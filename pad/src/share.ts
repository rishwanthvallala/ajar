/**
 * Sharing a pad that belongs to an account.
 *
 * The address bar never holds a code — the page takes it out — so this is
 * where links come from, and each says what it grants. What is offered
 * depends on who is asking: the owner gets both kinds and the settings; an
 * editor can pass on editing, and viewing when it is open; a viewer can pass
 * on what they have.
 *
 * Anonymous pads have no dialog. Share copies the link, as it always has.
 */
import {
  account,
  type Access,
  EDIT_LABEL,
  type Edit,
  linkTo,
  type PadInfo,
  resetLink,
  VIEW_LABEL,
  type View,
} from "./access";

export interface ShareContext {
  name: string;
  access: Access;
  /** The code this browser opened the pad with, if any. */
  code: string | null;
  /** Report something in the page's status line. */
  say: (text: string, error?: boolean) => void;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function copy(text: string, field: HTMLInputElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard — an insecure origin, or permission refused. The link is
    // in the field, selected, for copying by hand.
    field.focus();
    field.select();
    return false;
  }
}

/**
 * One link: what it grants, the link itself, and Copy. `reset` replaces it,
 * for a link that has gone further than it should have.
 */
function linkRow(
  label: string,
  about: string,
  url: string | null,
  off: string,
  reset?: () => Promise<void>,
): HTMLElement {
  const row = el("div", { className: "share-link" });
  row.append(el("div", { className: "share-what" }, el("strong", {}, label), el("span", {}, url ? about : off)));
  if (!url) {
    row.classList.add("off");
    // On, but with no link to show: none made yet, or one whose stored copy
    // can no longer be read. Making one stops any old ones too.
    if (reset) {
      const make = el("button", { type: "button", className: "share-button" }, "Make a new link");
      make.onclick = async () => {
        make.disabled = true;
        try {
          await reset();
        } finally {
          make.disabled = false;
        }
      };
      row.append(el("div", { className: "share-actions" }, make));
    }
    return row;
  }
  const field = el("input", { readOnly: true, value: url, className: "share-url" });
  field.setAttribute("aria-label", label);
  const copyButton = el("button", { type: "button", className: "share-button primary" }, "Copy");
  copyButton.onclick = async () => {
    copyButton.textContent = (await copy(url, field)) ? "Copied" : "Copy it from the box";
    setTimeout(() => (copyButton.textContent = "Copy"), 1600);
  };
  const actions = el("div", { className: "share-actions" }, field, copyButton);
  if (reset) {
    const resetButton = el("button", { type: "button", className: "share-button" }, "Reset");
    resetButton.title = "Make a new link. The old one stops working, for everyone using it.";
    resetButton.onclick = async () => {
      if (!confirm(`Reset the ${label.toLowerCase()}? Anyone using the old one loses access straight away.`)) return;
      resetButton.disabled = true;
      try {
        await reset();
      } finally {
        resetButton.disabled = false;
      }
    };
    actions.append(resetButton);
  }
  row.append(actions);
  return row;
}

/**
 * A setting. The label wraps its select rather than pointing at an id: the
 * dashboard shows one of these per pad, and an id would repeat.
 */
function select<T extends string>(label: string, value: T, options: Record<T, string>, onChange: (v: T) => void): HTMLElement {
  const box = el("select", { className: "share-select" });
  box.dataset.setting = label.toLowerCase().includes("view") ? "view" : "edit";
  for (const [v, text] of Object.entries(options) as [T, string][]) {
    box.append(el("option", { value: v, selected: v === value }, text));
  }
  box.onchange = () => onChange(box.value as T);
  return el("label", { className: "share-setting" }, el("span", {}, label), box);
}

/**
 * The owner's view: the settings, and a link of each kind. The dashboard
 * shows the same panel for every pad, so the two never disagree.
 */
