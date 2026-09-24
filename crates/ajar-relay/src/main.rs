//! ajar-relay — routes frames between an agent and its guests.
//!
//! It holds a session map and forwards bytes. It does not know what a
//! terminal is, what a file is, or what any payload contains.

mod outbox;
mod pad;
mod quota;
mod session;
mod ws;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ws::WebSocketUpgrade, ConnectInfo, DefaultBodyLimit, Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use clap::Parser;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

use crate::pad::Store;
use crate::session::Registry;

// A pad may contain 25 MiB of text. JSON escaping can expand each byte to six
// bytes on the wire, so the extractor limit must sit above the store's cap.
/// The largest pad write this will read off the wire.
///
/// A pad holds 25 MiB of *content*; JSON escaping makes the request bigger than
/// that. The multiplier used to be six, for the worst case where every byte is a
/// control character and becomes `\u00XX` — which is pathological, and it priced
/// every request as if it were: 151 MiB each, with nothing bounding how many
/// arrived at once. Four of them exceed the service's own `MemoryMax=512M`.
///
/// Two covers escaping that happens in real text — quotes, backslashes and
/// newlines all double — and a pad that genuinely cannot fit is refused with a
/// size error rather than being allowed to reserve six times its weight.
const MAX_PAD_HTTP_BODY: usize = pad::MAX_BYTES * 2 + 1024 * 1024;

/// Pad writes read off the wire at once.
///
/// The body limit bounds one request; this bounds the sum. Without it the two
/// numbers that matter are unrelated — any limit times any concurrency is an
/// arbitrarily large amount of memory, and the ceiling that actually applies is
/// the OOM killer.
///
/// A queue rather than a refusal, because waiting a moment is invisible and
/// being told "busy" is not. Requests wait *before* their body is read, so
/// queuing costs a connection rather than 51 MiB.
const MAX_CONCURRENT_PAD_WRITES: usize = 4;

// These two are only meaningful together, and the unit file's MemoryMax=512M is
// what they have to fit inside — along with every session, outbox and snapshot
// the relay is also holding. Raising either one alone is how a limit stops being
// one, so the product is stated here rather than left to be worked out after an
// OOM. 204 MiB against 512 MiB leaves room for the rest of the process.
const _: () = assert!(MAX_PAD_HTTP_BODY * MAX_CONCURRENT_PAD_WRITES < 256 * 1024 * 1024);

/// Pad reads being streamed at once, from every caller together.
///
/// Not a memory bound — a read is streamed from its file and costs a chunk
/// buffer whatever the pad's size — but a descriptor bound: each is an open
/// file and a socket, and the unit's soft limit is 1,024 of those shared with
/// every session. Each address is held to `quota::MAX_READS_PER_IP` of these, so
/// one slow reader cannot hold them all.
const MAX_CONCURRENT_PAD_READS: usize = 64;

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
}

#[derive(Clone)]
struct AppState {
    registry: Arc<Registry>,
    quota: Arc<quota::Quota>,
    pads: Arc<Store>,
    /// Bounds how many pad bodies are being read at once. See
    /// [`MAX_CONCURRENT_PAD_WRITES`].
    writing: Arc<tokio::sync::Semaphore>,
    /// Bounds how many pads are being streamed out at once. See
    /// [`MAX_CONCURRENT_PAD_READS`].
    reading: Arc<tokio::sync::Semaphore>,
    /// What each address has added to the pad store today.
    growth: Arc<quota::Growth>,
    trust_forwarded: bool,
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
    // Both numbers, because the interesting one is the gap. A relay that starts
    // already near its ceiling is a thing to know at boot rather than from the
    // first refused write.
    info!(
        "pads stored in {} — holding {} MB of {} MB",
        args.pad_dir,
        pads.used() / (1024 * 1024),
        args.max_store_bytes / (1024 * 1024),
    );

    let state = AppState {
        registry: Arc::new(Registry::new()),
        quota: Arc::new(quota::Quota::new()),
        pads: pads.clone(),
        writing: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_PAD_WRITES)),
        reading: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_PAD_READS)),
        growth: Arc::new(quota::Growth::new(args.pad_growth_per_address)),
        trust_forwarded: args.trust_forwarded_for,
    };

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

    let mut app = Router::new()
        .route("/ws", get(upgrade))
        .route("/healthz", get(health))
        .route("/install.sh", get(install_script))
        .route("/run.sh", get(run_script))
        .route(
            "/api/pad/{name}",
            get(read_pad)
                .put(write_pad)
                .layer(DefaultBodyLimit::max(MAX_PAD_HTTP_BODY)),
        )
        .layer(CorsLayer::permissive())
        .with_state(state);

    // In development the client is served by Vite; in a release build we can
    // hand out the compiled assets from the same process.
    if let Some(dir) = args.web.as_deref() {
        let index = ServeFile::new(format!("{dir}/index.html"));
        app = app.fallback_service(ServeDir::new(dir).fallback(index));
        info!("serving web client from {dir}");
    }

    let listener = tokio::net::TcpListener::bind(args.bind).await?;
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

async fn health() -> &'static str {
    "ok"
}

/// What the browser gets when it opens a name.
///
/// A name nobody holds is not an error — it is the normal way a pad begins,
/// and answering 404 would put a red line in the console every time somebody
/// started something. `exists` carries that instead.
#[derive(serde::Serialize)]
struct PadBody {
    exists: bool,
    seq: u64,
    files: std::collections::BTreeMap<String, pad::File>,
}

#[derive(serde::Deserialize)]
struct WriteBody {
    writes: Vec<pad::Write>,
}

