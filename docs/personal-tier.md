# The personal tier

*Design notes, September 2026. A second product on the same domain: a browser
scratchpad with a real shell, no install, no account, no machine involved but
the one you are sitting at.*

---

## What this is

Open a URL. Paste something. Run it. Share the link.

That is the whole product. The compute runs in your own tab as WebAssembly, so
there is no agent, no host machine, and nothing to lend. The server stores
files and serves `.wasm` packages — it never executes anything.

**It is not ajar.** ajar shares *someone's actual machine*: their toolchain,
their GPU, their database connection, and the bug that only reproduces there.
This shares nothing but files, and runs them in a clean sandbox with a
documented set of binaries. The two products answer different questions and
sit on the same domain because the audience overlaps, not because the
architecture does.

---

## The north star: instant usability

The benchmark is **rustpad.io**. You open it and you are typing. No signup, no
project wizard, no "choose a template", no decision of any kind before the
thing is useful.

The primary loop, stated plainly, because it should drive every decision below:

> **Paste → Run → Look at the output.**

Not "write a program from scratch." The realistic session is: you have Python
in your clipboard — often written with an AI's help — a CSV or three, and you
want the transformed output. Everything in the interface should be in service
of that, and anything that delays the first paste is wrong.

### What this rules out

This constraint kills the claim-flow we designed in conversation, at least as
the default path. Asking someone to pick a name and press a lock toggle before
they can type is exactly the friction rustpad does not have.

**Resolution — two paths, and the fast one has no decisions in it:**

| Path | What happens |
|---|---|
| **Fast** (the default) | Landing on the site mints a random name, claims it for you silently, and puts you in a focused editor. You are pasting in under a second. |
| **Vanity** (deliberate) | You type `/demowork` yourself. If it is free you are offered the claim explicitly; if it is taken you are told so. |

The claim still happens on the fast path — it just happens *for* you, rather
than being a thing you are asked about.

---

## Decisions locked so far

### Runtime: Wasmer SDK + WASIX

`@wasmer/sdk`, open source, from npm. WASIX is Wasmer's POSIX superset over
WASI Preview 1, adding **threads, fork, exec, pipes and TTY** — the things
standard WASI deliberately omits and the things a shell cannot work without.
`wasmer.sh` already runs bash, Python, ffmpeg and clang in a browser tab, so
this is a shipping capability rather than a bet.

**What it costs:**

- **Cross-origin isolation.** Threads need `SharedArrayBuffer`, which needs
  `COOP`/`COEP` headers on the document. This is per-document, so it must live
  on a **separate origin** from the ajar session client — otherwise that client
  inherits the isolation and every cross-origin thing it loads needs `CORP`
  headers or fails silently.
- **A non-standard dependency.** WASIX is Wasmer's extension, not a committee
  standard, and WASI Preview 2 is explicitly not going in this direction — the
  Component Model replaces the process model rather than completing it. If
  Wasmer stops, this stack stops. That is an accepted risk, not an oversight.

### Files: plaintext on the server

ajar sessions stay end-to-end encrypted. Personal folders do not.

The URL is the clean one — `ajar.rishwanth.dev/demowork` — which means the
server can read what you store. That is the right trade for scratch work and
CSVs and the wrong one for secrets, and the interface has to say so rather
than letting the ajar brand imply an encryption story that does not apply here.

**The relay's existing snapshot store cannot be reused.** It is in-memory, it
is attached to a live session, and `host_gone` calls `sessions.remove(id)` —
the files die with the host by design, and "a restart drops everything" is
stated in that code as *correct* rather than tolerable. This tier needs the
opposite: durable storage, no host, indefinite lifetime. That is new
machinery.

It is small machinery, though. A blob keyed by name, a cap around 25 MB, and
no accounts on the read path.

### Edit rights: a token in the fragment

Consistent with how ajar already thinks — **the link is the capability, and
the secret part lives in the fragment where browsers never transmit it.**

```
yours    ajar.rishwanth.dev/demowork#e=k3f9x2…     bookmark this
shared   ajar.rishwanth.dev/demowork               send this
```

Same rule on both paths: the edit token is always in the fragment, the
shareable link is always the bare path. Lose the fragment and you lose write
access, with no recovery — which is acceptable only if the interface is blunt
about it at the moment the folder is created.

---

## Claim, lease, account

Anonymous claims are **leases**. A week, renewable by visiting. Accounts make
them permanent, with a per-account cap on locked names, and paid tiers above
that cap.

This is the first revenue mechanism anywhere in the project. Phase 3 — org
hosts, accounts, billing — was never built for ajar, so the side product would
ship billing before the main one does.

The lease is also self-cleaning: abandoned scratch folders age out without
anyone having to decide anything.

### Four fixes folded in

