# Unified UI plan: Ajar and Pad

Created: 12 September 2026  
Status: Ready to start; framework migration has not begun.  
Working repository: `D:\ajar\ajar`  
Recommended first work: **UI-00, followed by UI-01**.

## 1. The decision

Use **React + TypeScript + Vite** for both Ajar and Pad, with one shared React UI package.

In beginner terms: React defines reusable screen components, TypeScript checks the data passed between them, and Vite runs the development server and builds the website. The shared package supplies the same buttons, panels, file navigation, and workspace layout to both products.

Keep `web/` and `pad/` as separate applications with their existing URLs and deployment outputs. Ajar connects to a host machine; Pad executes code inside the browser. They will share their interface foundation while retaining the services and actions appropriate to each product.

This document is the master plan and handoff record for separate chats. It does not authorize publishing, changing the backend protocol, or discarding existing work. Application code has not been changed as part of writing this plan.

### Chosen stack

| Area | Choice | Why it fits this repository |
| --- | --- | --- |
| UI | React, matching React DOM and TypeScript definitions | One component model for both applications and their previews |
| Build | Vite with the React plugin | Both applications already produce static Vite builds |
| Styling | Shared CSS variables plus CSS Modules | Reuses the existing CSS knowledge and prevents application-wide selector collisions |
| Package sharing | npm workspaces with a private `@ajar/ui` package | Local components can be imported without publishing a package |
| Small interface state | React state/reducers | Fits open drawers, selected panels, and transient form state |
| Service state | Existing TypeScript services exposed through subscriptions | Preserves the code responsible for connections, saves, and runtime execution |
| Code editor and terminal | Existing Monaco and xterm, hosted through React components | Preserves mature editing and terminal behavior |
| Tests | Playwright and the existing protocol/runtime checks | Covers actual browser layout and product behavior |

Use a supported stable React 19 release, pin the resolved versions in the lockfile, and record the exact selection in UI-01. Keep Node 24 as the development baseline. Do not perform unrelated major upgrades while moving components.

React's documentation includes a Vite/TypeScript setup for a browser application. For this project, retaining static delivery and the Rust backend is the reason to choose that setup. The migration does not require server rendering or a new application server. [React setup documentation](https://react.dev/learn/build-a-react-app-from-scratch)

Do not introduce a second component framework. Tailwind, a large state-management library, and a component-library rewrite are not prerequisites. Start with native controls and the existing tested interaction behavior; introduce any accessibility primitive dependency deliberately through the shared-package owner.

## 2. What exists today

The existing workspace improvements are a starting point to preserve, not a completed React migration.

| Area | Current implementation | Migration concern |
| --- | --- | --- |
| Ajar entry/screens | `web/src/main.ts`; direct DOM rendering | Landing, joining, session state, and event handling are coupled |
| Ajar workspace | `web/src/workspace.ts`, `workspace.css` | Already has persistent editor, 60/40 default, resizing, mobile drawer, and stored preferences |
| Ajar editor/tree | `web/src/viewer.ts`, `tree.ts`, `editing.ts` | Preserve lazy loading, large-tree rendering, document cleanup, and collaboration |
| Ajar connections | `web/src/connection.ts`, `proto.ts`, `sealed.ts` | Preserve session identity, encrypted traffic, and the link's key fragment |
| Ajar preview | `web/src/workspace-preview.ts`; `/?preview=workspace` | Works without a backend; keep this entry point useful throughout migration |
| Pad screen | `pad/index.html`, `pad/src/main.ts`, `app.ts`, `style.css` | HTML controls and the App class directly own screen elements |
| Pad execution | `runtime.ts`, `shell.ts`, `console.ts` | Keep browser runtime initialization, execution, and terminal input behavior outside render functions |
| Pad persistence/peers | `store.ts`, `sync.ts`, `peers.ts`, `editing.ts` | Preserve save conflicts, dirty state, remote changes, and document identity |
| Packaging | Separate manifests and lockfiles; no root npm workspace | Consolidation changes dependency lookup, build commands, and CI |

The client dependency versions differ: Ajar uses Vite 8, TypeScript 7, Monaco 0.56, and xterm 6; Pad uses Vite 7, TypeScript 5, Monaco 0.55, and xterm 5. Pad pins the Wasmer SDK to 0.11.0. Verify compatibility before consolidating a version. Sharing React does not require upgrading the execution runtime.

