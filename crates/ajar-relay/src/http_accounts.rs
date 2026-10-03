//! The HTTP side of accounts: signing in and out, and the dashboard's API.
//!
//! The session is a cookie on the pad's origin. State-changing requests also
//! need `X-Ajar: 1`, which a cross-site form cannot send; with the cookie
//! `SameSite=Lax`, a cross-site POST carries no session in the first place.

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::accounts::{Access, AccountError, Edit, PadInfo, Role, User, View};
use crate::AppState;

type Refusal = (StatusCode, String);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/{provider}/start", get(start))
        .route("/auth/{provider}/callback", get(callback))
        .route("/auth/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/my/pads", get(my_pads).post(create_pad))
        .route(
            "/api/my/pads/{name}",
            get(one_pad).delete(delete_pad).patch(set_access),
        )
        .route("/api/my/pads/{name}/links", post(new_link))
        .route("/api/my/pads/{name}/links/{id}", delete(revoke_link))
}

/// Run account-store work off the async workers. Every call is a few rows by
/// key, but it is still a file and a lock.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(f)
        .await
        .expect("account work panicked")
}

fn cookie_name(state: &AppState) -> &'static str {
    // `__Host-` binds the cookie to this exact origin, path `/`, `Secure`. A
    // plain-http development origin cannot use it, so it gets a plain name.
    if state.auth.secure() {
        "__Host-ajar"
    } else {
        "ajar"
    }
}

/// The session token from the request's cookies, if any.
pub fn session_token(state: &AppState, headers: &HeaderMap) -> Option<String> {
    let name = cookie_name(state);
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
}

pub async fn signed_in(state: &AppState, headers: &HeaderMap) -> Option<User> {
    let token = session_token(state, headers)?;
    let accounts = state.accounts.clone();
    blocking(move || accounts.session(&token)).await
}

/// What the caller may do with a pad: their session if they have one, the
/// code in `X-Pad-Code` if they sent one.
pub async fn access(state: &AppState, headers: &HeaderMap, name: &str) -> Access {
    let user = signed_in(state, headers).await.map(|u| u.id);
    let code = headers
        .get("x-pad-code")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let accounts = state.accounts.clone();
    let name = name.to_string();
    blocking(move || accounts.access(&name, user, code.as_deref())).await
}

fn intended(headers: &HeaderMap) -> Result<(), Refusal> {
    if headers.get("x-ajar").and_then(|v| v.to_str().ok()) == Some("1") {
        Ok(())
    } else {
        Err((StatusCode::FORBIDDEN, "missing X-Ajar header".into()))
    }
}

async fn require_user(state: &AppState, headers: &HeaderMap) -> Result<User, Refusal> {
    signed_in(state, headers)
        .await
        .ok_or((StatusCode::UNAUTHORIZED, "sign in first".into()))
}

