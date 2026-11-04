//! Paying for the paid plan: ₹99 (`AJAR_PAID_PRICE_INR`) for 30 days
//! (`AJAR_PAID_DAYS`), with UPI, through Razorpay. Designed in
//! docs/dev/billing.md.
//!
//! Each payment is a Razorpay Payment Link made for it alone and paid on
//! Razorpay's own page. Their checkout script cannot be used: the pad's
//! origin is cross-origin isolated (COEP `require-corp`), and a third party's
//! script and frames would have to opt in to that, which Razorpay's do not.
//! A redirect asks nothing of the page. The payer comes back to
//! `/api/billing/return` with Razorpay's signature, and Razorpay tells
//! `/api/billing/webhook` as well; whichever arrives first credits the
//! payment, and the other finds it done. One that neither reached — the tab
//! closed, no webhook set up — is asked after when its owner next looks.
//!
//! Not a subscription: nothing is taken again by itself. A payment adds its
//! days to whatever the account has left (`users.paid_until`), and the
//! account is on the paid plan until then (`Accounts::standing`).

use base64::Engine;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::accounts::{AccountError, Accounts};

/// How long a payment link can be paid: long enough to find a phone and
/// approve it, short enough that an abandoned one is not left open.
/// Razorpay refuses one that expires in under fifteen minutes.
pub const LINK_SECS: i64 = 30 * 60;

/// A link this close to expiring is not offered again; a new one is made.
const REUSE_MARGIN: i64 = 10 * 60;

/// Payments one account may begin in an hour. Each is a request to Razorpay
/// in our name; a person needs one, or two after a mistake.
pub const BEGUN_AN_HOUR: usize = 5;

/// How far ahead an account may pay. Without a limit, a price change, or a
/// refund, could meet years paid in advance.
pub const AHEAD_DAYS: i64 = 365;

/// How often an unfinished payment is asked after at Razorpay, at most.
const CHECK_EVERY: i64 = 5;

/// How long after it began an unfinished payment is still asked after. The
/// link has expired long before; Razorpay's own answer is in by then.
const CHECK_FOR: i64 = 24 * 60 * 60;

const DAY: i64 = 24 * 60 * 60;

/// What the paid plan costs, and what that buys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Price {
    /// In paise: ₹99 is 9900.
    pub amount: u64,
    pub currency: &'static str,
    pub days: u32,
}

impl Price {
    pub fn inr(rupees: u64, days: u32) -> Self {
        Price {
            amount: rupees * 100,
            currency: "INR",
            days,
        }
    }

    /// Why this will not do as a price, if it will not.
    pub fn problem(&self) -> Option<String> {
        if self.amount < 100 {
            Some("the paid plan's price is under ₹1, the least Razorpay takes".into())
        } else if self.amount > 100_000 * 100 {
            Some("the paid plan's price is over ₹1,00,000".into())
        } else if self.days == 0 || i64::from(self.days) > AHEAD_DAYS {
            Some(format!(
                "a payment adds {} days; it has to be 1 to {AHEAD_DAYS}",
                self.days
            ))
        } else {
            None
        }
    }
}

pub const CREATED: &str = "created";
pub const PAID: &str = "paid";
pub const EXPIRED: &str = "expired";
pub const CANCELLED: &str = "cancelled";
/// Razorpay would not make the link. Never shown; counted against
/// [`BEGUN_AN_HOUR`], so a failing Razorpay is not asked again and again.
const FAILED: &str = "failed";

/// One payment, as its owner sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Payment {
    /// Ours, sent to Razorpay as the link's `reference_id`.
    pub reference: String,
    pub amount: u64,
    pub currency: String,
    pub days: u32,
    /// [`CREATED`], [`PAID`], [`EXPIRED`] or [`CANCELLED`].
    pub status: String,
    pub created: i64,
    /// When its link stops taking payment.
    pub expires: i64,
    pub paid_at: Option<i64>,
    /// Razorpay's id for the money, `pay_…`: what a refund is asked by.
    pub payment_id: Option<String>,
    /// The account was paid for until this, once it was credited.
    pub until: Option<i64>,
    /// Razorpay's page for it, while it may still be paid.
    pub url: Option<String>,
}

