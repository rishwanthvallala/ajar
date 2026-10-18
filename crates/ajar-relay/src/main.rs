//! ajar-relay — routes frames between an agent and its guests.
//!
//! It holds a session map and forwards bytes. It does not know what a
//! terminal is, what a file is, or what any payload contains.

mod accounts;
mod auth;
mod http_accounts;
mod http_admin;
mod outbox;
mod pad;
mod quota;
#[cfg(test)]
mod serving_tests;
mod session;
mod usage;
mod ws;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ws::WebSocketUpgrade, ConnectInfo, Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{any, get};
use axum::{Json, Router};
use clap::Parser;
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

use crate::pad::Store;
use crate::session::Registry;

/// The largest pad write this will read off the wire.
///
/// One request, not one pad. It was tied to `pad::MAX_BYTES` — twice the cap,
/// for JSON escaping, plus a margin — while a pad's every write could carry
/// the whole of it: 121 MiB at the 60 MiB cap, and a request that size costs
/// the body and the text parsed out of it at once, which took the relay to
/// 268 MB of its 512 for one 60 MB file (11 October). Since then a browser
/// sends at most 24 MiB a request — a large upload goes in several, and a
/// large file as its first part and then edits adding the rest to its end —
/// so this is 32 MiB and a margin, whatever a pad holds.
///
/// The multiplier used to be six, for the worst case where every byte is a
/// control character and becomes `\u00XX` — which is pathological, and it priced
/// every request as if it were: 151 MiB each, with nothing bounding how many
/// arrived at once. Four of them exceed the service's own `MemoryMax=512M`.
const MAX_PAD_HTTP_BODY: usize = 33 * 1024 * 1024;

/// Pad writes parsed and stored at once, and in whole bodies, what every body
/// being read off the wire may hold between them ([`PAD_BODY_BUDGET`]).
///
/// The body limit bounds one request; this bounds the sum. Without it the two
/// numbers that matter are unrelated — any limit times any concurrency is an
/// arbitrarily large amount of memory, and the ceiling that actually applies is
/// the OOM killer.
///
/// A queue rather than a refusal, because waiting a moment is invisible and
/// being told "busy" is not — though not one with no end ([`PAD_WRITE_WAIT`]).
///
/// It was a permit taken *before* the body was read, held while it arrived:
/// two uploads that sent their headers and then nothing more held both, and
/// every save behind them waited for as long as they cared to (audit B04).
/// Now a body takes room in [`PAD_BODY_BUDGET`] as its bytes arrive, so one
/// that has stopped holds only what it sent, and only for [`BODY_IDLE`]; and
/// the permit is taken once the body is in, for parsing and storing it,
/// which waits on nobody's network.
///
/// Two since pads went to 60 MiB (it was four at 25): the assertion below is
/// what the two numbers have to satisfy together.
const MAX_CONCURRENT_PAD_WRITES: usize = 2;

/// Bytes of request bodies the relay holds at once — pad writes and kept runs,
/// arriving or being stored — taken as they arrive and given back when the
/// request is done with them: as much as [`MAX_CONCURRENT_PAD_WRITES`] bodies
/// of the largest size, or any number of smaller ones adding up to the same.
const PAD_BODY_BUDGET: usize = MAX_PAD_HTTP_BODY * MAX_CONCURRENT_PAD_WRITES;

// These two are only meaningful together, and the unit file's MemoryMax=512M is
// what they have to fit inside — along with every session, outbox and snapshot
// the relay is also holding. Raising either one alone is how a limit stops being
// one, so the product is stated here rather than left to be worked out after an
// OOM. Every body held is inside the budget, and only a write with a permit
// parses its body into text no bigger than it, so bodies and text together
// are at most twice the budget: 132 MiB against 512 MiB leaves room for the
// rest of the process. What the store does with a write after that streams,
// whatever the file's size. The changes and edits a body may hold are capped
// as it is parsed (`pad::MAX_WRITES`, `pad::MAX_EDITS`), so what they cost as
// structures is a few hundred kilobytes, not a multiple of the body.
const _: () = assert!(PAD_BODY_BUDGET * 2 < 256 * 1024 * 1024);

/// How long a request body may go with nothing arriving before it is refused
/// with 408 and lets go of what it held. A client that has stopped part-way
/// through an upload is not going to finish it; one on a slow network still
/// sends something every few seconds, and the page's own deadline for a
/// write is 30 seconds and more for its size.
const BODY_IDLE: std::time::Duration = std::time::Duration::from_secs(20);

/// The longest any request body may take, however it trickles in: a byte
/// every few seconds would otherwise hold its connection, and what it had
/// sent, for good. Ten minutes is a 24 MiB request — the most the page sends
/// in one — at 40 KiB a second, and the page itself waits for one at 50 KB a
/// second (`writeOnce` in pad/src/store.ts).
const BODY_LONGEST: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// How long a write waits for room — for its body's bytes in
/// [`PAD_BODY_BUDGET`], or for a permit once they are in — before it is told
/// the server is busy, which the page tries again after. A permit is held for
/// parsing and storing only, a second at most even for the largest write, so
/// this is a long queue.
const PAD_WRITE_WAIT: std::time::Duration = std::time::Duration::from_secs(20);

/// The largest body a kept run is read from: [`pad::LAST_RUN_MAX`] of output
/// whose every byte is a control character six bytes long as JSON, and its
/// command and path. It took axum's default of 2 MB.
const MAX_RUN_HTTP_BODY: usize = 256 * 1024;
const _: () = assert!(pad::LAST_RUN_MAX * 6 + 16 * 1024 < MAX_RUN_HTTP_BODY);

/// Pad reads being streamed at once, from every caller together.
///
/// Not a memory bound — a read is streamed from its file and costs a chunk
/// buffer whatever the pad's size — but a descriptor bound: each is an open
/// file and a socket, and the unit's soft limit is 1,024 of those shared with
/// every session. Each address is held to `quota::MAX_READS_PER_IP` of these, so
/// one slow reader cannot hold them all.
const MAX_CONCURRENT_PAD_READS: usize = 64;

/// How long data sent to a peer may sit unacknowledged — because it has
/// stopped reading — before the kernel closes the connection.
///
/// A pad read holds its slots until its last byte is sent, and nothing in the
/// response can notice a reader that has stopped: the server stops pulling the
/// body when it cannot write, so a deadline inside it never runs. A handful
/// of readers that opened large pads and stopped reading held every slot,
/// and everyone else waited ten seconds to be told the server was busy. The
/// kernel can see it — see `give_up_on_stalled_peers`. A minute is longer than
/// any connection that is merely slow goes without draining anything.
const STALLED_PEER: std::time::Duration = std::time::Duration::from_secs(60);

/// How long a read waits for a slot before being told the server is busy.
/// Queuing is right for a moment's contention; a queue with no end is how a
/// few slow readers turn into requests that simply never answer.
const PAD_READ_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Parser, Debug)]
#[command(name = "ajar-relay", version, about = "Frame relay for ajar sessions")]
struct Args {
    /// Address to listen on.
    #[arg(long, default_value = "127.0.0.1:8787")]
    bind: SocketAddr,

    /// Optional directory of built web-client assets to serve.
    #[arg(long)]
    web: Option<String>,

