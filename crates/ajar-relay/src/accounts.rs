//! Accounts, the pads they own, and the links that open them.
//!
//! Designed in `docs/dev/accounts.md`. SQLite in WAL mode, one connection
//! behind a mutex: every query here is a few rows by key, and the relay's
//! workers call it from `spawn_blocking`, never from the async path that
//! carries frames.
//!
//! A pad with no row here is anonymous and open to everyone, exactly as before
//! accounts existed. A pad with a row is owned, and who may view or edit it is
//! decided here — the store API and the relay's peer room both ask.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use aes_gcm::aead::{Aead, Generate, KeyInit, Nonce};
use aes_gcm::{Aes256Gcm, Key};
use base64::Engine;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Pads one account may own at once, unless the relay is told otherwise.
pub const MAX_PADS_PER_ACCOUNT: usize = 20;

/// Of those, how many may have a name their owner chose, rather than three
/// words minted for them. Few, because a name is first come, first served
/// and kept for good once used: `notes`, `demo` and `flask` are worth more
/// to everyone than to the first account that thinks of them.
pub const MAX_NAMED_PER_ACCOUNT: usize = 3;

/// The shortest name an owner may choose. A minted one is three words; two
/// letters is a land grab, not a name anyone needs.
pub const MIN_CHOSEN_NAME: usize = 3;
/// Bytes every pad of one account may hold together. Each pad keeps its own
/// cap (`pad::MAX_BYTES`) as well; this is what stops twenty of them filling
/// the disk. 250 MiB since pads went to 100 on 11 October — at 100 an owned pad
/// could never reach the cap a pad has.
pub const MAX_BYTES_PER_ACCOUNT: u64 = 250 * 1024 * 1024;

/// What one account may hold. Flags on the relay, so the numbers can move
/// without a release and the checks can reach them without writing 100 MB.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Limits {
    pub pads: usize,
    pub bytes: u64,
    /// Pads whose name the owner chose: [`MAX_NAMED_PER_ACCOUNT`].
    pub named: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            pads: MAX_PADS_PER_ACCOUNT,
            bytes: MAX_BYTES_PER_ACCOUNT,
            named: MAX_NAMED_PER_ACCOUNT,
        }
    }
}
/// How many three-word names a new pad tries before giving up. There are
/// some 470 billion and nearly all are free, so a run of misses is not bad
/// luck but a store that cannot say.
const MINT_TRIES: usize = 64;
/// How long a sign-in lasts.
const SESSION_DAYS: i64 = 30;
/// The same, for the cookie that carries it.
pub const SESSION_SECS: u64 = SESSION_DAYS as u64 * 24 * 60 * 60;

static WORDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    include_str!("words.txt")
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
        .collect()
});

/// What someone may do with a pad, least to most.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    None,
    Viewer,
    Editor,
    Owner,
}

/// Who may view an owned pad without being its owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum View {
    /// Anyone with the bare link.
    Link,
    /// Only people with a view or edit link.
    Code,
    /// Nobody but the owner.
    Owner,
}

/// Who may edit an owned pad without being its owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edit {
    /// Anyone with an edit link.
    Code,
    /// Nobody but the owner.
    Owner,
}

impl View {
    fn as_str(self) -> &'static str {
        match self {
            View::Link => "link",
            View::Code => "code",
            View::Owner => "owner",
        }
    }
    fn parse(s: &str) -> View {
        match s {
            "link" => View::Link,
            "code" => View::Code,
            _ => View::Owner,
        }
    }
}

impl Edit {
    fn as_str(self) -> &'static str {
        match self {
            Edit::Code => "code",
            Edit::Owner => "owner",
        }
    }
    fn parse(s: &str) -> Edit {
        match s {
            "code" => Edit::Code,
            _ => Edit::Owner,
        }
    }
}

fn role_str(role: Role) -> &'static str {
    match role {
        Role::Editor => "editor",
        _ => "viewer",
    }
}