The previous layout build and browser checks passed. A real host/relay and complete Pad execution were not verified on this Windows setup. Read [the validation record](workspace-layout-validation.md) and [the project review](review-2026-09-12.md) before making claims about end-to-end readiness. The review reproduction script confirms known defects; its successful exit is not evidence those defects have been fixed.

Existing changes may still be uncommitted. Every chat must inspect the current tree and preserve unrelated changes. Also, this checkout currently ignores `/openspec` and `/.agents` in Git: do not rely on those directories alone for context shared through commits or another checkout. Keep the durable handoff in this document and ordinary project documentation.

## 3. Target organization

The following paths are proposed. Except for the existing applications and scripts, they do not exist yet.

```text
ajar/
  package.json                 npm workspace and common commands
  package-lock.json            one installation record
  packages/
    ui/                        private package: @ajar/ui
      src/
        tokens.css             colors, typography, spacing, sizes
        components/            buttons, fields, badges, messages
        workspace/             shell, headers, panes, drawer, file tree
        hosts/                 editor/terminal mounting boundaries
        contracts.ts           shared view data and action interfaces
        index.ts               public exports
  web/
    src/
      app/                     React entry and route selection
      pages/                   landing, join, workspace, session ended
      session/                 Ajar controller and React subscription
      preview/                 sample Ajar controller/data
      ...existing services...
    dist/                      same deployment output location
  pad/
    src/
      app/                     React entry and Pad workspace
      controller/              Pad controller and React subscription
      preview/                 sample Pad controller/data
      ...existing services...
    dist/                      same deployment output location
  docs/
    unified-ui-plan.md          this plan and phase status
```

Initially `@ajar/ui` can export TypeScript source consumed by each app's Vite build. It does not need publishing or a separate library bundler. Declare React as a peer dependency of the shared package and check that each application resolves one React instance.

The import direction is `web/` and `pad/` -> `@ajar/ui`. Shared UI must not import either application, connect to a relay, access the encryption key, call Pad's store, or instantiate Wasmer.

### One layout, product-specific actions

| Shared interface | Ajar behavior | Pad behavior |
| --- | --- | --- |
| Workspace header | Workspace identity, host/participants, connection and permission state | Pad name, collaborators, Run and Share |
| Files | Host-provided directory tree | Pad files and supported file operations |
| Editor area | Collaborative host file or read-only saved copy | Local editable model, live document updates, persisted through Pad's store |
| Terminal area | Host PTY sessions and split-terminal controls | Browser shell/output and execution controls |
| Status/message components | Connecting, reconnecting, host away, locked, read-only, ended | Runtime loading, ready, running, saving, unsaved, save failed/conflict |
| Preview | Simulated session and terminals | Simulated runtime, save state, and output |

Shared appearance must not imply shared semantics. For example, Ajar's terminal read-only flag must not silently become an editor permission, and Pad must not display a confirmed Saved state before persistence succeeds.

## 4. Component and state rules

### What React owns

React owns application navigation, headers, forms, menus, panel arrangement, file-list selection UI, status messages, and empty/error/loading views. CSS Modules scope component styling; a single token file supplies colors, spacing, typography, borders, and focus treatments.

Port the current workspace behavior: persistent editor, 60/40 initial division, minimum usable sizes, pointer and keyboard resizing, narrow-screen Files drawer, focus restoration, and safe preference restoration. Keep Ajar's existing preference keys compatible. Give Pad separate keys so using one app does not unexpectedly change the other.

`WorkspaceShell` accepts areas such as header actions, file navigation, editor content, terminal content, and status messages. Define common file/participant display data without embedding backend-specific messages. Application adapters decide which actions exist and when they are available.

### What the services own

