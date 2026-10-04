/**
 * Your pads, at /dashboard — and the screen for a pad you may not open.
 *
 * Both are plain pages on the pad's origin rather than part of the editor:
 * neither needs the runtime, the editor or the room, and the dashboard is
 * where someone arrives back from signing in.
 */
import { account, AccountError, type Me, type PadInfo, PROVIDERS, signInUrl, size } from "./access";
import { el, ownerBody } from "./share";

function page(...children: (Node | string)[]): HTMLElement {
  return el(
    "main",
    { className: "page" },
    ...children,
    // Where sign-in is offered, what signing in collects is a click away —
    // and Google's review asks for exactly that.
    el("footer", { className: "page-foot" }, el("a", { href: "/privacy" }, "Privacy")),
  );
}

function signInButtons(me: Me, next: string): HTMLElement {
  if (me.providers.length === 0) {
    return el("p", { className: "page-note" }, "Signing in is not set up on this server.");
  }
  const row = el("div", { className: "page-actions" });
  for (const p of me.providers) {
    row.append(el("a", { className: "page-button primary", href: signInUrl(p, next) }, `Continue with ${PROVIDERS[p] ?? p}`));
  }
  return row;
}

function header(me: Me | null, onSignOut?: () => void): HTMLElement {
  const head = el("header", { className: "page-head" }, el("a", { className: "page-brand", href: "/" }, "pad"));
  if (me?.user) {
    const out = el("button", { type: "button", className: "page-button" }, "Sign out");
    out.onclick = () => onSignOut?.();
    head.append(
      el("span", { className: "page-who" }, `${me.user.name} · ${PROVIDERS[me.user.provider] ?? me.user.provider}`),
      out,
    );
  }
  return head;
}

const SIGN_IN_ERRORS: Record<string, string> = {
  access_denied: "Signing in was cancelled.",
};

/** The dashboard. */
export async function startDashboard(root: HTMLElement): Promise<void> {
  document.title = "Your pads — pad";
  const status = el("p", { className: "page-status", role: "status" } as Partial<HTMLParagraphElement>);
  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle("error", error);
  };

  let me: Me;
  try {
    me = await account.me();
  } catch (e) {
    root.replaceChildren(page(header(null), el("p", { className: "page-note" }, `Could not reach the server: ${(e as Error).message}`)));
    return;
  }

  const problem = new URLSearchParams(location.search).get("signin");
  if (problem) history.replaceState(null, "", location.pathname);

  if (!me.user) {
    root.replaceChildren(
      page(
        header(me),
        el("h1", {}, "Pads you control"),
        el(
          "p",
          { className: "page-lede" },
          "Sign in to make pads with three-word names and decide, for each, who can view it and who can edit it. ",
          "Open pads stay as they are — anyone with the link edits.",
        ),
        ...(problem ? [el("p", { className: "page-status error" }, SIGN_IN_ERRORS[problem] ?? `Signing in failed: ${problem}`)] : []),
        signInButtons(me, "/dashboard"),
        el("p", { className: "page-note" }, el("a", { href: "/" }, "Or open a pad without signing in")),
      ),
    );
    return;
  }

  const list = el("div", { className: "pad-list" });
  const usage = el("span", { className: "page-usage" });
  const create = el("button", { type: "button", className: "page-button primary", id: "new-pad" }, "New pad");

  const signOut = async () => {
    try {
      await account.signOut();
      location.assign("/dashboard");
    } catch (e) {
      say((e as Error).message, true);
    }
  };

  const draw = (pads: PadInfo[]) => {
    const limits = me.limits;
    const used = pads.reduce((n, p) => n + p.bytes, 0);
    usage.textContent = limits
      ? `${pads.length} of ${limits.pads} pads · ${size(used)} of ${size(limits.bytes)}`
      : `${pads.length} pads · ${size(used)}`;
    create.disabled = !!limits && pads.length >= limits.pads;
    create.title = create.disabled ? "Delete a pad to make another" : "A new pad with a three-word name";
    if (pads.length === 0) {
      list.replaceChildren(el("p", { className: "page-note" }, "No pads yet. New pad makes one, and opens it."));
      return;
    }
    list.replaceChildren(...pads.map((pad) => card(pad, pads, draw)));
  };

  const card = (pad: PadInfo, all: PadInfo[], redrawAll: (pads: PadInfo[]) => void): HTMLElement => {
    const box = el("section", { className: "pad-card" });
    box.dataset.name = pad.name;
    const redraw = (next: PadInfo) => {
      const i = all.findIndex((p) => p.name === next.name);
      if (i >= 0) all[i] = next;
      box.replaceWith(card(next, all, redrawAll));
    };
    const remove = el("button", { type: "button", className: "page-button danger" }, "Delete");
    remove.onclick = async () => {
      if (!confirm(`Delete ${pad.name}? Its files go, everyone with a link loses it, and the name is never used again.`)) return;
      try {
        await account.remove(pad.name);
        redrawAll(all.filter((p) => p.name !== pad.name));
        say(`deleted ${pad.name}`);
      } catch (e) {
        say((e as Error).message, true);
      }
    };
    const made = new Date(pad.created * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    box.append(
      el(
        "div",
        { className: "pad-card-head" },
        el("a", { className: "pad-name", href: `/${pad.name}` }, pad.name),
        el("span", { className: "pad-meta" }, `${size(pad.bytes)} · ${pad.files} ${pad.files === 1 ? "file" : "files"} · made ${made}`),
        remove,
      ),
      ...ownerBody(pad, redraw, { say: (text, error) => say(text, error) }, true),
    );
    return box;
  };

  create.onclick = async () => {
    create.disabled = true;
    try {
      const pad = await account.create();
      location.assign(`/${pad.name}`);
    } catch (e) {
      say((e as Error).message, true);
      create.disabled = false;
    }
  };

  root.replaceChildren(
    page(
      header(me, () => void signOut()),
      el("div", { className: "page-title" }, el("h1", {}, "Your pads"), usage, create),
      status,
      list,
    ),
  );
  try {
    draw(await account.pads());
  } catch (e) {
    say(e instanceof AccountError && e.status === 401 ? "You were signed out — reload to sign in again." : (e as Error).message, true);
  }
}

/** A pad this browser may not open. */
export async function showPrivate(root: HTMLElement, name: string): Promise<void> {
  document.title = `${name} — pad`;
  const me = await account.me().catch((): Me => ({ user: null, providers: [] }));
  const signedIn = me.user
    ? el("p", { className: "page-note" }, `You are signed in as ${me.user.name}, and it is not one of your pads.`)
    : signInButtons(me, `/${name}`);
  root.replaceChildren(
    page(
      header(me, async () => {
        await account.signOut().catch(() => {});
        location.reload();
      }),
      el("h1", {}, "This pad is private"),
      el(
        "p",
        { className: "page-lede" },
        el("code", {}, name),
        " belongs to someone's account, and this browser holds no link that opens it. Ask its owner for one — or, if it is yours, sign in.",
      ),
      signedIn,
      el("p", { className: "page-note" }, el("a", { href: "/" }, "Open a new pad instead")),
    ),
  );
}
