# Unified UI baseline (UI-00)

Captured: 13 September 2026

Branch: `feature/ui-improvements`

Starting commit: `7d202a8`

Working tree before UI-00: clean

This report is the starting evidence for the React/shared-UI migration in
[unified-ui-plan.md](unified-ui-plan.md). A passing reproduction command below can mean
that a known defect was successfully reproduced; it does not automatically mean the
product behavior is correct.

## Environment

| Item | Baseline |
| --- | --- |
| Host | Windows; repository at `D:\ajar\ajar` |
| Required frontend runtime used | Bundled Node `24.19.0`, npm CLI `10.5.0` |
| System Node | `20.12.2`; below the current Vite engine requirement and not used for results |
| Layout browser | Installed Microsoft Edge through Playwright |
| Rust | `cargo` and `rustc` not found |
| Relay binary | `target/debug/ajar-relay.exe` absent |
| Docker | Client `27.2.0` present; daemon pipe unavailable |
| WSL | Distribution enumeration unavailable in this execution environment (`E_ACCESSDENIED`) |
| Pad package mirror | `pad/public/packages/manifest.json` absent |

On this machine Node 24 is invoked as:

```powershell
& "C:\Users\tanuj\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" <script>
```

The system npm installation supplies npm CLI 10.5.0. UI-01 should make the normal
root `npm ci`/`npm run ...` commands select a supported Node version without relying on
this machine-specific command.

## Check results

| Check | Result | Evidence and interpretation |
| --- | --- | --- |
| Ajar TypeScript and production build | Passed | `cd web && npm run build`; Vite 8.2.2 transformed 917 modules. |
| Pad TypeScript | Passed | `cd pad && npx tsc --noEmit`. |
| Pad production build | Passed | `cd pad && npm run build`; Vite 7.3.6 transformed 740 modules and retained both `index.html` and `check.html` entries. |
| Ajar layout/browser suite | Passed | Development server on 5173 plus production preview on 5174, then `npm run test:layout` with the production URL. It covered lifecycle, resizing, four viewports, drawer focus, preferences, preview isolation, lazy loading, and disposal. |
| Ajar production preview gate | Passed | Included in the layout suite: `?preview=workspace` served by the production build renders the normal landing screen. |
| Focused review reproductions | Passed as a defect reproduction | `node scripts/review-repros.cjs` printed all eight expected `REPRODUCED` results. These are existing defects R01, R06-R08, R13-R15, and R24, not green product behavior. |
| Pad development server | Failed, pre-existing/environmental | Node 24/Vite 7 on port 5175 failed with `EBUSY` while watching `pad/public/vendor/wasmer/dist/browser-worker.js.map`, matching the 12 September review. The production preview server works because it does not watch that tree. |
| Ajar real host/relay smoke checks | Unavailable | No Rust toolchain or built agent/relay. The simulated WebSocket coverage in `test:layout` is not backend evidence. |
| Pad `browser-check.mjs` and `app-check.mjs` | Unavailable | Both spawn `target/debug/ajar-relay`; real runtime coverage additionally needs the mirrored packages, Playwright Chromium, cross-origin isolation, and network access for first-time package capture. |
| `scripts/check.sh`, Rust tests, Clippy, sandbox tests | Unavailable | `cargo`/`rustc` are absent; the Docker daemon and usable Linux/macOS environment are unavailable. |
| Docker build/start | Unavailable and known broken | Docker daemon unavailable. Review R11 already traces missing Docker build input and unwritable default Pad storage. |
| Deployment/production | Not run | UI-00 does not authorize deployment; no live infrastructure or credentials were tested. |

The Ajar build retains two expected warnings: `sealed.ts` is both statically and
dynamically imported, and Monaco's editor API chunk exceeds the 500 kB warning
threshold. Both warnings predate the migration. The development server also relayed
`[yjs] Tried to remove event handler that doesn't exist` after the completed layout
run; the suite still passed, so treat that teardown warning as baseline noise to
investigate if React lifecycle work changes or amplifies it.

## Build output baseline

Measured after the successful production builds:

