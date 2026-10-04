/**
 * Sharing a pad that belongs to an account.
 *
 * The address bar never holds a code — the page takes it out — so this is
 * where links come from, and each says what it grants. What is offered
 * depends on who is asking: the owner gets both settings and both kinds of
 * link; an editor can pass on editing, and viewing when it is open; a viewer
 * can pass on what they have. The dashboard opens the same dialog.
 *
 * Anonymous pads have no dialog. Share copies the link, as it always has.
 */
import { account, type Access, type Edit, linkTo, type PadInfo, resetLink, type View } from "./access";
import type { IconName } from "./icons";
import { button, confirmDialog, copyText, el, icon, modal, toast } from "./ui";

export interface ShareContext {
  name: string;
  access: Access;
  /** The code this browser opened the pad with, if any. */
  code: string | null;
  /** The pad as the dashboard already has it; fetched when absent. */
  pad?: PadInfo;
  /** Called with the pad after the owner changes it. */
  onChange?: (pad: PadInfo) => void;
  /** Whether to offer the way to the dashboard — not from the dashboard itself. */
  fromDashboard?: boolean;
}

interface Choice<T extends string> {
  value: T;
  label: string;
  icon: IconName;
}

const VIEW_CHOICES: Choice<View>[] = [
  { value: "link", label: "Anyone with the link", icon: "globe" },
  { value: "code", label: "Only people with a view link", icon: "link" },
  { value: "owner", label: "Only you", icon: "lock" },
];
const EDIT_CHOICES: Choice<Edit>[] = [
  { value: "code", label: "Anyone with an edit link", icon: "pencil" },
  { value: "owner", label: "Only you", icon: "lock" },
];

/** What a setting means, in the words of what it lets people do. */
function viewHint(view: View, edit: Edit): string {
  if (view === "link") return "Anyone who has the address can watch it live and run it.";
  if (view === "code") return "Only people you send the view link to can open it.";
  return edit === "code" ? "Nobody else can view it — except people with the edit link." : "Nobody else can open it.";
}
function editHint(edit: Edit): string {
  return edit === "code" ? "People you send the edit link to change it with you, live." : "Nobody else can change it.";
}

