/**
 * The small kit the account pages and the share dialog are built from, so
 * they look like one thing: elements, icons, the brand, provider buttons,
 * toasts, a confirm dialog and the theme switch. Styles are in accounts.css.
 */
import { applyTheme, parseTheme, THEME_CHOICES, type ThemeChoice } from "@ajar/workspace-ui/theme";

import { PROVIDERS, signInUrl } from "./access";
import { ICONS, type IconName } from "./icons";

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child) node.append(child);
  return node;
}

export function icon(name: IconName, className = "icon"): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.innerHTML = ICONS[name];
  return span;
}

/** A button with an icon before its label; `label` may be empty for an icon-only one. */
export function button(
  label: string,
  opts: { icon?: IconName; className?: string; title?: string; onClick?: (e: MouseEvent) => void; type?: "button" | "submit" } = {},
): HTMLButtonElement {
  const b = el("button", { type: opts.type ?? "button", className: `btn ${opts.className ?? ""}`.trim() });
  if (opts.icon) b.append(icon(opts.icon));
  if (label) b.append(el("span", { className: "btn-label" }, label));
  if (opts.title) {
    b.title = opts.title;
    if (!label) b.setAttribute("aria-label", opts.title);
  }
  if (opts.onClick) b.addEventListener("click", opts.onClick);
  return b;
}

/** pad's mark and name, linking home. */
export function brand(): HTMLElement {
  const a = el("a", { className: "brand", href: "/" });
  a.append(icon("mark", "brand-mark"), el("span", { className: "brand-name" }, "pad"));
  a.setAttribute("aria-label", "pad — open a new pad");
  return a;
}

/**
 * Sign in with each provider this server offers. Links rather than buttons:
 * signing in is a full-page trip to the provider and back.
 */
export function providerButtons(providers: string[], next: string): HTMLElement {
  const list = el("div", { className: "providers" });
  for (const p of providers) {
    const a = el("a", { className: `provider provider-${p}`, href: signInUrl(p, next) });
    a.append(icon(p === "google" ? "google" : "github", "provider-icon"), el("span", {}, `Continue with ${PROVIDERS[p] ?? p}`));
    list.append(a);
  }
  return list;
}

// ---------------------------------------------------------------- theme

const THEME_KEY = "pad.theme";
const THEME_LABEL: Record<ThemeChoice, string> = { system: "System", light: "Light", dark: "Dark" };

function storedTheme(): ThemeChoice {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

/** The same three-way switch the editor's header has, and the same stored choice. */
export function themeToggle(): HTMLButtonElement {
  const b = el("button", { type: "button", className: "btn btn-icon theme-switch" });
  const paint = () => {
    const now = storedTheme();
    const next = THEME_CHOICES[(THEME_CHOICES.indexOf(now) + 1) % THEME_CHOICES.length]!;
    b.innerHTML = ICONS[now];
    b.title = `Theme: ${THEME_LABEL[now]} — switch to ${THEME_LABEL[next]}`;
    b.setAttribute("aria-label", b.title);
  };
  b.onclick = () => {
    const next = THEME_CHOICES[(THEME_CHOICES.indexOf(storedTheme()) + 1) % THEME_CHOICES.length]!;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Applies for this visit only.
    }
    applyTheme(next);
    paint();
  };
  paint();
  return b;
}

// --------------------------------------------------------------- toasts

let ids = 0;
/** A unique id, for labels and descriptions that point across the tree. */
export function uid(prefix: string): string {
  ids += 1;
  return `${prefix}-${ids}`;
}

/**
 * The live regions toasts are written into: a polite one for confirmations
 * and an alert for failures. Made empty and ahead of time — a region added
 * together with its first message is one screen readers often miss — on the
 * page, and in each dialog, since everything outside an open modal is inert.
 */
export function toastRegions(host: Element = document.body): HTMLElement {
  const existing = host.querySelector<HTMLElement>(":scope > .toasts");
  if (existing) return existing;
  const polite = el("div", { className: "toasts-polite" });
  polite.setAttribute("role", "status");
  polite.setAttribute("aria-live", "polite");
  const loud = el("div", { className: "toasts-alert" });
  loud.setAttribute("role", "alert");
  const wrap = el("div", { className: "toasts" }, polite, loud);
  host.append(wrap);
  return wrap;
}

/**
 * A short confirmation at the bottom of the screen: "Link copied". `heard`
 * alone is for a confirmation the screen already shows — read aloud, not
 * drawn over what it confirms.
 */
