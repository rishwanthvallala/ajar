# Running the compute in the browser

*Feasibility note — September 2026. Revisits the "personal tier" that was cut
during the foundation audit, against a specific proposal: no agent, no relay,
files on the server, compute in a WASM container in the client.*

**It was built. It is live at [code.rishwanth.dev](https://code.rishwanth.dev),
and this note's conclusion was right for the wrong reason** — see the postscript
at the end. [`docs/dev/pad.md`](../dev/pad.md) describes what exists;
[`personal-tier.md`](personal-tier.md) is the design that came out of this.

---

## The short answer

**It is possible, and it already exists.** StackBlitz has shipped exactly this
architecture for years. The question is not whether it can be done — it is what
you give up, and whether what is left is still ajar.

The proposal describes a real, coherent system. It is also a *different
product*, and it does not remove the server. Both of those are worth being
precise about before deciding anything.

---

## What actually stops a browser from being a machine

Four walls. The first two are why "your real toolchain" becomes impossible.
The third is why the link stops working. The fourth is the one the proposal's
framing misses entirely.

### 1. There is no `fork` and no `exec`

A shell is a process factory. Every command you type is a new process. WASI
Preview 2 — the current standard interface — **does not support `fork`,
`exec`, or threads**, and this is deliberate rather than unfinished: the
Component Model's typed interface composition is the intended replacement for
the process model. Threads are not expected on a timescale shorter than years.

So `bash` does not run. Nor does anything that shells out, which is most build
tooling. `npm` spawns processes. `cargo` spawns `rustc`. `make` spawns
everything.

There are two escapes, and both are somebody's private fork of the world:

- **WASIX** (Wasmer) adds threads, signals and `fork` back on top of WASI
  Preview 1 as a non-standard superset.
- **WebContainers** (StackBlitz) sidesteps it by not being POSIX at all —
  a Node-shaped runtime with its own virtual process model, written from
  scratch.

Neither is a standard you can build on and expect to still work in three years.

### 2. Your binaries are the wrong machine code

The toolchain on your laptop is x86 or ARM. WASM runs neither. Every single
program a guest might invoke has to have been *recompiled to WASM by someone*,
and shipped to the browser.

That turns "a guest gets your toolchain" into "a guest gets the subset somebody
ported." In practice that means Node and Python, because those two have had
serious porting effort. It does not mean:

- the system compiler, or anything that links against a native library
- CUDA, or any GPU work at all
- Docker, or anything that needs a kernel
- a binary you downloaded from a GitHub release
- your half-broken dependency that only works on your machine — which is
  frequently the entire reason someone wants to show you their screen

The general-purpose escape is to emulate a CPU. `container2wasm` (CNCF Sandbox
since January 2025) converts container images by running a Linux kernel on an
emulated CPU compiled to WASM — QEMU now compiles to WASM via Emscripten with a
JIT backend. `CheerpX` does x86-to-WASM JIT and boots real Debian, streaming a
disk image up to 2 GB on demand into IndexedDB.

These genuinely work. They are also emulation, and emulation of a CPU is
between one and two orders of magnitude slower than the silicon under your
desk. For a terminal demo that is fine. For `cargo build` it is not.

### 3. A browser cannot open a socket

WASM in a page gets `fetch`, WebSocket and WebRTC. It does not get TCP.

That means every one of these needs a server-side proxy to work at all:

| What a guest tries | What it needs |
|---|---|
| `npm install` | CORS-friendly registry proxy |
| `git clone` over SSH | impossible — SSH is TCP |
| `psql` to the team database | TCP proxy, holding the credentials |
| the dev server they just started | a service worker to intercept it |

There is an escape — Chrome's **Direct Sockets API** gives real TCP and UDP.
It is available only to **Isolated Web Apps**, which must be *installed* and
run from a generated `isolated-app://` origin under a strict CSP.

That is fatal for this product specifically. The entire wedge is *here is a
link, open it*. An install step that exists on one browser is not a link.

### 4. The server does not go away — it gets bigger

This is the part the proposal's framing gets backwards. "On the server we store
files" **is a server**. And once you have committed to that, you also need:

- a package proxy, from wall 3, or nothing installs
- durable storage, with accounts and quotas, because files now live there
- a transport for collaboration, because two browsers still cannot talk
  directly without something in the middle

Compare what that replaces. The relay today is **1,500 lines**, has no
database, holds no plaintext, never sees a key, and a restart dropping every
session is *correct* rather than merely tolerable. It reads nine bytes of each
frame and forwards the rest.

The WASM version needs a file store, an auth system, a package proxy, and
backup. It can read your source. It is a product with an ops burden, not a
router.

> The relay is dumb **because** the agent is smart. Take the agent away and the
> server has to become smart — that is a conservation law, not a design choice.

---

## What you would genuinely gain

Not nothing. The honest list:

- **Zero setup on both sides.** No install for the host either, which is a real
  simplification over `curl | sh`.
- **Nobody lends their machine.** Compute is the guest's own CPU, in their own
  tab. The trust conversation disappears entirely.
- **The best sandbox on earth.** The browser origin sandbox has had two decades
  and a billion dollars of adversarial attention. `sandbox.rs` is 758 lines and
  leans on two OS mechanisms, one of which Apple has deprecated with no
  replacement.
- **It works when the host is offline**, which is the one case ajar currently
  handles poorly.

That last point is the interesting one, and I come back to it below.

---

## What it costs against the thing ajar promises

The pitch is *a guest gets your machine.* Every clause of that is load-bearing,
and the WASM tier deletes all of them:

| ajar today | Browser WASM |
|---|---|
| Your Rust version, your `node_modules`, your caches | A curated runtime someone ported |
| Your GPU | No GPU |
| Your database connection, your VPN, your `/etc/hosts` | No sockets |
| The bug reproduces because it is *your* machine | A clean room where it may not reproduce |
| Files never leave your disk unless you sync them | Files live on the server by design |

And the specific use case you said made this project interesting — *a teacher
with a GPU server shares its compute for an afternoon, zero setup* — is not
merely degraded here. It is **impossible**. There is no GPU to share, and no
mechanism by which a browser tab could reach one.

That is the same conclusion the foundation audit reached, and the research
above does not weaken it.

---

## Where it does fit

There is a real gap this could fill, and it is narrow and specific.

**Today, when the host closes their laptop**, guests fall back to the sealed
snapshot on the relay: they can read the files and nothing else. The session is
a museum. That is the weakest moment in the product, and it happens constantly
— lunch, a commute, a lid.

A WASM runtime would make that fallback **runnable** for the project types it
can handle. "The host is away, but you can still run the tests" is a genuinely
good answer, and it is additive: it compromises nothing about the core promise
because it only operates when the core promise is already suspended.

Scoped that way, it is tractable:

- **Python** — Pyodide is mature, ~10 MB, and covers the classroom case well.
- **Node** — WebContainers is the only serious option and it is *licensed*.
  Free for open source and personal use; commercial use needs an agreement,
  commercial StackBlitz plans cap at 500 sessions/month, and self-hosting is an
  enterprise arrangement. That is a dependency on another company's business
  model sitting directly under your core loop.
- **Anything else** — emulation, at emulation speed.

---

## Recommendation

**Do not build it as a replacement tier.** The proposal is architecturally
sound and would produce a working product — it would just be StackBlitz, which
exists, is better resourced, and has a five-year head start on the hard part.

**Do not build it next, either.** The retrospective already named the most
urgent hole, and it is still open: **preview URLs**. A guest runs `npm run dev`
and cannot see the thing they started. That is a hole in the loop that already
works, it serves exactly the same users, and it is a fraction of the cost.

**Revisit the offline case after that**, scoped to "make the snapshot runnable
for Python," and only if real sessions show people hitting the host-offline
wall often enough to matter. That is a question the usage answers, not one to
decide in advance.

The one test that settles more than any of this is still the same one: use it
with a colleague, on a real bug, twice.

---

## Sources

- [WASI Preview 2 vs WASIX (2026)](https://wasmruntime.com/en/blog/wasi-preview2-vs-wasix-2026) — no fork/exec/threads in Preview 2; WASIX as the non-standard superset
- [WASI and the WebAssembly Component Model: Current Status](https://eunomia.dev/blog/2025/02/16/wasi-and-the-webassembly-component-model-current-status/) — the process model is deliberately not coming back
- [Commercial Usage | WebContainers](https://webcontainers.io/enterprise) and [StackBlitz Terms](https://stackblitz.com/terms-of-service) — licensing, session caps, self-hosting
- [container2wasm](https://medium.com/nttlabs/container2wasm-converter-running-linux-based-containers-on-wasm-and-browser-2dd90a18cc9a) and [CNCF Atlas entry](https://kanywst.github.io/cncf-atlas/tools/container2wasm/) — CPU emulation, QEMU-to-WASM, recommended target architectures
- [CheerpX 1.0](https://labs.leaningtech.com/blog/cx-10) — x86-to-WASM JIT, 2 GB streamed disk images
- [Direct Sockets | Isolated Web Apps](https://developer.chrome.com/docs/iwa/direct-sockets) — raw TCP requires an installed IWA

---

## Postscript: what happened

This note answered "can WASM replace ajar's model" and concluded no. That was
right, and it was answering a question nobody had asked. The narrower one —
*a separate, small product with pinned binaries and no socket* — was viable,
and is now running.

Of the four walls above, only one stood as written.

**No `fork`/`exec`** was the wrong wall. That is WASI Preview 2; WASIX has
threads, fork, exec, pipes and TTY, and a real bash runs in a tab. What
actually bites is smaller and stranger: bash functions define and then hang
when called, ctrl-c kills the shell rather than the command, and there is no
canonical mode so ctrl-d sends no EOF.

**Wrong machine code** stood, exactly as described. The binary set is what
somebody ported, it is pinned, and the gaps are real — no `git`, no `make`, no
compiler, and awk had to be written in Python.

**No sockets** stood and cost nothing, because pre-downloading the binaries is
what removes `npm install` from the critical path. It does mean no `pip
install` and no `git clone`, permanently.

**"The server does not go away"** was the most useful paragraph here and still
understated it. The relay grew a durable store — the one persistent thing in a
binary whose whole design is that a restart losing everything is correct — plus
an origin of its own, cross-origin isolation headers, and 73 MB of mirrored
packages to serve. The conservation law held: the agent went away and the
server grew.

The estimate that was wrong in the reader's favour: Pyodide is 5 MB, not ~10.
The one wrong against it: WASIX python is 59 MB alone but 73 MB with the
dependencies a real shell drags in — about 16 MB once compressed and served
from an origin that bothers to compress it, which Wasmer's CDN does not.

---

## Second postscript, 16 September 2026

*Appended, not edited. The text above is what was believed at the time.*

**The sockets wall has since fallen, and the word "permanently" was wrong.** A
pad can `pip install` from PyPI as of 15 September 2026.

The reasoning above was right about browsers and wrong about the runtime: the
Wasmer SDK ships a WISP client, which carries TCP over a single WebSocket, and
what actually stood between the pad and a socket was **two unresolvable module
specifiers** — one that assumed a bundler, and one node built-in the package
expects a bundler to substitute. Both are a few lines of build configuration.

What the wall was really made of was the second half of the sentence: the
endpoint. Carrying somebody's TCP means running a proxy with your IP as the
exit, which is a decision about abuse rather than a technical limit. The answer
was an allowlist — PyPI on 443 and nothing else — which is narrow enough to be
defensible and wide enough to make `pip install` work.

So the honest correction is: *no sockets* was never the wall. *No one had
decided whose network it would be* was. See
[`../dev/networking.md`](../dev/networking.md).

The `git clone` half of that sentence still stands, for the reason the body
gives — git is 85 MB of binary nobody has decided to ship, and the network was
never what stopped it.
