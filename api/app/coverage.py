"""The coverage invariant, server side.

Ported from web/src/domain/coverage.ts, itself ported from docguard's
coverage.py (same author): every field is read, corrected, uncertain or
not_found, nothing else exists, and the four must sum to the number of
fields that went in. The browser already asserts this; the API asserts it
again on write because a browser is not a trusted narrator of its own
totals, and a client who reads "0 unaccounted" must be able to believe it.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Iterable


class CoverageError(ValueError):
    """The buckets do not account for every field."""


def assert_coverage(total: int, read: int, corrected: int, uncertain: int, not_found: int) -> None:
    """read + corrected + uncertain + not_found must equal total, or raise
    CoverageError naming the shortfall. The whole product claim is this line."""
    placed = read + corrected + uncertain + not_found
    if placed != total:
        gap = total - placed
        word = "unaccounted" if gap > 0 else "over-counted"
        raise CoverageError(
            f"coverage does not tie: {total} fields, {read} read + {corrected} corrected + "
            f"{uncertain} uncertain + {not_found} not found = {placed}; {abs(gap)} {word}"
        )


def count_buckets(fields: Iterable[tuple[str, str]]) -> dict[str, int]:
    """Bucket (state, source) pairs the way the browser does: a human-sourced
    value is `corrected` whatever state the extractor left it in."""
    c: Counter[str] = Counter()
    n = 0
    for state, source in fields:
        n += 1
        c["corrected" if source == "human" else state] += 1
    return {
        "total": n,
        "read": c["read"],
        "corrected": c["corrected"],
        "uncertain": c["uncertain"],
        "not_found": c["not_found"],
    }
