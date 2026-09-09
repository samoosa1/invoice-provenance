import os

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.models import Base

# Point at a real Postgres, not SQLite: the schema uses native ENUM and JSON
# types, and a SQLite stand-in would pass tests the real database fails.
DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+psycopg://postgres:postgres@127.0.0.1:5432/invoice_provenance_test",
)


@pytest.fixture(scope="session")
def engine():
    admin_url = DATABASE_URL.rsplit("/", 1)[0] + "/postgres"
    db_name = DATABASE_URL.rsplit("/", 1)[1]
    admin = create_engine(admin_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'DROP DATABASE IF EXISTS "{db_name}"'))
        c.execute(text(f'CREATE DATABASE "{db_name}"'))
    admin.dispose()

    eng = create_engine(DATABASE_URL)
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def session(engine):
    with sessionmaker(bind=engine)() as s:
        yield s
        s.rollback()
