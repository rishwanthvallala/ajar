//! The relay as a page or an agent meets it: requests through its router, and
//! sockets to it served on a port, each test with a store and an accounts
//! database of its own.
//!
//! The unit tests beside each module check what a store or a lookup answers;
//! these check what a caller is then told, which is where a failed lookup
//! used to become an open pad and a cookie from someone else's page used to
//! become its owner.

use std::net::SocketAddr;
use std::sync::Arc;

use ajar_proto::{Channel, Control, Frame, Role, TARGET_ALL};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tower::ServiceExt;

use crate::accounts::{Edit, PadInfo, View};
use crate::AppState;

/// A directory that is gone when the test is.
struct Dir(std::path::PathBuf);

impl Dir {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "ajar-serving-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Dir(path)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Where a test's requests come from.
pub const CALLER: SocketAddr = SocketAddr::new(
    std::net::IpAddr::V4(std::net::Ipv4Addr::new(198, 51, 100, 7)),
    40_000,
);

pub struct Relay {
    pub state: AppState,
    dir: Dir,
}

/// What a request was answered with.
pub struct Answer {
    pub status: StatusCode,
    pub body: String,
}

impl Answer {
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.body))
    }
}

impl Relay {
    /// A relay whose public origin is `origin`, as `AJAR_PUBLIC_ORIGIN` would
    /// set it: empty for a development relay.
    pub fn new(origin: &str) -> Self {
        let dir = Dir::new();
        let pads = Arc::new(crate::pad::Store::open(dir.0.join("pads"), u64::MAX).unwrap());
        let accounts =
            Arc::new(crate::accounts::Accounts::open(&dir.0.join("accounts.db")).unwrap());
        let state = AppState {
            registry: Arc::new(crate::session::Registry::new()),
            quota: Arc::new(crate::quota::Quota::new()),
            pads,
            writing: Arc::new(tokio::sync::Semaphore::new(
                crate::MAX_CONCURRENT_PAD_WRITES,
            )),
            reading: Arc::new(tokio::sync::Semaphore::new(crate::MAX_CONCURRENT_PAD_READS)),
            growth: Arc::new(crate::quota::Growth::new(u64::MAX)),
            trust_forwarded: false,
            accounts,
            auth: Arc::new(crate::auth::Auth::for_tests(origin)),
            account_writes: Default::default(),
            started: std::time::Instant::now(),
            usage: Arc::new(crate::usage::Usage::in_memory()),
        };
        Relay { state, dir }
    }

    /// A request through the router, as from [`CALLER`].
    pub async fn call(&self, mut request: Request<Body>) -> Answer {
        self.call_with(None, &mut request).await
    }

    /// The same, with the web client's files served from `web`.
    pub async fn call_with(&self, web: Option<&str>, request: &mut Request<Body>) -> Answer {
        let mut request = std::mem::replace(request, Request::new(Body::empty()));
        request.extensions_mut().insert(ConnectInfo(CALLER));
        let response = crate::router(self.state.clone(), web)
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        Answer {
            status,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        }
    }

    /// The router on a port of its own, for sockets.
    pub async fn serve(&self) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = crate::router(self.state.clone(), None);
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        addr
    }

    /// Somebody signed in: their id and the `Cookie` header their browser
    /// would send.
    pub fn signed_in(&self, who: &str) -> (i64, String) {
        let user = self
            .state
            .accounts
            .sign_in("github", who, None, who)
            .unwrap();
        let token = self.state.accounts.new_session(user.id).unwrap();
        let name = if self.state.auth.secure() {
            "__Host-ajar"
        } else {
            "ajar"
        };
        (user.id, format!("{name}={token}"))
    }

    /// A pad `owner` owns, with these settings and one file in it.
    pub fn owned_pad(&self, owner: i64, view: View, edit: Edit) -> PadInfo {
        let pad = self
            .state
            .accounts
            .create_pad(owner, &|_| false, None)
            .unwrap();
        self.state
            .accounts
            .change_access(owner, &pad.name, Some(view), Some(edit))
            .unwrap();
        self.state.pads.pin(&pad.name);
        self.state
            .pads
            .write(&pad.name, &[put("secret.txt", "the owner's words")])
            .unwrap();
        pad
    }

    /// Break the accounts database the way a fault would: the table every
    /// access decision reads is no longer there. From a connection of its
    /// own, as a corrupted or half-migrated file would look to the relay's.
    pub fn break_accounts(&self) {
        let db = rusqlite::Connection::open(self.dir.0.join("accounts.db")).unwrap();
        db.execute_batch("ALTER TABLE pads RENAME TO pads_unreadable")
            .unwrap();
    }
}

pub fn put(path: &str, content: &str) -> crate::pad::Write {
    serde_json::from_value(serde_json::json!({ "path": path, "content": content })).unwrap()
}

