//! The HTTP side of paying (billing.rs): what /pricing shows, beginning a
//! payment, Razorpay sending the payer back, and Razorpay's webhook.
//!
//! The way back and the webhook come from Razorpay, not from a page of ours,
//! and are believed only for Razorpay's signature on them. Neither needs a
//! session: a payment is credited to the account that began it, whoever is
//! signed in where it lands.

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::accounts::{now, Standing};
use crate::billing::{
    extended, plain_id, Billing, Credit, LinkRequest, LinkState, Payment, Price, AHEAD_DAYS,
    BEGUN_AN_HOUR, CANCELLED, EXPIRED, LINK_SECS,
};
use crate::http_accounts::{blocking, intended, refuse, require_user, signed_in, Refusal};
use crate::plan::Plan;
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/billing", get(status))
        .route("/api/billing/checkout", post(checkout))
        .route("/api/billing/return", get(came_back))
        .route("/api/billing/webhook", post(webhook))
}

const DAY: i64 = 24 * 60 * 60;

/// Why someone cannot pay now, as a word the page puts into a sentence.
fn refusal(billing: &Billing, standing: Option<&Standing>, now: i64) -> Option<&'static str> {
    if !billing.available() {
        return Some("unavailable");
    }
    let standing = standing?;
    if standing.listed {
        return Some("listed");
    }
    if extended(standing.paid_until, billing.price.days, now) > now + AHEAD_DAYS * DAY {
        return Some("ahead");
    }
    None
}

#[derive(Serialize)]
struct Status {
    /// Whether anything can be bought here: Razorpay's keys are set.
    available: bool,
    /// Razorpay's test mode, where no money moves.
    test: bool,
    price: Price,
    signed_in: bool,
    plan: Plan,
    /// On the paid plan by the relay's configuration, with nothing to pay.
    listed: bool,
    /// Until when payments hold the account on the paid plan; past, once
    /// they no longer do.
    paid_until: Option<i64>,
    /// The relay's clock, so days left are counted from the same moment.
    now: i64,
    /// Why this person cannot pay now — `unavailable`, `listed`, `ahead` —
    /// or nothing when they can, or are not signed in.
    refusal: Option<&'static str>,
    /// Theirs, newest first.
    payments: Vec<Payment>,
}

/// The paid plan's price, and where this person stands: what /pricing shows.
/// A payment of theirs not yet heard of is asked after at Razorpay first —
/// for one the way back and the webhook both missed.
async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Status>, Refusal> {
    let user = signed_in(&state, &headers).await;
    if let Some(user) = &user {
        catch_up(&state, user.id).await;
    }
    let now = now();
    let (standing, payments) = match &user {
        Some(user) => {
            let (accounts, id) = (state.accounts.clone(), user.id);
            blocking(move || Ok((accounts.standing(id), accounts.payments_of(id)?)))
                .await
                .map_err(refuse)?
        }
        None => (Standing::default(), Vec::new()),
    };
    let billing = &state.billing;
    Ok(Json(Status {
        available: billing.available(),
        test: billing.razorpay.as_ref().is_some_and(|r| r.test_mode()),
        price: billing.price,
        signed_in: user.is_some(),
        plan: standing.plan,
        listed: standing.listed,
        paid_until: standing.paid_until,
        now,
        refusal: refusal(billing, user.as_ref().map(|_| &standing), now),
        payments,
    }))
}

/// Ask Razorpay about this account's payments that are neither paid nor
/// over, and act on what it says. Each is asked at most every few seconds,
/// however often the page looks (`Accounts::payments_to_check`).
async fn catch_up(state: &AppState, user: i64) {
    if !state.billing.available() {
        return;
    }
    let accounts = state.accounts.clone();
    let due = blocking(move || accounts.payments_to_check(user, now()))
        .await
        .unwrap_or_default();
    for (reference, link) in due {
        let billing = state.billing.clone();
        let asked = blocking(move || {
            billing
                .razorpay
                .as_ref()
                .map(|r| r.fetch_link(&link))
                .unwrap_or_else(|| Err("payments are not set up".into()))
        })
        .await;
        match asked {
            Ok(link) => settle(state, &reference, link).await,
            Err(e) => {
                tracing::warn!(%reference, error = %e, "could not ask Razorpay about a payment")
            }
        }
    }
}

