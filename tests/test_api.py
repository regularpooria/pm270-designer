"""Hardware-free tests for the public pm270 Python API."""

from PIL import Image, ImageDraw

import pm270


def _label(w=384, h=88):
    img = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(img)
    d.rectangle([2, 2, w - 3, h - 3], outline=0, width=2)
    d.text((20, 30), "PM270", fill=0)
    return img


def test_short_job_pads_to_13mm_and_uses_app_order():
    job = pm270.build_image_job(_label(), short=True)
    assert b"SIZE 54 mm,13 mm\r\n" in job
    assert b"GAP 0,0\r\n" in job
    assert job.find(b"PRINT 1,1") < job.find(b"BITMAP")
    assert b"BITMAP 0,0,48,104,8," in job
    assert pm270.job_length_mm(job) == 13.0
    # 48 bytes * 104 rows * 4 bpp
    payload = job[job.index(b",8,") + 3:-2]
    assert len(payload) == 48 * 104 * 4


def test_short_job_rejects_tiny_canvas():
    try:
        pm270.build_short_job(Image.new("L", (384, 88), 255), 54)
    except ValueError as e:
        assert "13 mm" in str(e)
    else:
        raise AssertionError("expected ValueError for an 11 mm short job")


def test_exact_job_has_no_upper_cap():
    job = pm270.build_image_job(Image.new("L", (384, 480), 255), short=True)
    assert b"SIZE 54 mm,60 mm\r\n" in job
    assert b"BITMAP 0,0,48,480,8," in job


def test_4bpp_packing_is_high_nibble_first_and_white_high():
    # 8 pixels per row; black, white, black, white, ... in row 0.
    img = Image.new("L", (8, 4), 0)
    for x in (1, 3, 5, 7):
        img.putpixel((x, 0), 255)
    packed = pm270.pack_4bpp(img)
    assert packed[:4] == bytes([0x0F, 0x0F, 0x0F, 0x0F])
    # The feed-out guard forces the bottom two rows white.
    assert packed[-8:] == b"\xff" * 8


def test_long_job_unchanged():
    job = pm270.build_image_job(_label(), label_length_mm=50)
    assert b"SIZE 54 mm,50 mm\r\n" in job
    assert b"BITMAP 0,0,48,400,1," in job
    assert job.rstrip().endswith(b"PRINT 1")
