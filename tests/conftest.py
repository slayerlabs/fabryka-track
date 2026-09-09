import os
import shutil
from pathlib import Path

os.environ["FABRYKA_DATABASE_URL"] = "sqlite:///./test-fabryka.db"
os.environ["FABRYKA_ARTIFACT_DIR"] = "./test-artifacts"

import pytest
from fastapi.testclient import TestClient

from fabryka_track.api import app
from fabryka_track.database import engine
from fabryka_track.models import Base


def sign_in(client, username='tester'):
    """Seed an authenticated HF session; OAuth itself is tested separately."""
    import secrets
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import select
    from fabryka_track.accounts import COOKIE, digest
    from fabryka_track.database import SessionLocal
    from fabryka_track.models import Account, AccountSession, HuggingFaceIdentity
    token = secrets.token_urlsafe(32)
    with SessionLocal() as session:
        user = session.scalar(select(Account).where(Account.username == username))
        if not user:
            user = Account(username=username, password_hash='')
            session.add(user);session.flush()
            session.add(HuggingFaceIdentity(subject='fixture-'+username, account_id=user.id, username=username))
        session.add(AccountSession(id=digest(token), account_id=user.id,
                                   expires_at=datetime.now(timezone.utc)+timedelta(days=14)))
        session.commit()
    client.cookies.set(COOKIE, token, domain="testserver.local", path="/")


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr("fabryka_track.api.start_benchmark_queue",lambda:None)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    from fabryka_track.accounts import _attempts
    _attempts.clear()
    with TestClient(app, headers={"X-Track-Request": "1"}) as test_client:
        sign_in(test_client)
        yield test_client
    Base.metadata.drop_all(engine)
    shutil.rmtree("test-artifacts", ignore_errors=True)


@pytest.fixture(scope="session", autouse=True)
def cleanup_database():
    yield
    engine.dispose()
    Path("test-fabryka.db").unlink(missing_ok=True)
