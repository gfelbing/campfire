//! Auth loop regression (issues.md "infinite redirects on login"): the
//! browser's steps — probe → `/auth/login` → IdP → `/auth/callback` →
//! probe with the cookie — driven end-to-end against the real server
//! (HTTP/3) and a loopback mock IdP (plain HTTP/1.1):
//!
//! - the full happy path mints the session cookie and the probe then
//!   returns the forced name;
//! - an issuer configured with a trailing slash still verifies `iss`
//!   (regression: discovery trimmed the slash, `iss` validation did not);
//! - a failed callback answers the 200 error page, **not** a 302 to `/`
//!   (the silent 302 was the unbreakable redirect loop).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Buf;
use http::header;
use rustls::pki_types::CertificateDer;

mod common;
use common::start_server_with_auth;

const CLIENT_ID: &str = "campfire-test";

// The same fixed keypair the unit tests in `auth.rs` sign with (test-only;
// production only verifies). The JWKS serves the public numbers under kid
// `k1`, matching the JOSE header.
const TEST_KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCXwpVRtgRHgope
JMvU89S807/lX2CRl41Gi3u2FLvUtSfM8PseK5FWcCweNEzBm7bO4Ea9EFw3PiyC
Y0FVVCX7vQwMisteGBN0zJZhxpEpXwvk1Ep9EIOBShI2Y+kVlA60+8r5cPehDWtR
NvaWF9VJq8WxDBO+EeaZmwTYR+wfLeQnbUgNH+56DgTxmUm6J10HO4nkB7WbNadJ
603M5flk3dDVjN4xiEENUXnqq6FsAtOTPH4jUioznBStcmuk0sayQ0LLhjaZFMkw
PvKXWUxFo/9W7sVIOBtnwg1uAlh22Q5AOS8nKDtCs0mu+LtAN0k4fkP7UoNRMXlB
EjeZ4v83AgMBAAECggEAB6ErhJ1T/1koWUdPgBGqHLwm8s8l7OvjmSvvnxEElTlu
TZ1bFc8267n3KqWSd+e6+9351tnfT1+u0sQbesC6Q1R9XWJ08VjghLsfkr064XH7
CEwSWp53HgutRexYwYVdOYTj7w2nRWkfsuH1thU723JPtz28mFrdO9SEgwl903gu
70o7jh6AFlpk0z7iJB9TlMrz2MvZvgNvILwAv0/LRVZu/YrKIeyVJLz1jJPUtNRQ
v7Z+eWKbgO68mkiSo++c05IPMGCGF1OhzrQqOmwBjD8fmawkosYxJKnm1dV87P5S
N6ejWuqjalDo8s8u63cOVE0VuMmOMSxHdT7KbvMNAQKBgQDL6Il5izimO0fXzqfM
CYkPciMZlsB5UZX629X2hmry+AdKC8Hk8ZD8LHQRvribtsvowJ93K7oY8XWuhr41
ccUj5nwANgnJzY73tGHpnGx3y8anGWfNxX7ODqMZUwyLYJQ35slh1sETPrOjZRO/
fWiWF2P75CbeqzAXLRzKyUgHwQKBgQC+h5Y6srmEeQKohKXsORESHlTGqNx/nan3
IaowUvak70z5qL3aNVfnoZRZKlG23t/loVlyQyA4BNfN+E3zhqMJc8FTvKMdBrAn
RINsW3BsB7B6ZZPHVCJDZf/xu5V1X/w8OqX86l7FK+kE0pIlqujKjQY70vn+4I2g
Pg1BumSE9wKBgQCr9gaCByQWJGY5HGGsE9qPuRzaxqS5a1GFhoHR7pghIYTcMEAr
eIFh+YdFM8dyIl2ig1e4Y5sE0BUDw0SDw9eSqByo/OmSU5WfVnNAVRewi5yTbTx6
b3S6B+QKRlyM6jz1S99HcJnRRg6u3F4kHnnmIgHC+yzAmjPrR7NBXTAuwQKBgB2u
vebTJTfQKmvajobotRIfi5GPiRqQk4QeyIbSxf4YEePrN/igytsZPyVNBIH64uLB
ak/0yTYw+vXpsys3VHsKf5nuD3NcMWFMuTTOYgtSf1nyLT2mi9f4MhGU6cnpdEBl
2qo2USFin+DSdVZM9AtqQQhc6/mbPjUytZoB0dstAoGAC/dThPH8yQedJUdUR0ct
74rssyEYjUh/vWPZjwobOtiyKY/hNFWXTCnhoJy4IGYcBVZ/gKauZBzmm0ys9Q4L
m06WQFIIN0lN9hokdsX0++mbagUGylr9SVFzFBIIgwBEflh2/oVaD2+PkN+T/Egm
4zACe+f5T5Kfotn606BKVhg=
-----END PRIVATE KEY-----";
const TEST_JWK: &str = "{\"kty\": \"RSA\", \"alg\": \"RS256\", \"kid\": \"k1\", \"n\": \"l8KVUbYER4KKXiTL1PPUvNO_5V9gkZeNRot7thS71LUnzPD7HiuRVnAsHjRMwZu2zuBGvRBcNz4sgmNBVVQl-70MDIrLXhgTdMyWYcaRKV8L5NRKfRCDgUoSNmPpFZQOtPvK-XD3oQ1rUTb2lhfVSavFsQwTvhHmmZsE2EfsHy3kJ21IDR_ueg4E8ZlJuiddBzuJ5Ae1mzWnSetNzOX5ZN3Q1YzeMYhBDVF56quhbALTkzx-I1IqM5wUrXJrpNLGskNCy4Y2mRTJMD7yl1lMRaP_Vu7FSDgbZ8INbgJYdtkOQDkvJyg7QrNJrvi7QDdJOH5D-1KDUTF5QRI3meL_Nw\", \"e\": \"AQAB\"}";