/// Act on what Razorpay says of a payment's link.
async fn settle(state: &AppState, reference: &str, link: LinkState) {
    match link.status.as_str() {
        "paid" => match link.payment_id {
            Some(id) => {
                let _ = credit(state, reference, &id, Some(link.amount_paid), "asked").await;
            }
            None => tracing::warn!(%reference, "Razorpay says a link is paid, and by no payment"),
        },
        "expired" | "cancelled" => {
            let (accounts, reference) = (state.accounts.clone(), reference.to_string());
            let status = if link.status == "expired" {
                EXPIRED
            } else {
                CANCELLED
            };
            let _ = blocking(move || accounts.payment_ended(&reference, status)).await;
        }
        _ => {}
    }
}

/// Credit a payment, and say so in the journal. `how` it was heard of:
/// `returned`, `webhook` or `asked`.
async fn credit(
    state: &AppState,
    reference: &str,
    payment_id: &str,
    paid: Option<u64>,
    how: &'static str,
) -> Result<Credit, crate::accounts::AccountError> {
    let (accounts, r, p) = (
        state.accounts.clone(),
        reference.to_string(),
        payment_id.to_string(),
    );
    let done = blocking(move || accounts.credit(&r, &p, paid, now())).await;
    match &done {
        Ok(Credit::Credited(until)) => {
            tracing::info!(%reference, how, until = ?until, "a payment was credited")
        }
        Ok(Credit::Already) => {}
        Ok(Credit::Unknown) => {
            tracing::warn!(%reference, how, "Razorpay spoke of a payment this relay never began")
        }
        Ok(Credit::Short) => {
            tracing::warn!(%reference, how, ?paid, "a payment came in short, and was not credited")
        }
        Err(e) => {
            tracing::error!(%reference, how, error = %e.message(), "crediting a payment failed")
        }
    }
    done
}

#[derive(Serialize)]
struct Begun {
    reference: String,
    /// Razorpay's page, where it is paid.
    url: String,
}

/// Begin paying: a link to Razorpay's page for one payment, which the page
/// sends its tab to. One still open at this price is handed back rather
/// than another made, so Back and a second press lead to the same payment.
async fn checkout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Begun>), Refusal> {
    intended(&headers)?;
    let me = require_user(&state, &headers).await?;
    let now = now();
    let id = me.id;
    let accounts = state.accounts.clone();
    let standing = blocking(move || accounts.standing(id)).await;
    match refusal(&state.billing, Some(&standing), now) {
        Some("unavailable") => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "payments are not set up on this server".into(),
            ))
        }
        Some("listed") => {
            return Err((
                StatusCode::CONFLICT,
                "your account is on the paid plan already, with nothing to pay".into(),
            ))
        }
        Some(_) => {
            return Err((
                StatusCode::CONFLICT,
                format!("your account is paid for as far ahead as it can be — up to {AHEAD_DAYS} days; pay again nearer the time"),
            ))
        }
        None => {}
    }
    let price = state.billing.price;
    let accounts = state.accounts.clone();
    let open = blocking(move || accounts.open_payment(id, price, now))
        .await
        .map_err(refuse)?;
    if let Some(Payment {
        reference,
        url: Some(url),
        ..
    }) = open
    {
        return Ok((StatusCode::OK, Json(Begun { reference, url })));
    }
    let accounts = state.accounts.clone();
    let begun = blocking(move || accounts.payments_begun(id, now - 3600))
        .await
        .map_err(refuse)?;
    if begun >= BEGUN_AN_HOUR {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "that is a lot of payments begun in an hour — try again later".into(),
        ));
    }
    let reference = format!("ajar-{}", crate::accounts::new_secret());
    let (accounts, r) = (state.accounts.clone(), reference.clone());
    blocking(move || accounts.begin_payment(id, &r, price, now))
        .await
        .map_err(refuse)?;
    let (billing, r) = (state.billing.clone(), reference.clone());
    let made = blocking(move || {
        let Some(razorpay) = billing.razorpay.as_ref() else {
            return Err("payments are not set up".to_string());
        };
        razorpay.create_link(&LinkRequest {
            reference: &r,
            price,
            expire_by: now + LINK_SECS,
            callback: &billing.callback(),
            description: &format!("pad: the paid plan, for {} days", price.days),
            name: &me.name,
            email: me.email.as_deref(),
            account: id,
        })
    })
    .await;
    let accounts = state.accounts.clone();
    let r = reference.clone();
    match made {
        Ok(link) => {
            let url = link.url.clone();
            blocking(move || accounts.payment_linked(&r, &link.id, &link.url))
                .await
                .map_err(refuse)?;
            tracing::info!(%reference, "a payment was begun");
            Ok((StatusCode::CREATED, Json(Begun { reference, url })))
        }
        Err(e) => {
            tracing::warn!(%reference, error = %e, "Razorpay would not make a payment link");
            let _ = blocking(move || accounts.payment_not_begun(&r)).await;
            Err((
                StatusCode::BAD_GATEWAY,
                "Razorpay could not start the payment just now, and nothing was charged — try again in a minute".into(),
            ))
        }
    }
}

