"""Builds the sample set the accuracy table is measured against: 25 invented
invoices across six layouts, about a third run through a scan simulation,
plus a JSON truth file per invoice with every printed field and line item.

Truth records only what the layout PRINTS, per document rather than per
template: a layout with no due date has `"due_date": null`, and a layout that
prints its tax row only for a non-zero rate has `"tax": null` on a zero-rate
vendor; the correct extractor answer there is `not_found`, and
reporting a date would count as a false positive.

Planted faults (the extractor must flag these, not silently pass):
  line_sum_mismatch   one line's printed amount is off, so lines != subtotal

Self-authored ground truth: the same person wrote this generator and the
extractor. The README says so.

Run with an interpreter that has jinja2, playwright (+chromium), pymupdf,
pillow:  python tools/make_ground_truth.py
"""
from __future__ import annotations

import json
import random
import re
import shutil
import uuid
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta
from pathlib import Path

from sample_gen.render import Renderer
from sample_gen.scanify import scanify
from sample_gen.vendors import BUYER, VENDORS, Vendor

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PDF_OUT = ROOT / "web" / "public" / "sample"
TRUTH_OUT = ROOT / "web" / "tests" / "fixtures" / "ground-truth"
COUNT = 25

rng = random.Random(11)

SIGNERS = ["M. Okafor", "J. Lindqvist", "R. Castellano", "A. Brennan", "S. Whitcombe"]
SITES = ["Head office", "Warehouse B", "Depot 3", "Showroom", "Annex"]

# What each layout prints. Anything False is null in the truth file.
PRINTS = {
    "uk_service.html":        dict(due=True,  subtotal=True,  qty=True, unit=True),
    "us_letter.html":         dict(due=True,  subtotal=True,  qty=True, unit=True),
    "grid_einvoice.html":     dict(due=True,  subtotal=True,  qty=True, unit=True),
    "statement.html":         dict(due=True,  subtotal=True,  qty=True, unit=True),
    "minimal_freelancer.html": dict(due=False, subtotal=False, qty=True, unit=False),
    "thermal_receipt.html":   dict(due=False, subtotal=True,  qty=True, unit=False),
}


# Chromium stamps a wall-clock /CreationDate into every PDF it writes and pymupdf
# stamps a random /ID, so a regenerated sample set differed in all 25 files while
# being content-identical. That churn hides real changes and makes "regenerate,
# then read git status" a useless verification. The accuracy baseline is measured
# against these exact files, so they are frozen instead.
FIXED_PDF_DATE = b"D:20250106000000+00'00'"
_PDF_DATE = re.compile(rb"D:\d{14}\+\d{2}'\d{2}'")
# pymupdf, which writes the scan variants, puts a random pair of 32-hex-digit
# file identifiers in the trailer. Same problem as the dates, same fixed width.
_PDF_ID = re.compile(rb"/ID\s*\[\s*<[0-9A-Fa-f]{32}>\s*<[0-9A-Fa-f]{32}>\s*\]")
_FIXED_ID = b"/ID[<" + b"0" * 32 + b"><" + b"1" * 32 + b">]"


def freeze_pdf_nondeterminism(path: Path) -> None:
    """Both replacements preserve length, so every xref offset stays valid;
    re-serialising through a PDF library would not guarantee that."""
    raw = path.read_bytes()
    frozen = _PDF_DATE.sub(FIXED_PDF_DATE, raw)
    frozen = _PDF_ID.sub(lambda m: _FIXED_ID + b" " * (len(m.group(0)) - len(_FIXED_ID)), frozen)
    assert len(frozen) == len(raw), "replacement changed the file length; xref offsets would break"
    if frozen != raw:
        path.write_bytes(frozen)


@dataclass
class LineTruth:
    description: str
    qty: int | None
    unit_price: float | None
    amount: float


@dataclass
class Truth:
    file: str
    template: str
    scanned: str  # "" | "flatbed" | "phone"
    vendor: str
    invoice_number: str
    invoice_date: str
    due_date: str | None
    currency: str
    subtotal: float | None
    tax: float | None
    total: float
    line_items: list[LineTruth]
    planted: list[str] = field(default_factory=list)


def words(n: float, currency: str) -> str:
    return f"{n:,.2f} {currency}"  # the amount-in-words line is decoration; no template parses it back


def money(fmt: str):
    def f(x: float) -> str:
        s = f"{abs(x):,.2f}"
        if fmt == "eu":
            s = s.replace(",", "X").replace(".", ",").replace("X", ".")
        elif fmt == "plain":
            s = s.replace(",", "")
        return ("-" if x < 0 else "") + s
    return f


def make_lines(v: Vendor, start: date) -> list[dict]:
    n = rng.randint(6, 9) if v.template == "statement.html" else rng.randint(1, 5)
    scale = {"TRY": 40.0, "USD": 1.0, "EUR": 1.0, "GBP": 0.8, "AUD": 1.5}[v.currency]
    lines = []
    for i in range(n):
        qty = rng.choice([1, 1, 1, 2, 3, 4, 6, 10, 12])
        unit = round(rng.uniform(4, 38), 2) if v.template == "thermal_receipt.html" else round(rng.uniform(18, 420) * scale, 2)
        lines.append({"desc": rng.choice(v.services), "qty": qty, "unit": unit, "total": round(qty * unit, 2),
                      "date_str": (start + timedelta(days=i * 3)).strftime(v.date_format), "site": rng.choice(SITES)})
    return lines