/// A payment as it is kept: whose it is — nobody's, once that account is
/// deleted — and the Razorpay link it was given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recorded {
    pub owner: Option<i64>,
    pub link_id: Option<String>,
    pub payment: Payment,
}

/// What crediting a payment did.
#[derive(Debug, PartialEq, Eq)]
pub enum Credit {
    /// Its days were added: the account is paid for until this. `None` for
    /// a payment whose account has since been deleted.
    Credited(Option<i64>),
    /// It had been credited already.
    Already,
    /// No payment has that reference.
    Unknown,
    /// Less came in than it was for. Razorpay's links are made whole-only,
    /// so this is not expected; it is credited by hand, if at all.
    Short,
}

const COLUMNS: &str =
    "reference, amount, currency, days, status, created, expires, paid_at, payment_id, until, link_url";

fn payment_row(r: &rusqlite::Row) -> rusqlite::Result<Payment> {
    let status: String = r.get(4)?;
    let expires: i64 = r.get(6)?;
    let url: Option<String> = r.get(10)?;
    Ok(Payment {
        reference: r.get(0)?,
        amount: r.get::<_, i64>(1)? as u64,
        currency: r.get(2)?,
        days: r.get::<_, i64>(3)? as u32,
        // Only a link that can still be paid is handed back.
        url: url.filter(|_| status == CREATED && expires > crate::accounts::now()),
        status,
        created: r.get(5)?,
        expires,
        paid_at: r.get(7)?,
        payment_id: r.get(8)?,
        until: r.get(9)?,
    })
}

/// When `days` paid now run out, on top of whatever is left of `until`.
pub fn extended(until: Option<i64>, days: u32, now: i64) -> i64 {
    until.unwrap_or(0).max(now) + i64::from(days) * DAY
}

