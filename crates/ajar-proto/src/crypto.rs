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

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

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

#[derive(Default)]
struct ReceivedNonces {
    set: HashSet<[u8; NONCE_LEN]>,
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
            Err(_) => return Vec::new(),
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
            let nonce_bytes: [u8; NONCE_LEN] =
                nonce.as_slice().try_into().expect("nonce length");
            let mut received = self.received.lock().map_err(|_| CryptoError::Failed)?;
            if !received.set.insert(nonce_bytes) {
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
