/**
 * What the account pages and the share dialog are built from that is the
 * pad's own: its brand, the providers' sign-in buttons, the theme switch and
 * a pad's name. The rest of the kit — elements, buttons, toasts, the modal
 * and the confirm dialog — is @ajar/workspace-ui's (kit.ts), which the guest's
 * page of an ajar session uses too, and is passed on from here so the pad's
 * pages have one place to ask. Styles are in accounts.css and the kit's own.
 */
import { applyTheme, parseTheme, THEME_CHOICES, type ThemeChoice } from "@ajar/workspace-ui/theme";
import { button, el, icon, uid } from "@ajar/workspace-ui/kit";
import { ICONS } from "@ajar/workspace-ui/icons";

import { PROVIDERS, signInUrl } from "./access";

export { button, clearBusy, confirmDialog, copyText, el, icon, isBusy, modal, setBusy, toast, toastRegions, uid } from "@ajar/workspace-ui/kit";

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

// --------------------------------------------------------------- dialogs

/**
 * Asked before a pad of one's own is made: three words made up for it, or a
 * name of one's own while the account has named places left. The field says
 * as it is typed whether the name can be had. Resolves to the name, "" for
 * three words, or null when nothing is to be made after all.
 */
export function nameDialog(opts: {
  title: string;
  body: string;
  confirm: string;
  /** Named places left, and of how many. */
  left: number;
  limit: number;
  check: (name: string) => Promise<{ free: boolean; why: string | null }>;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = el("dialog", { className: "modal modal-confirm name-dialog" });
    const titleId = uid("name-title");
    dialog.setAttribute("aria-labelledby", titleId);
    let answer: string | null = null;
    const inputId = uid("name-input");
    const input = el("input", { id: inputId, className: "confirm-typed name-dialog-input", type: "text" }) as HTMLInputElement;
    input.placeholder = "three words, made up for it";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = 64;
    input.setAttribute("autocapitalize", "off");
    const label = el("label", { className: "confirm-typed-label" }, "Name it yourself, or leave it blank");
    label.htmlFor = inputId;
    const said = el("p", { className: "name-dialog-said" });
    said.setAttribute("aria-live", "polite");
    const places = el("p", { className: "name-dialog-places" }, opts.left > 0
      ? `${opts.left} of ${opts.limit} names of your own left. Lowercase letters, digits and dashes; a name is yours for as long as the pad is, and not given out again after.`
      : `You have named ${opts.limit} pads yourself, as many as an account can, so this one gets three words.`);
    if (opts.left <= 0) input.disabled = true;
    const yes = button(opts.confirm, { className: "btn-primary", onClick: () => { answer = input.value.trim(); dialog.close(); } });
    const no = button("Cancel", { onClick: () => dialog.close() });
    // What the server says of what is in the field now; an older answer, for
    // what was there a keystroke ago, is ignored.
    let asked = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const judge = () => {
      // As typed, as a name can be: spaces become dashes, capitals small.
      const tidy = input.value.toLowerCase().replace(/\s+/g, "-");
      if (tidy !== input.value) input.value = tidy;
      const name = input.value.trim();
      clearTimeout(timer);
      // Whatever is asked now, an answer for what was there before is old —
      // the empty field too, which an answer for the name just cleared put
      // "taken" under and turned the button off again (audit UX2).
      const mine = ++asked;
      if (!name) {
        said.textContent = "";
        said.className = "name-dialog-said";
        yes.disabled = false;
        return;
      }
      yes.disabled = true;
      said.textContent = "checking…";
      said.className = "name-dialog-said";
      timer = setTimeout(() => {
        void opts.check(name).then(
          (r) => {
            if (mine !== asked) return;
            said.textContent = r.free ? `${name} is free` : (r.why ?? `${name} cannot be had`);
            said.className = `name-dialog-said ${r.free ? "free" : "taken"}`;
            yes.disabled = !r.free;
          },
          (e: Error) => {
            if (mine !== asked) return;
            said.textContent = e.message;
            said.className = "name-dialog-said taken";
          },
        );
      }, 300);
    };
    input.addEventListener("input", judge);
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!yes.disabled) yes.click();
    });
    const body = el("div", { className: "confirm-body" }, el("h2", { id: titleId }, opts.title), el("p", {}, opts.body), label, input, said, places);
    dialog.append(body, el("div", { className: "confirm-actions" }, no, yes));
    dialog.addEventListener("close", () => {
      clearTimeout(timer);
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
    (opts.left > 0 ? input : yes).focus();
  });
}