impl Accounts {
    /// A payment of this account's begun at `price` and still open long
    /// enough to be finished: offered again, rather than a second link.
    pub fn open_payment(
        &self,
        user: i64,
        price: Price,
        now: i64,
    ) -> Result<Option<Payment>, AccountError> {
        let db = self.db.lock();
        Ok(db
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM payments
                     WHERE user_id = ?1 AND status = 'created' AND link_url IS NOT NULL
                       AND expires > ?2 AND amount = ?3 AND currency = ?4 AND days = ?5
                     ORDER BY created DESC LIMIT 1"
                ),
                params![
                    user,
                    now + REUSE_MARGIN,
                    price.amount as i64,
                    price.currency,
                    price.days
                ],
                payment_row,
            )
            .optional()?)
    }

    /// How many payments this account has begun since `since`, made or not.
    pub fn payments_begun(&self, user: i64, since: i64) -> Result<usize, AccountError> {
        let db = self.db.lock();
        let n: i64 = db.query_row(
            "SELECT COUNT(*) FROM payments WHERE user_id = ?1 AND created >= ?2",
            params![user, since],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }

    /// A payment, before Razorpay has been asked for its link.
    pub fn begin_payment(
        &self,
        user: i64,
        reference: &str,
        price: Price,
        now: i64,
    ) -> Result<(), AccountError> {
        self.db.lock().execute(
            "INSERT INTO payments (user_id, reference, amount, currency, days, status, created, expires)
             VALUES (?1, ?2, ?3, ?4, ?5, 'created', ?6, ?7)",
            params![
                user,
                reference,
                price.amount as i64,
                price.currency,
                price.days,
                now,
                now + LINK_SECS
            ],
        )?;
        Ok(())
    }

    /// Razorpay made its link.
    pub fn payment_linked(
        &self,
        reference: &str,
        link_id: &str,
        url: &str,
    ) -> Result<(), AccountError> {
        self.db.lock().execute(
            "UPDATE payments SET link_id = ?2, link_url = ?3 WHERE reference = ?1",
            params![reference, link_id, url],
        )?;
        Ok(())
    }

    /// Razorpay would not make its link.
    pub fn payment_not_begun(&self, reference: &str) -> Result<(), AccountError> {
        self.db.lock().execute(
            "UPDATE payments SET status = ?2 WHERE reference = ?1 AND status = 'created'",
            params![reference, FAILED],
        )?;
        Ok(())
    }

    /// The money came in: the payment is marked paid and its days added to
    /// its account, as one step, once. `paid` is the amount Razorpay says
    /// came in, when it says.
    ///
    /// Once whatever calls: the return from Razorpay's page, the webhook and
    /// a look at Razorpay can each arrive first, or together, and only the
    /// first finds the payment unpaid. A Razorpay payment id credits one
    /// payment at most (the column is unique).
    pub fn credit(
        &self,
        reference: &str,
        payment_id: &str,
        paid: Option<u64>,
        now: i64,
    ) -> Result<Credit, AccountError> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let row: Option<(Option<i64>, String, i64, i64)> = tx
            .query_row(
                "SELECT user_id, status, amount, days FROM payments WHERE reference = ?1",
                params![reference],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((user, status, amount, days)) = row else {
            return Ok(Credit::Unknown);
        };
        if status == PAID {
            return Ok(Credit::Already);
        }
        if paid.is_some_and(|p| p < amount as u64) {
            return Ok(Credit::Short);
        }
        let until = match user {
            Some(user) => {
                let before: Option<i64> = tx.query_row(
                    "SELECT paid_until FROM users WHERE id = ?1",
                    params![user],
                    |r| r.get(0),
                )?;
                let until = extended(before, days as u32, now);
                tx.execute(
                    "UPDATE users SET paid_until = ?2 WHERE id = ?1",
                    params![user, until],
                )?;
                Some(until)
            }
            None => None,
        };
        tx.execute(
            "UPDATE payments SET status = 'paid', payment_id = ?2, paid_at = ?3, until = ?4
             WHERE reference = ?1",
            params![reference, payment_id, now, until],
        )?;
        tx.commit()?;
        Ok(Credit::Credited(until))
    }

    /// Razorpay says the link can no longer be paid: [`EXPIRED`] or
    /// [`CANCELLED`]. Never a payment already paid.
    pub fn payment_ended(&self, reference: &str, status: &str) -> Result<(), AccountError> {
        self.db.lock().execute(
            "UPDATE payments SET status = ?2 WHERE reference = ?1 AND status = 'created'",
            params![reference, status],
        )?;
        Ok(())
    }

    /// One payment by its reference, with whose it is and its link's id.
    pub fn payment(&self, reference: &str) -> Result<Option<Recorded>, AccountError> {
        let db = self.db.lock();
        Ok(db
            .query_row(
                &format!("SELECT {COLUMNS}, user_id, link_id FROM payments WHERE reference = ?1"),
                params![reference],
                |r| {
                    Ok(Recorded {
                        owner: r.get(11)?,
                        link_id: r.get(12)?,
                        payment: payment_row(r)?,
                    })
                },
            )
            .optional()?)
    }

    /// An account's payments, newest first: those Razorpay made a link for.
    pub fn payments_of(&self, user: i64) -> Result<Vec<Payment>, AccountError> {
        let db = self.db.lock();
        let mut q = db.prepare(&format!(
            "SELECT {COLUMNS} FROM payments WHERE user_id = ?1 AND link_id IS NOT NULL
             ORDER BY created DESC, id DESC LIMIT 50"
        ))?;
        let rows = q.query_map(params![user], payment_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// An account's unfinished payments that are due to be asked after at
    /// Razorpay — reference and link id — each marked asked as it is
    /// handed out, so two looks at once do not both ask.
    pub fn payments_to_check(
        &self,
        user: i64,
        now: i64,
    ) -> Result<Vec<(String, String)>, AccountError> {
        let db = self.db.lock();
        let due: Vec<(String, String)> = {
            let mut q = db.prepare(
                "SELECT reference, link_id FROM payments
                 WHERE user_id = ?1 AND status = 'created' AND link_id IS NOT NULL
                   AND created > ?2 AND checked <= ?3
                 ORDER BY created DESC LIMIT 3",
            )?;
            let rows = q.query_map(params![user, now - CHECK_FOR, now - CHECK_EVERY], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        for (reference, _) in &due {
            db.execute(
                "UPDATE payments SET checked = ?2 WHERE reference = ?1",
                params![reference, now],
            )?;
        }
        Ok(due)
    }

    /// Payments for the operator's view: how many accounts are paying now,
    /// and what came in over the last `days`.
    pub fn takings(&self, days: i64, now: i64) -> Result<Takings, AccountError> {
        let db = self.db.lock();
        let paying: i64 = db.query_row(
            "SELECT COUNT(*) FROM users WHERE paid_until > ?1",
            params![now],
            |r| r.get(0),
        )?;
        let (payments, amount): (i64, i64) = db.query_row(
            "SELECT COUNT(*), COALESCE(SUM(amount), 0) FROM payments
             WHERE status = 'paid' AND paid_at >= ?1",
            params![now - days * DAY],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(Takings {
            paying,
            payments,
            amount,
        })
    }
}

/// What the operator's view says of payments.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Takings {
    /// Accounts a payment holds on the paid plan now.
    pub paying: i64,
    /// Payments credited in the period, and their total in paise.
    pub payments: i64,
    pub amount: i64,
}

// ------------------------------------------------------------- signatures

/// HMAC-SHA256 (RFC 2104), which is how Razorpay signs what it sends. A
/// dozen lines over the `sha2` the relay already has, rather than another
/// crate; checked against RFC 4231's vectors below.
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether `signature` is `secret`'s HMAC of `message`, in hex as Razorpay
/// writes it.
fn signed(secret: &str, message: &[u8], signature: &str) -> bool {
    crate::auth::same(
        &hex(&hmac_sha256(secret.as_bytes(), message)),
        &signature.trim().to_ascii_lowercase(),
    )
}

/// A reference of ours, or a Razorpay id: letters, digits, `_` and `-`.
/// Anything else came from somewhere else, and goes into no address.
pub fn plain_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

// ------------------------------------------------------------- Razorpay

/// How long a request to Razorpay may take. The page waits on it.
const RAZORPAY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Razorpay's API, with this relay's keys. Configured from the environment,
/// beside the sign-in secrets in `/etc/ajar/relay.env` and never in the
/// repository:
///
/// | | |
/// |---|---|
/// | `AJAR_RAZORPAY_KEY_ID`, `AJAR_RAZORPAY_KEY_SECRET` | The API key, from Razorpay's dashboard. `rzp_test_…` is test mode, where no money moves |
/// | `AJAR_RAZORPAY_WEBHOOK_SECRET` | The secret the webhook was set up with; without it, the webhook is refused |
/// | `AJAR_RAZORPAY_API` | Razorpay's API, `https://api.razorpay.com` unless a check points it at a stand-in |
pub struct Razorpay {
    key_id: String,
    key_secret: String,
    webhook_secret: Option<String>,
    api: String,
    http: ureq::Agent,
}

/// A payment link Razorpay made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub id: String,
    pub url: String,
}

/// What Razorpay says of a link now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkState {
    /// `created`, `partially_paid`, `paid`, `expired` or `cancelled`.
    pub status: String,
    /// The payment that paid it, when one did.
    pub payment_id: Option<String>,
    pub amount_paid: u64,
}

/// What a link is made for.
pub struct LinkRequest<'a> {
    pub reference: &'a str,
    pub price: Price,
    pub expire_by: i64,
    pub callback: &'a str,
    pub description: &'a str,
    pub name: &'a str,
    pub email: Option<&'a str>,
    pub account: i64,
}

impl Razorpay {
    pub fn from_env() -> Option<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Some(Razorpay::new(
            &var("AJAR_RAZORPAY_KEY_ID")?,
            &var("AJAR_RAZORPAY_KEY_SECRET")?,
            var("AJAR_RAZORPAY_WEBHOOK_SECRET").as_deref(),
            &var("AJAR_RAZORPAY_API").unwrap_or_else(|| "https://api.razorpay.com".into()),
        ))
    }

    pub fn new(key_id: &str, key_secret: &str, webhook_secret: Option<&str>, api: &str) -> Self {
        Razorpay {
            key_id: key_id.trim().to_string(),
            key_secret: key_secret.trim().to_string(),
            webhook_secret: webhook_secret.map(|s| s.trim().to_string()),
            api: api.trim_end_matches('/').to_string(),
            http: ureq::Agent::new_with_config(
                ureq::Agent::config_builder()
                    .timeout_global(Some(RAZORPAY_TIMEOUT))
                    // Razorpay says what was wrong in the body of a 400; read it.
                    .http_status_as_error(false)
                    .build(),
            ),
        }
    }

    /// Test mode: Razorpay's test keys, with which no money moves.
    pub fn test_mode(&self) -> bool {
        self.key_id.starts_with("rzp_test_")
    }

    pub fn webhooks(&self) -> bool {
        self.webhook_secret.is_some()
    }

    fn authorization(&self) -> String {
        let pair = format!("{}:{}", self.key_id, self.key_secret);
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(pair)
        )
    }

    /// A link for one payment, which takes UPI and nothing else. Blocking.
    pub fn create_link(&self, req: &LinkRequest) -> Result<Link, String> {
        let mut customer = serde_json::json!({ "name": req.name });
        if let Some(email) = req.email {
            customer["email"] = email.into();
        }
        let body = serde_json::json!({
            "amount": req.price.amount,
            "currency": req.price.currency,
            "accept_partial": false,
            "expire_by": req.expire_by,
            "reference_id": req.reference,
            "description": req.description,
            "customer": customer,
            // The page says what happens next; Razorpay sends nothing.
            "notify": { "sms": false, "email": false },
            "reminder_enable": false,
            "notes": { "account": req.account.to_string() },
            "callback_url": req.callback,
            "callback_method": "get",
            // UPI only. Razorpay's page offers what this leaves on.
            "options": { "checkout": { "method": {
                "upi": "1", "card": "0", "netbanking": "0", "wallet": "0"
            } } },
        });
        let mut res = self
            .http
            .post(&format!("{}/v1/payment_links", self.api))
            .header("Authorization", &self.authorization())
            .send_json(&body)
            .map_err(|e| format!("Razorpay could not be reached: {e}"))?;
        let status = res.status().as_u16();
        let said: serde_json::Value = res
            .body_mut()
            .read_json()
            .map_err(|e| format!("Razorpay answered {status} strangely: {e}"))?;
        if !(200..300).contains(&status) {
            return Err(format!(
                "Razorpay refused the link ({status}): {}",
                said["error"]["description"]
                    .as_str()
                    .unwrap_or("no reason given")
            ));
        }
        match (said["id"].as_str(), said["short_url"].as_str()) {
            (Some(id), Some(url)) if plain_id(id) && url.starts_with("http") => Ok(Link {
                id: id.to_string(),
                url: url.to_string(),
            }),
            _ => Err("Razorpay's answer had no link in it".into()),
        }
    }

    /// What Razorpay says of a link now. Blocking.
    pub fn fetch_link(&self, id: &str) -> Result<LinkState, String> {
        if !plain_id(id) {
            return Err("not a link id".into());
        }
        let mut res = self
            .http
            .get(&format!("{}/v1/payment_links/{id}", self.api))
            .header("Authorization", &self.authorization())
            .call()
            .map_err(|e| format!("Razorpay could not be reached: {e}"))?;
        let status = res.status().as_u16();
        let said: serde_json::Value = res
            .body_mut()
            .read_json()
            .map_err(|e| format!("Razorpay answered {status} strangely: {e}"))?;
        if !(200..300).contains(&status) {
            return Err(format!("Razorpay would not say ({status})"));
        }
        let payment_id = said["payments"].as_array().and_then(|ps| {
            ps.iter()
                .find(|p| p["status"].as_str() == Some("captured"))
                .and_then(|p| p["payment_id"].as_str())
                .map(str::to_string)
        });
        Ok(LinkState {
            status: said["status"].as_str().unwrap_or_default().to_string(),
            payment_id,
            amount_paid: said["amount_paid"].as_u64().unwrap_or(0),
        })
    }

    /// Whether the address Razorpay sent the payer back to is Razorpay's:
    /// its signature is over the link, our reference, the status and the
    /// payment, with the key's secret.
    pub fn callback_signed(
        &self,
        link_id: &str,
        reference: &str,
        status: &str,
        payment_id: &str,
        signature: &str,
    ) -> bool {
        let message = format!("{link_id}|{reference}|{status}|{payment_id}");
        signed(&self.key_secret, message.as_bytes(), signature)
    }

    /// Whether a webhook's body is Razorpay's — `None` when no webhook
    /// secret is set, and so none can be.
    pub fn webhook_signed(&self, body: &[u8], signature: &str) -> Option<bool> {
        let secret = self.webhook_secret.as_deref()?;
        Some(signed(secret, body, signature))
    }

    /// The signature Razorpay would put on a return, for the checks.
    #[cfg(test)]
    pub fn sign_callback(
        &self,
        link_id: &str,
        reference: &str,
        status: &str,
        payment_id: &str,
    ) -> String {
        let message = format!("{link_id}|{reference}|{status}|{payment_id}");
        hex(&hmac_sha256(self.key_secret.as_bytes(), message.as_bytes()))
    }
}