    /// Where durable pads live.
    ///
    /// Sessions are in-memory and a restart losing them is correct; pads have
    /// no agent to rebuild them, so they are on disk. Two lifetimes, one
    /// process, kept apart deliberately.
    ///
    /// Relative by default so a dev run and every smoke test can create it
    /// without privileges. The systemd unit passes an absolute path — an
    /// unprivileged default of `/var/lib/...` refuses to start on a laptop,
    /// which is where this is run most often.
    #[arg(long, default_value = "./ajar-pads")]
    pad_dir: String,

    /// Bytes every pad together may occupy. Refuses new writes past it.
    ///
    /// The default suits the box this normally runs on. A smaller disk should
    /// say so — the point is to refuse before the disk is gone, and what
    /// "before" means is a property of the disk, not of this program.
    #[arg(long, default_value_t = pad::MAX_STORE_BYTES)]
    max_store_bytes: u64,

    /// Bytes one address may add to the pad store per day.
    ///
    /// A flag for the same reason the store ceiling is one: so a check can
    /// reach it in a few requests rather than a quarter of a gigabyte.
    #[arg(long, default_value_t = quota::MAX_PAD_GROWTH_PER_IP)]
    pad_growth_per_address: u64,

    /// Read the caller's address from `X-Forwarded-For`.
    ///
    /// Only when something you control sets it. Left on with nothing in
    /// front, any caller can claim to be any address and the per-address
    /// limits become decorative.
    #[arg(long)]
    trust_forwarded_for: bool,

    /// The accounts database: who has signed in, the pads they own, and the
    /// links to them. Its sealing key is kept beside it, as `<name>.key`.
    ///
    /// Relative by default for the same reason as `--pad-dir`. Signing in also
    /// needs `AJAR_PUBLIC_ORIGIN` and a provider's client id and secret — see
    /// `auth.rs` — and without them the site works exactly as before.
    #[arg(long, default_value = "./ajar-accounts.db")]
    accounts_db: String,

    /// Where the usage counts for the operator's view are kept (usage.rs):
    /// counts only, nobody's. Beside the accounts database unless named —
    /// `accounts.db` gives `usage.db`, `ajar-accounts.db` gives
    /// `ajar-usage.db`.
    #[arg(long)]
    usage_db: Option<String>,

    /// Pads one account may own.
    #[arg(long, default_value_t = accounts::MAX_PADS_PER_ACCOUNT)]
    account_max_pads: usize,

    /// Bytes one account's pads may hold together.
    #[arg(long, default_value_t = accounts::MAX_BYTES_PER_ACCOUNT)]
    account_max_bytes: u64,

    /// Write every pad out as one JSON document each, the way the store kept
    /// them before October 2026, into this directory, and exit. The way back:
    /// what a relay from before the change reads.
    #[arg(long, value_name = "DIR")]
    export_pads: Option<String>,
}

#[derive(Clone)]
struct AppState {
    registry: Arc<Registry>,
    quota: Arc<quota::Quota>,
    pads: Arc<Store>,
    /// Bounds how many pad writes are parsed and stored at once. See
    /// [`MAX_CONCURRENT_PAD_WRITES`].
    writing: Arc<tokio::sync::Semaphore>,
    /// Bytes of request bodies held at once, one permit a byte. See
    /// [`PAD_BODY_BUDGET`].
    receiving: Arc<tokio::sync::Semaphore>,
    /// [`BODY_IDLE`], as a field so a test can reach it in a moment.
    body_idle: std::time::Duration,
    /// Bounds how many pads are being streamed out at once. See
    /// [`MAX_CONCURRENT_PAD_READS`].
    reading: Arc<tokio::sync::Semaphore>,
    /// What each address has added to the pad store today.
    growth: Arc<quota::Growth>,
    trust_forwarded: bool,
    accounts: Arc<accounts::Accounts>,
    auth: Arc<auth::Auth>,
    /// One write at a time per account, so the room an account has left is
    /// read and spent as one step. Without it, writes in parallel each saw
    /// the same room and together went past it.
    account_writes:
        Arc<parking_lot::Mutex<std::collections::HashMap<i64, Arc<tokio::sync::Mutex<()>>>>>,
    /// When the relay started, for the operator's view.
    started: std::time::Instant,
    /// How the pad is used, counted as it happens: counts only (usage.rs).
    usage: Arc<usage::Usage>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ajar_relay=info".into()),
        )
        .init();

    let args = Args::parse();
    let pads = Arc::new(
        Store::open(&args.pad_dir, args.max_store_bytes)
            .map_err(|e| anyhow::anyhow!("cannot open the pad directory {}: {e}", args.pad_dir))?,
    );
    if let Some(out) = &args.export_pads {
        let n = pads
            .export_legacy(std::path::Path::new(out))
            .map_err(|e| anyhow::anyhow!("exporting the pads failed: {}", e.message()))?;
        info!("wrote {n} pads to {out}, one document each");
        return Ok(());
    }
    // Both numbers, because the interesting one is the gap. A relay that starts
    // already near its ceiling is a thing to know at boot rather than from the
    // first refused write.
    info!(
        "pads stored in {} — holding {} MB of {} MB",
        args.pad_dir,
        pads.used() / (1024 * 1024),
        args.max_store_bytes / (1024 * 1024),
    );

    let accounts = Arc::new(
        accounts::Accounts::open(std::path::Path::new(&args.accounts_db))
            .map_err(|e| {
                anyhow::anyhow!(
                    "cannot open the accounts database {}: {e}",
                    args.accounts_db
                )
            })?
            .with_limits(accounts::Limits {
                pads: args.account_max_pads,
                bytes: args.account_max_bytes,
                named: accounts::MAX_NAMED_PER_ACCOUNT,
            }),
    );
    // An owned pad lasts as long as its account: none of them lapses. Not
    // starting is better than starting without knowing which those are, when
    // the hourly sweep would treat every one of them as anonymous.
    let owned = accounts.owned_names().map_err(|e| {
        anyhow::anyhow!(
            "cannot read which pads are owned from {}: {}",
            args.accounts_db,
            e.message()
        )
    })?;
    for name in owned {
        pads.pin(&name);
    }
    let auth = Arc::new(auth::Auth::from_env());
    info!(
        "accounts in {} — sign-in offered with {:?}",
        args.accounts_db,
        auth.offered()
    );
    let usage_db = args.usage_db.clone().unwrap_or_else(|| {
        let accounts = std::path::Path::new(&args.accounts_db);
        let file = accounts
            .file_name()
            .and_then(|f| f.to_str())
            .filter(|f| f.contains("accounts"))
            .map_or_else(
                || "usage.db".to_string(),
                |f| f.replace("accounts", "usage"),
            );
        accounts.with_file_name(file).to_string_lossy().into_owned()
    });
    let usage = Arc::new(
        usage::Usage::open(std::path::Path::new(&usage_db))
            .map_err(|e| anyhow::anyhow!("cannot open the usage database {usage_db}: {e}"))?,
    );
    info!("usage counted in {usage_db}");

    let state = AppState {
        registry: Arc::new(Registry::new()),
        quota: Arc::new(quota::Quota::new()),
        pads: pads.clone(),
        writing: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_PAD_WRITES)),
        receiving: Arc::new(tokio::sync::Semaphore::new(PAD_BODY_BUDGET)),
        body_idle: BODY_IDLE,
        reading: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_PAD_READS)),
        growth: Arc::new(quota::Growth::new(args.pad_growth_per_address)),
        trust_forwarded: args.trust_forwarded_for,
        accounts,
        auth,
        account_writes: Default::default(),
        started: std::time::Instant::now(),
        usage: usage.clone(),
    };

    // How many are in pads and sessions, every 30 seconds, kept as the most in
    // each five minutes (usage.rs) — a 30-second look misses less of a busy
    // minute than a five-minute one would. And at the turn of each hour, what
    // is past keeping goes: within a minute of midnight, the day's hashes of
    // its pads and their key.
    {
        let registry = state.registry.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
            let mut pruned_hour = -1;
            loop {
                tick.tick().await;
                let census = registry.census();
                let usage = usage.clone();
                let now = usage::now();
                let prune = now / 3600 != pruned_hour;
                pruned_hour = now / 3600;
                let done = tokio::task::spawn_blocking(move || -> rusqlite::Result<()> {
                    let people = (census.pad_people + census.session_people) as i64;
                    usage.sample(people, census.pad_rooms as i64, census.sessions as i64, now)?;
                    if prune {
                        usage.prune(now)?;
                    }
                    Ok(())
                })
                .await;
                if let Ok(Err(e)) = done {
                    tracing::warn!("keeping the usage counts failed: {e}");
                }
            }
        });
    }

    // Pads past their lease. Hourly rather than every few seconds: a lease is
    // ninety days, and nothing goes wrong if a dead pad lingers an extra hour.
    // Reads check the lease too, so nobody is ever served an expired one.
    // Blocking work — it reads every pad — so off the workers that carry
    // people's keystrokes.
    {
        let pads = pads.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
            loop {
                tick.tick().await;
                let pads = pads.clone();
                let Ok(expired) = tokio::task::spawn_blocking(move || pads.sweep()).await else {
                    continue;
                };
                for name in expired {
                    info!(pad = %name, "expired after 90 days untouched; the name is free again");
                }
            }
        });
    }

    // Sessions whose host never came back are swept here. Without this a
    // dropped agent would hold its link forever.
    {
        let registry = state.registry.clone();
        tokio::spawn(async move {
            let notice = ajar_proto::Frame::json(
                ajar_proto::Channel::Control,
                ajar_proto::TARGET_ALL,
                &ajar_proto::Control::Closed {
                    reason: "the host did not come back".into(),
                },
            )
            .map(|f| f.encode())
            .unwrap_or_default();

            let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                tick.tick().await;
                for id in registry.reap(session::HOST_GRACE, &notice) {
                    info!(session = %id, "reaped after grace expired");
                }
            }
        });
    }

    let app = router(state, args.web.as_deref());
    if let Some(dir) = args.web.as_deref() {
        info!("serving web client from {dir}");
    }

    use axum::serve::ListenerExt;
    let listener = tokio::net::TcpListener::bind(args.bind)
        .await?
        .tap_io(|tcp| give_up_on_stalled_peers(tcp, STALLED_PEER));
    info!("relay listening on {}", args.bind);
    // `into_make_service_with_connect_info` so the quota can see who is
    // calling. Behind a proxy every connection is the proxy, which is why
    // `--trust-forwarded-for` exists.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}

