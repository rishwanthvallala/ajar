# Open and check the workspace UI

The workspace now has a development preview. It uses the same layout, file tree, editor, and panel controls as a real Ajar session. You do not need Rust, WSL, a relay, or an account to open it.

## Start the preview

Use Node.js 24 LTS. From the project folder:

```sh
cd web
npm ci
npm run dev
```

Open **http://localhost:5173/?preview=workspace**. If the server prints a different port, use that port in the URL. Keep the terminal running; press Ctrl+C to stop it. Saving a UI source file updates the browser automatically.

On this Windows machine, the system Node version is older than the project supports. The already-installed newer runtime can start the preview directly in PowerShell:

```powershell
cd D:\ajar\ajar\web
& "C:\Users\tanuj\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173
```

That machine-specific command assumes dependencies have already been installed, as they have in this workspace.

## Try the layout

- Select **Populated**, **Empty**, or **Disconnected** in the Example selector at the top.
- Open a file from **Files**. Close it to return to the empty editor area.
- Drag the separator next to Files to change its width. Drag the horizontal separator to change the editor/terminal proportions.
- Focus a separator with Tab and use its arrow keys to resize. Hold Shift for larger steps.
- On a narrow window, Files opens a drawer. Select a file, press Escape, click Close, or click outside the drawer to dismiss it.
- Use **New terminal** and **Split** to inspect the terminal layout.

The terminal output is simulated: typing does not execute commands. Sample-file edits stay in memory and reset when you switch examples or reload. Layout choices persist between examples for this preview visit, without changing saved real-session preferences. The disconnected example displays read-only files.

The preview is available only with the development server. `npm run preview` serves the production build, where `?preview=workspace` has no special behavior.

## Run the checks

With the development server still running, open another terminal in `web`:

```sh
npm run test:layout
npm run build
```

The browser checks use Playwright, included as a development dependency. On Windows they use installed Microsoft Edge. On other systems, install Playwright's Chromium once with `npx playwright install chromium`. Set `AJAR_BROWSER_CHANNEL=chrome` to use an installed Chrome instead. The optional `AJAR_PREVIEW_URL` environment variable changes the default test server address, `http://127.0.0.1:5173`.

To keep screenshots, set `AJAR_SCREENSHOTS` to an output directory before running the checks. For example, in PowerShell:

```powershell
$env:AJAR_SCREENSHOTS = "$PWD\artifacts\workspace-layout"
npm run test:layout
```

The checks cover desktop and phone layouts, keyboard/pointer resizing, file drawer focus, stored preferences, lazy editor loading, closing files during loading, simulated connection callbacks, and preview isolation. The zoom check models a 1440x900 display at 200% zoom as a 720x450 CSS viewport at double pixel density. Also use your browser's actual zoom control for a manual visual check.

Real host execution, encryption, collaboration between browsers, and reconnection need a running host and relay. The layout preview and simulated connection checks do not establish that those backend flows work end to end.

To also check the production preview gate, run `npm run preview -- --port 5174` in a third terminal and set `AJAR_PRODUCTION_URL=http://127.0.0.1:5174` before running the layout checks. See [the validation record](workspace-layout-validation.md) for completed checks and their limits.