/// Paying, as the relay is set up for it.
pub struct Billing {
    /// `None` when no keys are set: the plans are shown, and nothing can be bought.
    pub razorpay: Option<Razorpay>,
    pub price: Price,
    /// Where Razorpay sends the payer back: the pad's public origin
    /// (`AJAR_PUBLIC_ORIGIN`). Empty on a development relay, which cannot
    /// take payments.
    pub origin: String,
}

impl Billing {
    pub fn available(&self) -> bool {
        self.razorpay.is_some() && !self.origin.is_empty()
    }

    /// Where Razorpay's page sends the payer back to.
    pub fn callback(&self) -> String {
        format!("{}/api/billing/return", self.origin.trim_end_matches('/'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(key: &[u8], message: &[u8]) -> String {
        hex(&hmac_sha256(key, message))
    }

    #[test]
    fn hmac_is_rfc_4231_s() {
        assert_eq!(
            h(&[0x0b; 20], b"Hi There"),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        assert_eq!(
            h(b"Jefe", b"what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // A key longer than a block is hashed first.
        assert_eq!(
            h(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            ),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn a_return_is_razorpay_s_only_with_its_signature() {
        let rz = Razorpay::new("rzp_test_k", "secret", Some("hook"), "http://x");
        let sig = rz.sign_callback("plink_1", "ajar-ref", "paid", "pay_1");
        assert!(rz.callback_signed("plink_1", "ajar-ref", "paid", "pay_1", &sig));
        assert!(rz.callback_signed("plink_1", "ajar-ref", "paid", "pay_1", &sig.to_uppercase()));
        for (link, reference, status, payment) in [
            ("plink_2", "ajar-ref", "paid", "pay_1"),
            ("plink_1", "ajar-other", "paid", "pay_1"),
            ("plink_1", "ajar-ref", "expired", "pay_1"),
            ("plink_1", "ajar-ref", "paid", "pay_2"),
        ] {
            assert!(!rz.callback_signed(link, reference, status, payment, &sig));
        }
        let other = Razorpay::new("rzp_test_k", "another", None, "http://x");
        assert!(!rz.callback_signed(
            "plink_1",
            "ajar-ref",
            "paid",
            "pay_1",
            &other.sign_callback("plink_1", "ajar-ref", "paid", "pay_1")
        ));
        assert!(rz.test_mode());
    }

    #[test]
    fn a_webhook_is_razorpay_s_only_with_the_webhook_secret() {
        let rz = Razorpay::new("rzp_live_k", "secret", Some("hook"), "http://x");
        let body = br#"{"event":"payment_link.paid"}"#;
        let sig = hex(&hmac_sha256(b"hook", body));
        assert_eq!(rz.webhook_signed(body, &sig), Some(true));
        assert_eq!(rz.webhook_signed(b"{}", &sig), Some(false));
        let by_key = hex(&hmac_sha256(b"secret", body));
        assert_eq!(rz.webhook_signed(body, &by_key), Some(false));
        let none = Razorpay::new("rzp_live_k", "secret", None, "http://x");
        assert_eq!(none.webhook_signed(body, &sig), None);
        assert!(!rz.test_mode());
    }

    #[test]
    fn days_are_added_to_what_is_left_or_to_now() {
        let now = 1_000_000;
        assert_eq!(extended(None, 30, now), now + 30 * DAY);
        assert_eq!(extended(Some(now - 5 * DAY), 30, now), now + 30 * DAY);
        assert_eq!(extended(Some(now + 5 * DAY), 30, now), now + 35 * DAY);
    }

    #[test]
    fn a_price_that_will_not_do_is_said() {
        assert_eq!(Price::inr(99, 30).amount, 9900);
        assert!(Price::inr(99, 30).problem().is_none());
        assert!(Price::inr(0, 30).problem().is_some());
        assert!(Price::inr(99, 0).problem().is_some());
        assert!(Price::inr(99, 400).problem().is_some());
    }

    #[test]
    fn only_plain_ids_go_into_an_address() {
        assert!(plain_id("plink_Abc123"));
        assert!(plain_id("ajar-x_Y"));
        for bad in ["", "../x", "a/b", "a?b", "a b", &"x".repeat(65)] {
            assert!(!plain_id(bad), "{bad}");
        }
    }

    fn accounts() -> (tempdir::Dir, Accounts) {
        let dir = tempdir::Dir::new();
        let accounts = Accounts::open(&dir.0.join("accounts.db")).unwrap();
        (dir, accounts)
    }

    mod tempdir {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let p = std::env::temp_dir()
                    .join(format!("ajar-billing-{}", crate::accounts::new_secret()));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn a_payment_is_credited_once_and_its_days_hold_the_account_on_the_paid_plan() {
        use crate::plan::Plan;
        let (_dir, a) = accounts();
        let ana = a.sign_in("github", "1", None, "ana").unwrap().id;
        let price = Price::inr(99, 30);
        let now = crate::accounts::now();
        assert_eq!(a.plan_of(ana), Plan::Free);

        a.begin_payment(ana, "ajar-one", price, now).unwrap();
        assert_eq!(
            a.open_payment(ana, price, now).unwrap(),
            None,
            "no link yet"
        );
        a.payment_linked("ajar-one", "plink_1", "https://rzp.io/i/1")
            .unwrap();
        let open = a.open_payment(ana, price, now).unwrap().unwrap();
        assert_eq!(open.url.as_deref(), Some("https://rzp.io/i/1"));
        assert_eq!(
            a.open_payment(ana, Price::inr(149, 30), now).unwrap(),
            None,
            "a link at another price is not offered"
        );
        assert_eq!(
            a.open_payment(ana, price, now + LINK_SECS - REUSE_MARGIN + 1)
                .unwrap(),
            None,
            "nor one about to expire"
        );
        assert_eq!(a.plan_of(ana), Plan::Free, "begun is not paid");

        assert_eq!(
            a.credit("ajar-one", "pay_1", Some(9800), now).unwrap(),
            Credit::Short
        );
        let until = now + 30 * DAY;
        assert_eq!(
            a.credit("ajar-one", "pay_1", Some(9900), now).unwrap(),
            Credit::Credited(Some(until))
        );
        assert_eq!(
            a.credit("ajar-one", "pay_1", None, now).unwrap(),
            Credit::Already
        );
        assert_eq!(
            a.credit("ajar-nope", "pay_9", None, now).unwrap(),
            Credit::Unknown
        );
        let standing = a.standing(ana);
        assert_eq!(standing.plan, Plan::Paid);
        assert_eq!(standing.paid_until, Some(until));
        assert!(!standing.listed);
        assert_eq!(
            a.open_payment(ana, price, now).unwrap(),
            None,
            "paid is not open"
        );

        // A second payment adds to what is left, not to now.
        a.begin_payment(ana, "ajar-two", price, now).unwrap();
        a.payment_linked("ajar-two", "plink_2", "https://rzp.io/i/2")
            .unwrap();
        // One Razorpay payment pays one of ours.
        assert!(a.credit("ajar-two", "pay_1", None, now).is_err());
        assert_eq!(
            a.credit("ajar-two", "pay_2", None, now).unwrap(),
            Credit::Credited(Some(until + 30 * DAY))
        );
        let listed = a.payments_of(ana).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].status, PAID);
        assert_eq!(listed[0].url, None, "a paid link is not handed back");
        assert_eq!(listed[1].payment_id.as_deref(), Some("pay_1"));

        // An expired payment's days hold no longer.
        a.db.lock()
            .execute(
                "UPDATE users SET paid_until = ?2 WHERE id = ?1",
                params![ana, now - 1],
            )
            .unwrap();
        assert_eq!(a.plan_of(ana), Plan::Free);
    }

    #[test]
    fn an_unfinished_payment_is_asked_after_once_in_a_while_and_ends_when_razorpay_says() {
        let (_dir, a) = accounts();
        let ana = a.sign_in("github", "1", None, "ana").unwrap().id;
        let price = Price::inr(99, 30);
        let now = crate::accounts::now();
        a.begin_payment(ana, "ajar-one", price, now).unwrap();
        // Not asked after before Razorpay has made its link.
        assert!(a.payments_to_check(ana, now).unwrap().is_empty());
        a.payment_linked("ajar-one", "plink_1", "https://rzp.io/i/1")
            .unwrap();
        assert_eq!(
            a.payments_to_check(ana, now).unwrap(),
            vec![("ajar-one".to_string(), "plink_1".to_string())]
        );
        assert!(
            a.payments_to_check(ana, now + 1).unwrap().is_empty(),
            "not again at once"
        );
        assert_eq!(
            a.payments_to_check(ana, now + CHECK_EVERY).unwrap().len(),
            1
        );
        assert_eq!(a.payments_begun(ana, now - 3600).unwrap(), 1);

        a.payment_ended("ajar-one", EXPIRED).unwrap();
        assert!(a
            .payments_to_check(ana, now + 2 * CHECK_EVERY)
            .unwrap()
            .is_empty());
        assert_eq!(a.payments_of(ana).unwrap()[0].status, EXPIRED);
        // An expired link that was paid after all is still credited.
        assert!(matches!(
            a.credit("ajar-one", "pay_1", None, now).unwrap(),
            Credit::Credited(_)
        ));
        a.payment_ended("ajar-one", CANCELLED).unwrap();
        assert_eq!(
            a.payments_of(ana).unwrap()[0].status,
            PAID,
            "paid stays paid"
        );
    }

    #[test]
    fn a_deleted_account_s_payments_stay_and_name_nobody() {
        let (_dir, a) = accounts();
        let ana = a
            .sign_in("github", "1", Some("ana@example.com"), "ana")
            .unwrap()
            .id;
        let now = crate::accounts::now();
        a.begin_payment(ana, "ajar-one", Price::inr(99, 30), now)
            .unwrap();
        a.payment_linked("ajar-one", "plink_1", "https://rzp.io/i/1")
            .unwrap();
        a.credit("ajar-one", "pay_1", None, now).unwrap();
        a.begin_payment(ana, "ajar-two", Price::inr(99, 30), now)
            .unwrap();
        a.payment_linked("ajar-two", "plink_2", "https://rzp.io/i/2")
            .unwrap();
        a.delete_account(ana).unwrap();
        let kept = a.payment("ajar-one").unwrap().unwrap();
        assert_eq!(kept.owner, None);
        assert_eq!(kept.link_id.as_deref(), Some("plink_1"));
        assert_eq!(kept.payment.payment_id.as_deref(), Some("pay_1"));
        // Paid after the account went: recorded, and credited to nobody.
        assert_eq!(
            a.credit("ajar-two", "pay_2", None, now).unwrap(),
            Credit::Credited(None)
        );
        assert_eq!(a.takings(30, now).unwrap().payments, 2);
        assert_eq!(a.takings(30, now).unwrap().paying, 0);
    }

    #[test]
    fn a_listed_account_is_paid_without_paying() {
        let (_dir, a) = accounts();
        let a = a.with_paid(crate::plan::PaidList::parse("github:1"));
        let ana = a.sign_in("github", "1", None, "ana").unwrap().id;
        let standing = a.standing(ana);
        assert_eq!(standing.plan, crate::plan::Plan::Paid);
        assert!(standing.listed);
        assert_eq!(standing.paid_until, None);
    }
}
