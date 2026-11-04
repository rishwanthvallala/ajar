/**
 * /pricing: the free plan and the paid one side by side, and paying for the
 * paid one with UPI.
 *
 * Paying is a trip to Razorpay's page and back — the relay's billing.rs says
 * why not their checkout script on this page. The button asks the relay for a
 * payment link and sends the tab there; Razorpay sends it back through
 * /api/billing/return, which lands here with `?payment=<reference>`, and this
 * page waits until the relay says how that payment stands. Every number on it
 * is the relay's (`/api/billing`, `/api/limits`), so a change to the price or
 * a limit needs no release of the page. Styles are in accounts.css.
 */
import { account, type Billing, type Me, type Payment } from "./access";
import { accountMenu, footer, shell, topbar } from "./dashboard";
import type { IconName } from "./icons";
import { button, el, icon, providerButtons, setBusy, toast, toastRegions } from "./ui";

/** One plan's limits, as `/api/limits` gives them under `plans`. */
interface PlanLimits {
  pad: { bytes: number; files: number; versions: number; history_bytes: number; version_age: number };
  account: { pads: number; bytes: number; named: number };
  address: { growth_per_day: number };
}

const DAY = 24 * 60 * 60;
/** How far ahead an account may pay: the relay's `AHEAD_DAYS`. */
const AHEAD_DAYS = 365;
/** How long the page waits on a payment Razorpay has not yet confirmed, and how often it asks. */
const WAIT_TRIES = 30;
const WAIT_EVERY_MS = 2000;

/** Rupees as Indians write them: ₹99, ₹1,499, ₹99.50. */
export function rupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: paise % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