// --- the mock IdP (plain HTTP/1.1 on loopback) ----------------------------

/// Code → the `nonce` it was minted with (the token endpoint stamps it
/// into the `id_token`).
type CodeMap = HashMap<String, String>;

#[derive(Clone)]
struct Idp {
    /// Canonical issuer (no trailing slash) — what tokens carry as `iss`.
    issuer: String,
    client_id: String,
    codes: Arc<std::sync::Mutex<CodeMap>>,
}

async fn idp_discovery(idp: axum::extract::State<Idp>) -> axum::Json<serde_json::Value> {
    let base = idp.issuer.trim_end_matches('/');
    axum::Json(serde_json::json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/authorize"),
        "token_endpoint": format!("{base}/token"),
        "jwks_uri": format!("{base}/jwks"),
    }))
}

#[derive(serde::Deserialize)]
struct AuthorizeQuery {
    state: String,
    nonce: String,
    redirect_uri: String,
}

/// The IdP "approves" instantly: mint a code bound to the `nonce` and 302
/// back to the registered redirect URI.
async fn idp_authorize(
    idp: axum::extract::State<Idp>,
    q: axum::extract::Query<AuthorizeQuery>,
) -> (http::StatusCode, [(header::HeaderName, String); 1]) {
    let code = format!("code-{}", rand::random::<u128>());
    idp.codes
        .lock()
        .unwrap()
        .insert(code.clone(), q.nonce.clone());
    (
        http::StatusCode::FOUND,
        [(
            header::LOCATION,
            format!("{}?code={code}&state={}", q.redirect_uri, q.state),
        )],
    )
}

async fn idp_jwks() -> axum::Json<serde_json::Value> {
    axum::Json(
        serde_json::json!({ "keys": [serde_json::from_str::<serde_json::Value>(TEST_JWK).unwrap()] }),
    )
}

#[derive(serde::Deserialize)]
struct TokenForm {
    code: String,
}

/// Exchange the code for an `id_token` signed with the test key. Unknown
/// code → 400 (the token endpoint's way of failing the callback).
async fn idp_token(
    idp: axum::extract::State<Idp>,
    form: axum::extract::Form<TokenForm>,
) -> Result<axum::Json<serde_json::Value>, (http::StatusCode, String)> {
    let nonce = idp
        .codes
        .lock()
        .unwrap()
        .remove(&form.code)
        .ok_or_else(|| (http::StatusCode::BAD_REQUEST, "invalid_grant".to_owned()))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    #[derive(serde::Serialize)]
    struct Claims<'a> {
        sub: &'a str,
        iss: &'a str,
        exp: i64,
        aud: &'a str,
        nonce: &'a str,
        name: &'a str,
    }
    let claims = Claims {
        sub: "u-123",
        iss: idp.issuer.trim_end_matches('/'),
        exp: now + 300,
        aud: idp.client_id.as_str(),
        nonce: nonce.as_str(),
        name: "Ada Lovelace",
    };
    let h = jsonwebtoken::Header {
        kid: Some("k1".to_owned()),
        alg: jsonwebtoken::Algorithm::RS256,
        ..Default::default()
    };
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(TEST_KEY_PEM.as_bytes()).unwrap();
    let id_token = jsonwebtoken::encode(&h, &claims, &key).unwrap();
    Ok(axum::Json(serde_json::json!({ "id_token": id_token })))
}

