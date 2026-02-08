from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


ROOT_DIR = Path(__file__).resolve().parents[3]
DEFAULT_BLUEPRINT_SCHEMA_PATH = ROOT_DIR / "docs" / "blueprint_schema.json"


class Section(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    bars: int = Field(ge=1, le=256)
    energy: float | None = Field(default=0.5, ge=0.0, le=1.0)
    prompt: str | None = None


class VoiceSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    voice_id: str = Field(min_length=1)
    model_id: str | None = "eleven_multilingual_v2"
    stability: float | None = Field(default=None, ge=0.0, le=1.0)
    similarity_boost: float | None = Field(default=None, ge=0.0, le=1.0)
    style_exaggeration: float | None = Field(default=None, ge=0.0, le=1.0)
    speaker_boost: bool | None = True


class Blueprint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    style: str = Field(min_length=1, max_length=120)
    tempo_bpm: int = Field(ge=40, le=220)
    key: str = Field(pattern=r"^[A-G](#|b)?m?$")
    time_signature: str | None = Field(default="4/4", pattern=r"^[1-9][0-9]?/[1-9][0-9]?$")
    sections: list[Section] = Field(min_length=1)
    lyrics: str = Field(min_length=1)
    voice: VoiceSettings
    metadata: dict[str, Any] = Field(default_factory=dict)


def load_blueprint_schema(schema_path: Path | None = None) -> dict[str, Any]:
    target = schema_path or DEFAULT_BLUEPRINT_SCHEMA_PATH
    return json.loads(target.read_text(encoding="utf-8"))
