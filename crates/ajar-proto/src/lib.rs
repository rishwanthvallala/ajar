//! Wire format shared by the agent, the relay and (by hand) the web client.
//!
//! Every message is one binary WebSocket frame:
//!
//! ```text
//! byte  0      channel    u8   CONTROL | PTY | FS | PRESENCE
//! bytes 1..5   stream_id  u32  LE  pty id, or 0 for channel-level JSON
//! bytes 5..9   target     u32  LE  host→guest destination, or authenticated
//!                                  guest→host sender; 0 for broadcast
//! bytes 9..    payload    opaque to the relay
//! ```
//!
//! The relay reads the header and nothing else. That constraint is why
//! turning on end-to-end encryption later is a layer, not a rewrite.

pub mod crypto;

pub use crypto::{Cipher, CryptoError};

use serde::{Deserialize, Serialize};

pub const HEADER_LEN: usize = 9;

/// Broadcast to everyone the routing rules allow.
pub const TARGET_ALL: u32 = 0;
/// JSON control payload for a channel, rather than raw stream bytes.
pub const STREAM_CONTROL: u32 = 0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Channel {
    Control = 0x01,
    Pty = 0x02,
    Fs = 0x03,
    Presence = 0x04,
    Doc = 0x05,
    Store = 0x06,
}

impl Channel {
    /// Whether this channel's payloads are sealed before they leave.
    ///
    /// Control stays readable because the relay has to route on it — session
    /// ids, participant ids, joins and leaves. Everything with content in it
    /// does not.
    pub fn is_encrypted(self) -> bool {
        // Store is absent deliberately: the relay must read its envelope to
        // count bytes against a limit, and the snapshot it carries is sealed
        // by the agent before it ever arrives.
        matches!(
            self,
            Channel::Pty | Channel::Fs | Channel::Doc | Channel::Presence
        )
    }

    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0x01 => Some(Channel::Control),
            0x02 => Some(Channel::Pty),
            0x03 => Some(Channel::Fs),
            0x04 => Some(Channel::Presence),
            0x05 => Some(Channel::Doc),
            0x06 => Some(Channel::Store),
            _ => None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("frame shorter than header ({0} bytes)")]
    TooShort(usize),
    #[error("unknown channel byte 0x{0:02x}")]
    UnknownChannel(u8),
    #[error("payload is not valid json: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone)]
pub struct Frame {
    pub channel: Channel,
    pub stream_id: u32,
    /// Destination on host-originated traffic; authenticated sender identity
    /// on encrypted guest-originated traffic.
    pub target: u32,
    pub payload: Vec<u8>,
}

impl Frame {
    fn authenticated_header(&self) -> [u8; HEADER_LEN] {
        let mut header = [0u8; HEADER_LEN];
        header[0] = self.channel as u8;
        header[1..5].copy_from_slice(&self.stream_id.to_le_bytes());
        header[5..9].copy_from_slice(&self.target.to_le_bytes());
        header
    }

    pub fn new(channel: Channel, stream_id: u32, target: u32, payload: Vec<u8>) -> Self {
        Self {
            channel,
            stream_id,
            target,
            payload,
        }
    }

    /// A JSON control message on the given channel.
    pub fn json<T: Serialize>(channel: Channel, target: u32, msg: &T) -> Result<Self, FrameError> {
        Ok(Self::new(
            channel,
            STREAM_CONTROL,
            target,
            serde_json::to_vec(msg)?,
        ))
    }

    /// Raw stream bytes — used for terminal I/O, which is the hot path.
    pub fn stream(channel: Channel, stream_id: u32, target: u32, bytes: Vec<u8>) -> Self {
        Self::new(channel, stream_id, target, bytes)
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_LEN + self.payload.len());
        out.push(self.channel as u8);
        out.extend_from_slice(&self.stream_id.to_le_bytes());
        out.extend_from_slice(&self.target.to_le_bytes());
        out.extend_from_slice(&self.payload);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, FrameError> {
        if bytes.len() < HEADER_LEN {
            return Err(FrameError::TooShort(bytes.len()));
        }
        let channel = Channel::from_u8(bytes[0]).ok_or(FrameError::UnknownChannel(bytes[0]))?;
        let stream_id = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        let target = u32::from_le_bytes([bytes[5], bytes[6], bytes[7], bytes[8]]);
        Ok(Self {
            channel,
            stream_id,
            target,
            payload: bytes[HEADER_LEN..].to_vec(),
        })
    }