pub fn get(uri: &str, headers: &[(&str, &str)]) -> Request<Body> {
    request("GET", uri, headers, Body::empty())
}

pub fn request(method: &str, uri: &str, headers: &[(&str, &str)], body: Body) -> Request<Body> {
    let mut r = Request::builder().method(method).uri(uri);
    for (k, v) in headers {
        r = r.header(*k, *v);
    }
    r.body(body).unwrap()
}

pub fn write(name: &str, headers: &[(&str, &str)], writes: serde_json::Value) -> Request<Body> {
    let mut all = vec![("content-type", "application/json")];
    all.extend_from_slice(headers);
    request(
        "PUT",
        &format!("/api/pad/{name}"),
        &all,
        Body::from(serde_json::json!({ "writes": writes }).to_string()),
    )
}

/// A peer's hello to a pad's room.
pub fn peer_hello(pad: &str) -> Control {
    Control::Hello {
        session: pad.to_string(),
        role: Role::Peer,
        locked: false,
        protocol: ajar_proto::PROTOCOL_VERSION,
        code: None,
        host_key: None,
        resume: None,
        admitted: Vec::new(),
    }
}

/// Open a socket with these headers, send `hello` as its first frame, and
/// say what the relay answered: a welcome or an error.
pub async fn knock(addr: SocketAddr, headers: &[(&str, &str)], hello: &[u8]) -> Control {
    let mut request = format!("ws://{addr}/ws").into_client_request().unwrap();
    for (k, v) in headers {
        request.headers_mut().insert(
            axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            v.parse().unwrap(),
        );
    }
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket
        .send(Message::Binary(hello.to_vec().into()))
        .await
        .unwrap();
    let wait = std::time::Duration::from_secs(10);
    loop {
        match tokio::time::timeout(wait, socket.next()).await {
            Ok(Some(Ok(Message::Binary(bytes)))) => {
                let frame = Frame::decode(&bytes).unwrap();
                if frame.channel == Channel::Control {
                    return frame.parse_json().unwrap();
                }
            }
            Ok(Some(Ok(_))) => continue,
            other => panic!("the relay answered the hello with {other:?}"),
        }
    }
}

pub fn encoded(hello: &Control) -> Vec<u8> {
    Frame::json(Channel::Control, TARGET_ALL, hello)
        .unwrap()
        .encode()
}

fn refused_with(answer: &Control) -> Option<&str> {
    match answer {
        Control::Error { code, .. } => Some(code),
        _ => None,
    }
}

fn welcomed(answer: &Control) -> bool {
    matches!(answer, Control::Welcome { .. })
}

// ------------------------------------------------- B01: lookups fail closed

#[tokio::test]
async fn a_broken_accounts_database_opens_no_pad_to_anyone() {
    // Audit B01: an SQL error in the ownership lookup was read as "no row",
    // which is an anonymous pad — editable by everyone. A private pad's file
    // was then served, and written, to a stranger.
    let relay = Relay::new("");
    let (owner, _) = relay.signed_in("1");
    let pad = relay.owned_pad(owner, View::Owner, Edit::Owner);
    let path = format!("/api/pad/{}", pad.name);
    assert_eq!(
        relay.call(get(&path, &[])).await.status,
        StatusCode::FORBIDDEN
    );

    relay.break_accounts();

    let read = relay.call(get(&path, &[])).await;
    assert_eq!(
        read.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        read.body
    );
    assert!(!read.body.contains("the owner's words"), "{}", read.body);
    let written = relay
        .call(write(
            &pad.name,
            &[],
            serde_json::json!([{ "path": "secret.txt", "content": "a stranger's" }]),
        ))
        .await;
    assert_eq!(written.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        relay.state.pads.get(&pad.name).unwrap().unwrap().files["secret.txt"].content,
        "the owner's words",
        "a write landed on a lookup that failed"
    );
    for route in ["history", "run"] {
        let answer = relay.call(get(&format!("{path}/{route}"), &[])).await;
        assert_eq!(answer.status, StatusCode::SERVICE_UNAVAILABLE, "{route}");
    }
    let kept = relay
        .call(request(
            "POST",
            &format!("{path}/history"),
            &[],
            Body::empty(),
        ))
        .await;
    assert_eq!(kept.status, StatusCode::SERVICE_UNAVAILABLE);
    // A preview card says nothing of it either.
    let card = relay
        .call(get(&format!("/api/unfurl/{}", pad.name), &[]))
        .await;
    assert!(!card.body.contains("secret.txt"), "{}", card.body);

    // And its room lets nobody in.
    let addr = relay.serve().await;
    let answer = knock(addr, &[], &encoded(&peer_hello(&pad.name))).await;
    assert_eq!(refused_with(&answer), Some("unavailable"), "{answer:?}");
}