export function toast(text: string, kind: "ok" | "error" = "ok", heard = false): void {
  // The server's messages start in lower case, for the status line; a toast
  // is a sentence of its own.
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  const dialogs = document.querySelectorAll("dialog[open]");
  const host = dialogs[dialogs.length - 1] ?? document.body;
  const wrap = toastRegions(host);
  const region = wrap.querySelector(kind === "ok" ? ".toasts-polite" : ".toasts-alert")!;
  const t = el("div", { className: `toast toast-${kind}${heard ? " vh" : ""}` }, icon(kind === "ok" ? "check" : "alert"), el("span", {}, sentence));
  region.append(t);
  // Failures stay long enough to read twice, and while a pointer is on them.
  const life = kind === "ok" ? 2600 : 9000;
  let timer = setTimeout(() => leave(), life);
  const leave = () => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 300);
  };
  t.addEventListener("pointerenter", () => clearTimeout(timer));
  t.addEventListener("pointerleave", () => (timer = setTimeout(() => leave(), 2000)));
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Busy on a button that keeps its focus: `disabled` would drop it to the page
 * for someone who pressed it from the keyboard. Clicks are ignored meanwhile
 * by whoever checks `isBusy`.
 */
export function setBusy(b: HTMLElement, busy: boolean, label?: string): void {
  if (busy) b.setAttribute("aria-busy", "true");
  else b.removeAttribute("aria-busy");
  let note = b.querySelector<HTMLElement>(".busy-note");
  if (busy && label) {
    note ??= b.appendChild(el("span", { className: "vh busy-note" }));
    note.textContent = label;
  } else note?.remove();
}
export const isBusy = (b: HTMLElement) => b.getAttribute("aria-busy") === "true";

// --------------------------------------------------------------- dialogs

/**
 * A modal with a header and a close button. Closes on Escape, on the close
 * button, and on a click on the backdrop; removes itself once closed.
 */
export function modal(title: string, subtitle?: string, className = ""): { dialog: HTMLDialogElement; body: HTMLElement } {
  const dialog = el("dialog", { className: `modal ${className}`.trim() });
  const titleId = uid("modal-title");
  const subId = uid("modal-sub");
  dialog.setAttribute("aria-labelledby", subtitle ? `${titleId} ${subId}` : titleId);
  const close = button("", { icon: "close", className: "btn-icon btn-quiet modal-close", title: "Close", onClick: () => dialog.close() });
  // Divs, not header and footer: inside a dialog those would be read as the
  // page's own banner and footer landmarks.
  const head = el(
    "div",
    { className: "modal-head" },
    el("div", { className: "modal-titles" }, el("h2", { id: titleId }, title), subtitle ? el("p", { className: "modal-sub", id: subId }, subtitle) : null),
    close,
  );
  const body = el("div", { className: "modal-body" });
  dialog.append(head, body);
  toastRegions(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  return { dialog, body };
}

/**
 * Ask before something that cannot be undone. Resolves true for yes. `title`
 * may hold a node — a pad's name, set in mono. With `typed`, yes stays off
 * until that word is typed: for the few things one click is too few for.
 */
export function confirmDialog(opts: { title: string | (string | Node)[]; body: string; confirm: string; danger?: boolean; typed?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = el("dialog", { className: "modal modal-confirm" });
    const titleId = uid("confirm-title");
    const bodyId = uid("confirm-body");
    // An alert dialog, so the consequence is read out with the question.
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.setAttribute("aria-describedby", bodyId);
    let answer = false;
    const yes = button(opts.confirm, { className: opts.danger ? "btn-danger" : "btn-primary", onClick: () => { answer = true; dialog.close(); } });
    const no = button("Cancel", { onClick: () => dialog.close() });
    const heading = el("h2", { id: titleId });
    heading.append(...(typeof opts.title === "string" ? [opts.title] : opts.title));
    const body = el("div", { className: "confirm-body" }, heading, el("p", { id: bodyId }, opts.body));
    let first: HTMLElement = no;
    if (opts.typed) {
      const word = opts.typed;
      const inputId = uid("confirm-typed");
      const input = el("input", { id: inputId, className: "confirm-typed", type: "text" }) as HTMLInputElement;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("autocapitalize", "off");
      const label = el("label", { className: "confirm-typed-label" }, "Type ", el("strong", {}, word), " to confirm");
      label.htmlFor = inputId;
      const match = () => input.value.trim().toLowerCase() === word;
      yes.disabled = true;
      input.addEventListener("input", () => (yes.disabled = !match()));
      // Enter in the field is yes, once the word is there; never before.
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (match()) yes.click();
      });
      body.append(label, input);
      // Typing is the next thing to do, and nothing happens until it is done.
      first = input;
    }
    dialog.append(body, el("div", { className: "confirm-actions" }, no, yes));
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
    // The safe choice has focus, so Enter does not destroy anything.
    first.focus();
  });
}
