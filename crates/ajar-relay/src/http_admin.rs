//! The operator's view: totals of how the pad is used, at /admin.
//!
//! Everything here is read from what the relay already keeps — the accounts
//! database, the pad store's files, the rooms in memory. Nothing is collected
//! for it. Only the people named in `AJAR_ADMINS` may ask; anyone else is told
//! there is nothing here, so the page's existence is not given away.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::accounts::AccountStats;
use crate::http_accounts::{blocking, signed_in};
use crate::pad::Census;
use crate::session::RoomCensus;
use crate::AppState;

/// The window the per-day figures cover.
const DAYS: i64 = 30;
/// How many of the biggest pads and accounts, and the newest accounts.
const TOP: usize = 10;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/admin/stats", get(stats))
}

#[derive(Serialize)]
struct Stats {
    accounts: AccountStats,
    store: Census,
    live: RoomCensus,
    relay: Relay,
    days: i64,
}

#[derive(Serialize)]
struct Relay {
    version: &'static str,
    uptime_secs: u64,
    /// Resident memory, where the system says (Linux).
    memory_bytes: Option<u64>,
}

/// The relay's resident memory, from `/proc`: there is no portable call, and
/// the box is Linux.
fn memory() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let kb: u64 = status
        .lines()
        .find(|l| l.starts_with("VmRSS:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    Some(kb * 1024)
}

/// Whether the caller is one of the operators. Not found otherwise.
pub async fn require_admin(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, String)> {
    let not_found = || (StatusCode::NOT_FOUND, "not found".to_string());
    let me = signed_in(state, headers).await.ok_or_else(not_found)?;
    let accounts = state.accounts.clone();
    let provider_id = blocking(move || accounts.provider_id(me.id)).await;
    if state
        .auth
        .is_admin(&me.provider, provider_id.as_deref(), me.email.as_deref())
    {
        Ok(())
    } else {
        Err(not_found())
    }
}

async fn stats(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Stats>, (StatusCode, String)> {
    require_admin(&state, &headers).await?;
    let (accounts, pads) = (state.accounts.clone(), state.pads.clone());
    let (accounts, store) = blocking(move || (accounts.stats(DAYS, TOP), pads.census(TOP))).await;
    let accounts = accounts.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.message()))?;
    Ok(Json(Stats {
        accounts,
        store,
        live: state.registry.census(),
        relay: Relay {
            version: env!("CARGO_PKG_VERSION"),
            uptime_secs: state.started.elapsed().as_secs(),
            memory_bytes: memory(),
        },
        days: DAYS,
    }))
}
