#!/usr/bin/python3
"""
PM270 / Nelko P21-family thermal printer driver (Classic Bluetooth SPP).

IMPORTANT: run this with a Python that has AF_BLUETOOTH support.
On this machine that is /usr/bin/python3, NOT the conda python.

    /usr/bin/python3 pm270.py status
    /usr/bin/python3 pm270.py config
    /usr/bin/python3 pm270.py tag
    /usr/bin/python3 pm270.py print-image test.png --width-mm 54
    /usr/bin/python3 pm270.py raw "1b213f0d0a"

Protocol notes (verified on PM270, 203 dpi):
  * RFCOMM channel 1, one SPP connection at a time.
  * Text commands are ASCII, terminated by CRLF. Matching is prefix/case-insensitive.
  * ESC commands are raw binary, no terminator, raw binary reply.
  * BITMAP payload is 1 bpp, MSB-first, row-padded to whole bytes.
    0 bit = black, 1 bit = white. No checksum.
  * The Nelko iOS app uses BITMAP mode 8 for short labels: 4 bpp, two dots
    per byte (high nibble first), 0x0 = black, 0xF = white. The payload is
    width_bytes * height * 4 bytes. It sends PRINT before BITMAP.

Python API
----------
    from pm270 import PM270, build_image_job, build_short_job

    with PM270() as p:
        print(p.status())
        p.print_image("label.png", short=True)

    # Hardware-free: build the bytes, send them yourself.
    job = build_image_job("label.png", short=True)
    with PM270() as p:
        p.print_job(job)
"""

from __future__ import annotations

import argparse
import re
import socket
import struct
import sys
import time

DEFAULT_ADDRESS = "6D:62:CD:C2:E4:1A"
CHANNEL = 1
DPI = 203
# Measured on this unit: ~40 mm of a 50 mm segment is visible. Keep content at
# or below 30 mm so even a 10 mm bottom margin leaves the last line readable.
SAFE_CONTENT_MM = 30.0
# Short labels below 0.5 in (13 mm / 104 dots) make the firmware feed an extra
# ~0.5 in after the image with the head still on, which prints a black bar.
MIN_SHORT_ROWS = 104
__all__ = [
    "PM270", "build_image_job", "build_short_job", "pack_4bpp",
    "job_length_mm", "DEFAULT_ADDRESS", "CHANNEL", "DPI",
    "MIN_SHORT_ROWS",
]

SERVICE_FF00 = "0000ff00-0000-1000-8000-00805f9b34fb"
CHAR_FF01 = "0000ff01-0000-1000-8000-00805f9b34fb"  # notify (replies)
CHAR_FF02 = "0000ff02-0000-1000-8000-00805f9b34fb"  # write (commands)


def _require_bt_socket() -> None:
    if not hasattr(socket, "AF_BLUETOOTH"):
        sys.exit(
            "This Python was built without Bluetooth sockets.\n"
            "Run with /usr/bin/python3 (or another distro Python)."
        )


