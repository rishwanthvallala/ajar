// A link of a set length, for the ajar perf lab (ajar-lab.mjs): a TCP proxy
// that holds everything it carries for `delay` milliseconds each way and, if
// asked, sends no faster than `mbit`. One stands between the host's agent and
// the relay and another between the guest's browser and the relay, so a
// number changes because the code did and not because the office network did.
//
// It is a relay of bytes, not a network: each side's TCP ends here, so what
// depends on the far end's acknowledgements — Nagle's algorithm holding a
// small write back — is not in the lab's numbers. Production's are measured
// once for that (`live`).
import { connect, createServer } from "node:net";

/** One direction of one connection: everything written `delay` ms after it was read, in order. */
function carry(from, to, delay, bytesPerMs, state) {
  const queue = [];
  let timer = null;
  let free = 0; // when the line is next free, for a rate
  const drain = () => {
    timer = null;
    const now = performance.now();
    while (queue.length && queue[0].at <= now + 0.5) {
      const { chunk } = queue.shift();
      if (chunk === null) to.end();
      else if (!state.cut && !to.destroyed) to.write(chunk);
    }
    if (queue.length) timer = setTimeout(drain, Math.max(0, queue[0].at - performance.now()));
  };
  const push = (chunk) => {
    const now = performance.now();
    let at = now + delay;
    if (bytesPerMs && chunk) {
      const start = Math.max(now, free);
      free = start + chunk.length / bytesPerMs;
      at = free + delay;
    }
    if (queue.length) at = Math.max(at, queue[queue.length - 1].at);
    queue.push({ at, chunk });
    if (!timer) timer = setTimeout(drain, Math.max(0, at - now));
  };
  from.on("data", push);
  from.on("end", () => push(null));
  return () => {
    clearTimeout(timer);
    queue.length = 0;
  };
}

/**
 * Listen on `port` and carry to `target` (a port on this machine).
 * `delay` is one way, in milliseconds; `mbit` a rate each way, or none.
 */
export function link({ port, target, delay = 0, mbit = 0 }) {
  const state = { cut: false };
  const open = new Set();
  const bytesPerMs = mbit ? (mbit * 1e6) / 8 / 1000 : 0;
  const server = createServer((down) => {
    if (state.cut) return down.destroy();
    const up = connect(target, "127.0.0.1");
    down.setNoDelay(true);
    up.setNoDelay(true);
    const stops = [carry(down, up, delay, bytesPerMs, state), carry(up, down, delay, bytesPerMs, state)];
    const pair = { down, up };
    open.add(pair);
    const end = () => {
      for (const stop of stops) stop();
      down.destroy();
      up.destroy();
      open.delete(pair);
    };
    down.on("error", end);
    up.on("error", end);
    down.on("close", end);
    up.on("close", end);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject).listen(port, "127.0.0.1", () =>
      resolve({
        port,
        /** The line goes dead: what is open is dropped, and nothing new is taken. */
        cut() {
          state.cut = true;
          for (const { down, up } of open) {
            down.destroy();
            up.destroy();
          }
        },
        restore() {
          state.cut = false;
        },
        close() {
          for (const { down, up } of open) {
            down.destroy();
            up.destroy();
          }
          return new Promise((done) => server.close(done));
        },
      }),
    );
  });
}
