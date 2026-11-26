"""python -m rag_eval.finetune kit: a test-free training kit from a mined bundle (FT-07; D-10, D-16).

`kit --bundle <run> --out <kitdir> [--model <base id>]` copies train_ntuple.jsonl, train_pairs.jsonl and dev.jsonl, writes
dev_corpus.jsonl (the chunks the dev InformationRetrievalEvaluator searches: every dev-split chunk of a tenant with dev pairs, plus the positives and
negatives of the dev pairs), training-config.json (the resolved TrainingRunConfig) and kit-manifest.json (tenant keys,
base model with its prompts, example counts and the sha256 of every file). Test files and chunks of test-split documents
never enter a kit: a train or dev row that is in the test split, or whose positive or a negative is a chunk of a test-split
document, refuses the whole kit (bundle_contains_test).

`verify_kit` is the check `train` runs first: a file with "test" in its name or any row with split test refuses with
kit_contains_test (scanned before the hashes, so the reason is always named), then unlisted files, missing files, hashes
that differ from the kit manifest and rows that do not validate.

Library versions are those pinned by eval/finetune/requirements-train.lock (the training image); `train` refuses a host
whose installed versions differ. Stdout and stderr carry ids, counts and codes only (D-31).
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from rag_sidecar.contracts.finetune import (
    BaseModelSpec,
    BundleFile,
    Count,
    DatasetPurpose,
    ExportedChunk,
    FinetuneConfig,
    FinetunePair,
    FinetuneSplit,
    LibraryVersions,
    ObjectId,
    RunId,
    Sha256,
    TenantKey,
    Timestamp,
    TrainingRunConfig,
)

from rag_eval.finetune import bundle
from rag_eval.finetune.config import load_finetune_config
from rag_eval.finetune.miner import DEV_FILE, TRAIN_NTUPLE_FILE, TRAIN_PAIRS_FILE
from rag_eval.paths import REPO_ROOT

KIT_MANIFEST_FILE = "kit-manifest.json"
TRAINING_CONFIG_FILE = "training-config.json"
DEV_CORPUS_FILE = "dev_corpus.jsonl"
PAIR_FILES: dict[str, FinetuneSplit] = {TRAIN_NTUPLE_FILE: "train", TRAIN_PAIRS_FILE: "train", DEV_FILE: "dev"}
KIT_FILES = (*PAIR_FILES, DEV_CORPUS_FILE, TRAINING_CONFIG_FILE)
TRAIN_LOCK = REPO_ROOT / "eval" / "finetune" / "requirements-train.lock"
LOCK_PACKAGES = {
    "torch": "torch",
    "transformers": "transformers",
    "sentence_transformers": "sentence-transformers",
    "datasets": "datasets",
}
_GIT_COMMIT = re.compile(r"^[a-f0-9]{7,40}$")

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2


class KitRefused(Exception):
    def __init__(self, code: str, exit_code: int = EXIT_FAILED, hint: str | None = None):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code
        self.hint = hint

    def message(self) -> str:
        return f"{self.code}: {self.hint}" if self.hint else self.code


class KitCorpusChunk(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    tenant_key: TenantKey
    chunk_id: ObjectId
    split: FinetuneSplit
    text: str = Field(min_length=1)

    @field_validator("split")
    @classmethod
    def _not_test(cls, value: str) -> str:
        if value == "test":
            raise ValueError("a kit corpus chunk cannot be in the test split")
        return value


class KitManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kit_version: Literal[1] = 1
    run_id: RunId
    purpose: DatasetPurpose
    split_rule: Literal["ft-sha256-first8hex-mod100-80-10-10"]
    tenant_keys: list[TenantKey] = Field(min_length=1)
    base_model: BaseModelSpec
    dataset_manifest_sha256: Sha256
    counts: dict[Literal["ntuple", "pairs", "dev", "dev_corpus"], Count]
    files: dict[BundleFile, Sha256]
    created_at: Timestamp


def _canonical(payload: object) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def config_sha256(config: FinetuneConfig) -> str:
    return hashlib.sha256(_canonical(config.model_dump(mode="json"))).hexdigest()


def git_head() -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, check=False, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = result.stdout.strip()
    return value if result.returncode == 0 and _GIT_COMMIT.fullmatch(value) else None


def lock_versions(lock: Path = TRAIN_LOCK) -> dict[str, str]:
    """The four training libraries as pinned by requirements-train.lock (local version suffixes kept)."""
    try:
        text = Path(lock).read_text(encoding="utf-8")
    except OSError:
        raise KitRefused("train_lock_missing", EXIT_USAGE) from None
    pins: dict[str, str] = {}
    for line in text.splitlines():
        match = re.match(r"^([A-Za-z0-9._-]+)==([^\s\\;]+)", line.strip())
        if match:
            pins[match.group(1).lower().replace("_", "-")] = match.group(2)
    try:
        return {field: pins[name] for field, name in LOCK_PACKAGES.items()}
    except KeyError:
        raise KitRefused("train_lock_incomplete", EXIT_USAGE) from None


def _row_split(line: str) -> object:
    try:
        row = json.loads(line)
    except ValueError:
        return None
    return row.get("split") if isinstance(row, dict) else None


def _check_bundle_file(run_dir: Path, name: str, recorded: Mapping[str, str]) -> None:
    path = run_dir / name
    if not path.is_file():
        raise KitRefused("mining_outputs_missing", EXIT_USAGE, "run mine first")
    if recorded.get(name) != bundle.sha256_file(path):
        raise KitRefused("bundle_modified")


def _load_pairs(run_dir: Path, name: str, split: str, chunks: Mapping[tuple[str, str], ExportedChunk]) -> list[FinetunePair]:
    path = run_dir / name
    if any(_row_split(line) == "test" for line in path.read_text(encoding="utf-8").splitlines() if line.strip()):
        raise KitRefused("bundle_contains_test")
    try:
        rows = bundle.read_jsonl(path, FinetunePair)
    except ValueError:
        raise KitRefused("rows_invalid") from None
    for pair in rows:
        if pair.split != split:
            raise KitRefused("rows_split_mismatch")
        for chunk_id in (pair.positive_chunk_id, *(n.chunk_id for n in pair.negatives)):
            chunk = chunks.get((pair.tenant_key, chunk_id))
            if chunk is None:
                raise KitRefused("rows_unknown_chunk")
            if chunk.split == "test":
                raise KitRefused("bundle_contains_test")
    return rows


def _expanded(rows: Sequence[FinetunePair]) -> int:
    return sum(pair.weight for pair in rows)


def _dev_corpus(dev: Sequence[FinetunePair], chunks: Sequence[ExportedChunk]) -> list[KitCorpusChunk]:
    tenants = {pair.tenant_key for pair in dev}
    wanted = {(c.tenant_key, c.chunk_id) for c in chunks if c.split == "dev" and c.tenant_key in tenants}
    for pair in dev:
        wanted.add((pair.tenant_key, pair.positive_chunk_id))
        wanted.update((pair.tenant_key, n.chunk_id) for n in pair.negatives)
    out = [
        KitCorpusChunk(tenant_key=c.tenant_key, chunk_id=c.chunk_id, split=c.split, text=c.text)
        for c in chunks
        if (c.tenant_key, c.chunk_id) in wanted and c.split != "test"
    ]
    return sorted(out, key=lambda c: (c.tenant_key, c.chunk_id))


def _base_model(config: FinetuneConfig, model: str | None) -> BaseModelSpec:
    if model is None:
        return next(m for m in config.base_models if m.default)
    spec = next((m for m in config.base_models if m.id == model), None)
    if spec is None:
        raise KitRefused("base_model_unknown", EXIT_USAGE, "the model must be listed in finetune.json base_models")
    return spec


def _prepare_out(out: Path) -> Path:
    out = Path(out)
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise KitRefused("out_exists", EXIT_USAGE)
    out.parent.mkdir(parents=True, exist_ok=True)
    staging = out.with_name(f".{out.name}.{os.getpid()}.staging")
    shutil.rmtree(staging, ignore_errors=True)
    os.mkdir(staging, 0o700)
    os.chmod(staging, 0o700)
    return staging


def build_kit(
    run_dir: Path,
    out: Path,
    *,
    base_model: str | None = None,
    config: FinetuneConfig | None = None,
    git_commit: str | None = None,
    library_versions: Mapping[str, str] | None = None,
    now: str | None = None,
) -> Path:
    """Build the kit in a staging directory and move it to `out` (mode 0700) only when every check passed."""
    run_dir = Path(run_dir)
    out = Path(out)
    config = config or load_finetune_config()
    if not (run_dir / bundle.MANIFEST_FILE).is_file() or not (run_dir / bundle.CHUNKS_FILE).is_file():
        raise KitRefused("bundle_not_found", EXIT_USAGE)
    try:
        manifest = bundle.read_manifest(run_dir)
    except (ValueError, OSError):
        raise KitRefused("manifest_invalid") from None
    spec = _base_model(config, base_model)
    for name in (bundle.CHUNKS_FILE, *PAIR_FILES):
        _check_bundle_file(run_dir, name, manifest.files)
    commit = git_commit or git_head()
    if commit is None or not _GIT_COMMIT.fullmatch(commit):
        raise KitRefused("git_commit_unknown", EXIT_USAGE, "build the kit from a git checkout")
    try:
        versions = LibraryVersions.model_validate(dict(library_versions or lock_versions()))
    except ValidationError:
        raise KitRefused("library_versions_invalid", EXIT_USAGE) from None
    try:
        chunks = bundle.read_jsonl(run_dir / bundle.CHUNKS_FILE, ExportedChunk)
    except ValueError:
        raise KitRefused("chunks_invalid") from None
    tenants = set(manifest.tenant_keys)
    if any(c.tenant_key not in tenants for c in chunks):
        raise KitRefused("tenant_mismatch")
    by_key = {(c.tenant_key, c.chunk_id): c for c in chunks}
    pairs = {name: _load_pairs(run_dir, name, split, by_key) for name, split in PAIR_FILES.items()}
    if not pairs[TRAIN_NTUPLE_FILE] and not pairs[TRAIN_PAIRS_FILE]:
        raise KitRefused("no_train_pairs", EXIT_USAGE)
    if not pairs[DEV_FILE]:
        raise KitRefused("no_dev_pairs", EXIT_USAGE, "the dev evaluator needs dev pairs")
    corpus = _dev_corpus(pairs[DEV_FILE], chunks)

    dataset_sha = bundle.sha256_file(run_dir / bundle.MANIFEST_FILE)
    training = TrainingRunConfig(
        run_id=manifest.run_id,
        base_model=spec.id,
        base_revision=spec.revision,
        dataset_manifest_sha256=dataset_sha,
        config_sha256=config_sha256(config),
        seed=config.training.seed,
        git_commit=commit,
        library_versions=versions,
        recipe=config.training,
    )
    staging = _prepare_out(out)
    try:
        files: dict[str, str] = {}
        for name, rows in pairs.items():
            files[name] = bundle.write_jsonl(staging / name, rows, FinetunePair)
        files[DEV_CORPUS_FILE] = bundle.write_jsonl(staging / DEV_CORPUS_FILE, corpus, KitCorpusChunk)
        files[TRAINING_CONFIG_FILE] = bundle._atomic_write(
            staging / TRAINING_CONFIG_FILE, _canonical(training.model_dump(mode="json"))
        )
        kit_manifest = KitManifest(
            run_id=manifest.run_id,
            purpose=manifest.purpose,
            split_rule=manifest.split_rule,
            tenant_keys=sorted({p.tenant_key for rows in pairs.values() for p in rows}),
            base_model=spec,
            dataset_manifest_sha256=dataset_sha,
            counts={
                "ntuple": _expanded(pairs[TRAIN_NTUPLE_FILE]),
                "pairs": _expanded(pairs[TRAIN_PAIRS_FILE]),
                "dev": len(pairs[DEV_FILE]),
                "dev_corpus": len(corpus),
            },
            files=files,
            created_at=now or datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
        bundle._atomic_write(staging / KIT_MANIFEST_FILE, _canonical(kit_manifest.model_dump(mode="json")))
        if out.exists():
            out.rmdir()
        os.replace(staging, out)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return out


def read_kit_manifest(kit_dir: Path) -> KitManifest:
    try:
        return KitManifest.model_validate_json((Path(kit_dir) / KIT_MANIFEST_FILE).read_text(encoding="utf-8"))
    except OSError:
        raise KitRefused("kit_not_found", EXIT_USAGE) from None
    except ValidationError:
        raise KitRefused("kit_manifest_invalid") from None


def _scan_for_test(kit_dir: Path, names: Sequence[str]) -> None:
    for name in names:
        if "test" in name.lower():
            raise KitRefused("kit_contains_test")
    for name in names:
        if name.endswith(".jsonl"):
            for line in (kit_dir / name).read_text(encoding="utf-8").splitlines():
                if line.strip() and _row_split(line) == "test":
                    raise KitRefused("kit_contains_test")


def verify_kit(kit_dir: Path) -> KitManifest:
    """Refuse a kit that holds any test file or row, an unlisted or missing file, or a file whose sha256 differs."""
    kit_dir = Path(kit_dir)
    if not kit_dir.is_dir():
        raise KitRefused("kit_not_found", EXIT_USAGE)
    present = sorted(str(p.relative_to(kit_dir)) for p in kit_dir.rglob("*") if p.is_file())
    _scan_for_test(kit_dir, present)
    manifest = read_kit_manifest(kit_dir)
    expected = set(manifest.files) | {KIT_MANIFEST_FILE}
    if set(present) - expected:
        raise KitRefused("kit_unexpected_file")
    if set(manifest.files) != set(KIT_FILES) or expected - set(present):
        raise KitRefused("kit_incomplete")
    for name, digest in manifest.files.items():
        if bundle.sha256_file(kit_dir / name) != digest:
            raise KitRefused("kit_modified")
    tenants = set(manifest.tenant_keys)
    try:
        for name, split in PAIR_FILES.items():
            for pair in bundle.read_jsonl(kit_dir / name, FinetunePair):
                if pair.split != split or pair.tenant_key not in tenants:
                    raise KitRefused("kit_rows_invalid")
        for chunk in bundle.read_jsonl(kit_dir / DEV_CORPUS_FILE, KitCorpusChunk):
            if chunk.tenant_key not in tenants:
                raise KitRefused("kit_rows_invalid")
        training = read_training_config(kit_dir)
    except ValueError:
        raise KitRefused("kit_rows_invalid") from None
    if training.run_id != manifest.run_id or training.dataset_manifest_sha256 != manifest.dataset_manifest_sha256:
        raise KitRefused("kit_config_mismatch")
    if training.base_model != manifest.base_model.id or training.base_revision != manifest.base_model.revision:
        raise KitRefused("kit_config_mismatch")
    return manifest


def read_training_config(kit_dir: Path) -> TrainingRunConfig:
    return TrainingRunConfig.model_validate_json((Path(kit_dir) / TRAINING_CONFIG_FILE).read_text(encoding="utf-8"))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.finetune kit")
    parser.add_argument("--bundle", required=True, type=Path, help="mined run directory")
    parser.add_argument("--out", required=True, type=Path, help="kit directory (must not exist or be empty)")
    parser.add_argument("--model", default=None, help="base model id from finetune.json (default: the default base)")
    parser.add_argument("--config", type=Path, default=None, help="finetune.json (default eval/config/finetune.json)")
    return parser


def main(
    argv: list[str] | None = None,
    *,
    config: FinetuneConfig | None = None,
    git_commit: str | None = None,
    library_versions: Mapping[str, str] | None = None,
) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return EXIT_USAGE if exc.code else EXIT_OK
    try:
        config = config or load_finetune_config(args.config)
    except (ValueError, OSError):
        print("[Finetune] kit refused: config_invalid", file=sys.stderr)
        return EXIT_USAGE
    try:
        out = build_kit(
            args.bundle,
            args.out,
            base_model=args.model,
            config=config,
            git_commit=git_commit,
            library_versions=library_versions,
        )
        manifest = read_kit_manifest(out)
    except KitRefused as exc:
        print(f"[Finetune] kit refused: {exc.message()}", file=sys.stderr)
        return exc.exit_code
    counts = " ".join(f"{key}={value}" for key, value in sorted(manifest.counts.items()))
    print(f"[Finetune] kit run_id={manifest.run_id} tenants={len(manifest.tenant_keys)} base={manifest.base_model.id} {counts}")
    return EXIT_OK
