"""The routes against a real Postgres. Each failure path asserts by counting
rows, not by reading the response: a 422 that still wrote something would be
the exact silent drop the coverage line exists to prevent."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.db import get_session
from app.main import app
from app.models import Document, Field, Run
from app.settings import Settings, settings

TOKEN = settings.workspace_token
AUTH = {"X-Workspace-Token": TOKEN}

FIELD_NAMES = ["invoice_number", "vendor", "invoice_date", "due_date", "currency", "subtotal", "tax", "total"]


def eight_fields() -> list[dict]:
    fields = [
        {"name": n, "value": f"v-{n}", "state": "read", "source": "text", "page": 1,
         "bbox": {"x": 10.0, "y": 20.0, "width": 30.0, "height": 8.0}, "confidence": None, "candidates": None}
        for n in FIELD_NAMES
    ]
    fields[3] = {**fields[3], "value": None, "state": "not_found", "bbox": None, "page": None}
    fields[4] = {**fields[4], "value": None, "state": "uncertain", "candidates": ["USD", "AUD"]}
    return fields


COVERAGE_8 = {"total": 8, "read": 6, "corrected": 0, "uncertain": 1, "not_found": 1}


@pytest.fixture
def client(engine):
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def override():
        with factory() as s:
            yield s

    app.dependency_overrides[get_session] = override
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def count(session, model) -> int:
    return session.scalar(select(func.count()).select_from(model))


def make_run(client, coverage: dict | None = None) -> str:
    r = client.post("/api/runs", json={"n_documents": 1, "client_version": "test", "coverage": coverage or COVERAGE_8}, headers=AUTH)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def make_doc(client, run_id: str, fingerprint: str = "a" * 64, file_name: str = "00_BF-00885.pdf") -> str:
    r = client.post(f"/api/runs/{run_id}/documents", json={"fingerprint": fingerprint, "file_name": file_name, "page_count": 1}, headers=AUTH)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_health_stays_open_without_a_token(client) -> None:
    assert client.get("/api/health").status_code == 200


def test_401_without_the_token_and_with_a_wrong_one(client) -> None:
    body = {"n_documents": 0, "coverage": {"total": 0, "read": 0, "corrected": 0, "uncertain": 0, "not_found": 0}}
    assert client.post("/api/runs", json=body).status_code == 401
    assert client.post("/api/runs", json=body, headers={"X-Workspace-Token": TOKEN + "x"}).status_code == 401


def test_happy_path_run_document_fields_and_readback(client, session) -> None:
    run_id = make_run(client)
    doc_id = make_doc(client, run_id)
    r = client.post(f"/api/runs/{run_id}/fields", json={"document_id": doc_id, "coverage": COVERAGE_8, "fields": eight_fields()}, headers=AUTH)
    assert r.status_code == 201, r.text
    assert r.json() == {"written": 8}

    r = client.get(f"/api/runs/{run_id}", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["coverage"] == COVERAGE_8
    assert body["field_counts"] == COVERAGE_8  # what was written ties to what was claimed
    assert session.scalar(select(func.count()).select_from(Field).where(Field.run_id == run_id)) == 8


def test_a_field_missing_is_422_with_the_coverage_message_and_zero_rows(client, session) -> None:
    run_id = make_run(client)
    doc_id = make_doc(client, run_id, fingerprint="b" * 64)
    before = count(session, Field)
    seven = eight_fields()[:7]
    # The browser claims eight; the server counts seven. Nothing may land.
    r = client.post(f"/api/runs/{run_id}/fields", json={"document_id": doc_id, "coverage": COVERAGE_8, "fields": seven}, headers=AUTH)
    assert r.status_code == 422, r.text
    assert "does not match the fields sent" in r.json()["detail"]
    assert count(session, Field) == before


def test_a_coverage_line_that_does_not_tie_is_422_before_any_write(client, session) -> None:
    before_runs = count(session, Run)
    r = client.post(
        "/api/runs",
        json={"n_documents": 1, "coverage": {"total": 8, "read": 6, "corrected": 0, "uncertain": 1, "not_found": 0}},
        headers=AUTH,
    )
    assert r.status_code == 422
    assert "1 unaccounted" in r.json()["detail"]
    assert count(session, Run) == before_runs

    run_id = make_run(client)
    doc_id = make_doc(client, run_id, fingerprint="c" * 64)
    before = count(session, Field)
    bad = {"total": 8, "read": 6, "corrected": 0, "uncertain": 1, "not_found": 0}
    r = client.post(f"/api/runs/{run_id}/fields", json={"document_id": doc_id, "coverage": bad, "fields": eight_fields()}, headers=AUTH)
    assert r.status_code == 422
    assert "1 unaccounted" in r.json()["detail"]
    assert count(session, Field) == before


def test_the_same_fingerprint_reuses_the_document_row(client, session) -> None:
    run_a = make_run(client)
    run_b = make_run(client)
    before = count(session, Document)
    id_a = make_doc(client, run_a, fingerprint="d" * 64, file_name="first.pdf")
    id_b = make_doc(client, run_b, fingerprint="d" * 64, file_name="renamed.pdf")
    assert id_a == id_b
    assert count(session, Document) == before + 1


def test_a_value_over_512_chars_is_rejected(client) -> None:
    run_id = make_run(client)
    doc_id = make_doc(client, run_id, fingerprint="e" * 64)
    fields = eight_fields()
    fields[0]["value"] = "x" * 513
    r = client.post(f"/api/runs/{run_id}/fields", json={"document_id": doc_id, "coverage": COVERAGE_8, "fields": fields}, headers=AUTH)
    assert r.status_code == 422


def test_content_bearing_keys_are_refused(client) -> None:
    run_id = make_run(client)
    doc_id = make_doc(client, run_id, fingerprint="f" * 64)
    fields = eight_fields()
    fields[0]["page_text"] = "Bluefern Supplies Ltd, 14 Tanner Row..."
    r = client.post(f"/api/runs/{run_id}/fields", json={"document_id": doc_id, "coverage": COVERAGE_8, "fields": fields}, headers=AUTH)
    assert r.status_code == 422
    r = client.post(f"/api/runs/{run_id}/documents", json={"fingerprint": "0" * 64, "file_name": "x.pdf", "text": "..."}, headers=AUTH)
    assert r.status_code == 422
    r = client.post(f"/api/runs/{run_id}/documents", json={"fingerprint": "not-a-sha", "file_name": "x.pdf"}, headers=AUTH)
    assert r.status_code == 422


def test_settings_refuse_the_default_token_outside_dev() -> None:
    with pytest.raises(ValueError, match="WORKSPACE_TOKEN"):
        Settings(app_env="prod", workspace_token="dev-token-change-me", _env_file=None)
    assert Settings(app_env="dev", workspace_token="dev-token-change-me", _env_file=None).app_env == "dev"
    assert Settings(app_env="prod", workspace_token="s3cret-enough", _env_file=None).workspace_token == "s3cret-enough"
