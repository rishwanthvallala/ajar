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
const MAX_PAD_HTTP_BODY: usize = pad::MAX_BYTES * 6 + 1024 * 1024;

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
        Store::open(&args.pad_dir)
            .map_err(|e| anyhow::anyhow!("cannot open the pad directory {}: {e}", args.pad_dir))?,
    );
    info!("pads stored in {}", args.pad_dir);

    let state = AppState {
        registry: Arc::new(Registry::new()),
        quota: Arc::new(quota::Quota::new()),
        pads: pads.clone(),
        trust_forwarded: args.trust_forwarded_for,
    };

    // Pads past their lease. Hourly rather than every few seconds: a lease is
    // a week, and nothing goes wrong if a dead pad lingers an extra hour.
    // `get` checks the lease too, so nobody is ever served an expired one.
    {
        let pads = pads.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
            loop {
                tick.tick().await;
                for name in pads.sweep() {
                    info!(pad = %name, "entombed after its lease expired");
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
        pad::Error::Gone => StatusCode::GONE,
        pad::Error::TooBig { .. } | pad::Error::TooManyFiles => StatusCode::PAYLOAD_TOO_LARGE,
        pad::Error::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_REQUEST,
    };
    (code, e.message())
}

async fn read_pad(
    Path(name): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<PadBody>, (StatusCode, String)> {
    match state.pads.get(&name).map_err(refuse)? {
        Some(p) => Ok(Json(PadBody {
            exists: true,
            seq: p.seq,
            files: p.files,
        })),
        None => Ok(Json(PadBody {
            exists: false,
            seq: 0,
            files: Default::default(),
        })),
    }
}

async fn write_pad(
    Path(name): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<WriteBody>,
) -> Result<Json<Wrote>, (StatusCode, String)> {
    let seq = state.pads.write(&name, &body.writes).map_err(refuse)?;
    Ok(Json(Wrote { seq }))
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
