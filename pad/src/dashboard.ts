/**
 * Your pads, at /dashboard — signing in, the list of pads you own — and the
 * screen for a pad you may not open.
 *
 * Plain pages on the pad's origin rather than part of the editor: none of
 * them needs the runtime, the editor or the room, and the dashboard is where
 * someone arrives back from signing in. Styles are in accounts.css.
 */
import { account, AccountError, codeFor, type Edit, type Me, type PadInfo, type PadLink, parsePadLink, PROVIDERS, size, type View } from "./access";
import type { IconName } from "./icons";
import { openShare } from "./share";
import { type Change, type Pad, Store, StoreError } from "./store";
import { brand, button, clearBusy, confirmDialog, el, icon, isBusy, modal, providerButtons, setBusy, themeToggle, toast, toastRegions, uid } from "./ui";
import { leftOut, PAD_LIMITS, pickZip, prepareImport, readZip, ZipError } from "./zip";

/** Reasons a provider sends someone back with, that are not failures. */
const SIGN_IN_CANCELLED = new Set(["access_denied"]);

/** Why a sign-in came back unfinished, in words — the relay sends only a code. */
function signInProblem(code: string): string {
  switch (code) {
    case "access_denied":
      return "Signing in was cancelled. You can try again whenever you like.";
    case "expired":
      return "That sign-in took longer than ten minutes, so it was stopped. Try again.";
    case "elsewhere":
    case "not_started":
      return "That sign-in was started in another tab or browser. Start again here.";
    case "provider":
      return "Google or GitHub did not complete that sign-in. Try again in a moment.";
    case "unavailable":
      return "Signing in with that service is not set up here.";
    default:
      return "Signing in did not finish. Try again.";
  }
}

function signInAlert(code: string): HTMLElement {
  // Cancelling at the provider is a choice, not a failure: said quietly.
  const cancelled = SIGN_IN_CANCELLED.has(code);
  const alert = el("div", { className: cancelled ? "alert alert-quiet" : "alert" }, icon("alert"), el("span", {}, signInProblem(code)));
  alert.setAttribute("role", cancelled ? "status" : "alert");
  return alert;
}

export function topbar(...right: (HTMLElement | null)[]): HTMLElement {
  return el("header", { className: "topbar" }, el("div", { className: "topbar-inner" }, brand(), el("div", { className: "topbar-right" }, ...right, themeToggle())));
}

export function footer(): HTMLElement {
  return el(
    "footer",
    { className: "page-foot" },
    el("a", { href: "/privacy" }, "Privacy"),
    el("span", { className: "dot-sep", ariaHidden: "true" } as Partial<HTMLSpanElement>, "·"),
    el("a", { href: "/" }, "Open a pad"),
  );
}

export function shell(...children: HTMLElement[]): HTMLElement {
  return el("div", { className: "acct" }, ...children);
}

/** A person's initial in a circle, coloured from their name. Decoration: the name is always beside it. */
function avatar(name: string): HTMLElement {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = el("span", { className: "avatar" }, (name.trim()[0] ?? "?").toUpperCase());
  a.setAttribute("aria-hidden", "true");
  a.style.setProperty("--hue", String(h % 360));
  return a;
}

/**
 * The signed-in person, and the way out. A disclosure — a button that shows a
 * panel — not an application menu: two items do not need arrow keys, and a
 * panel can say who you are, which a menu cannot.
 */
