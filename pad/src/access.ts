/**
 * Who you are to a pad, and the account behind it.
 *
 * A pad that belongs to an account is opened with a code after the `#` —
 * browsers never send that part anywhere, so it reaches no log, no `Referer`
 * and no link-preview bot. The page reads it, keeps it for that pad, and takes
 * it out of the address bar: people share by copying the address bar, and an
 * edit link copied that way would hand out editing. Sharing is the share
 * dialog's job, which says what each link grants. See docs/dev/accounts.md.
 */

export type Role = "none" | "viewer" | "editor" | "owner";
export type View = "link" | "code" | "owner";
export type Edit = "code" | "owner";

/** What the store says about you and a pad, alongside its files. */
export interface Access {
  role: Role;
  /**
   * What the link this browser presented grants on its own, before the pad's
   * settings narrow it — "editor" for an edit link while editing is locked.
   * Absent when it presented none, or one that no longer works.
   */
  link?: "viewer" | "editor";
  /** Whether the pad belongs to an account at all. */
  account: boolean;
  view?: View;
  edit?: Edit;
}

/** Before accounts the store sent nothing, and everyone could edit. */
export const OPEN: Access = { role: "editor", account: false };

export interface User {
  id: number;
  provider: string;
  name: string;
  email: string | null;
}

export interface Me {
  user: User | null;
  providers: string[];
  limits?: { pads: number; bytes: number };
  /** Whether this person may open /admin. */
  admin?: boolean;
}

export interface Link {
  id: number;
  role: "viewer" | "editor";
  label: string | null;
  code: string;
}

export interface PadInfo {
  name: string;
  created: number;
  view: View;
  edit: Edit;
  bytes: number;
  files: number;
  links: Link[];
}

const KEY = (name: string) => `pad.code.${name}`;
const PREV = (name: string) => `pad.code.prev.${name}`;

/**
 * The server accepted the code this tab is using: whatever it replaced can
 * go. Called once the pad has been read with it.
 */
export function acceptCode(name: string): void {
  try {
    sessionStorage.removeItem(PREV(name));
  } catch {
    // Nothing kept.
  }
}

/**
 * The code this tab is using turned out to open nothing. If it replaced one
 * that worked, that one comes back and the answer is true: open the page
 * again with it.
 */
export function restorePreviousCode(name: string): boolean {
  let before: string | null = null;
  try {
    before = sessionStorage.getItem(PREV(name));
    sessionStorage.removeItem(PREV(name));
  } catch {
    return false;
  }
  if (!before) return false;
  held.set(name, before);
  remember(name, before);
  return true;
}

function remember(name: string, code: string | null): void {
  try {
    if (code) localStorage.setItem(KEY(name), code);
    else localStorage.removeItem(KEY(name));
  } catch {
    // Private windows and blocked storage. The code still works for this
    // visit; it is only forgotten sooner.
  }
}

let held = new Map<string, string>();

/**
 * Read the code from the address bar, keep it, and take it out of the bar.
 *
 * Returns whether a code arrived that this browser did not already hold —
 * which, for a page already open, means it should open again with it.
 */
export function takeCode(name: string): boolean {
  let raw = location.hash.replace(/^#/, "");
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // A hash that is not valid percent-encoding is not a code either.
  }
  const fromUrl = raw.trim();
  let fresh = false;
  // Exactly a code's shape — 128 bits as 22 characters — so an ordinary
  // anchor like #installation-and-setup never replaces a working code.
  if (/^[A-Za-z0-9_-]{22}$/.test(fromUrl)) {
    const before = codeFor(name);
    fresh = before !== fromUrl;
    // On trial until the server accepts it: an anchor that happens to have a
    // code's shape — #installation-and-setup is 22 characters — must not
    // throw away a working edit code. The one it replaces is kept for this
    // tab, to go back to; see `restorePreviousCode`.
    if (fresh && before) {
      try {
        sessionStorage.setItem(PREV(name), before);
      } catch {
        // Without it, a bad hash costs the old code, as it did before.
      }
    }
    held.set(name, fromUrl);
    remember(name, fromUrl);
  }
  if (location.hash) history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return fresh;
}

