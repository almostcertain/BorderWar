// Terminal logging for the host process. One line per event, local-time
// stamped. Deliberately nothing per-turn or per-intent (10Hz would drown the
// terminal), and no client IPs (behind the Cloudflare Tunnel they would all be
// Cloudflare's anyway).
'use strict';

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function line(level, out, tag, msg) {
  out(stamp() + ' ' + level + ' [' + tag + '] ' + msg);
}

module.exports = {
  info: (tag, msg) => line('INFO ', console.log, tag, msg),
  warn: (tag, msg) => line('WARN ', console.warn, tag, msg),
  error: (tag, msg) => line('ERROR', console.error, tag, msg)
};