def pack_4bpp(canvas) -> bytes:
    """Pack a PIL 'L' image as TSPL BITMAP mode 8 (4 bpp, high nibble first).

    The Nelko app sends 16 grey levels, not 1 bpp, for short labels. Two dots
    share a byte; the left dot is the high nibble. 0x0 is black, 0xF is white.
    """

    w, h = canvas.size
    if w % 2:
        raise ValueError("4 bpp bitmap width must be even")
    px = canvas.load()
    row_bytes = w // 2
    out = bytearray(row_bytes * h)
    i = 0
    for y in range(h):
        for x in range(0, w, 2):
            hi = (px[x, y] * 15 + 127) // 255
            lo = ((px[x + 1, y] * 15 + 127) // 255) if x + 1 < w else 15
            out[i] = (hi << 4) | lo
            i += 1
    # The PM270 keeps the head on briefly during feed-out and can repeat the
    # bottom edge. Force the last two dot rows white so a dark design cannot
    # turn into a solid bar under the label.
    tail = max(0, h - 2) * row_bytes
    out[tail:] = b"\xff" * (len(out) - tail)
    return bytes(out)


# Backwards-compatible private name used by older snippets.
_pack_4bpp = pack_4bpp


def build_short_job(canvas, width_mm: float, density: int = 15,
                    copies: int = 1) -> bytes:
    """Build the exact job shape captured from the Nelko iOS app.

    `canvas` must be a PIL 'L' image whose width is a multiple of 8 and <= 384
    dots, and at least 104 rows (13 mm). Its height (in dots) becomes the label
    length (no upper cap). The app sends PRINT *before* BITMAP; this ordering
    is required, and labels shorter than 13 mm get a black bar during feed-out.
    `SIZE` and the bitmap height always come from the same dot count, so the
    firmware cannot swallow the trailing CRLF as image data.
    """

    w, h = canvas.size
    if w % 8 or w > 384:
        raise ValueError("canvas width must be a multiple of 8 and <= 384 dots")
    if h < MIN_SHORT_ROWS:
        raise ValueError(
            f"short job must be at least {MIN_SHORT_ROWS} rows (13 mm); "
            "shorter labels get a black post-feed bar"
        )
    wbytes = w // 8
    length_mm = h / 8.0          # firmware's nominal 8 dots/mm

    job = bytearray()
    job += f"SIZE {width_mm:g} mm,{length_mm:g} mm\r\n".encode()
    job += b"GAP 0,0\r\n"
    job += b"DIRECTION 0,0\r\n"
    job += f"DENSITY {density}\r\n".encode()
    job += b"CLS\r\n"
    job += f"PRINT {copies},1\r\n".encode()
    job += f"BITMAP 0,0,{wbytes},{h},8,".encode()
    job += pack_4bpp(canvas)
    job += b"\r\n"
    return bytes(job)


def job_length_mm(job: bytes) -> float:
    """Return the SIZE length in mm from a TSPL job, or 50.0 if absent."""
    m = re.search(rb"SIZE\s+[\d.]+\s*mm\s*,\s*([\d.]+)\s*mm", job)
    return float(m.group(1)) if m else 50.0


def build_image_job(src, *, width_mm: float = 54.0, width_dots: int = 384,
                    label_length_mm: float = 50.0, density: int = 15,
                    gap_mm: float = 0.0, feed_margin_mm: float | None = None,
                    threshold: int = 128, invert: bool = False,
                    copies: int = 1, short: bool = False,
                    max_short_mm: float | None = None) -> bytes:
    """Rasterise an image and return the complete TSPL job bytes.

    This is the hardware-free half of the API: `src` may be a path or a PIL
    Image. Send the result with `PM270.send()` / `PM270.print_job()`, or post
    it through any transport you like.

    Short mode (`short=True`) reproduces the Nelko iOS app's captured job:
    `PRINT` before `BITMAP`, `BITMAP` mode 8 (4 bpp), exact `SIZE`, and a
    13 mm minimum so the firmware does not burn a bar during feed-out.
    """
    from PIL import Image, ImageOps

    # The PM270 head is 384 dots; a wider bitmap would run off the head.
    width_dots = max(8, min(384, int(width_dots) // 8 * 8))
    if feed_margin_mm is None:
        feed_margin_mm = 0.0 if short else 10.0

    if isinstance(src, Image.Image):
        image = src.convert("L")
    else:
        image = Image.open(src).convert("L")
    if invert:
        image = ImageOps.invert(image)

    if short:
        margin_rows = max(0, round(feed_margin_mm * 8))
        if max_short_mm:
            max_rows = max(MIN_SHORT_ROWS, int(round(max_short_mm * 8)))
            avail_rows = max(1, max_rows - margin_rows)
            scale = min(width_dots / image.width, avail_rows / image.height)
        else:
            max_rows = None
            scale = width_dots / image.width
        w = max(1, round(image.width * scale))
        h = max(1, round(image.height * scale))
        image = image.resize((w, h), Image.LANCZOS)

        # Round up to a whole millimetre (8 dots) and never go below
        # 13 mm: below 0.5 in the printer burns a bar during feed-out.
        rows = max(MIN_SHORT_ROWS, -(-(h + margin_rows) // 8) * 8)
        if max_rows is not None:
            rows = min(max_rows, rows)
        canvas = Image.new("L", (width_dots, rows), 255)
        canvas.paste(image, ((width_dots - w) // 2, 0))
        return build_short_job(canvas, width_mm, density, copies)

    canvas_h = max(1, round(label_length_mm * 8))
    avail_h = max(1, canvas_h - round(feed_margin_mm * 8))
    safe_h = min(avail_h, round(SAFE_CONTENT_MM * 8))

    scale = min(width_dots / image.width, safe_h / image.height)
    w = max(1, round(image.width * scale))
    h = max(1, round(image.height * scale))
    image = image.resize((w, h), Image.LANCZOS)

    canvas = Image.new("L", (width_dots, canvas_h), 255)
    canvas.paste(image, ((width_dots - w) // 2, max(0, (avail_h - h) // 2)))

    # 1-bit: PIL packs MSB-first, 1 = white, 0 = black. TSPL wants
    # 0 = burn/black, 1 = paper, so this is already the right polarity.
    bw = canvas.point(lambda p: 255 if p >= threshold else 0).convert(
        "1", dither=Image.Dither.NONE
    )

    raw = bw.tobytes()
    wbytes = bw.width // 8
    height_dots = bw.height

    job = bytearray()
    job += b"\r\n"
    job += f"SIZE {width_mm:g} mm,{label_length_mm:g} mm\r\n".encode()
    job += f"GAP {gap_mm:g} mm,0 mm\r\n".encode()
    job += b"DIRECTION 0,0\r\n"
    job += f"DENSITY {density}\r\n".encode()
    job += b"CLS\r\n"
    job += f"BITMAP 0,0,{wbytes},{height_dots},1,".encode()
    job += raw
    job += b"\r\n"
    job += f"PRINT {copies}\r\n".encode()
    return bytes(job)


class PM270:
    """Minimal client for the Nelko TSPL-family printers over SPP."""

    def __init__(self, address: str = DEFAULT_ADDRESS, channel: int = CHANNEL,
                 timeout: float = 8.0):
        _require_bt_socket()
        self.address = address
        self.channel = channel
        self.timeout = timeout
        self.sock: socket.socket | None = None

    # ---------------------------------------------------------------- link
    def connect(self, retries: int = 6, retry_delay: float = 1.5) -> "PM270":
        """Connect to RFCOMM channel 1.

        The printer accepts only one SPP link and can take a few seconds to
        release the previous one, so retry EBUSY/EAGAIN instead of failing.
        """
        last: OSError | None = None
        for attempt in range(retries):
            sock = socket.socket(
                socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM
            )
            sock.settimeout(self.timeout)
            try:
                sock.connect((self.address, self.channel))
            except OSError as e:
                sock.close()
                last = e
                if e.errno in (16, 11) and attempt + 1 < retries:  # EBUSY / EAGAIN
                    time.sleep(retry_delay)
                    continue
                raise
            sock.settimeout(0.5)
            self.sock = sock
            return self
        raise last  # type: ignore[misc]

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            finally:
                self.sock = None

    def __enter__(self) -> "PM270":
        return self.connect()

    def __exit__(self, *exc) -> None:
        self.close()

    # ---------------------------------------------------------------- io
    def send(self, data: bytes, chunk: int = 512, delay: float = 0.005) -> None:
        assert self.sock is not None, "not connected"
        # recv() wants a short poll timeout, but large raster jobs can stall
        # the printer's SPP flow control for several seconds. Give sendall a
        # much longer deadline than the receive timeout.
        old_timeout = self.sock.gettimeout()
        self.sock.settimeout(max(15.0, self.timeout))
        try:
            for off in range(0, len(data), chunk):
                self.sock.sendall(data[off:off + chunk])
                if delay:
                    time.sleep(delay)
        finally:
            self.sock.settimeout(old_timeout)

    def recv(self, wait: float = 0.5, max_bytes: int = 65536) -> bytes:
        """Drain whatever arrives until `wait` seconds pass with no data."""
        assert self.sock is not None, "not connected"
        out = bytearray()
        end = time.time() + wait
        while time.time() < end and len(out) < max_bytes:
            try:
                chunk = self.sock.recv(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        return bytes(out)

    def query(self, payload: bytes, wait: float = 0.7) -> bytes:
        """Send one command and collect the reply (text or raw)."""
        self.recv(0.05)          # drop stale bytes
        self.send(payload)
        return self.recv(wait)

    def text(self, line: str, wait: float = 0.7) -> bytes:
        return self.query(line.encode("ascii") + b"\r\n", wait)

    # ------------------------------------------------------------- queries
    def status(self) -> int:
        data = self.query(b"\x1b!?")
        return data[0] if data else -1

    def battery(self) -> dict:
        data = self.text("BATTERY?")
        payload = data.removeprefix(b"BATTERY ").rstrip(b"\r\n")
        if len(payload) < 2:
            return {"raw": data.hex(" ")}
        return {
            "level_bcd": f"{payload[0]:02x}",
            "level": int(f"{payload[0] >> 4}{payload[0] & 0x0f}"),
            "charging": payload[1],
            "raw": data.hex(" "),
        }

    def config(self) -> dict:
        data = self.text("CONFIG?")
        payload = data.removeprefix(b"CONFIG ").rstrip(b"\r\n")
        if len(payload) < 10:
            return {"raw": data.hex(" ")}
        return {
            "dpi": struct.unpack(">H", payload[0:2])[0],
            "hardware": ".".join(str(b) for b in payload[2:5]),
            "firmware": ".".join(str(b) for b in payload[5:8]),
            "shutdown": payload[8],
            "beep": payload[9],
            "raw": data.hex(" "),
        }

    def tag(self) -> dict:
        data = self.query(b"\x1b!o")
        if len(data) < 16:
            return {"raw": data.hex(" ")}
        b = data[:16]
        return {
            "status": b[0],
            "paper_code": b[2:14].hex().upper(),
            "tag_version": b[3] >> 4,
            "trade_flag": b[3] & 0x0F,
            "colour": b[4],
            "batch": (b[5] << 8) | b[6],
            "paper_type": b[7],      # 0 continuous, 1 gapped, 2 black-mark
            "gap_mm": b[8],
            "roll_outer": b[9],
            "roll_length": b[10],
            "label_length_mm": b[11],
            "usable_width_mm": b[12],
            "label_width_mm": b[13],
            "crc": b[14:16].hex(" "),
            "raw": b.hex(" "),
        }

    # -------------------------------------------------------------- print
    def selftest(self, hold: float = 5.0) -> bytes:
        reply = self.text("SELFTEST", wait=0.5)
        time.sleep(hold)
        return reply

    def print_job(self, job: bytes, hold: float = 6.0) -> None:
        self.send(job)
        time.sleep(hold)

    def print_image(self, path: str, width_mm: float = 54.0,
                    width_dots: int = 384, label_length_mm: float = 50.0,
                    density: int = 15, gap_mm: float = 0.0,
                    feed_margin_mm: float | None = None,
                    threshold: int = 128, invert: bool = False,
                    copies: int = 1, hold: float | None = None,
                    short: bool = False, max_short_mm: float | None = None) -> bytes:
        """Build and send one image job; returns the job bytes.

        See `build_image_job` for the rasteriser and `build_short_job` for the
        app-compatible exact path. `hold` defaults to an estimate from SIZE.
        """
        job = build_image_job(
            path, width_mm=width_mm, width_dots=width_dots,
            label_length_mm=label_length_mm, density=density, gap_mm=gap_mm,
            feed_margin_mm=feed_margin_mm, threshold=threshold, invert=invert,
            copies=copies, short=short, max_short_mm=max_short_mm,
        )
        if hold is None:
            hold = max(5.0, job_length_mm(job) / 20.0 + 2.0)
        self.send(job)
        time.sleep(hold)
        return job


# --------------------------------------------------------------------- cli
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="PM270 / Nelko SPP driver")
    ap.add_argument("--address", default=DEFAULT_ADDRESS)
    ap.add_argument("--channel", type=int, default=CHANNEL)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status")
    sub.add_parser("battery")
    sub.add_parser("config")
    sub.add_parser("tag")
    sub.add_parser("selftest")

    p = sub.add_parser("print-image")
    p.add_argument("image")
    p.add_argument("--width-mm", type=float, default=54.0)
    p.add_argument("--width-dots", type=int, default=384)
    p.add_argument("--length-mm", type=float, default=50.0,
                   help="roll segment length (50 mm on the stock PM270 roll)")
    p.add_argument("--density", type=int, default=15)
    p.add_argument("--gap-mm", type=float, default=0.0)
    p.add_argument("--feed-margin-mm", type=float, default=None,
                   help="white space at the bottom; 10 normal, 0 with --short")
    p.add_argument("--copies", type=int, default=1)
    p.add_argument("--invert", action="store_true")
    p.add_argument("--short", action="store_true",
                   help="exact length (min 13 mm, no max); uses the app's mode-8 job shape")
    p.add_argument("--max-short-mm", type=float, default=0.0,
                   help="optional cap for --short; 0 = no cap")

    r = sub.add_parser("raw")
    r.add_argument("hex", help="hex bytes to send, e.g. 1b213f0d0a")
    r.add_argument("--wait", type=float, default=0.8)

    a = ap.parse_args(argv)

    with PM270(a.address, a.channel) as p:
        if a.cmd == "status":
            print("status:", p.status())
        elif a.cmd == "battery":
            print(p.battery())
        elif a.cmd == "config":
            print(p.config())
        elif a.cmd == "tag":
            print(p.tag())
        elif a.cmd == "selftest":
            p.selftest()
            print("SELFTEST sent (no reply expected)")
        elif a.cmd == "print-image":
            p.print_image(
                a.image, width_mm=a.width_mm, width_dots=a.width_dots,
                label_length_mm=a.length_mm, density=a.density,
                gap_mm=a.gap_mm, feed_margin_mm=a.feed_margin_mm,
                copies=a.copies, invert=a.invert,
                short=a.short, max_short_mm=a.max_short_mm,
            )
            print("print job sent")
        elif a.cmd == "raw":
            print("<-", p.query(bytes.fromhex(a.hex), wait=a.wait).hex(" "))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
