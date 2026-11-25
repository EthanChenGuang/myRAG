"""Build-time bake for the hhem image target: pinned downloads, hash checks and one offline load (D-12, P-9)."""

import hashlib
import os
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from rag_sidecar.groundedness.local_hhem import HHEM_MODEL_ID, _hub_cache
from rag_sidecar.settings import DEFAULT_HHEM_MODEL_REVISION, HHEM_MODEL_REVISION_ENV_VAR

FLAN_T5_MODEL_ID = "google/flan-t5-base"
FLAN_T5_REVISION = "7bcac572ce56db69c1ea7c8af255c5d7c9672fc2"
FLAN_T5_FILES = ("config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "spiece.model")
HHEM_FILES = ("config.json", "configuration_hhem_v2.py", "modeling_hhem_v2.py", "model.safetensors")
HHEM_SAFETENSORS_SHA256 = "634de18a38cf1e991c1acd0f7a9e0d30f7ea187fba42bb4798f862d3edd31e72"

# Hashes recorded in 05-05-PACKAGE-VERIFICATION.md. The HHEM config.json is covered by the revision pin only.
PINNED_SHA256: dict[str, dict[str, str]] = {
    FLAN_T5_MODEL_ID: {
        "config.json": "7c1853dbfa0e4aac093eb109a358b6ab25fe86b7c15185a91322f0ed26f0f940",
        "tokenizer.json": "fe2ebbbbde2985be723e0ce18217853e4020c5e9d35bd07be2c27ab9d3ead57a",
        "tokenizer_config.json": "4c55124402e4ce48c7125d04b9af152a125eda9e7c80829f8f99f2ec69f3f68d",
        "special_tokens_map.json": "5c87151ef0f72a99d1f766a4c418bd2a1f90aaa30a8e22fe5eca9641daebb64f",
        "spiece.model": "d60acb128cf7b7f2536e8f38a5b18a05535c9e14c7a355904270e15b0945ea86",
    },
    HHEM_MODEL_ID: {
        "configuration_hhem_v2.py": "ec57fe344e3104d0d4a99b13d893529aac1e2bd69e83c2814235baf37cdcacc7",
        "modeling_hhem_v2.py": "f1fcfd46e85eef7b941efdcc854ad33e914d328126e28206ca965154e64da262",
        "model.safetensors": HHEM_SAFETENSORS_SHA256,
    },
}

_TOKENIZER_DEPENDENCIES = ("sentencepiece", "protobuf")
_OFFLINE_CHECK_FLAG = "--offline-check"

Download = Callable[..., str]
Hasher = Callable[[Path], str]
Loader = Callable[..., Any]


class BakeError(SystemExit):
    def __init__(self, message: str) -> None:
        super().__init__(f"[HHEM bake] {message}")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def hub_download(repo_id: str, *, revision: str, allow_patterns: Sequence[str], cache_dir: Path) -> str:
    from huggingface_hub import snapshot_download

    return snapshot_download(
        repo_id=repo_id,
        revision=revision,
        allow_patterns=list(allow_patterns),
        cache_dir=str(cache_dir),
    )


def offline_load(model_id: str, *, revision: str, trust_remote_code: bool, local_files_only: bool) -> None:
    if not (trust_remote_code and local_files_only):
        raise RuntimeError("the offline check loads with trust_remote_code and local_files_only only")
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    cmd = [sys.executable, "-m", "rag_sidecar.groundedness.bake", _OFFLINE_CHECK_FLAG, model_id, revision]
    done = subprocess.run(cmd, env=env, capture_output=True, text=True, check=False)
    if done.returncode != 0:
        tail = "\n".join((done.stderr or done.stdout or "").strip().splitlines()[-20:])
        raise RuntimeError(f"offline load exited {done.returncode}: {tail}")


def _offline_check(model_id: str, revision: str) -> int:
    from rag_sidecar.groundedness.local_hhem import _default_loader

    model = _default_loader(model_id, revision=revision, trust_remote_code=True, local_files_only=True)
    score = float(model.predict([("The sky is blue.", "The sky is blue.")])[0])
    if not 0.0 <= score <= 1.0:
        print(f"offline check returned an out-of-range score {score}", file=sys.stderr)
        return 1
    return 0


def _repo_dir(cache_dir: Path, repo_id: str) -> Path:
    return cache_dir / ("models--" + repo_id.replace("/", "--"))


def _check_snapshot(repo_id: str, snapshot: Path, expected: str, files: Sequence[str]) -> None:
    if snapshot.name != expected:
        raise BakeError(f"{repo_id} resolved to commit {snapshot.name}, expected the reviewed commit {expected}")
    missing = [name for name in files if not (snapshot / name).is_file()]
    if missing:
        raise BakeError(f"{repo_id}@{expected} is missing {', '.join(missing)} after download")


def _check_hashes(repo_id: str, snapshot: Path, sha256: Hasher) -> None:
    for name, expected in PINNED_SHA256[repo_id].items():
        found = sha256(snapshot / name)
        if found != expected:
            raise BakeError(f"{repo_id}/{name} has sha256 {found}, expected {expected}")


def _missing_tokenizer_dependency(error: BaseException) -> bool:
    text = f"{type(error).__name__}: {error}".lower()
    return any(name in text for name in _TOKENIZER_DEPENDENCIES)


def bake(*, download: Download | None = None, sha256: Hasher | None = None, load: Loader | None = None) -> None:
    download = download or hub_download
    sha256 = sha256 or file_sha256
    load = load or offline_load

    if not (os.environ.get("HF_HOME") or "").strip():
        raise BakeError("HF_HOME must name the baked cache directory")
    revision = (os.environ.get(HHEM_MODEL_REVISION_ENV_VAR) or "").strip() or DEFAULT_HHEM_MODEL_REVISION
    if revision != DEFAULT_HHEM_MODEL_REVISION:
        raise BakeError(
            f"{HHEM_MODEL_REVISION_ENV_VAR}={revision} is not the reviewed revision {DEFAULT_HHEM_MODEL_REVISION}"
        )
    cache_dir = _hub_cache()

    flan = Path(download(FLAN_T5_MODEL_ID, revision="main", allow_patterns=FLAN_T5_FILES, cache_dir=cache_dir))
    _check_snapshot(FLAN_T5_MODEL_ID, flan, FLAN_T5_REVISION, FLAN_T5_FILES)
    main_ref = _repo_dir(cache_dir, FLAN_T5_MODEL_ID) / "refs" / "main"
    resolved_main = main_ref.read_text(encoding="utf-8").strip() if main_ref.is_file() else "<missing>"
    if resolved_main != FLAN_T5_REVISION:
        raise BakeError(
            f"{FLAN_T5_MODEL_ID} refs/main resolves offline to {resolved_main}, expected {FLAN_T5_REVISION}"
        )

    hhem = Path(download(HHEM_MODEL_ID, revision=revision, allow_patterns=HHEM_FILES, cache_dir=cache_dir))
    _check_snapshot(HHEM_MODEL_ID, hhem, revision, HHEM_FILES)

    _check_hashes(FLAN_T5_MODEL_ID, flan, sha256)
    _check_hashes(HHEM_MODEL_ID, hhem, sha256)

    try:
        load(HHEM_MODEL_ID, revision=revision, trust_remote_code=True, local_files_only=True)
    except Exception as error:
        if _missing_tokenizer_dependency(error):
            raise BakeError(
                "the flan-t5-base tokenizer needs a package the hhem extra does not install (sentencepiece or "
                "protobuf). Plan 05-05 approved the extra without it: sentencepiece was rejected by the user "
                "(05-05-PACKAGE-VERIFICATION.md), so do not add it; report the failure for a new decision. "
                f"Loader error: {error}"
            ) from None
        raise BakeError(f"offline load of {HHEM_MODEL_ID}@{revision} failed: {error}") from None


def main(
    argv: Sequence[str] | None = None,
    *,
    download: Download | None = None,
    sha256: Hasher | None = None,
    load: Loader | None = None,
) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == [_OFFLINE_CHECK_FLAG]:
        if len(args) != 3:
            print(f"usage: {_OFFLINE_CHECK_FLAG} <model_id> <revision>", file=sys.stderr)
            return 2
        return _offline_check(args[1], args[2])
    if args:
        print("usage: python -m rag_sidecar.groundedness.bake", file=sys.stderr)
        return 2
    try:
        bake(download=download, sha256=sha256, load=load)
    except BakeError as error:
        print(error.code, file=sys.stderr)
        return 1
    print("[HHEM bake] pinned HHEM and flan-t5-base files baked and loaded offline")
    return 0


if __name__ == "__main__":
    sys.exit(main())
