//! Signing in with Google or GitHub.
//!
//! The authorisation-code flow with PKCE, as a full-page redirect: the pad's
//! origin is cross-origin isolated, and `Cross-Origin-Opener-Policy:
//! same-origin` severs a popup's `window.opener`, so a popup could never report
//! back. No passwords are stored and no email is sent.
//!
//! Configured from the environment, so the secrets live in the unit's
//! environment file and nowhere in the repository:
//!
//! | Variable | |
//! |---|---|
//! | `AJAR_PUBLIC_ORIGIN` | Where the browser sees the pad, e.g. `https://code.rishwanth.dev` |
//! | `AJAR_GOOGLE_CLIENT_ID`, `AJAR_GOOGLE_CLIENT_SECRET` | Google, if set |
//! | `AJAR_GITHUB_CLIENT_ID`, `AJAR_GITHUB_CLIENT_SECRET` | GitHub, if set |
//! | `AJAR_<P>_AUTHORIZE_URL`, `_TOKEN_URL`, `_USERINFO_URL` | Endpoint overrides — the checks point them at a stand-in |
//!
//! A provider with no client id is simply not offered.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use base64::Engine;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};

/// How long a sign-in may take between leaving and coming back.
const PENDING_FOR: Duration = Duration::from_secs(10 * 60);

pub struct Provider {
    pub id: &'static str,
    client_id: String,
    client_secret: String,
    authorize: String,
    token: String,
    userinfo: String,
    scope: &'static str,
}

/// Who a provider says somebody is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub provider: &'static str,
    pub id: String,
    pub email: Option<String>,
    pub name: String,
}

struct Pending {
    provider: &'static str,
    verifier: String,
    next: String,
    at: Instant,
}

pub struct Auth {
    pub origin: String,
    providers: Vec<Provider>,
    pending: Mutex<HashMap<String, Pending>>,
}

impl Auth {
    pub fn from_env() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let mut providers = Vec::new();
        for (id, authorize, token, userinfo, scope) in [
            (
                "google",
                "https://accounts.google.com/o/oauth2/v2/auth",
                "https://oauth2.googleapis.com/token",
                "https://openidconnect.googleapis.com/v1/userinfo",
                "openid email profile",
            ),
            (
                "github",
                "https://github.com/login/oauth/authorize",
                "https://github.com/login/oauth/access_token",
                "https://api.github.com/user",
                "read:user",
            ),
        ] {
            let up = id.to_uppercase();
            let (Some(client_id), Some(client_secret)) = (
                var(&format!("AJAR_{up}_CLIENT_ID")),
                var(&format!("AJAR_{up}_CLIENT_SECRET")),
            ) else {
                continue;
            };
            providers.push(Provider {
                id,
                client_id,
                client_secret,
                authorize: var(&format!("AJAR_{up}_AUTHORIZE_URL")).unwrap_or(authorize.into()),
                token: var(&format!("AJAR_{up}_TOKEN_URL")).unwrap_or(token.into()),
                userinfo: var(&format!("AJAR_{up}_USERINFO_URL")).unwrap_or(userinfo.into()),
                scope,
            });
        }
        Auth {
            origin: var("AJAR_PUBLIC_ORIGIN").unwrap_or_default(),
            providers,
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Providers someone can sign in with here.
    pub fn offered(&self) -> Vec<&'static str> {
        if self.origin.is_empty() {
            return Vec::new();
        }
        self.providers.iter().map(|p| p.id).collect()
    }

    fn provider(&self, id: &str) -> Option<&Provider> {
        if self.origin.is_empty() {
            return None;
        }
        self.providers.iter().find(|p| p.id == id)
    }

    /// Whether cookies need `Secure`: everywhere but a plain-http development
    /// origin, where a browser would refuse to keep them.
    pub fn secure(&self) -> bool {
        self.origin.starts_with("https://")
    }

    fn redirect_uri(&self, provider: &str) -> String {
        format!("{}/auth/{provider}/callback", self.origin)
    }

    /// Where to send the browser to start signing in, or `None` if that
    /// provider is not set up.
    pub fn start(&self, provider: &str, next: &str) -> Option<String> {
        let p = self.provider(provider)?;
        let state = crate::accounts::new_secret();
        let verifier = format!(
            "{}{}",
            crate::accounts::new_secret(),
            crate::accounts::new_secret()
        );
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        {
            let mut pending = self.pending.lock();
            pending.retain(|_, v| v.at.elapsed() < PENDING_FOR);
            pending.insert(
                state.clone(),
                Pending {
                    provider: p.id,
                    verifier,
                    next: safe_next(next),
                    at: Instant::now(),
                },
            );
        }
        let mut url = format!(
            "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
            p.authorize,
            encode(&p.client_id),
            encode(&self.redirect_uri(p.id)),
            encode(p.scope),
            state,
            challenge,
        );
        if p.id == "google" {
            url.push_str("&prompt=select_account");
        }
        Some(url)
    }

