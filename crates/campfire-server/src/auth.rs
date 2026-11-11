//! OpenID Connect authentication (README §11, authorization-code flow).
//!
//! When enabled, a visitor must sign in through the configured IdP before
//! they can join a room. The flow is the standard **authorization code**
//! flow for a confidential client (we hold the `client_secret`):
//!
//! 1. `GET /auth/login` — 302 to the IdP's authorization endpoint with a
//!    random `state` (CSRF) and `nonce` (replay binding), both stored in the
//!    pending map with a short TTL.
//! 2. The IdP sends the browser back to `GET /auth/callback?code&state`. We
//!    verify `state` (single-use), exchange the `code` for tokens at the
//!    token endpoint (POSTing the `client_secret`), and validate the
//!    returned `id_token`: signature against the issuer's JWKS, `iss`,
//!    `aud`, `exp` and `nonce`.
//! 3. The display name is taken from the `id_token` claims (this is the
//!    name **forced** onto the join — a client cannot choose its own). We
//!    mint a random httpOnly session cookie mapping to that identity and
//!    302 back to the page the visitor came from.
//!
//! Enforcement: with auth on, a `join` (WebTransport or the SSE fallback)
//! without a valid session cookie is refused, and a valid one overrides the
//! client-supplied name. Everything is in memory (single instance, README
//! §15); logs stay identity-free.
//!
//! The IdP's endpoints come from the issuer's
//! `/.well-known/openid-configuration` document; both it and the JWKS are
//! cached (the JWKS is refetched once when a token's `kid` is not present,
//! to ride key rotation).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::{DecodingKey, Validation};
use rand::RngCore;
use serde::Deserialize;

/// How long a `state` may live unclaimed (a browser that abandons the IdP
/// tab). Bounded together with [`PENDING_CAP`].
const PENDING_TTL: Duration = Duration::from_secs(300);
/// How long a session cookie stays valid. Kept under a day so a leaked
/// cookie is short-lived; the user simply re-authenticates on expiry.
pub const SESSION_TTL: Duration = Duration::from_secs(8 * 60 * 60);
/// Refetch the JWKS at least this often when a token's `kid` is unknown
/// (bounds the latency of a key rotation).
const JWKS_REFRESH: Duration = Duration::from_secs(5 * 60);
/// Maximum in-flight logins kept at once (bounds the pending map).
const PENDING_CAP: usize = 10_000;
/// Outbound HTTP timeout for discovery / JWKS / token exchange.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// The OIDC discovery document (the subset we use).
#[derive(Debug, Clone, Deserialize)]
struct Discovery {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
}

/// The token endpoint's response (we only read the `id_token`).
#[derive(Debug, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    id_token: Option<String>,
}

/// The `id_token` we validate (only the claims we read). `aud` may be a
/// string or an array per the spec, so it is kept raw and checked by hand.
#[derive(Debug, Deserialize)]
struct IdToken {
    sub: String,
    // Checked by `Validation` inside `jsonwebtoken::decode` (see
    // `verify_id_token`); the values themselves are never read, hence the
    // allow.
    #[allow(dead_code)]
    iss: String,
    #[allow(dead_code)]
    exp: u64,
    aud: serde_json::Value,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    preferred_username: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

/// One in-flight login: `state` → (expected `nonce`, page to return to).
#[derive(Debug, Clone)]
struct Pending {
    nonce: String,
    return_to: String,
    created: Instant,
}

/// A verified, signed-in identity, keyed by the session cookie value.
#[derive(Debug, Clone)]
pub struct AuthSession {
    /// The display name forced onto joins (from the `id_token` claims).
    pub name: String,
    /// The IdP subject identifier (held, never logged).
    pub sub: String,
    valid_until: Instant,
}

/// The verified identity a join is allowed to use.
#[derive(Debug, Clone)]
pub struct AuthIdentity {
    pub name: String,
}

/// The OIDC client + in-memory session store. Cloned as `Arc` into the API
/// state and the WebTransport handler.
#[derive(Clone)]
pub struct Auth {
    inner: Arc<Inner>,
}

struct Inner {
    issuer: String,
    client_id: String,
    client_secret: String,
    /// Absolute redirect URI registered with the IdP (`…/auth/callback`).
    redirect_uri: String,
    http: reqwest::Client,
    cache: Mutex<Cache>,
    pending: Mutex<HashMap<String, Pending>>,
    sessions: Mutex<HashMap<String, AuthSession>>,
}

#[derive(Default)]
struct Cache {
    discovery: Option<Discovery>,
    jwks: Option<(Instant, JwkSet)>,
}

impl Auth {
    /// Build the client. Errors when a required field is missing (fail fast
    /// at startup, not mid-handshake).
    pub fn new(
        issuer: String,
        client_id: String,
        client_secret: String,
        redirect_uri: String,
    ) -> anyhow::Result<Self> {
        if issuer.is_empty() {
            anyhow::bail!("auth: --auth-openid-issuer is required when auth is enabled");
        }
        if client_id.is_empty() {
            anyhow::bail!("auth: --auth-openid-client-id is required when auth is enabled");
        }
        if redirect_uri.is_empty() {
            anyhow::bail!("auth: --auth-openid-redirect-uri is required when auth is enabled");
        }
        let http = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build()?;
        Ok(Self {
            inner: Arc::new(Inner {
                issuer,
                client_id,
                client_secret,
                redirect_uri,
                http,
                cache: Mutex::new(Cache::default()),
                pending: Mutex::new(HashMap::new()),
                sessions: Mutex::new(HashMap::new()),
            }),
        })
    }

