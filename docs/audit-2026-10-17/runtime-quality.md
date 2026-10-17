# Pad runtime and automated-quality audit — 17 October 2026

Scope: current checked-out Pad runtime, terminal, toolchain dispatch, Python shims, synchronization boundary, and existing automated gates. No product code was changed. Tests are bounded and use synthetic inputs. Production tests use new anonymous pads, not existing users' data.

## Evidence and execution

| Check | Result | Interpretation |
|---|---|---|
| Deployed `user-check.mjs` | **110 checks passed**, exit 0, zero page errors | Includes input/EOF/Ctrl-C/Stop, terminals, file operations, 260-file import, persistence, Markdown sanitization, requests, Flask and scientific plotting. Raw output: `logs/live-user-check.log`. |
| Deployed `preview-check.mjs` | **28 checks passed**, exit 0 | Covers request/console inspection, methods, headers, cross-port navigation, separate cookie contexts, pop-out, service-worker recovery and stopped-server restart. Expected failed-request messages occur in deliberate negative cases. `logs/live-preview-check.log`. |
| Existing `scripts/perf/pad-visit.mjs` | One cold and one warm visit completed, exit 0 | Cold editor 4,622 ms, Run-to-output 21,767 ms; warm editor 2,043 ms, Run-to-output 2,196 ms. Warm second run 676 ms and autosave 753 ms. `logs/pad-visit.jsonl`. |
| Existing `PAD_ORIGIN=https://code.rishwanth.dev node pad/scripts/app-check.mjs` | Failed: 4 initial checks passed, first Run timed out after 180 s | On scratch `dusky-canyon-5391`, the service worker became controlling at 1,250 ms and editor, runnable starter, and tree loaded. Runtime reported failure downloading `wasmer/grep@=3.12.0`. This is one observed cold-start failure, not proof every visitor fails. Root's independent browser successfully ran Python and JavaScript. |
| Follow-up HEAD of grep's same-origin mirror | HTTP 200 | Manifest points the failed CDN hash at `/packages/e74d4e6e770e4b21.webc`; mirror was reachable afterward. Initial failure's cause was not isolated. No sustained outage claim is justified. |
| Local differential shim probes | 8 of 8 selected edge cases differ from GNU output; all return success | Real checked-in Python shims were run under CPython and compared to Git for Windows' GNU awk/sort. This establishes deterministic implementation errors; it does not exercise WASIX. One awk case was independently confirmed on production by root. |
| Local source-state probes | 4 additional classes reproduced | Toolchain parser, shell completion parser, filesystem diff read failure, and runtime initialization retry use the real source with minimal controlled dependencies. See distinction below. |
| `npm run typecheck` initially | Shared UI and web passed; Pad failed with 13 TS2307 errors | Local `node_modules` lacked newly declared formatters/jsonc-parser. Environment setup failure, not a production runtime defect. Dependency recovery and revalidation are recorded separately below. |
| Restored `npm run typecheck` | Passed, exit 0 | All three workspaces typecheck. `logs/typecheck-restored.log`. |
| Restored `npm run build` | Passed, exit 0 | Both web and Pad built from current sources. Pad bundle phase took 50.05 s; large-chunk warnings remain, not build failures. `logs/build-restored.log`. |
| `npm audit --omit=dev --json` | Exit 1: two moderate package groups; zero high/critical | DOMPurify and Monaco through DOMPurify. Advisory inventory is not proof of reachable exploitation; see dependency assessment below. |

Evidence: `logs/live-app-check.log`, `logs/runtime-shim-probes.json`, `logs/runtime-source-probes.log`, and root's `live-filename-failure.png` / `live-awk-failure.png`. Repro scripts: `runtime-shim-probes.py` and `runtime-source-probes.mjs`.

Dependency recovery: sandboxed npm clean-install failed on a locked optional `bufferutil` binding; the partial local install was fully restored with the exact lockfile using WSL npm and Windows package selection. Generated workspace junctions and npm command shims were restored for Windows. `npm-ci-wsl.log` confirms exit 0, 65 packages. WSL's older Node skipped an optional Windows Rolldown binding; that exact lockfile tarball was restored with SHA-512 verified, after which the full build passed. No source manifest or lockfile was changed. Browser suites use `windows-test-adapter.mjs` to select installed Edge instead of an unavailable exact Chromium bundle and Windows `python.exe` instead of `python3`; assertions are unchanged. These are audit-environment accommodations, not product defects.

