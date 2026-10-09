// cd server && npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const adminModule = require('./admin');
const TOKEN = 'test-token';

async function startServer(updateFile) {
  process.env.BORDERWAR_ADMIN_TOKEN = TOKEN;
  const admin = adminModule.create({
    gameManager: { games: new Map() }, wss: Object.assign(new EventEmitter(), { clients: new Set() }),
    log: { info() {}, warn() {}, error() {} }, build: 'test', updateFile
  });
  const server = http.createServer((req, res) => admin.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (q, token) => fetch(base + '/admin/update' + q, {
    method: 'POST', headers: token === null ? {} : { Authorization: 'Bearer ' + (token || TOKEN) }
  });
  const stats = async () => (await fetch(base + '/admin/stats', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  return { post, stats, base, close: () => server.close() };
}

test('a request writes the mode to the request file, once', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bw-update-')), 'update-request');
  const s = await startServer(file);
  let st = (await s.stats()).server;
  assert.strictEqual(st.canUpdate, true);
  assert.strictEqual(st.updatePending, false);

  const r = await s.post('?mode=restart');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), 'restart');
  assert.strictEqual((await s.stats()).server.updatePending, true);
  assert.strictEqual((await s.post('?mode=update')).status, 409);
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), 'restart');
  s.close();
});

test('needs the token, POST and a known mode', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bw-update-')), 'update-request');
  const s = await startServer(file);
  assert.strictEqual((await s.post('?mode=update', null)).status, 401);
  assert.strictEqual((await s.post('?mode=update', 'wrong')).status, 401);
  assert.strictEqual((await s.post('?mode=reboot')).status, 400);
  assert.strictEqual((await s.post('')).status, 400);
  const get = await fetch(s.base + '/admin/update?mode=update', { headers: { Authorization: 'Bearer ' + TOKEN } });
  assert.strictEqual(get.status, 405);
  assert.strictEqual(fs.existsSync(file), false);
  s.close();
});

test('without an update file the route does not exist', async () => {
  const s = await startServer(null);
  assert.strictEqual((await s.post('?mode=update')).status, 404);
  assert.strictEqual((await s.stats()).server.canUpdate, false);
  s.close();
});