| Output | Files | Bytes | MiB |
| --- | ---: | ---: | ---: |
| `web/dist` | 89 | 3,871,516 | 3.69 |
| `web/dist/assets` | 88 | 3,871,118 | 3.69 |
| `pad/dist` | 52 | 8,321,497 | 7.94 |
| `pad/dist/assets` | 11 | 3,304,087 | 3.15 |
| `pad/dist/vendor/wasmer` | 39 | 5,015,505 | 4.78 |

The Pad totals do **not** include the approximately 70 MB runtime package mirror,
because `pad/public/packages` is absent in this checkout. Ajar's largest emitted asset
is `editor.api` at 2,620.48 kB (671.11 kB gzip); Pad's equivalent is 2,548.46 kB
(658.45 kB gzip). UI-07 should compare initial-route loading and total deployment
outputs separately so copied Wasmer assets do not conceal application-bundle growth.

## Resolved dependency versions

| Package | Ajar (`web`) | Pad |
| --- | --- | --- |
| Vite | 8.2.2 | 7.3.6 |
| TypeScript | 7.0.2 | 5.9.3 |
| Playwright | 1.62.1 | 1.60.0 |
| Monaco | 0.56.0 | 0.55.1 |
| xterm | 6.0.0 | 5.5.0 |
| xterm fit addon | 0.11.0 | 0.10.0 |
| Yjs | 13.6.32 | 13.6.32 |
| y-protocols | 1.0.7 | 1.0.7 |
| Wasmer SDK | n/a | pinned 0.11.0 |

These are installed/resolved versions, not only manifest ranges. UI-01 may add React
without forcing Monaco, xterm, Vite, TypeScript, or Wasmer convergence.

## Visual baseline and behaviors to preserve

Local screenshots were captured under `web/artifacts/ui-00-baseline/` (ignored by
Git):

- `workspace-light.png`, `workspace-dark.png`, `workspace-mobile.png`, and
  `workspace-zoom-200.png` were produced by the existing Ajar layout suite.
- `pad-desktop.png` and `pad-mobile.png` were produced from the Pad production build
  with only the initial store read stubbed to an empty Pad. They are visual evidence,
  not execution, persistence, or peer-integration evidence.

The Ajar baseline to preserve is the behavior recorded in
[workspace-layout-validation.md](workspace-layout-validation.md): a persistent editor,
60/40 initial editor/terminal split, bounded pointer and keyboard resizing, narrow
Files drawer with focus cleanup, safe and isolated preferences, lazy Monaco loading,
late-message cancellation, persistent terminal input, simulated connection updates,
light/dark themes, and 200% zoom coverage.

The Pad desktop capture shows the existing three-region layout and starter Python
file. At 390x844 the fixed files column remains visible while editor content clips
horizontally; responsive Pad behavior is therefore not an existing guarantee and must
not be reported later as a migration regression. UI-05 is expected to improve Pad by
using the shared narrow-screen shell.

## Current commands

These are the commands available before UI-01; the root commands in the master plan do
not exist yet.

### Ajar browser

```sh
cd web
npm ci
npm run dev
# open http://127.0.0.1:5173/?preview=workspace

npm run build
npm run test:layout       # needs the development server

# optional production-preview gate
npm run preview -- --port 5174
AJAR_PRODUCTION_URL=http://127.0.0.1:5174 npm run test:layout
```

`VITE_RELAY=ws://127.0.0.1:8787/ws npm run dev` points Ajar development at a local
relay. Real Ajar use additionally requires:

```sh
cargo run -p ajar-relay -- --bind 127.0.0.1:8787
cargo run -p ajar -- /path/to/project --relay http://127.0.0.1:8787
```

### Pad

```sh
cd pad
npm ci
npx vite build
node scripts/fetch-packages.mjs   # first-time package mirror; real browser/runtime/network
npm run dev

# in another terminal
cargo run -p ajar-relay -- --bind 127.0.0.1:8787 --pad-dir ./ajar-pads

npm run check                    # typecheck, build, and both browser suites
```

The documented Pad development setup does not currently work end to end: Vite has no
`/api` or `/ws` proxy (review R22). UI-01 must add those proxies and use port 5175.

### Repository gate

```sh
./scripts/check.sh
```

This gate requires a Rust toolchain plus installed `web` dependencies, runs Rust
format/Clippy/tests, only Ajar's TypeScript check, builds Rust binaries, and then runs
the hosted-session smoke and acceptance scripts. It currently omits Pad (review R27).

