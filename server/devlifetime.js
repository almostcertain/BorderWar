// Dev-only self-cleanup, opted into by flags in .claude/launch.json; the live
// server passes neither, so this does nothing there.
//   --idle-exit-min=N   stop after N minutes with no HTTP request and no open socket
//   --exit-with-parent  stop when the process that launched this one dies
'use strict';

function flag(name) {
  for (const a of process.argv.slice(2)) {
    if (a === name) return true;
    if (a.startsWith(name + '=')) return a.slice(name.length + 1);
  }
  return null;
}

function parentAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function start({ server, wss, stop, log }) {
  const idleMin = Number(flag('--idle-exit-min'));
  if (idleMin > 0) {
    let last = Date.now();
    server.on('request', () => { last = Date.now(); });
    const limit = idleMin * 60 * 1000;
    setInterval(() => {
      if (wss.clients.size > 0) last = Date.now();
      else if (Date.now() - last >= limit) stop('idle for ' + idleMin + ' min');
    }, Math.min(30000, limit)).unref();
    log.info('server', 'dev: will exit after ' + idleMin + ' idle min');
  }
  if (flag('--exit-with-parent')) {
    const ppid = process.ppid;
    setInterval(() => {
      if (!parentAlive(ppid)) stop('parent ' + ppid + ' exited');
    }, 5000).unref();
    log.info('server', 'dev: will exit with parent ' + ppid);
  }
}

module.exports = { start };