export function accountMenu(me: Me, onSignOut: () => void): HTMLElement {
  const user = me.user!;
  const provider = PROVIDERS[user.provider] ?? user.provider;
  const wrap = el("div", { className: "menu-wrap" });
  const trigger = el("button", { type: "button", className: "account-button" }, avatar(user.name), el("span", { className: "account-name" }, user.name), icon("chevron"));
  trigger.setAttribute("aria-label", `${user.name} — account`);
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", "account-menu");
  const signOut = el("button", { type: "button", className: "menu-item" }, icon("out"), "Sign out");
  signOut.onclick = onSignOut;
  const menu = el(
    "div",
    { className: "menu", id: "account-menu", hidden: true },
    el(
      "div",
      { className: "menu-who" },
      avatar(user.name),
      el("div", {}, el("strong", {}, user.name), el("span", {}, user.email ? `${user.email} · ${provider}` : `Signed in with ${provider}`)),
    ),
    me.admin ? el("a", { className: "menu-item", href: "/admin" }, icon("chart"), "Admin") : null,
    el("a", { className: "menu-item", href: "/privacy" }, icon("shield"), "Privacy"),
    signOut,
  );
  const setOpen = (open: boolean) => {
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  };
  trigger.onclick = () => setOpen(menu.hidden);
  // Closes when the pointer or the focus goes anywhere else, so it never
  // sits over the page under someone tabbing on.
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target as Node)) setOpen(false);
  });
  wrap.addEventListener("focusout", (e) => {
    if (!wrap.contains(e.relatedTarget as Node | null)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || menu.hidden) return;
    const inside = wrap.contains(document.activeElement);
    setOpen(false);
    if (inside) trigger.focus();
  });
  wrap.append(trigger, menu);
  return wrap;
}

// ------------------------------------------------------------- signing in

function feature(name: IconName, title: string, text: string): HTMLElement {
  return el("li", {}, el("span", { className: "feature-icon" }, icon(name)), el("div", {}, el("strong", {}, title), el("span", {}, text)));
}

function signInPage(me: Me, problem: string | null): HTMLElement {
  const offered = me.providers.length > 0;
  const card = el(
    "section",
    { className: "card auth-card" },
    el("h2", {}, offered ? "Sign in" : "Open pads still work"),
    el("p", { className: "muted" }, offered ? "No password, and nothing in your inbox. We only learn your name and email." : "Signing in isn't available on this server, so there are no pads of your own here — but anyone can open a pad and share it."),
  );
  if (problem) card.append(signInAlert(problem));
  if (offered) {
    card.append(
      providerButtons(me.providers, "/dashboard"),
      el("div", { className: "divider" }, el("span", {}, "or")),
      el("a", { className: "btn btn-block btn-ghost", href: "/" }, el("span", { className: "btn-label" }, "Open a pad without signing in"), icon("arrow")),
      el("p", { className: "fine" }, "Open pads can be edited by anyone with the link, and are deleted after 90 days without a visit."),
    );
  } else {
    card.append(el("a", { className: "btn btn-block btn-primary", href: "/" }, el("span", { className: "btn-label" }, "Open a pad"), icon("arrow")));
  }
  // Nothing to sign in with: no pitch for it, just the way to an open pad.
  if (!offered) return shell(topbar(), el("main", { className: "center" }, card), footer());
  return shell(
    topbar(),
    el(
      "main",
      { className: "auth" },
      el(
        "section",
        { className: "auth-pitch" },
        el("p", { className: "eyebrow" }, "pad — code you can send"),
        el("h1", {}, "Pads you control."),
        el("p", { className: "lede" }, "Sign in to keep pads with three-word names, and decide for each one who can view it and who can edit it."),
        el(
          "ul",
          { className: "features" },
          feature("link", "Two kinds of link", "A view link to watch and run, an edit link to change it with you."),
          feature("eye", "Viewers watch live", "Every keystroke as it happens. They can run it too — their changes stay with them."),
          feature("lock", "Private when you want", "Turn viewing or editing off for everyone but you, any time."),
        ),
      ),
      card,
    ),
    footer(),
  );
}

// ------------------------------------------------------------- the list

