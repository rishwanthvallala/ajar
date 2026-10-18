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
use axum::http::{header, HeaderMap, Request, StatusCode};
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
    pub headers: HeaderMap,
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
            receiving: Arc::new(tokio::sync::Semaphore::new(crate::PAD_BODY_BUDGET)),
            body_idle: crate::BODY_IDLE,
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
    pub async fn call(&self, request: Request<Body>) -> Answer {
        self.call_with(None, request).await
    }

    /// The same, with the web client's files served from `web`.
    pub async fn call_with(&self, web: Option<&str>, mut request: Request<Body>) -> Answer {
        request.extensions_mut().insert(ConnectInfo(CALLER));
        let response = crate::router(self.state.clone(), web)
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        Answer {
            status,
            headers,
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

// ------------------------------------------------ CORS, and /api/ answering

#[tokio::test]
async fn no_other_site_is_told_it_may_call_the_api() {
    // Every page that calls the API is served from the origin it calls, so
    // nothing here says any other may — `CorsLayer::permissive()` said every
    // site might read every answer and send any header it liked.
    let relay = Relay::new("https://code.rishwanth.dev");
    let preflight = relay
        .call(request(
            "OPTIONS",
            "/api/pad/some-pad",
            &[
                ("origin", "https://evil.example"),
                ("access-control-request-method", "PUT"),
                ("access-control-request-headers", "content-type,x-pad-code"),
            ],
            Body::empty(),
        ))
        .await;
    let read = relay
        .call(get(
            "/api/pad/some-pad",
            &[("origin", "https://evil.example")],
        ))
        .await;
    assert_eq!(read.status, StatusCode::OK);
    for answer in [&preflight, &read] {
        for name in [
            "access-control-allow-origin",
            "access-control-allow-methods",
            "access-control-allow-headers",
        ] {
            assert!(
                !answer.headers.contains_key(name),
                "{name}: {:?}",
                answer.headers.get(name)
            );
        }
    }
}

#[tokio::test]
async fn a_path_under_api_that_names_nothing_is_not_found() {
    // It fell through to the web client and answered 200 with index.html,
    // which a script reads as success and a browser shows as a page.
    let relay = Relay::new("");
    let web = Dir::new();
    std::fs::write(web.0.join("index.html"), "<!doctype html>the page").unwrap();
    let web = web.0.to_str().unwrap().to_string();
    for path in [
        "/api",
        "/api/",
        "/api/nope",
        "/api/pad",
        "/api/pad/a/b/c",
        "/api/my/nothing",
    ] {
        let answer = relay.call_with(Some(&web), get(path, &[])).await;
        assert_eq!(
            answer.status,
            StatusCode::NOT_FOUND,
            "{path}: {}",
            answer.body
        );
        assert!(!answer.body.contains("the page"), "{path}");
        assert!(
            answer.headers[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("text/plain"),
            "{path}: {:?}",
            answer.headers.get(header::CONTENT_TYPE)
        );
    }
    // Routes that are there still answer, and a page is still the page.
    let me = relay.call_with(Some(&web), get("/api/me", &[])).await;
    assert_eq!(me.status, StatusCode::OK);
    let page = relay
        .call_with(Some(&web), get("/amber-falcon-river", &[]))
        .await;
    assert_eq!(
        (page.status, page.body.as_str()),
        (StatusCode::OK, "<!doctype html>the page")
    );
}

// ---------------------------------------- B03 and B11: versions and lapsing

#[tokio::test]
async fn a_version_is_read_within_the_bounds_on_reads() {
    // Audit B03: a version was built whole in memory and sent with no read
    // slot and no permit, so nothing bounded how many went out at once.
    let relay = Relay::new("");
    let pads = &relay.state.pads;
    pads.write("p", &[put("a.txt", "first \"one\"\n")]).unwrap();
    let id = pads.keep_now("p").unwrap().unwrap();
    pads.write("p", &[put("a.txt", "second")]).unwrap();
    let path = format!("/api/pad/p/history/{id}");

    let answer = relay.call(get(&path, &[])).await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.body);
    assert_eq!(answer.json()["id"], id);
    assert_eq!(
        answer.json()["files"]["a.txt"]["content"],
        "first \"one\"\n"
    );
    assert_eq!(answer.json()["files"]["a.txt"]["encoding"], "utf8");
    assert_eq!(
        answer.headers[header::CONTENT_LENGTH],
        answer.body.len().to_string()
    );

    // Every read slot this address has, held by reads still being sent.
    let slots: Vec<_> = (0..crate::quota::MAX_READS_PER_IP)
        .map(|_| {
            relay
                .state
                .quota
                .claim(
                    CALLER.ip(),
                    std::time::Instant::now(),
                    crate::quota::Kind::Read,
                )
                .unwrap()
        })
        .collect();
    let refused = relay.call(get(&path, &[])).await;
    assert_eq!(
        refused.status,
        StatusCode::TOO_MANY_REQUESTS,
        "a version was read past the address's read slots"
    );
    drop(slots);

    // And every one of the relay's permits: it waits its turn.
    let permits = relay
        .state
        .reading
        .clone()
        .acquire_many_owned(crate::MAX_CONCURRENT_PAD_READS as u32)
        .await
        .unwrap();
    let waiting = tokio::spawn({
        let state = relay.state.clone();
        let path = path.clone();
        async move {
            let mut request = get(&path, &[]);
            request.extensions_mut().insert(ConnectInfo(CALLER));
            crate::router(state, None)
                .oneshot(request)
                .await
                .unwrap()
                .status()
        }
    });
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(
        !waiting.is_finished(),
        "a version was read with no permit free"
    );
    drop(permits);
    assert_eq!(waiting.await.unwrap(), StatusCode::OK);
}

#[tokio::test]
async fn a_lapsed_pad_shows_nothing_of_itself() {
    // Audit B11, as a page asks: a lapsed pad reads as free, and so do its
    // history, its versions and its last run, until the sweep removes them.
    let relay = Relay::new("");
    let pads = &relay.state.pads;
    pads.write("p", &[put("a.txt", "the old owner's")]).unwrap();
    let id = pads.keep_now("p").unwrap().unwrap();
    pads.set_last_run(
        "p",
        &crate::pad::LastRun {
            path: "a.txt".into(),
            command: "cat a.txt".into(),
            exit: 0,
            at_ms: 0,
            output: "the old owner's output".into(),
        },
    )
    .unwrap();
    pads.set_touched("p", crate::pad::LEASE + std::time::Duration::from_secs(60));

    let read = relay.call(get("/api/pad/p", &[])).await;
    assert_eq!(read.json()["exists"], false);
    let history = relay.call(get("/api/pad/p/history", &[])).await;
    assert_eq!(history.json(), serde_json::json!([]));
    let version = relay
        .call(get(&format!("/api/pad/p/history/{id}"), &[]))
        .await;
    assert_eq!(version.status, StatusCode::NOT_FOUND, "{}", version.body);
    let run = relay.call(get("/api/pad/p/run", &[])).await;
    assert_eq!(run.status, StatusCode::NO_CONTENT, "{}", run.body);
    let kept = relay
        .call(request("POST", "/api/pad/p/history", &[], Body::empty()))
        .await;
    assert_eq!(kept.json()["id"], serde_json::Value::Null);
}

// ------------------------------------------------------------- the hello

#[tokio::test]
async fn a_hello_too_big_to_be_one_is_refused_unread() {
    // The first frame was bounded only by the 32 MiB any frame may be, and
    // parsed before the quota had seen the connection.
    let relay = Relay::new("");
    let addr = relay.serve().await;
    let mut big = peer_hello("open-pad");
    if let Control::Hello { code, .. } = &mut big {
        *code = Some("x".repeat(300 * 1024));
    }
    let answer = knock(addr, &[], &encoded(&big)).await;
    assert_eq!(refused_with(&answer), Some("hello_too_big"), "{answer:?}");

    // The biggest a real one gets: a host vouching for more guests than the
    // relay will remember, three times over.
    let hash = |i: usize| format!("{i:064x}");
    let host = Control::Hello {
        session: "quiet-ember-1234".into(),
        role: Role::Host,
        locked: false,
        protocol: ajar_proto::PROTOCOL_VERSION,
        code: None,
        host_key: Some(hash(0)),
        resume: None,
        admitted: (0..3 * crate::session::MAX_ADMITTED).map(hash).collect(),
    };
    let answer = knock(addr, &[], &encoded(&host)).await;
    assert!(welcomed(&answer), "{answer:?}");
    // And an ordinary one, of course.
    let answer = knock(addr, &[], &encoded(&peer_hello("open-pad"))).await;
    assert!(welcomed(&answer), "{answer:?}");
}

// ------------------------------------------------------------------ links

#[tokio::test]
async fn a_link_is_for_viewing_or_editing_and_nothing_else() {
    // Asked for an owner link, or a link to nothing, the API minted a view
    // link and said it had made what was asked.
    let relay = Relay::new("");
    let (owner, cookie) = relay.signed_in("1");
    let pad = relay.owned_pad(owner, View::Code, Edit::Code);
    let before = relay
        .state
        .accounts
        .pad_of(owner, &pad.name)
        .unwrap()
        .links
        .len();
    let links = format!("/api/my/pads/{}/links", pad.name);
    let ask = |role: &str, replace: bool| {
        request(
            "POST",
            &links,
            &[
                ("cookie", &cookie),
                ("x-ajar", "1"),
                ("content-type", "application/json"),
            ],
            Body::from(serde_json::json!({ "role": role, "replace": replace }).to_string()),
        )
    };
    for role in ["owner", "none"] {
        for replace in [false, true] {
            let answer = relay.call(ask(role, replace)).await;
            assert_eq!(
                answer.status,
                StatusCode::BAD_REQUEST,
                "{role} (replace: {replace}): {}",
                answer.body
            );
        }
    }
    assert_eq!(
        relay
            .state
            .accounts
            .pad_of(owner, &pad.name)
            .unwrap()
            .links
            .len(),
        before,
        "a link was made, or one revoked, all the same"
    );
    for role in ["viewer", "editor"] {
        let answer = relay.call(ask(role, false)).await;
        assert_eq!(
            answer.status,
            StatusCode::CREATED,
            "{role}: {}",
            answer.body
        );
        assert_eq!(answer.json()["role"], role);
    }
}

// ------------------------------------------------------- what a write holds

#[tokio::test]
async fn a_write_refused_for_one_file_says_which() {
    let relay = Relay::new("");
    for (writes, named) in [
        (
            serde_json::json!([{ "path": "ok.txt", "content": "x" }, { "path": "a\tb.txt", "content": "x" }]),
            r#""a\tb.txt""#,
        ),
        (
            serde_json::json!([{ "path": "logo.png", "content": "not base64!", "encoding": "base64" }]),
            r#""logo.png""#,
        ),
        (
            serde_json::json!([{ "path": ".ajar/site/sitecustomize.py", "content": "import os" }]),
            r#"".ajar/site/sitecustomize.py""#,
        ),
    ] {
        let answer = relay.call(write("p", &[], writes)).await;
        assert_eq!(answer.status, StatusCode::BAD_REQUEST, "{}", answer.body);
        assert!(
            answer.body.contains(named),
            "{named} is not named: {}",
            answer.body
        );
    }
    assert!(
        relay.state.pads.get("p").unwrap().is_none(),
        "part of a refused write was stored"
    );
}

// ------------------------------------ B04: a body that stops holds up nobody

/// A body that sends `sent` and then nothing, for ever: a client that
/// stopped part-way through an upload.
fn stalled(sent: &str) -> Body {
    let sent = axum::body::Bytes::from(sent.to_string());
    Body::from_stream(
        futures_util::stream::once(async move { Ok::<_, std::io::Error>(sent) })
            .chain(futures_util::stream::pending()),
    )
}

/// `request` through the router in a task of its own, as from [`CALLER`]:
/// the status it is answered with, whenever that is.
fn send(relay: &Relay, mut request: Request<Body>) -> tokio::task::JoinHandle<StatusCode> {
    request.extensions_mut().insert(ConnectInfo(CALLER));
    let router = crate::router(relay.state.clone(), None);
    tokio::spawn(async move { router.oneshot(request).await.unwrap().status() })
}

#[tokio::test]
async fn uploads_that_stop_part_way_hold_up_no_save() {
    // Audit B04: a write took one of the two write permits before reading
    // its body, and held it while the body arrived. Two uploads that sent
    // their headers and part of a body held both, for as long as they liked,
    // and every save behind them waited.
    let mut relay = Relay::new("");
    relay.state.body_idle = std::time::Duration::from_millis(800);
    let json = ("content-type", "application/json");
    let stopped: Vec<_> = (0..crate::MAX_CONCURRENT_PAD_WRITES + 2)
        .map(|i| {
            send(
                &relay,
                request(
                    "PUT",
                    &format!("/api/pad/upload-{i}"),
                    &[json, ("content-length", "1000000")],
                    stalled(r#"{"writes":[{"path":"big.txt","content":"xxxx"#),
                ),
            )
        })
        .collect();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(stopped.iter().all(|upload| !upload.is_finished()));

    // Answered while they are still stuck, well inside the time they have.
    let saved = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        relay.call(write(
            "p",
            &[],
            serde_json::json!([{ "path": "a.txt", "content": "hello" }]),
        )),
    )
    .await
    .expect("a save waited behind uploads that had stopped");
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.body);

    // They are told, and let go of everything they held.
    for upload in stopped {
        let status = tokio::time::timeout(std::time::Duration::from_secs(10), upload)
            .await
            .expect("an upload that stopped was never cut off")
            .unwrap();
        assert_eq!(status, StatusCode::REQUEST_TIMEOUT);
    }
    assert_eq!(
        relay.state.receiving.available_permits(),
        crate::PAD_BODY_BUDGET
    );
    assert_eq!(
        relay.state.writing.available_permits(),
        crate::MAX_CONCURRENT_PAD_WRITES
    );
    assert!(relay.state.pads.get("upload-0").unwrap().is_none());

    // A kept run is read the same way.
    let run = send(
        &relay,
        request(
            "PUT",
            "/api/pad/p/run",
            &[json, ("content-length", "5000")],
            stalled(r#"{"path":"a.txt","command":"cat a.txt","exit":0,"output":"hel"#),
        ),
    );
    let status = tokio::time::timeout(std::time::Duration::from_secs(10), run)
        .await
        .expect("a kept run that stopped was never cut off")
        .unwrap();
    assert_eq!(status, StatusCode::REQUEST_TIMEOUT);

    // And a body that says it is too big is refused before any of it is
    // read, not waited for.
    let declared = (crate::MAX_PAD_HTTP_BODY + 1).to_string();
    let huge = send(
        &relay,
        request(
            "PUT",
            "/api/pad/p",
            &[json, ("content-length", &declared)],
            stalled("{"),
        ),
    );
    let status = tokio::time::timeout(std::time::Duration::from_millis(500), huge)
        .await
        .expect("a body declared too big was read anyway")
        .unwrap();
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn a_write_body_is_still_refused_as_json_was() {
    // Read by hand now rather than by axum's `Json`, so what it said about
    // a body that is not JSON, or not ours, is checked here.
    let relay = Relay::new("");
    let plain = relay
        .call(request(
            "PUT",
            "/api/pad/p",
            &[("content-type", "text/plain")],
            Body::from(r#"{"writes":[]}"#),
        ))
        .await;
    assert_eq!(plain.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let json = ("content-type", "application/json; charset=utf-8");
    for (body, status) in [
        ("{not json", StatusCode::BAD_REQUEST),
        (r#"{"writes":"no"}"#, StatusCode::UNPROCESSABLE_ENTITY),
        (
            r#"{"writes":[{"path":"a.txt","content":"x"}]}"#,
            StatusCode::OK,
        ),
    ] {
        let answer = relay
            .call(request("PUT", "/api/pad/p", &[json], Body::from(body)))
            .await;
        assert_eq!(answer.status, status, "{body}: {}", answer.body);
    }
    // Arriving in many pieces is the same body.
    let pieces = futures_util::stream::iter(
        [
            r#"{"writes":[{"pa"#,
            r#"th":"b.txt","con"#,
            r#"tent":"y"}]}"#,
        ]
        .map(|p| Ok::<_, std::io::Error>(axum::body::Bytes::from(p))),
    );
    let answer = relay
        .call(request(
            "PUT",
            "/api/pad/p",
            &[json],
            Body::from_stream(pieces),
        ))
        .await;
    assert_eq!(answer.status, StatusCode::OK, "{}", answer.body);
    assert_eq!(
        relay.state.pads.get("p").unwrap().unwrap().files["b.txt"].content,
        "y"
    );
}

// --------------------------------- B10: how much one request may ask for

#[tokio::test]
async fn a_save_of_more_changes_than_one_may_make_is_refused() {
    // Audit B10: nothing bounded how many changes one request made but its
    // 33 MiB body, and each was compared with every one after it while the
    // write held a permit: 8,000 deletions of files that did not exist took
    // one and a half seconds, and these 200,000 would have taken a quarter
    // of an hour.
    let relay = Relay::new("");
    let deletions = |n: usize| {
        serde_json::Value::Array(
            (0..n)
                .map(|i| serde_json::json!({ "path": format!("gone/{i}.txt") }))
                .collect(),
        )
    };
    let answer = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        relay.call(write("p", &[], deletions(200_000))),
    )
    .await
    .expect("200,000 changes in one request were worked through");
    assert_eq!(
        answer.status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "{}",
        answer.body
    );
    assert!(
        answer.body.contains(&crate::pad::MAX_WRITES.to_string()),
        "{}",
        answer.body
    );
    // The most one may make is taken.
    let most = relay
        .call(write("p", &[], deletions(crate::pad::MAX_WRITES)))
        .await;
    assert_eq!(most.status, StatusCode::OK, "{}", most.body);

    // So many edits to one file, or to a request's files together.
    let edits = |n: usize| {
        serde_json::Value::Array(
            (0..n)
                .map(|i| serde_json::json!({ "at": i, "remove": 0, "insert": "" }))
                .collect(),
        )
    };
    let base = "0".repeat(64);
    let one = relay
        .call(write(
            "p",
            &[],
            serde_json::json!([{
                "path": "a.txt", "content": null, "base": base,
                "edits": edits(crate::pad::MAX_EDITS + 1),
            }]),
        ))
        .await;
    assert_eq!(one.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", one.body);
    assert!(one.body.contains("edits"), "{}", one.body);
    let files = serde_json::Value::Array(
        (0..crate::pad::MAX_EDITS_PER_REQUEST / crate::pad::MAX_EDITS + 1)
            .map(|f| {
                serde_json::json!({
                    "path": format!("f{f}.txt"), "content": null, "base": base,
                    "edits": edits(crate::pad::MAX_EDITS),
                })
            })
            .collect(),
    );
    let all = relay.call(write("p", &[], files)).await;
    assert_eq!(all.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", all.body);
}
