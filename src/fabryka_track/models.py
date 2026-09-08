import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, Uuid
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def now():
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Account(Base):
    __tablename__ = "accounts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    api_key_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AccountSession(Base):
    __tablename__ = "account_sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    account_id: Mapped[str] = mapped_column(String(36), ForeignKey("accounts.id"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    runs: Mapped[list["Run"]] = relationship(back_populates="project")


class Run(Base):
    __tablename__ = "runs"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    is_public: Mapped[bool] = mapped_column(default=False)
    project_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String(300), index=True)
    state: Mapped[str] = mapped_column(String(20), default="running", index=True)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    metadata_: Mapped[dict] = mapped_column("metadata", JSON, default=dict)
    note: Mapped[str] = mapped_column(Text, default="")
    conclusion: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    project: Mapped[Project] = relationship(back_populates="runs")
    metrics: Mapped[list["Metric"]] = relationship(cascade="all, delete-orphan")


class Metric(Base):
    __tablename__ = "metrics"
    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("runs.id"), index=True)
    key: Mapped[str] = mapped_column(String(300))
    step: Mapped[int] = mapped_column(BigInteger)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    value: Mapped[float] = mapped_column(Float)
    __table_args__ = (Index("ix_metrics_run_key_step", "run_id", "key", "step"),)


class RunLog(Base):
    __tablename__ = "run_logs"
    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("runs.id"), index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    level: Mapped[str] = mapped_column(String(20), default="info")
    message: Mapped[str] = mapped_column(Text)


class RunAttribute(Base):
    __tablename__ = "run_attributes"
    run_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("runs.id"), primary_key=True)
    path: Mapped[str] = mapped_column(String(300), primary_key=True)
    value: Mapped[object] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class RunArtifactLink(Base):
    __tablename__ = "run_artifact_links"
    run_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("runs.id"), primary_key=True)
    path: Mapped[str] = mapped_column(String(300), primary_key=True)
    artifact_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("artifacts.id"))


class Artifact(Base):
    __tablename__ = "artifacts"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4()))
    run_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("runs.id"), index=True)
    name: Mapped[str] = mapped_column(String(500))
    storage_key: Mapped[str] = mapped_column(String(1000))
    size: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class IngestedEvent(Base):
    __tablename__ = "ingested_events"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    ingested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Dataset(Base):
    __tablename__ = "datasets"
    owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    example: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class GPUJob(Base):
    __tablename__ = "gpu_jobs"
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("runs.id"), primary_key=True)
    pod_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    token_hash: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(32), default="queued")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    heartbeat_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    deadline: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    cleanup_done: Mapped[bool] = mapped_column(default=False)
    files: Mapped[dict] = mapped_column(JSON, default=dict)
    bundle_sha256: Mapped[str] = mapped_column(String(64))
    dispatch_attempts: Mapped[int] = mapped_column(Integer, default=0)
    missing_checks: Mapped[int] = mapped_column(Integer, default=0)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class HuggingFaceIdentity(Base):
    __tablename__ = "huggingface_identities"
    subject: Mapped[str] = mapped_column(String(255), primary_key=True)
    account_id: Mapped[str] = mapped_column(String(36), ForeignKey("accounts.id"), unique=True)
    username: Mapped[str] = mapped_column(String(200))


class OAuthAttempt(Base):
    __tablename__ = "oauth_attempts"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    browser_hash: Mapped[str] = mapped_column(String(64))
    verifier: Mapped[str] = mapped_column(String(128))
    account_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    session_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class HFPublication(Base):
    __tablename__ = "hf_publications"
    run_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("accounts.id"))
    repo_id: Mapped[str] = mapped_column(String(200), unique=True)
    private: Mapped[bool] = mapped_column(default=True)
    status: Mapped[str] = mapped_column(String(32), default="authorizing")
    oauth_state: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    repo_created: Mapped[bool] = mapped_column(default=False)
    commit: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class BenchmarkEvaluation(Base):
    __tablename__ = "benchmark_evaluations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    run_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("runs.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    mode: Mapped[str] = mapped_column(String(20))
    tasks: Mapped[list] = mapped_column(JSON)
    results: Mapped[dict] = mapped_column(JSON, default=dict)
    provenance: Mapped[dict] = mapped_column(JSON, default=dict)
    current_task: Mapped[str | None] = mapped_column(String(100), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
