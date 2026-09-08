from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FABRYKA_", env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./fabryka-track.db"
    api_key: str | None = None
    api_url: str = "http://localhost:8000"
    spool_dir: Path = Path("~/.fabryka-track/spool").expanduser()
    artifact_dir: Path = Path("./artifacts")
    runner_image: str = "dawidmkrk/dmpod-gpt:1.0"
    r2_endpoint: str | None = None
    r2_bucket: str | None = None
    r2_access_key: str | None = None
    r2_secret_key: str | None = None


settings = Settings()
