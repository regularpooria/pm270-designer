# Nelko PM270 — protocol notes & toolkit

Reverse-engineered on real hardware (2026-11-03). The PM270 is a 203 dpi, 54 mm
direct-thermal sticker/label printer. It is the same firmware family as the Nelko
P21 / P22 and speaks a **subset of TSPL2** over a line-oriented serial protocol.

**Live designer:** <https://regularpooria.github.io/pm270-designer/> — static
GitHub Pages build, no server or Python API required.

## TL;DR — what we verified

| Item | Result |
|---|---|
| Transport | **Classic Bluetooth SPP / RFCOMM channel 1** (desktop/Linux) and **BLE GATT** (iOS app) |
| BLE | The iOS app connects over BLE and writes the same TSPL commands to GATT handle `0x0006`; replies arrive as notifications on `0x0008`. Only JieLi `af30` OTA is advertised; the data service appears after connecting. |
| Name / address (this unit) | `PM270` / `6D:62:CD:C2:E4:1A` (public) |
| Resolution | 203 dpi (`CONFIG?` → `00 CB`) |
| Firmware | `0.0.5` (this unit) |
| Head width | **384 dots / 48 mm** (48-byte rows printed correctly) |
| Web client | `web/designer.html` — direct **Web Serial** (RFCOMM/SPP), auto length, barcodes/QR |
| Roll (this unit) | 54 mm wide, continuous, no gap |
| Command terminator | `\r\n` for text; ESC commands are raw, no terminator |
| Bitmap | 1 bpp, MSB-first, row padded; **0 = black/burn, 1 = white/paper** |
| Short bitmaps | The iOS app uses **BITMAP mode 8**: 4 bpp, two dots/byte (high nibble first), payload `width_bytes × height × 4`, `0x0` black / `0xF` white. |
| Checksum | none on the bitmap |

## Commands

Text commands (ASCII, `\r\n` terminated, case-insensitive, prefix match):

```
SIZE 54 mm,50 mm          label width across head, length along feed
GAP 0 mm,0 mm             gap between labels
DIRECTION 0,0             direction, mirror
DENSITY 15                darkness 1..15
CLS                       clear image buffer
BITMAP x,y,wbytes,h,mode,<raw>   raster, mode 1 = OR
PRINT 1                   print N copies (executes the job)
SELFTEST                  built-in test page
INITIALPRINTER            factory reset
TIMER <0x00..0x03>        auto-off: never/15/30/60 min (raw byte)
BEEP <0x00|0x01>          beep (raw byte)
```

Queries / status:

| Send | Reply |
|---|---|
| `CONFIG?\r\n` | `CONFIG ` + 10 bytes + `\r\n` (`dpi`, hw ver, fw ver, timer, beep) |
| `BATTERY?\r\n` | `BATTERY ` + 2 bytes + `\r\n` (BCD %, charging flag) |
| `ESC ! ?` (`1b 21 3f`) | 1 raw status byte (`00` ready) |
| `ESC ! o` (`1b 21 6f`) | 16-byte NFC roll block |

Status byte: `00` ready · `01` lid open · `02` feeding · `03` paper error ·
`04` no paper · `10` paused · `20` busy · `30` low battery · `80` overheated.

### Roll tag (this unit)

```
00 0C 01 22 03 00 03 00 00 12 15 32 0F 36 4A CF
                     ^^          ^^ ^^ ^^ ^^
                     |           |  |  |  CRC16/MODBUS
                     |           |  |  label width 54 mm
                     |           |  usable width field
                     |           label length 50 mm
                     paper type 0 = continuous
```

Same 16-byte layout as the P21. The printer reads the tag but **does not require
it** — third-party / tag-less rolls print fine. The "genuine roll" DRM is in the
mobile app, not the firmware.

## Usage

