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
def client():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with TestClient(app) as test_client:
        yield test_client
    Base.metadata.drop_all(engine)
    shutil.rmtree("test-artifacts", ignore_errors=True)


@pytest.fixture(scope="session", autouse=True)
def cleanup_database():
    yield
    engine.dispose()
    Path("test-fabryka.db").unlink(missing_ok=True)