    pub fn parse_json<T: for<'de> Deserialize<'de>>(&self) -> Result<T, FrameError> {
        Ok(serde_json::from_slice(&self.payload)?)
    }

    /// True when this frame carries raw stream bytes rather than JSON.
    pub fn is_stream(&self) -> bool {
        self.stream_id != STREAM_CONTROL
    }

    /// Seal the payload if this channel carries content. Applied once, at the
    /// point the frame goes on the wire.
    pub fn seal(mut self, cipher: &Cipher) -> Self {
        if self.channel.is_encrypted() {
            self.payload = cipher.seal_with_aad(&self.payload, &self.authenticated_header());
        }
        self
    }

    /// Undo [`Frame::seal`]. A frame that will not open is dropped by the
    /// caller rather than guessed at.
    pub fn open(mut self, cipher: &Cipher) -> Result<Self, CryptoError> {
        if self.channel.is_encrypted() {
            self.payload = cipher.open_with_aad(&self.payload, &self.authenticated_header())?;
        }
        Ok(self)
    }
}

// ---------------------------------------------------------------- CONTROL

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Host,
    Guest,
}

/// What the relay knows about someone: an id and whether they are the host.
///
/// Deliberately nameless. Names are content, so they travel on the encrypted
/// presence channel and the relay never sees one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Participant {
    pub id: u32,
    pub role: Role,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Control {
    /// First frame on every socket. The relay answers with `Welcome` or `Error`.
    Hello {
        session: String,
        role: Role,
    },
    Welcome {
        participant_id: u32,
        participants: Vec<Participant>,
    },
    Joined {
        participant: Participant,
    },
    Left {
        participant_id: u32,
    },
    Kick {
        participant_id: u32,
    },
    /// Seal the room. Everyone already here stays; nobody new gets in.
    /// Enforced by the relay, because it is the only thing that sees a
    /// connection before the host does.
    Lock {
        locked: bool,
    },
    /// Relay → everyone, so the interface can say so.
    Locked {
        locked: bool,
    },
    /// The host is leaving deliberately. Distinct from the socket dropping,
    /// which starts a grace period instead of ending the session.
    Close,
    /// The host's socket dropped. The session survives for `grace_secs` so a
    /// blip is invisible; terminals keep running the whole time.
    HostAway {
        grace_secs: u64,
    },
    HostBack,
    Closed {
        reason: String,
    },
    Error {
        code: String,
        message: String,
    },
}

// -------------------------------------------------------------------- PTY

/// JSON messages on the PTY channel. These always ride `stream_id == 0`;
/// any frame with `stream_id != 0` on this channel is raw terminal bytes
/// belonging to that pty.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Pty {
    Open {
        cols: u16,
        rows: u16,
    },
    Opened {
        pty_id: u32,
        cols: u16,
        rows: u16,
        opened_by: u32,
    },
    /// Clients send their own size; the host applies the minimum across
    /// everyone attached, or the terminal wraps wrongly for the smallest.
    Resize {
        pty_id: u32,
        cols: u16,
        rows: u16,
    },
    Close {
        pty_id: u32,
    },
    Closed {
        pty_id: u32,
        exit_code: i32,
    },
    /// Guests can watch but not type. The host still can, because the host's
    /// input never travels through the relay in the first place.
    ReadOnly {
        read_only: bool,
    },
    /// The host declined to open one. Said out loud: a button that silently
    /// does nothing reads as a bug.
    Refused {
        reason: String,
    },
}

// --------------------------------------------------------------------- FS

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Dir,
}

/// One node in the shared tree. Paths are relative to the shared folder and
/// always use forward slashes, so the wire format doesn't care what the host
/// runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Fs {
    /// Full snapshot. Sent when someone joins, and again whenever the watcher
    /// gives up describing a change — a dependency install, a branch switch.
    /// Rebuilding a tree is cheaper than shipping fifty thousand deltas, and
    /// far cheaper than a client that falls behind forever.
    ///
    /// There is deliberately no separate "resync" message: a tree already
    /// means *replace everything you know*, and a client that received one
    /// would only redraw microseconds later.
    Tree {
        entries: Vec<Entry>,
    },
    /// Incremental change, coalesced and sent at most a few times a second.
    Patch {
        added: Vec<Entry>,
        changed: Vec<Entry>,
        removed: Vec<String>,
    },
    Read {
        path: String,
    },
    Content {
        path: String,
        text: String,
        /// Hit the size cap; `text` holds the first part only.
        truncated: bool,
        /// Binary, so `text` is empty. We never ship the bytes.
        binary: bool,
    },
    /// Reading failed — gone, unreadable, outside the workspace.
    ReadError {
        path: String,
        message: String,
    },
}

