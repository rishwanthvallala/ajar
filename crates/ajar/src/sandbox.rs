//! Confining a guest to the folder that was shared.
//!
//! The guest keeps the host's real toolchain — that is the whole point of
//! lending a machine, and a container would hand them a different one. So
//! this restricts the *account* rather than replacing the environment:
//! writes are confined to the project, and the obvious credentials are made
//! unreadable.
//!
//! It is not a container and it is not a VM. A determined attacker with a
//! kernel bug gets out of it. What it stops is the ordinary case — a guest
//! reading `~/.ssh/id_rsa`, or a stray `rm -rf` outside the folder — and the
//! summary says exactly that rather than implying more.
//!
//! macOS uses Seatbelt through `sandbox-exec`. Apple has it marked
//! deprecated with no announced replacement, which is a dependency worth
//! knowing about: it is still the only documented way to apply a Seatbelt
//! profile to an arbitrary process.

use std::path::{Path, PathBuf};

/// Directories a toolchain has to write to or nothing builds. Confining
/// writes to the project alone would break `cargo`, `npm` and everything
/// else that keeps a per-user cache — which is worse than useless, because
/// people would turn the sandbox off.
const CACHE_DIRS: &[&str] = &[
    // Whole cache roots, deliberately, and not the subdirectories inside
    // them. Narrowing these to `.npm/_cacache` and the
    // like was tried and reverted: a grant whose path does not exist yet is
    // dropped on the floor (see `existing` in the landlock builder, and the
    // same is true of an sbpl subpath), and every one of these tools creates
    // its own subdirectories on demand — npm writes `_logs` on each run and
    // stages `npx` under `_npx`, cargo makes its lock files beside the
    // registry. Granting the child and not the parent means the tool cannot
    // create what it was about to use, so the narrower list works on a
    // machine where those directories already happen to exist and fails on a
    // fresh one, with an error that names npm rather than the sandbox.
    ".rustup",
    ".npm",
    ".cache",
    ".bun",
    ".deno",
    ".pnpm-store",
    ".gradle",
    ".m2",
    "go/pkg",
    "Library/Caches",
];

/// Credentials. Read access is denied even though everything else is
/// readable — these are the files a guest has no business seeing.
///
/// macOS only: Landlock is allow-list based, so the Linux path withholds the
/// whole home directory instead of naming what to deny.
#[cfg(target_os = "macos")]
const SECRET_DIRS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    ".config/gh",
    ".config/gcloud",
    ".config/op",
    ".password-store",
    "Library/Keychains",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox",
];

#[cfg(target_os = "macos")]
const SECRET_FILES: &[&str] = &[
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    ".cargo/credentials.toml",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    /// The OS is enforcing something.
    Confined {
        mechanism: &'static str,
        /// One line each, for the panel. Written for a host deciding whether
        /// to trust this, not for a security audit.
        allows: Vec<String>,
    },
    /// Nothing between a guest and the host account.
    Open { why: String },
}

/// The hidden subcommand the agent re-execs itself as on Linux.
pub const CONFINE_ARG: &str = "__confine";

/// The hidden subcommand that tries one unix socket and exits 0 if it
/// connected. Run through [`Sandbox::wrap`], it answers the only question that
/// matters about a socket: can a guest, inside the real sandbox, reach it?
#[cfg(unix)]
pub const REACH_ARG: &str = "__reach";

/// Sockets that hold the host's identity or more. Each exists on a typical
/// developer's machine, and each is reachable by its path whether or not the
/// variable naming it was withheld — so they are measured, not assumed.
/// What a socket is, and what reaching it lets somebody do.
#[cfg(unix)]
type Exposure = (&'static str, &'static str);

