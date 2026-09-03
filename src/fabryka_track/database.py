from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from .models import Base
from .settings import settings


connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


def create_tables():
    Base.metadata.create_all(engine)


def session_scope():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
