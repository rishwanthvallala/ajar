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
import { brand, button, confirmDialog, el, icon, providerButtons, themeToggle, toast } from "./ui";

const SIGN_IN_ERRORS: Record<string, string> = {
  access_denied: "Signing in was cancelled. You can try again whenever you like.",
};

function topbar(...right: (HTMLElement | null)[]): HTMLElement {
  return el("header", { className: "topbar" }, el("div", { className: "topbar-inner" }, brand(), el("div", { className: "topbar-right" }, ...right, themeToggle())));
}

function footer(): HTMLElement {
  return el(
    "footer",
    { className: "page-foot" },
    el("a", { href: "/privacy" }, "Privacy"),
    el("span", { className: "dot-sep" }, "·"),
    el("a", { href: "/" }, "Open a pad"),
  );
}

function shell(...children: HTMLElement[]): HTMLElement {
  return el("div", { className: "acct" }, ...children);
}

/** A person's initial in a circle, coloured from their name. */
function avatar(name: string): HTMLElement {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = el("span", { className: "avatar" }, (name.trim()[0] ?? "?").toUpperCase());
  a.style.setProperty("--hue", String(h % 360));
  return a;
}

/** The signed-in person, as a menu: who, and the way out. */
function accountMenu(me: Me, onSignOut: () => void): HTMLElement {
  const user = me.user!;
  const wrap = el("div", { className: "menu-wrap" });
  const trigger = el("button", { type: "button", className: "account-button" }, avatar(user.name), el("span", { className: "account-name" }, user.name), icon("chevron"));
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  const menu = el("div", { className: "menu", hidden: true });
  menu.setAttribute("role", "menu");
  const signOut = el("button", { type: "button", className: "menu-item" }, icon("out"), "Sign out");
  signOut.setAttribute("role", "menuitem");
  signOut.onclick = onSignOut;
  const privacy = el("a", { className: "menu-item", href: "/privacy" }, icon("lock"), "Privacy");
  privacy.setAttribute("role", "menuitem");
  menu.append(
    el(
      "div",
      { className: "menu-who" },
      avatar(user.name),
      el(
        "div",
        {},
        el("strong", {}, user.name),
        el("span", {}, user.email ?? `Signed in with ${PROVIDERS[user.provider] ?? user.provider}`),
        user.email ? el("span", {}, `with ${PROVIDERS[user.provider] ?? user.provider}`) : null,
      ),
    ),
    privacy,
    signOut,
  );
  const close = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  trigger.onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    trigger.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) signOut.focus();
  };
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target as Node)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      close();
      trigger.focus();
    }
  });
  wrap.append(trigger, menu);
  return wrap;
}

// ------------------------------------------------------------- signing in

function feature(name: IconName, title: string, text: string): HTMLElement {
  return el("li", {}, el("span", { className: "feature-icon" }, icon(name)), el("div", {}, el("strong", {}, title), el("span", {}, text)));
}