def build(v: Vendor, counter: int, d: date, *, fault: str | None) -> tuple[dict, Truth]:
    lines = make_lines(v, d)
    subtotal = round(sum(l["total"] for l in lines), 2)
    if fault == "line_sum_mismatch":
        lines[0]["total"] = round(lines[0]["total"] + rng.choice([10.0, 100.0, -9.0]), 2)  # printed amount now disagrees
    tax = round(subtotal * v.tax_rate, 2)
    total = round(subtotal + tax, 2)
    number = v.numbering.format(n=counter)
    due = d + timedelta(days=rng.choice([14, 30, 30, 45]))
    p = PRINTS[v.template]
    # Printedness is per-DOCUMENT, not per-template: minimal_freelancer.html wraps
    # its tax row in `{% if tax %}`, so a zero-rate vendor there prints no tax
    # label and no tax value. Recording 0.0 anyway would score a correct
    # `not_found` as a miss. Every other layout prints the row unconditionally,
    # including us_letter at 0.00, which is a real printed zero.
    prints_tax = v.tax_rate > 0 or v.template != "minimal_freelancer.html"
    ctx = dict(v=v, buyer=BUYER, number=number, date_str=d.strftime(v.date_format), due_str=due.strftime(v.date_format),
               lines=lines, subtotal=subtotal, tax=tax, total=total, fmt=money(v.number_format), sym=v.symbol,
               credit_note=False, po=(f"PO-{rng.randint(4000, 4999)}" if rng.random() < 0.4 else None),
               uuid=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{v.name}/{number}")), words=words(total, v.currency),
               notes=rng.choice(["Payment within 30 days.", "Thank you for your order.", ""]),
               signer=rng.choice(SIGNERS), time_str=f"{rng.randint(7, 18):02d}:{rng.randint(0, 59):02d}",
               card4=f"{rng.randint(1000, 9999)}", paid_stamp=None,
               brand=rng.choice(["#2b4c7e", "#3d6b4f", "#7a2e2e", "#5a4a8a", "#1f6f78", "#8a5a1f"]))
    truth = Truth(
        file="", template=v.template, scanned="", vendor=v.name, invoice_number=number, invoice_date=d.isoformat(),
        due_date=due.isoformat() if p["due"] else None, currency=v.currency,
        subtotal=subtotal if p["subtotal"] else None, tax=tax if prints_tax else None, total=total,
        line_items=[LineTruth(l["desc"][:20] if v.template == "thermal_receipt.html" else l["desc"],
                              l["qty"] if p["qty"] else None, l["unit"] if p["unit"] else None, l["total"]) for l in lines],
        planted=[fault] if fault else [],
    )
    return ctx, truth


def main() -> None:
    for d in (PDF_OUT, TRUTH_OUT):
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)

    # Every layout at least three times; the remainder spread at random.
    by_template: dict[str, list[Vendor]] = {}
    for v in VENDORS:
        by_template.setdefault(v.template, []).append(v)
    plan: list[Vendor] = []
    for tpl, vs in by_template.items():
        plan += [rng.choice(vs) for _ in range(3)]
    while len(plan) < COUNT:
        plan.append(rng.choice(VENDORS))
    rng.shuffle(plan)

    fault_slots = set(rng.sample(range(COUNT), 3))
    counters = {v.name: rng.randint(100, 900) for v in VENDORS}
    truths: list[Truth] = []
    with Renderer() as r:
        for idx, v in enumerate(plan):
            counters[v.name] += rng.randint(1, 4)
            d = date(2025, 1, 6) + timedelta(days=rng.randint(0, 200))
            ctx, t = build(v, counters[v.name], d, fault="line_sum_mismatch" if idx in fault_slots else None)
            fname = f"{idx:02d}_{ctx['number'].replace('/', '-')}.pdf"
            out = PDF_OUT / fname
            r.render(v.template, ctx, out)
            roll = rng.random()
            scanned = "flatbed" if roll < 0.28 else "phone" if roll < 0.36 else ""
            if scanned:
                tmp = out.with_suffix(".clean.pdf")
                out.rename(tmp)
                scanify(tmp, out, rng, mode=scanned)
                tmp.unlink()
            freeze_pdf_nondeterminism(out)
            t.file, t.scanned = fname, scanned
            truths.append(t)
            (TRUTH_OUT / f"{out.stem}.json").write_text(json.dumps(asdict(t), indent=2, ensure_ascii=False) + "\n")

    index = {"seed": 11, "count": len(truths), "files": [t.file for t in truths],
             "scanned": sum(1 for t in truths if t.scanned), "planted": {t.file: t.planted for t in truths if t.planted}}
    (TRUTH_OUT / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    (PDF_OUT / "index.json").write_text(json.dumps(index["files"]) + "\n")
    print(f"{len(truths)} invoices, {index['scanned']} scanned, {len(index['planted'])} with planted faults -> {PDF_OUT}")


if __name__ == "__main__":
    main()