    // --- login initiation -------------------------------------------------

    /// Begin a login: mint `state` + `nonce`, store them, and return the IdP
    /// authorization URL to redirect the browser to.
    pub async fn start_login(&self, return_to: String) -> anyhow::Result<String> {
        let discovery = self.discovery().await?;
        let (state, nonce) = (random_token(), random_token());
        self.insert_pending(
            state.clone(),
            Pending {
                nonce: nonce.clone(),
                return_to,
                created: Instant::now(),
            },
        );
        let query = [
            ("response_type", "code"),
            ("client_id", self.inner.client_id.as_str()),
            ("redirect_uri", self.inner.redirect_uri.as_str()),
            ("scope", "openid profile email"),
            ("state", state.as_str()),
            ("nonce", nonce.as_str()),
        ]
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
        Ok(format!("{}?{query}", discovery.authorization_endpoint))
    }

    fn insert_pending(&self, state: String, pending: Pending) {
        let mut map = self.inner.pending.lock().unwrap();
        if map.len() >= PENDING_CAP {
            // Evict the oldest so a flood of abandoned logins cannot grow
            // the map unboundedly.
            if let Some(oldest) = map
                .iter()
                .min_by_key(|(_, p)| p.created)
                .map(|(k, _)| k.clone())
            {
                map.remove(&oldest);
            }
        }
        map.insert(state, pending);
    }

    /// Take a pending login by its `state`. `None` when unknown, already
    /// used, or expired (single-use: a replayed callback mints nothing).
    fn take_pending(&self, state: &str) -> Option<Pending> {
        let mut map = self.inner.pending.lock().unwrap();
        let pending = map.remove(state)?;
        (pending.created.elapsed() <= PENDING_TTL).then_some(pending)
    }

    // --- callback: code → tokens → verified identity ----------------------

    /// Handle the IdP redirect. Returns `(session_cookie, identity,
    /// return_to)` on success.
    pub async fn handle_callback(
        &self,
        code: &str,
        state: &str,
    ) -> anyhow::Result<(String, AuthIdentity, String)> {
        // Pop the pending entry: a `state` is single-use, so a replayed or
        // forged callback cannot mint a second session.
        let pending = self.take_pending(state);
        let Some(pending) = pending else {
            anyhow::bail!("auth: unknown or already-used state");
        };

        let tokens = self.exchange_code(code).await?;
        let id_token = tokens
            .id_token
            .ok_or_else(|| anyhow::anyhow!("auth: token response had no id_token"))?;
        // The JOSE header names the signing key; fetch the JWKS for it
        // (cached, refetched on key rotation).
        let header = jsonwebtoken::decode_header(&id_token)?;
        let jwks = self.jwks(header.kid.as_deref()).await?;
        let claims = self.verify_id_token(&id_token, &pending.nonce, &jwks)?;
        let name = display_name(&claims)
            .ok_or_else(|| anyhow::anyhow!("auth: id_token carried no usable name claim"))?;

        let cookie = random_token();
        self.inner.sessions.lock().unwrap().insert(
            cookie.clone(),
            AuthSession {
                name: name.clone(),
                sub: claims.sub,
                valid_until: Instant::now() + SESSION_TTL,
            },
        );
        Ok((cookie, AuthIdentity { name }, pending.return_to))
    }