function signInPage(me: Me, problem: string | null): HTMLElement {
  const card = el(
    "section",
    { className: "card auth-card" },
    el("h2", {}, "Sign in"),
    el("p", { className: "muted" }, "No password, and nothing in your inbox. We only learn your name and email."),
  );
  if (problem) {
    const alert = el("div", { className: "alert" }, icon("alert"), el("span", {}, SIGN_IN_ERRORS[problem] ?? `Signing in did not finish (${problem}). Try again.`));
    alert.setAttribute("role", "alert");
    card.append(alert);
  }
  card.append(
    me.providers.length
      ? providerButtons(me.providers, "/dashboard")
      : el("div", { className: "alert alert-quiet" }, icon("alert"), el("span", {}, "Signing in is not set up on this server.")),
    el("div", { className: "divider" }, el("span", {}, "or")),
    el("a", { className: "btn btn-block btn-ghost", href: "/" }, el("span", { className: "btn-label" }, "Open a pad without signing in"), icon("arrow")),
    el("p", { className: "fine" }, "Anyone with an open pad's link can edit it, and it goes after 90 days unopened."),
  );
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

const VIEW_CHIP: Record<View, { icon: IconName; text: string; title: string }> = {
  link: { icon: "globe", text: "Anyone with the link", title: "Anyone with the address can view it" },
  code: { icon: "link", text: "View link only", title: "Only people with a view link can open it" },
  owner: { icon: "lock", text: "Private", title: "Only you can view it" },
};
const EDIT_CHIP: Record<Edit, { icon: IconName; text: string; title: string }> = {
  code: { icon: "pencil", text: "Editable by link", title: "Anyone with an edit link can change it" },
  owner: { icon: "lock", text: "Only you edit", title: "Only you can change it" },
};

function chip(c: { icon: IconName; text: string; title: string }, kind: string): HTMLElement {
  const span = el("span", { className: `chip chip-${kind}`, title: c.title }, icon(c.icon), el("span", {}, c.text));
  return span;
}

function made(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function skeletonList(): HTMLElement {
  const list = el("div", { className: "pad-list loading" });
  for (let i = 0; i < 3; i++) {
    list.append(el("div", { className: "pad-row" }, el("span", { className: "skeleton block" }), el("div", { className: "pad-main" }, el("span", { className: "skeleton" }), el("span", { className: "skeleton short" }))));
  }
  return list;
}

/** The dashboard. */
export async function startDashboard(root: HTMLElement): Promise<void> {
  document.title = "Your pads — pad";
  let me: Me;
  try {
    me = await account.me();
  } catch (e) {
    root.replaceChildren(shell(topbar(), el("main", { className: "center" }, el("div", { className: "card gate" }, el("div", { className: "gate-icon" }, icon("alert")), el("h1", {}, "Could not reach pad"), el("p", { className: "muted" }, (e as Error).message))), footer()));
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
  const list = skeletonList();
  const usage = el("p", { className: "page-usage" });
  const meter = el("div", { className: "meter" }, el("span", { className: "meter-fill" }));
  meter.setAttribute("role", "presentation");
  const create = button("New pad", { icon: "plus", className: "btn-primary" });
  create.id = "new-pad";

  const draw = () => {
    const limits = me.limits;
    const used = pads.reduce((n, p) => n + p.bytes, 0);
    usage.textContent = limits
      ? `${pads.length} of ${limits.pads} pads · ${size(used)} of ${size(limits.bytes)}`
      : `${pads.length} pads · ${size(used)}`;
    const fill = limits ? Math.min(1, Math.max(pads.length / limits.pads, used / limits.bytes)) : 0;
    (meter.firstElementChild as HTMLElement).style.width = `${Math.round(fill * 100)}%`;
    meter.classList.toggle("full", fill >= 1);
    create.disabled = !!limits && pads.length >= limits.pads;
    create.title = create.disabled ? "Delete a pad to make another" : "A new pad with a three-word name";
    list.classList.remove("loading");
    if (pads.length === 0) {
      list.replaceChildren(
        el(
          "div",
          { className: "empty" },
          icon("mark", "empty-mark"),
          el("h2", {}, "No pads yet"),
          el("p", {}, "A pad of your own gets a three-word name, never expires, and lets you choose who can view it and who can edit it."),
          button("Make your first pad", { icon: "plus", className: "btn-primary", onClick: () => create.click() }),
        ),
      );
      return;
    }
    list.replaceChildren(...pads.map(row));
  };

  const row = (pad: PadInfo): HTMLElement => {
    const r = el("article", { className: "pad-row pad-card" });
    r.dataset.name = pad.name;
    const href = `/${pad.name}`;
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
          onChange: (next) => {
            const i = pads.findIndex((p) => p.name === next.name);
            if (i >= 0) pads[i] = next;
            r.replaceWith(row(next));
          },
        }),
    });
    const open = el("a", { className: "btn btn-small btn-icon", href, title: `Open ${pad.name}` }, icon("open"));
    open.setAttribute("aria-label", `Open ${pad.name}`);
    const remove = button("", {
      icon: "trash",
      className: "btn-small btn-icon btn-quiet-danger",
      title: `Delete ${pad.name}`,
      onClick: async () => {
        const yes = await confirmDialog({
          title: `Delete ${pad.name}?`,
          body: "Its files go for good, everyone with a link loses it, and the name is never used again.",
          confirm: "Delete pad",
          danger: true,
        });
        if (!yes) return;
        try {
          await account.remove(pad.name);
          pads = pads.filter((p) => p.name !== pad.name);
          draw();
          toast(`Deleted ${pad.name}`);
        } catch (e) {
          toast((e as Error).message, "error");
        }
      },
    });
    r.append(
      el("a", { className: "pad-glyph", href, tabIndex: -1 }, icon("file")),
      el(
        "div",
        { className: "pad-main" },
        el("a", { className: "pad-name", href }, pad.name),
        el("span", { className: "pad-meta" }, `${pad.files} ${pad.files === 1 ? "file" : "files"} · ${size(pad.bytes)} · made ${made(pad.created)}`),
      ),
      el("div", { className: "pad-chips" }, chip(VIEW_CHIP[pad.view], `view-${pad.view}`), chip(EDIT_CHIP[pad.edit], `edit-${pad.edit}`)),
      el("div", { className: "pad-actions" }, share, open, remove),
    );
    return r;
  };

  create.onclick = async () => {
    create.disabled = true;
    create.classList.add("busy");
    try {
      const pad = await account.create();
      location.assign(`/${pad.name}`);
    } catch (e) {
      toast((e as Error).message, "error");
      create.disabled = false;
      create.classList.remove("busy");
    }
  };

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
  try {
    pads = await account.pads();
    draw();
  } catch (e) {
    list.classList.remove("loading");
    list.replaceChildren(
      el("div", { className: "alert" }, icon("alert"), el("span", {}, e instanceof AccountError && e.status === 401 ? "You were signed out — reload to sign in again." : (e as Error).message)),
    );
  }
}

/** A pad this browser may not open. */
export async function showPrivate(root: HTMLElement, name: string): Promise<void> {
  document.title = `${name} — pad`;
  const me = await account.me().catch((): Me => ({ user: null, providers: [] }));
  const signOut = async () => {
    await account.signOut().catch(() => {});
    location.reload();
  };
  const card = el(
    "section",
    { className: "card gate" },
    el("div", { className: "gate-icon" }, icon("lock")),
    el("h1", {}, "This pad is private"),
    el("code", { className: "name-chip" }, name),
    el("p", { className: "muted" }, "It belongs to someone's account, and this browser has no link that opens it. Ask its owner to send you one."),
  );
  if (me.user) {
    card.append(
      el("p", { className: "gate-who" }, avatar(me.user.name), el("span", {}, `Signed in as ${me.user.name} — it isn't one of your pads.`)),
      button("Use another account", { icon: "out", className: "btn-block", onClick: () => void signOut() }),
    );
  } else if (me.providers.length) {
    card.append(el("p", { className: "gate-ask" }, "Is it yours? Sign in to open it."), providerButtons(me.providers, `/${name}`));
  }
  card.append(el("div", { className: "divider" }, el("span", {}, "or")), el("a", { className: "btn btn-block btn-ghost", href: "/" }, el("span", { className: "btn-label" }, "Open a new pad instead"), icon("arrow")));
  root.replaceChildren(shell(topbar(me.user ? accountMenu(me, () => void signOut()) : null), el("main", { className: "center" }, card), footer()));
}
