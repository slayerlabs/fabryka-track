from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

from .models import Base
from .settings import settings


connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


def create_tables():
    Base.metadata.create_all(engine)
    # Additive migration for installations created before accounts existed.
    with engine.begin() as connection:
        for table in ("runs", "datasets"):
            columns = {c["name"] for c in inspect(connection).get_columns(table)}
            if "owner_id" not in columns:
                connection.execute(text(f"ALTER TABLE {table} ADD COLUMN owner_id VARCHAR(36)"))
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table}_owner_id ON {table} (owner_id)"))
            if table == "runs" and "is_public" not in columns:
                connection.execute(text("ALTER TABLE runs ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT FALSE"))
                # Existing leaderboard entries stay visible as unclaimed legacy scores.
                connection.execute(text("UPDATE runs SET is_public = TRUE WHERE owner_id IS NULL"))

        gpu_columns={c['name'] for c in inspect(connection).get_columns('gpu_jobs')}
        for name,definition in {'dispatch_attempts':'INTEGER NOT NULL DEFAULT 0','missing_checks':'INTEGER NOT NULL DEFAULT 0','next_retry_at':'DATETIME'}.items():
            if name not in gpu_columns:connection.execute(text(f'ALTER TABLE gpu_jobs ADD COLUMN {name} {definition}'))


def session_scope():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
