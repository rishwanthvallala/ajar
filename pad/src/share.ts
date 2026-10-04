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
import { account, type Access, AccountError, type Edit, linkTo, type PadInfo, resetLink, type View } from "./access";
import type { IconName } from "./icons";
import { button, confirmDialog, copyText, el, icon, modal, toast, uid } from "./ui";

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
  /** The pad turned out not to exist any more — deleted in another tab. */
  onGone?: () => void;
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
  /** Which link, for the focus to come back to after a redraw. */
  key: string;
  about: string;
  url: string | null;
  off: string;
  icon: IconName;
  reset?: () => Promise<void>;
}): HTMLElement {
  const row = el("div", { className: "share-link" });
  const main = el("div", { className: "share-link-main" });
  const head = el("div", { className: "share-link-head" }, el("strong", {}, opts.label));
  const hintId = uid("link-hint");
  main.append(head);
  row.append(el("span", { className: "setting-icon" }, icon(opts.icon)), main);
  if (!opts.url) {
    row.classList.add("off");
    main.append(el("p", { className: "share-hint", id: hintId }, opts.off));
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
      make.dataset.focus = `make-${opts.key}`;
      main.append(make);
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
        if (yes) await opts.reset!();
      },
    });
    reset.setAttribute("aria-label", `Reset ${opts.label.toLowerCase()}`);
    reset.dataset.focus = `reset-${opts.key}`;
    head.append(reset);
  }
  main.append(el("p", { className: "share-hint", id: hintId }, opts.about));
  const field = el("input", { readOnly: true, value: display(opts.url), className: "share-url" });
  field.dataset.url = opts.url;
  field.dataset.focus = `field-${opts.key}`;
  field.setAttribute("aria-label", opts.label);
  field.setAttribute("aria-describedby", hintId);
  field.addEventListener("focus", () => field.select());
  const copy = button("Copy", {
    icon: "copy",
    className: "btn-primary share-copy",
    onClick: async () => {
      if (await copyText(opts.url!)) {
        copy.classList.add("copied");
        copy.querySelector(".btn-label")!.textContent = "Copied";
        copy.querySelector(".icon")!.innerHTML = icon("check").innerHTML;
        // The button turning green says it; the toast is for screen readers.
        toast(`${opts.label} copied`, "ok", true);
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
  copy.setAttribute("aria-label", `Copy ${opts.label.toLowerCase()}`);
  copy.dataset.focus = `copy-${opts.key}`;
  main.append(el("div", { className: "share-field" }, field, copy));
  return row;
}

/** A setting: an icon for what it is now, the choice, and what that means. */
function setting<T extends string>(
  label: string,
  key: "view" | "edit",
  value: T,
  choices: Choice<T>[],
  hint: string,
  onChange: (v: T) => void,
): HTMLElement {
  const current = choices.find((c) => c.value === value) ?? choices[0]!;
  const labelId = uid("setting-label");
  const hintId = uid("setting-hint");
  const select = el("select", { className: "select" });
  select.dataset.setting = key;
  select.dataset.focus = `setting-${key}`;
  // Named by its label and described by its hint, not named by both: the
  // wrapping label alone made the name a whole sentence.
  select.setAttribute("aria-labelledby", labelId);
  select.setAttribute("aria-describedby", hintId);
  for (const c of choices) select.append(el("option", { value: c.value, selected: c.value === value }, c.label));
  select.onchange = () => onChange(select.value as T);
  // The label wraps its select rather than pointing at an id, so a click on
  // the words focuses it.
  return el(
    "label",
    { className: `setting setting-${current.value}` },
    el("span", { className: "setting-icon" }, icon(current.icon)),
    el(
      "span",
      { className: "setting-main" },
      el("span", { className: "setting-label", id: labelId }, label),
      el("span", { className: "select-wrap" }, select, icon("chevron", "icon select-chevron")),
      el("span", { className: "share-hint", id: hintId }, hint),
    ),
  );
}

/** The owner's view: both settings, and a link of each kind. */
function ownerBody(
  pad: PadInfo,
  redraw: (pad: PadInfo, focus?: string) => void,
  fromDashboard: boolean,
  gone: (e: unknown) => boolean,
): HTMLElement[] {
  const viewLink = pad.links.find((l) => l.role === "viewer");
  const editLink = pad.links.find((l) => l.role === "editor");
  const access = el("section", { className: "share-section" });
  // Busy on the section rather than disabling the select: a disabled control
  // loses the focus it has, and the keyboard user is dropped onto the page.
  // Only the setting that changed is sent. Sending both let a dialog holding
  // an old copy of the other put it back — an owner who had locked editing
  // re-opened it by changing who can view.
  const change = async (what: { view?: View; edit?: Edit }) => {
    access.setAttribute("aria-busy", "true");
    try {
      redraw(await account.settings(pad.name, what));
      toast("Sharing updated");
    } catch (e) {
      if (gone(e)) return;
      toast((e as Error).message, "error");
      redraw(pad);
    }
  };
  const reset = (role: "viewer" | "editor") => async () => {
    try {
      await resetLink(pad, role);
      // Onto the new link's Copy, which is what anyone resetting wants next.
      redraw(await account.pad(pad.name), `copy-${role}`);
      toast(`New ${role === "viewer" ? "view" : "edit"} link — any old one no longer works`);
    } catch (e) {
      if (gone(e)) return;
      toast((e as Error).message, "error");
    }
  };
  const viewUrl =
    pad.view === "link" ? linkTo(pad.name) : pad.view === "code" && viewLink ? linkTo(pad.name, viewLink.code) : null;
  const editUrl = pad.edit === "code" && editLink ? linkTo(pad.name, editLink.code) : null;
  const missing = "There is no link to show. Make a new one — any old ones stop working.";
  const closed = pad.view === "owner" && pad.edit === "owner";

  access.append(
    el("h3", {}, "Access"),
    setting("Who can view", "view", pad.view, VIEW_CHOICES, viewHint(pad.view, pad.edit), (view) => void change({ view })),
    setting("Who can edit", "edit", pad.edit, EDIT_CHOICES, editHint(pad.edit), (edit) => void change({ edit })),
  );
  const links = el("section", { className: "share-section" }, el("h3", {}, "Links"));
  if (closed) {
    links.append(el("p", { className: "share-off" }, "This pad is private. Choose who can view or edit it above to get a link to share."));
  } else {
    links.append(
      linkRow({
        label: "View link",
        key: "viewer",
        icon: "eye",
        about: pad.view === "link" ? "The plain address. Anyone with it can watch and run, not change." : "Anyone with this link can watch and run, not change.",
        url: viewUrl,
        off:
          pad.view === "code"
            ? missing
            : pad.edit === "code"
              ? "No view link — only you and people with the edit link can open it."
              : "Viewing is off — only you can open this pad.",
        reset: pad.view === "code" ? reset("viewer") : undefined,
      }),
      linkRow({
        label: "Edit link",
        key: "editor",
        icon: "pencil",
        about: "Anyone with this link can edit it with you, live.",
        url: editUrl,
        off: pad.edit === "code" ? missing : "Editing is off — only you can change this pad.",
        reset: pad.edit === "code" ? reset("editor") : undefined,
      }),
    );
  }
  return [
    access,
    links,
    el(
      "div",
      { className: "share-foot" },
      el("p", {}, closed ? "Links you shared before stay off until you open the pad up again." : "Links can be forwarded. Reset replaces a link and turns the old one off."),
      fromDashboard ? null : el("a", { href: "/dashboard", className: "share-more" }, "All your pads", icon("arrow")),
    ),
  ];
}

/** Everyone else: pass on what you have. */
function guestBody(ctx: ShareContext): HTMLElement[] {
  const { name, access, code } = ctx;
  const openView = access.view === "link";
  const editor = access.role === "editor";
  const links = el("section", { className: "share-section" }, el("h3", {}, "Links"));
  // View first, then edit, as the owner sees them.
  if (editor) {
    links.append(
      linkRow({ label: "View link", key: "viewer", icon: "eye", about: "The plain address. Anyone with it can watch and run, not change.", url: openView ? linkTo(name) : null, off: "Only its owner can hand out view links for this pad." }),
      linkRow({ label: "Edit link", key: "editor", icon: "pencil", about: "Anyone with this link can edit it with you.", url: code && access.link === "editor" ? linkTo(name, code) : null, off: "You opened this without an edit link." }),
    );
  } else {
    // Only a view link is a viewer's to pass on. An edit link whose editing
    // is locked for now opens this as a viewer too — and would open it to
    // edit for whoever it went to, the moment editing came back.
    const ownViewLink = access.link === "viewer" && code;
    links.append(
      linkRow({
        label: "Link",
        key: "viewer",
        icon: "eye",
        about: openView ? "The plain address. Anyone with it can watch and run, not change." : "Anyone with this link can watch and run it.",
        url: openView ? linkTo(name) : ownViewLink ? linkTo(name, code) : null,
        off: access.link === "editor" ? "Only its owner can hand out links to this pad right now." : "Ask its owner for a link.",
      }),
    );
  }
  return [
    el(
      "div",
      { className: `share-role role-${access.role}` },
      icon(editor ? "pencil" : "eye"),
      el("span", {}, editor ? "You can edit this pad" : "You can view this pad"),
    ),
    links,
    el("div", { className: "share-foot" }, el("p", {}, "This pad belongs to someone's account. They decide who can view and edit it.")),
  ];
}

export async function openShare(ctx: ShareContext): Promise<void> {
  const { dialog, body } = modal("Share", ctx.name, "share-dialog");
  dialog.querySelector(".modal-sub")?.classList.add("mono");

  if (ctx.access.role !== "owner") {
    body.append(...guestBody(ctx));
    dialog.showModal();
    return;
  }
  // Deleted elsewhere since the list loaded: nothing here can be changed.
  const gone = (e: unknown) => {
    if (!(e instanceof AccountError)) return false;
    if (e.status === 401) {
      // Signed out in another tab: nothing here is theirs to change now.
      dialog.close();
      toast(e.message, "error");
      return true;
    }
    if (e.status !== 404) return false;
    dialog.close();
    ctx.onGone?.();
    return true;
  };
  // Redrawn whole after every change; the focus goes back to the control of
  // the same name, or to `focus`, rather than falling onto the page.
  const redraw = (pad: PadInfo, focus?: string) => {
    const was = (dialog.contains(document.activeElement) && (document.activeElement as HTMLElement).dataset.focus) || undefined;
    body.replaceChildren(...ownerBody(pad, redraw, !!ctx.fromDashboard, gone));
    const target = focus ?? was;
    if (target) body.querySelector<HTMLElement>(`[data-focus="${target}"]`)?.focus();
    ctx.pad = pad;
    ctx.onChange?.(pad);
  };
  if (ctx.pad) {
    body.replaceChildren(...ownerBody(ctx.pad, redraw, !!ctx.fromDashboard, gone));
    // Not to be copied until the server has confirmed them.
    for (const section of body.querySelectorAll(".share-section")) section.setAttribute("aria-busy", "true");
    dialog.showModal();
    // Fresh as well: the list may have loaded before another tab reset a
    // link or changed a setting, and showing those would hand out dead links.
    void account.pad(ctx.name).then(
      (fresh) => {
        if (dialog.open) redraw(fresh);
      },
      (e) => {
        // Not gone, just not answered: the links shown are the best there is.
        if (!gone(e)) for (const section of body.querySelectorAll(".share-section")) section.removeAttribute("aria-busy");
      },
    );
    return;
  }
  const loading = el("div", { className: "share-loading" }, el("span", { className: "skeleton" }), el("span", { className: "skeleton" }), el("span", { className: "skeleton short" }), el("span", { className: "vh" }, "Loading this pad's links…"));
  loading.setAttribute("aria-busy", "true");
  body.append(loading);
  dialog.showModal();
  try {
    redraw(await account.pad(ctx.name));
  } catch (e) {
    body.replaceChildren(el("p", { className: "share-error" }, icon("alert"), `Could not load this pad's links: ${(e as Error).message}`));
  }
}
