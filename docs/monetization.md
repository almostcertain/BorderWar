# Monetization — Currencies, Subscriptions and the Store

> **STATUS (2026-11-04): MVP in progress on `feature/monetization`.** Owner's brief
> is §1; the MVP decisions are §1.1. Items still marked *proposed* outside the MVP
> await the owner's call; open questions are in §10.

## Quick reference

- **Two currencies.** **Border Bucks** (BB, premium, bought with money or granted
  by a subscription) and **Marks** (free, earned by playing). *Name "Marks" proposed.*
- **Three subscription tiers.** Every tier gives a verified name, a monthly BB
  grant and the right to host public lobbies. Higher tiers give more BB and extras.
- **Five BB packs** at $5, $10, $20, $50 and $100.
- **Still no power.** Nothing bought or earned changes the simulation
  (`metaprogression.md` P1). Currencies buy cosmetics and convenience outside the
  match only. No sim file and no golden-hashed file changes.
- **The server owns all balances.** Wallets, subscriptions and verified names live
  in the accounts database; the client only displays them.
- **An account is required** for anything here. Guests keep playing as today.

---

## 1. Owner's brief (2026-11-04)

- Premium currency is called **Border Bucks**. Free currency: name to be proposed.
- Subscriptions in **three tiers**. A subscription grants a **verified user name**,
  a **monthly injection of Border Bucks**, and the **ability to create public lobbies**.
- Border Bucks can be bought at **$5, $10, $20, $50 and $100**.

### 1.1 MVP decisions (2026-11-04)

- **In the MVP:** password recovery with email verification (MO-1), wallet and
  ledger (MO-2), subscriptions and verified names (MO-5), checkout for BB packs and
  subscriptions (MO-6), legal page updates (MO-7).
- **Not in the MVP:** spending currency (the store, MO-3) and earning Marks (MO-4).
  Marks show as 0 until MO-4.
- **Public lobbies are subscriber-only.** The rotating public lobby stays open to all.
- **Tiers, prices and BB amounts as proposed** in §3 and §4.
- **Payment provider: Paddle Billing** (merchant of record; handles tax, VAT,
  receipts, refunds and the cancel flow). Webhook signatures are checked with
  Node's `crypto`, so no new dependency.
- **Email: Resend**, called over its HTTP API with `fetch`, so no new dependency.
  Needs a Resend account and DNS records on borderwar.io (owner task).
- Worked from this spec on the branch, not as board tickets.

## 2. The free currency: Marks

*Proposed name:* **Marks**. A "march" or "mark" was historically a borderland, and
the word also reads as money. Short, fits the BorderWar theme, and doesn't
collide with in-match gold. Alternatives if it doesn't land: Rations, Stakes, Scrip.

**How Marks are earned** (*proposed*):

| Source | Marks |
|---|---|
| Finish a multiplayer match (not quitting before the end) | 20 |
| Finish place bonus | up to +30, scaled by percentile |
| Win | +50 |
| First win of the day | +100 |
| Achievement unlocked (first time only) | 50–250 by difficulty |
| Singleplayer match (R2 minimum applies) | 10, capped at 5 per day |

- Multiplayer Marks are awarded by the **server** from its own match record, never
  from what the client reports. This needs **AU-4 (match results)**, which is not
  built yet (`accounts-auth.md` §8).
- Singleplayer and achievement Marks are client-reported (honour system, like
  achievements today), so they are capped low enough that cheating isn't worth it.
- **Marks cannot be bought**, transferred or converted to BB.

**What Marks buy:** a rotating selection of store cosmetics (§5), so free players
have a real path to new items. The best items stay BB-only.

## 3. Border Bucks packs

*Proposed* amounts: 100 BB per dollar, with a bonus on bigger packs.

| Price | Base | Bonus | Total BB |
|---|---|---|---|
| $5 | 500 | — | 500 |
| $10 | 1,000 | +5% | 1,050 |
| $20 | 2,000 | +10% | 2,200 |
| $50 | 5,000 | +15% | 5,750 |
| $100 | 10,000 | +20% | 12,000 |

- Store prices are set so the $5 pack always buys at least one item outright, and
  so no common item leaves an awkward leftover (prices in multiples of 50).
