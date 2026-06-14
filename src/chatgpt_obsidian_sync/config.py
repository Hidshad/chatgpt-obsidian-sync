import json
from pathlib import Path

from pydantic import BaseModel, Field, field_validator


class AppConfig(BaseModel):
    vault_path: Path = Path(r"C:\Path\To\ObsidianVault")
    base_dir: str = "AI/_ChatGPTSyncTest"
    messages_per_part: int = Field(default=10, ge=1)
    server_port: int = Field(default=8765, ge=1, le=65535)
    database_path: Path = Path("sync.db")

    @field_validator("vault_path", "database_path", mode="before")
    @classmethod
    def coerce_path(cls, value):
        return Path(value)

    @field_validator("base_dir")
    @classmethod
    def normalize_base_dir(cls, value: str) -> str:
        cleaned = value.replace("\\", "/").strip("/")
        return cleaned or "AI/_ChatGPTSyncTest"


def load_config(config_path: str | Path = "config.json") -> AppConfig:
    path = Path(config_path)
    if not path.exists():
        return AppConfig()

    data = json.loads(path.read_text(encoding="utf-8"))
    if "database_path" not in data:
        data["database_path"] = path.parent / "sync.db"
    return AppConfig(**data)


def config_to_json_dict(config: AppConfig) -> dict[str, str | int]:
    return {
        "vault_path": str(config.vault_path),
        "base_dir": config.base_dir,
        "messages_per_part": config.messages_per_part,
        "server_port": config.server_port,
    }


def save_config(config: AppConfig, config_path: str | Path = "config.json") -> None:
    path = Path(config_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(config_to_json_dict(config), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