```bash
# Use the distro Python: the conda python has no AF_BLUETOOTH
/usr/bin/python3 pm270.py status
/usr/bin/python3 pm270.py config
/usr/bin/python3 pm270.py battery
/usr/bin/python3 pm270.py tag
/usr/bin/python3 pm270.py selftest
/usr/bin/python3 pm270.py print-image test.png --width-mm 54 --density 15
/usr/bin/python3 pm270.py print-image label.png --short   # exact 13 mm+, mode 8
/usr/bin/python3 pm270.py raw "1b213f0d0a"
```

Only one SPP connection is allowed at a time. If you get `Device or resource
busy`, close the previous client, wait a few seconds, or:

```bash
bluetoothctl disconnect 6D:62:CD:C2:E4:1A
```

## Print-job shape (important)

This is the **>=50 mm** path. For exact labels under 50 mm, use the mode-8
short-label shape below.

Use the **roll tag's segment length** for `SIZE` — `50 mm` on the stock PM270
roll — even if the artwork is shorter. A `SIZE ...20 mm` job plus an `OFFSET`
made this unit feed/print continuously until it was powered off. The known-good
shape is:

```
\r\n
SIZE 54 mm,50 mm
GAP 0 mm,0 mm
DIRECTION 0,0
DENSITY 15
CLS
BITMAP 0,0,48,400,1,<19200 bytes>
PRINT 1
```

### Fixed 50 mm CLI path

`pm270.py print-image` places the artwork on a 384×400 (54×50 mm) canvas.
Calibration on this unit: about 35–40 mm is visible past the tear bar, so the
CLI caps content at 30 mm. `--feed-margin-mm` positions it: 10 mm is tight
(the last line sits at the tear bar), 20 mm leaves ~10 mm of spare white.

### Designer auto-length

The browser designer no longer rounds to 5 mm. It uses the content bounding box
in dots and derives both values from the **same** number:

```
length_dots = max(400, ceil(content_bottom + extra_margin_dots))
length_mm   = length_dots * 25.4 / 203
SIZE 54 mm,<length_mm to 3 decimals>
BITMAP 0,0,48,<length_dots>,1,...
```

That matters: an earlier version rounded `SIZE` to 5 mm but rounded the bitmap
height separately. On a 75 mm label that left the bitmap one row short, so the
printer consumed the trailing `\r\nPRINT 1\r\n` as pixels and printed a black
bar at the bottom. Using one dot count for both removes the mismatch.

The extra margin defaults to **0** (pure content length). The 400-dot / 50 mm
floor remains because shorter `SIZE` values can make this firmware hunt for a
gap.

### Exact labels: 13 mm+ (captured app job)

The app prints short strips using a different bitmap mode. The captured job is:

```text
SIZE 54 mm,<H> mm
GAP 0,0
DIRECTION 0,0
DENSITY 15
CLS
PRINT 1,1
BITMAP 0,0,48,<rows>,8,<4 bpp payload>
```

- `PRINT` comes **before** `BITMAP`. This is required: the standard TSPL order
  (`PRINT` after the bitmap) produced a ~0.5 in black bar during feed-out on
  this unit.
- `GAP 0,0` has no `mm` suffix.
- `BITMAP` mode **8** is 4 bits per dot: two dots per byte, the left dot in
  the high nibble, `0x0` = black and `0xF` = white. Payload length is
  `width_bytes × rows × 4` (48 × rows × 4 on the PM270).
- `SIZE` and the bitmap height must come from the same dot count. The designer
  rounds the length up to a whole millimetre (8 dots) and derives both from it.
- **Minimum 13 mm (104 dots / 0.5 in).** Below that the firmware feeds an
  extra ~0.5 in after the image with the head still on, which prints a black
  bar. The app's captured 11 mm job is below this limit and can show the bar;
  the scripts pad shorter artwork up to 13 mm with white rows.
- **No upper cap.** The app's captured 52 mm job is a single 421-row mode-8
  strip (80.8 KB) and prints fine; the designer sends one exact job at any
  length. The last two dot rows are forced white so a dark bottom edge cannot
  burn a bar during feed-out.

The designer always uses this shape. The CLI equivalent is:

```bash
/usr/bin/python3 pm270.py print-image label.png --short
```

