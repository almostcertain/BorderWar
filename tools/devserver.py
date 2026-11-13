"""Static dev server for the `borderwar` preview (.claude/launch.json).

Serves the current directory with caching off. Optional flags so stray
servers clean themselves up:
  --idle-exit-min=N   exit after N minutes with no requests
  --exit-with-parent  exit when the process that launched this one dies
"""
import http.server
import os
import socketserver
import sys
import threading
import time

_last_request = time.monotonic()


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def handle_one_request(self):
        global _last_request
        _last_request = time.monotonic()
        super().handle_one_request()


def _arg(name):
    for a in sys.argv[1:]:
        if a == name:
            return True
        if a.startswith(name + '='):
            return a.split('=', 1)[1]
    return None


def _exit(reason):
    print('devserver: ' + reason + ', exiting', flush=True)
    os._exit(0)


def _watch_idle(minutes):
    limit = minutes * 60
    while True:
        time.sleep(min(30, limit))
        if time.monotonic() - _last_request >= limit:
            _exit('idle for %g min' % minutes)


def _watch_parent():
    ppid = os.getppid()
    if os.name == 'nt':
        # Hold a handle and wait on it: immune to the PID being reused.
        import ctypes
        k32 = ctypes.windll.kernel32
        k32.OpenProcess.restype = ctypes.c_void_p
        h = k32.OpenProcess(0x00100000, False, ppid)  # SYNCHRONIZE
        if not h:
            print('devserver: cannot watch parent %d' % ppid, flush=True)
            return
        k32.WaitForSingleObject(ctypes.c_void_p(h), 0xFFFFFFFF)
        _exit('parent %d exited' % ppid)
    while os.getppid() == ppid:
        time.sleep(5)
    _exit('parent %d exited' % ppid)


def main():
    idle = _arg('--idle-exit-min')
    if idle not in (None, True) and float(idle) > 0:
        threading.Thread(target=_watch_idle, args=(float(idle),), daemon=True).start()
    if _arg('--exit-with-parent'):
        threading.Thread(target=_watch_parent, daemon=True).start()
    socketserver.TCPServer.allow_reuse_address = True
    http.server.test(HandlerClass=Handler, port=int(os.environ.get('PORT', 8123)))


if __name__ == '__main__':
    main()
