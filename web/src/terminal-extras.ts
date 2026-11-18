import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { type Place, placesIn } from "@ajar/workspace-ui/problems";

/**
 * What a terminal on the guest's page has that the pad's has too: a phone's
 * missing keys, its text for a screen reader, and a file and line in what a
 * program printed as a link to that place.
 */

/** Where this browser remembers the terminal's Screen reader button. */
const SCREEN_READER_KEY = "ajar.screenReader";

export function screenReaderWanted(): boolean {
  try {
    return localStorage.getItem(SCREEN_READER_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The terminal's text for screen readers, on or off, beside New terminal:
 * remembered in this browser, and for every terminal at once. Not always on:
 * in that mode xterm takes no plain text input, which is what a phone's
 * keyboard and a pasted "ï" send.
 */
export function screenReaderToggle(apply: (on: boolean) => void): HTMLButtonElement {
  let on = screenReaderWanted();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "screen-reader";
  button.textContent = "Screen reader";
  const paint = () => {
    button.setAttribute("aria-pressed", String(on));
    button.title = on ? "The terminal's text is read out — off again" : "Let a screen reader read the terminal's text";
  };
  button.onclick = () => {
    on = !on;
    try {
      localStorage.setItem(SCREEN_READER_KEY, on ? "1" : "0");
    } catch {
      // Not remembered, then; it still holds for this page.
    }
    apply(on);
    paint();
  };
  paint();
  return button;
}

/**
 * The keys a phone's keyboard does not have and a terminal needs: Tab to
 * complete, Ctrl-C to stop, the arrows for history and the line, Esc and
 * Ctrl-D. A row of them under the terminal's header on a touch screen, each
 * sent to the terminal in front as its key would be. Pressed without taking
 * the focus, so the phone's keyboard stays up.
 */
export function touchKeys(press: (data: string) => void): HTMLElement | null {
  if (!matchMedia("(pointer: coarse)").matches) return null;
  const row = document.createElement("div");
  row.className = "term-keys";
  row.setAttribute("role", "toolbar");
  row.setAttribute("aria-label", "Terminal keys");
  const keys: Array<[string, string, string]> = [
    ["Tab", "\t", "Tab: complete"],
    ["Ctrl-C", "\x03", "Ctrl-C: stop"],
    ["↑", "\x1b[A", "Up: the command before"],
    ["↓", "\x1b[B", "Down: the command after"],
    ["←", "\x1b[D", "Left"],
    ["→", "\x1b[C", "Right"],
    ["Esc", "\x1b", "Escape"],
    ["Ctrl-D", "\x04", "Ctrl-D: end of input"],
  ];
  for (const [label, data, title] of keys) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "term-key";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    // Not a focus change: the keyboard would close and the terminal lose
    // its place.
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", () => press(data));
    row.append(b);
  }
  return row;
}

/**
 * Which of the folder's files a path a program printed is.
 *
 * A terminal here is the host's own shell, so what it prints are the host's
 * own paths: absolute ones, whose start the page does not know, and relative
 * ones, from a directory it does not know either. So: a path the folder has
 * as written; else the longest end of it the folder has — `/Users/h/proj/src/
 * a.py` is `src/a.py`; else the one file in the folder that ends with it.
 * Null for anything else: a library's file, or two files it could be.
 */
export class Places {
  private files: readonly string[] = [];
  private known = new Set<string>();
  /** By the last part of the path, made the first time one is asked for after a change. */
  private byLeaf: Map<string, string[]> | null = null;

  /** The folder's files now. */
  set(files: readonly string[]) {
    this.files = files;
    this.known = new Set(files);
    this.byLeaf = null;
  }

  find(printed: string): string | null {
    const parts = printed.replace(/^(\.\/)+/, "").split("/").filter((p) => p && p !== ".");
    if (!parts.length || parts.includes("..")) return null;
    const absolute = printed.startsWith("/");
    for (let from = 0; from < parts.length; from++) {
      const path = parts.slice(from).join("/");
      if (this.known.has(path)) return path;
      // A relative path is from somewhere in the folder: all of it, or nothing.
      if (!absolute) break;
    }
    if (absolute) return null;
    if (!this.byLeaf) {
      this.byLeaf = new Map();
      for (const file of this.files) {
        const leaf = file.slice(file.lastIndexOf("/") + 1);
        const list = this.byLeaf.get(leaf);
        if (list) list.push(file);
        else this.byLeaf.set(leaf, [file]);
      }
    }
    const path = parts.join("/");
    const ends = (this.byLeaf.get(parts[parts.length - 1]!) ?? []).filter((f) => f.endsWith(`/${path}`));
    return ends.length === 1 ? ends[0]! : null;
  }
}

/**
 * A traceback's file and line, a compiler's, a stack frame's: a link to the
 * place, when it is one of the folder's files.
 */
export function placeLinks(term: Terminal, places: Places, open: (place: Place) => void): ILinkProvider {
  return {
    provideLinks: (y, callback) => {
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const links = placesIn(text).flatMap((found) => {
        const path = places.find(found.path);
        if (!path) return [];
        const place: Place = { path, line: found.line, ...(found.column ? { column: found.column } : {}) };
        return [{
          range: { start: { x: found.start + 1, y }, end: { x: found.end, y } },
          text: text.slice(found.start, found.end),
          decorations: { pointerCursor: true, underline: true },
          activate: () => open(place),
        }];
      });
      callback(links.length ? links : undefined);
    },
  };
}