    async fn exchange_code(&self, code: &str) -> anyhow::Result<TokenResponse> {
        let discovery = self.discovery().await?;
        let form = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", self.inner.redirect_uri.as_str()),
            ("client_id", self.inner.client_id.as_str()),
            ("client_secret", self.inner.client_secret.as_str()),
        ];
        let res = self
            .inner
            .http
            .post(&discovery.token_endpoint)
            .form(&form)
            .send()
            .await?
            .error_for_status()?;
        Ok(res.json().await?)
    }

    /// Validate the `id_token`: signature (the supplied JWKS), `iss`, `aud`,
    /// `exp` and `nonce`. Returns the decoded claims.
    fn verify_id_token(
        &self,
        id_token: &str,
        expected_nonce: &str,
        jwks: &JwkSet,
    ) -> anyhow::Result<IdToken> {
        // The JOSE header carries `kid` + `alg`; pick the matching JWK.
        let header = jsonwebtoken::decode_header(id_token)?;
        let jwk = jwks
            .keys
            .iter()
            .find(|k| JwkSet::kid_of(k) == header.kid.as_deref())
            .ok_or_else(|| anyhow::anyhow!("auth: no JWKS key for kid {:?}", header.kid))?;

        let alg = JwkSet::alg_of(jwk);
        let mut validation = Validation::new(alg);
        validation.set_issuer(&[self.inner.issuer.as_str()]);
        // `aud` is checked by hand (it may be a string or an array).
        validation.validate_aud = false;

        let data =
            jsonwebtoken::decode::<IdToken>(id_token, &JwkSet::to_decoding_key(jwk)?, &validation)?;
        let claims = data.claims;
        if !audience_matches(&claims.aud, &self.inner.client_id) {
            anyhow::bail!("auth: id_token audience does not include our client_id");
        }
        if claims.nonce.as_deref() != Some(expected_nonce) {
            anyhow::bail!("auth: id_token nonce mismatch");
        }
        Ok(claims)
    }

    async fn discovery(&self) -> anyhow::Result<Discovery> {
        if let Some(d) = self.inner.cache.lock().unwrap().discovery.clone() {
            return Ok(d);
        }
        let url = format!(
            "{}/.well-known/openid-configuration",
            self.inner.issuer.trim_end_matches('/')
        );
        let discovery: Discovery = self
            .inner
            .http
            .get(&url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        self.inner.cache.lock().unwrap().discovery = Some(discovery.clone());
        Ok(discovery)
    }

    /// The issuer's JWKS, cached. If the token's `kid` is not in the cached
    /// set (or the cache is stale), refetch once to ride key rotation.
    async fn jwks(&self, kid: Option<&str>) -> anyhow::Result<JwkSet> {
        {
            let cache = self.inner.cache.lock().unwrap();
            if let Some((ts, set)) = &cache.jwks {
                let has_kid =
                    kid.is_none_or(|k| set.keys.iter().any(|k2| JwkSet::kid_of(k2) == Some(k)));
                if has_kid || ts.elapsed() < JWKS_REFRESH {
                    return Ok(set.clone());
                }
            }
        }
        let discovery = self.discovery().await?;
        let set: JwkSet = self
            .inner
            .http
            .get(&discovery.jwks_uri)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        self.inner.cache.lock().unwrap().jwks = Some((Instant::now(), set.clone()));
        Ok(set)
    }

    // --- session lookup (enforcement) ------------------------------------

    /// Resolve a session cookie value to the verified identity, if the
    /// session is still valid.
    pub fn identity_for_cookie(&self, cookie: &str) -> Option<AuthIdentity> {
        let mut map = self.inner.sessions.lock().unwrap();
        let session = map.get(cookie)?;
        if session.valid_until < Instant::now() {
            map.remove(cookie);
            return None;
        }
        Some(AuthIdentity {
            name: session.name.clone(),
        })
    }

    /// Drop a session (logout). Returns the identity it held, or `None` if
    /// it was already gone/expired.
    pub fn logout(&self, cookie: &str) -> Option<AuthIdentity> {
        let mut map = self.inner.sessions.lock().unwrap();
        let session = map.remove(cookie)?;
        (session.valid_until > Instant::now()).then_some(AuthIdentity { name: session.name })
    }

    /// Remove expired sessions (called opportunistically).
    pub fn reap_expired(&self) {
        let now = Instant::now();
        self.inner
            .sessions
            .lock()
            .unwrap()
            .retain(|_, s| s.valid_until > now);
    }

    /// Test-only: seed a session directly (the real path mints one from a
    /// verified id_token in [`Auth::handle_callback`]).
    #[cfg(test)]
    pub fn insert_test_session(&self, cookie: &str, name: &str, sub: &str, valid_until: Instant) {
        self.inner.sessions.lock().unwrap().insert(
            cookie.to_owned(),
            AuthSession {
                name: name.to_owned(),
                sub: sub.to_owned(),
                valid_until,
            },
        );
    }
}

/// The JWKS document. Keys stay raw JSON: `DecodingKey::from_jwk` needs the
/// full key material (`n`/`e`, `x`/`y`, …) for every supported algorithm,
/// which a hand-picked struct would have to mirror field by field.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct JwkSet {
    pub keys: Vec<serde_json::Value>,
}

