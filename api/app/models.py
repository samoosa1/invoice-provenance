"""Six tables. `workspace_id` is on every row so multi-tenancy is a later
migration, not a redesign; the demo runs a single workspace behind one token.

What is deliberately NOT here: any column that could hold a PDF. Documents
are identified by a client-side SHA-256 fingerprint only.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Enum, Float, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class FieldState(str, enum.Enum):
    read = "read"
    uncertain = "uncertain"
    not_found = "not_found"


class FieldSource(str, enum.Enum):
    text = "text"
    ocr = "ocr"
    human = "human"


class CorrectionAction(str, enum.Enum):
    accept = "accept"
    correct = "correct"
    unreadable = "unreadable"


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(120))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    n_documents: Mapped[int] = mapped_column(Integer, default=0)
    # {"total": N, "read": a, "corrected": b, "uncertain": c, "not_found": d}; the
    # API refuses the write unless a+b+c+d == total. Same rule as the browser.
    coverage: Mapped[dict | None] = mapped_column(JSON)
    client_version: Mapped[str | None] = mapped_column(String(40))

    fields: Mapped[list[Field]] = relationship(back_populates="run")


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (UniqueConstraint("workspace_id", "fingerprint", name="uq_document_fingerprint"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"), index=True)
    fingerprint: Mapped[str] = mapped_column(String(64))  # SHA-256 hex, computed in the browser
    file_name: Mapped[str] = mapped_column(String(255))
    page_count: Mapped[int | None] = mapped_column(Integer)
    first_seen_run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("runs.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Field(Base):
    __tablename__ = "fields"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"), index=True)
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id"), index=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id"), index=True)
    name: Mapped[str] = mapped_column(String(60))  # invoice_number, vendor, ..., line_item[3].amount
    value: Mapped[str | None] = mapped_column(Text)
    state: Mapped[FieldState] = mapped_column(Enum(FieldState, name="field_state"))
    source: Mapped[FieldSource] = mapped_column(Enum(FieldSource, name="field_source"))
    page: Mapped[int | None] = mapped_column(Integer)
    bbox: Mapped[dict | None] = mapped_column(JSON)  # {"x","y","width","height"} in PDF points, top-left origin
    confidence: Mapped[float | None] = mapped_column(Float)
    candidates: Mapped[list | None] = mapped_column(JSON)  # what an `uncertain` field was torn between

    run: Mapped[Run] = relationship(back_populates="fields")
    corrections: Mapped[list[Correction]] = relationship(back_populates="field")


class Correction(Base):
    __tablename__ = "corrections"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"), index=True)
    field_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("fields.id"), index=True)
    action: Mapped[CorrectionAction] = mapped_column(Enum(CorrectionAction, name="correction_action"))
    value: Mapped[str | None] = mapped_column(Text)  # the typed value for `correct`; null otherwise
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    field: Mapped[Field] = relationship(back_populates="corrections")


class AccuracyBaseline(Base):
    __tablename__ = "accuracy_baselines"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"), index=True)
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    per_field: Mapped[dict] = mapped_column(JSON)  # {field_name: {"precision": p, "recall": r, "reviewed": q}}
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