/// Every route the relay answers, and the web client's files behind them when
/// it serves one. Apart from `main` so the tests can serve exactly this.
fn router(state: AppState, web: Option<&str>) -> Router {
    let mut app = Router::new()
        .route("/ws", get(upgrade))
        .route("/healthz", get(health))
        .route("/install.sh", get(install_script))
        .route("/run.sh", get(run_script))
        // A write's body is read by `receive`, which keeps to
        // `MAX_PAD_HTTP_BODY` itself: no extractor reads it, so a
        // `DefaultBodyLimit` here would limit nothing.
        .route("/api/pad/{name}", get(read_pad).put(write_pad))
        .route("/api/unfurl/{name}", get(unfurl))
        .route("/api/pad/{name}/history", get(history).post(keep_version))
        .route("/api/pad/{name}/history/{id}", get(version))
        // Read by `receive`, which keeps to `MAX_RUN_HTTP_BODY`; the
        // default limit is for extractors, and none reads this body.
        .route("/api/pad/{name}/run", get(last_run).put(keep_last_run))
        .merge(http_accounts::routes())
        .merge(http_admin::routes())
        .merge(usage::routes())
        // A path under /api/ that names nothing is not found. It fell
        // through to the web client and answered 200 with its index.html,
        // which a script reads as success and a browser shows as a page.
        // The more specific routes above win; this is what is left.
        .route("/api", any(no_such_route))
        .route("/api/", any(no_such_route))
        .route("/api/{*rest}", any(no_such_route))
        // No CORS layer, so no other origin may call this API from a page.
        // None needs to: the pad is served from the origin it calls, and in
        // development through Vite's proxy (pad/vite.config.ts); the session
        // client speaks only over the socket, which CORS does not govern;
        // and the checks and agents are programs, which it does not bind.
        // `CorsLayer::permissive()` was here, and told every site it might
        // read any answer and send any header — `X-Pad-Code` among them.
        .with_state(state);

    // In development the client is served by Vite; in a release build we can
    // hand out the compiled assets from the same process.
    if let Some(dir) = web {
        let index = ServeFile::new(format!("{dir}/index.html"));
        app = app.fallback_service(ServeDir::new(dir).fallback(index));
    }
    app
}

/// How long a readiness check waits for the databases to answer.
const READY_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(serde::Deserialize)]
struct HealthQuery {
    deep: Option<String>,
}

/// `ok`, from a process that is up: what the deploy and the checks wait for,
/// and what it always said.
///
/// With `?deep=1`, whether the pad can be used: the accounts database and
/// the pad store's each asked for a row of the table every request reads,
/// within [`READY_WAIT`] — 503 and which did not answer, and why, if either
/// did not. Plain `/healthz` said `ok` from a relay whose every pad request
/// was failing (audit B12); it still does, as liveness, and stays as cheap
/// as it was. A query string rather than a route of its own, so it takes
/// no name a pad could have.
async fn health(
    axum::extract::Query(query): axum::extract::Query<HealthQuery>,
    State(state): State<AppState>,
) -> axum::response::Response {
    if query.deep.is_none() {
        return "ok".into_response();
    }
    let (accounts, pads) = (state.accounts.clone(), state.pads.clone());
    let asked = tokio::task::spawn_blocking(move || {
        let mut wrong = Vec::new();
        if let Err(e) = accounts.ping() {
            wrong.push(format!("the accounts database: {}", e.message()));
        }
        if let Err(e) = pads.ping() {
            wrong.push(format!("the pad store: {}", e.message()));
        }
        wrong
    });
    let wrong = match tokio::time::timeout(READY_WAIT, asked).await {
        Ok(Ok(wrong)) => wrong,
        Ok(Err(_)) => vec!["the check itself failed".to_string()],
        Err(_) => vec![format!(
            "the databases did not answer within {} seconds",
            READY_WAIT.as_secs()
        )],
    };
    if wrong.is_empty() {
        "ready".into_response()
    } else {
        tracing::error!(reasons = %wrong.join("; "), "not ready");
        (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("not ready: {}", wrong.join("; ")),
        )
            .into_response()
    }
}

async fn no_such_route() -> (StatusCode, &'static str) {
    (StatusCode::NOT_FOUND, "no such API route")
}