`--short` scales the artwork into 384 dots (48 mm) and pads to at least 13 mm;
there is no upper length cap. The tear bar is 35–40 mm from the head, so a
short label may still need one press of Feed.

A safe alternative for many small labels is still to pack several short labels
into one 50 mm strip, then cut between them.

### Repeating short labels

The **Repeat** panel does that packing explicitly:

- **Copies per strip** — how many copies to tile vertically.
- **Gap between copies** — white space between them.
- **Fit to 50 mm** — sets the largest whole number of copies that fits in 50 mm.

The designer draws the copies into one strip, then sends a single `SIZE` equal to
the strip length with a bitmap that fills it. That avoids the firmware's own
tiling (which repeats the bitmap to fill its 50 mm minimum). Edit the **top
copy**; the copies below are previews and move automatically. For example, a
20 mm design with a 2 mm gap fits 2 copies in a 50 mm strip; 3 copies make a
64 mm strip.

Do not use `OFFSET` on this firmware. A `SIZE 54 mm,20 mm` job plus `OFFSET`
fed continuously until power-off.


Do **not** poll `ESC ! ?` while a job is printing either. The reference client
sends the job and waits; status queries injected mid-stream can confuse the
printer.

The printer does not require the NFC roll tag. If `ESC ! o` returns all zeros
(no tag readable), it still prints; keep `SIZE` at least 50 mm unless you are
using the short job shape above.

## Web Serial (direct SPP) — primary

Browsers cannot open RFCOMM with **Web Bluetooth**, but Chrome/Edge 117+ on
desktop and Chrome Android 138+ expose Bluetooth Classic SPP through **Web
Serial**. That is the primary path used by `web/designer.html`:

```js
const port = await navigator.serial.requestPort({
  allowedBluetoothServiceClassIds: ["00001101-0000-1000-8000-00805f9b34fb"],
  filters: [{ bluetoothServiceClassId: "00001101-0000-1000-8000-00805f9b34fb" }],
});
await port.open({ baudRate: 9600 });   // baud is ignored for RFCOMM but required
const writer = port.writable.getWriter();
await writer.write(job);                // same TSPL bytes as SPP
const reader = port.readable.getReader(); // replies / status
```

Requirements:

1. **Pair the PM270 in the OS first.** Web Serial cannot scan for unbonded
   Classic devices. On Linux it is already bonded as `6D:62:CD:C2:E4:1A`.
2. **Secure context:** HTTPS or `http://localhost`. The GitHub Pages build is
   HTTPS, so it qualifies. A LAN address such as `http://192.168.4.130:8000`
   is *not* a secure context, so Web Serial is unavailable there.
3. **One SPP link at a time.** Close the Nelko app or any other client before
   clicking Connect.
4. The picker filters on the SPP service class ID. If the printer does not
   appear, use **Show all ports** in the designer, or make sure the OS has
   finished pairing.

`navigator.serial` is absent in Firefox and Safari (including iOS), so the
designer only prints from Chromium browsers. It is a static page: there is no
server or HTTP API involved.

## Using the designer

The live copy is <https://regularpooria.github.io/pm270-designer/>. To run it
locally, serve `web/` with any static server (`python3 -m http.server`) and open
`designer.html`.

1. Open the page in Chrome/Edge. On desktop, Chrome 117+; on Android, a recent
   Chrome with RFCOMM support.
2. Pair the PM270 in the OS first.
3. Click **Connect printer**, pick `PM270`, then design and press **Print**.

Features: text, boxes, lines, images, Code128/Code39/EAN/UPC/ITF barcodes, QR
codes, drag/resize, layer ordering, undo/redo, template save/load, and
**automatic label length** (exact content height in dots, plus an optional extra
margin). Printing always uses the app-compatible **mode 8 / 4 bpp** job with
`PRINT` before `BITMAP`, as one job with no upper length cap. Enable **Dither
photos** for grayscale images; leave it off for crisp text and barcodes.

The editor canvas is 1:1 dots (384 wide) and scales down to fit the screen; the
red dashed line marks the bottom margin. Only the objects print — guides and
selection handles are excluded.


