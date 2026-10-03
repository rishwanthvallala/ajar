import { codeFor, takeCode } from "./access";
import { App } from "./app";
import { mirrorPackages } from "./runtime";
import { mintName, Store } from "./store";
import { PadWorkspace } from "./workspace";

export async function startPad(): Promise<void> {
  const path = location.pathname.replace(/^\/+|\/+$/g, "");
  const root = document.getElementById("app")!;
  if (path === "dashboard") {
    const { startDashboard } = await import("./dashboard");
    return startDashboard(root);
  }
  const name = path || mintName();
  if (!path) history.replaceState(null, "", `/${name}${location.search}`);
  // Before anything is read: the code goes from the address bar into storage,
  // and every request from here on carries it.
  takeCode(name);

  const ui = new PadWorkspace(root, name);
  await mirrorPackages();
  let app: App | null = null;
  const leave = () => {
    app?.dispose();
    ui.dispose();
  };
  app = new App(name, new Store("", codeFor), ui.elements, ui, {
    onPrivate: () => {
      leave();
      app = null;
      void import("./dashboard").then(({ showPrivate }) => showPrivate(root, name));
    },
  });
  await app.start();
  addEventListener("pagehide", leave, { once: true });
}
