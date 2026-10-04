/**
 * The operator's view, at /admin: how the pad is being used, from what the
 * relay already keeps. Only the people named in `AJAR_ADMINS` get it; to
 * anyone else /admin is what it always was — not a pad address.
 *
 * Charts are drawn here as SVG: the CSP allows no library from elsewhere, and
 * a bar per day needs none.
 */
import { account, type Me, PROVIDERS, size } from "./access";
import { accountMenu, footer, shell, showPrivate, topbar } from "./dashboard";
import type { IconName } from "./icons";
import { button, el, icon, toast, toastRegions } from "./ui";

interface Count {
  key: string;
  n: number;
}
interface Day {
  day: number;
  n: number;
}
interface AccountRow {
  name: string;
  provider: string;
  email: string | null;
  joined: number;
  pads: number;
  bytes: number;
  signed_in: number | null;
}
interface Stats {
  accounts: {
    users: number;
    by_provider: Count[];
    signed_in: number;
    sessions: number;
    pads: number;
    deleted: number;
    bytes: number;
    links: number;
    view: Count[];
    edit: Count[];
    signups: Day[];
    made: Day[];
    biggest: AccountRow[];
    newest: AccountRow[];
  };
  store: {
    pads: number;
    owned: number;
    bytes: number;
    ceiling: number;
    touched_1d: number;
    touched_7d: number;
    touched_30d: number;
    biggest: { name: string; bytes: number; touched: number; owned: boolean }[];
  };
  live: { pad_rooms: number; pad_people: number; sessions: number; session_people: number };
  relay: { version: string; uptime_secs: number; memory_bytes: number | null };
  days: number;
}

/** Live numbers move; the rest barely does. A minute is often enough for both. */
const REFRESH_MS = 60_000;

const VIEW_WORDS: Record<string, string> = { link: "Anyone with the link", code: "View link only", owner: "Only the owner" };
const EDIT_WORDS: Record<string, string> = { code: "Anyone with an edit link", owner: "Only the owner" };

async function load(): Promise<Stats> {
  const res = await fetch("/api/admin/stats", { cache: "no-store" });
  if (res.status === 404) throw new Error("not an admin");
  if (!res.ok) throw new Error(`The server said ${res.status}`);
  return (await res.json()) as Stats;
}

const number = (n: number) => n.toLocaleString();

function ago(seconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - seconds);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : "<1m";
}

function date(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** One figure: what it is, the number, and a line of context. */
function card(label: string, value: string, note: string, iconName: IconName, tone = ""): HTMLElement {
  return el(
    "div",
    { className: `stat ${tone}`.trim() },
    el("div", { className: "stat-head" }, el("span", { className: "stat-icon" }, icon(iconName)), el("span", { className: "stat-label" }, label)),
    el("div", { className: "stat-value" }, value),
    el("div", { className: "stat-note" }, note),
  );
}

/**
 * A bar per day. `role="img"` with a sentence that says what the bars do,
 * and each bar's own title for a pointer.
 */
function dayChart(title: string, days: Day[], noun: string): HTMLElement {
  const W = 600;
  const H = 120;
  const gap = 2;
  const max = Math.max(1, ...days.map((d) => d.n));
  const bw = W / days.length - gap;
  const total = days.reduce((n, d) => n + d.n, 0);
  const peak = days.reduce((best, d) => (d.n > best.n ? d : best), days[0] ?? { day: 0, n: 0 });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "chart-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    total
      ? `${title}: ${total} in ${days.length} days, most on ${date(peak.day)} with ${peak.n}.`
      : `${title}: none in ${days.length} days.`,
  );
  days.forEach((d, i) => {
    const h = d.n ? Math.max(3, (d.n / max) * (H - 4)) : 1.5;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(i * (bw + gap)));
    rect.setAttribute("y", String(H - h));
    rect.setAttribute("width", String(Math.max(1, bw)));
    rect.setAttribute("height", String(h));
    rect.setAttribute("rx", "2");
    rect.setAttribute("class", d.n ? "bar" : "bar empty");
    const tip = document.createElementNS("http://www.w3.org/2000/svg", "title");
    tip.textContent = `${date(d.day)}: ${d.n} ${noun}`;
    rect.append(tip);
    svg.append(rect);
  });
  const first = days[0];
  const last = days[days.length - 1];
  return el(
    "section",
    { className: "panel chart" },
    el("div", { className: "panel-head" }, el("h3", {}, title), el("span", { className: "panel-meta" }, `${number(total)} in ${days.length} days · peak ${peak.n}`)),
    svg as unknown as HTMLElement,
    el("div", { className: "chart-axis" }, el("span", {}, first ? date(first.day) : ""), el("span", {}, last ? "today" : "")),
  );
}

