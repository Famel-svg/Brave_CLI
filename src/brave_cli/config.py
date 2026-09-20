from pathlib import Path
from typing import Annotated, Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration with CLI overrides applied by callers."""

    model_config = SettingsConfigDict(env_prefix="BRAVE_CLI_", env_file=".env", extra="ignore")
    cdp_url: str = "http://127.0.0.1:9222"
    cdp_port: Annotated[int, Field(ge=1, le=65535)] = 9222
    brave_path: str | None = None
    user_data_dir: Path = Path.home() / "AppData" / "Local" / "brave-cli-control" / "profile"
    allowed_domains: list[str] = Field(default_factory=list)
    dry_run: bool = False
    log_level: str = "INFO"
    confirm_timeout_seconds: Annotated[int, Field(ge=1, le=3600)] = 60

    @field_validator("allowed_domains", mode="before")
    @classmethod
    def split_domains(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip().lower() for item in value.split(",") if item.strip()]
        return value


def load_settings(config_file: Path | None = None, **overrides: object) -> Settings:
    values: dict[str, Any] = {}
    if config_file:
        import tomllib

        with config_file.open("rb") as handle:
            values.update(tomllib.load(handle).get("brave_cli", {}))
    values.update({key: value for key, value in overrides.items() if value is not None})
    return Settings(**values)