/** A plan's room in round words: 50 MB, 1 GB. */
function room(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

const count = (n: number) => n.toLocaleString("en-IN");

function day(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

function shortDay(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function time(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function daysLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / DAY));
}

const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** What a plan gives, as the lines of its card: the same lines, in the same order, on both. */
function lines(l: PlanLimits): [IconName, string, string][] {
  return [
    ["file", "Each pad", `Up to ${room(l.pad.bytes)} and ${plural(l.pad.files, "file")}`],
    ["pads", "Your pads", `${plural(l.account.pads, "pad")} of your own, ${room(l.account.bytes)} in all`],
    ["pencil", "Your own names", `${count(l.account.named)} ${l.account.named === 1 ? "pad" : "pads"} with a name you choose`],
    ["reset", "History", `${plural(l.pad.versions, "earlier version")}, kept ${plural(Math.round(l.pad.version_age / DAY), "day")}`],
    ["upload", "Adding files", `Up to ${room(l.address.growth_per_day)} a day`],
  ];
}

function planCard(opts: { name: string; price: HTMLElement; tagline: string; limits: PlanLimits | null; paid: boolean; current: boolean; action?: HTMLElement | null; foot?: string }): HTMLElement {
  const id = `plan-${opts.paid ? "paid" : "free"}`;
  const card = el("article", { className: `card plan${opts.paid ? " plan-paid" : ""}${opts.current ? " plan-current" : ""}`, id });
  card.setAttribute("aria-labelledby", `${id}-name`);
  const head = el(
    "div",
    { className: "plan-head" },
    el("h2", { className: "plan-name", id: `${id}-name` }, opts.name),
    opts.current ? el("span", { className: "plan-badge" }, icon("check"), "Your plan") : null,
  );
  const list = el("ul", { className: "plan-lines" });
  if (opts.limits) {
    for (const [glyph, label, value] of lines(opts.limits)) {
      list.append(el("li", {}, el("span", { className: "plan-line-icon" }, icon(glyph)), el("div", {}, el("span", { className: "plan-line-label" }, label), el("strong", {}, value))));
    }
  } else {
    list.append(el("li", { className: "muted" }, "The limits could not be read just now."));
  }
  card.append(head, opts.price, el("p", { className: "plan-tagline" }, opts.tagline), list);
  if (opts.action) card.append(opts.action);
  if (opts.foot) card.append(el("p", { className: "plan-note plan-foot" }, opts.foot));
  return card;
}

function priceTag(amount: string, per: string): HTMLElement {
  return el("p", { className: "plan-price" }, el("span", { className: "plan-amount" }, amount), el("span", { className: "plan-per" }, per));
}

function step(n: number, glyph: IconName, title: string, text: string): HTMLElement {
  return el(
    "li",
    { className: "pay-step" },
    el("span", { className: "pay-step-icon" }, icon(glyph), el("span", { className: "pay-step-n", ariaHidden: "true" } as Partial<HTMLSpanElement>, String(n))),
    el("div", {}, el("strong", {}, title), el("span", {}, text)),
  );
}

function question(q: string, ...answer: (Node | string)[]): HTMLElement {
  return el("details", { className: "faq-item" }, el("summary", {}, q, icon("chevron")), el("div", { className: "faq-answer" }, ...answer.map((a) => (typeof a === "string" ? el("p", {}, a) : a))));
}

function link(text: string, href: string): HTMLAnchorElement {
  return el("a", { href }, text);
}

/** A payment's state in two or three words, for the list of them. */
function statusOf(p: Payment, now: number): { text: string; kind: "ok" | "wait" | "off" } {
  if (p.status === "paid") return { text: "Paid", kind: "ok" };
  if (p.status === "created" && p.url && p.expires > now) return { text: "Not finished", kind: "wait" };
  return { text: "Not completed", kind: "off" };
}

export async function startPricing(root: HTMLElement): Promise<void> {
  document.title = "Plans — pad";
  toastRegions();
  const params = new URLSearchParams(location.search);
  const returned = params.get("payment");

  // Back from Razorpay's page by the browser's Back: the page as it was
  // left, with its button still busy. Asked again instead.
  addEventListener("pageshow", (e) => {
    if (e.persisted) location.reload();
  });

  let me: Me;
  let billing: Billing;
  let plans: { free: PlanLimits; paid: PlanLimits } | null = null;
  try {
    [me, billing, plans] = await Promise.all([
      account.me(),
      account.billing(),
      fetch("/api/limits", { cache: "no-store", credentials: "same-origin" })
        .then(async (r) => (r.ok ? ((await r.json()) as { plans?: { free: PlanLimits; paid: PlanLimits } }).plans ?? null : null))
        .catch(() => null),
    ]);
  } catch (e) {
    root.replaceChildren(
      shell(
        topbar(),
        el("main", { className: "center" }, el("div", { className: "card gate" }, el("div", { className: "gate-icon" }, icon("alert")), el("h1", {}, "Could not reach pad"), el("p", { className: "muted" }, (e as Error).message), button("Try again", { icon: "reset", className: "btn-block", onClick: () => location.reload() }))),
        footer(),
      ),
    );
    return;
  }

  const signOut = async () => {
    await account.signOut().catch(() => {});
    location.assign("/pricing");
  };
  const right = me.user ? accountMenu(me, () => void signOut()) : el("a", { className: "btn btn-small", href: "/dashboard" }, "Sign in");

  const main = el("main", { className: "pricing" });
  root.replaceChildren(shell(topbar(right), main, footer()));

  const price = billing.price;
  const amount = rupees(price.amount);
  const per = `for ${plural(price.days, "day")}`;

  // ------------------------------------------------------------ the parts

  /** Where the account stands, in a line under the heading. */
  const standing = (): HTMLElement | null => {
    if (!billing.signed_in) return null;
    const line = el("p", { className: "standing" });
    if (billing.listed) {
      line.append(icon("check"), "Your account is on the paid plan, at no charge.");
    } else if (billing.plan === "paid" && billing.paid_until) {
      const left = daysLeft(billing.paid_until, billing.now);
      line.append(icon("check"), `You're on the paid plan until ${day(billing.paid_until)} — ${plural(left, "day")} left.`);
      if (left <= 7) line.classList.add("standing-soon");
    } else if (billing.paid_until && billing.paid_until <= billing.now) {
      line.append(icon("clock"), `You're on the free plan. Your paid plan ended on ${day(billing.paid_until)}.`);
    } else {
      line.append(icon("check"), "You're on the free plan.");
    }
    line.setAttribute("role", "status");
    return line;
  };

  const problem = el("div", { className: "alert pay-problem", hidden: true });
  problem.setAttribute("role", "alert");
  const say = (text: string) => {
    problem.replaceChildren(icon("alert"), el("span", {}, text));
    problem.hidden = false;
  };

  const pay = async (b: HTMLButtonElement) => {
    if (b.getAttribute("aria-busy") === "true") return;
    problem.hidden = true;
    setBusy(b, true, "Taking you to Razorpay…");
    try {
      const { url } = await account.checkout();
      location.assign(url);
    } catch (e) {
      setBusy(b, false);
      say((e as Error).message.replace(/^./, (c) => c.toUpperCase()));
    }
  };

  /** What the paid card offers: pay, continue, add days — or why not. */
  const action = (): HTMLElement => {
    const box = el("div", { className: "plan-action" });
    const note = (text: string | Node, ...more: (string | Node)[]) => el("p", { className: "plan-note" }, text, ...more);
    if (!billing.available) {
      const b = button(`Pay ${amount} with UPI`, { icon: "phone", className: "btn-primary btn-block" });
      b.disabled = true;
      box.append(b, note("Paying isn't open on this server yet."));
      return box;
    }
    if (!billing.signed_in) {
      if (me.providers.length) {
        box.append(note("The paid plan is for your account. Sign in first, then pay."), providerButtons(me.providers, "/pricing"));
      } else {
        box.append(note("Signing in isn't available on this server, so there is no account to pay for."));
      }
      return box;
    }
    if (billing.refusal === "listed") {
      box.append(note("Nothing to pay: your account is on the paid plan already."));
      return box;
    }
    const open = billing.payments.find((p) => p.status === "created" && p.url && p.expires > billing.now);
    if (billing.refusal === "ahead" && billing.paid_until) {
      const b = button(`Add ${plural(price.days, "day")}`, { icon: "plus", className: "btn-primary btn-block" });
      b.disabled = true;
      const from = billing.paid_until - (AHEAD_DAYS - price.days) * DAY;
      box.append(b, note(`You're paid up until ${day(billing.paid_until)}. You can add more from ${day(from)}.`));
      return box;
    }
    if (open?.url) {
      const b = button(`Continue paying ${rupees(open.amount)}`, { icon: "arrow", className: "btn-primary btn-block" });
      b.id = "pay";
      b.onclick = () => location.assign(open.url!);
      box.append(b, note(`You began a payment at ${time(open.created)}. It can be finished until ${time(open.expires)}.`), problem);
      return box;
    }
    const paying = billing.plan === "paid" && billing.paid_until && billing.paid_until > billing.now;
    const b = button(paying ? `Add ${plural(price.days, "day")} — ${amount}` : `Pay ${amount} with UPI`, { icon: paying ? "plus" : "phone", className: "btn-primary btn-block" });
    b.id = "pay";
    b.onclick = () => void pay(b);
    box.append(
      b,
      paying
        ? note(`Added to the ${plural(daysLeft(billing.paid_until!, billing.now), "day")} you have left: paid until ${day(billing.paid_until! + price.days * DAY)}.`)
        : note(`One payment, ${plural(price.days, "day")}. Nothing renews by itself.`),
      problem,
    );
    return box;
  };

  /** The payment this page was sent back for, as it stands. */
  const outcome = el("section", { className: "pay-outcome", hidden: true });
  outcome.setAttribute("role", "status");
  outcome.setAttribute("aria-live", "polite");
  outcome.setAttribute("aria-label", "Your payment");
  let tries = 0;
  const showOutcome = (): "done" | "wait" => {
    if (!returned) return "done";
    outcome.hidden = false;
    outcome.className = "pay-outcome card";
    if (!billing.signed_in) {
      outcome.replaceChildren(icon("alert"), el("div", {}, el("h2", {}, "Sign in to see your payment"), el("p", {}, "Whatever happened, a payment is kept with the account that began it. Sign in with that account to see how it went.")));
      return "done";
    }
    const p = billing.payments.find((x) => x.reference === returned);
    if (!p) {
      outcome.replaceChildren(icon("alert"), el("div", {}, el("h2", {}, "That payment isn't this account's"), el("p", {}, "It was begun by another account. Sign in with that one to see it.")));
      return "done";
    }
    if (p.status === "paid") {
      outcome.classList.add("pay-outcome-ok");
      const go = el("a", { className: "btn btn-primary", href: "/dashboard" }, el("span", { className: "btn-label" }, "Go to your pads"), icon("arrow"));
      outcome.replaceChildren(
        el("span", { className: "pay-outcome-icon" }, icon("check")),
        el(
          "div",
          {},
          el("h2", {}, "Payment received — thank you"),
          el("p", {}, p.until ? `Your account is on the paid plan until ${day(p.until)}.` : "Your account is on the paid plan."),
          el("p", { className: "pay-ref" }, `${rupees(p.amount)} · Razorpay ${p.payment_id ?? ""} · ${p.reference}`),
          el("div", { className: "pay-outcome-actions" }, go),
        ),
      );
      return "done";
    }
    if (p.status === "expired" || p.status === "cancelled" || p.expires + 15 * 60 < billing.now) {
      outcome.classList.add("pay-outcome-off");
      outcome.replaceChildren(icon("alert"), el("div", {}, el("h2", {}, "That payment didn't go through"), el("p", {}, "No money was taken for it. You can begin again below.")));
      return "done";
    }
    if (tries < WAIT_TRIES) {
      outcome.replaceChildren(el("span", { className: "spinner", ariaHidden: "true" } as Partial<HTMLSpanElement>), el("div", {}, el("h2", {}, "Confirming your payment…"), el("p", {}, "Razorpay is telling us how it went. This usually takes a few seconds.")));
      return "wait";
    }
    const again = button("Check again", { icon: "refresh", className: "btn-small" });
    again.onclick = () => {
      tries = 0;
      void wait();
    };
    outcome.replaceChildren(
      icon("clock"),
      el(
        "div",
        {},
        el("h2", {}, "Still waiting to hear from Razorpay"),
        el("p", {}, "If money left your account, your plan changes here as soon as Razorpay confirms it — usually within a few minutes — and you're never charged twice for one payment. If you didn't finish paying, you can carry on below."),
        el("p", { className: "pay-ref" }, `Reference ${p.reference}`),
        el("div", { className: "pay-outcome-actions" }, again),
      ),
    );
    return "done";
  };

  const history = el("section", { className: "pay-history" });
  history.setAttribute("aria-labelledby", "history-heading");
  const drawHistory = () => {
    const shown = billing.payments.filter((p) => p.status === "paid" || p.status === "created" || p.status === "expired" || p.status === "cancelled");
    history.hidden = !billing.signed_in || shown.length === 0;
    if (history.hidden) return;
    const rows = shown.map((p) => {
      const s = statusOf(p, billing.now);
      return el(
        "tr",
        {},
        el("td", {}, shortDay(p.paid_at ?? p.created)),
        el("td", {}, rupees(p.amount)),
        el("td", {}, p.until ? `${plural(p.days, "day")}, to ${shortDay(p.until)}` : plural(p.days, "day")),
        el("td", {}, el("span", { className: `pay-chip pay-chip-${s.kind}` }, s.text)),
        el("td", { className: "mono" }, p.payment_id ?? p.reference),
      );
    });
    history.replaceChildren(
      el("h2", { id: "history-heading" }, "Your payments"),
      el(
        "div",
        { className: "card table-card" },
        el(
          "div",
          { className: "table-wrap" },
          el("table", { className: "admin-table" }, el("thead", {}, el("tr", {}, ...["Date", "Amount", "For", "Status", "Reference"].map((h) => el("th", { scope: "col" }, h)))), el("tbody", {}, ...rows)),
        ),
      ),
      el("p", { className: "plan-note" }, "The reference is what to quote if you write to us about a payment."),
    );
  };

  const cards = el("div", { className: "plans" });
  const drawCards = () => {
    const current = billing.signed_in ? billing.plan : null;
    cards.replaceChildren(
      planCard({
        name: "Free",
        price: priceTag("₹0", "always"),
        tagline: "Everything pad does, for trying things out and sharing a snippet.",
        limits: plans?.free ?? null,
        paid: false,
        current: current === "free",
        foot: "Pads opened without signing in are on this plan, whoever writes in them.",
      }),
      planCard({
        name: "Paid",
        price: priceTag(amount, per),
        tagline: "More room for the pads you keep, and a longer history of them.",
        limits: plans?.paid ?? null,
        paid: true,
        current: current === "paid",
        action: action(),
      }),
    );
  };

  const head = el("header", { className: "pricing-head" });
  const drawHead = () =>
    head.replaceChildren(
      el("p", { className: "eyebrow" }, "Plans"),
      el("h1", {}, "More room for your pads"),
      el("p", { className: "lede" }, `pad is free to use. The paid plan gives the pads you own more room and a longer history — ${amount} ${per}, paid with UPI.`),
      ...(billing.test ? [el("p", { className: "alert alert-quiet test-mode" }, icon("alert"), el("span", {}, "Test mode: payments here go through Razorpay's test system, and no money moves."))] : []),
      standing() ?? "",
    );

  const redraw = () => {
    drawHead();
    drawCards();
    drawHistory();
  };

  /** Ask again until the payment this page came back for is settled. */
  const wait = async (): Promise<void> => {
    if (showOutcome() !== "wait") return;
    while (tries < WAIT_TRIES) {
      tries += 1;
      await new Promise((r) => setTimeout(r, WAIT_EVERY_MS));
      try {
        billing = await account.billing();
      } catch {
        continue;
      }
      if (showOutcome() !== "wait") {
        redraw();
        if (billing.payments.find((p) => p.reference === returned)?.status === "paid") toast("You're on the paid plan");
        return;
      }
    }
    showOutcome();
  };

  main.append(
    outcome,
    head,
    cards,
    el("p", { className: "plans-both" }, "Both plans run code the same way, in every language, with live editing and links to share. The paid plan changes how much room your pads have — nothing else."),
    el(
      "section",
      { className: "pay-how" },
      el("h2", {}, "How paying works"),
      el(
        "ol",
        { className: "pay-steps" },
        step(1, "arrow", "Go to Razorpay", "The button takes you to Razorpay's secure payment page for this one payment."),
        step(2, "phone", "Pay with any UPI app", "Scan the QR code with Google Pay, PhonePe, Paytm, BHIM or your bank's app — or enter your UPI ID — and approve it there."),
        step(3, "check", "Back here, on the paid plan", `Razorpay sends you back, and your account is on the paid plan straight away, for ${plural(price.days, "day")}.`),
      ),
    ),
    history,
    el(
      "section",
      { className: "faq" },
      el("h2", {}, "Questions"),
      question("Is this a subscription?", `No. Each payment buys ${plural(price.days, "day")}, and nothing is ever taken again by itself. When you want more, pay again — the days are added to what you have left.`),
      question(
        "What happens when the paid plan ends?",
        "Your account goes back to the free plan, and nothing is deleted: every pad, file and link stays, and opens as before.",
        `A pad bigger than the free plan allows can still be edited and made smaller, just not bigger. While you own more pads than the free plan's ${plans ? count(plans.free.account.pads) : "limit"}, you can't make another.`,
      ),
      question("Which pads does it cover?", "Every pad your account owns, for everyone who opens them. Pads opened without signing in are on the free plan, whoever writes in them."),
      question("What do you learn about my payment?", "The amount, when it was paid, and Razorpay's reference for it — which we keep, for our accounts and in case of a refund. Razorpay handles the payment itself: we never see your UPI PIN or your bank details, and we don't keep your UPI ID."),
      question("I paid, and it still says Free", "Reload this page: it asks Razorpay how any unfinished payment of yours went. If it still says Free a quarter of an hour later, write to us with the reference from your UPI app or from Your payments above, and we'll put it right.", el("p", {}, link("How to reach us", "/terms#contact"))),
      question("Can I get a refund?", "If you were charged and your account didn't move to the paid plan, or you were charged twice for one payment, we refund it in full.", el("p", {}, link("Refunds and cancellations", "/terms#refunds"))),
    ),
  );
  redraw();
  void wait();
}