/// Start the mock IdP on an ephemeral loopback port. Returns the address
/// and the canonical issuer (`http://{addr}`, no trailing slash).
async fn start_idp() -> (SocketAddr, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let idp = Idp {
        issuer: format!("http://{addr}"),
        client_id: CLIENT_ID.to_owned(),
        codes: Arc::new(std::sync::Mutex::new(HashMap::new())),
    };
    let app = axum::Router::new()
        .route(
            "/.well-known/openid-configuration",
            axum::routing::get(idp_discovery),
        )
        .route("/authorize", axum::routing::get(idp_authorize))
        .route("/jwks", axum::routing::get(idp_jwks))
        .route("/token", axum::routing::post(idp_token))
        .with_state(idp);
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    (addr, format!("http://{addr}"))
}

// --- an h3 client that carries headers -------------------------------------

/// One HTTP/3 GET against the server (real QUIC, verified against the rcgen
/// root), with optional request headers. Returns status, headers and body.
async fn get3(
    addr: SocketAddr,
    root: &CertificateDer<'static>,
    uri: &str,
    headers: &[(&str, &str)],
) -> (u16, http::HeaderMap, String) {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(root.clone()).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut client_conf = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_root_certificates(Arc::new(roots))
        .with_no_client_auth();
    client_conf.alpn_protocols = vec![b"h3".to_vec()];

    let crypto = quinn::crypto::rustls::QuicClientConfig::try_from(client_conf).unwrap();
    let qconf = quinn::ClientConfig::new(Arc::new(crypto));
    let mut endpoint = quinn::Endpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
    endpoint.set_default_client_config(qconf);

    let conn = endpoint.connect(addr, "localhost").unwrap().await.unwrap();
    let (h3_conn, mut send_req) = h3::client::builder()
        .build::<_, _, bytes::Bytes>(h3_quinn::Connection::new(conn))
        .await
        .unwrap();
    let mut builder = http::Request::builder().uri(format!("https://localhost{uri}"));
    for (k, v) in headers {
        builder = builder.header(*k, *v);
    }
    let mut res = send_req
        .send_request(builder.body(()).unwrap())
        .await
        .unwrap();
    res.finish().await.unwrap(); // no request body
    let response = res.recv_response().await.unwrap();
    let status = response.status().as_u16();
    let resp_headers = response.headers().clone();
    let mut body = Vec::new();
    while let Some(chunk) = res.recv_data().await.unwrap() {
        body.extend_from_slice(chunk.chunk());
    }
    drop(h3_conn); // keep the connection alive while the body is read
    (
        status,
        resp_headers,
        String::from_utf8_lossy(&body).into_owned(),
    )
}

// --- the server under test ---------------------------------------------------

/// Start the real server with OpenID Connect enabled against the given
/// issuer (the redirect URI is a placeholder: the mock IdP echoes it back
/// verbatim and neither side validates it against a network).
async fn start_auth_server(issuer: &str) -> (SocketAddr, CertificateDer<'static>) {
    let auth = campfire_server::auth::Auth::new(
        issuer.to_owned(),
        CLIENT_ID.to_owned(),
        "secret".to_owned(),
        "https://campfire.test/auth/callback".to_owned(),
    )
    .unwrap();
    let (addr, root, _world) = start_server_with_auth(Some(Arc::new(auth))).await;
    (addr, root)
}

/// A reqwest client that never follows redirects (a browser step driver).
fn idp_http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

