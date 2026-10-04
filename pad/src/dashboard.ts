/**
 * Your pads, at /dashboard — signing in, the list of pads you own — and the
 * screen for a pad you may not open.
 *
 * Plain pages on the pad's origin rather than part of the editor: none of
 * them needs the runtime, the editor or the room, and the dashboard is where
 * someone arrives back from signing in. Styles are in accounts.css.
 */
import { account, AccountError, type Edit, type Me, type PadInfo, PROVIDERS, size, type View } from "./access";
import type { IconName } from "./icons";
import { openShare } from "./share";
import { brand, button, confirmDialog, el, icon, isBusy, providerButtons, setBusy, themeToggle, toast, toastRegions } from "./ui";

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

function topbar(...right: (HTMLElement | null)[]): HTMLElement {
  return el("header", { className: "topbar" }, el("div", { className: "topbar-inner" }, brand(), el("div", { className: "topbar-right" }, ...right, themeToggle())));
}

function footer(): HTMLElement {
  return el(
    "footer",
    { className: "page-foot" },
    el("a", { href: "/privacy" }, "Privacy"),
    el("span", { className: "dot-sep", ariaHidden: "true" } as Partial<HTMLSpanElement>, "·"),
    el("a", { href: "/" }, "Open a pad"),
  );
}

function shell(...children: HTMLElement[]): HTMLElement {
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
function accountMenu(me: Me, onSignOut: () => void): HTMLElement {
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

  const problem = new URLSearchParams(location.search).get("signin");
  if (problem) history.replaceState(null, "", location.pathname);

  if (!me.user) {
    document.title = "Sign in — pad";
    root.replaceChildren(signInPage(me, problem));
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
    if (pads.length === 0) {
      list.replaceChildren(
        el(
          "li",
          { className: "empty" },
          el("span", { className: "empty-icon" }, icon("file")),
          el("h2", {}, "No pads yet"),
          el("p", {}, "A pad of your own gets a three-word name, never expires, and lets you choose who can view it and who can edit it."),
          button("Make your first pad", { icon: "plus", className: "btn-primary", onClick: () => void makePad(create) }),
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
    const open = el("a", { className: "btn btn-small btn-icon", href, title: `Open ${pad.name}` }, icon("open"));
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
      const pad = await account.create();
      location.assign(`/${pad.name}`);
    } catch (e) {
      staleSession(e);
      toast((e as Error).message, "error");
      setBusy(from, false);
    }
  };
  create.onclick = () => void makePad(create);

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
          el("p", {}, signedOut ? "Sign in again to see them." : (e as Error).message),
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
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    const now = await account.me().catch(() => null);
    if (!now) return;
    if (now.user?.id !== me.user?.id) return location.reload();
    if (document.querySelector("dialog[open]") || list.getAttribute("aria-busy")) return;
    const fresh = await account.pads().catch(() => null);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(pads)) {
      pads = fresh;
      draw();
    }
  });

  root.replaceChildren(
    shell(
      topbar(accountMenu(me, () => void signOut())),
      el(
        "main",
        { className: "dash" },
        el("div", { className: "dash-head" }, el("div", { className: "dash-title" }, el("h1", {}, "Your pads"), usage, meter), create),
        list,
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
export async function showPrivate(root: HTMLElement, name: string, why: "private" | "gone" | "invalid" = "private", signin: string | null = null): Promise<void> {
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
      me.user ? el("a", { className: "btn btn-block btn-ghost gate-second", href: "/dashboard" }, el("span", { className: "btn-label" }, "Your pads")) : null,
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
  let offered = false;
  if (me.user) {
    offered = true;
    const provider = PROVIDERS[me.user.provider] ?? me.user.provider;
    card.append(
      el("p", { className: "gate-who" }, avatar(me.user.name), el("span", {}, `Signed in as ${me.user.name} with ${provider} — it isn't one of your pads.`)),
      button("Use another account", { icon: "out", className: "btn-block", onClick: () => void signOut() }),
      el("a", { className: "btn btn-block btn-ghost gate-second", href: "/dashboard" }, el("span", { className: "btn-label" }, "Your pads")),
    );
  } else if (me.providers.length) {
    offered = true;
    card.append(el("p", { className: "gate-ask" }, "Is it yours? Sign in to open it."), providerButtons(me.providers, `/${name}`));
  }
  // "or" only between two ways forward.
  if (offered) card.append(el("div", { className: "divider" }, el("span", {}, "or")));
  card.append(el("a", { className: `btn btn-block ${offered ? "btn-ghost" : "btn-primary"}`, href: "/" }, el("span", { className: "btn-label" }, "Open a new pad instead"), icon("arrow")));
  root.replaceChildren(shell(topbar(me.user ? accountMenu(me, () => void signOut()) : null), el("main", { className: "center" }, card), footer()));
}