## Python API

`pm270.py` is the programming API. It owns the SPP link and can also build job
bytes without touching hardware.

```bash
python3 -m pip install -e .        # installs the pm270 module + Pillow
```

```python
from pm270 import PM270, build_image_job
from PIL import Image

img = Image.open("label.png")

# Build the bytes, no printer required:
job = build_image_job(img, short=True)      # exact 13-50 mm, mode 8
normal = build_image_job(img, label_length_mm=50)  # classic 1 bpp, 50 mm

# Send it:
with PM270() as p:
    print(p.status())                       # 0 = ready
    print(p.battery())
    p.print_image("label.png", short=True)  # build + send in one call
    p.print_job(job)                        # send pre-built bytes
```

The public surface is `PM270`, `build_image_job`, `build_short_job`,
`pack_4bpp`, and `job_length_mm`. `build_image_job(..., short=True)` enforces
the 13 mm minimum and the 50 mm mode-8 maximum; `print_image(..., short=True)`
does the same. Tests are hardware-free:

```bash
python3 -m pytest -q
```

`bridge.py` is an optional local HTTP helper kept for automation. The designer
does not use it.


## How the reverse-engineering was done

This is the repeatable method, in order of speed:

1. **Enumerate the radio.** BLE scan + `bluetoothctl info` showed the name and
   advertised UUIDs. Seeing `1101` (Serial Port) immediately says "Classic SPP".
2. **Connect to RFCOMM channel 1** and probe with the known sibling protocol
   (`ESC ! ?`, `BATTERY?`, `CONFIG?`). It answered — protocol family identified.
3. **Capture the official app** when you need the exact print job / handshake:
   - Android: Developer options → *Enable Bluetooth HCI snoop log* → reproduce a
     print → *Take bug report* / `adb bugreport` → unzip and open
     `btsnoop_hci.log` in Wireshark (`btatt` / `btrfcomm` filters).
   - iPhone: install Apple's Bluetooth logging profile, then capture over USB on
     Linux with `pymobiledevice3 btlogger -f pcapng pm270.pcapng`. The iOS app
     uses BLE, so filter `btatt` (writes go to handle `0x0006`, replies to
     `0x0008`). The captured job shape is in the short-label section above.
   - Or decompile the APK (`jadx`) and grep for `BITMAP`, `SIZE `, `ff02`,
     `TSPL`, `0x1b 0x21`.
4. **Diff jobs.** Print the same image at different density / length and diff
   the byte streams. The bitmap payload changes with the image; the ASCII header
   changes with settings. This maps every field without guessing.
5. **Replay from scratch.** Send a minimal `SIZE/GAP/DENSITY/CLS/BITMAP/PRINT`
   job you built yourself. If it prints, the protocol is yours.
6. **Probe unknown commands** one at a time and watch the reply / status byte.
   Unrecognised text commands are usually ignored (or `ERROR0`).

## Files

```
pm270.py                     Python API + SPP client + CLI
pyproject.toml               pip-installable module metadata
tests/test_api.py            hardware-free API tests
bridge.py                    optional local HTTP helper (designer does not use it)
web/designer.html            standalone label designer
web/designer.css             designer styles
web/designer.js              canvas editor, auto-length, Web Serial, exact jobs
web/vendor/                  JsBarcode (MIT) + qrcode-generator (MIT)
web/app.html                 legacy bridge-backed print UI
web/index.html               standalone BLE probe
.github/workflows/pages.yml  GitHub Pages deploy
test.png                     generated 384x400 test label
```

## GitHub Pages

The live designer is built from this repo by `.github/workflows/pages.yml`:

- `web/designer.html` is copied to `_site/index.html`.
- `designer.css`, `designer.js`, and `web/vendor/` are copied alongside it.
- `actions/deploy-pages` publishes the artifact to
  <https://regularpooria.github.io/pm270-designer/>.

The site is completely static. Web Serial talks to the paired printer from the
browser; no Python process is involved.
