//! What a socket is allowed to fall behind by.
//!
//! Every connection gets a queue, and the routing side never blocks on a slow
//! reader — it hands bytes over and moves on. Left unbounded, that is a memory
//! exhaustion bug with no attacker required: one guest whose connection stalls
//! while a terminal is producing output makes the relay accumulate until
//! something dies.
//!
//! So the queue is bounded, and a connection that exceeds it is **closed
//! rather than fed a lossy stream**. Terminal output with holes in it is worse
//! than a clean disconnect: the client would render a corrupted screen and
//! have no way to know. Dropping the socket makes the agent's reconnect and
//! replay path handle it, which is already tested.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::{mpsc, Notify};

/// How far behind a socket may fall before it is disconnected.
///
/// This governs *accumulation*, not the size of any one frame — see
/// [`Outbox::send`]. Eight megabytes is far more than a terminal session
/// produces between polls, and small enough that a few hundred stalled
/// connections cannot exhaust a small VM.
pub const MAX_QUEUED_BYTES: usize = 8 * 1024 * 1024;

/// A second bound, on count rather than volume. Guards against a flood of
/// tiny frames, which would slip under the byte cap.
pub const MAX_QUEUED_FRAMES: usize = 2048;

/// The queue is full; the caller should stop using this connection.
#[derive(Debug, PartialEq, Eq)]
pub struct Overflowed;

/// The sending half of one socket's queue.
#[derive(Clone)]
pub struct Outbox {
    inner: mpsc::Sender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    /// Latched when a send is refused, so the writer task exits and takes the
    /// socket down with it.
    ///
    /// A flag rather than only a notification: `Notify::notify_waiters` wakes
    /// tasks that are *already parked*, so an overflow occurring while the
    /// writer was mid-send would vanish and the connection would limp on.
    closed: Arc<AtomicBool>,
    wake: Arc<Notify>,
}

/// The receiving half, held by the one task that writes to the socket.
pub struct Drain {
    inner: mpsc::Receiver<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
    wake: Arc<Notify>,
}

pub fn channel() -> (Outbox, Drain) {
    let (tx, rx) = mpsc::channel(MAX_QUEUED_FRAMES);
    let queued = Arc::new(AtomicUsize::new(0));
    let closed = Arc::new(AtomicBool::new(false));
    let wake = Arc::new(Notify::new());
    (
        Outbox {
            inner: tx,
            queued: queued.clone(),
            closed: closed.clone(),
            wake: wake.clone(),
        },
        Drain {
            inner: rx,
            queued,
            closed,
            wake,
        },
    )
}

impl Outbox {
    /// Queue bytes for this socket, or report that it has fallen too far
    /// behind.
    ///
    /// A single frame is always accepted when the queue is empty, however
    /// large it is: a workspace snapshot is legitimately megabytes, and
    /// refusing it would break a working feature to defend against a problem
    /// it does not cause. What is refused is *accumulation* behind a reader
    /// that has stopped draining.
    pub fn send(&self, bytes: Vec<u8>) -> Result<(), Overflowed> {
        let queued = self.queued.load(Ordering::Relaxed);
        if queued > 0 && queued.saturating_add(bytes.len()) > MAX_QUEUED_BYTES {
            self.shut();
            return Err(Overflowed);
        }
        self.queued.fetch_add(bytes.len(), Ordering::Relaxed);
        match self.inner.try_send(bytes) {
            Ok(()) => Ok(()),
            Err(e) => {
                // Either the frame cap was hit or the reader is gone. Either
                // way this connection is finished.
                self.queued
                    .fetch_sub(e.into_inner().len(), Ordering::Relaxed);
                self.shut();
                Err(Overflowed)
            }
        }
    }

    fn shut(&self) {
        self.closed.store(true, Ordering::Release);
        self.wake.notify_waiters();
    }

    /// Bytes currently waiting to go out. Only the tests look at this; the
    /// running relay just sends and lets `send` decide.
    #[cfg(test)]
    pub fn queued(&self) -> usize {
        self.queued.load(Ordering::Relaxed)
    }
}

