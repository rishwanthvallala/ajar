//! ajar-relay — routes frames between an agent and its guests.
//!
//! It holds a session map and forwards bytes. It does not know what a
//! terminal is, what a file is, or what any payload contains.

mod outbox;
mod session;
mod ws;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ws::WebSocketUpgrade, State};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use clap::Parser;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

use crate::session::Registry;

#[derive(Parser, Debug)]
#[command(name = "ajar-relay", version, about = "Frame relay for ajar sessions")]
struct Args {
    /// Address to listen on.
    #[arg(long, default_value = "127.0.0.1:8787")]
    bind: SocketAddr,

    /// Optional directory of built web-client assets to serve.
    #[arg(long)]
    web: Option<String>,
}

#[derive(Clone)]
struct AppState {
    registry: Arc<Registry>,
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
    let state = AppState {
        registry: Arc::new(Registry::new()),
    };

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
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> &'static str {
    "ok"
}

/// `curl -sSf https://ajar.sh/install.sh | sh`
///
/// Compiled in rather than served from disk: the installer and the relay ship
/// together, so there is no way for the published script to drift from the
/// version that was built, and nothing extra to deploy.
async fn install_script() -> impl IntoResponse {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; charset=utf-8",
        )],
        include_str!("../../../install.sh"),
    )
}

async fn upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    // Cap what one client may send in a single frame. The largest legitimate
    // payload is a workspace snapshot, which the store already refuses above
    // 25 MB — so anything much larger than that is either a bug or an attempt
    // to make the relay allocate on demand.
    ws.max_message_size(32 * 1024 * 1024)
        .max_frame_size(32 * 1024 * 1024)
        .on_upgrade(move |socket| ws::handle(socket, state.registry.clone()))
}
