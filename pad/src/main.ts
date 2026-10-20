import { applyStoredTheme } from "@ajar/workspace-ui/theme";
import "@ajar/workspace-ui/theme.css";
import "@ajar/workspace-ui/workspace.css";
import "./style.css";
import "./accounts.css";
import { loadEditor, opensAPad } from "./editor-load";

applyStoredTheme("pad");

const fixture = import.meta.env.DEV && new URLSearchParams(location.search).get("preview") === "workspace";

if (fixture) {
  void import("./workspace-preview").then(({ startWorkspacePreview }) => startWorkspacePreview());
} else {
  // The editor's code is most of what a pad's opening waits for: asked for
  // here, beside the page's own, rather than after them (editor-load.ts).
  if (opensAPad(location.pathname)) void loadEditor().catch(() => {});
  void import("./bootstrap").then(({ startPad }) => startPad());
}
