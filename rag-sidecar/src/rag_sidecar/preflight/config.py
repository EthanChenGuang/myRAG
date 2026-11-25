from __future__ import annotations

import json
from pathlib import Path

from pydantic import ValidationError

from rag_sidecar.contracts.ingest import ProcessingProfileSet
from rag_sidecar.contracts.routing import ParseRoutingConfig

ROUTING_FILE = "parse-routing.json"
PROFILES_FILE = "processing-profiles.json"
# <sidecar>/src/rag_sidecar/preflight/config.py: <sidecar> is rag-sidecar/ in a checkout and /app in the image.
_SIDECAR_ROOT = Path(__file__).resolve().parents[3]

_cached: ParseRoutingConfig | None = None
_cached_path: Path | None = None


class RagConfigMissing(FileNotFoundError):
    """Neither the repository's config/rag nor the copy the sidecar image ships holds the file."""


def config_dir_candidates(sidecar_root: Path | None = None) -> list[Path]:
    """The repo-root config/rag of a checkout first, then the copy next to src/ (rag-sidecar/config/rag, /app/config/rag in the image)."""
    root = sidecar_root or _SIDECAR_ROOT
    return [root.parent / "config" / "rag", root / "config" / "rag"]


def resolve_config_file(name: str, sidecar_root: Path | None = None) -> Path:
    candidates = [directory / name for directory in config_dir_candidates(sidecar_root)]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    tried = ", ".join(str(candidate) for candidate in candidates)
    raise RagConfigMissing(
        f"{name} not found (tried {tried}); a checkout reads config/rag/, the sidecar image ships rag-sidecar/config/rag/ as /app/config/rag/"
    )


def default_routing_config_path() -> Path:
    return resolve_config_file(ROUTING_FILE)


def default_processing_profiles_path() -> Path:
    return resolve_config_file(PROFILES_FILE)


def reset_routing_config_cache() -> None:
    global _cached, _cached_path
    _cached = None
    _cached_path = None


def load_routing_config(path: Path | None = None) -> ParseRoutingConfig:
    """Load and validate routing data; memoise the default file per process."""
    global _cached, _cached_path
    if path is None and _cached is not None:
        return _cached
    target = path or default_routing_config_path()
    raw = json.loads(target.read_text(encoding="utf-8"))
    try:
        config = ParseRoutingConfig.model_validate(raw)
    except ValidationError:
        reset_routing_config_cache()
        raise
    if path is None:
        _cached = config
        _cached_path = target
    return config


def load_processing_profiles(path: Path | None = None) -> ProcessingProfileSet:
    target = path or default_processing_profiles_path()
    return ProcessingProfileSet.model_validate(json.loads(target.read_text(encoding="utf-8")))
