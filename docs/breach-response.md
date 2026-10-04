# Data breach response plan

What to do if player data may have been exposed. Written for a one-person
operation: short enough to follow under pressure. Not legal advice; if a breach
is serious, talk to a lawyer early (step 5).

**Owner:** the BorderWar operator. **Player contact:** contact@borderwar.io.

## What we hold

| Data | Where | If exposed |
|---|---|---|
| Email addresses | `server/data/borderwar.db` and `backups/` | Personal data. Spam or phishing risk. |
| Password hashes (salted scrypt) | same | Not directly usable, but weak passwords can be cracked offline. Treat as compromised. |
| Session token hashes | same | Not replayable as a login (only the SHA-256 is stored). Revoke anyway. |
| Display names, tags, settings, match results | same | Low sensitivity. |
| Admin token | `server/data/admin-token.txt` | Lets someone read live stats and drain the server. No player data. |

Not held: payment details, real names, addresses, chat, IP addresses in logs.

## What counts as a breach

Any of these, confirmed or reasonably suspected:

- Someone other than the operator had access to the host, its disk, or a copy of
  `server/data/` (lost or stolen machine, malware, shared or synced folder, a
  backup uploaded somewhere).
- `borderwar.db` or a backup was reachable over the web, or committed to git.
- A bug let one player read or change another player's account.
- The Cloudflare or GitHub account that controls the site was taken over.

Start the clock when you first have good reason to believe it happened. Note
that time; the 72-hour deadline in step 5 runs from it.

## Steps

### 1. Contain (first hour)

1. If the host itself may be compromised, take the site offline: stop the tunnel
   window, then the server.
2. Sign everyone out:
   ```
   node server/accounts/admin.js revoke-sessions --all
   ```
3. Rotate the admin token: delete `server/data/admin-token.txt` (or change
   `BORDERWAR_ADMIN_TOKEN`) and restart the server.
4. If an outside account was involved, change that password, end its other
   sessions and turn on two-factor sign-in (Cloudflare, GitHub, domain registrar).
5. Close the hole: remove the exposed copy, fix the bug, or move to a clean machine.
   If the file was pushed to GitHub, removing it in a new commit is not enough;
   it stays in history. Treat every account in it as exposed.

### 2. Keep evidence

Before cleaning up, save a copy of the server terminal output, the current
database, and anything showing how access happened. Start a dated log of what
you found and did. Regulators ask for this.

### 3. Work out what was exposed

- Which files, and from what date? (Backups go back 14 days.)
- How many accounts? `SELECT COUNT(*) FROM users` on the exposed copy.
- Could the person only read, or also change data?

If you cannot rule something out, assume it was exposed.

### 4. Decide who has to be told

| Situation | Regulator | Players |
|---|---|---|
| Emails or password hashes exposed, or may have been | Yes | Yes |
| Only names, tags, settings or match results | Record it; usually no | Usually no |
| Admin token only | No | No |
| Contained before anyone could have copied data (provably) | Record it; no | No |

### 5. Notify

- **Regulator, within 72 hours** of becoming aware, if players in the EU or UK
  are affected (GDPR Art. 33): the data protection authority where the operator
  is based, or the UK ICO. Report what you know by the deadline even if the
  investigation is not finished, and follow up later. US states have their own
  rules, mostly triggered by more sensitive data than we hold; a lawyer can
  confirm for the states involved.
- **Players, without undue delay**, by email to the address on each affected
  account, plus a notice on the main menu and in Discord and r/BorderWar. The
  game has no email-sending setup, so this is a manual send from
  contact@borderwar.io with recipients in BCC.

  List the addresses on the host with
  `sqlite3 server/data/borderwar.db "SELECT email FROM users"`, and delete the
  list once the notice is sent.

### 6. Force new passwords (if hashes were exposed)

Sessions are already revoked (step 1). There is no bulk reset: tell players in
the notice to change their password from Account on the main menu, and to change
it anywhere else they used the same one. For a player who is locked out:

```
node server/accounts/admin.js reset-password <email>
```

### 7. Afterwards

Within two weeks, add to the dated log: the cause, what was fixed, and what
would have caught it sooner. Update this plan and `privacy.html` if anything
about what we hold or how we protect it changed.

## Notice to players (template)

> **Subject: Security notice about your BorderWar account**
>
> On [date] we found that [what happened, in one plain sentence].
>
> **What was involved:** the email address on your BorderWar account, and a
> scrambled (hashed) form of your password. [Adjust to what was exposed.] We do
> not hold payment details, real names or addresses.
>
> **What we have done:** [fixed the cause], signed every account out, and
> reported this to [regulator].
>
> **What you should do:** sign in and change your password from Account on the
> main menu. If you used the same password anywhere else, change it there too.
> Be wary of emails claiming to be from BorderWar; we will never ask for your
> password.
>
> Questions: contact@borderwar.io. We're sorry this happened.

## Keep this plan usable

- Two-factor sign-in on Cloudflare, GitHub and the domain registrar.
- Once a year: restore a backup to a scratch file and run
  `admin.js export` against it, to prove the backups and tools still work.
