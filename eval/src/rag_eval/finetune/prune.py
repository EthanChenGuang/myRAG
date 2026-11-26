"""python -m rag_eval.finetune prune: retention for fine-tune bundles (FT-10; D-29, D-31).

Bundles are the run directories directly under --root (default eval/out/finetune) that hold a valid manifest.json; other
directories are left alone. A bundle is pruned when its last activity, the later of the manifest's created_at and the newest
file mtime in the bundle, is more than --older-than-days ago (default finetune.json retention.retention_days, 30), or, with
--tenant <key>, whenever its manifest lists that tenant, whatever its age (D-29 revocation; bundles of other tenants only are
untouched).

Pruning deletes the text-bearing files: every *.jsonl (chunks, queries, pairs, training and dev sets), vector files
(*.f32 and the vectors/ directory), the generate and judge caches (cache/), kit directories inside the bundle (kit*/) and
temporary *.tmp files. Manifests and reports (the other *.json files at the bundle root: manifest, filter, mining, offline
reports, provenance, card) stay, since they hold ids, hashes, counts and metrics only. A kit written with --out outside the
bundle is not found here and is removed by the operator. Output names each pruned bundle by run id with the deleted file
names and their count; it never prints tenant keys or file contents.
"""
import argparse
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TextIO

from rag_sidecar.contracts.cache import TENANT_KEY_PATTERN

from rag_eval.finetune import bundle
from rag_eval.finetune.config import load_finetune_config
from rag_eval.finetune.export import DEFAULT_OUT

TEXT_DIRS = ("vectors", "cache")
KIT_DIR_PREFIX = "kit"
TEXT_SUFFIXES = (".jsonl", ".f32", ".tmp")
EXIT_OK = 0
EXIT_USAGE = 2
_TENANT = re.compile(TENANT_KEY_PATTERN)


@dataclass
class PruneResult:
    exit_code: int
    deleted: dict[str, list[str]] = field(default_factory=dict)
    skipped: list[str] = field(default_factory=list)


def is_text_bearing(relative: Path) -> bool:
    first = relative.parts[0]
    if len(relative.parts) > 1 and (first in TEXT_DIRS or first.startswith(KIT_DIR_PREFIX)):
        return True
    return relative.name.endswith(TEXT_SUFFIXES)


def _files(run_dir: Path) -> list[Path]:
    out: list[Path] = []
    for current, dirs, names in os.walk(run_dir, followlinks=False):
        dirs.sort()
        out.extend(Path(current) / name for name in sorted(names))
    return out


def _created_at(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def last_activity(run_dir: Path, created_at: str) -> datetime:
    newest = _created_at(created_at)
    for path in _files(run_dir):
        try:
            mtime = datetime.fromtimestamp(path.lstat().st_mtime, tz=UTC)
        except OSError:
            continue
        newest = max(newest, mtime)
    return newest


def prune_bundle(run_dir: Path) -> list[str]:
    deleted: list[str] = []
    for path in _files(run_dir):
        relative = path.relative_to(run_dir)
        if is_text_bearing(relative):
            path.unlink(missing_ok=True)
            deleted.append(relative.as_posix())
    for current, dirs, _names in sorted(os.walk(run_dir, topdown=False, followlinks=False), key=lambda w: -len(w[0])):
        directory = Path(current)
        if directory != run_dir and not any(directory.iterdir()):
            directory.rmdir()
    return sorted(deleted)


def run_prune(
    root: Path,
    *,
    older_than_days: int | None = None,
    tenant: str | None = None,
    now: datetime | None = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> PruneResult:
    out = out or sys.stdout
    err = err or sys.stderr
    now = now or datetime.now(UTC)
    if tenant is not None and not _TENANT.fullmatch(tenant):
        print("[Finetune] prune refused: tenant_invalid", file=err)
        return PruneResult(EXIT_USAGE)
    if older_than_days is None:
        older_than_days = load_finetune_config().retention.retention_days
    if older_than_days < 1:
        print("[Finetune] prune refused: older_than_days_invalid (at least 1)", file=err)
        return PruneResult(EXIT_USAGE)
    root = Path(root)
    result = PruneResult(EXIT_OK)
    cutoff = now - timedelta(days=older_than_days)
    candidates = sorted(p for p in root.iterdir() if p.is_dir() and not p.is_symlink()) if root.is_dir() else []
    for run_dir in candidates:
        if not (run_dir / bundle.MANIFEST_FILE).is_file():
            continue
        try:
            manifest = bundle.read_manifest(run_dir)
        except (ValueError, OSError):
            result.skipped.append(run_dir.name)
            print(f"[Finetune] prune: skipped {run_dir.name}: manifest_invalid", file=err)
            continue
        if tenant is not None:
            selected = tenant in manifest.tenant_keys
        else:
            selected = last_activity(run_dir, manifest.created_at) < cutoff
        if not selected:
            continue
        deleted = prune_bundle(run_dir)
        if deleted:
            result.deleted[run_dir.name] = deleted
            print(f"[Finetune] prune: {run_dir.name}: deleted {len(deleted)} files: {', '.join(deleted)}", file=out)
    if result.deleted:
        total = sum(len(names) for names in result.deleted.values())
        print(f"[Finetune] prune: {total} files in {len(result.deleted)} bundles", file=out)
    else:
        print("[Finetune] prune: nothing to prune", file=out)
    return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rag_eval.finetune prune")
    parser.add_argument("--root", type=Path, default=DEFAULT_OUT, help="bundle root (default eval/out/finetune)")
    parser.add_argument(
        "--older-than-days",
        type=int,
        default=None,
        help="retention in days (default finetune.json retention.retention_days)",
    )
    parser.add_argument("--tenant", default=None, help="prune every bundle listing this tenant, whatever its age")
    return parser


def main(argv: list[str] | None = None, *, now: datetime | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return EXIT_USAGE if exc.code else EXIT_OK
    try:
        return run_prune(args.root, older_than_days=args.older_than_days, tenant=args.tenant, now=now).exit_code
    except ValueError:
        print("[Finetune] prune refused: config_invalid", file=sys.stderr)
        return EXIT_USAGE