/** Short and parallel, so a column of them reads at a glance: the same two words, the same width. */
const VIEW_CHIP: Record<View, { text: string; title: string; open: boolean }> = {
  link: { text: "Anyone", title: "Anyone with the address can view it", open: true },
  code: { text: "View link", title: "Only people with a view link can open it", open: true },
  owner: { text: "Only you", title: "Only you can view it", open: false },
};
const EDIT_CHIP: Record<Edit, { text: string; title: string; open: boolean }> = {
  code: { text: "Edit link", title: "Anyone with an edit link can change it", open: true },
  owner: { text: "Only you", title: "Only you can change it", open: false },
};

function chip(kind: "view" | "edit", c: { text: string; title: string; open: boolean }): HTMLElement {
  return el(
    "span",
    { className: `chip chip-${kind}${c.open ? " chip-open" : ""}`, title: c.title },
    icon(kind === "view" ? "eye" : "pencil"),
    // The icon says which setting; read aloud, the words have to.
    el("span", { className: "vh" }, kind === "view" ? "Who can view: " : "Who can edit: "),
    el("span", {}, c.text),
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Quiet ways on, under a card's one main action. */
function gateLinks(...links: [string, string][]): HTMLElement {
  const row = el("p", { className: "gate-links" });
  links.forEach(([text, href], i) => {
    if (i) row.append(el("span", { ariaHidden: "true" } as Partial<HTMLSpanElement>, "·"));
    row.append(el("a", { href }, text));
  });
  return row;
}

function made(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The dashboard. */
export async function startDashboard(root: HTMLElement): Promise<void> {
  document.title = "Your pads — pad";
  toastRegions();
  let me: Me;
  try {
    me = await account.me();
  } catch (e) {
    root.replaceChildren(shell(topbar(), el("main", { className: "center" }, el("div", { className: "card gate" }, el("div", { className: "gate-icon" }, icon("alert")), el("h1", {}, "Could not reach pad"), el("p", { className: "muted" }, (e as Error).message), button("Try again", { icon: "reset", className: "btn-block", onClick: () => location.reload() }))), footer()));
    return;
  }

  const params = new URLSearchParams(location.search);
  const problem = params.get("signin");
  const deletedAccount = params.get("deleted") === "account";
  if (problem || deletedAccount) history.replaceState(null, "", location.pathname);

  if (!me.user) {
    document.title = "Sign in — pad";
    root.replaceChildren(signInPage(me, problem));
    if (deletedAccount) toast("Your account and its pads were deleted.");
    return;
  }

  const signOut = async () => {
    try {
      await account.signOut();
      location.assign("/dashboard");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  let pads: PadInfo[] = [];
  const list = el("ul", { className: "pad-list" });
  const usage = el("p", { className: "page-usage" });
  const meter = el("div", { className: "meter" }, el("span", { className: "meter-fill" }));
  meter.setAttribute("aria-hidden", "true");
  const create = button("New pad", { icon: "plus", className: "btn-primary" });
  create.id = "new-pad";
  const fromZip = button("Import a zip", { icon: "upload", title: "A new pad of yours, with a zip's files in it" });
  fromZip.id = "import-zip";
  const fromLink = button("Copy a pad", { icon: "copy", title: "A new pad of yours, with the files of a pad you have a link to" });
  fromLink.id = "copy-pad";
  const limits = me.limits;
  const full = () => !!limits && pads.length >= limits.pads;

  const loading = () => {
    list.setAttribute("aria-busy", "true");
    const rows = [0, 1, 2].map(() => el("li", { className: "pad-row" }, el("span", { className: "skeleton block" }), el("div", { className: "pad-main" }, el("span", { className: "skeleton" }), el("span", { className: "skeleton short" }))));
    list.replaceChildren(...rows, el("li", { className: "vh" }, "Loading your pads…"));
  };

  const draw = () => {
    const used = pads.reduce((n, p) => n + p.bytes, 0);
    list.removeAttribute("aria-busy");
    usage.textContent = limits
      ? `${pads.length} of ${limits.pads} pads · ${size(used)} of ${size(limits.bytes)}${full() ? " — delete one to make another" : ""}`
      : `${pads.length} pads · ${size(used)}`;
    usage.classList.toggle("full", full());
    const fill = limits ? Math.min(1, Math.max(pads.length / limits.pads, used / limits.bytes)) : 0;
    meter.hidden = false;
    (meter.firstElementChild as HTMLElement).style.width = `${Math.round(fill * 100)}%`;
    meter.classList.toggle("full", fill >= 1);
    // Focusable even when it cannot be pressed, so its reason can be found.
    if (full()) create.setAttribute("aria-disabled", "true");
    else create.removeAttribute("aria-disabled");
    // The empty state has its own button; two primaries would compete.
    create.hidden = pads.length === 0;
    for (const b of [fromZip, fromLink]) {
      b.hidden = pads.length === 0;
      if (full()) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    }
    if (pads.length === 0) {
      list.replaceChildren(
        el(
          "li",
          { className: "empty" },
          el("span", { className: "empty-icon" }, icon("file")),
          el("h2", {}, "No pads yet"),
          el("p", {}, "A pad of your own gets a three-word name, never expires, and lets you choose who can view it and who can edit it."),
          el(
            "div",
            { className: "empty-actions" },
            button("Make your first pad", { icon: "plus", className: "btn-primary", onClick: () => void makePad(create) }),
            button("Start from a zip", { icon: "upload", onClick: (e) => void makeFromZip(e.currentTarget as HTMLElement) }),
            button("Copy a pad", { icon: "copy", onClick: () => copyFromLink() }),
          ),
        ),
      );
      return;
    }
    list.replaceChildren(...pads.map(row));
  };

  const row = (first: PadInfo): HTMLElement => {
    let pad = first;
    const r = el("li", { className: "pad-row pad-card" });
    r.dataset.name = pad.name;
    const href = `/${pad.name}`;
    const titleId = `pad-${pad.name}`;
    r.setAttribute("aria-labelledby", titleId);
    const chips = el("div", { className: "pad-chips" });
    const paintChips = () => chips.replaceChildren(chip("view", VIEW_CHIP[pad.view]), chip("edit", EDIT_CHIP[pad.edit]));
    paintChips();
    const share = button("Share", {
      icon: "link",
      className: "btn-small",
      onClick: () =>
        void openShare({
          name: pad.name,
          access: { role: "owner", account: true, view: pad.view, edit: pad.edit },
          code: null,
          pad,
          fromDashboard: true,
          onGone: () => {
            pads = pads.filter((p) => p.name !== pad.name);
            draw();
            toast(`${pad.name} no longer exists — it was deleted in another tab`, "error");
          },
          // In place, not a new row: the dialog hands the focus back to this
          // button when it closes, and a replaced row would have taken it away.
          onChange: (next) => {
            pad = next;
            const i = pads.findIndex((p) => p.name === next.name);
            if (i >= 0) pads[i] = next;
            paintChips();
          },
        }),
    });
    share.setAttribute("aria-label", `Share ${pad.name}`);
    const open = el("a", { className: "btn btn-small btn-icon pad-open", href, title: `Open ${pad.name}` }, icon("open"));
    open.setAttribute("aria-label", `Open ${pad.name}`);
    const remove = button("", {
      icon: "trash",
      className: "btn-small btn-icon btn-quiet-danger",
      title: `Delete ${pad.name}`,
      onClick: async () => {
        if (isBusy(remove)) return;
        const yes = await confirmDialog({
          title: ["Delete ", el("span", { className: "mono" }, pad.name), "?"],
          body: "Its files go for good, everyone with a link loses it, and the name is never used again.",
          confirm: "Delete pad",
          danger: true,
        });
        if (!yes) return;
        setBusy(remove, true, "Deleting…");
        try {
          await account.remove(pad.name).catch((e) => {
            // Already gone — deleted in another tab. Gone is what was asked for.
            if (!(e instanceof AccountError && e.status === 404)) throw e;
          });
          // Onto the next pad, or the one before, so the focus is not left on
          // a button that no longer exists.
          const next = (r.nextElementSibling ?? r.previousElementSibling) as HTMLElement | null;
          const nextName = next?.dataset.name;
          pads = pads.filter((p) => p.name !== pad.name);
          draw();
          const target = nextName ? list.querySelector<HTMLElement>(`[data-name="${nextName}"] .pad-name`) : list.querySelector<HTMLElement>(".empty .btn");
          target?.focus();
          toast(`Deleted ${pad.name}`);
        } catch (e) {
          staleSession(e);
          toast((e as Error).message, "error");
          setBusy(remove, false);
        }
      },
    });
    const glyph = el("a", { className: "pad-glyph", href, tabIndex: -1 }, icon("file"));
    // The name beside it is the link; this one is only a bigger target.
    glyph.setAttribute("aria-hidden", "true");
    r.append(
      glyph,
      el(
        "div",
        { className: "pad-main" },
        el("h2", { className: "pad-title", id: titleId }, el("a", { className: "pad-name", href }, pad.name)),
        el("span", { className: "pad-meta" }, `${pad.files} ${pad.files === 1 ? "file" : "files"} · ${size(pad.bytes)} · made ${made(pad.created)}`),
      ),
      chips,
      el("div", { className: "pad-actions" }, share, open, remove),
    );
    return r;
  };

  /** A session that ended in another tab: back to signing in, rather than error after error. */
  const staleSession = (e: unknown) => {
    if (e instanceof AccountError && e.status === 401) setTimeout(() => location.assign("/dashboard"), 1500);
  };

  const makePad = async (from: HTMLElement) => {
    if (isBusy(from)) return;
    if (full()) {
      toast(`An account holds ${limits!.pads} pads — delete one to make another`, "error");
      return;
    }
    setBusy(from, true, "Making a pad…");
    try {
      // Two windows side by side never hide each other, so a page can be
      // showing someone who is no longer the one signed in. The pad would be
      // made in the other account.
      const now = await account.me();
      if (now.user?.id !== me.user?.id) return location.reload();
      const pad = await account.create();
      location.assign(`/${pad.name}`);
    } catch (e) {
      staleSession(e);
      toast((e as Error).message, "error");
      setBusy(from, false);
    }
  };
  create.onclick = () => void makePad(create);

  /**
   * A new pad of theirs with a zip's files in it. The zip is read and held to
   * a pad's limits here first; if writing its files fails, the pad made for
   * them goes too, rather than staying behind empty in their list.
   */
  const makeFromZip = async (from: HTMLElement) => {
    if (isBusy(from)) return;
    if (full()) return toast(`An account holds ${limits!.pads} pads — delete one to make another`, "error");
    const zip = await pickZip();
    if (!zip) return;
    setBusy(from, true, `Reading ${zip.name}…`);
    try {
      let prepared;
      try {
        prepared = prepareImport(await readZip(zip, PAD_LIMITS));
      } catch (e) {
        throw new Error(e instanceof ZipError ? e.message : `could not read ${zip.name} as a zip`);
      }
      if (!prepared.files.length) {
        const why = leftOut(prepared);
        throw new Error(`nothing in ${zip.name} a pad can hold${why ? ` — ${why}` : ""}`);
      }
      const now = await account.me();
      if (now.user?.id !== me.user?.id) return location.reload();
      const pad = await account.create();
      try {
        await new Store("", codeFor).write(pad.name, prepared.files.map((f) => ({ path: f.path, content: f.content, encoding: f.encoding })));
      } catch (e) {
        await account.remove(pad.name).catch(() => {});
        throw e;
      }
      location.assign(`/${pad.name}?imported=${prepared.files.length}&skipped=${prepared.unsafe.length}`);
    } catch (e) {
      staleSession(e);
      toast((e as Error).message, "error");
      setBusy(from, false);
    }
  };
  fromZip.onclick = () => void makeFromZip(fromZip);

  /**
   * The files of a pad this person can open, as last saved, read with the code
   * the pasted link carries — or, for a bare name, one this browser already
   * holds. Said in words when it cannot be read: deleted, private, or empty.
   */
  const readForCopy = async (link: PadLink): Promise<Change[]> => {
    let source: Pad;
    try {
      source = await new Store("", () => link.code ?? codeFor(link.name)).read(link.name);
    } catch (e) {
      if (e instanceof StoreError && e.gone) throw new Error(`${link.name} was deleted by its owner.`);
      if (e instanceof StoreError && e.refused) {
        throw new Error(
          /no longer works/.test(e.message)
            ? "That link no longer works — its owner reset it or turned it off."
            : `${link.name} is private. Paste the link its owner shared, with the code after the #.`,
        );
      }
      throw e;
    }
    const files = Object.entries(source.files).map(([path, f]) => ({ path, content: f.content, encoding: f.encoding }));
    if (!source.exists || files.length === 0) throw new Error(`There's no pad at ${link.name} yet — nothing has been saved there.`);
    return files;
  };

  /**
   * A new pad of theirs with another pad's files: a copy, as last saved, of
   * any pad they can open — someone else's, an open one they found, or one of
   * their own. The original is not touched. Like a zip, the new pad goes
   * again if writing into it fails.
   */
  const copyFromLink = () => {
    if (full()) return toast(`An account holds ${limits!.pads} pads — delete one to make another`, "error");
    const { dialog, body } = modal("Copy a pad", "A new pad of yours, with another pad's files", "copy-dialog");
    const inputId = uid("pad-link");
    const hintId = uid("pad-link-hint");
    const label = el("label", { className: "field-label" }, "Link to a pad");
    label.htmlFor = inputId;
    const input = el("input", { id: inputId, className: "text-field", type: "text" }) as HTMLInputElement;
    input.placeholder = `${location.host}/amber-falcon-river`;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("aria-describedby", hintId);
    const hint = el(
      "p",
      { className: "field-hint", id: hintId },
      "Any pad you can open, with the code after the # if its link has one. Its files are copied as they were last saved; the original is not changed.",
    );
    const problem = el("p", { className: "field-problem", hidden: true });
    problem.setAttribute("role", "alert");
    const say = (text: string) => {
      problem.textContent = text;
      problem.hidden = !text;
      if (text) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    };
    const go = button("Make a copy", { icon: "copy", className: "btn-primary", type: "submit" });
    const cancel = button("Cancel", { onClick: () => dialog.close() });
    const form = el("form", { className: "copy-form" }, label, input, hint, problem, el("div", { className: "form-actions" }, cancel, go));
    form.addEventListener("input", () => say(""));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void (async () => {
        if (isBusy(go)) return;
        const link = parsePadLink(input.value);
        if ("error" in link) {
          say(link.error);
          return input.focus();
        }
        setBusy(go, true, `Copying ${link.name}…`);
        input.readOnly = true;
        try {
          const files = await readForCopy(link);
          const now = await account.me();
          if (now.user?.id !== me.user?.id) return location.reload();
          const pad = await account.create();
          try {
            await new Store("", () => null).write(pad.name, files);
          } catch (e) {
            await account.remove(pad.name).catch(() => {});
            throw e;
          }
          location.assign(`/${pad.name}?from=${encodeURIComponent(link.name)}&files=${files.length}`);
        } catch (e) {
          staleSession(e);
          say((e as Error).message);
          setBusy(go, false);
          input.readOnly = false;
          input.focus();
        }
      })();
    });
    body.append(form);
    dialog.showModal();
    input.focus();
  };
  fromLink.onclick = () => copyFromLink();

  const load = async () => {
    loading();
    try {
      pads = await account.pads();
      draw();
    } catch (e) {
      list.removeAttribute("aria-busy");
      meter.hidden = true;
      usage.textContent = "";
      const signedOut = e instanceof AccountError && e.status === 401;
      list.replaceChildren(
        el(
          "li",
          { className: "empty" },
          el("span", { className: "empty-icon bad" }, icon("alert")),
          el("h2", {}, signedOut ? "You were signed out" : "Your pads did not load"),
          el("p", {}, signedOut ? "Sign in again to see them." : capitalise((e as Error).message)),
          signedOut
            ? button("Sign in again", { icon: "arrow", className: "btn-primary", onClick: () => location.assign("/dashboard") })
            : button("Try again", { icon: "reset", onClick: () => void load() }),
        ),
      );
    }
  };

  // Back to a tab left open: whoever is signed in now may not be whom this
  // page shows — another tab signed out, or in as someone else — and its list
  // may be out of date. A different person reloads the page; the same one
  // gets the list as it stands.
  const recheck = async () => {
    const now = await account.me().catch(() => null);
    if (!now) return;
    if (now.user?.id !== me.user?.id) return location.reload();
    if (document.querySelector("dialog[open]") || list.getAttribute("aria-busy")) return;
    const fresh = await account.pads().catch(() => null);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(pads)) {
      pads = fresh;
      draw();
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void recheck();
  });
  // Back to this page from a pad — out of the back-forward cache, as it was
  // left: the button that made the pad still busy, the copy dialog still
  // open over it. Both cleared, then the list and the sign-in checked as for
  // a tab come back to. (Chromium also fires `visibilitychange` after this,
  // which re-reads them too; this one is for a browser that fires it first,
  // while the dialog would still have stopped it.)
  addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    clearBusy();
    for (const d of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) d.close();
    void recheck();
  });

  /** Asked twice over — a dialog, and a word typed into it — then gone. */
  const deleteAccount = async (from: HTMLElement) => {
    if (isBusy(from)) return;
    const n = pads.length;
    const yes = await confirmDialog({
      title: "Delete your account?",
      body: `${n === 0 ? "You have no pads." : `Your ${n === 1 ? "pad is" : `${n} pads are`} deleted for everyone, with ${n === 1 ? "its" : "their"} files and links, and ${n === 1 ? "its name is" : "their names are"} never used again.`} Your name and email address are removed. This cannot be undone.`,
      confirm: "Delete account",
      danger: true,
      typed: "delete",
    });
    if (!yes) return;
    setBusy(from, true, "Deleting your account…");
    try {
      await account.deleteAccount();
      location.assign("/dashboard?deleted=account");
    } catch (e) {
      staleSession(e);
      toast((e as Error).message, "error");
      setBusy(from, false);
    }
  };
  const user = me.user;
  const provider = PROVIDERS[user.provider] ?? user.provider;
  const accountHeading = el("h2", { id: "account-heading" }, "Your account");
  const removeAccount = button("Delete account", { icon: "trash", className: "btn-small btn-quiet-danger", onClick: (e) => void deleteAccount(e.currentTarget as HTMLElement) });
  const accountPart = el(
    "section",
    { className: "dash-account" },
    el("div", {}, accountHeading, el("p", {}, `${user.email ?? user.name}, signed in with ${provider}. Deleting the account deletes every pad in it.`)),
    removeAccount,
  );
  accountPart.setAttribute("aria-labelledby", "account-heading");

  root.replaceChildren(
    shell(
      topbar(accountMenu(me, () => void signOut())),
      el(
        "main",
        { className: "dash" },
        el("div", { className: "dash-head" }, el("div", { className: "dash-title" }, el("h1", {}, "Your pads"), usage, meter), el("div", { className: "dash-actions" }, fromLink, fromZip, create)),
        list,
        accountPart,
      ),
      footer(),
    ),
  );
  await load();
}