/// Have the kernel close a connection whose peer has stopped reading.
///
/// `TCP_USER_TIMEOUT` bounds how long sent data may stay unacknowledged *or*
/// unsent behind a zero window — a reader that has stopped. Closing the
/// socket ends whatever was being streamed to it, and with it the slots it
/// held. Linux only; elsewhere the relay is a development build.
fn give_up_on_stalled_peers(tcp: &tokio::net::TcpStream, after: std::time::Duration) {
    #[cfg(target_os = "linux")]
    if let Err(e) = socket2::SockRef::from(tcp).set_tcp_user_timeout(Some(after)) {
        tracing::warn!("could not set TCP_USER_TIMEOUT: {e}");
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (tcp, after);
}

/// What the browser gets when it opens a name.
///
/// A name nobody holds is not an error — it is the normal way a pad begins,
/// and answering 404 would put a red line in the console every time somebody
/// started something. `exists` carries that instead.
#[derive(serde::Serialize)]
struct PadBody {
    exists: bool,
    access: http_accounts::AccessView,
    seq: u64,
    files: std::collections::BTreeMap<String, pad::File>,
    /// The reader has the pad at `seq` already (`x-pad-seq`), and `files`
    /// is empty for that reason, not because the pad is.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    unchanged: bool,
}

#[derive(serde::Deserialize)]
struct WriteBody {
    /// Kept to what a request may hold as they are read, so a body of
    /// millions costs no more than the most there may be: see `pad::writes`.
    #[serde(deserialize_with = "pad::writes")]
    writes: Vec<pad::Write>,
}

#[derive(serde::Serialize)]
struct Wrote {
    seq: u64,
    /// Each written file's hash, to send edits against next time.
    hashes: std::collections::BTreeMap<String, String>,
}

fn refuse(e: pad::Error) -> (StatusCode, String) {
    let code = match e {
        pad::Error::TooBig { .. }
        | pad::Error::TooManyFiles
        | pad::Error::TooManyWrites
        | pad::Error::TooManyEdits => StatusCode::PAYLOAD_TOO_LARGE,
        // Not the request's fault and worth retrying, which is what this status
        // means and what PAYLOAD_TOO_LARGE would wrongly deny.
        pad::Error::StoreFull => StatusCode::INSUFFICIENT_STORAGE,
        // The caller's own daily allowance: theirs to wait out, not the server's
        // fault, and retryable later — which is what 429 says.
        pad::Error::OverAllowance => StatusCode::TOO_MANY_REQUESTS,
        pad::Error::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        // Edits against a version the store no longer holds: the browser sends
        // the whole file instead.
        pad::Error::Stale => StatusCode::CONFLICT,
        _ => StatusCode::BAD_REQUEST,
    };
    (code, e.message())
}

/// What a read holds while it is sent: the address's read slot and one of
/// the global permits. See [`admit_read`].
type ReadHeld = (quota::Claim, tokio::sync::OwnedSemaphorePermit);

/// Let a read in, or say why not: one of the caller's
/// [`quota::MAX_READS_PER_IP`] slots, then one of the
/// [`MAX_CONCURRENT_PAD_READS`] permits, waiting at most [`PAD_READ_WAIT`]
/// for it. What it returns has to last until the response's last byte is
/// sent — see [`stream_json`].
async fn admit_read(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    peer: SocketAddr,
) -> Result<ReadHeld, (StatusCode, &'static str)> {
    let caller = caller_ip(headers, peer.ip(), state.trust_forwarded);
    let Ok(slot) = state
        .quota
        .claim(caller, std::time::Instant::now(), quota::Kind::Read)
    else {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many pads being read from this address at once — try again in a moment",
        ));
    };
    let Ok(Ok(permit)) =
        tokio::time::timeout(PAD_READ_WAIT, state.reading.clone().acquire_owned()).await
    else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "the server is busy sending other pads — try again in a moment",
        ));
    };
    Ok((slot, permit))
}

async fn read_pad(
    Path(name): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    State(state): State<AppState>,
) -> axum::response::Response {
    let held = match admit_read(&state, &headers, peer).await {
        Ok(held) => held,
        Err(refused) => return refused.into_response(),
    };

    // An owned pad says who may see it; an anonymous one is anybody's. Asked
    // after the slot and the permit, not before: the answer is a database
    // lookup, and a flood of reads the limits would refuse should not get one
    // each first.
    let access = match http_accounts::access(&state, &headers, &name).await {
        Ok(access) => access,
        Err(refused) => return refused.into_response(),
    };
    // Deleted is not private: the page says which, so an owner who deleted
    // it in another tab is not told to sign in as someone else.
    if access.deleted {
        return (StatusCode::GONE, "this pad was deleted by its owner").into_response();
    }
    if access.role == accounts::Role::None {
        // A code was presented and matched no link: it was reset or revoked,
        // and the page can say so — and forget it — rather than only that the
        // pad is private.
        let dead = headers.contains_key("x-pad-code") && access.link_role.is_none();
        let why = if dead {
            "the link you opened no longer works"
        } else {
            "this pad is private"
        };
        return (StatusCode::FORBIDDEN, why).into_response();
    }

    // A page opening the pad, rather than reading it again — after a save
    // elsewhere, a reconnect, a change of access — says so, and is counted
    // once it is served (usage.rs).
    let counted = headers.contains_key("x-pad-open").then(|| name.clone());
    let view = http_accounts::AccessView::from(&access);

    // A page that has the pad at a sequence says so, and is told it has it
    // rather than sent it all again. It reads again on every welcome to its
    // room and whenever anybody joins or leaves it, and for a 78 MB pad each
    // was 9 MB more to download (18 October). Who it is to the pad is said
    // either way: that is what a read after a change of access is for.
    let since = headers
        .get("x-pad-seq")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if let (Some(since), None) = (since, &counted) {
        let (pads, name) = (state.pads.clone(), name.clone());
        if let Ok(Ok(Some(seq))) =
            tokio::task::spawn_blocking(move || pads.unchanged_since(&name, since)).await
        {
            return Json(PadBody {
                exists: true,
                access: view,
                seq,
                files: Default::default(),
                unchanged: true,
            })
            .into_response();
        }
    }

    // Opening, checking and renewing are filesystem calls, so they go where
    // blocking belongs rather than stalling a worker carrying keystrokes.
    let pads = state.pads.clone();
    let Ok(opened) = tokio::task::spawn_blocking(move || pads.open_for_read(&name)).await else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "reading the pad failed").into_response();
    };
    if let (Some(pad), Ok(_)) = (counted, &opened) {
        usage::count_open(&state, pad);
    }
    match opened {
        // `exists` and who you are to this pad, then the stored object's own
        // fields. The stored document starts with `{`, which `open_for_read`
        // left off.
        Ok(Some(opened)) => stream_json(
            format!(
                r#"{{"exists":true,"access":{},"#,
                serde_json::to_string(&view).unwrap_or_else(|_| "{}".into())
            ),
            opened,
            held,
        ),
        Ok(None) => Json(PadBody {
            exists: false,
            access: view,
            seq: 0,
            files: Default::default(),
            unchanged: false,
        })
        .into_response(),
        Err(e) => refuse(e).into_response(),
    }
}

/// Who may look at a pad's history: whoever may read the pad. And who may
/// keep a version of it now: whoever may write it.
async fn history_access(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    name: &str,
    write: bool,
) -> Result<(), (StatusCode, &'static str)> {
    pad_access(
        state,
        headers,
        name,
        write,
        "only someone who can edit this pad can keep a version of it",
    )
    .await
}

/// Whoever may read a pad, or with `write` whoever may edit it — refused
/// otherwise, with `cannot` said to a reader who may not write.
async fn pad_access(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    name: &str,
    write: bool,
    cannot: &'static str,
) -> Result<(), (StatusCode, &'static str)> {
    let access = http_accounts::access(state, headers, name).await?;
    if access.deleted {
        return Err((StatusCode::GONE, "this pad was deleted by its owner"));
    }
    let enough = if write {
        access.role >= accounts::Role::Editor
    } else {
        access.role > accounts::Role::None
    };
    if !enough {
        return Err((
            StatusCode::FORBIDDEN,
            if write && access.role > accounts::Role::None {
                cannot
            } else {
                "this pad is private"
            },
        ));
    }
    Ok(())
}

