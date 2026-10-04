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
 * Returns the code this browser holds for the pad, from now or from before.
 */
export function takeCode(name: string): string | null {
  const fromUrl = decodeURIComponent(location.hash.replace(/^#/, "")).trim();
  if (fromUrl && /^[A-Za-z0-9_-]{16,64}$/.test(fromUrl)) {
    held.set(name, fromUrl);
    remember(name, fromUrl);
  }
  if (location.hash) history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return codeFor(name);
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

/** For the checks, which open several pads in one page. */
export function resetCodes(): void {
  held = new Map();
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
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      // A cross-site form cannot set this, which is what makes a change here
      // something this page asked for. See http_accounts.rs.
      ...(write ? { "x-ajar": "1" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AccountError(res.status, text || `the server said ${res.status}`);
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
  settings: (name: string, view: View, edit: Edit) =>
    call<PadInfo>(`/api/my/pads/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify({ view, edit }),
    }),
  /** `replace` revokes every other link of that kind in the same step. */
  newLink: (name: string, role: "viewer" | "editor", replace = false) =>
    call<Link>(`/api/my/pads/${encodeURIComponent(name)}/links`, {
      method: "POST",
      body: JSON.stringify({ role, replace }),
    }),
  revoke: (name: string, id: number) =>
    call<void>(`/api/my/pads/${encodeURIComponent(name)}/links/${id}`, { method: "DELETE" }),
  signOut: () => call<void>("/auth/logout", { method: "POST" }),
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