## Installation and selector assumptions UI-01 must repair

### Package layout

- `Dockerfile` copies only `web/package.json` and `web/package-lock.json`, runs `npm ci`
  in `/w`, and builds only Ajar.
- `.github/workflows/ci.yml` caches `web/package-lock.json`, installs in `web`, and
  invokes a gate that does not include Pad.
- `deploy/deploy.sh` runs separate `npm ci`/Vite builds inside `web` and `pad`.
- `scripts/review-repros.cjs` loads TypeScript and Yjs from `pad/node_modules`.
- `scripts/smoke-editing.mjs` imports Yjs from `web/node_modules`.
- `pad/tsconfig.json` maps Monaco types through `./node_modules/...`.
- `pad/vite.config.ts` copies `@wasmer/sdk` from
  `./node_modules/@wasmer/sdk`, which breaks when npm hoists it.
- Both local lockfiles currently determine the installed graphs. Remove them only
  after a clean root lockfile has reproduced both builds and checks.

### DOM selectors

The Ajar layout suite and production code rely on the current workspace IDs, notably
`#sidebar`, `#sidebar-splitter`, `#viewer-pane`, `#editor-empty`, `#viewer`,
`#splitter`, `#tree`, `#people`, `#tabs`, `#terms`, `#empty`, `#name`, and
`#preview-scenario`, plus `.monaco-editor` and `.xterm`. Pad's checks depend on
`#files`, `#editor`, `#terminal`, `#run`, `#share`, `#status`, `#presence`, file-tree
classes, and Monaco/xterm classes. UI-04/UI-05 should replace brittle selectors with
accessible roles/labels while retaining equivalent behavior coverage; UI-01 should
not silently delete the present flows while introducing React roots.

## Wasmer, worker, package-mirror, and service-worker constraints

- Keep the Pad Vite `index.html` and `check.html` build entries.
- Keep cross-origin isolation in development and deployment: COOP `same-origin`, COEP
  `require-corp`, and the deployed CORP/CSP rules needed by WASIX workers.
- Resolve `@wasmer/sdk` by its installed package location, then copy its `dist` and
  `pkg` directories without flattening them. The SDK's `browser-worker.js` imports
  sibling files by relative URL.
- Keep the public SDK base URL `/vendor/wasmer` or introduce an explicitly versioned
  equivalent across Vite, runtime imports, Caddy, and tests. Review R23 tracks the
  current immutable caching risk at the unversioned URL.
- Keep Monaco's editor worker creation in the application adapter until versions are
  deliberately reconciled.
- `mirrorPackages()` registers `/sw.js` at scope `/`. The service worker reads
  `/packages/manifest.json`, intercepts `https://cdn.wasmer.io/` requests from both
  the page and SDK workers, serves mapped local files, strips stale content encoding
  headers, and falls back to the CDN for missing entries.
- `pad/scripts/fetch-packages.mjs` discovers runtime downloads in a real browser and
  writes `pad/public/packages`; deployment refuses to proceed without its manifest.
  Do not make a UI preview initialize this path or fetch packages.

## Existing issues, not migration regressions

The authoritative list remains [review-2026-09-12.md](review-2026-09-12.md). UI work
must not relabel its findings as fixed without direct behavioral evidence. The most
relevant migration gates are:

- Ajar reconnect can detach an open document (R05), and initial read-only state is not
  sent correctly (R21).
- Pad has stale runtime/document reconciliation, remote-deletion resurrection, and
  save-ordering data-loss paths (R06-R08), plus execution/input lifecycle failures
  (R13-R15) and incomplete reconnect refresh (R26).
- Pad development proxying and CI coverage are missing (R22, R27).
- Docker build/start is already blocked (R11).
- Real protocol, revocation, sandbox, runtime, persistence, and two-browser checks were
  unavailable in this Windows baseline.

## UI-01 starting point

Create the root npm workspace and lockfile while preserving the two successful app
builds, Ajar layout suite, output directories, current routes, and lazy/runtime asset
boundaries above. Repair all package-location assumptions as part of the verified
transition. Do not use the unavailable real-host/runtime gates as a reason to weaken
them; keep them documented for UI-07 and make CI able to run them in the appropriate
environment.