/** Shown without the scheme: the box is narrow and every link is https. */
function display(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/**
 * One link: what it is, what it grants, and Copy. `reset` replaces it, for a
 * link that has gone further than it should have.
 */
function linkRow(opts: {
  label: string;
  about: string;
  url: string | null;
  off: string;
  icon: IconName;
  reset?: () => Promise<void>;
}): HTMLElement {
  const row = el("div", { className: "share-link" });
  const head = el("div", { className: "share-link-head" }, icon(opts.icon, "icon share-link-icon"), el("strong", {}, opts.label));
  row.append(head);
  if (!opts.url) {
    row.classList.add("off");
    row.append(el("p", { className: "share-hint" }, opts.off));
    // On, but nothing to show: none made yet, or one whose stored copy can no
    // longer be read. Making one stops any old ones too.
    if (opts.reset) {
      const make = button("Make a new link", {
        icon: "plus",
        className: "btn-small",
        onClick: async () => {
          make.disabled = true;
          try {
            await opts.reset!();
          } finally {
            make.disabled = false;
          }
        },
      });
      row.append(make);
    }
    return row;
  }
  if (opts.reset) {
    const reset = button("Reset", {
      icon: "reset",
      className: "btn-quiet btn-small share-reset",
      title: "Make a new link. The old one stops working, for everyone using it.",
      onClick: async () => {
        const yes = await confirmDialog({
          title: `Reset the ${opts.label.toLowerCase()}?`,
          body: "Anyone using the current link loses access straight away. You'll get a new link to share.",
          confirm: "Reset link",
          danger: true,
        });
        if (!yes) return;
        reset.disabled = true;
        try {
          await opts.reset!();
        } finally {
          reset.disabled = false;
        }
      },
    });
    head.append(reset);
  }
  row.append(el("p", { className: "share-hint" }, opts.about));
  const field = el("input", { readOnly: true, value: display(opts.url), className: "share-url" });
  field.dataset.url = opts.url;
  field.setAttribute("aria-label", opts.label);
  field.addEventListener("focus", () => field.select());
  const copy = button("Copy", {
    icon: "copy",
    className: "btn-primary share-copy",
    onClick: async () => {
      if (await copyText(opts.url!)) {
        copy.classList.add("copied");
        copy.querySelector(".btn-label")!.textContent = "Copied";
        copy.querySelector(".icon")!.innerHTML = icon("check").innerHTML;
        toast(`${opts.label} copied`);
        setTimeout(() => {
          copy.classList.remove("copied");
          copy.querySelector(".btn-label")!.textContent = "Copy";
          copy.querySelector(".icon")!.innerHTML = icon("copy").innerHTML;
        }, 1800);
      } else {
        // No clipboard — an insecure origin, or permission refused. The link
        // is in the field, selected, for copying by hand.
        field.value = opts.url!;
        field.focus();
        field.select();
        toast("Copy it from the box — the clipboard is not available here", "error");
      }
    },
  });
  row.append(el("div", { className: "share-field" }, field, copy));
  return row;
}

/** A setting: an icon for what it is now, the choice, and what that means. */
function setting<T extends string>(
  label: string,
  value: T,
  choices: Choice<T>[],
  hint: string,
  onChange: (v: T) => void,
): HTMLElement {
  const current = choices.find((c) => c.value === value) ?? choices[0]!;
  const select = el("select", { className: "select" });
  select.dataset.setting = label.toLowerCase().includes("view") ? "view" : "edit";
  for (const c of choices) select.append(el("option", { value: c.value, selected: c.value === value }, c.label));
  select.onchange = () => onChange(select.value as T);
  // The label wraps its select rather than pointing at an id: the dashboard
  // opens one of these per pad over time, and ids would repeat.
  return el(
    "label",
    { className: `setting setting-${current.value}` },
    el("span", { className: "setting-icon" }, icon(current.icon)),
    el(
      "span",
      { className: "setting-main" },
      el("span", { className: "setting-label" }, label),
      el("span", { className: "select-wrap" }, select, icon("chevron", "icon select-chevron")),
      el("span", { className: "share-hint" }, hint),
    ),
  );
}

/** The owner's view: both settings, and a link of each kind. */
export function ownerBody(pad: PadInfo, redraw: (pad: PadInfo) => void, fromDashboard: boolean): HTMLElement[] {
  const viewLink = pad.links.find((l) => l.role === "viewer");
  const editLink = pad.links.find((l) => l.role === "editor");
  const busy = (on: boolean) => document.querySelectorAll<HTMLSelectElement>(".share-dialog .select").forEach((s) => (s.disabled = on));
  const change = async (view: View, edit: Edit) => {
    busy(true);
    try {
      redraw(await account.settings(pad.name, view, edit));
      toast("Sharing updated — anyone already in the pad was asked to reconnect");
    } catch (e) {
      toast((e as Error).message, "error");
      redraw(pad);
    }
  };
  const reset = (role: "viewer" | "editor") => async () => {
    try {
      await resetLink(pad, role);
      redraw(await account.pad(pad.name));
      toast(`New ${role === "viewer" ? "view" : "edit"} link — any old one no longer works`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const viewUrl =
    pad.view === "link" ? linkTo(pad.name) : pad.view === "code" && viewLink ? linkTo(pad.name, viewLink.code) : null;
  const editUrl = pad.edit === "code" && editLink ? linkTo(pad.name, editLink.code) : null;
  const missing = "There is no link to show. Make a new one — any old ones stop working.";

  return [
    el(
      "section",
      { className: "share-section" },
      el("h3", {}, "Access"),
      setting("Who can view", pad.view, VIEW_CHOICES, viewHint(pad.view, pad.edit), (v) => void change(v, pad.edit)),
      setting("Who can edit", pad.edit, EDIT_CHOICES, editHint(pad.edit), (e) => void change(pad.view, e)),
    ),
    el(
      "section",
      { className: "share-section" },
      el("h3", {}, "Links"),
      linkRow({
        label: "View link",
        icon: "eye",
        about: pad.view === "link" ? "The plain address. Opens it to watch and run, not to change." : "Opens it to watch and run, not to change.",
        url: viewUrl,
        off: pad.view === "code" ? missing : "Viewing is off — only you can open this pad.",
        reset: pad.view === "code" ? reset("viewer") : undefined,
      }),
      linkRow({
        label: "Edit link",
        icon: "pencil",
        about: "Opens it to change, live, with everyone else on it.",
        url: editUrl,
        off: pad.edit === "code" ? missing : "Editing is off — only you can change this pad.",
        reset: pad.edit === "code" ? reset("editor") : undefined,
      }),
    ),
    el(
      "footer",
      { className: "share-foot" },
      el("p", {}, "Anyone you send a link to can pass it on. Reset makes a new one and stops the old."),
      fromDashboard ? null : el("a", { href: "/dashboard", className: "share-more" }, "All your pads", icon("arrow")),
    ),
  ];
}

/** Everyone else: pass on what you have. */
function guestBody(ctx: ShareContext): HTMLElement[] {
  const { name, access, code } = ctx;
  const openView = access.view === "link";
  const editor = access.role === "editor";
  const rows: HTMLElement[] = [
    el(
      "div",
      { className: `share-role role-${access.role}` },
      icon(editor ? "pencil" : "eye"),
      el("span", {}, editor ? "You can edit this pad" : "You can view this pad"),
    ),
  ];
  if (editor) {
    rows.push(
      linkRow({ label: "Edit link", icon: "pencil", about: "Lets people change it with you, as you can.", url: code ? linkTo(name, code) : null, off: "You opened this without a link." }),
      linkRow({ label: "View link", icon: "eye", about: "The plain address. Opens it to watch and run, not to change.", url: openView ? linkTo(name) : null, off: "Only its owner can hand out view links for this pad." }),
    );
  } else {
    rows.push(
      linkRow({
        label: "Link",
        icon: "link",
        about: openView ? "The plain address. Opens it to watch and run, not to change." : "Opens it the way it opens for you.",
        url: openView ? linkTo(name) : code ? linkTo(name, code) : null,
        off: "Ask its owner for a link.",
      }),
    );
  }
  rows.push(el("footer", { className: "share-foot" }, el("p", {}, "This pad belongs to someone's account. They decide who can view and edit it.")));
  return rows;
}

export async function openShare(ctx: ShareContext): Promise<void> {
  const { dialog, body } = modal("Share", ctx.name, "share-dialog");
  dialog.querySelector(".modal-sub")?.classList.add("mono");

  if (ctx.access.role !== "owner") {
    body.append(...guestBody(ctx));
    dialog.showModal();
    return;
  }
  const redraw = (pad: PadInfo) => {
    body.replaceChildren(...ownerBody(pad, redraw, !!ctx.fromDashboard));
    ctx.pad = pad;
    ctx.onChange?.(pad);
  };
  if (ctx.pad) {
    body.replaceChildren(...ownerBody(ctx.pad, redraw, !!ctx.fromDashboard));
    dialog.showModal();
    return;
  }
  body.append(el("div", { className: "share-loading" }, el("span", { className: "skeleton" }), el("span", { className: "skeleton" }), el("span", { className: "skeleton short" })));
  dialog.showModal();
  try {
    redraw(await account.pad(ctx.name));
  } catch (e) {
    body.replaceChildren(el("p", { className: "share-error" }, icon("alert"), `Could not load this pad's links: ${(e as Error).message}`));
  }
}
