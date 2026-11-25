from __future__ import annotations

import json
from pathlib import Path

from pydantic import ValidationError

from rag_sidecar.config_files import RagConfigMissing as RagConfigMissing
from rag_sidecar.config_files import config_dir_candidates as config_dir_candidates
from rag_sidecar.config_files import resolve_config_file
from rag_sidecar.contracts.ingest import ProcessingProfileSet
from rag_sidecar.contracts.routing import ParseRoutingConfig

ROUTING_FILE = "parse-routing.json"
PROFILES_FILE = "processing-profiles.json"

_cached: ParseRoutingConfig | None = None
_cached_path: Path | None = None


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
