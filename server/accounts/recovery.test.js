// Email verification and password reset (docs/monetization.md MO-1).
// node --test server/accounts/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const routes = require('./routes');
const mailer = require('./mailer');

const FAST = { N: 1 << 10, r: 8, p: 1 };
// Throwaway test values, used nowhere else.
const PASS = 'test-only-Rv38-pass';
const PASS2 = 'test-only-Wn61-pass';

async function startServer(opts) {
  const mail = mailer.memory();
  let t = 1e12;
  const accounts = routes.create(Object.assign({ dbPath: ':memory:', scrypt: FAST, mailer: mail, now: () => t }, opts));
  const server = http.createServer((req, res) => accounts.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  function browser() {
    let cookie = '';
    async function call(method, route, body) {
      const h = Object.assign({}, cookie ? { Cookie: cookie } : {},
        method === 'POST' ? { 'Content-Type': 'application/json', Origin: base } : {});
      const res = await fetch(base + '/api/' + route, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json() };
    }
    return { get: (r) => call('GET', r), post: (r, b) => call('POST', r, b || {}) };
  }
  return {
    browser, base, mail,
    advance(ms) { t += ms; },
    // The token from the last mail of a kind sent to an address.
    token(to, kind) {
      const m = mail.sent.filter((x) => x.to === to && x.text.includes('#' + kind + '=')).pop();
      return m && /#(?:reset|verify)=([\w-]+)/.exec(m.text)[1];
    },
    close: () => { server.close(); accounts.close(); }
  };
}

test('register sends a verification link; verifying marks the email', async () => {
  const s = await startServer();
  const b = s.browser();
  const reg = await b.post('register', { email: 'ada@example.com', password: PASS });
  assert.strictEqual(reg.body.user.emailVerified, false);
  const token = s.token('ada@example.com', 'verify');
  assert.ok(token);
  assert.ok(s.mail.sent[0].text.includes(s.base + '/#verify='));

  // Works from another browser, signed out.
  assert.strictEqual((await s.browser().post('verify-email', { token })).status, 200);
  assert.strictEqual((await b.get('me')).body.user.emailVerified, true);
  // One use only.
  assert.strictEqual((await s.browser().post('verify-email', { token })).body.error, 'bad-token');
  s.close();
});

test('verification link expires after 24 hours', async () => {
  const s = await startServer();
  await s.browser().post('register', { email: 'ada@example.com', password: PASS });
  s.advance(24 * 60 * 60 * 1000 + 1);
  const r = await s.browser().post('verify-email', { token: s.token('ada@example.com', 'verify') });
  assert.strictEqual(r.body.error, 'bad-token');
  s.close();
});

test('forgot password: same answer for unknown email, reset signs in and ends old sessions', async () => {
  const s = await startServer();
  const old = s.browser();
  await old.post('register', { email: 'ada@example.com', password: PASS });

  const unknown = await s.browser().post('forgot-password', { email: 'nobody@example.com' });
  const known = await s.browser().post('forgot-password', { email: 'ADA@example.com' });
  assert.deepStrictEqual(unknown, known);
  assert.strictEqual(s.mail.sent.filter((m) => m.to === 'nobody@example.com').length, 0);

  const token = s.token('ada@example.com', 'reset');
  const b = s.browser();
  assert.strictEqual((await b.post('reset-password', { token, password: 'short' })).body.error, 'invalid');
  const r = await b.post('reset-password', { token, password: PASS2 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.user.emailVerified, true);   // the link proved the mailbox
  assert.strictEqual((await b.get('me')).body.user.email, 'ada@example.com');
  assert.deepStrictEqual((await old.get('me')).body, { user: null });

  assert.strictEqual((await s.browser().post('login', { email: 'ada@example.com', password: PASS })).status, 401);
  assert.strictEqual((await s.browser().post('login', { email: 'ada@example.com', password: PASS2 })).status, 200);
  assert.strictEqual((await s.browser().post('reset-password', { token, password: PASS })).body.error, 'bad-token');
  s.close();
});

test('reset link: only the latest works, expires after 1 hour, dies on email change', async () => {
  const s = await startServer();
  const b = s.browser();
  await b.post('register', { email: 'ada@example.com', password: PASS });

  await s.browser().post('forgot-password', { email: 'ada@example.com' });
  const first = s.token('ada@example.com', 'reset');
  await s.browser().post('forgot-password', { email: 'ada@example.com' });
  const second = s.token('ada@example.com', 'reset');
  assert.strictEqual((await s.browser().post('reset-password', { token: first, password: PASS2 })).body.error, 'bad-token');

  s.advance(60 * 60 * 1000 + 1);
  assert.strictEqual((await s.browser().post('reset-password', { token: second, password: PASS2 })).body.error, 'bad-token');

  await s.browser().post('forgot-password', { email: 'ada@example.com' });
  const third = s.token('ada@example.com', 'reset');
  const changed = await b.post('email', { password: PASS, email: 'ada2@example.com' });
  assert.strictEqual(changed.body.user.emailVerified, false);
  assert.ok(s.mail.sent.some((m) => m.to === 'ada@example.com' && /was changed/.test(m.subject)));
  assert.ok(s.token('ada2@example.com', 'verify'));
  assert.strictEqual((await s.browser().post('reset-password', { token: third, password: PASS2 })).body.error, 'bad-token');
  s.close();
});

test('forgot password is rate limited per email', async () => {
  const s = await startServer();
  await s.browser().post('register', { email: 'ada@example.com', password: PASS });
  for (let i = 0; i < 5; i++) await s.browser().post('forgot-password', { email: 'ada@example.com' });
  // 1 verify mail + 3 reset mails; the rest are dropped silently.
  assert.strictEqual(s.mail.sent.filter((m) => /Reset/.test(m.subject)).length, 3);
  assert.strictEqual((await s.browser().post('forgot-password', { email: 'ada@example.com' })).body.error, 'rate-limited');
  s.close();
});

test('resend verification needs a session; no mail service means a clear error', async () => {
  const s = await startServer();
  assert.strictEqual((await s.browser().post('resend-verification')).status, 401);
  const b = s.browser();
  await b.post('register', { email: 'ada@example.com', password: PASS });
  assert.strictEqual((await b.post('resend-verification')).status, 200);
  assert.strictEqual(s.mail.sent.filter((m) => /Confirm/.test(m.subject)).length, 2);
  s.close();

  const off = await startServer({ mailer: mailer.create({}) });
  const r = await off.browser().post('forgot-password', { email: 'ada@example.com' });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.body.error, 'mail-unavailable');
  off.close();
});

test('mailer: Resend request shape, failure never throws', async () => {
  const calls = [];
  const ok = mailer.create({ apiKey: 'test-key', fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; } });
  assert.strictEqual(await ok.send('a@b.co', 'Hi', 'Body'), true);
  assert.strictEqual(calls[0].url, 'https://api.resend.com/emails');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body).to, ['a@b.co']);
  const bad = mailer.create({ apiKey: 'test-key', fetch: async () => { throw new Error('down'); } });
  assert.strictEqual(await bad.send('a@b.co', 'Hi', 'Body'), false);
});
