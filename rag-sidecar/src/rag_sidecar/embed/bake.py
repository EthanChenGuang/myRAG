"""Build-time bake for the bge-m3 image target: pinned download, sha256 checks, one offline load (D-26).

    python -m rag_sidecar.embed.bake /opt/models/bge-m3

The only networked step of the image. A mismatch fails the build and leaves no REVISION marker, so the loader refuses
the directory.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

from rag_sidecar.embed.bge_m3 import (
    BGE_M3_DIMS,
    BGE_M3_FILES,
    BGE_M3_MODEL_ID,
    BGE_M3_REVISION,
    BGE_M3_SHA256,
    REVISION_FILE,
    file_sha256,
    load_from_baked_dir,
)

_OFFLINE_CHECK_FLAG = "--offline-check"

Download = Callable[..., Path]
Check = Callable[[Path], None]


class BakeError(SystemExit):
    def __init__(self, message: str) -> None:
        super().__init__(f"[BGE-M3 bake] {message}")


def hub_download(repo_id: str, *, revision: str, filenames: Sequence[str], cache_dir: Path) -> Path:
    from huggingface_hub import snapshot_download

    return Path(
        snapshot_download(repo_id=repo_id, revision=revision, allow_patterns=list(filenames), cache_dir=str(cache_dir))
    )


def offline_check(target: Path) -> None:
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    cmd = [sys.executable, "-m", "rag_sidecar.embed.bake", _OFFLINE_CHECK_FLAG, str(target)]
    done = subprocess.run(cmd, env=env, capture_output=True, text=True, check=False)
    if done.returncode != 0:
        tail = "\n".join((done.stderr or done.stdout or "").strip().splitlines()[-20:])
        raise BakeError(f"offline load exited {done.returncode}: {tail}")


def _offline_check(target: str) -> int:
    vectors = load_from_baked_dir(Path(target), BGE_M3_REVISION).embed(["A short neutral sentence."])
    if len(vectors) != 1 or len(vectors[0]) != BGE_M3_DIMS:
        print("offline check returned an unexpected vector", file=sys.stderr)
        return 1
    return 0


def bake(
    target: Path,
    *,
    download: Download | None = None,
    expected_sha256: Mapping[str, str] | None = None,
    check: Check | None = None,
) -> None:
    download = download or hub_download
    expected = expected_sha256 if expected_sha256 is not None else BGE_M3_SHA256
    check = check or offline_check
    target = Path(target)
    if (target / REVISION_FILE).exists():
        raise BakeError(f"{target} is already baked")
    with tempfile.TemporaryDirectory(prefix="bge-m3-bake-") as scratch:
        snapshot = Path(
            download(BGE_M3_MODEL_ID, revision=BGE_M3_REVISION, filenames=BGE_M3_FILES, cache_dir=Path(scratch))
        )
        for name in BGE_M3_FILES:
            source = snapshot / name
            if not source.is_file():
                raise BakeError(f"{BGE_M3_MODEL_ID}@{BGE_M3_REVISION} is missing {name} after download")
            found = file_sha256(source)
            if found != expected[name]:
                raise BakeError(f"{name} has sha256 {found}, expected {expected[name]}")
        target.mkdir(parents=True, exist_ok=True)
        for name in BGE_M3_FILES:
            shutil.copyfile((snapshot / name).resolve(), target / name)
    for name in BGE_M3_FILES:
        if file_sha256(target / name) != expected[name]:
            raise BakeError(f"{name} changed while copying")
    (target / REVISION_FILE).write_text(BGE_M3_REVISION + "\n", encoding="utf-8")
    try:
        check(target)
    except BaseException:
        (target / REVISION_FILE).unlink(missing_ok=True)
        raise


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == [_OFFLINE_CHECK_FLAG]:
        if len(args) != 2:
            print(f"usage: {_OFFLINE_CHECK_FLAG} <model_dir>", file=sys.stderr)
            return 2
        return _offline_check(args[1])
    if len(args) != 1:
        print("usage: python -m rag_sidecar.embed.bake <model_dir>", file=sys.stderr)
        return 2
    try:
        bake(Path(args[0]))
    except BakeError as error:
        print(error.code, file=sys.stderr)
        return 1
    print(f"[BGE-M3 bake] {BGE_M3_MODEL_ID}@{BGE_M3_REVISION} baked, hash-checked and loaded offline")
    return 0


if __name__ == "__main__":
    sys.exit(main())