impl JwkSet {
    pub fn kid_of(key: &serde_json::Value) -> Option<&str> {
        key.get("kid").and_then(|k| k.as_str())
    }

    /// The key's `alg` (optional per RFC 7517); RS256 when absent.
    pub fn alg_of(key: &serde_json::Value) -> jsonwebtoken::Algorithm {
        key.get("alg")
            .and_then(|a| serde_json::from_value::<jsonwebtoken::Algorithm>(a.clone()).ok())
            .unwrap_or(jsonwebtoken::Algorithm::RS256)
    }

    pub fn to_decoding_key(key: &serde_json::Value) -> anyhow::Result<DecodingKey> {
        let jwk: jsonwebtoken::jwk::Jwk = serde_json::from_value(key.clone())?;
        Ok(DecodingKey::from_jwk(&jwk)?)
    }
}

/// `aud` in a JWT may be a single string or an array of strings; we accept
/// both and require our `client_id` to be among them.
fn audience_matches(aud: &serde_json::Value, client_id: &str) -> bool {
    match aud {
        serde_json::Value::String(s) => s == client_id,
        serde_json::Value::Array(v) => v.iter().any(|a| a.as_str() == Some(client_id)),
        _ => false,
    }
}

/// The display name forced onto a join, from the `id_token` claims.
/// Precedence: `preferred_username` > `name` > `email` local-part > `sub`.
fn display_name(claims: &IdToken) -> Option<String> {
    if let Some(n) = &claims.preferred_username
        && !n.trim().is_empty()
    {
        return Some(trim_name(n));
    }
    if let Some(n) = &claims.name
        && !n.trim().is_empty()
    {
        return Some(trim_name(n));
    }
    if let Some(e) = &claims.email {
        let local = e.split('@').next().unwrap_or(e).trim();
        if !local.is_empty() {
            return Some(trim_name(local));
        }
    }
    if !claims.sub.trim().is_empty() {
        return Some(trim_name(&claims.sub));
    }
    None
}

/// Trim and cap a name to the protocol's 24-char limit (README §11).
fn trim_name(s: &str) -> String {
    s.trim()
        .chars()
        .take(crate::realtime::MAX_NAME_CHARS)
        .collect()
}

