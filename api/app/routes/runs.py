"""Runs, documents and fields. Every write that carries a coverage line is
checked with assert_coverage BEFORE anything is written, inside one
transaction, so a 422 leaves zero rows behind.
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import require_workspace
from ..coverage import CoverageError, assert_coverage, count_buckets
from ..db import get_session
from ..models import Document, Field, FieldSource, FieldState, Run, Workspace
from ..schemas import CoverageIn, DocumentIn, FieldsIn, RunIn, RunOut

router = APIRouter(prefix="/api/runs", tags=["runs"])


def _check(cov: CoverageIn) -> None:
    try:
        assert_coverage(cov.total, cov.read, cov.corrected, cov.uncertain, cov.not_found)
    except CoverageError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(e)) from e


def _run(session: Session, ws: Workspace, run_id: UUID) -> Run:
    run = session.get(Run, run_id)
    if run is None or run.workspace_id != ws.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="run not found")
    return run


@router.post("", status_code=status.HTTP_201_CREATED)
def create_run(body: RunIn, ws: Workspace = Depends(require_workspace), session: Session = Depends(get_session)) -> dict[str, str]:
    _check(body.coverage)
    run = Run(workspace_id=ws.id, n_documents=body.n_documents, client_version=body.client_version, coverage=body.coverage.model_dump())
    session.add(run)
    session.commit()
    return {"id": str(run.id)}


@router.post("/{run_id}/documents", status_code=status.HTTP_201_CREATED)
def upsert_document(
    run_id: UUID, body: DocumentIn, ws: Workspace = Depends(require_workspace), session: Session = Depends(get_session)
) -> dict[str, str]:
    run = _run(session, ws, run_id)
    doc = session.scalar(select(Document).where(Document.workspace_id == ws.id, Document.fingerprint == body.fingerprint))
    if doc is None:
        doc = Document(workspace_id=ws.id, fingerprint=body.fingerprint, file_name=body.file_name, page_count=body.page_count, first_seen_run_id=run.id)
        session.add(doc)
        session.commit()
    return {"id": str(doc.id)}


@router.post("/{run_id}/fields", status_code=status.HTTP_201_CREATED)
def add_fields(run_id: UUID, body: FieldsIn, ws: Workspace = Depends(require_workspace), session: Session = Depends(get_session)) -> dict[str, int]:
    run = _run(session, ws, run_id)
    doc = session.get(Document, body.document_id)
    if doc is None or doc.workspace_id != ws.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="document not found")

    # The browser's line must tie on its own, and it must equal what the
    # fields actually say. Both checks run before the first INSERT.
    _check(body.coverage)
    counted = count_buckets((f.state, f.source) for f in body.fields)
    if counted != body.coverage.model_dump():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"coverage line {body.coverage.model_dump()} does not match the fields sent {counted}",
        )

    session.add_all(
        Field(
            workspace_id=ws.id,
            run_id=run.id,
            document_id=doc.id,
            name=f.name,
            value=f.value,
            state=FieldState(f.state),
            source=FieldSource(f.source),
            page=f.page,
            bbox=f.bbox.model_dump() if f.bbox else None,
            confidence=f.confidence,
            candidates=f.candidates,
        )
        for f in body.fields
    )
    session.commit()
    return {"written": len(body.fields)}


@router.get("/{run_id}")
def get_run(run_id: UUID, ws: Workspace = Depends(require_workspace), session: Session = Depends(get_session)) -> RunOut:
    run = _run(session, ws, run_id)
    rows = session.execute(select(Field.state, Field.source, func.count()).where(Field.run_id == run.id).group_by(Field.state, Field.source)).all()
    counts = count_buckets((state.value, source.value) for state, source, n in rows for _ in range(n))
    return RunOut(
        id=run.id,
        n_documents=run.n_documents,
        client_version=run.client_version,
        coverage=CoverageIn(**run.coverage) if run.coverage else None,
        field_counts=counts,
    )
