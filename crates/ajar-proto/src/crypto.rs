//! Keeping the relay out of it.
//!
//! The relay reads a nine-byte header and forwards the rest. That was true
//! before this module existed — which is why turning encryption on is a layer
//! rather than a rewrite, and why the relay needed no changes at all.
//!
//! The key lives in the link's fragment (`#k=…`), which browsers never send
//! to a server. So the relay routes frames it cannot read, and the people in
//! the session hold the only copy of the key.
//!
//! What this does **not** hide: session ids, participant ids, who is a host,
//! when people join and leave, and the size and timing of every frame. A
//! relay operator can see that a session is busy. They cannot see what is in
//! it.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use parking_lot::Mutex;

use aes_gcm::aead::{Aead, Generate, KeyInit, Nonce, Payload};
use aes_gcm::{Aes256Gcm, Key};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("the key in the link is not valid base64")]
    BadEncoding,
    #[error("expected a {KEY_LEN}-byte key, got {0} bytes")]
    BadKeyLength(usize),
    #[error("frame is too short to contain a nonce")]
    TooShort,
    #[error("could not decrypt — wrong key, or the frame was tampered with")]
    Failed,
    #[error("encrypted frame was already received")]
    Replayed,
}

/// One session's key. Cheap to clone; the underlying cipher is stateless.
#[derive(Clone)]
pub struct Cipher {
    cipher: Aes256Gcm,
    key: [u8; KEY_LEN],
    received: Arc<Mutex<ReceivedNonces>>,
}

/// How many recent nonces to remember when rejecting replays.
///
/// This has to be bounded or it becomes the leak it was added to prevent: a
/// single `ls -R` is a couple of thousand frames, and remembering every one
/// for the life of the session costs tens of megabytes on the host and in
/// every guest's tab.
///
/// So it is a *window*, and the bargain is explicit: a frame replayed after
/// another `REMEMBERED` have arrived will be accepted. DTLS and IPsec make
/// the same trade for the same reason — replay matters while a frame is
/// still current, and an attacker who can hold one for four thousand frames
/// can hold it forever.
const REMEMBERED: usize = 4096;

/// The nonces seen recently, newest last.
///
/// A set to answer "have I seen this", and a queue to know which to forget.
/// Counter nonces would need neither, but the session key is shared by the
/// host and every guest, so independent counters would collide — and a
/// repeated nonce under GCM leaks the authentication key. Random 96-bit
/// nonces are the right choice here precisely because the key is shared.
#[derive(Default)]
struct ReceivedNonces {
    set: HashSet<[u8; NONCE_LEN]>,
    order: VecDeque<[u8; NONCE_LEN]>,
}

impl ReceivedNonces {
    /// True when this nonce has not been seen inside the window.
    fn accept(&mut self, nonce: [u8; NONCE_LEN]) -> bool {
        if !self.set.insert(nonce) {
            return false;
        }
        self.order.push_back(nonce);
        if self.order.len() > REMEMBERED {
            if let Some(forgotten) = self.order.pop_front() {
                self.set.remove(&forgotten);
            }
        }
        true
    }
}

impl std::fmt::Debug for Cipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the key, not even by accident in a log line.
        f.write_str("Cipher(…)")
    }
}

