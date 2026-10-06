import { codeFor, takeCode } from "./access";
import { App } from "./app";
import { mirrorPackages } from "./runtime";
import { mintName, Store } from "./store";
import { PadWorkspace } from "./workspace";

/** Where people look for signing in. Each is a reserved name, so no pad sits there. */
const TO_DASHBOARD = new Set(["dashboard", "login", "signup", "account", "settings"]);

export async function startPad(): Promise<void> {
  const path = location.pathname.replace(/^\/+|\/+$/g, "");
  const root = document.getElementById("app")!;
  if (TO_DASHBOARD.has(path.toLowerCase())) {
    if (path !== "dashboard") history.replaceState(null, "", `/dashboard${location.search}`);
    const { startDashboard } = await import("./dashboard");
    return startDashboard(root);
  }
  // The operator's view. To anyone else it says what /admin always said.
  if (path === "admin") {
    const { startAdmin } = await import("./admin");
    return startAdmin(root);
  }
  // A name typed with capitals is the same pad in lower case.
  if (path !== path.toLowerCase() && /^[a-z0-9-]{1,64}$/.test(path.toLowerCase())) {
    location.replace(`/${path.toLowerCase()}${location.search}${location.hash}`);
    return;
  }
  // Not a pad's shape at all — slashes, too long, other characters: said at once,
  // rather than after an editor has been drawn around an error.
  if (path && !/^[a-z0-9-]{1,64}$/.test(path)) {
    const { showPrivate } = await import("./dashboard");
    let shown = path;
    try {
      shown = decodeURIComponent(path);
    } catch {
      // Shown as it came.
    }
    return showPrivate(root, shown, "invalid");
  }
  const name = path || mintName();
  if (!path) history.replaceState(null, "", `/${name}${location.search}`);
  // Before anything is read: the code goes from the address bar into storage,
  // and every request from here on carries it.
  takeCode(name);
  // A link pasted into a tab already on this pad changes only the part after
  // the `#`, and the browser does not reload for that. Taken here, the page
  // opens again with it — as an editor, or past the private screen.
  addEventListener("hashchange", () => {
    if (takeCode(name)) location.reload();
  });
  // Why a sign-in begun from this pad's private screen came back unfinished.
  const params = new URLSearchParams(location.search);
  const signin = params.get("signin");
  if (signin) {
    params.delete("signin");
    const rest = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}`);
  }

  const ui = new PadWorkspace(root, name);
  await mirrorPackages();
  let app: App | null = null;
  const leave = () => {
    app?.dispose();
    ui.dispose();
  };
  app = new App(name, new Store("", codeFor), ui.elements, ui, {
    onPrivate: (why, deadLink) => {
      leave();
      app = null;
      void import("./dashboard").then(({ showPrivate }) => showPrivate(root, name, why, signin, deadLink));
    },
  });
  await app.start();
  // Leaving for good, or only into the back-forward cache: there the page is
  // frozen as it is and may come back on Back. Torn down on the way in, it
  // came back an empty editor that answered nothing — every listener
  // aborted, the editor and the room gone — until 6 October.
  addEventListener("pagehide", (e) => {
    if (!e.persisted) leave();
  });
  addEventListener("pageshow", (e) => {
    if (e.persisted) app?.resume();
  });
}
