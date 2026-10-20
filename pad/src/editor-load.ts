/**
 * The editor's code — Monaco, and the languages and standard features that
 * come with it (monaco-languages.ts) — asked for once, and as early as the
 * page can tell it opens a pad: by main.ts, beside the page's own scripts.
 *
 * Until 20 October it was asked for once the pad had been read, and on a
 * first visit once the service worker had installed as well, so the largest
 * download of an opening, 1 MB compressed, began two round trips and an
 * install late. See "Opening a pad to paste into" in docs/dev/pad.md.
 */
const load = () =>
  Promise.all([
    import("monaco-editor/esm/vs/editor/editor.api"),
    import("monaco-editor/esm/vs/base/common/errors.js"),
    import("./monaco-languages"),
  ]);

let loading: ReturnType<typeof load> | null = null;

export function loadEditor(): ReturnType<typeof load> {
  loading ??= load().catch((e: unknown) => {
    // Forgotten, so the next caller fetches it again.
    loading = null;
    throw e;
  });
  return loading;
}

/** Addresses that are the site's own pages rather than pads — bootstrap.ts routes them. */
const SITE_PAGES = new Set(["dashboard", "login", "signup", "account", "settings", "admin", "help"]);

/** Whether `pathname` is a pad's address, as bootstrap.ts will open it: the editor is worth starting for. */
export function opensAPad(pathname: string): boolean {
  const path = pathname.replace(/^\/+|\/+$/g, "");
  return /^[a-z0-9-]{0,64}$/.test(path) && !SITE_PAGES.has(path);
}