/// The browser's steps: probe → `/auth/login` → IdP authorize → callback.
/// Returns the callback's (status, headers, body).
async fn drive_login(
    server: SocketAddr,
    root: &CertificateDer<'static>,
) -> (u16, http::HeaderMap, String) {
    let http = idp_http();

    // 1. Probe: auth on, no session yet.
    let (status, _, body) = get3(server, root, "/api/v1/auth", &[]).await;
    assert_eq!(status, 200, "probe body: {body}");
    let probe: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(probe["enabled"], true, "probe: {body}");
    assert!(probe.get("name").is_none(), "no session yet: {body}");

    // 2. `/auth/login` → 302 to the IdP's authorization endpoint.
    let (status, headers, _) = get3(server, root, "/auth/login?return_to=/room-x", &[]).await;
    assert_eq!(status, 302, "login should redirect to the IdP");
    let idp_url = headers
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();

    // 3. The IdP approves and 302s back to the callback with code + state.
    let idp_res = http.get(&idp_url).send().await.unwrap();
    assert_eq!(idp_res.status(), 302, "IdP should redirect to the callback");
    let cb_url = idp_res
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();

    // 4. The callback (over HTTP/3).
    let query = cb_url.split('?').nth(1).unwrap_or_default();
    get3(server, root, &format!("/auth/callback?{query}"), &[]).await
}

/// The `campfire_auth=…` fragment of the callback's `Set-Cookie`, or a
/// panic message when the cookie is missing.
fn cookie_from(headers: &http::HeaderMap) -> String {
    headers
        .get(header::SET_COOKIE)
        .unwrap_or_else(|| panic!("no Set-Cookie header"))
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

// --- the tests ---------------------------------------------------------------

#[tokio::test]
async fn full_login_mints_the_session_cookie() {
    let (_idp_addr, issuer) = start_idp().await;
    let (server, root) = start_auth_server(&issuer).await;

    let (status, headers, body) = drive_login(server, &root).await;
    assert_eq!(status, 302, "callback body: {body}");
    assert_eq!(
        headers.get(header::LOCATION).unwrap().to_str().unwrap(),
        "/room-x",
        "the callback must land back on the requested page"
    );
    let cookie = cookie_from(&headers);
    assert!(
        cookie.starts_with("campfire_auth=") && cookie.len() > "campfire_auth=".len(),
        "Set-Cookie: {cookie}"
    );

    // 5. Probe with the cookie: the forced name appears — the loop is broken.
    let (status, _, body) = get3(
        server,
        &root,
        "/api/v1/auth",
        &[(header::COOKIE.as_str(), &cookie)],
    )
    .await;
    assert_eq!(status, 200);
    let probe: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(probe["name"], "Ada Lovelace", "probe: {body}");
}

#[tokio::test]
async fn trailing_slash_issuer_still_verifies() {
    // Regression: `discovery()` trims the trailing slash, but `iss`
    // validation used the raw config — a slash-typed issuer failed against
    // every IdP that issues the canonical (slash-less) value.
    let (_idp_addr, issuer) = start_idp().await;
    let (server, root) = start_auth_server(&format!("{issuer}/")).await;

    let (status, headers, body) = drive_login(server, &root).await;
    assert_eq!(status, 302, "callback body: {body}");
    let cookie = cookie_from(&headers);
    assert!(
        cookie.starts_with("campfire_auth=") && cookie.len() > "campfire_auth=".len(),
        "Set-Cookie: {cookie}"
    );
}

#[tokio::test]
async fn failed_callback_shows_the_error_page() {
    let (_idp_addr, issuer) = start_idp().await;
    let (server, root) = start_auth_server(&issuer).await;

    // Start a login (to get a valid `state`), then present a forged code.
    let (status, headers, _) = get3(server, &root, "/auth/login?return_to=/", &[]).await;
    assert_eq!(status, 302, "login should redirect to the IdP");
    let idp_url = headers.get(header::LOCATION).unwrap().to_str().unwrap();
    let idp_res = idp_http().get(idp_url).send().await.unwrap();
    let cb_url = idp_res
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    let state = cb_url.rsplit_once("state=").unwrap().1;

    let (status, headers, body) = get3(
        server,
        &root,
        &format!("/auth/callback?code=bogus&state={state}"),
        &[],
    )
    .await;
    // The loop-breaker: a 200 error page, not a 302 to `/`.
    assert_eq!(status, 200, "body: {body}");
    assert!(body.contains("Sign-in failed"), "body: {body}");
    assert!(body.contains("Try again"), "body: {body}");
    assert!(
        headers.get(header::SET_COOKIE).is_none(),
        "a failed callback must not mint a cookie"
    );
    assert!(headers.get(header::LOCATION).is_none());
}
