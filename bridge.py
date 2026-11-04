#!/usr/bin/python3
"""
Tiny HTTP bridge: website <-> PM270 Classic Bluetooth SPP.

Browsers cannot open an RFCOMM/SPP socket, so this process owns the Bluetooth
link and exposes a small JSON/binary API. It also serves the designer, which
avoids mixed-content problems and works on phones that only have Safari.

Run (must be the distro Python, not conda):

    /usr/bin/python3 bridge.py                       # 127.0.0.1:8765
    /usr/bin/python3 bridge.py --host 0.0.0.0        # reachable from your phone
    /usr/bin/python3 bridge.py --host 0.0.0.0 --token secret
    /usr/bin/python3 bridge.py --mock                 # API test, no printer

API
---
GET  /api/health
GET  /api/query?cmd=status|battery|config|tag
POST /api/print     body = raw TSPL job bytes   (waits for print to finish)
POST /api/raw       body = raw bytes            (no wait)
POST /api/disconnect
GET  /              serves web/designer.html
GET  /quick         serves web/app.html

If --token is set, every /api/* request must send X-PM270-Token: <token>.
Short jobs (13-50 mm) must use PRINT-before-BITMAP and BITMAP mode 8; the API
rejects anything below 13 mm because the printer burns a bar during feed-out.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import socket
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pm270 import DEFAULT_ADDRESS, CHANNEL, PM270

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, "web")
MAX_BODY = 8 * 1024 * 1024
MIN_SHORT_MM = 13.0


class MockPrinter:
    """Hardware-free stand-in used by `bridge.py --mock` and CI."""

    def __init__(self):
        self.jobs: list[bytes] = []

    def connect(self) -> None:
        pass

    def close(self) -> None:
        pass

    def send(self, data: bytes, chunk: int = 512, delay: float = 0.0) -> None:
        self.jobs.append(bytes(data))

    def status(self) -> int:
        return 0

    def battery(self) -> dict:
        return {"level_bcd": "99", "level": 99, "charging": 0,
                "raw": "42 41 54 54 45 52 59 20 39 39 00 0d 0a"}

    def config(self) -> dict:
        return {"dpi": 203, "hardware": "0.0.1", "firmware": "0.0.5",
                "shutdown": 1, "beep": 0, "raw": "mock"}

    def tag(self) -> dict:
        return {"status": 0, "paper_code": "000C012203000300001215320F364ACF",
                "label_length_mm": 50, "usable_width_mm": 48,
                "label_width_mm": 54, "raw": "mock"}


class PrinterService:
    """Owns the single allowed SPP link and serialises all access to it."""

    def __init__(self, address: str, channel: int, mock: bool = False):
        self.address = address
        self.channel = channel
        self.mock = mock
        self.lock = threading.Lock()
        self.p = MockPrinter() if mock else PM270(address, channel)
        self.connected = False

    def _ensure(self) -> None:
        if not self.connected:
            self.p.connect()
            self.connected = True

    def _drop(self) -> None:
        try:
            self.p.close()
        finally:
            self.connected = False

    def close(self) -> None:
        with self.lock:
            self._drop()

    def run(self, fn):
        with self.lock:
            try:
                self._ensure()
                return fn(self.p)
            except Exception:
                self._drop()
                raise

    def hold_for_finish(self, job: bytes) -> float:
        """Estimate how long the printer needs, then sleep that long.

        Do NOT poll ESC!? while a job is printing: on the PM270 the status
        queries can be consumed mid-stream and confuse the job. The reference
        P21 client also just sends the job and waits.
        """
        m = re.search(rb"SIZE\s+[\d.]+\s*mm\s*,\s*([\d.]+)\s*mm", job)
        length_mm = float(m.group(1)) if m else 50.0
        if self.mock:
            return 0.05
        return min(60.0, max(5.0, length_mm / 20.0 + 2.0))


SERVICE: PrinterService
TOKEN = ""


class Handler(BaseHTTPRequestHandler):
    server_version = "pm270-bridge/1.1"

    # ------------------------------------------------------------ helpers
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-PM270-Token")
        self.send_header("Access-Control-Max-Age", "86400")

    def _authorized(self) -> bool:
        if not TOKEN:
            return True
        got = self.headers.get("X-PM270-Token") or ""
        return got == TOKEN

    def _deny(self) -> None:
        self._json({"ok": False, "error": "missing or bad X-PM270-Token"}, 401)

    def _json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n < 0 or n > MAX_BODY:
            raise ValueError("body too large")
        return self.rfile.read(n) if n else b""

    def _file(self, rel: str) -> None:
        # only serve inside WEB_DIR
        path = os.path.abspath(os.path.join(WEB_DIR, rel))
        if not path.startswith(os.path.abspath(WEB_DIR) + os.sep) and path != os.path.abspath(WEB_DIR):
            self._json({"error": "forbidden"}, 403)
            return
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        if not os.path.isfile(path):
            self._json({"error": "not found", "path": rel}, 404)
            return
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        data = open(path, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ------------------------------------------------------------- routes
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/api/") and not self._authorized():
            self._deny()
            return
        if u.path == "/api/health":
            self._json({
                "ok": True, "connected": SERVICE.connected,
                "mock": SERVICE.mock, "version": 1,
                "address": SERVICE.address, "channel": SERVICE.channel,
            })
            return
        if u.path == "/api/query":
            cmd = urllib.parse.parse_qs(u.query).get("cmd", ["status"])[0]
            try:
                if cmd == "status":
                    val = SERVICE.run(lambda p: p.status())
                    self._json({"ok": True, "cmd": cmd, "status": val})
                elif cmd in ("battery", "config", "tag"):
                    val = SERVICE.run(lambda p: getattr(p, cmd)())
                    self._json({"ok": True, "cmd": cmd, "value": val})
                else:
                    self._json({"ok": False, "error": "unknown cmd"}, 400)
            except Exception as e:
                self._json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 502)
            return
        if u.path in ("/", "/index.html"):
            self._file("designer.html")
            return
        if u.path == "/quick":
            self._file("app.html")
            return
        self._file(u.path.lstrip("/"))

    def do_POST(self) -> None:
        u = urllib.parse.urlparse(self.path)
        if u.path.startswith("/api/") and not self._authorized():
            self._deny()
            return
        if u.path == "/api/disconnect":
            try:
                SERVICE.close()
                self._json({"ok": True})
            except Exception as e:
                self._json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)
            return
        if u.path not in ("/api/print", "/api/raw"):
            self._json({"ok": False, "error": "not found"}, 404)
            return
        try:
            body = self._body()
            if not body:
                self._json({"ok": False, "error": "empty body"}, 400)
                return
            if u.path == "/api/print":
                m = re.search(rb"SIZE\s+[\d.]+\s*mm\s*,\s*([\d.]+)\s*mm", body)
                if m:
                    length_mm = float(m.group(1))
                    if length_mm < MIN_SHORT_MM:
                        self._json({
                            "ok": False,
                            "error": f"SIZE length {length_mm:g} mm is below the "
                                     f"{MIN_SHORT_MM:g} mm minimum; shorter labels "
                                     "print a black bar during feed-out",
                        }, 400)
                        return
                    if length_mm < 50:
                        bm = re.search(
                            rb"BITMAP\s+\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d+)\s*,",
                            body,
                        )
                        if bm and bm.group(1) != b"8":
                            self._json({
                                "ok": False,
                                "error": "short jobs must use BITMAP mode 8 (4 bpp)",
                            }, 400)
                            return
                        i_print = body.find(b"PRINT")
                        i_bitmap = body.find(b"BITMAP")
                        if i_print < 0 or i_bitmap < 0 or i_print > i_bitmap:
                            self._json({
                                "ok": False,
                                "error": "short jobs must send PRINT before BITMAP",
                            }, 400)
                            return
            t0 = time.time()

            def send(p: PM270):
                p.send(body, chunk=512, delay=0.005)
                if u.path == "/api/print":
                    time.sleep(SERVICE.hold_for_finish(body))
                return None

            SERVICE.run(send)
            self._json({
                "ok": True, "bytes": len(body),
                "ms": round((time.time() - t0) * 1000),
            })
        except Exception as e:
            self._json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 502)

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} {fmt % args}")


def main() -> int:
    global SERVICE, TOKEN
    ap = argparse.ArgumentParser(description="PM270 web bridge / HTTP API")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--address", default=DEFAULT_ADDRESS)
    ap.add_argument("--channel", type=int, default=CHANNEL)
    ap.add_argument("--token", default="",
                    help="require X-PM270-Token on /api/* (use with tunnels / --host 0.0.0.0)")
    ap.add_argument("--mock", action="store_true",
                    help="run without hardware (accept jobs, fake status) for API tests")
    a = ap.parse_args()

    if not a.mock and not hasattr(socket, "AF_BLUETOOTH"):
        raise SystemExit("run with /usr/bin/python3 (no AF_BLUETOOTH here)")

    TOKEN = a.token
    SERVICE = PrinterService(a.address, a.channel, mock=a.mock)
    httpd = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"PM270 bridge on http://{a.host}:{a.port}  "
          f"({'mock' if a.mock else f'printer {a.address} ch{a.channel}'})")
    if a.host == "0.0.0.0" and not TOKEN:
        print("WARNING: bound to 0.0.0.0 without --token; anyone on the LAN can print")
    if TOKEN:
        print("API token required (header: X-PM270-Token)")
    if a.host == "0.0.0.0":
        print("open http://<this-machine-ip>:%d on your phone" % a.port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        SERVICE.close()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
