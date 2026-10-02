import { applyStoredTheme } from "@ajar/workspace-ui/theme";
import "@ajar/workspace-ui/theme.css";
import "@ajar/workspace-ui/workspace.css";
import "./style.css";

applyStoredTheme("pad");

const fixture = import.meta.env.DEV && new URLSearchParams(location.search).get("preview") === "workspace";

if (fixture) {
  void import("./workspace-preview").then(({ startWorkspacePreview }) => startWorkspacePreview());
} else {
  void import("./bootstrap").then(({ startPad }) => startPad());
}