Performance context: installed headless Microsoft Edge 155.0.4283.45 on the audit Windows machine, Playwright 1.63.0, unique empty scratch profile, one cold and one cached visit, pip benchmark disabled. The harness deliberately waited 5 seconds before the cold Run and 3 seconds before the warm Run, so landing-to-output totals (31,444 ms and 7,324 ms) include those waits. Run-to-output excludes them. Warm shell input echoes were 7–19 ms over 30 samples (median 10 ms), and three shell commands took 19–23 ms. These are useful observations, not a supported-device latency guarantee. The initial sandboxed attempt failed before browser interaction; the allowed retry produced the two valid samples. No stress, low-end-device or throttled-network benchmark was completed.

## Findings

### R1 — P1: awk silently computes incorrect numeric results

**Production confirmed.** `printf '3 4\n' | awk '{print $1 + $2}'` prints `34`, exits successfully, and should print `7`. Local differential probe also finds `$1 * 2` on `3` prints `33`, not `6`.

`pad/src/tools/awk.py:297` evaluates translated expressions directly in Python; `Field` at line 310 is a `str` subclass that overrides comparisons but not arithmetic. Python string concatenation/repetition therefore leaks into a command presented as awk. This is especially dangerous for data manipulation because it looks successful and produces plausible output. Support numeric operators correctly or explicitly reject unsupported arithmetic; test numeric/non-numeric fields, unary signs, decimals, precision, and mixed operands against real awk.

### R2 — P2: valid Python filenames fail under Run because filenames undergo shell expansion

**Production confirmed by root.** New file `cash$HOME.py` is accepted, filled with the normal Python starter, then Run exits 2: `can't open file '/workspace/cash.py'`. `pad/src/app.ts:2575` uses `JSON.stringify(this.active)` as shell quoting. JSON double quotes do not protect `$variable`, `$(...)`, or backticks from Bash. Other language runners already use single-quote shell escaping in `toolchains.ts`.

Use one shell-word quoting function consistently, and test `$`, backticks, single/double quotes, spaces, Unicode, and nested paths. The proven finding is a filename/run correctness defect; no host compromise is implied.

### R3 — P2: sort silently changes data and ordering under accepted options

**Local source differential confirmed.** All examples return exit 0.

| Input/action | Pad result | GNU result |
|---|---|---|
| Two input files: first `z` with no final newline; second `a\n` | one line `za` | separate sorted lines `a`, `z` |
| `sort -k2` on `a same z\nb same a\n` | original order | `b same a` first |
| `sort -n` on `-1\nword\n2\n` | `word`, `-1`, `2` | `-1`, `word`, `2` |
| `sort -n` on integers 9007199254740993 then 9007199254740992 | original descending order | ascending order |
| `sort -k2,2` on `z same\na same\n` | `z same` first | `a same` first |

Causes: `pad/src/tools/sort.py:158-162` concatenates whole input files before line splitting; line 120 ends an unspecified key at its first field; lines 136-138 convert numeric values to binary float and nonnumbers to minus infinity; line 172 has no whole-line fallback for equal keys. A small compatibility subset must still produce the right result for syntax it accepts.

### R4 — P2: awk accepts regular-expression field separators but treats them literally

**Local source differential confirmed.** `awk -F '[,:]' '{print $2}'` on `a,b:c` emits an empty field; GNU emits `b`. `pad/src/tools/awk.py:243` calls Python `str.split(fs)`. A regex-looking separator must work or be refused clearly. This is separate from arithmetic but shares the broader shim-compatibility risk.

### R5 — P2: quoting-unaware lazy toolchain detection triggers large unwanted downloads and misses valid commands

**Actual parser reproduced locally.** `neededBy("echo 'hello; go run main.go'", new Set())` requests the 273 MB Go package, despite the command only printing text. A quoted string containing `; node app.js` similarly requests Node's nominal 75 MB. Conversely `"node" app.js` and `env -i node app.js` do not request Node even though they execute it.

`pad/src/toolchains.ts:131-136` splits on shell punctuation without respecting quoting and skips prefix words without their options. `App.fetchFor` installs detected packages and replaces the shell. The false positive therefore costs download/startup time and also loses unexported shell variables/functions/custom aliases (`terminals.ts:184-210`). Do not reproduce the large Go download on production just to prove the parser; the source probe is sufficient. A real shell tokenizer with tests for quotes/escapes/heredocs is needed.

### R6 — P2: one transient runtime download failure poisons Run until the page reloads

**Actual method reproduced with a controlled failing loader; live cold download failure observed separately.** `pad/src/app.ts:1630-1663` stores the initialization promise with `this.runtime ??=` but never clears it after rejection. Source harness fails `Runtime.start` once, restores the simulated network, and calls again: both reject with the same error and the loader call count remains 1. The SDK import at `runtime.ts:129` similarly memoizes its loading promise.