    /// Finish signing in: check the state, trade the code for a token, and ask
    /// the provider who this is. Blocking — it makes two HTTPS requests — so
    /// call it off the async workers. Returns where to go next as well.
    pub fn finish(
        &self,
        provider: &str,
        code: &str,
        state: &str,
    ) -> Result<(Identity, String), String> {
        let pending = self
            .pending
            .lock()
            .remove(state)
            .filter(|p| p.provider == provider && p.at.elapsed() < PENDING_FOR)
            .ok_or("that sign-in had expired or was not started here — try again")?;
        let p = self
            .provider(provider)
            .ok_or("that provider is not set up")?;

        let token: serde_json::Value = ureq::post(&p.token)
            .header("Accept", "application/json")
            .send_form([
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", &self.redirect_uri(p.id)),
                ("client_id", &p.client_id),
                ("client_secret", &p.client_secret),
                ("code_verifier", &pending.verifier),
            ])
            .map_err(|e| format!("{} refused the sign-in: {e}", p.id))?
            .body_mut()
            .read_json()
            .map_err(|e| format!("{} answered strangely: {e}", p.id))?;
        let access = token["access_token"]
            .as_str()
            .ok_or_else(|| format!("{} gave no access token", p.id))?;

        let me: serde_json::Value = ureq::get(&p.userinfo)
            .header("Authorization", &format!("Bearer {access}"))
            .header("Accept", "application/json")
            // GitHub refuses a request without one.
            .header("User-Agent", "ajar")
            .call()
            .map_err(|e| format!("{} would not say who you are: {e}", p.id))?
            .body_mut()
            .read_json()
            .map_err(|e| format!("{} answered strangely: {e}", p.id))?;
        identity(p.id, &me)
            .map(|id| (id, pending.next))
            .ok_or_else(|| format!("{} did not say who you are", p.id))
    }
}

/// Google's userinfo has `sub`; GitHub's user has a numeric `id` and a
/// `login`, and often no `name` or public `email`.
fn identity(provider: &'static str, me: &serde_json::Value) -> Option<Identity> {
    let id = match provider {
        "google" => me["sub"].as_str()?.to_string(),
        _ => me["id"]
            .as_u64()
            .map(|n| n.to_string())
            .or_else(|| me["id"].as_str().map(str::to_string))?,
    };
    let email = me["email"].as_str().map(str::to_string);
    let name = me["name"]
        .as_str()
        .filter(|n| !n.is_empty())
        .or_else(|| me["login"].as_str())
        .or(email.as_deref())
        .unwrap_or("someone")
        .to_string();
    Some(Identity {
        provider,
        id,
        email,
        name,
    })
}

/// Only a path on this site — never `//elsewhere` or a full URL — so the
/// return address cannot be used to bounce someone off to another site.
pub fn safe_next(next: &str) -> String {
    if next.starts_with('/') && !next.starts_with("//") && !next.contains('\\') {
        next.to_string()
    } else {
        "/dashboard".to_string()
    }
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_return_address_stays_on_this_site() {
        assert_eq!(safe_next("/amber-falcon-river"), "/amber-falcon-river");
        assert_eq!(safe_next("//evil.example/x"), "/dashboard");
        assert_eq!(safe_next("https://evil.example"), "/dashboard");
        assert_eq!(safe_next("/\\evil.example"), "/dashboard");
    }

    #[test]
    fn identities_from_both_providers() {
        let google = serde_json::json!({ "sub": "1093", "email": "a@b.c", "name": "Ana" });
        assert_eq!(
            identity("google", &google),
            Some(Identity {
                provider: "google",
                id: "1093".into(),
                email: Some("a@b.c".into()),
                name: "Ana".into()
            })
        );
        // GitHub: a numeric id, often no public name or email.
        let github =
            serde_json::json!({ "id": 583231, "login": "octocat", "name": null, "email": null });
        assert_eq!(
            identity("github", &github),
            Some(Identity {
                provider: "github",
                id: "583231".into(),
                email: None,
                name: "octocat".into()
            })
        );
        assert_eq!(identity("google", &serde_json::json!({})), None);
    }

    #[test]
    fn nothing_is_offered_without_a_public_origin() {
        let auth = Auth {
            origin: String::new(),
            providers: Vec::new(),
            pending: Mutex::new(HashMap::new()),
        };
        assert!(auth.offered().is_empty());
        assert_eq!(auth.start("google", "/"), None);
    }
}
