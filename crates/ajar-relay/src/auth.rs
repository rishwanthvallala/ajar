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
//!
//! What a sign-in needs between leaving and coming back — the PKCE verifier,
//! the `state`, where to go after — rides in a short-lived cookie on the
//! browser that started it, never in memory here. That binds the callback to
//! that browser: a callback URL somebody else started, sent to you, finds no
//! cookie of yours to match and signs nobody in. A `state` kept only on the
//! server lets that through — login CSRF, which signs you into the sender's
//! account so that what you make there is theirs. And there is nothing here
//! for strangers to fill by starting sign-ins they never finish.

use std::time::Duration;

use base64::Engine;
use sha2::{Digest, Sha256};

/// How long a sign-in may take between leaving and coming back.
pub const SIGN_IN_SECS: u64 = 10 * 60;

/// How long a provider gets to answer. Each call holds a blocking thread, and
/// one that never answered would hold it for good.
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(15);

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

/// A sign-in on its way: where to send the browser, and the cookie it has to
/// bring back.
pub struct Started {
    pub location: String,
    pub cookie: String,
}

pub struct Auth {
    pub origin: String,
    providers: Vec<Provider>,
    http: ureq::Agent,
}

fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(PROVIDER_TIMEOUT))
            .build(),
    )
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Equal, in time that does not depend on where they differ.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// The cookie: `provider.state.verifier.issued.next`, every part URL-safe
/// base64 or digits, so a dot is only ever a separator.
fn started_cookie(provider: &str, state: &str, verifier: &str, at: u64, next: &str) -> String {
    format!(
        "{provider}.{state}.{verifier}.{at}.{}",
        b64(next.as_bytes())
    )
}

/// Check a callback against the cookie its browser brought, and say what the
/// sign-in carried: the PKCE verifier, and where to go after.
fn check_started(
    cookie: Option<&str>,
    provider: &str,
    state: &str,
    at: u64,
) -> Result<(String, String), String> {
    let cookie = cookie.ok_or("this browser did not start that sign-in — try again")?;
    let parts: Vec<&str> = cookie.split('.').collect();
    let [pid, nonce, verifier, issued, next] = parts[..] else {
        return Err("that sign-in was garbled — try again".into());
    };
    if pid != provider || !same(nonce, state) {
        return Err("that sign-in was started somewhere else — try again".into());
    }
    let issued: u64 = issued
        .parse()
        .map_err(|_| "that sign-in was garbled — try again")?;
    if at.saturating_sub(issued) > SIGN_IN_SECS {
        return Err("that sign-in took too long — try again".into());
    }
    let next = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(next)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_default();
    Ok((verifier.to_string(), safe_next(&next)))
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
            http: agent(),
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

    /// Where to send the browser to start signing in, and the cookie it must
    /// bring back — or `None` if that provider is not set up.
    pub fn start(&self, provider: &str, next: &str) -> Option<Started> {
        let p = self.provider(provider)?;
        let state = crate::accounts::new_secret();
        let verifier = format!(
            "{}{}",
            crate::accounts::new_secret(),
            crate::accounts::new_secret()
        );
        let challenge = b64(&Sha256::digest(verifier.as_bytes()));
        let cookie = started_cookie(p.id, &state, &verifier, now(), &safe_next(next));
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
        Some(Started {
            location: url,
            cookie,
        })
    }

    /// Finish signing in: check the callback against the cookie its browser
    /// brought, trade the code for a token, and ask the provider who this is.
    /// Blocking — it makes two HTTPS requests — so call it off the async
    /// workers. Returns where to go next as well.
    pub fn finish(
        &self,
        provider: &str,
        code: &str,
        state: &str,
        cookie: Option<&str>,
    ) -> Result<(Identity, String), String> {
        let (verifier, next) = check_started(cookie, provider, state, now())?;
        let p = self
            .provider(provider)
            .ok_or("that provider is not set up")?;

        let token: serde_json::Value = self
            .http
            .post(&p.token)
            .header("Accept", "application/json")
            .send_form([
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", &self.redirect_uri(p.id)),
                ("client_id", &p.client_id),
                ("client_secret", &p.client_secret),
                ("code_verifier", &verifier),
            ])
            .map_err(|e| format!("{} refused the sign-in: {e}", p.id))?
            .body_mut()
            .read_json()
            .map_err(|e| format!("{} answered strangely: {e}", p.id))?;
        let access = token["access_token"]
            .as_str()
            .ok_or_else(|| format!("{} gave no access token", p.id))?;

        let me: serde_json::Value = self
            .http
            .get(&p.userinfo)
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
            .map(|id| (id, next))
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
            http: agent(),
        };
        assert!(auth.offered().is_empty());
        assert!(auth.start("google", "/").is_none());
    }

    #[test]
    fn a_callback_needs_the_cookie_of_the_browser_that_started_it() {
        let cookie = started_cookie("github", "the-state", "the-verifier", 1000, "/a-b-c");
        assert_eq!(
            check_started(Some(&cookie), "github", "the-state", 1060),
            Ok(("the-verifier".into(), "/a-b-c".into()))
        );
        // Somebody else's callback, in a browser that started its own
        // sign-in, or none at all.
        assert!(check_started(Some(&cookie), "github", "their-state", 1060).is_err());
        assert!(check_started(None, "github", "the-state", 1060).is_err());
        // Started with one provider, back from another.
        assert!(check_started(Some(&cookie), "google", "the-state", 1060).is_err());
        // Too long ago.
        let late = 1000 + SIGN_IN_SECS + 1;
        assert!(check_started(Some(&cookie), "github", "the-state", late).is_err());
        // Garbled, and a return address tampered with in the cookie.
        assert!(check_started(Some("github.the-state"), "github", "the-state", 1060).is_err());
        let bounced = started_cookie("github", "s", "v", 1000, "//evil.example");
        assert_eq!(
            check_started(Some(&bounced), "github", "s", 1000).map(|(_, next)| next),
            Ok("/dashboard".to_string())
        );
    }
}