The observed live app-check failure makes recovery particularly relevant, but the retry behavior itself was not exercised in that already-closed production tab. Failed initialization should leave an explicit retry path, release partial resources, and reset caches on failure. Test first-fetch failure followed by successful retry without losing edits.

### R7 — P2: terminal output can impersonate command completion

**Actual shell state machine reproduced with fake I/O.** `pad/src/shell.ts:146,415-445` accepts any stdout substring matching SOH + digits + SOH as completion. A running program that prints `\x010\x01` clears `busy` and resolves exit code 0 before the real process exits. The deterministic probe observed `busyBefore=true`, `busyAfter=false`, successful completion, and no process exit.

Consequences include premature synchronization, wrong exit state, subsequent terminal input going to a still-running process, and Stop no longer corresponding to actual activity. Binary/control-character output is legitimate in a terminal. Prefer a separate completion channel or at minimum a high-entropy per-command marker; test markers split across chunks and marker-looking user output. This is a correctness issue inside the user's browser sandbox, not evidence of escaping it.

### R8 — P2, conditional: an unreadable existing sandbox file is published as a deletion

**Actual diff reproduced with an injected transient read failure.** A listing returns existing `data.txt`; `readBytes` throws; the resulting change is `{path:'data.txt',content:null}`. `pad/src/sync.ts:157-160` skips every read error, then line 179 interprets omission from `next` as disappearance. The catch explicitly includes both disappearance and general unreadability, which require different outcomes.

Potential effect: unexpected shared-store deletion after I/O/race failures. A real WASIX permission/I/O trigger was not established during this audit, so classify as a deterministic error-handling defect with unmeasured production incidence, not observed live data loss. Preserve known state or abort publication when a listed file cannot be read; only delete after confirmed absence.

### R9 — P2, source inspection: failed requirements installation is persisted as already installed

`pad/src/app.ts:2426-2459` records `.deps/.installed-requirements.txt` even when pip returns nonzero, and sets `requirementsInstalled` before installation. A temporary package/network failure is consequently skipped on subsequent Runs and future visitors until `requirements.txt` changes. The terminal does explain this, but transient failure becomes persistent broken setup. This is explicit current behavior, not a hidden crash. Store successful completion separately from a failed attempt and offer retry. Not run live to avoid unnecessary package downloads.

## Runtime limits that materially constrain the product

These are documented product limits, not all defects:

- Every new visitor starts a substantial browser runtime, even readers (`app.ts:1603-1624`); the source quotes about 18.6 MB compressed baseline. Toolchains add nominal 66–273 MB before compression. Cold and cached use are very different experiences, especially on phones and metered connections.
- Python threads are explicitly blocked; `socketserver` threading becomes sequential; Flask reloaders are disabled; only compatible WASIX wheels/pure wheels install because pip uses a fixed platform and binary-only mode. This is not an unrestricted CPython development machine.
- C++ `<iostream>` does not finish compiling, Go modules do not work, Go built programs have reuse limitations, Lisp file execution is omitted. No git/make/ssh/vim/less; nano is a small custom editor. These limits are disclosed in `docs/use/pad.md:419-454`.
- Ctrl-C normally works, but some child processes can outlive forced shell termination and continue holding ports/CPU. Source and user guide explicitly acknowledge it (`shell.ts:595-647`, `docs/use/pad.md` “If a command hangs”). Reload may be needed to stop the sandbox; closure of one terminal is not a universal process-tree kill.
- A process's filesystem changes synchronize at command completion, not continuously. Long-running servers/background jobs complicate when changes become durable and visible.
- Each completed command recursively lists and reads every nonignored file to detect same-size edits (`sync.ts:140-179`). This is O(total content), including unchanged dependencies and binary base64 encoding. No large-pad latency benchmark was completed. It is a measurable scaling risk, not a measured speed regression.
- Scientific dependency persistence needs a dedicated reload check. The public WASIX NumPy wheel examined in `logs/science-wheel-count.json` contains 925 non-pyc files (22.16 MB unpacked), while Pad caps the entire saved tree at 500 files and includes `.deps` in synchronization. The source promises installed dependencies travel with the pad. The live scientific computation passed, but full dependency persistence after reload was not verified; wheel contents versus actual installed/published files must be reconciled before promising that behavior. This is a source/artifact incompatibility risk, not an observed failed reload.
- The actual local production build emitted Pad's editor bundle at 2,588.04 kB (671.47 kB gzip) and `monaco-languages` at 1,098.94 kB (280.76 kB gzip). These are individual build assets, not measured total initial transfer; lazy-loading/caching affect what any visit actually downloads.
- Terminal sessions have no explicit cap in the UI/source and share one browser sandbox. Many terminals, output floods, large compilers, and concurrent runs need resource-pressure testing. Do not load-test production to establish this.

