"""EXTERNAL ORACLE for text-position extraction.

Emits every word box in every clean sample invoice, as measured by PyMuPDF
(MuPDF's own text layer implementation), to
`web/tests/fixtures/oracle-word-boxes.json`.

Why this exists: every other expectation in this repo descends from code in this
repo, so a consistent-but-wrong coordinate conversion would pass its own tests.
PyMuPDF is a different library by different authors reading the same PDF, which
makes it the one check on `lib/pdf.ts` that is not derived from `lib/pdf.ts`.

Coordinates: PDF points, origin at the page's TOP-LEFT, y growing downward.
That is PyMuPDF's native convention and the one `lib/pdf.ts` converts into, so
the two are directly comparable with no transform in the test.

Regenerate ONLY when the sample PDFs themselves change. The output is committed
and a test compares against it; regenerating it to make a failing test pass
would destroy the only external check in the project.
"""
from __future__ import annotations

import json
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
PDFS = ROOT / "web" / "public" / "sample"
TRUTH = ROOT / "web" / "tests" / "fixtures" / "ground-truth"
OUT = ROOT / "web" / "tests" / "fixtures" / "oracle-word-boxes.json"


def main() -> None:
    scanned = {
        t["file"]
        for f in TRUTH.glob("*.json")
        if f.name != "index.json"
        for t in [json.loads(f.read_text())]
        if t["scanned"]
    }

    docs = {}
    for pdf in sorted(PDFS.glob("*.pdf")):
        if pdf.name in scanned:
            continue  # no text layer by design; the OCR path is measured separately
        with pymupdf.open(pdf) as doc:
            pages = []
            for page in doc:
                words = [
                    {"text": w[4], "x0": round(w[0], 2), "y0": round(w[1], 2),
                     "x1": round(w[2], 2), "y1": round(w[3], 2)}
                    for w in page.get_text("words")
                ]
                pages.append({
                    "page": page.number + 1,
                    "width": round(page.rect.width, 2),
                    "height": round(page.rect.height, 2),
                    "words": words,
                })
            docs[pdf.name] = pages

    OUT.write_text(json.dumps(
        {"producer": f"PyMuPDF {pymupdf.__doc__.strip().splitlines()[0] if pymupdf.__doc__ else ''}".strip(),
         "origin": "top-left, PDF points",
         "documents": docs}, indent=1) + "\n")
    n = sum(len(p["words"]) for pages in docs.values() for p in pages)
    print(f"{len(docs)} documents, {n} word boxes -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

# Calibration measured 10.09.2026 against lib/pdf.ts as of commit 2b551b0, by
# centre-containment matching of all 1996 oracle words:
#   located 1996 / 1996 (0 missing)   page dimensions agree exactly (0.00)
#   |y0 diff| p50 1.96  p95 2.41  p99 3.45  max 5.04
#   |y1 diff| p50 2.18  p95 3.00  p99 3.90  max 5.70
#   |x0 diff| p50 0.00  p95 157.77  p99 234.61  max 274.28
# The vertical spread is expected: pdf.js reports a font-height box per text RUN,
# PyMuPDF a tight glyph box per WORD. The horizontal spread is the whole reason
# character spans exist; a run's x0 is nowhere near a word late in that run.
# Tolerances in tests/oracle.spans.test.ts derive from these numbers.
