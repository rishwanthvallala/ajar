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

/** A short confirmation at the bottom of the screen: "Link copied". */
export function toast(text: string, kind: "ok" | "error" = "ok"): void {
  let region = document.getElementById("toasts");
  if (!region) {
    region = el("div", { id: "toasts", className: "toasts" });
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.append(region);
  }
  // Inside an open modal dialog, so it is not underneath the backdrop.
  const host = document.querySelector("dialog[open]") ?? document.body;
  if (region.parentElement !== host) host.append(region);
  const t = el("div", { className: `toast toast-${kind}` }, icon(kind === "ok" ? "check" : "alert"), el("span", {}, text));
  region.append(t);
  setTimeout(() => t.classList.add("leaving"), 2600);
  setTimeout(() => t.remove(), 3000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- dialogs

/**
 * A modal with a header and a close button. Closes on Escape, on the close
 * button, and on a click on the backdrop; removes itself once closed.
 */
export function modal(title: string, subtitle?: string, className = ""): { dialog: HTMLDialogElement; body: HTMLElement } {
  const dialog = el("dialog", { className: `modal ${className}`.trim() });
  dialog.setAttribute("aria-label", subtitle ? `${title} ${subtitle}` : title);
  const close = button("", { icon: "close", className: "btn-icon btn-quiet modal-close", title: "Close", onClick: () => dialog.close() });
  const head = el("header", { className: "modal-head" }, el("div", { className: "modal-titles" }, el("h2", {}, title), subtitle ? el("p", { className: "modal-sub" }, subtitle) : null), close);
  const body = el("div", { className: "modal-body" });
  dialog.append(head, body);
  dialog.addEventListener("close", () => dialog.remove());
  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  return { dialog, body };
}

/** Ask before something that cannot be undone. Resolves true for yes. */
export function confirmDialog(opts: { title: string; body: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = el("dialog", { className: "modal modal-confirm" });
    dialog.setAttribute("aria-label", opts.title);
    let answer = false;
    const yes = button(opts.confirm, { className: opts.danger ? "btn-danger" : "btn-primary", onClick: () => { answer = true; dialog.close(); } });
    const no = button("Cancel", { onClick: () => dialog.close() });
    dialog.append(
      el("div", { className: "confirm-body" }, el("h2", {}, opts.title), el("p", {}, opts.body)),
      el("div", { className: "confirm-actions" }, no, yes),
    );
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
    // The safe choice has focus, so Enter does not destroy anything.
    no.focus();
  });
}