#[derive(serde::Serialize)]
struct Wrote {
    seq: u64,
}

fn refuse(e: pad::Error) -> (StatusCode, String) {
    let code = match e {
        pad::Error::TooBig { .. } | pad::Error::TooManyFiles => StatusCode::PAYLOAD_TOO_LARGE,
        // Not the request's fault and worth retrying, which is what this status
        // means and what PAYLOAD_TOO_LARGE would wrongly deny.
        pad::Error::StoreFull => StatusCode::INSUFFICIENT_STORAGE,
        // The caller's own daily allowance: theirs to wait out, not the server's
        // fault, and retryable later — which is what 429 says.
        pad::Error::OverAllowance => StatusCode::TOO_MANY_REQUESTS,
        pad::Error::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_REQUEST,
    };
    (code, e.message())
}

async fn read_pad(
    Path(name): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    State(state): State<AppState>,
) -> axum::response::Response {
    let caller = caller_ip(&headers, peer.ip(), state.trust_forwarded);
    let Ok(slot) = state
        .quota
        .claim(caller, std::time::Instant::now(), quota::Kind::Read)
    else {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "too many pads being read from this address at once — try again in a moment",
        )
            .into_response();
    };
    let Ok(Ok(permit)) =
        tokio::time::timeout(PAD_READ_WAIT, state.reading.clone().acquire_owned()).await
    else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "the server is busy sending other pads — try again in a moment",
        )
            .into_response();
    };

    // Opening, checking and renewing are filesystem calls, so they go where
    // blocking belongs rather than stalling a worker carrying keystrokes.
    let pads = state.pads.clone();
    let Ok(opened) = tokio::task::spawn_blocking(move || pads.open_for_read(&name)).await else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "reading the pad failed").into_response();
    };
    match opened {
        Ok(Some(opened)) => stream_pad(opened, (slot, permit)),
        Ok(None) => Json(PadBody {
            exists: false,
            seq: 0,
            files: Default::default(),
        })
        .into_response(),
        Err(e) => refuse(e).into_response(),
    }
}

/// The stored document, sent from its file with `exists` put in front.
///
/// `held` is what has to last as long as the sending: the address's read slot
/// and the global permit. It rides inside the body stream, so it is released
/// when the last byte goes or the client disappears — not when this function
/// returns, which is before a single byte of the body has moved. Held by the
/// handler instead, the bound would cover nothing but opening the file.
fn stream_pad(opened: pad::Opened, held: impl Send + 'static) -> axum::response::Response {
    use futures_util::StreamExt;

    const HEAD: &[u8] = br#"{"exists":true,"#;
    let rest = tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(opened.file));
    let body = futures_util::stream::once(async {
        Ok::<_, std::io::Error>(axum::body::Bytes::from_static(HEAD))
    })
    .chain(rest)
    .map(move |chunk| {
        let _held = &held;
        chunk
    });
    axum::response::Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .header(
            axum::http::header::CONTENT_LENGTH,
            HEAD.len() as u64 + opened.remaining,
        )
        .body(axum::body::Body::from_stream(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// A permit to read one pad body.
///
/// An extractor rather than something the handler takes for itself, because
/// where it runs is the whole point: extractors that do not touch the body run
/// first, so this waits *before* 51 MiB is pulled off the wire. Taken inside the
/// handler it would bound nothing — the memory is already spent by then.
struct WritePermit(#[allow(dead_code)] tokio::sync::OwnedSemaphorePermit);

impl axum::extract::FromRequestParts<AppState> for WritePermit {
    type Rejection = (StatusCode, String);

    async fn from_request_parts(
        _parts: &mut axum::http::request::Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        state
            .writing
            .clone()
            .acquire_owned()
            .await
            .map(WritePermit)
            .map_err(|_| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "the server is shutting down".to_string(),
                )
            })
    }
}

async fn write_pad(
    Path(name): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    State(state): State<AppState>,
    _permit: WritePermit,
    Json(body): Json<WriteBody>,
) -> Result<Json<Wrote>, (StatusCode, String)> {
    let caller = caller_ip(&headers, peer.ip(), state.trust_forwarded);
    let now = std::time::Instant::now();
    let allowance = state.growth.remaining(caller, now);

    // Read, modify and rename under a lock: blocking work, kept off the workers
    // that carry every session's frames.
    let pads = state.pads.clone();
    let written =
        tokio::task::spawn_blocking(move || pads.write_within(&name, &body.writes, allowance))
            .await
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "storing the pad failed".to_string(),
                )
            })?
            .map_err(refuse)?;
    state.growth.charge(caller, now, written.grew);
    Ok(Json(Wrote { seq: written.seq }))
}

/// `curl -sSf https://ajar.sh/install.sh | sh`
///
/// Compiled in rather than served from disk: the installer and the relay ship
/// together, so there is no way for the published script to drift from the
/// version that was built, and nothing extra to deploy.
/// `curl -sSf https://ajar.sh/run.sh | sh`
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
    // Cap what one client may send in a single frame. The largest legitimate
    // payload is a workspace snapshot, which the store already refuses above
    // 25 MB — so anything much larger than that is either a bug or an attempt
    // to make the relay allocate on demand.
    ws.max_message_size(32 * 1024 * 1024)
        .max_frame_size(32 * 1024 * 1024)
        .on_upgrade(move |socket| {
            ws::handle(socket, state.registry.clone(), state.quota.clone(), caller)
        })
}

#[cfg(test)]
mod tests {
    use super::caller_ip;
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
