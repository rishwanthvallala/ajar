# Shared workspace UI

This document tracks the Ajar/Pad workspace unification introduced by the
OpenSpec change `unify-pad-workspace-ui`.

## Baseline — 18 September 2026

Built from the locked root dependencies with `npm run build`. Sizes are the
production entry assets reported by Vite and recompressed locally with gzip.

| Application | Initial JavaScript | Gzip | Initial CSS | Gzip |
|---|---:|---:|---:|---:|
| Ajar | 367,697 B | 95,409 B | 20,398 B | 4,702 B |
| Pad | 21,373 B | 7,610 B | 3,489 B | 1,235 B |

The editor, editing bindings, terminal, shell, sync, and runtime remain separate
lazy chunks. Baseline screenshots were captured at 1440×900 in dark mode for
both products, plus Ajar's light, mobile, and 200% zoom states, under
`web/artifacts/workspace-ui-baseline/` (the repository intentionally ignores
generated browser artifacts).

Baseline verification:

- `npm run build` passed for Ajar and Pad.
- `npm run test:review` passed all eight focused regressions.
- `scripts/check-workspace-layout.cjs` passed against a fresh Ajar development
  server on port 5193: lifecycle, pointer/keyboard resize, four viewports,
  drawer focus, preferences, preview isolation, lazy loading, and disposal.
- A first run against an unrelated server already occupying port 5173 reached
  the live-session fixture and timed out waiting for Monaco. The isolated rerun
  above establishes the branch baseline and avoids attributing foreign server
  state to this change.

## Implementation result

`packages/workspace-ui` is a private source-only npm workspace. It owns the
workspace DOM, responsive geometry, pointer and keyboard separators, the mobile
Files drawer and focus trap, preference storage, disposal, design tokens, and
workspace styling. It has no transport, persistence, editor, terminal, or
runtime dependency.

| Owner | Responsibilities |
|---|---|
| `packages/workspace-ui` | Shared shell, layout state, accessible drawer/resizers, theme and panel styles |
| `web/src/workspace.ts` | Ajar adapter and lazy `EditorPane`; Ajar session code still owns host controls and terminal tabs |
| `pad/src/workspace.ts` | Pad action/file/editor/preview/terminal mount points over the shared shell |
| `pad/src/app.ts` | Monaco models, Yjs peers, durable saves, WASIX runtime, xterm console, Run/Share and server preview |

Ajar continues to restore `ajar.sidebar`, `ajar.sidebarWidth`, and `ajar.split`.
Pad uses the corresponding `pad.*` keys. Storage access is guarded so denied or
invalid values fall back to a usable 15 rem sidebar and 60/40 editor-terminal
split. Layout notifications refit Monaco and xterm without remounting them.

Pad now mounts Run, Preview, Share, active filename, connection/save status,
presence, file creation, Monaco, xterm, and server preview into the shared
regions. The server iframe replaces Monaco inside the upper region and exposes
an explicit **Back to editor** control. The iframe still uses the separately
configured preview origin. Hidden preview content is asserted to occupy no row
at boot.

## Development previews

```sh
npm run dev:ajar
# http://127.0.0.1:5173/?preview=workspace

npm run dev:pad
# http://127.0.0.1:5175/?preview=workspace
```

Pad checks `/?preview=workspace` before importing its store, peer, package
mirror, or runtime bootstrap. Its fixture covers populated, empty, saving, save
failure/retry, runtime loading, running, and disconnected states. Preferences
are in memory; Run and Share are simulated. The root UI gate asserts that the
fixture makes no API, peer WebSocket, Wasmer, mirrored-package, or service
worker request. Vite eliminates the fixture from production: the production
query follows the normal Pad flow and contains no fixture controls or chunk.

## Final bundle comparison

The comparable entry/controller assets from the locked production build are:

| Application | Baseline raw/gzip | Final raw/gzip | Change |
|---|---:|---:|---:|
| Ajar JS entry | 367,697 / 95,409 B | 368,182 / 95,089 B | +485 / -320 B |
| Ajar CSS | 20,398 / 4,702 B | 21,156 / 4,756 B | +758 / +54 B |
| Pad JS entry/bootstrap path | 21,373 / 7,610 B | 37,485 / 12,715 B | +16,112 / +5,105 B |
| Pad CSS | 3,489 / 1,235 B | 11,793 / 2,900 B | +8,304 / +1,665 B |

Pad's final JS figure combines the 423-byte entry, 1,820-byte preload helper,
and 35,242-byte normal bootstrap. The gzip increase is below the proposed
10 KiB review threshold. The existing editor, xterm, shell/runtime support,
sync, and Wasmer assets retain their separate chunks; the development fixture
is absent from `dist`. Ajar imports no Pad code.

## Requirement and validation ledger

| Area | Delivered evidence |
|---|---|
| Shared presentation | Both products consume `@ajar/workspace-ui`; the Ajar layout suite and Pad layout suite pass pointer/keyboard resizing, bounds, focus return, disposal, light/dark themes, four viewports, and larger text. |
| Ajar behavior | Existing lazy-editor, stale-selection, terminal input/resize, drawer, storage restoration/failure, and remount checks pass. |
| Pad behavior | Root boot checks preserve Monaco content and undo history plus xterm contents across layout/theme changes. File/folder controls and all product actions remain reachable at desktop and mobile sizes. |
| Status and preview | Accessible Pad fixtures cover every planned status; preview switching retains editor state and terminal height, the normal boot has no blank preview row, and the real flow keeps the separate preview origin plus error recovery. |
| Fixture isolation | No API/runtime/package/socket/service-worker activity; no production preference writes; production omits fixture controls and code. |
| Delivery | Root lockfile, typecheck, Docker copy inputs, and both frontend production builds include the shared package. |

Validation completed on Windows:

- Clean `npm ci --ignore-scripts --no-audit --no-fund` passed.
- `npm run typecheck` passed all three workspaces.
- `npm run build` passed Ajar and Pad.
- `npm run test:ui` passed both layout suites and both production boot checks.
- `npm run test:review` passed all eight focused code-review regressions.
- `node --check` passed the changed browser harnesses.
- `git diff --check` passed.

The real Pad app/runtime harness and Ajar smoke suites could not run on this
Windows host because no Rust/Cargo toolchain or `ajar-relay.exe` is installed;
those flows remain the supported Linux CI release gate. Docker copied the new
package in both manifest-install and source-build phases, but local image
construction could not start because the Docker Desktop Linux engine is not
running. These unavailable checks are not reported as passes.

The one remaining OpenSpec task is the relay-dependent Pad verification. On a
supported host with the Rust relay built, run:

```sh
npm run check --workspace=ajar-pad
VITE_PREVIEW_ORIGIN=http://127.0.0.1:5251 npm run build --workspace=ajar-pad
node pad/scripts/preview-check.mjs
```

That gate exercises real edit/save/reload/share and two-peer behavior plus Run,
stdin, Ctrl-C, and the server preview. It remains unchecked until those commands
complete against a live relay.