fn refuse(e: AccountError) -> Refusal {
    let status = match e {
        AccountError::NotFound => StatusCode::NOT_FOUND,
        AccountError::TooManyPads(_) | AccountError::OverQuota(_) => {
            StatusCode::INSUFFICIENT_STORAGE
        }
        AccountError::Db(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, e.message())
}

/// Everyone in a pad's room but its owner reconnects, and is let back in on
/// what they hold now. Called whenever who may do what to a pad changes.
fn reconsider(state: &AppState, name: &str, everyone: bool) {
    let notice = ajar_proto::Frame::json(
        ajar_proto::Channel::Control,
        ajar_proto::TARGET_ALL,
        &ajar_proto::Control::Closed {
            reason: "who can open this pad changed".into(),
        },
    )
    .map(|f| f.encode())
    .unwrap_or_default();
    state.registry.evict_peers(name, everyone, notice);
}

// ------------------------------------------------------------- signing in

#[derive(Deserialize)]
struct Next {
    next: Option<String>,
}

async fn start(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    Query(q): Query<Next>,
) -> Response {
    match state
        .auth
        .start(&provider, q.next.as_deref().unwrap_or("/dashboard"))
    {
        Some(url) => (StatusCode::SEE_OTHER, [(header::LOCATION, url)]).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            format!("signing in with {provider} is not set up here"),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct Callback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn callback(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    Query(q): Query<Callback>,
) -> Response {
    let (Some(code), Some(nonce)) = (q.code, q.state) else {
        // Cancelled at the provider, or refused there.
        let why = q.error.unwrap_or_else(|| "no code".into());
        return (
            StatusCode::SEE_OTHER,
            [(header::LOCATION, format!("/dashboard?signin={why}"))],
        )
            .into_response();
    };
    let auth = state.auth.clone();
    let finished = blocking(move || auth.finish(&provider, &code, &nonce)).await;
    let (who, next) = match finished {
        Ok(done) => done,
        Err(why) => return (StatusCode::BAD_REQUEST, why).into_response(),
    };
    let accounts = state.accounts.clone();
    let token = blocking(move || {
        let user = accounts.sign_in(who.provider, &who.id, who.email.as_deref(), &who.name)?;
        accounts.new_session(user.id)
    })
    .await;
    let token = match token {
        Ok(t) => t,
        Err(e) => return refuse(e).into_response(),
    };
    let cookie = format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000{}",
        cookie_name(&state),
        if state.auth.secure() { "; Secure" } else { "" }
    );
    (
        StatusCode::SEE_OTHER,
        [(header::SET_COOKIE, cookie), (header::LOCATION, next)],
    )
        .into_response()
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(r) = intended(&headers) {
        return r.into_response();
    }
    if let Some(token) = session_token(&state, &headers) {
        let accounts = state.accounts.clone();
        blocking(move || accounts.end_session(&token)).await;
    }
    let cookie = format!(
        "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
        cookie_name(&state),
        if state.auth.secure() { "; Secure" } else { "" }
    );
    (StatusCode::NO_CONTENT, [(header::SET_COOKIE, cookie)]).into_response()
}

#[derive(Serialize)]
struct Me {
    user: Option<User>,
    /// Who you can sign in with here; empty when sign-in is not set up.
    providers: Vec<&'static str>,
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Json<Me> {
    Json(Me {
        user: signed_in(&state, &headers).await,
        providers: state.auth.offered(),
    })
}

// ------------------------------------------------------------- the dashboard

async fn my_pads(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<PadInfo>>, Refusal> {
    let me = require_user(&state, &headers).await?;
    let accounts = state.accounts.clone();
    blocking(move || accounts.pads_of(me.id))
        .await
        .map(Json)
        .map_err(refuse)
}

/// One pad, for its share dialog.
async fn one_pad(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<PadInfo>, Refusal> {
    let me = require_user(&state, &headers).await?;
    let accounts = state.accounts.clone();
    blocking(move || accounts.pad_of(me.id, &name))
        .await
        .map(Json)
        .map_err(refuse)
}

async fn create_pad(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<PadInfo>), Refusal> {
    intended(&headers)?;
    let me = require_user(&state, &headers).await?;
    let (accounts, pads) = (state.accounts.clone(), state.pads.clone());
    let pad = blocking(move || {
        let taken = |name: &str| pads.get(name).ok().flatten().is_some();
        let pad = accounts.create_pad(me.id, &taken)?;
        pads.pin(&pad.name);
        Ok(pad)
    })
    .await
    .map_err(refuse)?;
    Ok((StatusCode::CREATED, Json(pad)))
}

#[derive(Deserialize)]
struct Settings {
    view: View,
    edit: Edit,
}

async fn set_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(settings): Json<Settings>,
) -> Result<Json<PadInfo>, Refusal> {
    intended(&headers)?;
    let me = require_user(&state, &headers).await?;
    let accounts = state.accounts.clone();
    let pad_name = name.clone();
    let pad = blocking(move || {
        accounts.set_access(me.id, &pad_name, settings.view, settings.edit)?;
        accounts.pad_of(me.id, &pad_name)
    })
    .await
    .map_err(refuse)?;
    reconsider(&state, &name, false);
    Ok(Json(pad))
}

async fn delete_pad(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<StatusCode, Refusal> {
    intended(&headers)?;
    let me = require_user(&state, &headers).await?;
    let (accounts, pads) = (state.accounts.clone(), state.pads.clone());
    let pad_name = name.clone();
    blocking(move || {
        accounts.delete_pad(me.id, &pad_name)?;
        pads.remove(&pad_name)
            .map_err(|e| AccountError::Db(e.message()))
    })
    .await
    .map_err(refuse)?;
    reconsider(&state, &name, true);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct NewLink {
    role: Role,
}

async fn new_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<NewLink>,
) -> Result<(StatusCode, Json<crate::accounts::Link>), Refusal> {
    intended(&headers)?;
    let me = require_user(&state, &headers).await?;
    let accounts = state.accounts.clone();
    blocking(move || accounts.new_link(me.id, &name, body.role))
        .await
        .map(|l| (StatusCode::CREATED, Json(l)))
        .map_err(refuse)
}

async fn revoke_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((name, id)): Path<(String, i64)>,
) -> Result<StatusCode, Refusal> {
    intended(&headers)?;
    let me = require_user(&state, &headers).await?;
    let accounts = state.accounts.clone();
    let pad_name = name.clone();
    blocking(move || accounts.revoke_link(me.id, &pad_name, id))
        .await
        .map_err(refuse)?;
    reconsider(&state, &name, false);
    Ok(StatusCode::NO_CONTENT)
}

/// The access a pad's page is told about, alongside its files.
#[derive(Serialize)]
pub struct AccessView {
    pub role: Role,
    /// Whether the pad belongs to an account at all.
    pub account: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<View>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit: Option<Edit>,
}

impl From<&Access> for AccessView {
    fn from(a: &Access) -> Self {
        AccessView {
            role: a.role,
            account: a.owner.is_some(),
            view: a.view,
            edit: a.edit,
        }
    }
}