export function ownerBody(
  pad: PadInfo,
  redraw: (pad: PadInfo) => void,
  ctx: Pick<ShareContext, "say">,
  onDashboard = false,
): HTMLElement[] {
  const viewLink = pad.links.find((l) => l.role === "viewer");
  const editLink = pad.links.find((l) => l.role === "editor");
  const change = async (view: View, edit: Edit) => {
    try {
      redraw(await account.settings(pad.name, view, edit));
      ctx.say("sharing changed — people already here were asked to reconnect");
    } catch (e) {
      ctx.say((e as Error).message, true);
      redraw(pad);
    }
  };
  const reset = (role: "viewer" | "editor") => async () => {
    try {
      await resetLink(pad, role);
      redraw(await account.pad(pad.name));
      ctx.say(`new ${role === "viewer" ? "view" : "edit"} link — any old one no longer works`);
    } catch (e) {
      ctx.say((e as Error).message, true);
    }
  };
  const viewUrl =
    pad.view === "link" ? linkTo(pad.name) : pad.view === "code" && viewLink ? linkTo(pad.name, viewLink.code) : null;
  const editUrl = pad.edit === "code" && editLink ? linkTo(pad.name, editLink.code) : null;
  const missing = "No link to show — make a new one, and any old ones stop working.";
  return [
    el(
      "div",
      { className: "share-settings" },
      select("Who can view", pad.view, VIEW_LABEL, (v) => void change(v, pad.edit)),
      select("Who can edit", pad.edit, EDIT_LABEL, (e) => void change(pad.view, e)),
    ),
    linkRow(
      "View link",
      pad.view === "link"
        ? "Watch and run, not change. This is the plain address — anyone who has it can view."
        : "Watch and run, not change. Only this link opens it.",
      viewUrl,
      pad.view === "code" ? missing : "Only you can view this pad. Change who can view to share it.",
      pad.view === "code" ? reset("viewer") : undefined,
    ),
    linkRow(
      "Edit link",
      "Change the pad, live, with everyone else on it.",
      editUrl,
      pad.edit === "code" ? missing : "Only you can edit this pad. Change who can edit to share editing.",
      pad.edit === "code" ? reset("editor") : undefined,
    ),
    el(
      "p",
      { className: "share-note" },
      "Anyone you send a link to can pass it on. Reset makes a new one and the old one stops working. ",
      ...(onDashboard ? [] : [el("a", { href: "/dashboard" }, "All your pads")]),
    ),
  ];
}

/** Everyone else: pass on what you have. */
function guestBody(ctx: ShareContext): HTMLElement[] {
  const { name, access, code } = ctx;
  const openView = access.view === "link";
  const rows: HTMLElement[] = [];
  if (access.role === "editor") {
    rows.push(
      linkRow("Edit link", "Change the pad with everyone else on it, as you can.", code ? linkTo(name, code) : null, "You opened this without a link."),
      linkRow(
        "View link",
        "Watch and run, not change. The plain address.",
        openView ? linkTo(name) : null,
        "Only its owner can hand out view links for this pad.",
      ),
    );
  } else {
    rows.push(
      linkRow(
        "Link",
        openView ? "Watch and run, not change. The plain address." : "Opens it the way it opens for you.",
        openView ? linkTo(name) : code ? linkTo(name, code) : null,
        "Ask its owner for a link.",
      ),
    );
  }
  rows.push(el("p", { className: "share-note" }, "This pad belongs to someone's account; they decide who can view and edit it."));
  return rows;
}

export async function openShare(ctx: ShareContext): Promise<void> {
  const dialog = el("dialog", { className: "pad-dialog share-dialog" });
  dialog.setAttribute("aria-label", `Share ${ctx.name}`);
  const close = el("button", { type: "button", className: "share-close" }, "Close");
  close.onclick = () => dialog.close();
  const body = el("div", { className: "share-body" });
  dialog.append(el("header", {}, el("h2", {}, "Share ", el("code", {}, ctx.name)), close), body);
  dialog.addEventListener("close", () => dialog.remove());
  // A click on the backdrop lands on the dialog itself.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  document.body.append(dialog);

  if (ctx.access.role === "owner") {
    body.append(el("p", { className: "share-note" }, "Loading…"));
    dialog.showModal();
    const redraw = (pad: PadInfo) => body.replaceChildren(...ownerBody(pad, redraw, ctx));
    try {
      redraw(await account.pad(ctx.name));
    } catch (e) {
      body.replaceChildren(el("p", { className: "share-note" }, `Could not load this pad's links: ${(e as Error).message}`));
    }
    return;
  }
  body.append(...guestBody(ctx));
  dialog.showModal();
}