- BB never expires, can't be cashed out, and can't be traded between players.
- Spent BB is non-refundable; an **unspent** pack can be refunded through the
  provider, which removes the BB. If the player has already spent it, the balance
  goes negative and the store is locked until it is repaid (standard practice).

## 4. Subscriptions

*Proposed* names and prices (monthly; yearly at roughly 2 months free):

| | **Scout** | **Warden** | **Sovereign** |
|---|---|---|---|
| Price / month | $2.99 | $5.99 | $11.99 |
| Verified name (check mark) | yes | yes | yes |
| Badge colour | silver | gold | crimson |
| Monthly BB | 300 | 700 | 1,600 |
| Host public lobbies | yes | yes | yes |
| Public lobbies at once | 1 | 2 | 3 |
| Lobby extras | — | custom lobby name | custom name, featured slot at the top of the Join list |
| Marks earned | +0% | +25% | +50% |
| Exclusive cosmetic each month | — | yes | yes |

- The monthly BB is worth a bit more than the BB the same money buys outright, so
  a subscription is always the better deal for regular players.
- BB is granted when each paid period starts (on the provider's renewal event),
  not on a calendar date. It stays after cancelling.
- **Changing tier** upgrades at once (prorated by the provider; the BB difference
  is granted immediately) and downgrades at the next renewal.
- **Cancelling** keeps every benefit until the end of the paid period.

### 4.1 Verified names

- A subscriber **reserves** their display name: unique, case-insensitive, and
  with look-alike characters folded together (`l`/`I`/`1`, Cyrillic `а`, etc.), so
  nobody can impersonate them.
- A check mark in the subscriber's tier colour shows next to the name in the
  lobby roster, the leaderboard, the hover panel and map labels.
- Nobody else, guest or signed in, can use a reserved name; they get a "name taken"
  message. This **reverses A4** in `accounts-auth.md` for subscribers only.
- Renaming a verified name: once per 30 days.
- **When a subscription lapses:** the check mark goes immediately; the name stays
  reserved for 60 days so a returning subscriber keeps it, then is released.
- Names go through a word filter and an owner override (to pull an abusive name
  without refunding).

### 4.2 Public lobbies

- **Today anyone can host a public lobby.** This change means free players can only
  host **private** lobbies (shared by join code) and join public ones. The
  always-on rotating public lobby (`gamemanager.js` `_spawnAutoLobby`) stays free
  for everyone, so a free player can always find a public game.
- The check is on the server, when the lobby is made public: the host's socket
  must belong to an account with an active subscription.
- *Risk:* fewer public lobbies in the Join list while the player base is small.
  Possible softener: free players get one public lobby per day.

## 5. The store

- A **Store** tab next to Cosmetics in the Achievements panel.
- Sells cosmetics only: flags, territory patterns (today's Supporter Pack items),
  and new kinds later (border styles, name colours, lobby banners, end-screen
  flourishes).
- Each item has a BB price, and some also have a Marks price. Prices *proposed*:
  common 200 BB / 1,500 Marks, rare 500 BB / 4,000 Marks, epic 1,000 BB (BB only).
- A **weekly rotation** of featured items, some at a discount.
- **No loot boxes or random rewards** for money, ever. Players always see exactly
  what they get. This keeps clear of the loot-box laws in Belgium, the Netherlands
  and elsewhere, and of app-store rules.
- Earned cosmetics (achievement titles, emblems, banners) stay earned-only, as
  `metaprogression.md` requires.
- **The existing Supporter Pack** becomes a store bundle priced in BB. Anyone
  already granted it keeps it.

## 6. Server design (outline)

New tables in the accounts database, all owned by one module
(`server/accounts/wallet.js`), the same way `entitlements.js` owns entitlements:

- `ledger (id, user_id, currency, delta, reason, ref, created_at)`: every change to
  any balance, append-only. The balance is the sum, cached in `wallets`.
- `wallets (user_id, currency, balance)`
- `subscriptions (user_id, tier, status, period_end, provider, provider_ref)`
- `reserved_names (folded_name, user_id, display_name, released_at)`
- Purchases from the store reuse `entitlements` for the item, and write one ledger
  row, in a single transaction so a crash can't take the BB without giving the item.
- The payment provider's webhook is the only thing that grants BB or changes a
  subscription. Each event's id is recorded so a retried webhook does nothing twice.
- `GET /api/me` adds `wallet: {bb, marks}`, `subscription: {tier, renewsAt}` and
  `verified: true|false`.

## 7. Payments, tax and legal

- **Use a merchant of record** (Paddle or Lemon Squeezy) rather than plain Stripe.
  They act as the seller, so they collect and pay sales tax and VAT worldwide and
  handle chargebacks and receipts. Their cut (~5%) is worth not running tax
  compliance in-house. Card data never touches this server.
- **Cancel online, in a few clicks**, from the account panel (US click-to-cancel
  rules; also just good practice).
- **EU/UK:** buyers of digital content waive the 14-day withdrawal right only if
  they tick a consent box at checkout; the provider's checkout handles this.
- **Terms and privacy pages** need sections on virtual currency (no cash value,
  non-transferable, may change), subscriptions, refunds and the provider.
- **Age:** the terms should say purchases need a parent's permission under 18;
  no data is collected from under-13s (already true: no email is mailed).

## 8. Prerequisites before taking money

1. **Password recovery and verified email.** Accounts today can't recover a lost
   password (`accounts-auth.md` A2). A paying subscriber who loses access loses
   their money. Email verification and reset must come first; this needs an email
   sending service.
2. **AU-4 match results** on the server, so Marks can be awarded from the server's
   own record.
3. A **support path**: a contact address, and owner admin commands to look up a
   wallet, refund or adjust it (always as a ledger row), and pull a name.

## 8.1 MO-1 as built (2026-11-04)

- **Links:** `/#reset=<token>` (1 hour) and `/#verify=<token>` (24 hours). The token
  is in the URL fragment so it never reaches a server or Cloudflare log. Only the
  token's SHA-256 is stored (`email_tokens`, schema v4); a new link replaces the
  previous one, and each link is tied to the address it was sent to, so changing
  the email kills it.
- **Routes:** `forgot-password` (always answers ok, so it doesn't reveal which
  emails have accounts; 5/hour per IP, 3 mails/hour per email), `reset-password`
  (signs in, ends every other session, counts the email as verified),
  `verify-email` (works signed out), `resend-verification` (3/hour). `/api/me`
  gains `emailVerified`.
- **Mails sent:** confirm link on sign-up and on email change; a notice to the
  old address when the email changes; the reset link.
- **Existing accounts** start unverified. Reset works for them anyway (the link
  goes to the address on file); the menu shows "Confirm email" until they do.
- **UI:** "Forgot password?" in the sign-in dialog, a new-password form opened
  from the link, "Confirm email" in the menu strip.
- **Server config:** `RESEND_API_KEY` turns real sending on; `BORDERWAR_MAIL_FROM`
  overrides the sender (default `BorderWar <no-reply@borderwar.io>`);
  `BORDERWAR_PUBLIC_URL` sets the link base (production default
  `https://borderwar.io`). Without a key, production sends nothing and the reset
  form says it is unavailable; a dev server prints each mail to its console.
- **On the box:** secrets go in `/opt/borderwar/server/data/secrets.env`
  (owner-only, read by `borderwar.service`).
- **Owner tasks before it works live:** create a Resend account, add its DNS
  records for borderwar.io in Cloudflare, put `RESEND_API_KEY=…` in
  `secrets.env`, and make `support@borderwar.io` reach you (the email-changed
  notice names it). `privacy.html` must name Resend as a processor (MO-7).
- Tests: `server/accounts/recovery.test.js`.

## 8.2 MO-2 as built (2026-11-05)

- `server/accounts/wallet.js` is the only code that changes a balance. Every
  change is a `ledger` row (schema v5) with the balance after it; `wallets` caches
  the balance. `wallet.consistent()` checks the two agree.
- **Repeat-safe:** a row with a non-empty `(source, ref)` (e.g. `paddle`, a
  transaction id) is applied once; a retried webhook gets `duplicate: true`.
- **No overspending:** a take-away below zero is refused unless `allowNegative`,
  which only refunds and admin adjustments use (a refund of BB already spent
  leaves a negative balance; §3).
- Runs in a savepoint, so a later store purchase can take BB and grant the item
  in one transaction.
- `/api/me` gains `wallet: {bb, marks}`; the menu strip shows both when signed in.
  The account export and the admin page's user list include them.
- **Owner commands:** `admin.js wallet <email>` (balances and the last 20
  changes) and `admin.js adjust <email> <bb|marks> <+n|-n> <note>` (a note is
  required; it is kept in the ledger).
- Tests: `server/accounts/wallet.test.js`.

## 8.3 MO-5 as built (2026-11-05)

- **Tier table:** `js/shop-defs.js` (tiers and BB packs), shared by client and
  server. Changing a price or BB amount is one line there (plus Paddle, MO-6).
- **Subscriptions** (`server/accounts/subscriptions.js`, schema v6): one row per
  account with tier, status (`active`, `canceled`: runs to the period end,
  `ended`: stopped now) and period end. `startPeriod` is called once per paid
  period and grants that tier's BB, once per payment reference.
- **Verified names** (`server/accounts/names.js`): folding drops case, the clan
  tag, accents and separators, and maps look-alikes (Cyrillic/Greek letters,
  `0→o`, `1/i/|→l`, `rn→m`…). A subscriber's display name is reserved when the
  subscription starts and when they rename (once per 30 days; a change of case
  is free). Held for 60 days after the subscription ends.
- **Who is refused a reserved name:** sign-up and profile changes (`name-taken`),
  and joining any lobby under it, guests included, unless the socket's account
  owns it.
- **Badge:** the server adds `verified: <tier>` to the player's lobby roster and
  match-start entry only when the socket's account is subscribed and joined
  under its verified name. Drawn as a disc in the tier colour with a white
  tick: map labels, hover panel, lobby roster. Not in singleplayer (no server).
- **Public lobbies:** with accounts on, opening a public lobby needs an active
  subscription, and at most 1/2/3 open public lobbies per Scout/Warden/Sovereign.
  Refused with `subscription-required` or `public-limit`. The host panel's Public
  box is disabled with a note for non-subscribers. Without accounts (LAN or local
  servers) nothing is gated. The rotating public lobby is unaffected.
- **Menu strip:** a subscriber sees their badge, tier and verified name.
- **Owner commands:** `admin.js subscribe <email> <tier> [days]` (stacks onto
  the current period, grants the BB, reserves the name), `unsubscribe <email>`,
  `release-name <name>`. Export and the admin user list include the tier.
- **Not yet:** the leaderboard has no badge; tier extras beyond public lobbies
  (custom lobby name, featured slot, monthly cosmetic, Marks boost) wait for the
  store and Marks work.
- Tests: `server/accounts/subscriptions.test.js`.

## 9. Task breakdown (proposed order)

1. **MO-1 Email verification and password reset.** Prerequisite (§8.1).
2. **MO-2 Wallet and ledger.** Tables, `wallet.js`, admin commands, `/api/me` fields.
   Testable with admin grants and no real money.
3. **MO-3 Store.** Store tab, item catalogue in `progress-defs.js`, buy with BB or
   Marks, Supporter Pack as a bundle.
4. **MO-4 Marks earning.** Needs AU-4. Server-side awards, singleplayer caps.
5. **MO-5 Subscriptions and verified names.** Tables, name reservation and folding,
   check marks in the UI, public-lobby gating on the server.
6. **MO-6 Checkout.** Provider account, webhook route, BB packs and subscription
   checkout, cancel and manage from the account panel.
7. **MO-7 Legal and launch.** Terms and privacy updates, support address, test
   purchases in the provider's sandbox, then live.

MO-2 to MO-5 can be built and tested with admin grants before any money is involved.

## 10. Open questions for the owner

1. **Free currency name:** Marks, or something else?
2. **Tier names and prices** in §4: keep Scout / Warden / Sovereign at
   $2.99 / $5.99 / $11.99, or different?
3. **What separates the tiers** beyond the BB amount: are the proposed extras
   (concurrent lobbies, featured slot, Marks boost, monthly exclusive) right?
4. **Public lobby gating:** fully subscriber-only, or one free public lobby per
   day for everyone?
5. **BB pack amounts and bonuses** in §3.
6. **Can Marks buy anything at all**, or only a rotating subset (as proposed)?
7. **Gifting:** should players be able to gift a subscription or BB to someone else?
   (Common, but a fraud vector; proposed: later.)
8. **Payment provider:** Paddle, Lemon Squeezy, or Stripe with its tax add-on.