#[cfg(unix)]
fn key_holding_sockets() -> Vec<(PathBuf, Exposure)> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
    let mut out = Vec::new();

    const SSH: Exposure = (
        "your ssh agent",
        "they can sign in as you wherever your keys work",
    );
    if let Some(p) = std::env::var_os("SSH_AUTH_SOCK") {
        out.push((PathBuf::from(p), SSH));
    }

    const DOCKER: Exposure = (
        "the Docker socket",
        "anyone who can reach it can mount and read anything on this machine",
    );
    out.push((PathBuf::from("/var/run/docker.sock"), DOCKER));
    out.push((PathBuf::from("/run/docker.sock"), DOCKER));
    if let Some(h) = &home {
        out.push((h.join(".docker/run/docker.sock"), DOCKER));
        out.push((h.join(".docker/desktop/docker.sock"), DOCKER));
    }

    const GPG: Exposure = (
        "your gpg agent",
        "they can sign and decrypt with your keys while it holds them unlocked",
    );
    let gnupg = std::env::var_os("GNUPGHOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|h| h.join(".gnupg")));
    if let Some(g) = gnupg {
        out.push((g.join("S.gpg-agent"), GPG));
    }
    if let Some(r) = &runtime {
        out.push((r.join("gnupg/S.gpg-agent"), GPG));
    }

    const BUS: Exposure = (
        "your desktop session bus",
        "it hands out saved passwords from the keyring while it is unlocked",
    );
    let bus = std::env::var("DBUS_SESSION_BUS_ADDRESS")
        .ok()
        .and_then(|a| {
            a.split(',')
                .find_map(|kv| kv.strip_prefix("unix:path=").map(PathBuf::from))
        })
        .or_else(|| runtime.as_ref().map(|r| r.join("bus")));
    if let Some(b) = bus {
        out.push((b, BUS));
    }

    out.into_iter().filter(|(p, _)| p.exists()).collect()
}

pub struct Sandbox {
    pub mode: Mode,
    /// Passed directly to `sandbox-exec`, so no guest-writable pathname can
    /// replace the policy between construction and process launch.
    profile: Option<String>,
    project: PathBuf,
    network: bool,
}

impl Sandbox {
    pub fn is_confined(&self) -> bool {
        matches!(self.mode, Mode::Confined { .. })
    }

