/**
 * A name typed into a file tree, and where a dragged row may land: the rules
 * both products' trees hold a new name or a move to before anything is asked
 * of the store or the host. Pure, so each product's checks can hold them to
 * it without a tree.
 *
 * The pad's tree began them (pad/src/files.ts); here since 19 November, when
 * the guest's tree in an ajar session came to make, rename and move things
 * too.
 */

/** The folder something lands in when dropped on `row`: a folder itself, or a file's own folder. */
export function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * Whether `what` may go into `folder`. Not where it already is — that moves
 * nothing — and never a folder into itself or anything under it.
 */
export function canDrop(what: { path: string; folder: boolean }, folder: string): boolean {
  if (folderOf(what.path) === folder) return false;
  if (what.folder && (folder === what.path || folder.startsWith(`${what.path}/`))) return false;
  return true;
}

/** What the tree holds, for whether a name is free. */
export interface Taken {
  files: ReadonlySet<string>;
  folders: ReadonlySet<string>;
}

/**
 * The path a name typed in `folder` stands for: inside that folder, or from
 * the top of the pad when it starts with `/`. A slash within it makes the
 * folders on the way, as `mkdir -p` would.
 */
export function pathFor(typed: string, folder: string): string {
  const name = typed.trim();
  if (name.startsWith("/")) return name.replace(/^\/+|\/+$/g, "");
  const inside = name.replace(/\/+$/g, "");
  return folder && inside ? `${folder}/${inside}` : inside;
}

/**
 * Why `path` will not do for something new — or for `from`, renamed — or
 * null when it will. Said under the name as it is typed, so a name that is
 * taken is never taken over by accident; a move onto a file that is there is
 * a drag, and asks.
 */
export function nameProblem(path: string, taken: Taken, from: { path: string; folder: boolean } | null = null, holder = "a pad"): string | null {
  if (!path) return "a name is needed";
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || p !== p.trim() || /[\u0000-\u001f\\]/.test(p))) return `${path} is not a path ${holder} can hold`;
  if (new TextEncoder().encode(path).length > 512) return `that path is too long for ${holder}`;
  if (from && path === from.path) return null;
  if (from?.folder && path.startsWith(`${from.path}/`)) return "a folder cannot go inside itself";
  for (let i = 1; i < parts.length; i++) {
    const above = parts.slice(0, i).join("/");
    if (taken.files.has(above)) return `${above} is a file, not a folder`;
  }
  if (taken.files.has(path)) return `there is already a file called ${path}`;
  if (taken.folders.has(path)) return `there is already a folder called ${path}`;
  return null;
}