Connection controllers, Yjs documents, terminal sessions, Pad saves, and Wasmer execution remain ordinary TypeScript services. Extract their DOM updates into subscribed view state and explicit commands. Service snapshots must be immutable and stable until data changes. React can subscribe with `useSyncExternalStore`; local interface state can use ordinary React state. [React external-store guidance](https://react.dev/reference/react/useSyncExternalStore)

Do not store every terminal byte or the whole editable document in React state. Stream terminal output directly to xterm and bind document updates to Monaco/Yjs. React observes small summaries such as current file, participants, connection status, and pending-save state.

### Editor and terminal ownership

React renders a dedicated empty container and passes it to a mounting adapter. Monaco or xterm exclusively owns that container's children. A normal React rerender must not reconstruct an editor, lose its undo history, recreate a document, reset terminal scrollback, or start a second process.

Specify who owns models, subscriptions, and sessions, and when each is disposed. React unmount disposes view subscriptions and mounted widgets; the owning controller decides whether an underlying connection/process/document must end. Switching tabs should preserve the resources the product already retains.

Keep lazy editor/runtime loading. Use cancellation or selection generations to prevent delayed work from recreating closed views. Side effects must tolerate React development setup/cleanup cycles; do not disable Strict Mode to conceal duplicate subscriptions or missing cleanup. [React Strict Mode documentation](https://react.dev/reference/react/StrictMode)

During migration, a legacy view may temporarily own a dedicated subtree. Never let its `innerHTML` or DOM replacement operations target a React-owned subtree. Such bridges are transitional and must be removed before UI-07 is complete.

Initially editor/terminal adapter implementations stay in their respective apps, allowing different Monaco/xterm versions behind a common mounting contract. Consolidate package versions and reusable adapter implementations only after both runtime checks pass.

## 5. Screens and visual scope

The visual baseline is the new Ajar workspace: clear panel boundaries, system-font navigation, monospace code, restrained light/dark colors, and readable controls. Capture it before migration. React adoption should first preserve this behavior, then make the shared components the place to improve both products.

Deliver these screens and states:

- **Ajar landing:** concise product introduction, installation and share flow, accurate feature/limitation copy, useful copy feedback.
- **Ajar join:** labeled name input, validation, pending state, and invalid/incomplete-link errors while retaining the full key-bearing URL.
- **Ajar workspace:** files, persistent editor, terminal sessions, participants, permission indicators, connection and host-away feedback.
- **Ajar end/error screens:** clear explanation and valid recovery/navigation actions; do not promise reconnection after a session is ended.
- **Pad workspace:** the shared shell with Pad's Run, Share, runtime progress, file operations, save state, and output controls.
- **Both development previews:** the same React screen components as the real apps, populated/empty/failure scenarios, no real writes or execution, and no preview route in production.

Support mouse, keyboard, touch-sized controls, long content, light/dark system themes, and 200% browser zoom. Avoid adding unrelated IDE features, such as Git panels, extensions, multiple editor tabs, or authentication, during this migration.

## 6. Phases and separate-chat ownership

Every phase begins by reading this file and inspecting the current implementation. Mark a phase complete only after its completion checks pass. Add exact commands, outcomes, limitations, and the next phase to its handoff record below.

| ID | Work | Depends on | Primary files | Status |
| --- | --- | --- | --- | --- |
| UI-00 | Record the baseline and compatibility constraints | None | Documentation and focused baseline checks | Not started |
| UI-01 | npm workspace and React foundation | UI-00 | Root manifests/config, app build config, CI/build scripts | Not started |
| UI-02 | Shared styling and basic components | UI-01 | `packages/ui` tokens/components, component gallery | Not started |
| UI-03 | React workspace and adapter contracts | UI-02 | `packages/ui/workspace`, `hosts`, `contracts.ts` | Not started |
| UI-04 | Migrate Ajar's session and preview | UI-03 | `web/src/session`, workspace route, preview, Ajar tests | Not started |
| UI-05 | Migrate Pad and add its preview | UI-03 | `pad/src/app`, controller, preview, Pad tests | Not started |
| UI-06 | Migrate Ajar landing/join/end screens | UI-04 | `web/src/pages`, navigation, onboarding tests | Not started |
| UI-07 | Complete integration, cleanup, and release checks | UI-04, UI-05, UI-06 | Both apps, shared package, checks, documentation | Not started |

### UI-00: Record the starting point

Capture what currently works, screenshots, dependency versions, output sizes, and the exact commands needed to run each application/check. Read the existing review and separate known defects from migration regressions. Baseline the new Ajar workspace behavior instead of recreating it from memory.

Inspect scripts that rely on `web/node_modules`, `pad/node_modules`, local lockfiles, or current HTML IDs. Record the migration requirements for the Wasmer copy plugin, package-mirror script, worker URLs, and service worker. Confirm the test environment needed for real Ajar and Pad checks.

**Done when:** the baseline report identifies passed, failed, and unavailable checks, with reproduction commands and known issues. A failure that already existed is documented explicitly; it is never silently recorded as a pass.

### UI-01: Establish shared installation and React entry points

Add a root npm workspace covering `web`, `pad`, and `packages/*`, then add a private `@ajar/ui` package and consistent React dependencies. Choose compatible React plugins for the existing Vite versions; Vite/TypeScript version convergence can follow successful builds rather than forcing Pad's toolchain upgrade immediately.

Move to a root lockfile and root clean installation. Replace per-app installation assumptions in the Docker frontend build stage, `deploy/deploy.sh`, `.github/workflows/ci.yml`, and affected scripts. Include the shared package in Docker's build context/copy steps. Keep `web/dist` and `pad/dist` output locations.

Fix the Wasmer SDK lookup in `pad/vite.config.ts` to resolve its installed package location: npm hoisting can invalidate the current `./node_modules/@wasmer/sdk/` assumption. Preserve `dist`/`pkg` directory relationships, worker paths, cross-origin isolation headers, and both Pad build entry points. Configure Pad development proxies for `/api` and `/ws`; keep Ajar's `VITE_RELAY` support.

Add React roots through isolated entry points while the current product flows remain runnable. Add root scripts for the target commands in section 7. Remove the old lockfiles only as part of a verified transition to the new root install. Check `npm ls react react-dom` and avoid duplicate React copies in shared components.

**Done when:** a clean root install works; both applications typecheck/build; both can render a small shared React component; current product paths still open; Docker/CI/deployment command changes have been verified as far as the available environment permits. Merely adding React dependencies is insufficient.

### UI-02: Create shared visual building blocks

Implement shared tokens and React Button, IconButton, Field, Badge, StatusMessage, EmptyState, LoadingState, and panel-header components. Include accessible labels, focus styles, disabled and pending states. Provide a development-only component gallery at Ajar's `/?preview=components` using the exported components.

Make shared typography/color values usable by Monaco and xterm adapters too. Provide explicit theme values for tests and derive the production default from system settings. Scope application CSS and document component usage so chats do not recreate their own button or status styles.

**Done when:** the gallery demonstrates both themes and keyboard states, and both apps import at least one component from the same package source. No application imports the other app's implementation files.

### UI-03: Build the shared React workspace

Implement `WorkspaceShell`, resizable panels, Files drawer, editor-region empty/loading/error states, terminal header/tab presentation, and participant/status areas. Define the stable contracts for file display, controller subscriptions, available actions, and editor/terminal mounting.

Use React-friendly file navigation with Ajar's large-tree behavior in mind; retain virtualization or equivalent bounded rendering for large trees. Port the current keyboard resizing, minimum dimensions, restored sizes, and drawer focus cleanup. Avoid a giant component full of product-name conditionals: accept product actions and content through explicit slots/props.

Publish the component exports and example adapters in source before UI-04/UI-05 start. Test the workspace with in-memory fixtures that mount real editor/terminal views where practical, including close-during-load and disposal.

**Done when:** the reusable React workspace passes the current layout acceptance behaviors, its adapter ownership is documented, and both product teams can implement their integration without changing the agreed contract.

### UI-04: Migrate Ajar's session

Extract DOM-free session/controller responsibilities from `web/src/main.ts`. Connect React through subscribed state and explicit actions while preserving wire formats and encryption. Preserve `/j/<session>#k=<key>`, participant state, host/permission indicators, file opening, document bindings, terminal creation/splitting, and offline-copy display.

Replace the session's legacy Workspace and file-view DOM ownership with shared React components and stable widget adapters. Route `/?preview=workspace` to the same React workspace using a fake session controller. Update the existing browser checks to use stable accessible selectors and outcomes; remove tests that depend on replaced internal source strings.

Check development remount/cleanup, stale file replies, and terminal output under frequent state updates. A layout rerender must not open another socket or lose the key. Existing reconnect correctness defects remain tracked against the review rather than being misrepresented as fixed by React.

**Done when:** the Ajar session and preview use the shared React workspace, the frontend integration/layout checks pass, and real host checks are either executed successfully or explicitly left as a release gate for UI-07.

### UI-05: Migrate Pad's workspace

Separate `pad/src/app.ts` into a DOM-free controller and React views. Move the existing HTML toolbar/layout into React, using shared components for Files, editor, terminal/output, Run, Share, status, and presence.

Preserve each browser's local runtime/terminal ownership, starter file behavior, file models, runtime prefetch, package mirroring, execution, saves, conflicts, and peer updates. Mount changes must not create duplicate runtimes, save timers, or peer connections. Keep unsaved local content recoverable when a save fails.

Add Pad's own development-only `/?preview=workspace`, checked before pad-name creation, store access, peer connection, or package-mirror/runtime initialization. Include runtime loading/failure, running, unsaved/saving/save failure, and disconnected examples, with no actual execution or persistence. Keep the real runtime behind the normal Pad route.

**Done when:** normal Pad and its preview use the shared React workspace, UI tests cover Run/Share/save feedback, and existing runtime/app checks have recorded results. Actual Run, interrupt/input, reload persistence, and two-peer behavior need a working relay and browser runtime before release readiness can be claimed.

### UI-06: Finish Ajar's remaining screens

Move landing, join, ended-session, and error views into React. Use shared typography, controls, validation, and messages. Keep existing routes, fragment handling, clipboard actions, and deployment behavior compatible. Simple explicit route selection is sufficient for the current small route set; add a routing dependency only if real navigation requirements demand it.

Check landing-page claims against implementation and the review. Use concrete, accurate copy about supported platforms, sharing, persistence, and access. Handle pending joins and incomplete/invalid links without printing sensitive key material.

**Done when:** all Ajar screens use React, join/navigation checks pass, and loading, error, clipboard, and keyboard behavior are covered.

### UI-07: Verify both products and remove transitional code

Remove replaced legacy renderers, duplicate workspace CSS, temporary DOM bridges, unused imports, and preview-specific copies of production components. Reconcile Monaco/xterm versions only if both applications' widget/runtime tests support it. Document any necessary version difference behind the common adapter contract.

Run both applications' typechecks/builds, shared layout/component tests, and product checks. Verify production deep links, static asset/worker paths, Pad headers/service-worker behavior, and preview exclusion. Add both applications and the shared package to CI rather than leaving Pad outside the frontend checks.

Compare bundle/loading measurements with UI-00. Monaco must still load on demand for Ajar, and Wasmer must not become part of the initial Ajar bundle or a preview's startup. Check large file trees, sustained terminal output, and layout/state updates for lost focus or repeated widget initialization.

**Done when:** all shipped screens in both apps use React and shared components; migration regressions are resolved; real integration checks pass in an appropriate environment; deployment artifacts build reproducibly; remaining pre-existing issues have explicit disposition. Do not equate a completed visual migration with production readiness while data-loss, execution, or security blockers remain unresolved.

## 7. Development commands and verification targets

These are **commands to implement in UI-01**, not commands already available today:

```sh
# Repository root, Node 24
npm ci
npm run dev:ajar          # Ajar on http://127.0.0.1:5173
npm run dev:pad           # Pad on http://127.0.0.1:5175
npm run typecheck         # shared package and both applications
npm run build            # both applications, including shared source
npm run test:ui          # start/manage fixture servers and run browser checks
```

Use port 5175 for Pad to avoid the existing Ajar production-preview port 5174. Keep application-specific test commands available as well. Root test commands should start and stop their own fixture servers or document an explicit prerequisite, and must not depend on another chat having left a server running.

Planned preview URLs:

- Ajar: `http://127.0.0.1:5173/?preview=workspace`
- Pad: `http://127.0.0.1:5175/?preview=workspace`
- Shared component gallery: `http://127.0.0.1:5173/?preview=components`

Until UI-01 is complete, use [the current Ajar preview instructions](workspace-preview.md). Existing Pad browser scripts need a built relay and runtime assets; fixtures cannot substitute for those integration checks.

### Required test layers

| Layer | Must establish |
| --- | --- |
| Typecheck/build | Shared imports, React instance resolution, both app builds, worker/static asset paths |
| Components/layout | Four existing screen sizes, both themes, actual 200% zoom review, keyboard/drawer behavior, readable long content |
| Lifecycle | Repeated mount/dispose, close during load, stable editor models, one subscription/socket/runtime per owner |
| Ajar integration | Join/key preservation, editing, terminal input/output/resize, permissions, reconnect and offline behavior against the real host |
| Pad integration | First run/runtime loading, execution and interruption, save/reload/conflict behavior, two-browser synchronization |
| Production | Deep links, correct origins/headers, no preview entry point, both builds usable by the current deployment model |

Preserve baseline tests that check behavior. Replace brittle implementation-specific assertions deliberately and explain the equivalent coverage. Never weaken a test simply to make the migration appear complete.

## 8. Working safely across separate chats

The recommended order is UI-00 -> UI-01 -> UI-02 -> UI-03. Then UI-04 and UI-05 can proceed separately after the shared contracts are stable. UI-06 follows UI-04; UI-07 integrates everything.

Only one chat should own root manifests, the root lockfile, shared contracts, and shared components at a time. After UI-03, Ajar and Pad chats can work concurrently in their app-specific directories. If a shared change is needed, record it for the shared-package owner instead of editing the same API in competing chats.

Separate chats in one checkout still share the same files. Prefer isolated branches/worktrees for concurrent work, and integrate prerequisite changes before beginning a dependent phase. Do not overwrite another chat's status entry or unrelated changes. Do not commit, push, publish, or archive planning artifacts unless requested.

The phase table and handoff records are the source of progress. For a new checkout, verify that this file and prerequisites are actually present; conversation history and ignored local OpenSpec files will not automatically travel with the code.

### Copy this into the first implementation chat

```text
Read D:\ajar\ajar\docs\unified-ui-plan.md and inspect the current repository.
Implement UI-00 and then UI-01 from that plan: establish the baseline, then
create the npm workspace and React foundation for Ajar and Pad.
Preserve the existing workspace improvements and unrelated uncommitted work.
Verify both apps and the affected build paths. Do not deploy or commit.
Update only these phases' status and handoff records in the plan, including
exact checks, known failures, and anything the UI-02 chat needs.
```

### Copy this for later phases

```text
Read D:\ajar\ajar\docs\unified-ui-plan.md.
Implement phase UI-XX only, after verifying its prerequisites in the source.
Follow the agreed React/shared-component architecture and file ownership.
Preserve unrelated work. Verify the phase's completion conditions, and update
its status plus handoff record with files changed, checks and limitations.
Do not deploy or commit. Stop after this phase is handed off.
```

Replace `UI-XX` with the desired phase. On another machine, substitute the repository's actual absolute path.

## 9. Handoff records

All migration phases are currently **Not started**. The earlier Ajar layout work is complete, but does not count as implementing these React phases.

When completing a phase, append one record using this format and update its table row:

```text
Phase: UI-XX
Status: Not started / In progress / Blocked / Complete
Owner/chat label:
Date:
Branch or commit, if one exists:
Implemented behavior:
Files changed:
Shared interfaces or versions established:
Commands and results:
Checks not run and why:
Known issues / dependencies:
Next phase and exact starting point:
```

## 10. Reference material

- [Project design](design.md): what Ajar and Pad do and how their services fit together.
- [Project review](review-2026-09-12.md): known defects and limits of previous verification.
- [Current workspace preview](workspace-preview.md): how to run and inspect the existing Ajar UI.
- [Current workspace validation](workspace-layout-validation.md): behavior to preserve during migration.
- [React with Vite](https://react.dev/learn/build-a-react-app-from-scratch): supported browser-app setup and its trade-offs.
- [React external stores](https://react.dev/reference/react/useSyncExternalStore): connecting existing services to React snapshots.
- [React Strict Mode](https://react.dev/reference/react/StrictMode): development checks for resource cleanup.
- [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/): sharing local packages through one workspace install.

The framework and package structure above are recommendations chosen for this repository. Official documentation supports the underlying mechanisms; it does not establish that this migration has already been completed or tested.
