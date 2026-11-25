"""Fill the tiktoken cache with cl100k_base so tests never fetch it.

The encoding file is not vendored: it is published by OpenAI without a license of its own. This script downloads it once into
TIKTOKEN_CACHE_DIR (default: <repo>/.cache/tiktoken, git-ignored) under the name tiktoken looks up, after checking the sha256 that
tiktoken itself expects. The sidecar test harness and the sidecar pytest suite read only that cache and refuse to download.

Usage: python scripts/ci/fill-tiktoken-cache.py [--check]
  --check  exit 1 when the cache is missing or wrong instead of downloading.
"""

from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CL100K_URL = "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken"
CL100K_SHA256 = "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7"
CL100K_CACHE_FILE = hashlib.sha1(CL100K_URL.encode()).hexdigest()


def cache_dir() -> Path:
    configured = os.environ.get("TIKTOKEN_CACHE_DIR")
    return Path(configured) if configured else REPO_ROOT / ".cache" / "tiktoken"


def cached_ok(path: Path) -> bool:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest() == CL100K_SHA256
    except OSError:
        return False


def main(argv: list[str]) -> int:
    target = cache_dir() / CL100K_CACHE_FILE
    if cached_ok(target):
        print(f"[tiktoken cache] cl100k_base present in {target.parent}")
        return 0
    if "--check" in argv:
        print(f"[tiktoken cache] cl100k_base missing or wrong in {target.parent}", file=sys.stderr)
        return 1
    with urllib.request.urlopen(CL100K_URL, timeout=60) as response:  # noqa: S310 - fixed https URL
        data = response.read()
    actual = hashlib.sha256(data).hexdigest()
    if actual != CL100K_SHA256:
        print(f"[tiktoken cache] sha256 mismatch: expected {CL100K_SHA256}, got {actual}", file=sys.stderr)
        return 1
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as handle:
        handle.write(data)
    os.replace(handle.name, target)
    print(f"[tiktoken cache] cl100k_base written to {target.parent}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