/**
 * A pad this browser may not open: private to it, or deleted by its owner.
 * `signin` is why a sign-in begun from this screen came back unfinished.
 */
export async function showPrivate(
  root: HTMLElement,
  name: string,
  why: "private" | "gone" | "invalid" = "private",
  signin: string | null = null,
  deadLink = false,
): Promise<void> {
  document.title = `${name} — pad`;
  toastRegions();
  const me = await account.me().catch((): Me => ({ user: null, providers: [] }));
  const signOut = async () => {
    await account.signOut().catch(() => {});
    location.reload();
  };
  if (why === "invalid") {
    const card = el(
      "section",
      { className: "card gate" },
      el("div", { className: "gate-icon" }, icon("alert")),
      el("h1", {}, "That isn't a pad address"),
      el("code", { className: "name-chip" }, name),
      el("p", { className: "muted" }, "Pad names are lowercase letters, numbers and dashes, up to 64 of them — and a few words are kept for the site itself."),
      el("a", { className: "btn btn-block btn-primary", href: "/" }, el("span", { className: "btn-label" }, "Open a new pad"), icon("arrow")),
    );
    root.replaceChildren(shell(topbar(me.user ? accountMenu(me, () => void signOut()) : null), el("main", { className: "center" }, card), footer()));
    return;
  }
  if (why === "gone") {
    // Nothing to sign in for: whoever asks, it is not there.
    const card = el(
      "section",
      { className: "card gate" },
      el("div", { className: "gate-icon" }, icon("trash")),
      el("h1", {}, "This pad was deleted"),
      el("code", { className: "name-chip" }, name),
      el("p", { className: "muted" }, "Its owner deleted it, and its files are gone. The name won't be used again."),
      el("a", { className: "btn btn-block btn-primary", href: "/" }, el("span", { className: "btn-label" }, "Open a new pad"), icon("arrow")),
      me.user ? gateLinks(["Your pads", "/dashboard"]) : null,
    );
    root.replaceChildren(shell(topbar(me.user ? accountMenu(me, () => void signOut()) : null), el("main", { className: "center" }, card), footer()));
    return;
  }
  const card = el(
    "section",
    { className: "card gate" },
    el("div", { className: "gate-icon" }, icon("lock")),
    el("h1", {}, "This pad is private"),
    el("code", { className: "name-chip" }, name),
    el("p", { className: "muted" }, "It belongs to someone's account, and this browser has no link that opens it. Ask its owner to send you one."),
  );
  if (signin) card.append(signInAlert(signin));
  if (deadLink) {
    const note = el("div", { className: "alert alert-quiet" }, icon("alert"), el("span", {}, "The link you opened no longer works — its owner reset it or turned it off."));
    note.setAttribute("role", "status");
    card.append(note);
  }
  let offered = false;
  if (me.user) {
    offered = true;
    const provider = PROVIDERS[me.user.provider] ?? me.user.provider;
    card.append(
      el("p", { className: "gate-who" }, avatar(me.user.name), el("span", {}, `Signed in as ${me.user.name} with ${provider} — it isn't one of your pads.`)),
      button("Use another account", { icon: "out", className: "btn-block", onClick: () => void signOut() }),
      gateLinks(["Your pads", "/dashboard"], ["Open a new pad", "/"]),
    );
    root.replaceChildren(shell(topbar(accountMenu(me, () => void signOut())), el("main", { className: "center" }, card), footer()));
    return;
  } else if (me.providers.length) {
    offered = true;
    card.append(el("p", { className: "gate-ask" }, "Is it yours? Sign in to open it."), providerButtons(me.providers, `/${name}`));
  }
  // "or" only between two ways forward.
  if (offered) card.append(el("div", { className: "divider" }, el("span", {}, "or")));
  card.append(el("a", { className: `btn btn-block ${offered ? "btn-ghost" : "btn-primary"}`, href: "/" }, el("span", { className: "btn-label" }, "Open a new pad instead"), icon("arrow")));
  root.replaceChildren(shell(topbar(me.user ? accountMenu(me, () => void signOut()) : null), el("main", { className: "center" }, card), footer()));
}
