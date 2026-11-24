from __future__ import annotations

import json
from pathlib import Path

from pydantic import ValidationError

from rag_sidecar.contracts.routing import ParseRoutingConfig

_REPO_ROOT = Path(__file__).resolve().parents[4]
_DEFAULT_PATH = _REPO_ROOT / "config" / "rag" / "parse-routing.json"

_cached: ParseRoutingConfig | None = None
_cached_path: Path | None = None


def default_routing_config_path() -> Path:
    return _DEFAULT_PATH


def reset_routing_config_cache() -> None:
    global _cached, _cached_path
    _cached = None
    _cached_path = None


def load_routing_config(path: Path | None = None) -> ParseRoutingConfig:
    """Load and validate routing data; memoise the default repo file per process."""
    global _cached, _cached_path
    target = path or _DEFAULT_PATH
    if path is None and _cached is not None:
        return _cached
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