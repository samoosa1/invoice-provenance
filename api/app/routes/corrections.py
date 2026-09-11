"""Corrections: the review queue's three actions, persisted.

A correction is appended (the corrections table is the audit trail: never
updated, never deleted) and the field it rules on flips to `source: human`
with the ruled value. The run's stored coverage line is recomputed from
its fields, so the `corrected` bucket grows by one and `read`/`uncertain`/
`not_found` shrinks by one; the four still tie to the total, and
assert_coverage says so before the commit.
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..auth import require_workspace
from ..coverage import assert_coverage, count_buckets
from ..db import get_session
from ..models import Correction, CorrectionAction, Field, FieldSource, Run, Workspace
from ..schemas import BBox, CorrectionIn, CorrectionOut, CoverageIn, FieldOut

router = APIRouter(prefix="/api/fields", tags=["corrections"])


def _field_out(f: Field) -> FieldOut:
    return FieldOut(
        id=f.id,
        name=f.name,
        value=f.value,
        state=f.state.value,
        source=f.source.value,
        page=f.page,
        bbox=BBox(**f.bbox) if f.bbox else None,
        confidence=f.confidence,
        candidates=f.candidates,
    )


@router.post("/{field_id}/corrections", status_code=status.HTTP_201_CREATED)
def add_correction(
    field_id: UUID, body: CorrectionIn, ws: Workspace = Depends(require_workspace), session: Session = Depends(get_session)
) -> CorrectionOut:
    field = session.get(Field, field_id)
    if field is None or field.workspace_id != ws.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="field not found")

    # Each action has exactly one shape; anything else is refused before any write.
    if body.action == "accept":
        if body.value is None or body.value not in (field.candidates or []):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"accept needs one of the field's candidates {field.candidates or []}, got {body.value!r}",
            )
    elif body.action == "correct":
        if body.value is None or body.value.strip() == "":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="correct needs a non-empty value")
    elif body.value is not None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="unreadable carries no value")

    session.add(Correction(workspace_id=ws.id, field_id=field.id, action=CorrectionAction(body.action), value=body.value))
    field.source = FieldSource.human
    field.value = body.value  # None for unreadable: the person could not read it either
    session.flush()

    run = session.get(Run, field.run_id)
    assert run is not None
    counted = count_buckets((f.state.value, f.source.value) for f in run.fields)
    assert_coverage(counted["total"], counted["read"], counted["corrected"], counted["uncertain"], counted["not_found"])
    run.coverage = counted
    session.commit()
    return CorrectionOut(field=_field_out(field), run_coverage=CoverageIn(**counted))