fn role_parse(s: &str) -> Role {
    if s == "editor" {
        Role::Editor
    } else {
        Role::Viewer
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct User {
    pub id: i64,
    pub provider: String,
    pub name: String,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Link {
    pub id: i64,
    pub role: Role,
    pub label: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PadInfo {
    pub name: String,
    pub created: i64,
    pub view: View,
    pub edit: Edit,
    pub bytes: u64,
    pub files: u64,
    pub links: Vec<Link>,
    /// Named by its owner rather than minted: counts against [`Limits::named`].
    pub chosen: bool,
}

/// One caller's standing with one pad.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Access {
    pub role: Role,
    /// The link the caller came in by, so revoking it can find them.
    pub link: Option<i64>,
    /// What the link they presented grants on its own — before the pad's
    /// settings narrow it. A page uses it to tell an edit link that is locked
    /// for now from a view link, and to notice a code that no longer works.
    pub link_role: Option<Role>,
    /// A pad its owner deleted. Nobody gets anything, and pages say so
    /// rather than calling it private.
    pub deleted: bool,
    /// The owner's id, or `None` for an anonymous pad.
    pub owner: Option<i64>,
    pub view: Option<View>,
    pub edit: Option<Edit>,
}

impl Access {
    fn anonymous() -> Self {
        Access {
            role: Role::Editor,
            link: None,
            link_role: None,
            deleted: false,
            owner: None,
            view: None,
            edit: None,
        }
    }
}

/// See [`Accounts::stats`].
#[derive(Debug, Serialize)]
pub struct AccountStats {
    pub users: i64,
    pub by_provider: Vec<Count>,
    /// People who signed in within the window.
    pub signed_in: i64,
    /// Sessions that have not expired.
    pub sessions: i64,
    pub pads: i64,
    pub deleted: i64,
    pub bytes: i64,
    pub links: i64,
    pub view: Vec<Count>,
    pub edit: Vec<Count>,
    /// Accounts made, and account pads made, per day of the window.
    pub signups: Vec<Day>,
    pub made: Vec<Day>,
    /// The accounts holding the most, and the newest.
    pub biggest: Vec<AccountRow>,
    pub newest: Vec<AccountRow>,
}

#[derive(Debug, Serialize)]
pub struct Count {
    pub key: String,
    pub n: i64,
}

#[derive(Debug, Serialize)]
pub struct Day {
    /// The day's start, in Unix seconds.
    pub day: i64,
    pub n: i64,
}

#[derive(Debug, Serialize)]
pub struct AccountRow {
    pub name: String,
    pub provider: String,
    pub email: Option<String>,
    pub joined: i64,
    pub pads: i64,
    pub bytes: i64,
    /// When they last signed in, if a session of theirs is still on record.
    pub signed_in: Option<i64>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AccountError {
    NotFound,
    /// At the number of pads an account may hold, which it carries.
    TooManyPads(usize),
    /// At the bytes an account may hold, which it carries.
    OverQuota(u64),
    /// At the pads with chosen names an account may hold, which it carries.
    TooManyNamed(usize),
    /// A chosen name that is somebody's, or was: account pads' names stay
    /// retired once deleted, and an open pad of that name is somebody's work.
    NameTaken(String),
    /// A chosen name that is not one: what is wrong with it.
    BadName(String),
    /// A link asked for with a role no link carries: only viewer and editor.
    NotALinkRole,
    Db(String),
}

impl AccountError {
    pub fn message(&self) -> String {
        match self {
            AccountError::NotFound => "no pad of yours by that name".into(),
            AccountError::TooManyPads(n) => {
                format!("an account can hold {n} pads — delete one to make another")
            }
            AccountError::OverQuota(bytes) => format!(
                "the account this pad belongs to is full — its pads together are at the {} an account can hold",
                size(*bytes)
            ),
            AccountError::TooManyNamed(n) => format!(
                "an account can name {n} pads itself — the rest get three words; delete a named one to name another"
            ),
            AccountError::NameTaken(name) => format!("{name} is taken — pick another name"),
            AccountError::BadName(why) => why.clone(),
            AccountError::NotALinkRole => {
                "a link lets people view a pad or edit it — ask for viewer or editor".into()
            }
            AccountError::Db(e) => format!("the account store failed: {e}"),
        }
    }
}

impl From<rusqlite::Error> for AccountError {
    fn from(e: rusqlite::Error) -> Self {
        AccountError::Db(e.to_string())
    }
}

fn size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{} MB", bytes / (1024 * 1024))
    } else {
        format!("{} KB", bytes.div_ceil(1024))
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("the system has no randomness");
    out
}

/// 128 random bits, as 22 URL-safe characters.
pub fn new_secret() -> String {
    b64(&random::<16>())
}

fn hash(secret: &str) -> Vec<u8> {
    Sha256::digest(secret.as_bytes()).to_vec()
}

/// A session token as the database keys it, for the room to remember an
/// owner's connection by without keeping the token itself.
pub fn session_key(token: &str) -> Vec<u8> {
    hash(token)
}

/// A uniformly chosen word: rejection sampling rather than `%`, so no word is
/// likelier than another.
fn word() -> &'static str {
    let n = WORDS.len() as u32;
    let limit = u32::MAX - u32::MAX % n;
    loop {
        let r = u32::from_le_bytes(random::<4>());
        if r < limit {
            return WORDS[(r % n) as usize];
        }
    }
}

pub fn three_words() -> String {
    format!("{}-{}-{}", word(), word(), word())
}

pub struct Accounts {
    db: Mutex<Connection>,
    /// Seals link codes so the dashboard can show them again. Kept in a file
    /// beside the database rather than in it, so a copy of the database —
    /// a backup — is not a copy of every edit link.
    key: Aes256Gcm,
    limits: Limits,
}

impl Accounts {
    /// Open, or create, the database and its key.
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&conn)?;
        let key = load_or_make_key(&path.with_extension("key"))?;
        Ok(Accounts {
            db: Mutex::new(conn),
            key,
            limits: Limits::default(),
        })
    }

    pub fn with_limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    fn seal(&self, secret: &str) -> Vec<u8> {
        let nonce = Nonce::<Aes256Gcm>::generate();
        let mut out = nonce.to_vec();
        out.extend(
            self.key
                .encrypt(&nonce, secret.as_bytes())
                .expect("sealing a short string cannot fail"),
        );
        out
    }

    fn unseal(&self, sealed: &[u8]) -> Option<String> {
        if sealed.len() < 12 {
            return None;
        }
        let nonce = Nonce::<Aes256Gcm>::try_from(&sealed[..12]).ok()?;
        let plain = self.key.decrypt(&nonce, &sealed[12..]).ok()?;
        String::from_utf8(plain).ok()
    }

    // ---------------------------------------------------------- people

    /// Sign someone in from what their provider said about them.
    pub fn sign_in(
        &self,
        provider: &str,
        provider_id: &str,
        email: Option<&str>,
        name: &str,
    ) -> Result<User, AccountError> {
        let db = self.db.lock();
        db.execute(
            "INSERT INTO users (provider, provider_id, email, name, created) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (provider, provider_id) DO UPDATE SET email = ?3, name = ?4",
            params![provider, provider_id, email, name, now()],
        )?;
        let id: i64 = db.query_row(
            "SELECT id FROM users WHERE provider = ?1 AND provider_id = ?2",
            params![provider, provider_id],
            |r| r.get(0),
        )?;
        Ok(User {
            id,
            provider: provider.into(),
            name: name.into(),
            email: email.map(Into::into),
        })
    }

    /// A new session for a user. The token goes in a cookie; only its hash is
    /// kept, so the database cannot be used to sign in as anyone.
    pub fn new_session(&self, user: i64) -> Result<String, AccountError> {
        let token = b64(&random::<32>());
        let now = now();
        self.db.lock().execute(
            "INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?1, ?2, ?3, ?4)",
            params![hash(&token), user, now, now + SESSION_DAYS * 86_400],
        )?;
        Ok(token)
    }

    pub fn session(&self, token: &str) -> Option<User> {
        let db = self.db.lock();
        db.query_row(
            "SELECT u.id, u.provider, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1 AND s.expires > ?2",
            params![hash(token), now()],
            |r| {
                Ok(User {
                    id: r.get(0)?,
                    provider: r.get(1)?,
                    name: r.get(2)?,
                    email: r.get(3)?,
                })
            },
        )
        .optional()
        // Signed out, if the lookup fails: the least anyone can be, so it
        // grants nothing a stranger lacks. Said, so it is not silent.
        .inspect_err(|e| tracing::error!(error = %e, "could not look up a sign-in; treated as signed out"))
        .ok()
        .flatten()
    }

    pub fn end_session(&self, token: &str) {
        let _ = self.db.lock().execute(
            "DELETE FROM sessions WHERE token_hash = ?1",
            params![hash(token)],
        );
    }

    // ---------------------------------------------------------- pads

    /// Mint a pad for `owner`: a three-word name nobody has had, open to view
    /// by its link and to edit by its edit link, with one of each.
    ///
    /// `taken` is the file store's say on a name, so a pad never lands on an
    /// anonymous one that happens to exist. Names are checked against every
    /// row here too, deleted pads included: an owner's old link must never
    /// open somebody else's pad.
    /// A new pad for `owner`: under three minted words, or under `wanted`, a
    /// name of their own, if it is one ([`check_chosen`]), nobody has it or
    /// had it, and they have a named place left. `taken` says whether the
    /// store holds a pad of a name, which an account pad must never take.
    pub fn create_pad(
        &self,
        owner: i64,
        taken: &dyn Fn(&str) -> bool,
        wanted: Option<&str>,
    ) -> Result<PadInfo, AccountError> {
        let mut db = self.db.lock();
        let held: i64 = db.query_row(
            "SELECT COUNT(*) FROM pads WHERE owner_id = ?1 AND deleted IS NULL",
            params![owner],
            |r| r.get(0),
        )?;
        if held as usize >= self.limits.pads {
            return Err(AccountError::TooManyPads(self.limits.pads));
        }
        if let Some(wanted) = wanted {
            let named: i64 = db.query_row(
                "SELECT COUNT(*) FROM pads WHERE owner_id = ?1 AND deleted IS NULL AND chosen = 1",
                params![owner],
                |r| r.get(0),
            )?;
            if named as usize >= self.limits.named {
                return Err(AccountError::TooManyNamed(self.limits.named));
            }
            Self::free(&db, wanted, taken)?;
            let tx = db.transaction()?;
            tx.execute(
                "INSERT INTO pads (name, owner_id, view, edit, created, chosen) VALUES (?1, ?2, 'link', 'code', ?3, 1)",
                params![wanted, owner, now()],
            )?;
            tx.commit()?;
            drop(db);
            self.new_link(owner, wanted, Role::Viewer)?;
            self.new_link(owner, wanted, Role::Editor)?;
            return self.pad_of(owner, wanted);
        }
        // Bounded, though a free name is nearly every name: `taken` says yes
        // when the store cannot answer, and a store that cannot answer would
        // otherwise keep this here for good, holding the lock.
        let mut tries = 0;
        let name = loop {
            tries += 1;
            if tries > MINT_TRIES {
                return Err(AccountError::Db(
                    "no free name could be found for a new pad".into(),
                ));
            }
            let candidate = three_words();
            let exists: bool = db.query_row(
                "SELECT EXISTS (SELECT 1 FROM pads WHERE name = ?1)",
                params![candidate],
                |r| r.get(0),
            )?;
            if !exists && !taken(&candidate) {
                break candidate;
            }
        };
        let tx = db.transaction()?;
        tx.execute(
            "INSERT INTO pads (name, owner_id, view, edit, created) VALUES (?1, ?2, 'link', 'code', ?3)",
            params![name, owner, now()],
        )?;
        tx.commit()?;
        drop(db);
        self.new_link(owner, &name, Role::Viewer)?;
        self.new_link(owner, &name, Role::Editor)?;
        self.pad_of(owner, &name)
    }

    /// Whether `name` could be a pad of somebody's choosing now: said as the
    /// error creating it would give, so the page can say it while they type.
    pub fn name_free(&self, name: &str, taken: &dyn Fn(&str) -> bool) -> Result<(), AccountError> {
        Self::free(&self.db.lock(), name, taken)
    }

    fn free(db: &Connection, name: &str, taken: &dyn Fn(&str) -> bool) -> Result<(), AccountError> {
        check_chosen(name)?;
        let ever: bool = db.query_row(
            "SELECT EXISTS (SELECT 1 FROM pads WHERE name = ?1)",
            params![name],
            |r| r.get(0),
        )?;
        if ever || taken(name) {
            return Err(AccountError::NameTaken(name.to_string()));
        }
        Ok(())
    }

    fn owned(&self, owner: i64, name: &str) -> Result<(), AccountError> {
        let mine: bool = self.db.lock().query_row(
            "SELECT EXISTS (SELECT 1 FROM pads WHERE name = ?1 AND owner_id = ?2 AND deleted IS NULL)",
            params![name, owner],
            |r| r.get(0),
        )?;
        if mine {
            Ok(())
        } else {
            Err(AccountError::NotFound)
        }
    }

    pub fn pads_of(&self, owner: i64) -> Result<Vec<PadInfo>, AccountError> {
        let names: Vec<String> = {
            let db = self.db.lock();
            let mut q = db.prepare(
                "SELECT name FROM pads WHERE owner_id = ?1 AND deleted IS NULL ORDER BY created DESC, rowid DESC",
            )?;
            let rows = q.query_map(params![owner], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        names.iter().map(|n| self.pad_of(owner, n)).collect()
    }

    pub fn pad_of(&self, owner: i64, name: &str) -> Result<PadInfo, AccountError> {
        self.owned(owner, name)?;
        let db = self.db.lock();
        let (created, view, edit, bytes, files, chosen): (i64, String, String, i64, i64, bool) = db
            .query_row(
                "SELECT created, view, edit, bytes, files, chosen FROM pads WHERE name = ?1",
                params![name],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )?;
        let mut q = db.prepare(
            "SELECT id, role, label, code_sealed FROM links WHERE pad = ?1 AND revoked IS NULL ORDER BY id",
        )?;
        let links = q
            .query_map(params![name], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Vec<u8>>(3)?,
                ))
            })?
            .filter_map(Result::ok)
            .filter_map(|(id, role, label, sealed)| {
                Some(Link {
                    id,
                    role: role_parse(&role),
                    label,
                    code: self.unseal(&sealed)?,
                })
            })
            .collect();
        Ok(PadInfo {
            name: name.into(),
            created,
            view: View::parse(&view),
            edit: Edit::parse(&edit),
            bytes: bytes.max(0) as u64,
            files: files.max(0) as u64,
            links,
            chosen,
        })
    }

    /// A new link to an owned pad. Viewer and editor are the only roles a link
    /// can carry.
    pub fn new_link(&self, owner: i64, name: &str, role: Role) -> Result<Link, AccountError> {
        self.make_link(owner, name, role, false)
    }

    /// A new link of one kind, with every other link of that kind revoked in
    /// the same transaction — what Reset does. Every one, not only those the
    /// dashboard shows: a link whose sealed code can no longer be opened (a
    /// lost key) is left off the dashboard but still works, and must still be
    /// possible to stop.
    pub fn replace_link(&self, owner: i64, name: &str, role: Role) -> Result<Link, AccountError> {
        self.make_link(owner, name, role, true)
    }

    fn make_link(
        &self,
        owner: i64,
        name: &str,
        role: Role,
        replace: bool,
    ) -> Result<Link, AccountError> {
        self.owned(owner, name)?;
        // Refused rather than read as viewer, which is what an owner link or
        // a link to nothing used to become — reported back as made, and with
        // `replace`, every view link revoked for it.
        if !matches!(role, Role::Viewer | Role::Editor) {
            return Err(AccountError::NotALinkRole);
        }
        let code = new_secret();
        let mut db = self.db.lock();
        let db = db.transaction()?;
        if replace {
            db.execute(
                "UPDATE links SET revoked = ?1 WHERE pad = ?2 AND role = ?3 AND revoked IS NULL",
                params![now(), name, role_str(role)],
            )?;
        }
        db.execute(
            "INSERT INTO links (pad, role, code_hash, code_sealed, label, created) VALUES (?1, ?2, ?3, ?4, '', ?5)",
            params![name, role_str(role), hash(&code), self.seal(&code), now()],
        )?;
        let id = db.last_insert_rowid();
        db.commit()?;
        Ok(Link {
            id,
            role,
            label: String::new(),
            code,
        })
    }

    pub fn revoke_link(&self, owner: i64, name: &str, link: i64) -> Result<(), AccountError> {
        self.owned(owner, name)?;
        let changed = self.db.lock().execute(
            "UPDATE links SET revoked = ?1 WHERE id = ?2 AND pad = ?3 AND revoked IS NULL",
            params![now(), link, name],
        )?;
        if changed == 0 {
            return Err(AccountError::NotFound);
        }
        Ok(())
    }

    /// Both settings at once — what the tests set up a pad with.
    #[cfg(test)]
    pub fn set_access(
        &self,
        owner: i64,
        name: &str,
        view: View,
        edit: Edit,
    ) -> Result<(), AccountError> {
        self.change_access(owner, name, Some(view), Some(edit))
    }

    /// Change either setting, or both. One alone leaves the other as it
    /// stands in the database — not as a page last saw it: a page holding a
    /// stale copy of the other setting must not be able to put it back.
    pub fn change_access(
        &self,
        owner: i64,
        name: &str,
        view: Option<View>,
        edit: Option<Edit>,
    ) -> Result<(), AccountError> {
        self.owned(owner, name)?;
        self.db.lock().execute(
            "UPDATE pads SET view = COALESCE(?1, view), edit = COALESCE(?2, edit) WHERE name = ?3",
            params![view.map(|v| v.as_str()), edit.map(|e| e.as_str()), name],
        )?;
        Ok(())
    }

    /// Delete an owned pad's record. The name stays, marked deleted, so it is
    /// never minted again; the caller removes the files.
    pub fn delete_pad(&self, owner: i64, name: &str) -> Result<(), AccountError> {
        self.owned(owner, name)?;
        let db = self.db.lock();
        db.execute(
            "UPDATE pads SET deleted = ?1 WHERE name = ?2",
            params![now(), name],
        )?;
        db.execute(
            "UPDATE links SET revoked = ?1 WHERE pad = ?2 AND revoked IS NULL",
            params![now(), name],
        )?;
        Ok(())
    }

    /// Delete an account: the person, their sign-ins, and every pad they own.
    /// Returns the pads that still existed, whose files the caller removes.
    ///
    /// The pads' names stay, marked deleted and owned by nobody, so none is
    /// minted again and an old link says the pad was deleted rather than
    /// opening someone else's. Nothing else of theirs stays: the links' codes
    /// go, and the account row with its name and email address.
    pub fn delete_account(&self, user: i64) -> Result<Vec<String>, AccountError> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let live: Vec<String> = {
            let mut q =
                tx.prepare("SELECT name FROM pads WHERE owner_id = ?1 AND deleted IS NULL")?;
            let rows = q.query_map(params![user], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        tx.execute(
            "DELETE FROM links WHERE pad IN (SELECT name FROM pads WHERE owner_id = ?1)",
            params![user],
        )?;
        tx.execute(
            "UPDATE pads SET deleted = COALESCE(deleted, ?2), owner_id = NULL, bytes = 0, files = 0
             WHERE owner_id = ?1",
            params![user, now()],
        )?;
        tx.execute("DELETE FROM sessions WHERE user_id = ?1", params![user])?;
        tx.execute("DELETE FROM users WHERE id = ?1", params![user])?;
        tx.commit()?;
        Ok(live)
    }

    /// Every owned pad that still exists: the names the store must never let
    /// lapse.
    ///
    /// An error, not an empty list, when they cannot be read: the relay pins
    /// these at start, and an empty list would leave every owned pad on the
    /// ninety-day lease of an anonymous one — to be swept, files and all.
    pub fn owned_names(&self) -> Result<Vec<String>, AccountError> {
        let db = self.db.lock();
        let mut q = db.prepare("SELECT name FROM pads WHERE deleted IS NULL")?;
        let rows = q.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Record what a write left an owned pad at, for the dashboard and the
    /// account's quota.
    pub fn record_size(&self, name: &str, bytes: u64, files: u64) -> Result<(), AccountError> {
        self.db.lock().execute(
            "UPDATE pads SET bytes = ?1, files = ?2 WHERE name = ?3",
            params![bytes as i64, files as i64, name],
        )?;
        Ok(())
    }

    /// What an owned pad held after its last write; nothing for a pad with no
    /// row. A lookup that failed is an error rather than nothing, which would
    /// be room the account does not have.
    pub fn bytes_of(&self, name: &str) -> Result<u64, AccountError> {
        Ok(self
            .db
            .lock()
            .query_row(
                "SELECT bytes FROM pads WHERE name = ?1",
                params![name],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .map_or(0, |b| b.max(0) as u64))
    }

    /// Bytes an owner may still add across all their pads, other than `name`'s
    /// current size — which the write that asks is about to replace. An error
    /// when it cannot be counted: read as nothing used, it was the whole of
    /// the account's room.
    pub fn room_for(&self, owner: i64, name: &str) -> Result<u64, AccountError> {
        let used: i64 = self.db.lock().query_row(
            "SELECT COALESCE(SUM(bytes), 0) FROM pads WHERE owner_id = ?1 AND deleted IS NULL AND name != ?2",
            params![owner, name],
            |r| r.get(0),
        )?;
        Ok(self.limits.bytes.saturating_sub(used.max(0) as u64))
    }

    // ---------------------------------------------------------- the operator

    /// The provider's own id for a user, for matching an admin given as
    /// `github:12345`.
    pub fn provider_id(&self, user: i64) -> Option<String> {
        self.db
            .lock()
            .query_row(
                "SELECT provider_id FROM users WHERE id = ?1",
                params![user],
                |r| r.get(0),
            )
            .ok()
    }

    /// Totals for the operator's view, from what the database already holds:
    /// who signed up and when, pads and how they are shared, and the accounts
    /// that use the most room. Nothing is collected for it.
    pub fn stats(&self, days: i64, top: usize) -> Result<AccountStats, AccountError> {
        let db = self.db.lock();
        let now = now();
        let since = now - days * 86_400;
        let one = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> rusqlite::Result<i64> {
            db.query_row(sql, p, |r| r.get(0))
        };
        let counts = |sql: &str| -> rusqlite::Result<Vec<Count>> {
            let mut q = db.prepare(sql)?;
            let rows = q.query_map([], |r| {
                Ok(Count {
                    key: r.get(0)?,
                    n: r.get(1)?,
                })
            })?;
            rows.collect()
        };
        let per_day = |sql: &str| -> rusqlite::Result<Vec<Day>> {
            let mut q = db.prepare(sql)?;
            let rows = q.query_map(params![since], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })?;
            let got: std::collections::HashMap<i64, i64> = rows.collect::<Result<_, _>>()?;
            // Every day in the window, the empty ones too, oldest first.
            let today = now / 86_400;
            Ok((0..days)
                .rev()
                .map(|back| {
                    let day = today - back;
                    Day {
                        day: day * 86_400,
                        n: got.get(&day).copied().unwrap_or(0),
                    }
                })
                .collect())
        };
        let accounts = |order: &str| -> rusqlite::Result<Vec<AccountRow>> {
            let mut q = db.prepare(&format!(
                "SELECT u.name, u.provider, u.email, u.created,
                        COUNT(p.name), COALESCE(SUM(p.bytes), 0),
                        (SELECT MAX(s.created) FROM sessions s WHERE s.user_id = u.id)
                 FROM users u LEFT JOIN pads p ON p.owner_id = u.id AND p.deleted IS NULL
                 GROUP BY u.id ORDER BY {order} LIMIT ?1"
            ))?;
            let rows = q.query_map(params![top as i64], |r| {
                Ok(AccountRow {
                    name: r.get(0)?,
                    provider: r.get(1)?,
                    email: r.get(2)?,
                    joined: r.get(3)?,
                    pads: r.get(4)?,
                    bytes: r.get(5)?,
                    signed_in: r.get(6)?,
                })
            })?;
            rows.collect()
        };
        Ok(AccountStats {
            users: one("SELECT COUNT(*) FROM users", &[])?,
            by_provider: counts("SELECT provider, COUNT(*) FROM users GROUP BY provider ORDER BY 2 DESC")?,
            signed_in: one("SELECT COUNT(DISTINCT user_id) FROM sessions WHERE created > ?1", &[&since])?,
            sessions: one("SELECT COUNT(*) FROM sessions WHERE expires > ?1", &[&now])?,
            pads: one("SELECT COUNT(*) FROM pads WHERE deleted IS NULL", &[])?,
            deleted: one("SELECT COUNT(*) FROM pads WHERE deleted IS NOT NULL", &[])?,
            bytes: one("SELECT COALESCE(SUM(bytes), 0) FROM pads WHERE deleted IS NULL", &[])?,
            links: one("SELECT COUNT(*) FROM links WHERE revoked IS NULL", &[])?,
            view: counts("SELECT view, COUNT(*) FROM pads WHERE deleted IS NULL GROUP BY view ORDER BY 2 DESC")?,
            edit: counts("SELECT edit, COUNT(*) FROM pads WHERE deleted IS NULL GROUP BY edit ORDER BY 2 DESC")?,
            signups: per_day("SELECT created / 86400, COUNT(*) FROM users WHERE created > ?1 GROUP BY 1")?,
            made: per_day("SELECT created / 86400, COUNT(*) FROM pads WHERE created > ?1 GROUP BY 1")?,
            biggest: accounts("6 DESC, u.created DESC")?,
            newest: accounts("u.created DESC")?,
        })
    }

    // ---------------------------------------------------------- access

    /// What `user`, holding `code`, may do with `name`.
    ///
    /// No row: an anonymous pad, open to everyone — that is the product, and
    /// it does not change. A deleted pad gives nobody anything. Otherwise the
    /// owner is the owner; a code gives what its link grants, as far as the
    /// pad's settings allow; and the bare name gives viewing if viewing is
    /// open. An edit link always lets you view, even with editing locked.
    ///
    /// A lookup that fails is an error, never an answer. Both lookups used to
    /// read an error as no row: no pad row is the open, anonymous pad above,
    /// so a database that could not be read made every private pad editable
    /// by anyone (audit B01, 17 October); and no link row told the page its
    /// code was dead, and the page forgot it.
    pub fn access(
        &self,
        name: &str,
        user: Option<i64>,
        code: Option<&str>,
    ) -> Result<Access, AccountError> {
        let db = self.db.lock();
        let row: Option<(Option<i64>, String, String, Option<i64>)> = db
            .query_row(
                "SELECT owner_id, view, edit, deleted FROM pads WHERE name = ?1",
                params![name],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((owner, view, edit, deleted)) = row else {
            return Ok(Access::anonymous());
        };
        let (view, edit) = (View::parse(&view), Edit::parse(&edit));
        let mut access = Access {
            role: Role::None,
            link: None,
            link_role: None,
            deleted: deleted.is_some(),
            owner,
            view: Some(view),
            edit: Some(edit),
        };
        if access.deleted {
            return Ok(access);
        }
        if user.is_some() && user == owner {
            access.role = Role::Owner;
            return Ok(access);
        }
        if view == View::Link {
            access.role = Role::Viewer;
        }
        if let Some(code) = code {
            let link: Option<(i64, String)> = db
                .query_row(
                    "SELECT id, role FROM links WHERE pad = ?1 AND code_hash = ?2 AND revoked IS NULL",
                    params![name, hash(code)],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((id, role)) = link {
                access.link_role = Some(role_parse(&role));
                let granted = match role_parse(&role) {
                    Role::Editor if edit == Edit::Code => Role::Editor,
                    _ if view != View::Owner => Role::Viewer,
                    _ => Role::None,
                };
                if granted > access.role {
                    access.role = granted;
                    access.link = Some(id);
                }
            }
        }
        Ok(access)
    }
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "CREATE TABLE users (
                 id INTEGER PRIMARY KEY,
                 provider TEXT NOT NULL,
                 provider_id TEXT NOT NULL,
                 email TEXT,
                 name TEXT NOT NULL,
                 created INTEGER NOT NULL,
                 UNIQUE (provider, provider_id)
             );
             CREATE TABLE sessions (
                 token_hash BLOB PRIMARY KEY,
                 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                 created INTEGER NOT NULL,
                 expires INTEGER NOT NULL
             );
             CREATE TABLE pads (
                 name TEXT PRIMARY KEY,
                 owner_id INTEGER REFERENCES users(id),
                 view TEXT NOT NULL,
                 edit TEXT NOT NULL,
                 created INTEGER NOT NULL,
                 deleted INTEGER,
                 bytes INTEGER NOT NULL DEFAULT 0,
                 files INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX pads_owner ON pads (owner_id);
             CREATE TABLE links (
                 id INTEGER PRIMARY KEY,
                 pad TEXT NOT NULL REFERENCES pads(name),
                 role TEXT NOT NULL,
                 code_hash BLOB NOT NULL UNIQUE,
                 code_sealed BLOB NOT NULL,
                 label TEXT NOT NULL DEFAULT '',
                 created INTEGER NOT NULL,
                 revoked INTEGER
             );
             CREATE INDEX links_pad ON links (pad);
             PRAGMA user_version = 1;",
        )?;
    }
    // Names an owner chose, rather than three minted words (16 October 2026).
    if version < 2 {
        conn.execute_batch(
            "ALTER TABLE pads ADD COLUMN chosen INTEGER NOT NULL DEFAULT 0;
             PRAGMA user_version = 2;",
        )?;
    }
    Ok(())
}

/// A name an owner may choose: a pad's name ([`crate::pad::check_name`]),
/// of at least [`MIN_CHOSEN_NAME`] characters, with a letter in it so it is a
/// word rather than a number.
pub fn check_chosen(name: &str) -> Result<(), AccountError> {
    crate::pad::check_name(name).map_err(|e| {
        AccountError::BadName(format!("{name} cannot be a pad's name: {}", e.message()))
    })?;
    if name.len() < MIN_CHOSEN_NAME {
        return Err(AccountError::BadName(format!(
            "a name of your own needs at least {MIN_CHOSEN_NAME} characters"
        )));
    }
    if !name.bytes().any(|b| b.is_ascii_lowercase()) {
        return Err(AccountError::BadName("a name needs a letter in it".into()));
    }
    Ok(())
}

/// The sealing key, made on first start and kept beside the database with
/// owner-only permissions.
fn load_or_make_key(path: &PathBuf) -> anyhow::Result<Aes256Gcm> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) if bytes.len() == 32 => bytes,
        Ok(_) => anyhow::bail!("{} is not a 32-byte key", path.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let fresh = random::<32>().to_vec();
            write_private(path, &fresh)?;
            fresh
        }
        Err(e) => return Err(e.into()),
    };
    let key: [u8; 32] = bytes.try_into().expect("checked above");
    Ok(Aes256Gcm::new(&Key::<Aes256Gcm>::from(key)))
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Accounts, PathBuf) {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ajar-accounts-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let accounts = Accounts::open(&dir.join("accounts.db")).unwrap();
        (accounts, dir)
    }

    fn person(a: &Accounts, id: &str) -> i64 {
        a.sign_in("github", id, None, id).unwrap().id
    }

    #[test]
    fn a_name_is_three_words_from_the_list() {
        let name = three_words();
        let parts: Vec<&str> = name.split('-').collect();
        assert_eq!(parts.len(), 3, "{name}");
        assert!(parts.iter().all(|p| WORDS.contains(p)), "{name}");
        assert!(
            crate::pad::check_name(&name).is_ok(),
            "{name} is not a valid pad name"
        );
        assert!(
            WORDS.len() > 7700,
            "the list is the EFF one, {} words",
            WORDS.len()
        );
    }

    #[test]
    fn a_lookup_that_fails_is_an_error_and_grants_nothing() {
        // Audit B01: every SQL error read as "no row", and no row is the
        // anonymous pad anyone may edit.
        let (a, _) = store();
        let me = person(&a, "1");
        let pad = a.create_pad(me, &|_| false, None).unwrap();
        a.set_access(me, &pad.name, View::Owner, Edit::Owner)
            .unwrap();
        let code = pad.links[1].code.clone();

        // A code that cannot be checked is not a dead code, which a page
        // forgets, nor no code at all.
        a.db.lock()
            .execute_batch("ALTER TABLE links RENAME TO links_unreadable")
            .unwrap();
        assert!(matches!(
            a.access(&pad.name, None, Some(&code)),
            Err(AccountError::Db(_))
        ));
        assert_eq!(
            a.access(&pad.name, Some(me), None).unwrap().role,
            Role::Owner,
            "without a code the links are not read"
        );

        a.db.lock()
            .execute_batch("ALTER TABLE pads RENAME TO pads_unreadable")
            .unwrap();
        for (user, held) in [(None, None), (Some(me), None), (None, Some(code.as_str()))] {
            assert!(
                matches!(a.access(&pad.name, user, held), Err(AccountError::Db(_))),
                "a private pad read as {:?}",
                a.access(&pad.name, user, held)
            );
        }
        assert!(a.access("never-owned-pad", None, None).is_err());
        assert!(a.owned_names().is_err(), "the names to pin, read as none");
        assert!(
            a.room_for(me, &pad.name).is_err(),
            "room, read as all of it"
        );
        assert!(a.bytes_of(&pad.name).is_err());
        assert!(a.record_size(&pad.name, 1, 1).is_err());
    }

    #[test]
    fn a_store_that_cannot_say_which_names_are_taken_gets_no_new_pad() {
        // `taken` says yes when the store cannot answer, so the loop that
        // looks for a free name has to end.
        let (a, _) = store();
        let me = person(&a, "1");
        assert!(matches!(
            a.create_pad(me, &|_| true, None),
            Err(AccountError::Db(_))
        ));
        assert!(a.pads_of(me).unwrap().is_empty());
    }

    #[test]
    fn a_pad_with_no_row_is_open_to_everyone() {
        let (a, _) = store();
        assert_eq!(
            a.access("rustic-notch-5292", None, None).unwrap().role,
            Role::Editor
        );
    }

    #[test]
    fn the_defaults_are_view_by_link_and_edit_by_edit_link() {
        let (a, _) = store();
        let me = person(&a, "1");
        let pad = a.create_pad(me, &|_| false, None).unwrap();
        let edit = pad.links.iter().find(|l| l.role == Role::Editor).unwrap();
        let view = pad.links.iter().find(|l| l.role == Role::Viewer).unwrap();

        assert_eq!(
            a.access(&pad.name, Some(me), None).unwrap().role,
            Role::Owner
        );
        assert_eq!(
            a.access(&pad.name, None, None).unwrap().role,
            Role::Viewer,
            "the bare name views"
        );
        assert_eq!(
            a.access(&pad.name, None, Some(&view.code)).unwrap().role,
            Role::Viewer
        );
        let editor = a.access(&pad.name, None, Some(&edit.code)).unwrap();
        assert_eq!((editor.role, editor.link), (Role::Editor, Some(edit.id)));
        assert_eq!(
            a.access(&pad.name, None, Some("not-a-code")).unwrap().role,
            Role::Viewer
        );
        let stranger = person(&a, "2");
        assert_eq!(
            a.access(&pad.name, Some(stranger), None).unwrap().role,
            Role::Viewer,
            "signed in is not owning"
        );
    }

    #[test]
    fn private_viewing_needs_a_link_and_an_edit_link_still_views() {
        let (a, _) = store();
        let me = person(&a, "1");
        let pad = a.create_pad(me, &|_| false, None).unwrap();
        let edit = pad
            .links
            .iter()
            .find(|l| l.role == Role::Editor)
            .unwrap()
            .code
            .clone();
        let view = pad
            .links
            .iter()
            .find(|l| l.role == Role::Viewer)
            .unwrap()
            .code
            .clone();

        a.set_access(me, &pad.name, View::Code, Edit::Owner)
            .unwrap();
        assert_eq!(a.access(&pad.name, None, None).unwrap().role, Role::None);
        assert_eq!(
            a.access(&pad.name, None, Some(&view)).unwrap().role,
            Role::Viewer
        );
        assert_eq!(
            a.access(&pad.name, None, Some(&edit)).unwrap().role,
            Role::Viewer,
            "edit locked: the edit link views and no more"
        );

        a.set_access(me, &pad.name, View::Owner, Edit::Owner)
            .unwrap();
        assert_eq!(
            a.access(&pad.name, None, Some(&edit)).unwrap().role,
            Role::None
        );
        assert_eq!(
            a.access(&pad.name, Some(me), None).unwrap().role,
            Role::Owner
        );

        // Unlocking brings the same links back.
        a.set_access(me, &pad.name, View::Link, Edit::Code).unwrap();
        assert_eq!(
            a.access(&pad.name, None, Some(&edit)).unwrap().role,
            Role::Editor
        );
    }

    #[test]
    fn stats_count_what_is_there() {
        let (a, _) = store();
        let me = person(&a, "1");
        let you = person(&a, "2");
        let pad = a.create_pad(me, &|_| false, None).unwrap();
        a.create_pad(you, &|_| false, None).unwrap();
        a.record_size(&pad.name, 5000, 2).unwrap();
        a.new_session(me).unwrap();
        let s = a.stats(30, 5).unwrap();
        assert_eq!((s.users, s.pads, s.bytes, s.signed_in), (2, 2, 5000, 1));
        assert_eq!(s.links, 4, "a viewer and an editor link each");
        assert_eq!(s.signups.len(), 30);
        assert_eq!(s.signups.last().unwrap().n, 2, "both joined today");
        assert_eq!(s.made.iter().map(|d| d.n).sum::<i64>(), 2);
        assert_eq!(s.biggest[0].bytes, 5000);
        assert!(s.biggest[0].signed_in.is_some());
        assert_eq!(
            s.view.iter().find(|c| c.key == "link").map(|c| c.n),
            Some(2)
        );
    }

    #[test]
    fn changing_one_setting_leaves_the_other_as_stored() {
        let (a, _) = store();
        let me = person(&a, "1");
        let pad = a.create_pad(me, &|_| false, None).unwrap();
        a.set_access(me, &pad.name, View::Link, Edit::Owner)
            .unwrap();
        // A page that last saw editing open, changing only who can view.
        a.change_access(me, &pad.name, Some(View::Code), None)
            .unwrap();
        let now = a.pad_of(me, &pad.name).unwrap();
        assert_eq!((now.view, now.edit), (View::Code, Edit::Owner));
    }

    #[test]
    fn a_link_says_what_it_grants_and_a_deleted_pad_says_so() {
        let (a, _) = store();
        let me = person(&a, "1");
        let pad = a.create_pad(me, &|_| false, None).unwrap();
        let edit = pad
            .links
            .iter()
            .find(|l| l.role == Role::Editor)
            .unwrap()
            .code
            .clone();
        a.set_access(me, &pad.name, View::Link, Edit::Owner)
            .unwrap();
        // Locked for now, but still an edit link — a viewer must not pass it on.
        let held = a.access(&pad.name, None, Some(&edit)).unwrap();
        assert_eq!(
            (held.role, held.link_role),
            (Role::Viewer, Some(Role::Editor))
        );
        assert_eq!(
            a.access(&pad.name, None, Some("no-such-code-anywhere"))
                .unwrap()
                .link_role,
            None
        );
        a.delete_pad(me, &pad.name).unwrap();
        let gone = a.access(&pad.name, Some(me), None).unwrap();
        assert!(gone.deleted && gone.role == Role::None);
    }

    #[test]
    fn reset_stops_every_link_of_its_kind_even_ones_it_cannot_show() {
        let (a, _) = store();
        let me = person(&a, "1");
        let pad = a.create_pad(me, &|_| false, None).unwrap();
        a.set_access(me, &pad.name, View::Code, Edit::Code).unwrap();
        let first = pad
            .links
            .iter()
            .find(|l| l.role == Role::Editor)
            .unwrap()
            .clone();
        let second = a.new_link(me, &pad.name, Role::Editor).unwrap();
        let view = pad
            .links
            .iter()
            .find(|l| l.role == Role::Viewer)
            .unwrap()
            .clone();
        // A link whose sealed copy cannot be opened — a lost key — is not
        // listed, but its code still works until something revokes it.
        a.db.lock()
            .execute(
                "UPDATE links SET code_sealed = x'00' WHERE id = ?1",
                params![second.id],
            )
            .unwrap();
        assert!(a
            .pad_of(me, &pad.name)
            .unwrap()
            .links
            .iter()
            .all(|l| l.id != second.id));
        assert_eq!(
            a.access(&pad.name, None, Some(&second.code)).unwrap().role,
            Role::Editor
        );

        let fresh = a.replace_link(me, &pad.name, Role::Editor).unwrap();
        assert_eq!(
            a.access(&pad.name, None, Some(&first.code)).unwrap().role,
            Role::None
        );
        assert_eq!(
            a.access(&pad.name, None, Some(&second.code)).unwrap().role,
            Role::None
        );
        assert_eq!(
            a.access(&pad.name, None, Some(&fresh.code)).unwrap().role,
            Role::Editor
        );
        assert_eq!(
            a.access(&pad.name, None, Some(&view.code)).unwrap().role,
            Role::Viewer,
            "links of the other kind are untouched"
        );
        assert!(a
            .replace_link(person(&a, "2"), &pad.name, Role::Editor)
            .is_err());
    }

    #[test]
    fn a_link_views_or_edits_and_is_never_anything_else() {
        let (a, _) = store();
        let me = person(&a, "1");
        let pad = a.create_pad(me, &|_| false, None).unwrap();
        for role in [Role::Owner, Role::None] {
            assert_eq!(
                a.new_link(me, &pad.name, role).err(),
                Some(AccountError::NotALinkRole)
            );
            assert_eq!(
                a.replace_link(me, &pad.name, role).err(),
                Some(AccountError::NotALinkRole)
            );
        }
        let links = a.pad_of(me, &pad.name).unwrap().links;
        assert_eq!(links.len(), 2, "the two it was made with, untouched");
    }

    #[test]
    fn a_revoked_link_opens_nothing_and_a_new_one_does() {
        let (a, _) = store();
        let me = person(&a, "1");
        let pad = a.create_pad(me, &|_| false, None).unwrap();
        a.set_access(me, &pad.name, View::Code, Edit::Code).unwrap();
        let old = pad
            .links
            .iter()
            .find(|l| l.role == Role::Editor)
            .unwrap()
            .clone();
        a.revoke_link(me, &pad.name, old.id).unwrap();
        assert_eq!(
            a.access(&pad.name, None, Some(&old.code)).unwrap().role,
            Role::None
        );
        let fresh = a.new_link(me, &pad.name, Role::Editor).unwrap();
        assert_eq!(
            a.access(&pad.name, None, Some(&fresh.code)).unwrap().role,
            Role::Editor
        );
        assert!(
            a.pad_of(me, &pad.name)
                .unwrap()
                .links
                .iter()
                .all(|l| l.id != old.id),
            "a revoked link is not listed"
        );
    }

    #[test]
    fn codes_are_kept_sealed_and_hashed_not_plain() {
        let (a, dir) = store();
        let me = person(&a, "1");
        let pad = a.create_pad(me, &|_| false, None).unwrap();
        let code = pad.links[0].code.clone();
        drop(a);
        // Neither the database nor its write-ahead log holds a code as text.
        for file in ["accounts.db", "accounts.db-wal"] {
            if let Ok(raw) = std::fs::read(dir.join(file)) {
                assert!(
                    !raw.windows(code.len()).any(|w| w == code.as_bytes()),
                    "{file} holds a link code in the clear"
                );
            }
        }
        // And the dashboard can still show it.
        let a = Accounts::open(&dir.join("accounts.db")).unwrap();
        assert_eq!(a.pad_of(me, &pad.name).unwrap().links[0].code, code);
    }

    #[test]
    fn only_the_owner_can_change_a_pad() {
        let (a, _) = store();
        let me = person(&a, "1");
        let them = person(&a, "2");
        let pad = a.create_pad(me, &|_| false, None).unwrap();
        assert_eq!(
            a.set_access(them, &pad.name, View::Owner, Edit::Owner),
            Err(AccountError::NotFound)
        );
        assert_eq!(a.delete_pad(them, &pad.name), Err(AccountError::NotFound));
        assert!(a.new_link(them, &pad.name, Role::Editor).is_err());
        assert!(a.pads_of(them).unwrap().is_empty());
    }

    #[test]
    fn a_deleted_pad_opens_for_nobody_and_its_name_is_never_minted_again() {
        let (a, _) = store();
        let me = person(&a, "1");
        let pad = a.create_pad(me, &|_| false, None).unwrap();
        let code = pad.links[1].code.clone();
        a.delete_pad(me, &pad.name).unwrap();
        assert_eq!(
            a.access(&pad.name, Some(me), Some(&code)).unwrap().role,
            Role::None
        );
        // Nor does it fall back to an open, anonymous pad anyone could write.
        assert_eq!(a.access(&pad.name, None, None).unwrap().role, Role::None);
        assert!(a.owned_names().unwrap().is_empty());
    }

    #[test]
    fn deleting_an_account_takes_its_pads_sign_ins_and_details_and_retires_the_names() {
        let (a, _) = store();
        let me = person(&a, "1");
        let them = person(&a, "2");
        let token = a.new_session(me).unwrap();
        let kept = a.create_pad(me, &|_| false, None).unwrap();
        let gone_before = a.create_pad(me, &|_| false, None).unwrap();
        a.delete_pad(me, &gone_before.name).unwrap();
        let theirs = a.create_pad(them, &|_| false, None).unwrap();
        let code = kept.links[1].code.clone();

        let live = a.delete_account(me).unwrap();
        assert_eq!(
            live,
            vec![kept.name.clone()],
            "only the pad still there needs its files removed"
        );
        assert!(a.session(&token).is_none(), "its sign-ins end");
        let left: i64 =
            a.db.lock()
                .query_row(
                    "SELECT COUNT(*) FROM users WHERE id = ?1",
                    params![me],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(left, 0, "the person's row, name and email go");
        let codes: i64 =
            a.db.lock()
                .query_row(
                    "SELECT COUNT(*) FROM links WHERE pad IN (?1, ?2)",
                    params![kept.name, gone_before.name],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(codes, 0, "and the links' codes");
        let access = a.access(&kept.name, None, Some(&code)).unwrap();
        assert!(
            access.deleted && access.role == Role::None,
            "an old link finds a deleted pad"
        );
        assert!(!a.owned_names().unwrap().contains(&kept.name));
        assert_eq!(
            a.pads_of(them).unwrap().len(),
            1,
            "someone else's pads are untouched"
        );
        assert_eq!(
            a.access(&theirs.name, Some(them), None).unwrap().role,
            Role::Owner
        );
        // Signing in again with the same provider id is a new, empty account.
        let again = person(&a, "1");
        assert!(a.pads_of(again).unwrap().is_empty());
        assert_eq!(
            a.access(&kept.name, Some(again), None).unwrap().role,
            Role::None
        );
    }

    #[test]
    fn an_account_holds_a_limited_number_of_pads() {
        let (a, _) = store();
        let me = person(&a, "1");
        for _ in 0..MAX_PADS_PER_ACCOUNT {
            a.create_pad(me, &|_| false, None).unwrap();
        }
        assert_eq!(
            a.create_pad(me, &|_| false, None).err(),
            Some(AccountError::TooManyPads(MAX_PADS_PER_ACCOUNT))
        );
    }

    #[test]
    fn a_name_the_store_has_is_not_minted() {
        let (a, _) = store();
        let me = person(&a, "1");
        let refused = std::cell::RefCell::new(0);
        // The first two candidates are "taken"; the third is used.
        let pad = a
            .create_pad(
                me,
                &|_| {
                    let mut n = refused.borrow_mut();
                    *n += 1;
                    *n <= 2
                },
                None,
            )
            .unwrap();
        assert_eq!(*refused.borrow(), 3);
        assert_eq!(pad.name.split('-').count(), 3);
    }

    #[test]
    fn an_owner_names_three_pads_and_a_name_is_kept_for_good() {
        let (a, _) = store();
        let me = person(&a, "1");
        let taken = |n: &str| n == "an-open-pad";
        let named = a.create_pad(me, &taken, Some("notes")).unwrap();
        assert_eq!((named.name.as_str(), named.chosen), ("notes", true));
        assert!(
            !a.create_pad(me, &taken, None).unwrap().chosen,
            "a minted one is not chosen"
        );
        assert_eq!(
            a.create_pad(me, &taken, Some("notes")).err(),
            Some(AccountError::NameTaken("notes".into()))
        );
        assert_eq!(
            a.create_pad(me, &taken, Some("an-open-pad")).err(),
            Some(AccountError::NameTaken("an-open-pad".into())),
            "an open pad is somebody's"
        );
        for bad in ["ab", "1234", "Notes!", "-x-y", "api", ""] {
            assert!(
                matches!(
                    a.create_pad(me, &taken, Some(bad)).err(),
                    Some(AccountError::BadName(_))
                ),
                "{bad:?} is not a name"
            );
        }
        a.create_pad(me, &taken, Some("demo")).unwrap();
        a.create_pad(me, &taken, Some("flask-app")).unwrap();
        assert_eq!(
            a.create_pad(me, &taken, Some("fourth")).err(),
            Some(AccountError::TooManyNamed(MAX_NAMED_PER_ACCOUNT))
        );
        // Deleting one frees a place, but not the name.
        a.delete_pad(me, "demo").unwrap();
        assert_eq!(
            a.create_pad(me, &taken, Some("demo")).err(),
            Some(AccountError::NameTaken("demo".into()))
        );
        assert_eq!(
            a.name_free("demo", &taken).err(),
            Some(AccountError::NameTaken("demo".into()))
        );
        assert_eq!(a.name_free("fourth", &taken), Ok(()));
        assert!(a.create_pad(me, &taken, Some("fourth")).unwrap().chosen);
    }

    #[test]
    fn sessions_find_their_user_until_they_end() {
        let (a, _) = store();
        let me = person(&a, "1");
        let token = a.new_session(me).unwrap();
        assert_eq!(a.session(&token).map(|u| u.id), Some(me));
        assert_eq!(a.session("forged"), None);
        a.end_session(&token);
        assert_eq!(a.session(&token), None);
    }

    #[test]
    fn room_counts_every_other_pad_of_the_owner() {
        let (a, _) = store();
        let me = person(&a, "1");
        let one = a.create_pad(me, &|_| false, None).unwrap();
        let two = a.create_pad(me, &|_| false, None).unwrap();
        a.record_size(&one.name, 60 * 1024 * 1024, 3).unwrap();
        assert_eq!(
            a.room_for(me, &two.name).unwrap(),
            MAX_BYTES_PER_ACCOUNT - 60 * 1024 * 1024
        );
        assert_eq!(
            a.room_for(me, &one.name).unwrap(),
            MAX_BYTES_PER_ACCOUNT,
            "a pad's own size is not counted against it"
        );
    }
}