## Automated-quality assessment

The test suite is unusually broad for a small product: real-browser terminal keystrokes, errors, persistence, file import/export, binary correctness, collaborative edits, accounts, role transitions, reconnect, preview isolation, and deliberately degraded conditions. Test documentation explicitly discusses false positives, stale builds, back-forward cache, race-sensitive assertions, and mutation validation. Those are strengths.

The coverage gaps remain material:

1. CI Pad jobs install and run Chromium on Ubuntu only (`.github/workflows/ci.yml:99-145`). This does not establish Safari, Firefox, iOS, Android, touch, IME, assistive technology, or old-browser behavior. Desktop viewport resizing is not mobile browser validation.
2. Heavy-language cases in `user-check.mjs:903` are behind `PAD_LANGUAGES`; `check.sh`/CI never set it. Much of scientific-package install behavior runs only with live `PAD_ORIGIN`; local user checks intentionally do not have the deployment network. These features need a dedicated reproducible gate.
3. `app-check.mjs` has substantial deployment/CSP/mirror checks but `check.sh`'s Pad gate calls browser/terminal/user and accounts/pair/preview; it does not call app-check. The `pad/package.json` `check` script does include app-check but omits accounts/pair/preview. There is no single npm command matching the complete documented gate.
4. The shim corpus checks ordinary values and a few flags but misses elementary arithmetic and line-boundary semantics. Differential tests against reference tools should systematically cover every advertised option and combinations, not just convenient examples.
5. Quote handling and unusual-but-valid filenames lack adequate end-to-end coverage. The production `cash$HOME.py` failure is an ordinary file operation.
6. Process termination, runtime download retry, transient file-read failure, and control-character output need direct regression tests. Mocked failures should be complemented with browser integration where possible.
7. Existing benchmark `typing-perf.mjs` is observational, not a gate. No audited latency budgets, memory ceilings, mobile resource budgets, soak/concurrency tests, or deployment rollback/backup restoration results were established here.
8. `browser-check.mjs:45` spawns a relay using URL `.pathname` and lacks the Windows `.exe` suffix, while app-check handles both correctly. Some Windows dev/test workflows are less portable than production's browser-facing claim.

## Production-dependency advisory assessment

`logs/npm-audit-production.json` records npm's current registry advisory response. Two affected package groups are reported: `dompurify` (moderate) and `monaco-editor` through DOMPurify (moderate). This does **not** mean two independent product exploits or that every advisory in the combined DOMPurify record applies to every installed version.

Pad directly pins DOMPurify 3.4.8; Monaco 0.55.1 also brings an older 3.2.7. The Pad Markdown path dynamically imports the direct 3.4.8 copy, uses the HTML profile, forbidden tags/attributes, named-property sanitization and `RETURN_DOM_FRAGMENT`, plus a restrictive class hook. Advisories involving `IN_PLACE`, caller-controlled configuration, custom elements, hook mutation or trusted-type output require their stated preconditions. No live XSS was demonstrated in this audit. The older Monaco copy needs its own renderer/hover reachability review. Update compatible sanitizer/editor versions in a dedicated change, inspect the specific applicable advisory prerequisites, and rerun Markdown/hover/CSP regressions; do not apply an unreviewed `npm audit fix --force`.

Representative primary advisory links from the actual npm response: [DOMPurify XSS affecting 3.1.3–3.3.1](https://github.com/advisories/GHSA-v2wj-7wpq-c8vv), [configuration pollution](https://github.com/advisories/GHSA-cmwh-pvxp-8882), [IN_PLACE hook-removal issue](https://github.com/advisories/GHSA-55q2-fjhq-7xh7). They support a dependency-maintenance finding, not a claim that these paths were exploitable in the deployed product.

## Scoring of this area

| Dimension | Current | Plausible after targeted work | Basis |
|---|---:|---:|---|
| Common Python edit/run experience | 7/10 | 9/10 | Root's live workflows succeed; unusual filenames and cold failure recovery remain brittle. |
| Terminal/tool compatibility | 4/10 | 8/10 | Useful command set, but silently wrong accepted operations undermine trust. |
| Runtime resilience | 5/10 | 8.5/10 | Good error/stop handling for common cases; sticky initialization failures and process descendants remain. |
| Performance predictability | 5/10 | 8/10 | Lazy heavy tools help, yet baseline downloads, false-positive installs, full-folder diffs and device coverage remain. |
| Automated assurance | 7/10 | 9/10 | Deep scenario coverage, but one browser family, optional-language gaps, and weak shim edge-case coverage. |

Scores are qualitative audit judgments, not measured probabilities of failure. A finite test run cannot prove zero errors for every user/action/device.
