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
    ".cargo",
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

pub struct Sandbox {
    pub mode: Mode,
    /// Kept alive for the lifetime of the session: `sandbox-exec` reads it
    /// at spawn time, and every new terminal spawns again.
    profile: Option<PathBuf>,
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
                    Some(p) => p.display().to_string(),
                    None => return (shell.to_string(), Vec::new()),
                };
                (
                    "/usr/bin/sandbox-exec".to_string(),
                    vec!["-f".to_string(), profile, shell.to_string()],
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
                Ok((path, allows)) => Sandbox {
                    mode: Mode::Confined {
                        mechanism: "seatbelt",
                        allows,
                    },
                    profile: Some(path),
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

impl Drop for Sandbox {
    fn drop(&mut self) {
        if let Some(p) = &self.profile {
            let _ = std::fs::remove_file(p);
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

    pub fn profile(project: &Path, allow_network: bool) -> Result<(PathBuf, Vec<String>), String> {
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

        // A per-session file rather than an inline profile: the text is long,
        // and every new terminal re-reads it.
        let path = std::env::temp_dir().join(format!(
            "ajar-sandbox-{}-{}.sb",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&path, sbpl).map_err(|e| format!("could not write the profile: {e}"))?;

        let allows = vec![
            "writes confined to the shared folder, temp and build caches".to_string(),
            "ssh, cloud and browser credentials unreadable".to_string(),
            if allow_network {
                "network allowed".to_string()
            } else {
                "no network".to_string()
            },
        ];
        Ok((path, allows))
    }
}

#[cfg(target_os = "linux")]
pub mod linux {
    use super::*;
    use landlock::{
        path_beneath_rules, Access, AccessFs, AccessNet, Ruleset, RulesetAttr, RulesetCreatedAttr,
        RulesetStatus, ABI,
    };

    /// Landlock has been in the kernel since 5.13, but a distribution can
    /// leave it out of the active LSM list, in which case the syscall exists
    /// and enforces nothing. Ask for the ABI rather than assuming.
    pub fn available() -> Result<ABI, String> {
        let abi = ABI::V1;
        match Ruleset::default().handle_access(AccessFs::from_all(abi)) {
            Ok(_) => Ok(abi),
            Err(e) => Err(format!("landlock is not usable on this kernel: {e}")),
        }
    }

    /// Whether this kernel can refuse outbound TCP.
    ///
    /// Network rules arrived in ABI 4 (Linux 6.7). Older kernels can still
    /// confine the filesystem, so this is asked separately rather than
    /// refusing to sandbox at all.
    pub fn can_restrict_network() -> bool {
        Ruleset::default()
            .handle_access(AccessNet::ConnectTcp)
            .and_then(|r| r.create())
            .is_ok()
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

        let abi = ABI::V1;
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
        let mut ruleset = Ruleset::default().handle_access(AccessFs::from_all(abi))?;
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
