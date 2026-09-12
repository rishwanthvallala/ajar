# Workspace layout validation

Checked on 12 September 2026, using Node 24 and Playwright with Microsoft Edge on Windows.

## Passed

- TypeScript checking and the Vite production build.
- `npm run test:layout`: 1440x900, 1024x768, 640x360, and 390x844 layouts; long names and participant lists; pointer and keyboard separators; bounds; file drawer focus and breakpoint cleanup.
- Persistent editor empty state; first-use lazy loading; close during loading; late file messages; retained terminal input and resize callbacks. Connection callbacks were exercised against a simulated WebSocket peer using the real browser session code and Yjs payloads.
- Valid, invalid, and inaccessible layout storage; preview preference isolation; repeated mount/dispose cycles.
- Populated, empty, and disconnected development examples without a session WebSocket. Vite's own development hot-reload socket remains expected.
- Production routing: `?preview=workspace` shows the ordinary landing page, with no development preview.
- Visual review in light/dark themes on desktop and phone-sized windows.
- Native browser zoom at 200%, using an isolated temporary Edge profile: 707x453 CSS viewport, device pixel ratio 2. Reviewed all three examples in both themes. Captured full browser surfaces through CDP because the ordinary screenshot helper clipped screenshots at native zoom.

Optional screenshots are saved locally under `web/artifacts/workspace-layout/`, which is ignored by Git. The automated suite also includes a portable 200%-equivalent viewport check.

## Limits

A real Rust host and relay were not run on this Windows machine. Host command execution, encrypted transport, multi-browser collaboration, and reconnection remain separate integration checks. The simulated peer verifies frontend bindings, not backend correctness.

The build retains the existing warnings about Monaco chunk size and the mixed static/dynamic import of `sealed.ts`.

See [workspace-preview.md](workspace-preview.md) for startup and test commands.
