"""What the browser may send. Mirrors the TypeScript `Field`.

The privacy claim on screen is "your documents stay in this browser; only
the values you review are saved". This module is where that claim is
enforced, not the README: every model forbids unknown keys, so a `text`,
`page_text` or base64 payload is a 422, and a field `value` is capped at
512 characters, long enough for any invoice value and too short to smuggle
a page through.
"""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from typing_extensions import Annotated

VALUE_MAX = 512

Value = Annotated[str, StringConstraints(max_length=VALUE_MAX)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BBox(Strict):
    x: float
    y: float
    width: float = Field(ge=0)
    height: float = Field(ge=0)


class CoverageIn(Strict):
    total: int = Field(ge=0)
    read: int = Field(ge=0)
    corrected: int = Field(ge=0)
    uncertain: int = Field(ge=0)
    not_found: int = Field(ge=0)


class FieldIn(Strict):
    name: Annotated[str, StringConstraints(min_length=1, max_length=60)]
    value: Value | None
    state: Literal["read", "uncertain", "not_found"]
    source: Literal["text", "ocr", "human"]
    page: int | None = Field(default=None, ge=1)
    bbox: BBox | None = None
    confidence: float | None = Field(default=None, ge=0, le=100)
    candidates: list[Value] | None = None


class RunIn(Strict):
    n_documents: int = Field(ge=0)
    client_version: Annotated[str, StringConstraints(max_length=40)] | None = None
    coverage: CoverageIn


class DocumentIn(Strict):
    fingerprint: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    file_name: Annotated[str, StringConstraints(min_length=1, max_length=255)]
    page_count: int | None = Field(default=None, ge=0)


class FieldsIn(Strict):
    """One document's fields plus the browser's own coverage line for them.
    The server recounts and refuses the write if the two disagree."""

    document_id: UUID
    coverage: CoverageIn
    fields: list[FieldIn]


class CorrectionIn(Strict):
    """A human's ruling on one field. `accept` takes a candidate the extractor
    offered, `correct` a typed value, `unreadable` nothing: the person could not
    read it either, which is recorded rather than guessed."""

    action: Literal["accept", "correct", "unreadable"]
    value: Value | None = None


class FieldOut(Strict):
    id: UUID
    name: str
    value: str | None
    state: Literal["read", "uncertain", "not_found"]
    source: Literal["text", "ocr", "human"]
    page: int | None
    bbox: BBox | None
    confidence: float | None
    candidates: list[str] | None


class CorrectionOut(Strict):
    field: FieldOut
    run_coverage: CoverageIn


class RunOut(Strict):
    id: UUID
    n_documents: int
    client_version: str | None
    coverage: CoverageIn | None
    field_counts: dict[str, int]
