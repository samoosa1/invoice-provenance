# invoice-provenance

Invoice extraction console with field-level provenance and a persisted review queue.

Drop invoice PDFs. Every extracted value shows the exact pixels it came from. Anything
uncertain goes to a review queue instead of the output. Corrections and every run's
accuracy are saved. Zero silent drops.

**Your documents stay in this browser. Only the values you review are saved.**

Status: day 1 scaffold. Nothing here is usable yet.

## Layout

```
web/    React 19 + TypeScript + Vite. Extraction runs here; PDF bytes never leave the browser.
api/    FastAPI + SQLAlchemy 2. Persists reviewed fields, corrections, run history.
db/     Alembic migrations for PostgreSQL.
infra/  docker-compose.yml, Dockerfiles, optional k8s manifests.
tools/  Synthetic ground-truth generator (extends ledger-reconciler's sample_gen).
```

## Run

```
docker compose -f infra/docker-compose.yml up
```

## Ground truth

The accuracy table is measured against synthetic invoices produced by `tools/make_ground_truth.py`.
That ground truth is external to the extractor but self-authored: the same person wrote the
generator and the extractor. Read the numbers with that in mind.

## License

MIT. Reuses code from [ledger-reconciler](https://github.com/samoosa1/ledger-reconciler) by the same author.
