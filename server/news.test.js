// cd server && npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

const newsModule = require('./news');
const adminModule = require('./admin');

const TOKEN = 'test-token';

// The admin and news routes wired the way server/index.js wires them.
async function startServer(opts) {
  process.env.BORDERWAR_ADMIN_TOKEN = TOKEN;
  const news = newsModule.create(opts);
  const admin = adminModule.create({
    gameManager: { games: new Map() }, wss: Object.assign(new EventEmitter(), { clients: new Set() }),
    log: { info() {}, warn() {}, error() {} }, build: 'test', news
  });
  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    if (urlPath.startsWith('/admin/')) return admin.handle(req, res);
    if (req.method === 'GET' && urlPath === '/news') return news.serve(req, res);
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function post(body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token !== null) headers.Authorization = 'Bearer ' + (token || TOKEN);
    const res = await fetch(base + '/admin/news', { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  const get = async () => (await (await fetch(base + '/news')).json()).post;
  return { news, base, post, get, close: () => server.close() };
}

test('publish, read back, replace and remove', async () => {
  let t = 5000;
  const s = await startServer({ now: () => t });
  assert.strictEqual(await s.get(), null);

  let r = await s.post({ title: '  Fog of war  ', body: 'Line one\r\nLine two\n' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.post, { title: 'Fog of war', body: 'Line one\nLine two', at: 5000 });
  assert.deepStrictEqual(await s.get(), r.body.post);

  t = 6000;
  r = await s.post({ title: '', body: 'Text only' });
  assert.deepStrictEqual(await s.get(), { title: '', body: 'Text only', at: 6000 });

  r = await s.post({ title: ' ', body: '' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.post, null);
  assert.strictEqual(await s.get(), null);
  s.close();
});

test('needs the admin token and POST', async () => {
  const s = await startServer();
  assert.strictEqual((await s.post({ title: 'x', body: 'y' }, null)).status, 401);
  assert.strictEqual((await s.post({ title: 'x', body: 'y' }, 'wrong')).status, 401);
  const get = await fetch(s.base + '/admin/news', { headers: { Authorization: 'Bearer ' + TOKEN } });
  assert.strictEqual(get.status, 405);
  assert.strictEqual(await s.get(), null);
  s.close();
});

test('bad or oversized fields are refused and leave the post alone', async () => {
  const s = await startServer();
  await s.post({ title: 'Keep', body: 'me' });
  const bad = [
    { title: 'x' },
    { title: 7, body: 'y' },
    { title: 'x', body: ['y'] },
    { title: 'x'.repeat(newsModule.MAX_TITLE + 1), body: 'y' },
    { title: 'x', body: 'y'.repeat(newsModule.MAX_BODY + 1) }
  ];
  for (const body of bad) {
    const r = await s.post(body);
    assert.strictEqual(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.strictEqual(typeof r.body.message, 'string');
  }
  assert.strictEqual((await s.post({ title: 'x', body: 'y', pad: 'z'.repeat(5000) })).status, 413);
  assert.strictEqual((await s.get()).title, 'Keep');
  s.close();
});

test('control characters are stripped; the title is one line', () => {
  const n = newsModule.create();
  assert.deepStrictEqual(n.set('a\nb\tc', 'x\u0000y\u0007\n\tz').title, 'a b c');
  assert.strictEqual(n.get().body, 'xy\nz');
});

test('the post survives a restart; a damaged file means no post', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bw-news-')), 'sub', 'news.json');
  const a = newsModule.create({ file, now: () => 42 });
  a.set('Hello', 'World');
  assert.deepStrictEqual(newsModule.create({ file }).get(), { title: 'Hello', body: 'World', at: 42 });
  a.set('', '');
  assert.strictEqual(newsModule.create({ file }).get(), null);
  for (const text of ['not json', '{"title":"<b>","body":7,"at":1}', '{"title":"a","body":"b"}', '[]']) {
    fs.writeFileSync(file, text);
    assert.strictEqual(newsModule.create({ file }).get(), null, text);
  }
});
