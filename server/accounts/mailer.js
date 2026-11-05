// Outgoing email (docs/monetization.md MO-1). Sends through Resend's HTTP API
// with the built-in fetch, so no dependency. Never logs addresses or bodies.
'use strict';

// opts: { apiKey, from, log, fetch, console: bool }
// - apiKey set: real sending.
// - console: true (dev only, BORDERWAR_MAIL=console): prints each mail to stdout.
// - neither: `enabled` is false and send() does nothing.
function create(opts) {
  opts = opts || {};
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const doFetch = opts.fetch || globalThis.fetch;
  const from = opts.from || 'BorderWar <no-reply@borderwar.io>';

  if (opts.apiKey) {
    return {
      enabled: true,
      // Resolves to true when Resend accepted the mail. Never rejects.
      async send(to, subject, text) {
        try {
          const r = await doFetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + opts.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to: [to], subject, text })
          });
          if (!r.ok) log.warn('mail', 'send failed: HTTP ' + r.status);
          return r.ok;
        } catch (e) {
          log.warn('mail', 'send failed: ' + (e && e.message || e));
          return false;
        }
      }
    };
  }

  if (opts.console) {
    return {
      enabled: true,
      async send(to, subject, text) {
        process.stdout.write('\n[dev-mail] to ' + to + ': ' + subject + '\n' + text + '\n\n');
        return true;
      }
    };
  }

  return { enabled: false, async send() { return false; } };
}

// A test double that keeps what was sent.
function memory() {
  const sent = [];
  return { enabled: true, sent, async send(to, subject, text) { sent.push({ to, subject, text }); return true; } };
}

module.exports = { create, memory };