/// What Run last printed in the pad, for whoever may read it; 204 when it has
/// not been run.
async fn last_run(
    Path(name): Path<String>,
    headers: axum::http::HeaderMap,
    State(state): State<AppState>,
) -> axum::response::Response {
    if let Err(refused) = pad_access(&state, &headers, &name, false, "").await {
        return refused.into_response();
    }
    let pads = state.pads.clone();
    match tokio::task::spawn_blocking(move || pads.last_run(&name)).await {
        Ok(Ok(Some(run))) => Json(run).into_response(),
        Ok(Ok(None)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => refuse(e).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "reading the last run failed",
        )
            .into_response(),
    }
}

/// A Run's output kept as the pad's last, from whoever may edit it, and
/// charged to their address's day as a write is — only what it adds, since
/// it replaces the one before.
async fn keep_last_run(
    Path(name): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    State(state): State<AppState>,
    body: axum::body::Body,
) -> axum::response::Response {
    // Read as a write's body is, within the same budget and deadlines — it
    // took no permit, but nothing bounded how many arrived at once, or how
    // slowly.
    let received = match receive(&state, &headers, body, MAX_RUN_HTTP_BODY).await {
        Ok(received) => received,
        Err(refused) => return refused.into_response(),
    };
    let run = match received.parse::<pad::LastRun>() {
        Ok(run) => run,
        Err(refused) => return refused.into_response(),
    };
    if let Err(refused) = pad_access(
        &state,
        &headers,
        &name,
        true,
        "only someone who can edit this pad can keep its output",
    )
    .await
    {
        return refused.into_response();
    }
    let caller = caller_ip(&headers, peer.ip(), state.trust_forwarded);
    let now = std::time::Instant::now();
    // What the store counts a run as, names and all; a store at its ceiling
    // refuses it below as it refuses a write (audit B09).
    if run.bytes() > state.growth.remaining(caller, now) {
        return refuse(pad::Error::OverAllowance).into_response();
    }
    let pads = state.pads.clone();
    match tokio::task::spawn_blocking(move || pads.set_last_run(&name, &run)).await {
        Ok(Ok(Some(grew))) => {
            state.growth.charge(caller, now, grew);
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            "there is no pad here to keep a run with",
        )
            .into_response(),
        Ok(Err(e)) => refuse(e).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "keeping the last run failed",
        )
            .into_response(),
    }
}

/// A pad's kept versions, newest first: when, how many files, how big.
async fn history(
    Path(name): Path<String>,
    headers: axum::http::HeaderMap,
    State(state): State<AppState>,
) -> axum::response::Response {
    if let Err(refused) = history_access(&state, &headers, &name, false).await {
        return refused.into_response();
    }
    let pads = state.pads.clone();
    match tokio::task::spawn_blocking(move || pads.history(&name)).await {
        Ok(Ok(versions)) => Json(versions).into_response(),
        Ok(Err(e)) => refuse(e).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "reading the history failed",
        )
            .into_response(),
    }
}

/// One version's files, as a read of the pad gives its files.
///
/// Let in as a read is and sent as one is, from its blobs, holding the same
/// slot and permit until the last byte has gone. It was neither: built whole
/// in memory — a version is as big as the pad was, up to 100 MiB — and
/// outside every bound on reads, so a few at once could take the relay's
/// memory and everyone's sessions with it (audit B03).
async fn version(
    Path((name, id)): Path<(String, u64)>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    State(state): State<AppState>,
) -> axum::response::Response {
    let held = match admit_read(&state, &headers, peer).await {
        Ok(held) => held,
        Err(refused) => return refused.into_response(),
    };
    if let Err(refused) = history_access(&state, &headers, &name, false).await {
        return refused.into_response();
    }
    let pads = state.pads.clone();
    match tokio::task::spawn_blocking(move || pads.open_version(&name, id)).await {
        Ok(Ok(Some(opened))) => stream_json("{".to_string(), opened, held),
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            "no such version of this pad, or no longer kept",
        )
            .into_response(),
        Ok(Err(e)) => refuse(e).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "reading the version failed",
        )
            .into_response(),
    }
}

/// The pad as it is now kept as a version, before a restore replaces it,
/// so the restore can be undone the same way.
async fn keep_version(
    Path(name): Path<String>,
    headers: axum::http::HeaderMap,
    State(state): State<AppState>,
) -> axum::response::Response {
    if let Err(refused) = history_access(&state, &headers, &name, true).await {
        return refused.into_response();
    }
    let pads = state.pads.clone();
    match tokio::task::spawn_blocking(move || pads.keep_now(&name)).await {
        Ok(Ok(id)) => Json(serde_json::json!({ "id": id })).into_response(),
        Ok(Err(e)) => refuse(e).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "keeping the version failed",
        )
            .into_response(),
    }
}

/// What a chat app shows for a pad link: a page of Open Graph tags.
///
/// Caddy sends link-preview bots here instead of to the page, which they
/// cannot run (deploy/Caddyfile, `@unfurl`). Asked as nobody: no cookie and
/// no link code go into the access check, so a preview says what anyone
/// with the bare link may see, whoever fetches it. A pad only some people
/// may view gets a card saying it is private and nothing of its contents —
/// the code that would open it is after the `#`, which never reaches a
/// server.
async fn unfurl(
    Path(name): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    State(state): State<AppState>,
) -> axum::response::Response {
    let caller = caller_ip(&headers, peer.ip(), state.trust_forwarded);
    let Ok(_slot) = state
        .quota
        .claim(caller, std::time::Instant::now(), quota::Kind::Read)
    else {
        return (StatusCode::TOO_MANY_REQUESTS, "too many requests").into_response();
    };
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .filter(|h| {
            h.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-.:".contains(&b))
        })
        .unwrap_or("code.rishwanth.dev")
        .to_string();
    let name = name.to_ascii_lowercase();
    if pad::check_name(&name).is_err() {
        return card(
            &host,
            "",
            "code.rishwanth.dev",
            "A pad: files you can edit together and run in the browser, nothing to install.",
        );
    }
    let access = match http_accounts::access(&state, &axum::http::HeaderMap::new(), &name).await {
        Ok(access) => access,
        // Who may see it is not known, so nothing of it is said.
        Err(_) => {
            return card(
                &host,
                &name,
                &name,
                "A pad: files you can edit together and run in the browser.",
            )
        }
    };
    if access.deleted {
        return card(&host, &name, &name, "This pad was deleted by its owner.");
    }
    if access.role == accounts::Role::None {
        return card(
            &host,
            &name,
            &name,
            "A private pad. Open the link to see it, if it was shared with you.",
        );
    }
    let pads = state.pads.clone();
    let lookup = name.clone();
    let summary = tokio::task::spawn_blocking(move || pads.summary(&lookup)).await;
    let description = match summary {
        Ok(Ok(Some(summary))) => describe(&summary),
        Ok(Ok(None)) => "An empty pad. Open it and start typing: files you can edit together and run in the browser.".to_string(),
        _ => "A pad: files you can edit together and run in the browser.".to_string(),
    };
    card(&host, &name, &name, &description)
}

