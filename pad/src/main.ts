/**
 * Bootstrap. Works out which folder this is, then hands over to the app.
 *
 * A bare `/` mints a name and replaces the URL, so landing on the site puts
 * you in a folder without asking you to name one. That is the whole entry
 * flow: no dialog, no template picker, nothing between arriving and typing.
 */
import { App } from "./app";
import { mintName, Store } from "./store";
import "./style.css";

const el = {
  files: document.getElementById("files")!,
  editor: document.getElementById("editor")!,
  terminal: document.getElementById("terminal")!,
  run: document.getElementById("run") as HTMLButtonElement,
  share: document.getElementById("share") as HTMLButtonElement,
  status: document.getElementById("status")!,
  title: document.getElementById("title")!,
};

const path = location.pathname.replace(/^\/+|\/+$/g, "");
const name = path || mintName();
if (!path) {
  // `replaceState`, not a redirect: the address bar should show the folder you
  // are in, but the back button should leave the site rather than bouncing
  // through a name you never chose.
  history.replaceState(null, "", `/${name}${location.search}`);
}

void new App(name, new Store(), el).start();
