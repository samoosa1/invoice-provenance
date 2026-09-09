"""The schema holds what the browser sends and nothing that could identify a
document's contents beyond the values a human reviewed."""
import uuid

import pytest
from sqlalchemy import inspect
from sqlalchemy.exc import IntegrityError

from app.models import Correction, CorrectionAction, Document, Field, FieldSource, FieldState, Run, Workspace


def _workspace(session) -> Workspace:
    w = Workspace(name="demo", token_hash=uuid.uuid4().hex)
    session.add(w)
    session.commit()
    return w


def test_six_tables_exist(engine) -> None:
    assert set(inspect(engine).get_table_names()) == {
        "workspaces", "runs", "documents", "fields", "corrections", "accuracy_baselines",
    }


def test_no_column_can_hold_a_document(engine) -> None:
    # The privacy claim on screen is "your documents stay in this browser".
    # A bytes column anywhere in the schema would quietly make that false.
    insp = inspect(engine)
    for table in insp.get_table_names():
        for col in insp.get_columns(table):
            assert "BYTEA" not in str(col["type"]).upper(), f"{table}.{col['name']} could hold a file"


def test_a_field_carries_its_provenance_and_a_correction(session) -> None:
    w = _workspace(session)
    run = Run(workspace_id=w.id, n_documents=1)
    doc = Document(workspace_id=w.id, fingerprint="a" * 64, file_name="00_BF-00885.pdf", page_count=1)
    session.add_all([run, doc])
    session.commit()

    f = Field(workspace_id=w.id, run_id=run.id, document_id=doc.id, name="total", value="2487.16",
              state=FieldState.read, source=FieldSource.text, page=1,
              bbox={"x": 430.2, "y": 592.5, "width": 61.0, "height": 10.5}, confidence=None, candidates=None)
    session.add(f)
    session.commit()
    session.refresh(f)
    assert f.bbox["x"] == pytest.approx(430.2)

    session.add(Correction(workspace_id=w.id, field_id=f.id, action=CorrectionAction.correct, value="2487.61"))
    session.commit()
    session.refresh(f)
    assert [c.value for c in f.corrections] == ["2487.61"]


def test_the_same_file_twice_is_one_document(session) -> None:
    w = _workspace(session)
    print_ = "b" * 64
    session.add(Document(workspace_id=w.id, fingerprint=print_, file_name="01.pdf"))
    session.commit()
    session.add(Document(workspace_id=w.id, fingerprint=print_, file_name="01_copy.pdf"))
    with pytest.raises(IntegrityError):
        session.commit()