/// A pad in a sentence or two: its files, and the first lines of the one a
/// reader would open first.
fn describe(summary: &pad::Summary) -> String {
    let files = match summary.files {
        1 => "1 file".to_string(),
        n => format!("{n} files"),
    };
    let mut names = summary.paths.join(", ");
    if summary.files > summary.paths.len() {
        names.push_str(", …");
    }
    let mut out = format!("{files}: {names}");
    if let Some((path, text)) = &summary.lead {
        let lines: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .take(4)
            .collect();
        if !lines.is_empty() {
            out.push_str(&format!(" — {path}: {}", lines.join(" · ")));
        }
    }
    if let Some((path, output)) = &summary.ran {
        let plain = plain(output);
        let lines: Vec<&str> = plain
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .take(3)
            .collect();
        if !lines.is_empty() {
            out.push_str(&format!(" — ran {path}: {}", lines.join(" · ")));
        }
    }
    shorten(&out, 280)
}

/// A terminal's text without its escapes — colours, cursor moves, titles —
/// for a preview that is only text.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                // CSI: parameters, then one final letter.
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC: to BEL, or to ESC \.
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\x07' || (c == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\r' => {}
            c if c.is_control() && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

fn shorten(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max - 1).collect();
    format!("{}…", cut.trim_end())
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// The page a bot reads: title, description, image, and where the pad is.
/// Not to be indexed — a pad is not a page for search engines — and short-
/// lived in caches, as the pad changes.
fn card(host: &str, name: &str, title: &str, description: &str) -> axum::response::Response {
    let url = format!("https://{host}/{name}");
    let (title, description, url) = (escape(title), escape(description), escape(&url));
    let image = escape(&format!("https://{host}/og.png"));
    let html = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{title}</title>
<meta name="description" content="{description}">
<meta name="robots" content="noindex">
<meta property="og:site_name" content="code.rishwanth.dev">
<meta property="og:type" content="website">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{description}">
<link rel="canonical" href="{url}">
</head><body><h1>{title}</h1><p>{description}</p><p><a href="{url}">Open it</a></p></body></html>"#
    );
    (
        [
            (axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (axum::http::header::CACHE_CONTROL, "public, max-age=300"),
        ],
        html,
    )
        .into_response()
}

/// A stored document — a pad, or a version of one — sent from its files with
/// `head` put in front: `{` and whatever fields the caller adds.
///
/// `held` is what has to last as long as the sending: the address's read slot
/// and the global permit. It rides inside the body stream, so it is released
/// when the last byte goes or the client disappears — not when this function
/// returns, which is before a single byte of the body has moved. Held by the
/// handler instead, the bound would cover nothing but opening the file.
fn stream_json(
    head: String,
    opened: pad::Opened,
    held: impl Send + 'static,
) -> axum::response::Response {
    use futures_util::{StreamExt, TryStreamExt};

    let head_len = head.len() as u64;
    // Kept until the body is sent or dropped: the store deletes a blob a
    // write let go of only once nothing is sending it.
    let reading = opened.reading;
    // Each blob opened when it is reached, not all at the start: a read holds
    // one file open, whatever the pad has in it.
    let rest = futures_util::stream::iter(opened.parts)
        .map(|part| match part {
            pad::Part::Bytes(bytes) => futures_util::stream::once(async move {
                Ok::<_, std::io::Error>(axum::body::Bytes::from(bytes))
            })
            .boxed(),
            pad::Part::Blob(path) => futures_util::stream::once(tokio::fs::File::open(path))
                .map_ok(tokio_util::io::ReaderStream::new)
                .try_flatten()
                .boxed(),
        })
        .flatten();
    let body = futures_util::stream::once(async move {
        Ok::<_, std::io::Error>(axum::body::Bytes::from(head))
    })
    .chain(rest)
    .map(move |chunk| {
        let _held = (&held, &reading);
        chunk
    });
    axum::response::Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .header(
            axum::http::header::CONTENT_LENGTH,
            head_len + opened.remaining,
        )
        .body(axum::body::Body::from_stream(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// A request body read off the wire, and the room it holds in
/// [`PAD_BODY_BUDGET`] until this is dropped — which the caller does when it
/// is done with what it parsed from it, not when the bytes are parsed.
struct Received {
    bytes: axum::body::Bytes,
    _held: tokio::sync::OwnedSemaphorePermit,
}

impl Received {
    /// The body as JSON, refused as axum's `Json` would refuse it: 400 for
    /// what is not JSON, 422 for JSON of the wrong shape.
    fn parse<T: serde::de::DeserializeOwned>(&self) -> Result<T, (StatusCode, String)> {
        Json::<T>::from_bytes(&self.bytes)
            .map(|Json(value)| value)
            .map_err(|rejection| (rejection.status(), rejection.body_text()))
    }
}

/// A JSON request body of at most `limit` bytes, read before anything waits
/// on a write permit and taking room in [`PAD_BODY_BUDGET`] as its bytes
/// arrive (see [`MAX_CONCURRENT_PAD_WRITES`]). Refused with 408 when nothing
/// arrives for [`BODY_IDLE`] or all of it has not within [`BODY_LONGEST`],
/// 413 past `limit` — said before a byte is read when the declared length
/// is already over — and 503 when no room is free within [`PAD_WRITE_WAIT`].
///
/// Room is taken a chunk at a time rather than for the declared length at
/// the start, because a declared length costs nothing to send: two requests
/// claiming 33 MiB and sending none of it would hold the whole budget, which
/// is the stall this replaced. The price is that two large bodies arriving
/// together into a nearly full budget can each wait on the room the other
/// holds; the one that has waited longest gives up first, with a 503 the page
/// tries again after, and the other goes on.
async fn receive(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    body: axum::body::Body,
    limit: usize,
) -> Result<Received, (StatusCode, String)> {
    use futures_util::StreamExt;

    if !json_content_type(headers) {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected request with `Content-Type: application/json`".to_string(),
        ));
    }
    let too_big = || {
        let most = if limit >= 1024 * 1024 {
            format!("{} MB", limit / (1024 * 1024))
        } else {
            format!("{} KB", limit / 1024)
        };
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("this request is bigger than the {most} one may be"),
        )
    };
    let shutting_down = || {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "the server is shutting down".to_string(),
        )
    };
    let declared = headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > limit as u64) {
        return Err(too_big());
    }

    let mut held = state
        .receiving
        .clone()
        .acquire_many_owned(0)
        .await
        .map_err(|_| shutting_down())?;
    // The chunks as they came, joined once at the end: grown in place, the
    // buffer would be up to twice what arrived, and the budget counts what
    // arrived.
    let mut chunks = Vec::new();
    let mut total = 0usize;
    let mut stream = body.into_data_stream();
    let longest = tokio::time::Instant::now() + BODY_LONGEST;
    loop {
        let wait = (tokio::time::Instant::now() + state.body_idle).min(longest);
        let chunk = match tokio::time::timeout_at(wait, stream.next()).await {
            Ok(Some(Ok(chunk))) => chunk,
            Ok(None) => break,
            Ok(Some(Err(e))) => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!("the request's body did not arrive whole: {e}"),
                ))
            }
            Err(_) => {
                return Err((
                    StatusCode::REQUEST_TIMEOUT,
                    "the rest of this request never arrived — try again".to_string(),
                ))
            }
        };
        total += chunk.len();
        if total > limit {
            return Err(too_big());
        }
        // `total` is at most `limit`, a few tens of MiB, so it fits.
        let room = tokio::time::timeout(
            PAD_WRITE_WAIT,
            state
                .receiving
                .clone()
                .acquire_many_owned(chunk.len() as u32),
        )
        .await;
        match room {
            Ok(Ok(room)) => held.merge(room),
            Ok(Err(_)) => return Err(shutting_down()),
            Err(_) => {
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "the server is busy saving other pads — try again in a moment".to_string(),
                ))
            }
        }
        chunks.push(chunk);
    }
    let bytes = match chunks.len() {
        0 => axum::body::Bytes::new(),
        1 => chunks.pop().expect("one chunk"),
        _ => {
            let mut joined = Vec::with_capacity(total);
            for chunk in chunks.drain(..) {
                joined.extend_from_slice(&chunk);
            }
            joined.into()
        }
    };
    Ok(Received { bytes, _held: held })
}

