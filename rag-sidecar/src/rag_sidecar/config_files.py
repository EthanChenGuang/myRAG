"""Locating the shared config/rag data files; base install only (no optional extra)."""

from __future__ import annotations

from pathlib import Path

# <sidecar>/src/rag_sidecar/config_files.py: <sidecar> is rag-sidecar/ in a checkout and /app in the image.
_SIDECAR_ROOT = Path(__file__).resolve().parents[2]


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
