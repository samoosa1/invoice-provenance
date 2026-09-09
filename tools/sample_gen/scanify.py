"""Turn a clean text-layer PDF into what comes back from a scanner or a
phone: rasterised, slightly rotated, blurred, JPEG-compressed, noisy, and
(for the photo variant) perspective-warped with uneven lighting. The result
is an image-only PDF with no text layer, so a text extractor gets nothing
and an OCR path is the only way in.
"""
from __future__ import annotations

import io
import random
from pathlib import Path

import pymupdf
from PIL import Image, ImageEnhance, ImageFilter, ImageOps


def _page_image(pdf: Path, dpi: int) -> Image.Image:
    doc = pymupdf.open(pdf)
    pix = doc[0].get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def flatbed(img: Image.Image, rng: random.Random) -> Image.Image:
    img = img.rotate(rng.uniform(-1.8, 1.8), resample=Image.BICUBIC, expand=False, fillcolor=(255, 255, 255))
    img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.2, 0.6)))
    img = ImageEnhance.Contrast(img).enhance(rng.uniform(0.85, 1.05))
    img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.95, 1.08))
    # salt-and-pepper speckle. Density calibrated to a desk scanner: a few
    # hundred stray dots per page, not thousands (which no OCR survives).
    px = img.load()
    w, h = img.size
    for _ in range(int(w * h * rng.uniform(0.00002, 0.00008))):
        x, y = rng.randrange(w), rng.randrange(h)
        v = 0 if rng.random() < 0.6 else 255
        px[x, y] = (v, v, v)
    if rng.random() < 0.5:
        img = ImageOps.grayscale(img).convert("RGB")
    return img


def phone(img: Image.Image, rng: random.Random) -> Image.Image:
    w, h = img.size
    pad = int(w * 0.08)
    canvas = Image.new("RGB", (w + 2 * pad, h + 2 * pad), (rng.randint(60, 110),) * 3)
    canvas.paste(img, (pad, pad))
    # perspective: pull the corners in by different amounts
    d = lambda: rng.uniform(0.0, 0.06)
    W, H = canvas.size
    src = [(0, 0), (W, 0), (W, H), (0, H)]
    dst = [(W * d(), H * d()), (W * (1 - d()), H * d()), (W * (1 - d()), H * (1 - d())), (W * d(), H * (1 - d()))]
    coeffs = _perspective_coeffs(dst, src)
    canvas = canvas.transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=(70, 70, 70))
    # uneven lighting: a soft radial gradient multiplied in
    grad = Image.radial_gradient("L").resize((W, H))
    grad = ImageOps.invert(grad).point(lambda p: 150 + p * 105 // 255)
    canvas = Image.composite(canvas, Image.new("RGB", (W, H), (20, 20, 20)), grad)
    canvas = canvas.filter(ImageFilter.GaussianBlur(rng.uniform(0.6, 1.4)))
    return canvas


def _perspective_coeffs(pa, pb):
    import numpy as np
    matrix = []
    for p1, p2 in zip(pa, pb):
        matrix.append([p1[0], p1[1], 1, 0, 0, 0, -p2[0] * p1[0], -p2[0] * p1[1]])
        matrix.append([0, 0, 0, p1[0], p1[1], 1, -p2[1] * p1[0], -p2[1] * p1[1]])
    A = np.array(matrix, dtype=float)
    B = np.array(pb, dtype=float).reshape(8)
    return tuple(np.linalg.solve(A, B))


def scanify(src: Path, out: Path, rng: random.Random, mode: str = "flatbed") -> None:
    dpi = rng.choice([200, 200, 240, 300]) if mode == "flatbed" else rng.choice([120, 150, 180])
    img = _page_image(src, dpi)
    img = flatbed(img, rng) if mode == "flatbed" else phone(img, rng)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=rng.randint(45, 72))
    buf.seek(0)
    doc = pymupdf.open()
    w_pt, h_pt = img.width * 72 / dpi, img.height * 72 / dpi
    page = doc.new_page(width=w_pt, height=h_pt)
    page.insert_image(page.rect, stream=buf.getvalue())
    doc.save(out, deflate=True)