impl Cipher {
    /// A fresh key, and the text to put after `#k=` in the link.
    pub fn generate() -> (Self, String) {
        let key = Key::<Aes256Gcm>::generate();
        let mut bytes = [0u8; KEY_LEN];
        bytes.copy_from_slice(key.as_slice());
        (Self::from_bytes(bytes), URL_SAFE_NO_PAD.encode(bytes))
    }

    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        let key = Key::<Aes256Gcm>::from(bytes);
        Self {
            cipher: Aes256Gcm::new(&key),
            key: bytes,
            received: Arc::new(Mutex::new(ReceivedNonces::default())),
        }
    }

    pub fn from_link(encoded: &str) -> Result<Self, CryptoError> {
        let raw = URL_SAFE_NO_PAD
            .decode(encoded.trim())
            .map_err(|_| CryptoError::BadEncoding)?;
        let bytes: [u8; KEY_LEN] = raw
            .as_slice()
            .try_into()
            .map_err(|_| CryptoError::BadKeyLength(raw.len()))?;
        Ok(Self::from_bytes(bytes))
    }

    pub fn to_link(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.key)
    }

    /// `nonce || ciphertext || tag`.
    ///
    /// A random 96-bit nonce per frame. The birthday bound is around 2^32
    /// frames on one key, and a session that produced four billion frames
    /// would have other problems.
    pub fn seal(&self, plaintext: &[u8]) -> Vec<u8> {
        let nonce = Nonce::<Aes256Gcm>::generate();
        let mut out = Vec::with_capacity(NONCE_LEN + plaintext.len() + 16);
        out.extend_from_slice(nonce.as_slice());
        match self.cipher.encrypt(&nonce, plaintext) {
            Ok(ct) => out.extend_from_slice(&ct),
            // Only reachable on allocation failure, where there is nothing
            // useful to do but refuse to emit plaintext.
            Err(_) => return Vec::new(),
        }
        out
    }

    pub fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
        self.open_inner(sealed, &[], false)
    }

    /// Seal while authenticating data that remains visible on the wire.
    pub fn seal_with_aad(&self, plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
        let nonce = Nonce::<Aes256Gcm>::generate();
        let mut out = Vec::with_capacity(NONCE_LEN + plaintext.len() + 16);
        out.extend_from_slice(nonce.as_slice());
        match self.cipher.encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        ) {
            Ok(ct) => out.extend_from_slice(&ct),
            // Unreachable short of a plaintext measured in exabytes. Loudly
            // rather than quietly: returning an empty payload would reach the
            // peer as `TooShort`, which reads as "wrong key or tampered" and
            // points whoever debugs it at entirely the wrong thing.
            Err(e) => unreachable!("sealing a frame cannot fail: {e}"),
        }
        out
    }

    /// Open an authenticated frame and reject a nonce already accepted for
    /// this session key. Nonces are recorded only after authentication.
    pub fn open_with_aad(&self, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
        self.open_inner(sealed, aad, true)
    }

    fn open_inner(
        &self,
        sealed: &[u8],
        aad: &[u8],
        reject_replay: bool,
    ) -> Result<Vec<u8>, CryptoError> {
        if sealed.len() < NONCE_LEN {
            return Err(CryptoError::TooShort);
        }
        let (nonce, ct) = sealed.split_at(NONCE_LEN);
        let nonce = Nonce::<Aes256Gcm>::try_from(nonce).map_err(|_| CryptoError::TooShort)?;
        let plain = self
            .cipher
            .decrypt(&nonce, Payload { msg: ct, aad })
            .map_err(|_| CryptoError::Failed)?;

        if reject_replay {
            let nonce_bytes: [u8; NONCE_LEN] = nonce.as_slice().try_into().expect("nonce length");
            if !self.received.lock().accept(nonce_bytes) {
                return Err(CryptoError::Replayed);
            }
        }
        Ok(plain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_replayed_frame_is_refused() {
        let (cipher, _) = Cipher::generate();
        let sealed = cipher.seal_with_aad(b"whoami", b"header");
        assert_eq!(cipher.open_with_aad(&sealed, b"header").unwrap(), b"whoami");
        assert!(matches!(
            cipher.open_with_aad(&sealed, b"header"),
            Err(CryptoError::Replayed)
        ));
    }

    #[test]
    fn remembering_replays_is_bounded() {
        // The whole point: a long session must not accumulate one entry per
        // frame. A single `ls -R` is around two thousand frames, so an
        // unbounded set is tens of megabytes an hour on the host and in
        // every guest's tab.
        let (cipher, _) = Cipher::generate();
        for i in 0..(REMEMBERED * 3) {
            let sealed = cipher.seal_with_aad(format!("frame {i}").as_bytes(), b"h");
            cipher.open_with_aad(&sealed, b"h").expect("fresh frame");
        }
        let held = cipher.received.lock();
        assert!(
            held.set.len() <= REMEMBERED && held.order.len() <= REMEMBERED,
            "replay window grew past its bound: {} entries",
            held.set.len()
        );
    }

    #[test]
    fn the_window_forgets_in_order() {
        let (cipher, _) = Cipher::generate();
        let first = cipher.seal_with_aad(b"first", b"h");
        cipher.open_with_aad(&first, b"h").unwrap();
        // Push it out of the window, then replay it. Accepted, and that is
        // the documented bargain rather than a bug.
        for i in 0..REMEMBERED {
            let s = cipher.seal_with_aad(format!("{i}").as_bytes(), b"h");
            cipher.open_with_aad(&s, b"h").unwrap();
        }
        assert!(
            cipher.open_with_aad(&first, b"h").is_ok(),
            "a nonce older than the window should have been forgotten"
        );
    }

    #[test]
    fn a_sealed_frame_comes_back_whole() {
        let (c, _) = Cipher::generate();
        let sealed = c.seal(b"ls -la\r");
        assert_eq!(c.open(&sealed).unwrap(), b"ls -la\r");
    }

    #[test]
    fn ciphertext_does_not_contain_the_plaintext() {
        let (c, _) = Cipher::generate();
        let sealed = c.seal(b"DATABASE_URL=postgres://secret");
        let as_text = String::from_utf8_lossy(&sealed);
        assert!(
            !as_text.contains("postgres"),
            "the payload was not encrypted"
        );
        assert!(!as_text.contains("DATABASE"));
    }

    #[test]
    fn the_same_plaintext_seals_differently_every_time() {
        // A fixed nonce would make a terminal session trivially analysable:
        // every repeated keystroke would produce identical bytes.
        let (c, _) = Cipher::generate();
        let a = c.seal(b"y\r");
        let b = c.seal(b"y\r");
        assert_ne!(a, b, "identical frames produced identical ciphertext");
        assert_eq!(c.open(&a).unwrap(), c.open(&b).unwrap());
    }

    #[test]
    fn another_key_cannot_read_it() {
        let (mine, _) = Cipher::generate();
        let (theirs, _) = Cipher::generate();
        let sealed = mine.seal(b"private");
        assert!(matches!(theirs.open(&sealed), Err(CryptoError::Failed)));
    }

    #[test]
    fn tampering_is_detected() {
        let (c, _) = Cipher::generate();
        let mut sealed = c.seal(b"git push --force");
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert!(
            matches!(c.open(&sealed), Err(CryptoError::Failed)),
            "a modified frame was accepted"
        );
    }

    #[test]
    fn a_truncated_frame_is_rejected_not_panicked_on() {
        let (c, _) = Cipher::generate();
        assert!(matches!(c.open(&[]), Err(CryptoError::TooShort)));
        assert!(matches!(c.open(&[0u8; 4]), Err(CryptoError::TooShort)));
        // Long enough for a nonce, but no ciphertext behind it.
        assert!(matches!(
            c.open(&[0u8; NONCE_LEN]),
            Err(CryptoError::Failed)
        ));
    }

    #[test]
    fn a_key_survives_the_round_trip_through_a_link() {
        let (original, encoded) = Cipher::generate();
        assert!(
            !encoded.contains('+') && !encoded.contains('/') && !encoded.contains('='),
            "the key has to be safe in a URL fragment: {encoded}"
        );
        let recovered = Cipher::from_link(&encoded).unwrap();
        let sealed = original.seal(b"hello");
        assert_eq!(recovered.open(&sealed).unwrap(), b"hello");
        assert_eq!(recovered.to_link(), encoded);
    }

    #[test]
    fn a_broken_key_is_refused_clearly() {
        assert!(matches!(
            Cipher::from_link("not base64!!"),
            Err(CryptoError::BadEncoding)
        ));
        assert!(matches!(
            Cipher::from_link("c2hvcnQ"),
            Err(CryptoError::BadKeyLength(_))
        ));
    }

    #[test]
    fn the_key_never_appears_in_debug_output() {
        let (c, encoded) = Cipher::generate();
        let printed = format!("{c:?}");
        assert!(
            !printed.contains(&encoded),
            "the key leaked into a log line"
        );
    }

    #[test]
    fn empty_payloads_are_still_authenticated() {
        let (c, _) = Cipher::generate();
        let sealed = c.seal(b"");
        assert!(sealed.len() > NONCE_LEN, "an empty frame still needs a tag");
        assert_eq!(c.open(&sealed).unwrap(), b"");
    }
}