/// 32 random bytes, base64url (no padding) — for `state`, `nonce` and
/// session cookies.
fn random_token() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// Minimal percent-encoding for the query we build by hand (our values are
/// URL-safe base64 or plain, but be correct regardless).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{Algorithm, EncodingKey, Header};
    use serde::Serialize;
    use std::time::{SystemTime, UNIX_EPOCH};

    const ISSUER: &str = "https://idp.example.com";
    const CLIENT_ID: &str = "campfire";

    // Fixed test keypair, generated once and checked in. Production only
    // *verifies* (against the issuer's fetched JWKS), but the unit tests
    // sign real tokens, so a private key has to live here. `FORGED_JWK`
    // serves the *second* key's public numbers under the same kid `k1`, so
    // in the bad-signature test the kid check passes and only the
    // signature itself can (and must) fail.
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
    const FORGED_JWK: &str = "{\"kty\": \"RSA\", \"alg\": \"RS256\", \"kid\": \"k1\", \"n\": \"ufSKuv1WOYhEe3hWi4SgLMOqMianECswapIeEYK5LGhiwumNrlyvUx2koXJtZDRAqWUIzV-x5chRkdrr-Pix4UNayAgfdaa9RJf9F8paVK638lqE8sezzedoNaj9KDGRBPr0EjEhMLvMzYkKrpHpYfRPsIPQ4zMZm_an1Nn8RwS-DJyxRNI4_N-SctODu5SVYM0tgdhcVwqytow4oACpqGAZlZQKKreaJ7SmotvP4zuVdJr1Rtc6KfUpuqXgm9Q7MJmhH2Ffc6vVmvnH62Oz8VmVLz2iY_DUKL3IYD7Mc00CTJ4nveWKpY6_XGxELqpQeKB1mvRDyjxjisxh4D-27Q\", \"e\": \"AQAB\"}";

    fn now_secs() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    fn test_auth() -> Auth {
        Auth::new(
            ISSUER.to_owned(),
            CLIENT_ID.to_owned(),
            "secret".to_owned(),
            "https://campfire.example.com/auth/callback".to_owned(),
        )
        .unwrap()
    }

    /// A hand-built [`IdToken`] for the display-name tests (no signing).
    fn id_token(
        sub: &str,
        name: Option<&str>,
        preferred_username: Option<&str>,
        email: Option<&str>,
    ) -> IdToken {
        IdToken {
            sub: sub.to_owned(),
            iss: ISSUER.to_owned(),
            exp: (now_secs() + 60) as u64,
            aud: serde_json::json!(CLIENT_ID),
            nonce: Some("n".to_owned()),
            name: name.map(|s| s.to_owned()),
            preferred_username: preferred_username.map(|s| s.to_owned()),
            email: email.map(|s| s.to_owned()),
        }
    }

    /// Claims the tests sign into a token. Mirrors the fields [`IdToken`]
    /// reads (with `aud` as a single string, the common id_token shape).
    #[derive(Serialize)]
    struct TClaims<'a> {
        sub: &'a str,
        iss: &'a str,
        exp: i64,
        aud: &'a str,
        nonce: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        preferred_username: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        email: Option<&'a str>,
    }

    fn claims<'a>(iss: &'a str, aud: &'a str, nonce: &'a str, exp: i64) -> TClaims<'a> {
        TClaims {
            sub: "u-123",
            iss,
            exp,
            aud,
            nonce,
            name: Some("Ada Lovelace"),
            preferred_username: None,
            email: None,
        }
    }

    fn jwks_from(raw: &str) -> JwkSet {
        JwkSet {
            keys: vec![serde_json::from_str(raw).unwrap()],
        }
    }

    fn test_jwks() -> JwkSet {
        jwks_from(TEST_JWK)
    }

    /// Sign with the fixed test key; the JOSE header carries kid `k1`.
    fn sign(c: &TClaims) -> String {
        let header = Header {
            kid: Some("k1".to_owned()),
            alg: Algorithm::RS256,
            ..Default::default()
        };
        let key = EncodingKey::from_rsa_pem(TEST_KEY_PEM.as_bytes()).unwrap();
        jsonwebtoken::encode(&header, c, &key).unwrap()
    }

    // --- display_name ------------------------------------------------------

    #[test]
    fn display_name_prefers_preferred_username() {
        let c = id_token(
            "u-1",
            Some("Full Name"),
            Some("ada"),
            Some("ada@example.com"),
        );
        assert_eq!(display_name(&c).as_deref(), Some("ada"));
    }

    #[test]
    fn display_name_falls_back_name_email_sub() {
        assert_eq!(
            display_name(&id_token("u", Some("Ada"), None, None)).as_deref(),
            Some("Ada")
        );
        assert_eq!(
            display_name(&id_token("u", None, None, Some("ada@example.com"))).as_deref(),
            Some("ada")
        );
        assert_eq!(
            display_name(&id_token("u-123", None, None, None)).as_deref(),
            Some("u-123")
        );
        assert_eq!(
            display_name(&id_token("", None, None, None)).as_deref(),
            None
        );
    }

    #[test]
    fn display_name_trims_and_caps() {
        let long = "  ".to_owned() + &"a".repeat(40);
        let c = id_token("u", Some(&long), None, None);
        let name = display_name(&c).unwrap();
        assert_eq!(name.len(), crate::realtime::MAX_NAME_CHARS);
    }

    // --- audience_matches --------------------------------------------------

    #[test]
    fn audience_matches_string_and_array() {
        assert!(audience_matches(&serde_json::json!(CLIENT_ID), CLIENT_ID));
        assert!(!audience_matches(&serde_json::json!("other"), CLIENT_ID));
        assert!(audience_matches(
            &serde_json::json!(["other", CLIENT_ID]),
            CLIENT_ID
        ));
        assert!(!audience_matches(&serde_json::json!(["other"]), CLIENT_ID));
        assert!(!audience_matches(&serde_json::json!(42), CLIENT_ID));
    }

    // --- urlencode ---------------------------------------------------------

    #[test]
    fn urlencode_escapes_and_keeps_unreserved() {
        assert_eq!(urlencode("abc-XYZ019._~"), "abc-XYZ019._~");
        assert_eq!(urlencode("a b/c?d"), "a%20b%2Fc%3Fd");
    }

    // --- pending map: single-use + unknown ---------------------------------

    #[test]
    fn take_pending_is_single_use() {
        let auth = test_auth();
        auth.insert_pending(
            "s1".to_owned(),
            Pending {
                nonce: "n1".to_owned(),
                return_to: "/".to_owned(),
                created: Instant::now(),
            },
        );
        let p = auth.take_pending("s1").expect("first take");
        assert_eq!(p.nonce, "n1");
        assert!(auth.take_pending("s1").is_none(), "replay must fail");
        assert!(auth.take_pending("nope").is_none(), "unknown state");
    }

    // --- session store -----------------------------------------------------

    #[test]
    fn session_lookup_valid_and_expired() {
        let auth = test_auth();
        let live = Instant::now() + SESSION_TTL;
        let dead = Instant::now() - Duration::from_secs(1);
        auth.insert_test_session("live", "Ada", "u", live);
        auth.insert_test_session("dead", "Bob", "v", dead);
        assert_eq!(
            auth.identity_for_cookie("live").map(|i| i.name),
            Some("Ada".to_owned())
        );
        assert!(auth.identity_for_cookie("dead").is_none(), "expired");
        assert!(auth.identity_for_cookie("missing").is_none());
    }

    #[test]
    fn logout_drops_the_session() {
        let auth = test_auth();
        auth.insert_test_session("c", "Ada", "u", Instant::now() + SESSION_TTL);
        assert_eq!(auth.logout("c").map(|i| i.name), Some("Ada".to_owned()));
        assert!(auth.identity_for_cookie("c").is_none(), "gone after logout");
        assert!(auth.logout("c").is_none(), "second logout is a no-op");
    }

    // --- verify_id_token ---------------------------------------------------

    #[test]
    fn verify_accepts_a_valid_token() {
        let auth = test_auth();
        let token = sign(&claims(ISSUER, CLIENT_ID, "nonce-1", now_secs() + 300));
        let claims = auth
            .verify_id_token(&token, "nonce-1", &test_jwks())
            .expect("valid token");
        assert_eq!(claims.sub, "u-123");
    }

    #[test]
    fn verify_rejects_wrong_issuer() {
        let auth = test_auth();
        let token = sign(&claims(
            "https://evil.example.com",
            CLIENT_ID,
            "n",
            now_secs() + 300,
        ));
        assert!(auth.verify_id_token(&token, "n", &test_jwks()).is_err());
    }

    #[test]
    fn verify_rejects_wrong_audience() {
        let auth = test_auth();
        let token = sign(&claims(ISSUER, "other-client", "n", now_secs() + 300));
        assert!(auth.verify_id_token(&token, "n", &test_jwks()).is_err());
    }

    #[test]
    fn verify_rejects_expired() {
        let auth = test_auth();
        let token = sign(&claims(ISSUER, CLIENT_ID, "n", now_secs() - 300));
        assert!(auth.verify_id_token(&token, "n", &test_jwks()).is_err());
    }

    #[test]
    fn verify_rejects_nonce_mismatch() {
        let auth = test_auth();
        let token = sign(&claims(ISSUER, CLIENT_ID, "nonce-real", now_secs() + 300));
        assert!(
            auth.verify_id_token(&token, "nonce-other", &test_jwks())
                .is_err()
        );
    }

    #[test]
    fn verify_rejects_bad_signature() {
        let auth = test_auth();
        // FORGED_JWK serves key 2's public numbers under kid `k1`: the kid
        // check passes, so only the signature itself can (and must) fail.
        let token = sign(&claims(ISSUER, CLIENT_ID, "n", now_secs() + 300));
        assert!(
            auth.verify_id_token(&token, "n", &jwks_from(FORGED_JWK))
                .is_err()
        );
    }
}
