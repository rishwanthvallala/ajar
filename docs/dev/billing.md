# Paying for the paid plan

Since 5 November 2026 the paid plan ([the storage limits](operations.md#the-storage-limits),
`crates/ajar-relay/src/plan.rs`) can be bought: **₹99 for 30 days, with UPI,
through Razorpay**, on the pad's own page at `/pricing`. Before that an
account was on the paid plan only when `AJAR_PAID_ACCOUNTS` named it, and
that still works, beside paying.

The code: `crates/ajar-relay/src/billing.rs` (the payments, the signatures,
Razorpay's API), `http_billing.rs` (the four routes), `pad/src/pricing.ts`
(the page), `pad/public/terms.html` (terms, refunds, contact). The checks:
the unit tests in `billing.rs`, three serving tests against a stand-in
Razorpay (`serving_tests.rs`), and `pad/scripts/billing-check.mjs` in a real
browser.

## What was decided, and why

**Razorpay**, the maintainer's choice of 5 November, over Cashfree, PhonePe's
gateway or a bare UPI QR code. A bare `upi://pay` code costs nothing but
cannot be confirmed: nothing tells the server the money came, so every
payment would be checked by hand against a bank statement. A gateway says so,
signed.

**Pay each time, not a subscription.** One payment buys 30 days
(`AJAR_PAID_DAYS`) and nothing renews by itself. UPI AutoPay mandates exist,
but need the payer to approve a mandate in their app, Razorpay's
subscriptions product, and a cancel flow; a one-off payment needs none of
that, and nobody is charged for a month they forgot about. Paying again adds
its days to what is left (`billing::extended`), up to a year ahead
(`AHEAD_DAYS`) — beyond that a price change or a refund would meet years paid
in advance.

**₹99** (`AJAR_PAID_PRICE_INR`), in `deploy/limits.env` beside the limits it
buys. A change applies to payments begun after it; a link still open at the
old price is not offered again (`open_payment` matches the amount).

**Payment Links, and a redirect — not Razorpay's checkout script.** The pad's
origin is cross-origin isolated (`Cross-Origin-Embedder-Policy:
require-corp`, which the runtime needs for `SharedArrayBuffer`), and the CSP
allows scripts from this origin only. Razorpay's `checkout.js` and the frame
it opens would have to send `Cross-Origin-Resource-Policy` and be allowed by
the CSP, and they are not. A Payment Link is Razorpay's own page at its own
address: the tab goes there, pays, and comes back. Nothing on our page
changes. Each payment gets a link of its own, made when the button is
pressed, with our reference on it.

**UPI only**, as asked: the link is made with
`options.checkout.method = {upi: "1", card: "0", netbanking: "0", wallet: "0"}`.
Razorpay's page then offers the QR code and the UPI ID box.

## How a payment goes

1. **Begun.** `POST /api/billing/checkout` (signed in, `X-Ajar: 1` as every
   change is) records a payment — status `created`, a reference
   `ajar-<22 characters>` — and asks Razorpay for a link: the amount in
   paise, `INR`, `accept_partial: false`, our reference as `reference_id`,
   open for 30 minutes (`LINK_SECS`; Razorpay refuses under 15), the
   payer's name and email so its page need not ask, Razorpay's SMS and email
   off, and `callback_url` = `<AJAR_PUBLIC_ORIGIN>/api/billing/return`. The
   page sends the tab to the link's `short_url`. A link still open for more
   than ten minutes at this price is handed back instead of a new one, so
   Back and a second press lead to the same payment; and an account may
   begin five an hour (`BEGUN_AN_HOUR`), each being a request to Razorpay in
   our name.
2. **Paid**, on Razorpay's page.
3. **Credited**, by whichever of three arrives first; the others find it done.
   - **The way back.** Razorpay sends the tab to `/api/billing/return` with
     `razorpay_payment_id`, `_payment_link_id`, `_payment_link_reference_id`,
     `_payment_link_status` and `razorpay_signature` — the hex HMAC-SHA256,
     with the key's secret, of `link_id|reference|status|payment_id`. If it
     holds, the status is `paid` and the link is the one this reference was
     given, the payment is credited. Either way the tab goes on to
     `/pricing?payment=<reference>`. No session is needed or used: the tab
     arrives from another site, so the cookie is not trusted
     (`trusts_cookie_from`), and a payment is credited to the account that
     began it.
   - **The webhook.** Razorpay posts `payment_link.paid` (and `.expired`,
     `.cancelled`) to `/api/billing/webhook`, signed with the webhook's own
     secret over the raw body (`X-Razorpay-Signature`). A paid one is
     credited if `amount_paid` covers the payment and the currency is ours.
     Anything signed but not ours is acknowledged with a 200 and let be; a
     failure of ours is a 500, which Razorpay sends again.
   - **Asking.** `GET /api/billing` — `/pricing` as it opens, and every 2
     seconds while it waits on a payment — first asks Razorpay
     (`GET /v1/payment_links/<id>`) about this account's payments that are
     neither paid nor over, begun in the last day, each at most every 5
     seconds (`payments_to_check`, which marks them asked as it hands them
     out). This is what finds a payment whose tab was closed on Razorpay's
     page when no webhook is set up.
4. **What crediting does** (`Accounts::credit`), in one transaction: the
   payment becomes `paid` with Razorpay's `pay_…` id, and the account's
   `paid_until` becomes `max(now, paid_until) + 30 days`. Only the first call
   finds it unpaid; a Razorpay payment id is unique, so one payment cannot pay
   two of ours.
5. **The paid plan**, until `paid_until`: `Accounts::standing` reads it with
   the provider and email `AJAR_PAID_ACCOUNTS` is matched against, in the one
   query `plan_of` already made, so nothing else changed — pads, accounts and
   the daily allowance all ask `plan_of`. Past it, the account is free again,
   with no sweep: the next question gets the other answer. Pads past the free
   limits stay as they are, and can be edited and shrunk but not grown (the
   grandfathering in [operations.md](operations.md#the-storage-limits)).

## What is kept

In `accounts.db` (schema version 3): `users.paid_until`, and a `payments`
row per payment begun — reference, Razorpay's link id and page, amount in
paise, currency, days, status, Razorpay's payment id, when it was begun, when
its link expires, when it was paid, and until when that payment took the
account. Nothing else of the payer: not the UPI ID, which the webhook carries
and is dropped.

**Deleting an account keeps its payments**, with `user_id` set to null
(`ON DELETE SET NULL`): amount, date and Razorpay's reference, for the books
and for a refund, naming nobody. The privacy page says so, and the dashboard's
delete dialog says that paid days left go with the account. A payment that
completes after its account was deleted is recorded and credited to nobody.

The operator's view (`/admin`, People) shows how many accounts a payment holds
on the paid plan now, and the payments and rupees of the last 30 days.

## Setting it up

Razorpay needs an account with KYC (PAN and a bank account; an individual
without a registered business can sign up as one) and a review of the site,
which looks for the price, terms, a refund and cancellation policy, a privacy
policy and a way to reach us: `/pricing`, `/terms` (with `#refunds`,
`#delivery` and `#contact`) and `/privacy`.

1. **Test mode first.** In Razorpay's dashboard, test mode, *Account &
   Settings → API Keys*: generate a key. On the box:

   ```sh
   ssh ajar-relay
   sudo -e /etc/ajar/relay.env
   #   AJAR_RAZORPAY_KEY_ID=rzp_test_...
   #   AJAR_RAZORPAY_KEY_SECRET=...
   #   AJAR_RAZORPAY_WEBHOOK_SECRET=...   (step 2)
   sudo systemctl restart ajar-relay
   sudo journalctl -u ajar-relay -n 20 -o cat | grep payments
   #   payments: Razorpay in test mode, ₹99 for 30 days; its webhook taken
   ```

   With test keys `/pricing` says *Test mode* and no money moves; Razorpay's
   test UPI ID `success@razorpay` pays, `failure@razorpay` fails.
2. **The webhook.** *Account & Settings → Webhooks → Add new webhook*: URL
   `https://code.rishwanth.dev/api/billing/webhook`, a secret of your
   choosing (the same in `AJAR_RAZORPAY_WEBHOOK_SECRET`), events
   `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`.
   Test and live mode each have their own webhooks. Without one, payments
   are still credited by the way back and by asking; the journal says
   `its webhook not set up`, and the endpoint answers 404.
3. **Pay once in test mode**, end to end, from a signed-in account: the page
   says *Payment received*, the dashboard *Paid plan until …*, and the
   journal `a payment was credited` with how it was heard of.
4. **Live.** Once Razorpay has activated the account, generate live keys
   (`rzp_live_…`), a live-mode webhook, and put both in `relay.env` in place
   of the test ones. Payments begun with the test keys stay in the table and
   cannot be paid live.

Without the keys the relay runs as before: `/pricing` shows the plans and
says paying is not open, and `/api/billing/checkout` answers 503.

## By hand

The table is the record; Razorpay's dashboard is the other one.

```sh
ssh ajar-relay
sudo sqlite3 /var/lib/ajar/accounts.db
-- recent payments
SELECT reference, user_id, amount/100.0 AS rupees, status, payment_id,
       datetime(created,'unixepoch') AS begun, datetime(until,'unixepoch') AS until
FROM payments ORDER BY created DESC LIMIT 20;
-- who is paid up, until when
SELECT id, provider, email, datetime(paid_until,'unixepoch') FROM users WHERE paid_until > strftime('%s','now');
```

- **A payment Razorpay has and we do not credit** (both ways missed and the
  owner never opened `/pricing` again): opening `/pricing` signed in as them
  asks Razorpay. By hand: find its reference in Razorpay's dashboard
  (the link's *Reference ID*), then `UPDATE payments SET status='paid',
  payment_id='pay_…', paid_at=strftime('%s','now') WHERE reference='ajar-…';`
  and `UPDATE users SET paid_until = MAX(COALESCE(paid_until,0),
  strftime('%s','now')) + 30*86400 WHERE id = <user_id>;` — the two steps
  `credit` does.
- **A refund** is made in Razorpay's dashboard (*Payments → the payment →
  Issue refund*); Razorpay returns it to the payer's account in 5–7 working
  days. Then take its days off: `UPDATE users SET paid_until = paid_until -
  30*86400 WHERE id = <user_id>;`. Nothing here learns of refunds by itself
  yet (no `refund.processed` webhook).

## Not built

- Refunds from our side, and learning of one made in Razorpay's dashboard.
- Invoices or GST. Razorpay's receipt is the only one; registering for GST,
  if it is ever needed, changes the price and the terms.
- UPI AutoPay or any subscription; cards, netbanking, wallets.
- Emails of our own before a plan ends: the dashboard says so from seven days
  before (`.plan-link.soon`), and the privacy page promises no email.
- A price other than in rupees.
