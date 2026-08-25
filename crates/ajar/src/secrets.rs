//! Finding the things you did not mean to hand over.
//!
//! A `.env` with production keys sits in the same folder as the code, and
//! sharing that folder shares it. Cheap to detect, expensive to leak.
//!
//! **This is a warning, not a boundary.** Until the sandbox lands, a guest has
//! a shell — keeping a file out of the tree stops it being opened by accident,
//! not read on purpose. Saying otherwise would be worse than saying nothing.

use std::path::Path;

use crate::workspace::Filter;

/// Files bigger than this are not scanned. Credentials are small; a large
/// file is a build artefact or a dataset, and scanning it costs more than it
/// finds.
const MAX_SCAN_BYTES: u64 = 256 * 1024;

/// Stop after this many findings. The point is to make someone look, and a
/// list of two hundred does the opposite.
const MAX_FINDINGS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub path: String,
    pub reason: &'static str,
}

/// Filenames that are credentials by convention.
fn by_name(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    // `.env.example` and friends are meant to be shared — they are the
    // template, not the secret.
    if lower.starts_with(".env") {
        let is_template = lower.contains("example")
            || lower.contains("sample")
            || lower.contains("template")
            || lower.ends_with(".dist");
        return (!is_template).then_some("environment file");
    }
    if lower.ends_with(".pem") || lower.ends_with(".p12") || lower.ends_with(".pfx") {
        return Some("certificate or key");
    }
    if lower.ends_with(".key") && !lower.ends_with("public.key") {
        return Some("private key");
    }
    match lower.as_str() {
        "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519" => Some("ssh private key"),
        ".netrc" | "_netrc" => Some("stored logins"),
        ".npmrc" | ".pypirc" => Some("registry credentials"),
        "credentials" => Some("credentials file"),
        "terraform.tfvars" => Some("terraform variables"),
        "service-account.json" | "serviceaccount.json" => Some("service account key"),
        _ => None,
    }
}

/// Distinctive credential shapes. Deliberately narrow — a scanner that cries
/// wolf gets ignored, and being ignored is the only real failure mode here.
fn by_content(bytes: &[u8]) -> Option<&'static str> {
    let text = std::str::from_utf8(bytes).ok()?;
    if text.contains("-----BEGIN") && text.contains("PRIVATE KEY-----") {
        return Some("private key");
    }
    for line in text.lines().take(2000) {
        if let Some(reason) = scan_line(line) {
            return Some(reason);
        }
    }
    None
}

fn scan_line(line: &str) -> Option<&'static str> {
    // AWS access key ids: AKIA or ASIA then 16 upper-alphanumerics.
    if let Some(i) = line.find("AKIA").or_else(|| line.find("ASIA")) {
        let rest = &line[i + 4..];
        if rest.len() >= 16
            && rest
                .chars()
                .take(16)
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        {
            return Some("aws access key");
        }
    }
    // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ then 36+ chars.
    for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        if let Some(i) = line.find(prefix) {
            let rest = &line[i + 4..];
            if rest.len() >= 36 && rest.chars().take(36).all(|c| c.is_ascii_alphanumeric()) {
                return Some("github token");
            }
        }
    }
    // Slack tokens.
    for prefix in ["xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-"] {
        if line.contains(prefix) {
            return Some("slack token");
        }
    }
    if line.contains("sk-ant-api") || line.contains("sk-proj-") {
        return Some("api key");
    }
    None
}

/// Walk the shared folder looking for credentials. Uses the same filter as
/// the tree, so it never wanders into dependencies.
pub fn scan(root: &Path, filter: &Filter) -> Vec<Finding> {
    let mut findings = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .follow_links(false)
        .build();

    for dirent in walker.flatten() {
        if findings.len() >= MAX_FINDINGS {
            break;
        }
        let path = dirent.path();
        let is_dir = dirent.file_type().is_some_and(|t| t.is_dir());
        if is_dir || filter.is_ignored(path, is_dir) {
            continue;
        }
        let Some(rel) = filter.relative(path) else {
            continue;
        };
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned());

        if let Some(reason) = name.as_deref().and_then(by_name) {
            findings.push(Finding { path: rel, reason });
            continue;
        }

        let too_big = std::fs::metadata(path)
            .map(|m| m.len() > MAX_SCAN_BYTES)
            .unwrap_or(true);
        if too_big {
            continue;
        }
        if let Ok(bytes) = std::fs::read(path) {
            if let Some(reason) = by_content(&bytes) {
                findings.push(Finding { path: rel, reason });
            }
        }
    }
    findings.sort_by(|a, b| a.path.cmp(&b.path));
    findings
}