/// Files above this never travel whole. Source is small; anything bigger is
/// usually generated, and a client cannot usefully render it anyway.
pub const MAX_FILE_BYTES: usize = 1024 * 1024;

// -------------------------------------------------------------------- DOC

/// Collaborative editing.
///
/// Same shape as the PTY channel: `stream_id == 0` carries JSON, and any
/// other `stream_id` is raw bytes belonging to that document. CRDT updates
/// are binary and frequent, so they never travel as JSON.
///
/// The first byte of a binary payload says which kind it is — see [`DocKind`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Doc {
    /// Start editing. The host answers with `Opened` followed by the
    /// document's full state.
    Open {
        path: String,
    },
    Opened {
        doc_id: u32,
        path: String,
    },
    /// Stop editing. The host drops the document once nobody has it open.
    Close {
        doc_id: u32,
    },
    Closed {
        doc_id: u32,
        reason: String,
    },
    Error {
        path: String,
        message: String,
    },
}

/// The tag byte at the front of every binary payload on the doc channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum DocKind {
    /// A Yjs update. Idempotent and commutative, so the host can forward a
    /// guest's bytes to everyone else without interpreting them.
    Update = 0x01,
    /// A y-protocols awareness update: cursors, selections, who is where.
    /// Ephemeral — never written to disk, never replayed to a latecomer.
    Awareness = 0x02,
}

impl DocKind {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0x01 => Some(DocKind::Update),
            0x02 => Some(DocKind::Awareness),
            _ => None,
        }
    }

    /// Prefix `bytes` with this tag.
    pub fn frame(self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(bytes.len() + 1);
        out.push(self as u8);
        out.extend_from_slice(bytes);
        out
    }

    /// Split a tagged payload back into its kind and body.
    pub fn split(payload: &[u8]) -> Option<(Self, &[u8])> {
        let (first, rest) = payload.split_first()?;
        Some((Self::from_u8(*first)?, rest))
    }
}

// ------------------------------------------------------------------ STORE

/// Keeping a copy, so guests can still read the folder when the host's
/// connection drops.
///
/// The relay stores bytes it cannot read: the agent seals the snapshot with
/// the session key first. The envelope is in the clear only because a size
/// limit has to be enforced by something that can count.
///
/// The host is authoritative whenever it is online. What is stored here is a
/// stale replica, served read-only and only while the host is away — a store
/// that is never written to by anyone else can never diverge from it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Store {
    /// Agent → relay, before the blob.
    Offer {
        bytes: u64,
        files: u32,
    },
    Accepted,
    /// Over a limit, or refused. Said out loud rather than truncating.
    Rejected {
        reason: String,
    },
    /// Guest → relay, when the host has gone away.
    Fetch,
    /// Relay → guest, before the blob.
    Snapshot {
        bytes: u64,
        files: u32,
    },
    /// Nothing stored — sync is off, or nothing offered yet.
    Empty,
}

/// A snapshot before sealing: the source files, and nothing else.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotBody {
    pub files: Vec<SnapshotFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotFile {
    pub path: String,
    pub text: String,
}

/// The stream id every snapshot blob rides on.
pub const SNAPSHOT_STREAM: u32 = 1;

// --------------------------------------------------------------- PRESENCE

/// Who is looking at what. Guests send `Report`; the host stamps it with the
/// sender and rebroadcasts as `Update`.
///
/// Presence goes through the host rather than being fanned out by the relay,
/// because the host is the authority on session state and the relay's routing
/// table is four cells that we would like to keep at four cells.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Presence {
    Report {
        active_pty: Option<u32>,
    },
    Update {
        participant_id: u32,
        active_pty: Option<u32>,
    },
    /// A guest introducing themselves, once they are past the relay.
    Iam {
        name: String,
    },
    /// The host's view of who is here, and what folder this is. Rebroadcast
    /// whenever it changes — the relay cannot assemble this, because it does
    /// not know anyone's name.
    Roster {
        workspace: String,
        people: Vec<Person>,
    },
}

