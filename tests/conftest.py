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


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr("fabryka_track.api.start_benchmark_queue",lambda:None)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    from fabryka_track.accounts import _attempts
    _attempts.clear()
    with TestClient(app, headers={"X-Track-Request": "1"}) as test_client:
        response = test_client.post('/api/auth/register', json={'username': 'tester', 'password': 'testing-password-123'})
        assert response.status_code == 201
        yield test_client
    Base.metadata.drop_all(engine)
    shutil.rmtree("test-artifacts", ignore_errors=True)


@pytest.fixture(scope="session", autouse=True)
def cleanup_database():
    yield
    engine.dispose()
    Path("test-fabryka.db").unlink(missing_ok=True)
