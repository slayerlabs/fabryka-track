from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

from .models import Base
from .settings import settings


connect_args = (
    {"check_same_thread": False, "timeout": 30}
    if settings.database_url.startswith("sqlite")
    else {}
)
engine = create_engine(settings.database_url, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


def create_tables():
    Base.metadata.create_all(engine)
    # Additive migration for installations created before accounts existed.
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE IF NOT EXISTS track_migrations (name VARCHAR(100) PRIMARY KEY)"))
        for table in ("runs", "datasets"):
            columns = {c["name"] for c in inspect(connection).get_columns(table)}
            if "owner_id" not in columns:
                connection.execute(text(f"ALTER TABLE {table} ADD COLUMN owner_id VARCHAR(36)"))
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_{table}_owner_id ON {table} (owner_id)"))
            if table == "runs" and "is_public" not in columns:
                connection.execute(text("ALTER TABLE runs ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT TRUE"))
                # Existing leaderboard entries stay visible as unclaimed legacy scores.
                connection.execute(text("UPDATE runs SET is_public = TRUE WHERE owner_id IS NULL"))
        if connection.execute(text("SELECT 1 FROM track_migrations WHERE name='owner-runs-public-v1'")).first() is None:
            # Upgrade existing user-owned runs once. Owners can still unpublish
            # individual runs through the visibility control afterwards.
            connection.execute(text("UPDATE runs SET is_public = TRUE WHERE owner_id IS NOT NULL"))
            connection.execute(text("INSERT INTO track_migrations(name) VALUES ('owner-runs-public-v1')"))

        connection.execute(text("CREATE INDEX IF NOT EXISTS ix_metrics_run_key_id ON metrics (run_id, key, id)"))
        dataset_columns = {c['name'] for c in inspect(connection).get_columns('datasets')}
        if 'source' not in dataset_columns:
            connection.execute(text("ALTER TABLE datasets ADD COLUMN source JSON NOT NULL DEFAULT '{}'"))
        if 'byte_count' not in dataset_columns:
            connection.execute(text('ALTER TABLE datasets ADD COLUMN byte_count INTEGER'))
        byte_length = 'length(CAST(content AS BLOB))' if engine.dialect.name == 'sqlite' else 'octet_length(content)'
        connection.execute(text(f'UPDATE datasets SET byte_count = {byte_length} WHERE byte_count IS NULL'))
        gpu_columns={c['name'] for c in inspect(connection).get_columns('gpu_jobs')}
        for name,definition in {'allocation_deadline':'DATETIME','dispatch_attempts':'INTEGER NOT NULL DEFAULT 0','missing_checks':'INTEGER NOT NULL DEFAULT 0','next_retry_at':'DATETIME'}.items():
            if name not in gpu_columns:connection.execute(text(f'ALTER TABLE gpu_jobs ADD COLUMN {name} {definition}'))
        run_columns={c['name'] for c in inspect(connection).get_columns('runs')}
        if 'parent_run_id' not in run_columns:
            connection.execute(text('ALTER TABLE runs ADD COLUMN parent_run_id VARCHAR(36)'))
        connection.execute(text('CREATE INDEX IF NOT EXISTS ix_runs_parent_run_id ON runs (parent_run_id)'))
        if 'forked_from_checkpoint_id' not in run_columns:
            connection.execute(text('ALTER TABLE runs ADD COLUMN forked_from_checkpoint_id VARCHAR(36)'))
        if 'archived' not in run_columns:
            connection.execute(text('ALTER TABLE runs ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE'))
        connection.execute(text('CREATE INDEX IF NOT EXISTS ix_runs_archived ON runs (archived)'))


def session_scope():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
