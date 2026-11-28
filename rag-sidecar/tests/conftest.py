"""Suite-wide guard: tiktoken reads encodings only from TIKTOKEN_CACHE_DIR and never downloads them during tests."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault("TIKTOKEN_CACHE_DIR", str(_REPO_ROOT / ".cache" / "tiktoken"))


@pytest.fixture(autouse=True)
def _no_tiktoken_download(monkeypatch: pytest.MonkeyPatch) -> None:
    try:
        import tiktoken.load as tiktoken_load
    except ImportError:
        return
    original = tiktoken_load.read_file

    def read_file(blobpath: str) -> bytes:
        if "://" in blobpath:
            raise RuntimeError(
                f"tiktoken tried to download {blobpath}; tests read encodings only from TIKTOKEN_CACHE_DIR "
                f"({os.environ.get('TIKTOKEN_CACHE_DIR', '')}). Fill it once with: python3 scripts/ci/fill-tiktoken-cache.py"
            )
        return original(blobpath)

    monkeypatch.setattr(tiktoken_load, "read_file", read_file)