/// How to say it out loud, in one line.
pub fn summarise(findings: &[Finding]) -> String {
    match findings.len() {
        0 => String::new(),
        1 => format!("{} ({})", findings[0].path, findings[0].reason),
        n => {
            let shown: Vec<&str> = findings.iter().take(3).map(|f| f.path.as_str()).collect();
            if n <= 3 {
                shown.join(", ")
            } else {
                format!("{}, and {} more", shown.join(", "), n - 3)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ajar-secrets-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn found(dir: &Path) -> Vec<Finding> {
        let filter = Filter::build(dir).unwrap();
        scan(dir, &filter)
    }

    #[test]
    fn finds_an_env_file() {
        let dir = scratch("env");
        fs::write(dir.join(".env"), "DATABASE_URL=postgres://real\n").unwrap();
        let f = found(&dir);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].path, ".env");
    }

    #[test]
    fn leaves_env_templates_alone() {
        let dir = scratch("env-template");
        fs::write(dir.join(".env.example"), "DATABASE_URL=\n").unwrap();
        fs::write(dir.join(".env.sample"), "TOKEN=\n").unwrap();
        assert!(found(&dir).is_empty(), "templates are meant to be shared");
    }

    #[test]
    fn finds_a_private_key_by_its_header() {
        let dir = scratch("pk");
        fs::write(
            dir.join("deploy_token"),
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
        )
        .unwrap();
        let f = found(&dir);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].reason, "private key");
    }

    #[test]
    fn finds_credentials_hiding_in_source() {
        let dir = scratch("inline");
        fs::write(
            dir.join("config.py"),
            "REGION = 'us-east-1'\nKEY = 'AKIAIOSFODNN7EXAMPLE'\n",
        )
        .unwrap();
        let f = found(&dir);
        assert_eq!(f.len(), 1, "{f:?}");
        assert_eq!(f[0].reason, "aws access key");
    }

    #[test]
    fn ordinary_source_is_not_suspicious() {
        let dir = scratch("clean");
        fs::write(dir.join("main.rs"), "fn main() { println!(\"hello\"); }").unwrap();
        fs::write(
            dir.join("README.md"),
            "# a project\n\nSet AWS_REGION before running.\n",
        )
        .unwrap();
        fs::write(dir.join("app.ts"), "const apiKey = process.env.API_KEY;\n").unwrap();
        assert!(
            found(&dir).is_empty(),
            "false positives make the warning worthless"
        );
    }

    #[test]
    fn never_wanders_into_dependencies() {
        let dir = scratch("deps");
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("node_modules/pkg/.env"), "TOKEN=x\n").unwrap();
        assert!(
            found(&dir).is_empty(),
            "dependencies are not the host's secrets to leak"
        );
    }

    #[test]
    fn honours_gitignore_the_same_way_the_tree_does() {
        let dir = scratch("ignored");
        fs::write(dir.join(".gitignore"), "private/\n").unwrap();
        fs::create_dir_all(dir.join("private")).unwrap();
        fs::write(dir.join("private/.env"), "TOKEN=x\n").unwrap();
        assert!(found(&dir).is_empty());
    }

    #[test]
    fn a_summary_stays_short() {
        let many: Vec<Finding> = (0..9)
            .map(|i| Finding {
                path: format!("f{i}/.env"),
                reason: "environment file",
            })
            .collect();
        let s = summarise(&many);
        assert!(s.contains("and 6 more"), "{s}");
        assert!(s.len() < 80, "{s}");
        assert_eq!(summarise(&[]), "");
    }
}
