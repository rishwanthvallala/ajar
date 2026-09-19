import { App } from "./app";
import { mirrorPackages } from "./runtime";
import { mintName, Store } from "./store";
import { PadWorkspace } from "./workspace";

export async function startPad(): Promise<void> {
  const path = location.pathname.replace(/^\/+|\/+$/g, "");
  const name = path || mintName();
  if (!path) history.replaceState(null, "", `/${name}${location.search}`);

  const ui = new PadWorkspace(document.getElementById("app")!, name);
  await mirrorPackages();
  const app = new App(name, new Store(), ui.elements, ui);
  await app.start();
  addEventListener("pagehide", () => {
    app.dispose();
    ui.dispose();
  }, { once: true });
}
