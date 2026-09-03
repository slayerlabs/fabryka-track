import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, Uuid
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def now():
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    runs: Mapped[list["Run"]] = relationship(back_populates="project")


class Run(Base):
    __tablename__ = "runs"
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
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