export function codeFor(name: string): string | null {
  const known = held.get(name);
  if (known) return known;
  try {
    const stored = localStorage.getItem(KEY(name));
    if (stored) held.set(name, stored);
    return stored;
  } catch {
    return null;
  }
}

/** Forget a pad's code — signing out, or a pad that no longer exists. */
export function forgetCode(name: string): void {
  held.delete(name);
  remember(name, null);
}

/**
 * Forget every pad's code — signing out. On a shared computer the next person
 * should not walk into the pads the last one was given links to.
 */
export function forgetAllCodes(): void {
  held = new Map();
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith("pad.code.")) localStorage.removeItem(key);
  } catch {
    // Nothing was kept.
  }
}

export function linkTo(name: string, code?: string | null): string {
  return `${location.origin}/${name}${code ? `#${code}` : ""}`;
}

export function signInUrl(provider: string, next = location.pathname): string {
  return `/auth/${encodeURIComponent(provider)}/start?next=${encodeURIComponent(next)}`;
}

export const PROVIDERS: Record<string, string> = { google: "Google", github: "GitHub" };

// ------------------------------------------------------------- the account

export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const write = init.method && init.method !== "GET";
  const away = "Can't reach pad right now — check your connection and try again.";
  let res: Response;
  try {
    res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      // A cross-site form cannot set this, which is what makes a change here
      // something this page asked for. See http_accounts.rs.
      ...(write ? { "x-ajar": "1" } : {}),
      ...init.headers,
    },
    });
  } catch {
    throw new AccountError(0, away);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // What a person can act on, for the two that come from a stale page.
    const said =
      res.status >= 502 && res.status <= 504
        ? away
        : res.status === 401
        ? "You were signed out. Sign in again to carry on."
        : res.status === 404 && path.startsWith("/api/my/pads/")
          ? "That pad no longer exists — it may have been deleted in another tab."
          : text || `The server said ${res.status}`;
    throw new AccountError(res.status, said);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const account = {
  me: () => call<Me>("/api/me"),
  pads: () => call<PadInfo[]>("/api/my/pads"),
  pad: (name: string) => call<PadInfo>(`/api/my/pads/${encodeURIComponent(name)}`),
  create: () => call<PadInfo>("/api/my/pads", { method: "POST" }),
  remove: (name: string) => call<void>(`/api/my/pads/${encodeURIComponent(name)}`, { method: "DELETE" }),
  /** One setting or both; one alone leaves the other as the server has it. */
  settings: (name: string, change: { view?: View; edit?: Edit }) =>
    call<PadInfo>(`/api/my/pads/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify(change),
    }),
  /** `replace` revokes every other link of that kind in the same step. */
  newLink: (name: string, role: "viewer" | "editor", replace = false) =>
    call<Link>(`/api/my/pads/${encodeURIComponent(name)}/links`, {
      method: "POST",
      body: JSON.stringify({ role, replace }),
    }),
  revoke: (name: string, id: number) =>
    call<void>(`/api/my/pads/${encodeURIComponent(name)}/links/${id}`, { method: "DELETE" }),
  signOut: async () => {
    await call<void>("/auth/logout", { method: "POST" });
    forgetAllCodes();
  },
  /** The account and every pad in it, for everyone, at once. */
  deleteAccount: async () => {
    await call<void>("/api/me", { method: "DELETE" });
    forgetAllCodes();
  },
};

/**
 * Replace a pad's link of one kind: every old one stops working for everyone
 * using it, at once — in one step on the server, including any the dashboard
 * cannot show — and the new one is what gets shared from now on.
 */
export function resetLink(pad: PadInfo, role: "viewer" | "editor"): Promise<Link> {
  return account.newLink(pad.name, role, true);
}

/** The words a setting is shown as, everywhere. */
export const VIEW_LABEL: Record<View, string> = {
  link: "Anyone with the link",
  code: "Only people with a view link",
  owner: "Only you",
};
export const EDIT_LABEL: Record<Edit, string> = {
  code: "Anyone with an edit link",
  owner: "Only you",
};

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) || mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}
