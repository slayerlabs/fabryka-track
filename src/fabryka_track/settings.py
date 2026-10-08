from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FABRYKA_", env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./fabryka-track.db"
    public_url: str = "https://track.fabryka.ai"
    api_key: str | None = None
    api_url: str = "http://localhost:8000"
    spool_dir: Path = Path("~/.fabryka-track/spool").expanduser()
    artifact_dir: Path = Path("./artifacts")
    dataset_storage_enabled: bool = True
    runner_image: str = "dawidmkrk/dmpod-gpt:1.0"
    runpod_api_key: str | None = None
    runpod_gpu_type: str = "NVIDIA RTX A5000"
    runpod_cloud_type: str = "SECURE"
    runpod_gpu_fallbacks: str = "NVIDIA RTX A4000,NVIDIA RTX 4000 Ada Generation"
    runpod_max_seconds: int = 86400
    runpod_max_hourly_usd: float = 0.50
    runpod_allocation_wait_seconds: int = Field(default=3600, ge=60, le=86400)
    runpod_max_parallel: int = Field(default=50, ge=1, le=500)
    runpod_max_pending: int = Field(default=500, ge=1)
    runpod_max_pending_per_user: int = Field(default=5, ge=1)
    runpod_controller_workers: int = Field(default=16, ge=1, le=64)
    runpod_allowed_users: str = ""
    # Independent, optional stricter cap (e.g. for a single workshop event); unset deployments
    # must not be silently throttled below the tested runpod_max_parallel capacity.
    runpod_max_concurrent: int = Field(default=50, ge=1, le=500)
    runpod_network_volume_id: str = ""
    runpod_volume_mount: str = "/runpod-volume"
    # Public model leaderboard (/models). Rows owned by these accounts may carry Fabryka trust badges;
    # "verified" also needs one of the listed evaluation-harness revisions. Comma-separated; every other
    # row is shown as self-reported whatever its owner declared. Default: the Fabryka account that logs the
    # board rows it measured itself (override with FABRYKA_MODEL_BOARD_TRUSTED_OWNERS; empty trusts nobody).
    model_board_trusted_owners: str = "hf_maggio33"
    model_board_harness_shas: str = ""
    # The owner-only Tiny-ML suite (docs/private-tiny-ml.md) contributes its aggregate EN scores to the
    # public model board's "measured by track" rows only when this is enabled.
    model_board_publish_tiny_ml: bool = False
    white_benchmark_url: str = ""
    benchmark_runner_tokens: str = "{}"
    r2_endpoint: str | None = None
    r2_bucket: str | None = None
    r2_access_key: str | None = None
    r2_secret_key: str | None = None
    pipeline_url: str = "https://data-pipeline.fabryka.ai"
    pipeline_username: str | None = None
    pipeline_password: str | None = None

    @field_validator("pipeline_url")
    @classmethod
    def pipeline_url_uses_https(cls, value: str) -> str:
        # The Track Basic pair travels with every controller call.
        if not value.startswith("https://"):
            raise ValueError("FABRYKA_PIPELINE_URL must start with https://")
        return value


settings = Settings()
