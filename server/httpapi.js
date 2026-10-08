// Request helpers shared by the /api/ routes (server/accounts/routes.js,
// server/loadouts.js). Kept free of the database so a route can use them when
// accounts are disabled.
'use strict';

const BODY_LIMIT = 4096;

const MESSAGES = {
  'invalid': 'That doesn\'t look right. Check the fields and try again.',
  'bad-credentials': 'Wrong email or password',
  'email-taken': 'That email already has an account',
  'rate-limited': 'Too many attempts, try again in a minute',
  'unauthorized': 'You are not signed in',
  'not-found': 'Not found'
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || MESSAGES[code]);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body, cookie) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  if (status === 413) headers['Connection'] = 'close';
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// Behind the Cloudflare Tunnel every TCP peer is cloudflared on loopback, and
// the real address is in CF-Connecting-IP. From any other peer that header is
// attacker-controlled, so the socket address is used instead.
function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  const cf = req.headers['cf-connecting-ip'];
  return (isLoopback(peer) && typeof cf === 'string' && cf) ? cf : peer;
}

// The Origin of a state-changing request, or throws. Must name the same host
// the request was sent to.
function checkOrigin(req) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new ApiError(415, 'invalid', 'Expected a JSON body');
  let origin;
  try { origin = new URL(req.headers.origin); } catch (e) { throw new ApiError(403, 'invalid', 'Bad origin'); }
  if (!req.headers.host || origin.host !== req.headers.host.toLowerCase()) {
    throw new ApiError(403, 'invalid', 'Bad origin');
  }
  return origin;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // Too big: answer now and stop keeping the rest. send() closes the
      // connection after a 413, so the upload can't go on.
      if (size > BODY_LIMIT) return reject(new ApiError(413, 'invalid', 'Request too large'));
      chunks.push(c);
    });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new ApiError(400, 'invalid'));
      resolve(body);
    });
    req.on('error', reject);
  });
}

module.exports = { ApiError, send, clientIp, checkOrigin, readJson };
