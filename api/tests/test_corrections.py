"""The three review actions against a real Postgres. Each one must leave an
appended correction row, a field flipped to `human`, and a run coverage
line that still ties with `corrected` grown by one."""
from __future__ import annotations

from sqlalchemy import func, select

from app.models import Correction, Field

from .test_runs import AUTH, COVERAGE_8, client, eight_fields, make_doc, make_run  # noqa: F401  (client fixture)


def write_eight(client, fingerprint: str) -> tuple[str, list[str]]:
    run_id = make_run(client)
    doc_id = make_doc(client, run_id, fingerprint=fingerprint)
    r = client.post(f"/api/runs/{run_id}/fields", json={"document_id": doc_id, "coverage": COVERAGE_8, "fields": eight_fields()}, headers=AUTH)
    assert r.status_code == 201, r.text
    return run_id, r.json()["ids"]


def test_accept_a_candidate_flips_the_field_to_human_and_recounts_the_run(client, session) -> None:
    run_id, ids = write_eight(client, "1" * 64)
    currency_id = ids[4]  # uncertain between USD and AUD
    r = client.post(f"/api/fields/{currency_id}/corrections", json={"action": "accept", "value": "USD"}, headers=AUTH)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["field"]["value"] == "USD" and body["field"]["source"] == "human"
    assert body["run_coverage"] == {"total": 8, "read": 6, "corrected": 1, "uncertain": 0, "not_found": 1}
    assert client.get(f"/api/runs/{run_id}", headers=AUTH).json()["coverage"] == body["run_coverage"]
    assert session.scalar(select(func.count()).select_from(Correction).where(Correction.field_id == currency_id)) == 1


def test_accept_refuses_a_value_that_was_not_a_candidate_and_writes_nothing(client, session) -> None:
    _, ids = write_eight(client, "2" * 64)
    before = session.scalar(select(func.count()).select_from(Correction))
    r = client.post(f"/api/fields/{ids[4]}/corrections", json={"action": "accept", "value": "EUR"}, headers=AUTH)
    assert r.status_code == 422
    assert "candidates" in r.json()["detail"]
    assert session.scalar(select(func.count()).select_from(Correction)) == before
    assert session.get(Field, ids[4]).source.value == "text"


def test_correct_takes_a_typed_value_even_on_a_read_field(client) -> None:
    _, ids = write_eight(client, "3" * 64)
    r = client.post(f"/api/fields/{ids[7]}/corrections", json={"action": "correct", "value": "2487.16"}, headers=AUTH)
    assert r.status_code == 201, r.text
    assert r.json()["field"]["value"] == "2487.16"
    assert r.json()["run_coverage"] == {"total": 8, "read": 5, "corrected": 1, "uncertain": 1, "not_found": 1}
    r = client.post(f"/api/fields/{ids[6]}/corrections", json={"action": "correct", "value": "  "}, headers=AUTH)
    assert r.status_code == 422


def test_unreadable_records_the_ruling_with_no_value(client) -> None:
    _, ids = write_eight(client, "4" * 64)
    r = client.post(f"/api/fields/{ids[3]}/corrections", json={"action": "unreadable"}, headers=AUTH)
    assert r.status_code == 201, r.text
    assert r.json()["field"]["value"] is None and r.json()["field"]["source"] == "human"
    assert r.json()["run_coverage"]["corrected"] == 1 and r.json()["run_coverage"]["not_found"] == 0
    r = client.post(f"/api/fields/{ids[2]}/corrections", json={"action": "unreadable", "value": "x"}, headers=AUTH)
    assert r.status_code == 422


def test_two_corrections_on_one_field_are_both_kept_and_the_last_wins(client, session) -> None:
    _, ids = write_eight(client, "5" * 64)
    client.post(f"/api/fields/{ids[1]}/corrections", json={"action": "correct", "value": "Bluefern Supplies Ltd"}, headers=AUTH)
    r = client.post(f"/api/fields/{ids[1]}/corrections", json={"action": "correct", "value": "Bluefern Supplies Limited"}, headers=AUTH)
    assert r.json()["field"]["value"] == "Bluefern Supplies Limited"
    assert r.json()["run_coverage"]["corrected"] == 1  # one field, however many rulings
    assert session.scalar(select(func.count()).select_from(Correction).where(Correction.field_id == ids[1])) == 2


def test_unknown_field_is_404_and_a_missing_token_401(client) -> None:
    body = {"action": "unreadable"}
    assert client.post("/api/fields/00000000-0000-0000-0000-000000000000/corrections", json=body, headers=AUTH).status_code == 404
    assert client.post("/api/fields/00000000-0000-0000-0000-000000000000/corrections", json=body).status_code == 401