// ---------------------------------- B02: a cookie counts only from our pages

#[tokio::test]
async fn a_socket_from_another_page_is_not_its_owner() {
    // Audit B02: the preview origin is the same site as the pad, so a page
    // running there could open a socket to the pad with the owner's cookie
    // and be let into a private pad's room as its owner.
    let origin = "http://127.0.0.1:5214";
    let relay = Relay::new(origin);
    let (owner, cookie) = relay.signed_in("1");
    let pad = relay.owned_pad(owner, View::Owner, Edit::Owner);
    let addr = relay.serve().await;
    let hello = encoded(&peer_hello(&pad.name));

    let ours = knock(addr, &[("cookie", &cookie), ("origin", origin)], &hello).await;
    assert!(welcomed(&ours), "the owner's own page: {ours:?}");
    let program = knock(addr, &[("cookie", &cookie)], &hello).await;
    assert!(
        welcomed(&program),
        "no Origin is a program, not a page: {program:?}"
    );
    for foreign in [
        "https://preview.rishwanth.dev",
        "null",
        "http://127.0.0.1:5215",
    ] {
        let theirs = knock(addr, &[("cookie", &cookie), ("origin", foreign)], &hello).await;
        assert_eq!(
            refused_with(&theirs),
            Some("private"),
            "a socket from {foreign} was let in on the owner's cookie: {theirs:?}"
        );
    }
    // Not refused for coming from elsewhere: answered as anyone would be.
    relay
        .state
        .accounts
        .change_access(owner, &pad.name, Some(View::Link), Some(Edit::Owner))
        .unwrap();
    let anyone = knock(
        addr,
        &[
            ("cookie", &cookie),
            ("origin", "https://preview.rishwanth.dev"),
        ],
        &hello,
    )
    .await;
    assert!(welcomed(&anyone), "a pad anyone may view: {anyone:?}");
}

#[tokio::test]
async fn without_a_public_origin_a_cookie_counts_as_it_always_has() {
    let relay = Relay::new("");
    let (owner, cookie) = relay.signed_in("1");
    let pad = relay.owned_pad(owner, View::Owner, Edit::Owner);
    let addr = relay.serve().await;
    let answer = knock(
        addr,
        &[("cookie", &cookie), ("origin", "http://localhost:5175")],
        &encoded(&peer_hello(&pad.name)),
    )
    .await;
    assert!(welcomed(&answer), "{answer:?}");
}

#[tokio::test]
async fn a_request_from_another_page_is_answered_as_nobody() {
    // The HTTP side of B02. A PUT from another origin is stopped by the
    // browser's preflight; keeping a version is a POST with no body, which
    // is not, and same-site pages bring the cookie with it.
    let origin = "https://code.rishwanth.dev";
    let relay = Relay::new(origin);
    let (owner, cookie) = relay.signed_in("1");
    let pad = relay.owned_pad(owner, View::Owner, Edit::Owner);
    let path = format!("/api/pad/{}", pad.name);
    let ours: &[(&str, &str)] = &[("cookie", &cookie), ("origin", origin)];
    let preview: &[(&str, &str)] = &[
        ("cookie", &cookie),
        ("origin", "https://preview.rishwanth.dev"),
        ("sec-fetch-site", "same-site"),
    ];

    let read = relay.call(get(&path, &[("cookie", &cookie)])).await;
    assert_eq!(
        read.status,
        StatusCode::OK,
        "a same-origin read sends no Origin"
    );
    assert_eq!(read.json()["access"]["role"], "owner");
    for (method, route) in [("POST", "/history"), ("GET", "/history"), ("GET", "")] {
        let from_preview = relay
            .call(request(
                method,
                &format!("{path}{route}"),
                preview,
                Body::empty(),
            ))
            .await;
        assert_eq!(
            from_preview.status,
            StatusCode::FORBIDDEN,
            "{method} {route} from the preview origin"
        );
        let from_ours = relay
            .call(request(
                method,
                &format!("{path}{route}"),
                ours,
                Body::empty(),
            ))
            .await;
        assert!(
            from_ours.status.is_success(),
            "{method} {route}: {}",
            from_ours.body
        );
    }
    // A browser that hides our own Origin as `null` still says same-origin.
    let hidden = relay
        .call(request(
            "POST",
            &format!("{path}/history"),
            &[
                ("cookie", &cookie),
                ("origin", "null"),
                ("sec-fetch-site", "same-origin"),
            ],
            Body::empty(),
        ))
        .await;
    assert!(hidden.status.is_success(), "{}", hidden.body);
    let me = relay.call(get("/api/me", preview)).await;
    assert_eq!(me.json()["user"], serde_json::Value::Null);
}