/// Whether the request says its body is JSON, as axum's `Json` asks:
/// `application/json`, or any `application/…+json`.
fn json_content_type(headers: &axum::http::HeaderMap) -> bool {
    let Some(value) = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let essence = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    essence == "application/json"
        || (essence.starts_with("application/") && essence.ends_with("+json"))
}

/// One of the [`MAX_CONCURRENT_PAD_WRITES`] permits to parse and store a
/// write, waiting at most [`PAD_WRITE_WAIT`] for it. Taken once the body is
/// in: it was taken before, and held while the body arrived, however slowly
/// (audit B04).
async fn write_permit(
    state: &AppState,
) -> Result<tokio::sync::OwnedSemaphorePermit, (StatusCode, String)> {
    match tokio::time::timeout(PAD_WRITE_WAIT, state.writing.clone().acquire_owned()).await {
        Ok(Ok(permit)) => Ok(permit),
        Ok(Err(_)) => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "the server is shutting down".to_string(),
        )),
        Err(_) => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "the server is busy saving other pads — try again in a moment".to_string(),
        )),
    }
}

async fn write_pad(
    Path(name): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    State(state): State<AppState>,
    body: axum::body::Body,
) -> Result<Json<Wrote>, (StatusCode, String)> {
    let received = receive(&state, &headers, body, MAX_PAD_HTTP_BODY).await?;
    let _permit = write_permit(&state).await?;
    let body: WriteBody = received.parse()?;
    let caller = caller_ip(&headers, peer.ip(), state.trust_forwarded);
    // Writing needs an edit link or the pad itself; viewing is not enough.
    // An anonymous pad lets everyone write, as it always has.
    let access = http_accounts::access(&state, &headers, &name)
        .await
        .map_err(|(code, why)| (code, why.to_string()))?;
    if access.deleted {
        return Err((
            StatusCode::GONE,
            "this pad was deleted by its owner".to_string(),
        ));
    }
    if access.role < accounts::Role::Editor {
        return Err((
            StatusCode::FORBIDDEN,
            if access.role == accounts::Role::None {
                "this pad is private".to_string()
            } else {
                "you can view this pad but not change it".to_string()
            },
        ));
    }
    let _account_turn = match access.owner {
        Some(owner) => {
            let lock = state
                .account_writes
                .lock()
                .entry(owner)
                .or_default()
                .clone();
            Some(lock.lock_owned().await)
        }
        None => None,
    };
    let now = std::time::Instant::now();
    let by_address = state.growth.remaining(caller, now);
    // An owned pad also draws on its account's room, whoever is writing —
    // and a room that cannot be counted is none, not all of it.
    let by_account = match access.owner {
        Some(owner) => {
            let (accounts, pad) = (state.accounts.clone(), name.clone());
            http_accounts::blocking(move || {
                Ok::<_, accounts::AccountError>(
                    accounts
                        .room_for(owner, &pad)?
                        .saturating_sub(accounts.bytes_of(&pad)?),
                )
            })
            .await
            .map_err(|e| {
                tracing::error!(pad = %name, error = %e.message(), "could not count an account's room; write refused");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "the server could not check the room this pad's account has left — try again in a moment"
                        .to_string(),
                )
            })?
        }
        None => u64::MAX,
    };
    let allowance = by_address.min(by_account);

    // Read, modify and rename under a lock: blocking work, kept off the workers
    // that carry every session's frames.
    let pads = state.pads.clone();
    let pad_name = name.clone();
    let written =
        tokio::task::spawn_blocking(move || pads.write_within(&pad_name, &body.writes, allowance))
            .await
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "storing the pad failed".to_string(),
                )
            })?
            .map_err(|e| {
                // Refused for the account's room rather than the address's
                // day: say which, or the advice is wrong.
                if e == pad::Error::OverAllowance && by_account < by_address {
                    (
                        StatusCode::INSUFFICIENT_STORAGE,
                        accounts::AccountError::OverQuota(state.accounts.limits().bytes).message(),
                    )
                } else {
                    refuse(e)
                }
            })?;
    state.growth.charge(caller, now, written.grew);
    if access.owner.is_some() {
        let accounts = state.accounts.clone();
        let (bytes, files) = (written.bytes, written.files);
        let pad = name.clone();
        // The write is in, so this cannot refuse it; it can say so. Left
        // unsaid, the account's room went on being counted at the size before.
        if let Err(e) =
            http_accounts::blocking(move || accounts.record_size(&pad, bytes, files)).await
        {
            tracing::error!(pad = %name, error = %e.message(), "could not record an owned pad's size");
        }
    }
    Ok(Json(Wrote {
        seq: written.seq,
        hashes: written.hashes,
    }))
}

/// `curl -sSf https://ajar.rishwanth.dev/run.sh | sh`
///
/// Install-if-missing and run, for a machine with nothing on it. The script
/// is rewritten to point at whichever relay served it: a self-hosted one
/// would otherwise hand out a script that dials ours, which is both wrong and
/// a quiet way to send someone else's session to a stranger.
///
/// The `Host` header is the only thing that knows the public address, since
/// the relay binds localhost behind a proxy. A caller can spoof it, but the
/// only script affected is the one they are downloading for themselves.
async fn run_script(headers: axum::http::HeaderMap) -> impl IntoResponse {
    const DEFAULT_ORIGIN: &str = "https://ajar.rishwanth.dev";
    let script = include_str!("../../../run.sh");

    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .filter(|h| !h.is_empty() && h.len() < 256 && !h.contains(|c: char| c.is_whitespace()));

    let body = match host {
        Some(host) => {
            // Behind a proxy the hop to us is plain http, so the header is
            // what says what the browser used. Local addresses are the one
            // place where plain http is the honest answer.
            let proto = headers
                .get("x-forwarded-proto")
                .and_then(|v| v.to_str().ok())
                .unwrap_or(
                    if host.starts_with("127.0.0.1") || host.starts_with("localhost") {
                        "http"
                    } else {
                        "https"
                    },
                );
            script.replace(DEFAULT_ORIGIN, &format!("{proto}://{host}"))
        }
        None => script.to_string(),
    };

    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        body,
    )
}

/// `curl -sSf https://ajar.rishwanth.dev/install.sh | sh`
///
/// Compiled in rather than served from disk: the installer and the relay ship
/// together, so there is no way for the published script to drift from the
/// version that was built, and nothing extra to deploy. Served as written: it
/// names no relay, only GitHub's releases, so there is nothing to rewrite.
async fn install_script() -> impl IntoResponse {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        include_str!("../../../install.sh"),
    )
}

