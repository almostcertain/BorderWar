# Customization and the Supporter Pack

> **STATUS (2026-10-12): MVP built, nothing on sale.** Flags and territory
> patterns exist, ownership is decided by the server, and the owner can grant
> the pack by hand. There is no checkout and no price. §6 lists what is left
> before real money.
> Tests: `cd server && npm test` and `node --test tools/progress.test.js`.

## Quick reference

- **What is sold:** one **Supporter Pack**, a one-time purchase that unlocks
  every flag and every territory pattern.
- **Still no power.** Both are decoration (`metaprogression.md` P1). No sim file
  and no file the golden harness hashes was touched.
- **Earned and paid stay separate.** Titles, emblems and banners are still earned
  from achievements and cannot be bought. Flags and patterns cannot be earned.
- **Paid items are checked by the server.** Achievements are on the honour
  system; purchases are not (§4).
- **An account is required** to own the pack. Guests see the items locked.
- **Granting today:** `node server/accounts/admin.js grant <email> supporter`.

---

## 1. What players see

- **Cosmetics tab** (Achievements panel): a Supporter Pack card at the top, then
  a Flag row and a Territory pattern row with a picture of each item, then the
  earned slots as before. Locked pack items are greyed and say they belong to
  the pack. The card says "Not on sale yet" until checkout exists.
- **Flag:** beside the player's name in the lobby roster and the hover panel, and
  in front of the name on the nation's map label.
- **Territory pattern:** the nation's land alternates between its normal fill and
  a slightly lighter tone of the same colour, in a repeating motif.
- Other players see both, in the lobby and in the match, the same way they see
  titles and emblems (`metaprogression.md` §6.3).

## 2. Flags

Eight in v1, all invented (no real national flags). A flag is data, not an image:
a layout (`v3`, `h3`, `cross`, `saltire`, `disc`, `chevron`, `quarters`,
`diamond`) and two or three colours, in `js/progress-defs.js`. `Render.drawFlag`
draws it at any size. Adding a flag in an existing layout is one line; a new
layout is one `case`.

## 3. Territory patterns

Six in v1: stripes, bars, checker, dots, crosshatch, zigzag.

- A pattern is a 16x16 tile mask (`Render.PATTERNS`). `paintTile` picks the
  nation's normal fill or its second tone from the mask, so a pattern costs one
  array read per repainted tile and adds no draw pass. This is why the earlier
  performance objection (`metaprogression.md` §4) does not apply.
- Only the fill changes. Border tone, the alt view (hold Space), fallout, the
  dead zone and fog are as before, and the nation keeps its colour.
- **Known weak spot:** zoomed far out with many patterned nations on screen, the
  map looks busier. Acceptable while few players own the pack; if it sells well,
  consider fading patterns out below a zoom level.

## 4. Ownership

- New table `entitlements (user_id, sku, granted_at, source, ref)`, one row per
  account per pack, removed with the account. `source` is `admin` today; a
  payment provider's name and payment id go in `source` and `ref` later.
- `server/accounts/entitlements.js` is the only code that grants, revokes or
  reads it. Granting twice keeps the first row, so a retried webhook is harmless.
- `GET /api/me` returns `entitlements: ['supporter']`. The client uses it only to
  decide what to show as unlocked.
- **Enforcement** is in two places, both on the server:
  - `POST /api/progress` clears an equipped pack item the account does not own.
  - `POST /api/loadout` (what other players are shown) keeps a pack item only if
    the request's session cookie belongs to an account that owns the pack.
  - Joining a lobby checks again, against the account on the joining socket's
    own session cookie, and so does a loadout change while in the lobby. The
    stored loadout only proves that whoever posted it owned the pack, so
    without this an owner could post one under a friend's browser ID.
- So a modified client can draw a flag on its own screen and nobody else's.
- A revoked pack (a refund) stops showing from the player's next lobby. A match
  already started keeps what it started with.
- With no account server (static hosting) nobody owns anything.

## 5. Owner commands

```
node server/accounts/admin.js grant <email> supporter
node server/accounts/admin.js revoke <email> supporter
node server/accounts/admin.js export <email>      # now lists entitlements too
```

Safe while the server is running. The player sees the change on their next page
load.

## 6. Before real money

Owner decisions and work still open:

1. **Price and provider.** A hosted checkout page (Stripe Checkout or a merchant
   of record such as Paddle or Lemon Squeezy, which also handles sales tax and
   VAT) keeps card data off this server entirely.
2. **Webhook route** that verifies the provider's signature and calls
   `entitlements.grant(db, userId, 'supporter', '<provider>', '<payment id>')`;
   a refund event calls `revoke`.
3. **Buy button** on the pack card, replacing "Not on sale yet", plus a
   sign-in prompt for guests.
4. **Legal pages:** `terms.html` and `privacy.html` need a purchases and refunds
   section, and the privacy page should mention the payment provider.
5. **Email:** accounts have no verified email and no password reset by email. A
   buyer who loses access to their account loses the pack unless the owner
   resets it by hand.
6. Whether any flag or pattern should be free, as a taster.