/// Someone, with their name. Only ever seen inside a sealed frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Person {
    pub id: u32,
    pub name: String,
    pub role: Role,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_a_stream_frame() {
        let f = Frame::stream(Channel::Pty, 7, 3, b"hello".to_vec());
        let back = Frame::decode(&f.encode()).unwrap();
        assert_eq!(back.channel, Channel::Pty);
        assert_eq!(back.stream_id, 7);
        assert_eq!(back.target, 3);
        assert_eq!(back.payload, b"hello");
        assert!(back.is_stream());
    }

    #[test]
    fn roundtrips_a_control_frame() {
        let msg = Control::Hello {
            session: "quiet-ember-4417".into(),
            role: Role::Guest,
        };
        let f = Frame::json(Channel::Control, TARGET_ALL, &msg).unwrap();
        let back = Frame::decode(&f.encode()).unwrap();
        assert!(!back.is_stream());
        match back.parse_json::<Control>().unwrap() {
            Control::Hello { session, role } => {
                assert_eq!(session, "quiet-ember-4417");
                assert_eq!(role, Role::Guest);
            }
            other => panic!("wrong message: {other:?}"),
        }
    }

    #[test]
    fn the_relay_never_learns_a_name() {
        // Names are content. If one could be serialised into a control frame
        // it would cross the wire in the clear.
        let hello = serde_json::to_string(&Control::Hello {
            session: "s".into(),
            role: Role::Guest,
        })
        .unwrap();
        assert!(
            !hello.contains("name"),
            "a name leaked into the handshake: {hello}"
        );

        let welcome = serde_json::to_string(&Control::Welcome {
            participant_id: 2,
            participants: vec![Participant {
                id: 1,
                role: Role::Host,
            }],
        })
        .unwrap();
        assert!(
            !welcome.contains("name"),
            "a name leaked into welcome: {welcome}"
        );
    }

    #[test]
    fn content_channels_are_sealed_and_control_is_not() {
        let (cipher, _) = Cipher::generate();

        let pty = Frame::stream(Channel::Pty, 1, 0, b"cat ~/.ssh/id_rsa\r".to_vec());
        let sealed = pty.clone().seal(&cipher);
        assert!(
            !String::from_utf8_lossy(&sealed.payload).contains(".ssh"),
            "terminal input went out in the clear"
        );
        assert_eq!(sealed.open(&cipher).unwrap().payload, pty.payload);

        // The relay routes on this, so it has to stay readable.
        let hello = Frame::json(
            Channel::Control,
            TARGET_ALL,
            &Control::Hello {
                session: "quiet-ember-4417".into(),
                role: Role::Guest,
            },
        )
        .unwrap();
        let after = hello.clone().seal(&cipher);
        assert_eq!(
            after.payload, hello.payload,
            "control must stay in the clear"
        );
    }

    #[test]
    fn routing_metadata_is_authenticated_and_replays_are_rejected() {
        let (cipher, _) = Cipher::generate();
        let sealed = Frame::stream(Channel::Pty, 7, 2, b"whoami\r".to_vec()).seal(&cipher);

        let mut redirected = sealed.clone();
        redirected.target = 3;
        assert!(matches!(redirected.open(&cipher), Err(CryptoError::Failed)));

        let opened = sealed.clone().open(&cipher).unwrap();
        assert_eq!(opened.payload, b"whoami\r");
        assert!(matches!(sealed.open(&cipher), Err(CryptoError::Replayed)));
    }

    #[test]
    fn every_content_channel_is_covered() {
        // A new channel that carries content and is not listed here would
        // silently travel in the clear.
        for ch in [Channel::Pty, Channel::Fs, Channel::Doc, Channel::Presence] {
            assert!(
                ch.is_encrypted(),
                "{ch:?} carries content but is not sealed"
            );
        }
        assert!(!Channel::Control.is_encrypted());
    }

    #[test]
    fn rejects_a_short_frame() {
        assert!(matches!(
            Frame::decode(&[0x01, 0x00]),
            Err(FrameError::TooShort(2))
        ));
    }
}