/// What Razorpay adds to the address it sends a payer back to.
#[derive(Deserialize)]
struct Returned {
    razorpay_payment_id: Option<String>,
    razorpay_payment_link_id: Option<String>,
    razorpay_payment_link_reference_id: Option<String>,
    razorpay_payment_link_status: Option<String>,
    razorpay_signature: Option<String>,
}

/// Razorpay's page sends the payer here once they have paid. Credited at
/// once when Razorpay's signature holds, and on to /pricing either way,
/// which says how the payment stands — and asks Razorpay itself, should
/// this have been anything but Razorpay.
async fn came_back(State(state): State<AppState>, Query(q): Query<Returned>) -> Response {
    let reference = q.razorpay_payment_link_reference_id.filter(|r| plain_id(r));
    let to = match &reference {
        Some(r) => format!("/pricing?payment={r}"),
        None => "/pricing".to_string(),
    };
    if let (Some(razorpay), Some(reference), Some(link), Some(status), Some(paid_by), Some(sig)) = (
        state.billing.razorpay.as_ref(),
        reference.as_deref(),
        q.razorpay_payment_link_id.as_deref(),
        q.razorpay_payment_link_status.as_deref(),
        q.razorpay_payment_id.as_deref(),
        q.razorpay_signature.as_deref(),
    ) {
        if !razorpay.callback_signed(link, reference, status, paid_by, sig) {
            tracing::warn!(%reference, "a return from Razorpay's page whose signature does not hold");
        } else if status == "paid" {
            let (accounts, r) = (state.accounts.clone(), reference.to_string());
            let known = blocking(move || accounts.payment(&r)).await.ok().flatten();
            // The link has to be the one this payment was given.
            if known.is_some_and(|known| known.link_id.as_deref() == Some(link)) {
                let _ = credit(&state, reference, paid_by, None, "returned").await;
            }
        }
    }
    (
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, to),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
    )
        .into_response()
}

/// Razorpay's word on a payment link: paid, expired or cancelled. Believed
/// for the webhook secret's signature on the body as it came. Anything else
/// signed is acknowledged and let be; a failure of ours is a 500, which
/// Razorpay sends again later.
async fn webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let Some(razorpay) = state.billing.razorpay.as_ref() else {
        return (StatusCode::NOT_FOUND, "payments are not set up here").into_response();
    };
    let signature = headers
        .get("x-razorpay-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    match razorpay.webhook_signed(&body, signature) {
        None => return (StatusCode::NOT_FOUND, "webhooks are not set up here").into_response(),
        Some(false) => {
            tracing::warn!("a webhook whose signature does not hold");
            return (StatusCode::BAD_REQUEST, "the signature does not hold").into_response();
        }
        Some(true) => {}
    }
    let Ok(event) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return (StatusCode::BAD_REQUEST, "not JSON").into_response();
    };
    let link = &event["payload"]["payment_link"]["entity"];
    let Some(reference) = link["reference_id"].as_str().filter(|r| plain_id(r)) else {
        return (StatusCode::OK, "not ours").into_response();
    };
    let failed = || (StatusCode::INTERNAL_SERVER_ERROR, "try again").into_response();
    match event["event"].as_str() {
        Some("payment_link.paid") => {
            let payment = &event["payload"]["payment"]["entity"];
            let (Some(paid_by), Some(currency)) =
                (payment["id"].as_str(), link["currency"].as_str())
            else {
                return (StatusCode::BAD_REQUEST, "no payment in it").into_response();
            };
            if currency != state.billing.price.currency {
                tracing::warn!(%reference, currency, "a payment in another currency, not credited");
                return (StatusCode::OK, "not credited").into_response();
            }
            let paid = link["amount_paid"].as_u64().unwrap_or(0);
            match credit(&state, reference, paid_by, Some(paid), "webhook").await {
                Ok(_) => (StatusCode::OK, "ok").into_response(),
                Err(_) => failed(),
            }
        }
        Some(event @ ("payment_link.expired" | "payment_link.cancelled")) => {
            let status = if event.ends_with("expired") {
                EXPIRED
            } else {
                CANCELLED
            };
            let (accounts, r) = (state.accounts.clone(), reference.to_string());
            match blocking(move || accounts.payment_ended(&r, status)).await {
                Ok(()) => (StatusCode::OK, "ok").into_response(),
                Err(_) => failed(),
            }
        }
        _ => (StatusCode::OK, "ignored").into_response(),
    }
}