/// Which address the per-address limits should be charged to.
///
/// The **rightmost** `X-Forwarded-For` value, not the leftmost. A proxy
/// *appends* the peer it actually saw, so the last element is the only one it
/// vouched for — everything to the left was supplied by the caller and can say
/// anything. Reading the leftmost made the quota decorative: a client sending
/// `X-Forwarded-For: 1.2.3.4` got that value back out, and rotating it bought
/// a fresh bucket on every request.
///
/// With `--trust-forwarded-for` off, or with no usable header, the socket's own
/// peer is the answer. That is also correct when the proxy replaces the header
/// rather than appending, since then there is only one element.
fn caller_ip(
    headers: &axum::http::HeaderMap,
    peer: std::net::IpAddr,
    trust_forwarded: bool,
) -> std::net::IpAddr {
    if !trust_forwarded {
        return peer;
    }
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit(',').next())
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(peer)
}

async fn upgrade(
    ws: WebSocketUpgrade,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: axum::http::HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let caller = caller_ip(&headers, peer.ip(), state.trust_forwarded);
    // Who the cookie says is signed in, for an owned pad's room. Read here,
    // on the upgrade, because it is the one request that carries the cookie
    // — and only from a page of ours: a socket opened by another page on the
    // same site brings the cookie too, and is nobody (audit B02).
    let user = http_accounts::signed_in(&state, &headers).await;
    let gate = ws::Gate {
        accounts: state.accounts.clone(),
        user: user.as_ref().map(|u| u.id),
        // Which sign-in, so that ending it ends what it let this socket do.
        session: user
            .and(http_accounts::session_token(&state, &headers))
            .map(|t| accounts::session_key(&t)),
    };
    // Cap what one client may send in a single frame. The largest legitimate
    // payload is a workspace snapshot, which the store already refuses above
    // 25 MB — so anything much larger than that is either a bug or an attempt
    // to make the relay allocate on demand.
    ws.max_message_size(32 * 1024 * 1024)
        .max_frame_size(32 * 1024 * 1024)
        .on_upgrade(move |socket| {
            ws::handle(
                socket,
                state.registry.clone(),
                state.quota.clone(),
                caller,
                gate,
            )
        })
}

#[cfg(test)]
mod tests {
    use super::caller_ip;

    #[test]
    fn a_link_preview_quotes_the_pad_and_escapes_it() {
        let summary = crate::pad::Summary {
            files: 8,
            paths: ["a.py", "b.py", "c.py", "d.py", "e.py", "main.py"]
                .map(String::from)
                .to_vec(),
            lead: Some((
                "main.py".to_string(),
                "\nimport flask\n\napp = Flask(__name__)\n".to_string(),
            )),
            ran: None,
        };
        let said = super::describe(&summary);
        assert!(
            said.starts_with("8 files: a.py, b.py, c.py, d.py, e.py, main.py, …"),
            "{said}"
        );
        assert!(
            said.ends_with("main.py: import flask · app = Flask(__name__)"),
            "{said}"
        );
        assert_eq!(
            super::escape(r#"<script>"a" & 'b'</script>"#),
            "&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;"
        );
        assert_eq!(super::shorten(&"x".repeat(300), 280).chars().count(), 280);
    }

    #[test]
    fn a_link_preview_quotes_the_last_run_without_its_escapes() {
        let summary = crate::pad::Summary {
            files: 1,
            paths: vec!["main.py".to_string()],
            lead: None,
            ran: Some((
                "main.py".to_string(),
                "\x1b]0;title\x07\x1b[32mhello\x1b[0m world\r\n\n42\n\x1b[1;31mdone\x1b[0m\nmore\n"
                    .to_string(),
            )),
        };
        assert_eq!(
            super::describe(&summary),
            "1 file: main.py — ran main.py: hello world · 42 · done"
        );
    }

    #[test]
    fn every_access_log_leaves_out_the_link_code() {
        // Audit B05: the page sends a link's code in `X-Pad-Code`, read in
        // http_accounts.rs, and Caddy logs request headers — blanking Cookie
        // and Authorization by default, but not one it does not know. Read
        // out of the Caddyfile that ships, as the reserved names are, so a
        // site or a log added later without the filter fails here. Caddy
        // itself checks the syntax, at every deploy.
        let caddyfile = include_str!("../../../deploy/Caddyfile");
        let logs: Vec<&str> = caddyfile
            .split("\n\tlog {")
            .skip(1)
            .map(|rest| rest.split("\n\t}").next().unwrap_or_default())
            .collect();
        assert_eq!(logs.len(), 3, "one access log a site");
        for log in logs {
            for header in ["X-Pad-Code", "Cookie", "Authorization"] {
                assert!(
                    log.contains(&format!("request>headers>{header} delete")),
                    "a log keeps {header}:{log}"
                );
            }
            assert!(log.contains("wrap json"), "the logs are still JSON:{log}");
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_peer_that_stops_reading_is_cut_off() {
        // Connected and silent: never reads a byte. Without the option the
        // server's writes would park once the buffers fill, for good.
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let _client = std::net::TcpStream::connect(addr).unwrap();
        let (mut server, _) = listener.accept().await.unwrap();
        super::give_up_on_stalled_peers(&server, std::time::Duration::from_secs(2));
        let chunk = vec![0u8; 64 * 1024];
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                if let Err(e) = server.write_all(&chunk).await {
                    return e;
                }
            }
        })
        .await;
        let error = outcome.expect("writes to a peer that stopped reading never failed");
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut, "{error}");
    }
    use axum::http::HeaderMap;
    use std::net::IpAddr;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn forwarded(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", value.parse().unwrap());
        h
    }

    #[test]
    fn a_caller_cannot_choose_its_own_address() {
        // The whole point. Caddy appends the peer it saw, so a client that
        // sends its own X-Forwarded-For produces `<theirs>, <real>` — and the
        // limits must charge the real one. Reading the leftmost here is what
        // made every per-address limit in the relay decorative.
        let headers = forwarded("1.2.3.4, 203.0.113.9");
        assert_eq!(
            caller_ip(&headers, ip("127.0.0.1"), true),
            ip("203.0.113.9")
        );
    }

    #[test]
    fn a_long_forged_chain_still_charges_the_last_hop() {
        let headers = forwarded("9.9.9.9, 8.8.8.8, 7.7.7.7, 203.0.113.9");
        assert_eq!(
            caller_ip(&headers, ip("127.0.0.1"), true),
            ip("203.0.113.9")
        );
    }

    #[test]
    fn one_honest_value_is_used_as_it_stands() {
        // A proxy that replaces rather than appends leaves a single element.
        let headers = forwarded("203.0.113.9");
        assert_eq!(
            caller_ip(&headers, ip("127.0.0.1"), true),
            ip("203.0.113.9")
        );
    }

    #[test]
    fn the_header_is_ignored_unless_it_is_trusted() {
        // Without the flag there is nothing in front, so the socket is the
        // only thing that cannot lie.
        let headers = forwarded("1.2.3.4");
        assert_eq!(
            caller_ip(&headers, ip("198.51.100.7"), false),
            ip("198.51.100.7")
        );
    }

    #[test]
    fn rubbish_falls_back_to_the_socket() {
        for value in ["", "not-an-ip", "1.2.3.4, ", ",,,"] {
            assert_eq!(
                caller_ip(&forwarded(value), ip("198.51.100.7"), true),
                ip("198.51.100.7"),
                "{value:?} should fall back"
            );
        }
        assert_eq!(
            caller_ip(&HeaderMap::new(), ip("198.51.100.7"), true),
            ip("198.51.100.7"),
            "an absent header should fall back"
        );
    }
}
