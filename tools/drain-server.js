#!/usr/bin/env node
// Drains the running BorderWar server: no new games, matches in progress play
// out, then the server exits. Run on the host machine, from anywhere:
//
//   node tools/drain-server.js [--max-minutes N] [--port 8124]
//
// --max-minutes caps the wait; when it runs out the server stops anyway and
// the players still connected are told it is restarting. Without it the wait
// is as long as the longest match. Ctrl+C here only stops watching; the
// server keeps draining. To stop it now, press Ctrl+C twice in its own window.
//
// Uses POST /admin/drain (server/admin.js) with the admin token.
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}
const port = Number(flag('--port') || process.env.PORT || 8124);
const maxMinutes = Number(flag('--max-minutes') || 0);
const POLL_MS = 5000;

let token = process.env.BORDERWAR_ADMIN_TOKEN;
if (!token) {
  try {
    token = fs.readFileSync(path.join(__dirname, '..', 'server', 'data', 'admin-token.txt'), 'utf8').trim();
  } catch (e) {
    console.error('No admin token: set BORDERWAR_ADMIN_TOKEN or start the server once to create server/data/admin-token.txt.');
    process.exit(1);
  }
}

function request(method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: port, method: method, path: urlPath,
      headers: { Authorization: 'Bearer ' + token }
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' from ' + urlPath));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const gone = (e) => e && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET');
const stamp = () => new Date().toTimeString().slice(0, 8);

async function main() {
  let state;
  try {
    state = await request('POST', '/admin/drain' + (maxMinutes > 0 ? '?maxMinutes=' + maxMinutes : ''));
  } catch (e) {
    if (gone(e)) { console.log('No server running on port ' + port + '.'); return; }
    throw e;
  }
  console.log('Draining: new games are blocked. ' + state.activeGames + ' active game'
    + (state.activeGames === 1 ? '' : 's') + ' to finish'
    + (state.deadline ? ', stopping by ' + new Date(state.deadline).toTimeString().slice(0, 5) + ' at the latest.' : '.'));

  let last = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let s;
    try {
      s = await request('GET', '/admin/stats');
    } catch (e) {
      if (gone(e)) { console.log(stamp() + '  Server stopped.'); return; }
      throw e;
    }
    const line = s.totals.activeGames + ' active game' + (s.totals.activeGames === 1 ? '' : 's')
      + ', ' + s.totals.players + ' player' + (s.totals.players === 1 ? '' : 's');
    if (line !== last) console.log(stamp() + '  ' + line);
    last = line;
  }
}

main().catch((e) => { console.error('drain-server: ' + (e && e.message || e)); process.exit(1); });