/** Shares of a whole, as labelled bars. */
function mix(title: string, counts: Count[], words: Record<string, string>): HTMLElement {
  const total = counts.reduce((n, c) => n + c.n, 0);
  const list = el("ul", { className: "mix" });
  for (const c of counts) {
    const pct = total ? Math.round((c.n / total) * 100) : 0;
    const bar = el("span", { className: "mix-bar" }, el("span", { className: "mix-fill" }));
    (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;
    bar.setAttribute("aria-hidden", "true");
    list.append(el("li", {}, el("span", { className: "mix-label" }, words[c.key] ?? PROVIDERS[c.key] ?? c.key), bar, el("span", { className: "mix-n" }, `${number(c.n)} · ${pct}%`)));
  }
  if (!counts.length) list.append(el("li", { className: "mix-none" }, "Nothing yet"));
  return el("section", { className: "panel" }, el("div", { className: "panel-head" }, el("h3", {}, title)), list);
}

function table(title: string, head: string[], rows: (string | Node)[][], empty: string): HTMLElement {
  const t = el("table", { className: "admin-table" });
  t.append(el("thead", {}, el("tr", {}, ...head.map((h) => el("th", { scope: "col" }, h)))));
  const body = el("tbody");
  for (const r of rows) body.append(el("tr", {}, ...r.map((c) => el("td", {}, c))));
  if (!rows.length) body.append(el("tr", {}, el("td", { colSpan: head.length, className: "table-empty" }, empty)));
  t.append(body);
  return el("section", { className: "panel" }, el("div", { className: "panel-head" }, el("h3", {}, title)), el("div", { className: "table-wrap" }, t));
}

function accountRows(rows: AccountRow[]): (string | Node)[][] {
  return rows.map((a) => [
    el("span", { className: "who" }, el("strong", {}, a.name), a.email ? el("span", {}, a.email) : null),
    PROVIDERS[a.provider] ?? a.provider,
    number(a.pads),
    size(a.bytes),
    date(a.joined),
    a.signed_in ? ago(a.signed_in) : "—",
  ]);
}

function render(s: Stats): HTMLElement[] {
  const a = s.accounts;
  const st = s.store;
  const week = a.signups.slice(-7).reduce((n, d) => n + d.n, 0);
  const full = st.ceiling ? st.bytes / st.ceiling : 0;
  const storage = card("Storage", size(st.bytes), `of ${size(st.ceiling)} · ${Math.round(full * 100)}% used`, "file", full > 0.8 ? "warn" : "");
  const meter = el("div", { className: "meter" }, el("span", { className: "meter-fill" }));
  (meter.firstElementChild as HTMLElement).style.width = `${Math.min(100, full * 100)}%`;
  meter.classList.toggle("full", full > 0.8);
  meter.setAttribute("aria-hidden", "true");
  storage.append(meter);

  return [
    el(
      "section",
      { className: "admin-section" },
      el("h2", {}, "Right now"),
      el(
        "div",
        { className: "stats" },
        card("In pads", number(s.live.pad_people), `${number(s.live.pad_rooms)} ${s.live.pad_rooms === 1 ? "pad" : "pads"} open live`, "eye", s.live.pad_people ? "live" : ""),
        card("ajar sessions", number(s.live.sessions), `${number(s.live.session_people)} people connected`, "link"),
        card("Relay", uptime(s.relay.uptime_secs), `up · v${s.relay.version}${s.relay.memory_bytes ? ` · ${size(s.relay.memory_bytes)} memory` : ""}`, "chart"),
      ),
    ),
    el(
      "section",
      { className: "admin-section" },
      el("h2", {}, "People"),
      el(
        "div",
        { className: "stats" },
        card("Accounts", number(a.users), `${number(week)} new this week`, "pads"),
        card("Signed in", number(a.signed_in), `in the last ${s.days} days`, "out"),
        card("Sessions", number(a.sessions), "signed in now, not yet expired", "lock"),
      ),
      el("div", { className: "panels two" }, dayChart("Sign-ups per day", a.signups, "sign-ups"), mix("Signed in with", a.by_provider, {})),
    ),
    el(
      "section",
      { className: "admin-section" },
      el("h2", {}, "Pads"),
      el(
        "div",
        { className: "stats" },
        card("Pads stored", number(st.pads), `${number(st.owned)} in accounts · ${number(st.pads - st.owned)} open`, "file"),
        card("Opened", number(st.touched_7d), `this week · ${number(st.touched_1d)} today · ${number(st.touched_30d)} this month`, "eye"),
        storage,
        card("Account pads", number(a.pads), `${number(a.links)} live links · ${number(a.deleted)} deleted`, "lock"),
      ),
      el("div", { className: "panels two" }, dayChart("Account pads made per day", a.made, "pads"), el("div", { className: "panel-stack" }, mix("Who can view", a.view, VIEW_WORDS), mix("Who can edit", a.edit, EDIT_WORDS))),
      table(
        "Biggest pads",
        ["Pad", "Size", "Kind", "Last opened"],
        st.biggest.map((p) => [el("a", { href: `/${p.name}`, className: "mono" }, p.name), size(p.bytes), p.owned ? "Account" : "Open", ago(p.touched)]),
        "No pads stored yet",
      ),
    ),
    el(
      "section",
      { className: "admin-section" },
      el("h2", {}, "Accounts"),
      el(
        "div",
        { className: "panels two" },
        table("Using the most room", ["Person", "With", "Pads", "Storage", "Joined", "Last sign-in"], accountRows(a.biggest), "No accounts yet"),
        table("Newest", ["Person", "With", "Pads", "Storage", "Joined", "Last sign-in"], accountRows(a.newest), "No accounts yet"),
      ),
    ),
  ];
}

export async function startAdmin(root: HTMLElement): Promise<void> {
  document.title = "Admin — pad";
  toastRegions();
  const me = await account.me().catch((): Me => ({ user: null, providers: [] }));
  // To anyone but an operator, /admin is what it was: a reserved name.
  if (!me.admin || !me.user) return showPrivate(root, "admin", "invalid");

  const body = el("div", { className: "admin-body" });
  const updated = el("span", { className: "admin-updated" });
  updated.setAttribute("aria-live", "polite");
  const refresh = button("Refresh", { icon: "refresh", className: "btn-small", onClick: () => void draw(true) });
  let timer: ReturnType<typeof setTimeout> | undefined;

  const draw = async (asked = false) => {
    clearTimeout(timer);
    body.setAttribute("aria-busy", "true");
    try {
      const stats = await load();
      body.replaceChildren(...render(stats));
      updated.textContent = `Updated ${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
      if (asked) toast("Up to date", "ok", true);
    } catch (e) {
      if ((e as Error).message === "not an admin") return location.reload();
      if (!body.childElementCount) body.replaceChildren(el("div", { className: "alert" }, icon("alert"), el("span", {}, (e as Error).message)));
      else toast(`Could not refresh: ${(e as Error).message}`, "error");
    } finally {
      body.removeAttribute("aria-busy");
      // Only while the tab is looked at: a hidden tab asking every minute is
      // load for nobody.
      if (document.visibilityState === "visible") timer = setTimeout(() => void draw(), REFRESH_MS);
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void draw();
  });

  const signOut = async () => {
    await account.signOut().catch(() => {});
    location.assign("/dashboard");
  };
  root.replaceChildren(
    shell(
      topbar(el("a", { className: "btn btn-small btn-ghost", href: "/dashboard" }, el("span", { className: "btn-label" }, "Your pads")), accountMenu(me, () => void signOut())),
      el(
        "main",
        { className: "dash admin" },
        el("div", { className: "dash-head" }, el("div", { className: "dash-title" }, el("h1", {}, "Admin"), el("p", { className: "page-usage" }, "How pad is being used — from what the server already keeps.")), el("div", { className: "admin-tools" }, updated, refresh)),
        body,
      ),
      footer(),
    ),
  );
  await draw();
}