**1. Names are never reused.** This is the important one.

The failure it prevents: you share `/demowork` in a tutorial, the lease lapses
a week later, someone else claims the name, and everyone holding your link
now lands on a stranger's files. If stored HTML ever rendered, that is a
phishing page on your domain with your reputation behind it.

So expiry deletes the **content** and tombstones the **name**. `/demowork`
afterwards says "this expired" forever. A name is about twenty bytes; keeping
every one ever issued is free next to the class of problem it removes.

**2. Claiming is a POST, never a GET side effect.**

Slack, iMessage, WhatsApp and Twitter all fetch a URL to unfurl it, and
crawlers fetch everything. If merely *opening* a name claimed it, a link
preview bot would take the name before your recipient saw the page. Opening
reports that a name is free; an explicit action takes it.

**3. Lease state has to be durable, and IP limiting is a speed bump.**

`quota.rs` is `Mutex<HashMap<IpAddr, Caller>>` and its own header says it does
not survive a restart. That is correct for 45-second sessions and useless for
week-long leases — this state belongs in the durable store.

And IP as identity is weak in both directions: CGNAT puts thousands of real
users behind one address, so a strict limit blocks an entire ISP, while a VPN
defeats it in one click. Worth having to stop casual bulk-claiming. Not worth
believing in.

**4. Stored files are never served as HTML.**

By construction in this design, files are fetched by JavaScript and mounted
into the WASM filesystem — they are never a browsable web root. That property
is worth protecting deliberately, because the day `…/name/index.html` renders
is the day this is hosting arbitrary user HTML on the product's domain.

### Reserved names

`/ws`, `/healthz`, `/install.sh`, `/run.sh` and `/j/*` are already taken, and
a bare path currently falls through to the SPA. A reserved list has to exist
**before** the first claim, not after — it cannot be added retroactively once
someone owns `/api`.

---

## What is reusable from ajar

More than expected. The session client already is an editor, a file tree and a
terminal sharing one window.

| From `web/src` | Reuse |
|---|---|
| `style.css` (587) | **Direct.** The layout, the splitter, the zoom-safe sizing. |
| `viewer.ts` (167) | **Direct.** Monaco setup and the language map, already trimmed to `editor.api`. |
| `tree.ts` (220) | **Direct.** Virtualised, takes an entry list — only the data source changes. |
| `scale.ts` (31) | **Direct.** |
| `main.ts` (851) | **Partial.** Layout and wiring survive; everything relay-shaped does not. |
| `editing.ts` (218) | **Later.** The Yjs binding is only needed if this becomes multiplayer. |
| `connection.ts`, `proto.ts`, `sealed.ts` | **No.** All relay-specific. |

xterm.js is already wired for terminal output, and a WASIX shell writes to it
exactly the way a pty does.

---

## Open questions, in the order they should be answered

Each of these changes what gets built. None of them is decided.

1. **Where does the shell's filesystem actually live at runtime?** The WASM FS
   is in memory. Does it write through to the server on every change, on a
   debounce, or only when you press something? ajar's `docs.rs` already solved
   this shape once with a 400 ms debounce — the reasoning transfers, the code
   does not.

2. **What is in the binary set, and how is a version pinned?** Python is the
   obvious first one. Which coreutils? Does `pip install` exist at all, given
   there are no sockets — or is the answer a pre-baked wheel set, documented?

3. **How big is the first load?** Pyodide alone is ~10 MB. Instant usability
   and a 10 MB download are in direct tension. Does the editor open before the
   runtime is ready, with the shell arriving late?

4. **What does "run" mean in the interface?** A button, a keystroke, or a
   shell prompt you type into? The paste-run-look loop wants the fewest
   possible actions between clipboard and output.

5. **Does output write back into the folder?** The transform generates
   `out.csv` — is that now part of the shared folder, or does it live only in
   the tab that made it?

6. **What happens when a visitor runs it?** They have no edit token. Their run
   has to go somewhere, and "nowhere" is a legitimate answer.

7. **Account system: build or buy?** This is the first one in the project. It
   is also the thing most likely to consume a month if built from scratch.

8. **Does this share a domain, a subdomain, or a separate name?** Cross-origin
   isolation forces at least a separate origin. Whether it shares branding is
   a different question.

---

## Shape of a v0

Enough to test whether the loop is worth anything, and nothing more:

- One page, separate origin, `COOP`/`COEP` set.
- Landing mints a random name and drops you in a focused editor.
- Python only. No vanity names, no accounts, no leases — everything expires in
  a week, full stop.
- Files in a server blob, capped small.
- One editor pane, one output pane, one run action.
- Share copies the bare URL.

If pasting a transform and getting a CSV back is not obviously useful at that
size, none of the machinery above will save it.