impl Drain {
    /// The next frame to write, or `None` when the connection is finished —
    /// because the senders are gone, or because one of them overflowed.
    pub async fn next(&mut self) -> Option<Vec<u8>> {
        // Checked before parking, so an overflow that happened while this
        // task was busy is still seen.
        if self.closed.load(Ordering::Acquire) {
            return None;
        }
        tokio::select! {
            // A refused send means this socket is already beyond saving;
            // prefer noticing that over draining more into it.
            biased;
            _ = self.wake.notified() => None,
            frame = self.inner.recv() => {
                let frame = frame?;
                self.queued.fetch_sub(frame.len(), Ordering::Relaxed);
                Some(frame)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ordinary_traffic_passes_straight_through() {
        let (tx, mut rx) = channel();
        tx.send(b"hello".to_vec()).unwrap();
        assert_eq!(tx.queued(), 5);
        assert_eq!(rx.next().await.as_deref(), Some(b"hello".as_slice()));
        assert_eq!(tx.queued(), 0, "draining should release the reservation");
    }

    #[tokio::test]
    async fn a_reader_that_stops_draining_is_cut_off() {
        let (tx, _rx) = channel();
        // Nothing is being drained, so this accumulates.
        let chunk = vec![0u8; 1024 * 1024];
        let mut sent = 0;
        while tx.send(chunk.clone()).is_ok() {
            sent += 1;
            assert!(sent < 64, "the queue never refused anything");
        }
        assert!(
            tx.queued() <= MAX_QUEUED_BYTES,
            "queued {} bytes, over the {MAX_QUEUED_BYTES} cap",
            tx.queued()
        );
    }

    #[tokio::test]
    async fn one_oversized_frame_is_still_allowed() {
        // A workspace snapshot is legitimately larger than the accumulation
        // cap. Refusing it would break a working feature.
        let (tx, mut rx) = channel();
        let snapshot = vec![7u8; MAX_QUEUED_BYTES * 3];
        assert_eq!(tx.send(snapshot.clone()), Ok(()));
        assert_eq!(rx.next().await.map(|f| f.len()), Some(snapshot.len()));
    }

    #[tokio::test]
    async fn but_not_two_of_them() {
        let (tx, _rx) = channel();
        let big = vec![7u8; MAX_QUEUED_BYTES * 3];
        assert_eq!(tx.send(big.clone()), Ok(()));
        assert_eq!(
            tx.send(big),
            Err(Overflowed),
            "a second oversized frame should not stack on the first"
        );
    }

    #[tokio::test]
    async fn a_flood_of_tiny_frames_is_bounded_too() {
        // Small frames slip under the byte cap, so the count cap catches them.
        let (tx, _rx) = channel();
        let mut sent = 0;
        while tx.send(vec![1u8]).is_ok() {
            sent += 1;
            assert!(sent <= MAX_QUEUED_FRAMES, "the frame cap never fired");
        }
        assert_eq!(sent, MAX_QUEUED_FRAMES);
    }

    #[tokio::test]
    async fn an_overflow_ends_the_connection() {
        let (tx, mut rx) = channel();
        // Fill past the cap, which signals the writer to give up.
        let chunk = vec![0u8; MAX_QUEUED_BYTES];
        tx.send(chunk.clone()).unwrap();
        assert_eq!(tx.send(chunk), Err(Overflowed));

        // Whatever is still queued is abandoned: the socket is going away.
        assert!(
            rx.next().await.is_none(),
            "the writer should stop rather than keep feeding a dead socket"
        );
    }

    #[tokio::test]
    async fn draining_makes_room_again() {
        // Backpressure, not a permanent ban: a client that keeps up keeps
        // going, however much has passed through it.
        let (tx, mut rx) = channel();
        let chunk = vec![0u8; MAX_QUEUED_BYTES / 2];
        for _ in 0..8 {
            tx.send(chunk.clone())
                .expect("a client that drains is never refused");
            rx.next().await.expect("the frame should arrive");
            assert_eq!(tx.queued(), 0);
        }
    }

    #[tokio::test]
    async fn two_halves_fit_but_a_third_does_not() {
        let (tx, _rx) = channel();
        let third = vec![0u8; MAX_QUEUED_BYTES / 2];
        assert_eq!(tx.send(third.clone()), Ok(()));
        assert_eq!(tx.send(third.clone()), Ok(()));
        assert_eq!(tx.send(third), Err(Overflowed));
    }

    #[tokio::test]
    async fn an_overflow_while_the_writer_is_busy_is_not_lost() {
        // The failure mode this guards: signalling with `notify_waiters`
        // alone wakes only tasks already parked, so an overflow landing
        // while the writer was mid-send disappeared and the socket limped on.
        let (tx, mut rx) = channel();
        let chunk = vec![0u8; MAX_QUEUED_BYTES];
        tx.send(chunk.clone()).unwrap();
        assert_eq!(tx.send(chunk), Err(Overflowed));
        // Nothing was waiting when that happened.
        assert!(rx.next().await.is_none(), "the overflow signal was lost");
    }
}