    /// Turn a shell into the command that actually gets spawned.
    ///
    /// macOS wraps it in `sandbox-exec`. Linux re-execs *this binary* as a
    /// launcher, because Landlock restricts the calling process and cannot be
    /// applied to one that is already running — so something has to restrict
    /// itself and then `exec` the shell.
    pub fn wrap(&self, shell: &str) -> (String, Vec<String>) {
        match &self.mode {
            Mode::Confined { mechanism, .. } if *mechanism == "seatbelt" => {
                let profile = match &self.profile {
                    Some(p) => p.clone(),
                    None => return (shell.to_string(), Vec::new()),
                };
                (
                    "/usr/bin/sandbox-exec".to_string(),
                    vec!["-p".to_string(), profile, shell.to_string()],
                )
            }
            Mode::Confined { mechanism, .. } if *mechanism == "landlock" => {
                let me = std::env::current_exe()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| "ajar".to_string());
                (
                    me,
                    vec![
                        CONFINE_ARG.to_string(),
                        self.project.display().to_string(),
                        if self.network { "net" } else { "no-net" }.to_string(),
                        "--".to_string(),
                        shell.to_string(),
                    ],
                )
            }
            _ => (shell.to_string(), Vec::new()),
        }
    }

    /// One paragraph a host can actually read.
    pub fn summary(&self) -> String {
        match &self.mode {
            Mode::Confined { mechanism, allows } => {
                format!("sandboxed with {mechanism} — {}", allows.join(", "))
            }
            Mode::Open { why } => format!("no sandbox: {why}"),
        }
    }

    /// What this machine's sandbox cannot enforce, said before the link is.
    pub fn gaps(&self) -> Vec<String> {
        match &self.mode {
            #[cfg(target_os = "linux")]
            Mode::Confined { mechanism, .. } if *mechanism == "landlock" => linux::gaps(),
            _ => Vec::new(),
        }
    }

    /// Key-holding sockets a guest can connect to from inside this sandbox,
    /// one sentence each.
    ///
    /// Measured by running this binary through the same wrapper a guest's shell
    /// gets, rather than reasoned about from the rules: a rule set read on paper
    /// cannot say whether a connect will be refused, and a warning that is wrong
    /// in either direction is the thing this project keeps having to undo.
    /// Withholding `SSH_AUTH_SOCK` does not hide the socket — its path sits in a
    /// temp directory the guest can list.
    #[cfg(unix)]
    pub fn reachable_sockets(&self) -> Vec<String> {
        // With no sandbox the notice already says a guest has everything.
        if !self.is_confined() {
            return Vec::new();
        }
        let Ok(me) = std::env::current_exe() else {
            return Vec::new();
        };
        let mut said: Vec<&str> = Vec::new();
        let mut out = Vec::new();
        for (path, (what, consequence)) in key_holding_sockets() {
            if said.contains(&what) {
                continue;
            }
            let (program, mut args) = match &self.mode {
                // The Landlock launcher probes in its own process once it has
                // restricted itself. Exec'ing this binary instead would fail:
                // it is installed under the home directory, which the sandbox
                // hides, so every socket would read as unreachable — a
                // reassurance produced by the probe breaking.
                Mode::Confined { mechanism, .. } if *mechanism == "landlock" => {
                    self.wrap(REACH_ARG)
                }
                _ => {
                    let (program, mut args) = self.wrap(&me.display().to_string());
                    args.push(REACH_ARG.to_string());
                    (program, args)
                }
            };
            args.push(path.display().to_string());
            let reached = std::process::Command::new(program)
                .args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success());
            if reached {
                said.push(what);
                out.push(format!(
                    "a guest can reach {what} at {} — {consequence}",
                    path.display()
                ));
            }
        }
        out
    }

    #[cfg(not(unix))]
    pub fn reachable_sockets(&self) -> Vec<String> {
        Vec::new()
    }

    /// Deliberately unsandboxed, with the reason recorded.
    pub fn open(why: &str) -> Self {
        Sandbox {
            mode: Mode::Open { why: why.into() },
            profile: None,
            project: PathBuf::new(),
            network: true,
        }
    }

    /// Build a sandbox for this project, or explain why there isn't one.
    pub fn build(project: &Path, allow_network: bool) -> Self {
        #[cfg(target_os = "macos")]
        {
            match macos::profile(project, allow_network) {
                Ok((profile, allows)) => Sandbox {
                    mode: Mode::Confined {
                        mechanism: "seatbelt",
                        allows,
                    },
                    profile: Some(profile),
                    project: project.to_path_buf(),
                    network: allow_network,
                },
                Err(why) => Sandbox {
                    mode: Mode::Open { why },
                    profile: None,
                    project: project.to_path_buf(),
                    network: true,
                },
            }
        }
        #[cfg(target_os = "linux")]
        {
            match linux::available() {
                Ok(abi) => Sandbox {
                    mode: Mode::Confined {
                        mechanism: "landlock",
                        allows: linux::describe(abi, allow_network),
                    },
                    profile: None,
                    project: project.to_path_buf(),
                    network: allow_network,
                },
                Err(why) => Sandbox {
                    mode: Mode::Open { why },
                    profile: None,
                    project: project.to_path_buf(),
                    network: true,
                },
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (project, allow_network);
            Sandbox {
                mode: Mode::Open {
                    why: "no sandbox is implemented for this platform".into(),
                },
                profile: None,
                project: PathBuf::new(),
                network: true,
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::fmt::Write as _;

    /// SBPL string literals are double-quoted with backslash escapes. A path
    /// containing a quote would otherwise end the literal early and change
    /// what the rest of the profile means.
    fn quote(path: &str) -> String {
        let mut out = String::with_capacity(path.len() + 2);
        out.push('"');
        for ch in path.chars() {
            if ch == '"' || ch == '\\' {
                out.push('\\');
            }
            out.push(ch);
        }
        out.push('"');
        out
    }

    /// Both the path as given and its canonical form. On macOS `/tmp` is a
    /// symlink to `/private/tmp`, and Seatbelt matches the resolved path — a
    /// rule naming only one of them silently does nothing.
    fn both_forms(path: &Path) -> Vec<String> {
        let mut out = vec![path.display().to_string()];
        if let Ok(real) = path.canonicalize() {
            let real = real.display().to_string();
            if !out.contains(&real) {
                out.push(real);
            }
        }
        out
    }

    fn home() -> Option<PathBuf> {
        std::env::var_os("HOME").map(PathBuf::from)
    }

    pub fn profile(project: &Path, allow_network: bool) -> Result<(String, Vec<String>), String> {
        if !Path::new("/usr/bin/sandbox-exec").exists() {
            return Err("sandbox-exec is missing from this system".into());
        }
        let home = home().ok_or_else(|| "HOME is not set".to_string())?;

        let mut sbpl = String::from("(version 1)\n(allow default)\n\n");

        // ---- writes ------------------------------------------------------
        sbpl.push_str(";; deny every write, then hand back the ones a\n");
        sbpl.push_str(";; toolchain genuinely needs\n(deny file-write*)\n\n(allow file-write*\n");
        let mut writable = Vec::new();
        for form in both_forms(project) {
            let _ = writeln!(sbpl, "  (subpath {})", quote(&form));
            writable.push(form);
        }
        for dir in [
            "/tmp",
            "/private/tmp",
            "/private/var/folders",
            "/var/folders",
        ] {
            let _ = writeln!(sbpl, "  (subpath {})", quote(dir));
        }
        for cache in CACHE_DIRS {
            let p = home.join(cache);
            let _ = writeln!(sbpl, "  (subpath {})", quote(&p.display().to_string()));
        }
        // A shell that cannot write to its tty is not a shell.
        for dev in [
            "/dev/null",
            "/dev/zero",
            "/dev/stdout",
            "/dev/stderr",
            "/dev/tty",
        ] {
            let _ = writeln!(sbpl, "  (literal {})", quote(dev));
        }
        sbpl.push_str("  (regex #\"^/dev/ttys[0-9]*$\")\n");
        sbpl.push_str("  (regex #\"^/dev/pty.*$\")\n)\n\n");

        // ---- credentials -------------------------------------------------
        sbpl.push_str(";; readable by default, except the things a guest has\n");
        sbpl.push_str(";; no business seeing\n(deny file-read*\n");
        for dir in SECRET_DIRS {
            let p = home.join(dir);
            let _ = writeln!(sbpl, "  (subpath {})", quote(&p.display().to_string()));
        }
        for file in SECRET_FILES {
            let p = home.join(file);
            let _ = writeln!(sbpl, "  (literal {})", quote(&p.display().to_string()));
        }
        sbpl.push_str(")\n");

        if !allow_network {
            sbpl.push_str("\n;; no outbound anything\n(deny network*)\n");
        }

        let allows = vec![
            "writes confined to the shared folder, temp and build caches".to_string(),
            "ssh, cloud and browser credentials unreadable".to_string(),
            if allow_network {
                "network allowed".to_string()
            } else {
                "no network".to_string()
            },
        ];
        Ok((sbpl, allows))
    }
}

#[cfg(target_os = "linux")]
pub mod linux {
    use super::*;
    use landlock::{
        path_beneath_rules, Access, AccessFs, AccessNet, CompatLevel, Compatible, Ruleset,
        RulesetAttr, RulesetCreatedAttr, RulesetStatus, Scope, ABI,
    };

    /// The newest ABI this has been written and attacked against.
    ///
    /// It was ABI 1 until September 2026, and that was a hole rather than a
    /// cautious floor: ABI 1 has no notion of truncation, so `truncate(2)` —
    /// which takes a path and needs no writable file descriptor — emptied any
    /// file the host owned, anywhere, from a shell that could not write a byte
    /// outside the folder. ABI 6 governs truncation and stops a guest
    /// signalling processes outside its own terminal, which includes this agent.
    ///
    /// Older kernels get what they support and the summary names what is
    /// missing. Newer ABIs are not reached for until someone has run
    /// `scripts/linux-sandbox.sh` on a kernel that has them.
    pub const TARGET: ABI = ABI::V6;

    /// Whether the running kernel will actually enforce a ruleset built by
    /// `build`.
    ///
    /// Asked as a hard requirement, and that is the whole point. The crate's
    /// default is best effort, under which an unsupported right is dropped
    /// without an error and `create()` still succeeds — so every one of these
    /// probes used to answer "yes" on every kernel. A host on Linux 6.1 was told
    /// "no outbound network" and given a shell that could reach anything.
    fn enforced(build: impl FnOnce(Ruleset) -> Result<Ruleset, landlock::RulesetError>) -> bool {
        build(Ruleset::default().set_compatibility(CompatLevel::HardRequirement))
            .and_then(|r| r.create())
            .is_ok()
    }

    /// Landlock has been in the kernel since 5.13, but a distribution can
    /// leave it out of the active LSM list, in which case the syscall exists
    /// and enforces nothing. Ask for the ABI rather than assuming.
    pub fn available() -> Result<ABI, String> {
        let abi = ABI::V1;
        if enforced(|r| r.handle_access(AccessFs::from_all(abi))) {
            Ok(abi)
        } else {
            Err("landlock is not enabled on this kernel".into())
        }
    }

    /// Whether this kernel can refuse outbound TCP.
    ///
    /// Network rules arrived in ABI 4 (Linux 6.7). Older kernels can still
    /// confine the filesystem, so this is asked separately rather than
    /// refusing to sandbox at all.
    pub fn can_restrict_network() -> bool {
        enforced(|r| r.handle_access(AccessNet::ConnectTcp))
    }

    /// Whether this kernel can refuse `truncate(2)` outside the grants. ABI 3,
    /// Linux 6.2.
    pub fn can_refuse_truncation() -> bool {
        enforced(|r| r.handle_access(AccessFs::Truncate))
    }

    /// Whether this kernel can stop a guest signalling processes it did not
    /// start. ABI 6, Linux 6.12.
    pub fn can_scope_signals() -> bool {
        enforced(|r| r.scope(Scope::Signal))
    }

    pub fn describe(_abi: ABI, allow_network: bool) -> Vec<String> {
        vec![
            "writes confined to the shared folder, temp and build caches".to_string(),
            "the rest of your home directory unreadable — ssh, cloud, browser".to_string(),
            match (allow_network, can_restrict_network()) {
                (true, _) => "network allowed".to_string(),
                (false, true) => "no outbound network".to_string(),
                // Said plainly rather than implied. A flag that reports
                // success while enforcing nothing is worse than one that
                // admits it cannot.
                (false, false) => {
                    "network NOT restricted — this kernel is older than 6.7".to_string()
                }
            },
        ]
    }

    /// What this kernel cannot enforce, in words a host can act on.
    ///
    /// Kept out of the one-line summary and put where the panel wraps text:
    /// these are the sentences that change whether somebody sends the link.
    pub fn gaps() -> Vec<String> {
        let mut out = Vec::new();
        if !can_refuse_truncation() {
            out.push(
                "this kernel is older than 6.2, so a guest can still empty any file you own by \
                 truncating it — outside the shared folder too"
                    .to_string(),
            );
        }
        if !can_scope_signals() {
            out.push(
                "this kernel is older than 6.12, so a guest can signal your other processes — \
                 including this one, which ends the session"
                    .to_string(),
            );
        }
        out
    }

    fn home() -> PathBuf {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"))
    }

    /// Everything outside the home directory, granted read and execute.
    ///
    /// Landlock is allow-list only — there is no way to say "everything
    /// except this". So instead of granting `/` and trying to carve out
    /// `~/.ssh`, grant each top-level directory *except* the one home lives
    /// under, and then hand back only the parts of home that are needed.
    ///
    /// That makes Linux stricter than macOS here: the whole home directory is
    /// invisible apart from what is listed, rather than just the credential
    /// directories we happened to think of.
    fn system_paths(home: &Path) -> Vec<PathBuf> {
        // The top-level directory home sits under — `/home` for a normal
        // account, `/root` for root. `Ancestors` only walks upward, so take
        // the last one whose parent is `/`.
        let home_root = home
            .ancestors()
            .filter(|p| p.parent() == Some(Path::new("/")))
            .map(|p| p.to_path_buf())
            .last();

        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir("/") else {
            return vec![PathBuf::from("/usr"), PathBuf::from("/bin")];
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if Some(&path) == home_root.as_ref() {
                continue;
            }
            out.push(path);
        }
        out
    }

    /// Home entries a shell and a toolchain cannot start without. Config, not
    /// credentials — everything else under home stays invisible.
    const HOME_READABLE: &[&str] = &[
        ".zshrc",
        ".zshenv",
        ".zprofile",
        ".bashrc",
        ".bash_profile",
        ".profile",
        ".inputrc",
        ".oh-my-zsh",
        ".terminfo",
        ".gitconfig",
        // Rustup installs its executable proxies here. Cargo's mutable home is
        // redirected to the guest cache, so this directory can remain read-only
        // and cannot expose credentials.toml.
        ".cargo/bin",
    ];

    /// Restrict this process, then become the shell.
    ///
    /// Landlock applies to the calling thread and is inherited across `exec`,
    /// so the only way to confine a pty's shell is for something to restrict
    /// itself and then turn into it.
    pub fn confine_and_exec(args: Vec<std::ffi::OsString>) -> anyhow::Result<()> {
        use std::os::unix::process::CommandExt;

        let mut it = args.into_iter();
        let project = PathBuf::from(it.next().unwrap_or_default());
        let network = it.next().map(|s| s == *"net").unwrap_or(true);
        // Skip the `--` separator.
        let _ = it.next();
        let program = it.next().ok_or_else(|| anyhow::anyhow!("nothing to run"))?;
        let rest: Vec<std::ffi::OsString> = it.collect();
        let _ = network;

        // Writable paths get every write right of the target ABI, which now
        // includes truncation and cross-directory renames: handled but never
        // granted anywhere else, both are refused outside these paths.
        let abi = TARGET;
        let read = AccessFs::from_read(abi);
        let write = AccessFs::from_write(abi) | read;
        let home = home();

        let mut writable: Vec<PathBuf> = vec![project.clone()];
        if let Ok(real) = project.canonicalize() {
            if real != project {
                writable.push(real);
            }
        }
        writable.extend([PathBuf::from("/tmp"), PathBuf::from("/var/tmp")]);
        for dev in [
            "/dev/null",
            "/dev/zero",
            "/dev/full",
            "/dev/tty",
            "/dev/pts",
            "/dev/ptmx",
        ] {
            writable.push(PathBuf::from(dev));
        }
        for cache in CACHE_DIRS {
            writable.push(home.join(cache));
        }

        let mut readable = system_paths(&home);
        for entry in HOME_READABLE {
            readable.push(home.join(entry));
        }

        // Paths that do not exist cannot be granted, and a missing cache
        // directory is not a reason to refuse to start.
        let existing =
            |v: Vec<PathBuf>| -> Vec<PathBuf> { v.into_iter().filter(|p| p.exists()).collect() };

        // Cutting off the network means handling the access and then adding
        // no rule for it: Landlock only grants, so an unmentioned port is a
        // refused one.
        //
        // Best effort, deliberately, unlike the probes above: an older kernel
        // should still get the filesystem rules it can enforce. What it cannot
        // is said by `gaps()` before the link is printed.
        //
        // Scoping means a process in this terminal cannot signal, or reach an
        // abstract socket of, anything outside it. The cost is that a sibling
        // terminal is outside it too, so `kill` of a server started in another
        // tab is refused — stop it from the tab that started it.
        let mut ruleset = Ruleset::default()
            .handle_access(AccessFs::from_all(abi))?
            .scope(Scope::Signal | Scope::AbstractUnixSocket)?;
        let restricting_network = !network && can_restrict_network();
        if restricting_network {
            ruleset = ruleset.handle_access(AccessNet::ConnectTcp)?;
        }

        let status = ruleset
            .create()?
            .add_rules(path_beneath_rules(existing(readable), read))?
            .add_rules(path_beneath_rules(existing(writable), write))?
            .restrict_self()?;

        if status.ruleset == RulesetStatus::NotEnforced {
            anyhow::bail!("landlock accepted the rules but is not enforcing them");
        }
        if !network && !restricting_network {
            // The caller asked for no network and this kernel cannot give it.
            // Starting anyway while reporting success is how a security flag
            // becomes decorative.
            anyhow::bail!(
                "--no-network needs landlock ABI 4 (linux 6.7); this kernel cannot enforce it"
            );
        }

        // The socket probe, answered from inside the ruleset a guest's shell
        // gets rather than by a process that would first need to exec.
        if program == REACH_ARG {
            let reached = rest
                .first()
                .is_some_and(|p| std::os::unix::net::UnixStream::connect(p).is_ok());
            std::process::exit(if reached { 0 } else { 1 });
        }

        let mut cmd = std::process::Command::new(&program);
        cmd.args(rest);
        // `exec` replaces this process, so nothing after it runs.
        Err(cmd.exec().into())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    struct Fixture {
        project: PathBuf,
        outside: PathBuf,
        sandbox: Sandbox,
    }

    /// Fixtures live under HOME, not in temp.
    ///
    /// Temp is deliberately writable — every toolchain needs it — so a test
    /// that puts its "outside" file there is testing nothing. The location a
    /// host actually cares about is their home directory.
    fn fixture(name: &str, network: bool) -> Fixture {
        let root = PathBuf::from(std::env::var("HOME").unwrap())
            .join(".ajar-sandbox-tests")
            .join(name);
        let _ = fs::remove_dir_all(&root);
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("readme.md"), "hello\n").unwrap();
        let outside = root.join("outside.txt");
        fs::write(&outside, "not yours\n").unwrap();
        let project = project.canonicalize().unwrap();
        let sandbox = Sandbox::build(&project, network);
        Fixture {
            project,
            outside,
            sandbox,
        }
    }

    /// Run a shell command inside the sandbox, from the project directory.
    fn run(f: &Fixture, script: &str) -> (bool, String) {
        let (cmd, args) = f.sandbox.wrap("/bin/sh");
        let out = Command::new(cmd)
            .args(args)
            .arg("-c")
            .arg(script)
            .current_dir(&f.project)
            .output()
            .expect("spawn");
        (
            out.status.success(),
            format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            ),
        )
    }

    #[test]
    fn temp_is_writable_and_the_summary_admits_it() {
        // Not a leak so much as a compromise: confining writes to the project
        // alone breaks anything that uses TMPDIR, which is nearly everything.
        // It should be stated, not discovered.
        let f = fixture("temp", true);
        let probe = std::env::temp_dir().join("ajar-temp-probe");
        let (ok, out) = run(&f, &format!("echo x > {}", probe.display()));
        assert!(
            ok,
            "temp was not writable, which breaks most toolchains: {out}"
        );
        let _ = fs::remove_file(&probe);
        assert!(
            f.sandbox.summary().contains("temp"),
            "the summary should mention temp: {}",
            f.sandbox.summary()
        );
    }

    #[test]
    fn a_sandbox_is_actually_built() {
        let f = fixture("built", true);
        assert!(f.sandbox.is_confined(), "{}", f.sandbox.summary());
        assert!(f.sandbox.summary().contains("seatbelt"));
    }

    #[test]
    fn work_inside_the_project_is_unaffected() {
        let f = fixture("inside", true);
        let (ok, out) = run(&f, "echo written > new.txt && cat new.txt && cat readme.md");
        assert!(ok, "ordinary work was blocked: {out}");
        assert!(out.contains("written") && out.contains("hello"), "{out}");
    }

    #[test]
    fn writing_outside_the_project_is_refused() {
        let f = fixture("outside", true);
        let escape = f.outside.parent().unwrap().join("escaped.txt");
        let (_, out) = run(&f, &format!("echo x > {}", escape.display()));
        assert!(
            !escape.exists(),
            "a guest wrote outside the shared folder: {out}"
        );
    }

    #[test]
    fn deleting_outside_the_project_is_refused() {
        let f = fixture("delete", true);
        let (_, out) = run(&f, &format!("rm -f {}", f.outside.display()));
        assert!(
            f.outside.exists(),
            "a guest deleted a file outside the folder: {out}"
        );
    }

    #[test]
    fn credentials_are_unreadable() {
        let f = fixture("creds", true);
        let home = std::env::var("HOME").unwrap();
        // Read whatever really exists rather than planting a decoy, so the
        // test fails if the profile stops covering the real location.
        let (_, out) = run(
            &f,
            &format!("cat {home}/.ssh/* 2>&1; ls {home}/.aws 2>&1; true"),
        );
        assert!(
            !out.contains("PRIVATE KEY") && !out.contains("BEGIN OPENSSH"),
            "a private key was readable inside the sandbox"
        );
        assert!(
            out.contains("Operation not permitted") || out.contains("No such file"),
            "expected a refusal or an absent directory, got: {out}"
        );
    }

    #[test]
    fn the_home_directory_is_not_writable() {
        let f = fixture("home", true);
        let home = std::env::var("HOME").unwrap();
        let target = format!("{home}/ajar-sandbox-escape-check");
        let (_, out) = run(&f, &format!("echo x > {target}"));
        assert!(
            !Path::new(&target).exists(),
            "a guest wrote into the host's home directory: {out}"
        );
        let _ = fs::remove_file(&target);
    }

    #[test]
    fn toolchain_caches_stay_writable() {
        // Confining writes to the project alone breaks every build tool that
        // keeps a per-user cache, and a sandbox people switch off protects
        // nobody.
        let f = fixture("cache", true);
        let home = std::env::var("HOME").unwrap();
        let probe = format!("{home}/.cache/ajar-sandbox-probe");
        let (ok, out) = run(&f, &format!("mkdir -p {home}/.cache && echo x > {probe}"));
        assert!(ok, "a toolchain cache was not writable: {out}");
        let _ = fs::remove_file(&probe);
    }

    #[test]
    fn a_tool_can_create_a_cache_directory_it_has_not_used_before() {
        // The reason CACHE_DIRS lists roots rather than the subdirectories
        // inside them. A grant for a path that does not exist is silently
        // dropped, so granting `.npm/_npx` on a machine that has one proves
        // nothing about a machine that does not — there the guest cannot
        // create it either, and `npx` fails with EPERM and advice to chown a
        // directory that was never the problem.
        let f = fixture("fresh-cache", true);
        let home = std::env::var("HOME").unwrap();
        let fresh = format!("{home}/.cache/ajar-probe-{}", std::process::id());
        let (ok, out) = run(
            &f,
            &format!("mkdir -p {fresh}/nested && echo x > {fresh}/nested/f"),
        );
        assert!(
            ok,
            "a tool could not create a cache directory it had not used before: {out}"
        );
        let _ = fs::remove_dir_all(&fresh);
    }

    #[test]
    fn network_can_be_denied() {
        let f = fixture("nonet", false);
        assert!(
            f.sandbox.summary().contains("no network"),
            "{}",
            f.sandbox.summary()
        );
        let (ok, _) = run(&f, "nc -z -w1 1.1.1.1 80 2>/dev/null");
        assert!(!ok, "the network was reachable with network denied");
    }

    #[test]
    fn a_path_with_a_quote_cannot_break_the_profile() {
        // A folder named `foo"bar` would otherwise close the SBPL string and
        // turn the rest of the profile into something else entirely.
        let root = PathBuf::from(std::env::var("HOME").unwrap())
            .join(".ajar-sandbox-tests")
            .join("quote");
        let _ = fs::remove_dir_all(&root);
        let project = root.join("we\"ird");
        fs::create_dir_all(&project).unwrap();
        let project = project.canonicalize().unwrap();
        let sandbox = Sandbox::build(&project, true);
        assert!(sandbox.is_confined(), "{}", sandbox.summary());

        let f = Fixture {
            project: project.clone(),
            outside: root.join("outside.txt"),
            sandbox,
        };
        let (ok, out) = run(&f, "echo fine > ok.txt && cat ok.txt");
        assert!(ok && out.contains("fine"), "{out}");
    }
}
