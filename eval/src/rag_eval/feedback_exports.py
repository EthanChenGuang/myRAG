"""Dictionary and training hand-off files (Phase 5.1.1 D-17) for Phases 4.1.1 and 6.1.

`python -m rag_eval.feedback_exports --tenant <key> --kind dictionary|training --base-url <url>` reads one export of the
admin route, validates every line with its Pydantic contract and writes it atomically under
eval/golden/private/exports/<tenant_hash>/<kind>-<date>.jsonl. Training pairs are checked a second time against the
tenant's domain set (D-21): a train pair whose positive document or document group is in a test group is a leak and
nothing is written. Only counts and hashes are printed, never a token, question or chunk text.
"""

import argparse
import json
import os
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, ValidationError
from rag_sidecar.contracts.cache import TENANT_KEY_PATTERN
from rag_sidecar.contracts.feedback_loop import DictionaryCandidate, TrainingPair

from rag_eval.draft import writer
from rag_eval.draft.writer import PrivatePathError, assert_private_path
from rag_eval.golden_io import load_golden
from rag_eval.paths import resolve_cli_path
from rag_eval.review_queue import (
    DEFAULT_TOKEN_ENV,
    DOMAIN_GOLDEN_NAME,
    DOMAIN_MANIFEST_NAME,
    DOMAIN_SUBDIR,
    EXIT_API,
    EXIT_INPUT,
    EXIT_OK,
    EXIT_PRIVATE,
    EXPORT_ROUTE,
    tenant_hash,
)
from rag_eval.split import document_key, load_group_manifest

KINDS: dict[str, type[BaseModel]] = {"dictionary": DictionaryCandidate, "training": TrainingPair}
EXPORTS_SUBDIR = "exports"


class _ExportError(Exception):
    pass


def _today() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%d")


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


def _fetch(base_url: str, token: str, kind: str, tenant: str) -> list[str]:
    url = base_url.rstrip("/") + EXPORT_ROUTE
    try:
        with _http_client() as client:
            response = client.get(url, params={"kind": kind, "tenant": tenant}, headers={"Authorization": f"Bearer {token}"})
    except Exception as exc:  # noqa: BLE001 - transport errors never carry the token
        raise _ExportError(f"export request failed: {type(exc).__name__}") from None
    if response.status_code != 200:
        raise _ExportError(f"export answered HTTP {response.status_code}")
    return [line for line in response.text.split("\n") if line.strip()]


def _validate(lines: list[str], kind: str, tenant: str) -> list[BaseModel]:
    model = KINDS[kind]
    records: list[BaseModel] = []
    for number, line in enumerate(lines, start=1):
        try:
            record = model.model_validate_json(line)
        except ValidationError as exc:
            raise _ExportError(f"line {number} fails the {model.__name__} contract ({exc.error_count()} error(s))") from None
        if record.tenant_key != tenant:  # type: ignore[attr-defined]
            raise _ExportError(f"line {number} belongs to another tenant")
        records.append(record)
    return records


def _test_groups(tenant: str) -> tuple[set[str], set[str]] | None:
    """Document keys and group ids of the domain set's test split; None when the tenant has no domain set yet."""
    directory = writer.PRIVATE_DIR / DOMAIN_SUBDIR / tenant_hash(tenant)
    golden_path = assert_private_path(directory / DOMAIN_GOLDEN_NAME)
    manifest_path = assert_private_path(directory / DOMAIN_MANIFEST_NAME)
    if not golden_path.exists() and not manifest_path.exists():
        return None
    if not golden_path.exists() or not manifest_path.exists():
        raise ValueError("the tenant's domain set is incomplete: golden.jsonl and split-manifest.json go together")
    manifest = load_group_manifest(manifest_path)
    assert manifest is not None
    test_ids = {item_id for item_id, split in manifest.assignments.items() if split == "test"}
    documents = {
        document_key(span) for item in load_golden(golden_path) if item.id in test_ids for span in item.gold_evidence
    }
    groups = {gid for gid, split in (manifest.group_assignments or {}).items() if split == "test"}
    return documents, groups


def _leaks(records: list[BaseModel], test: tuple[set[str], set[str]]) -> int:
    documents, groups = test
    count = 0
    for record in records:
        assert isinstance(record, TrainingPair)
        if record.split != "train":
            continue
        if record.positive.document_id.lower() in documents or record.document_group in groups:
            count += 1
    return count


def _write_atomic(path: Path, records: list[BaseModel]) -> None:
    payload = "".join(json.dumps(record.model_dump(mode="json"), ensure_ascii=False, sort_keys=True) + "\n" for record in records)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_bytes(payload.encode("utf-8"))
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def export(kind: str, tenant: str, *, base_url: str, token_env: str = DEFAULT_TOKEN_ENV, out: Path | str | None = None) -> int:
    if not re.fullmatch(TENANT_KEY_PATTERN, tenant):
        print("error: --tenant must be s:default, u:<uuid> or o:<uuid>", file=sys.stderr)
        return EXIT_INPUT
    hashed = tenant_hash(tenant)
    try:
        default = writer.PRIVATE_DIR / EXPORTS_SUBDIR / hashed / f"{kind}-{_today()}.jsonl"
        target = assert_private_path(resolve_cli_path(out) if out is not None else default)
    except PrivatePathError as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_PRIVATE
    token = os.environ.get(token_env, "").strip()
    if not token:
        print(f"error: set {token_env} to an admin access token for the {kind} export", file=sys.stderr)
        return EXIT_INPUT
    try:
        test = _test_groups(tenant) if kind == "training" else None
    except (OSError, ValueError, PrivatePathError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INPUT

    try:
        records = _validate(_fetch(base_url, token, kind, tenant), kind, tenant)
    except _ExportError as exc:
        print(f"error: {kind} export: {exc}; nothing written", file=sys.stderr)
        return EXIT_API
    if test is not None:
        leaks = _leaks(records, test)
        if leaks:
            print(
                f"error: {leaks} train pair(s) use a document of the domain set's test groups (test-split leak); nothing written",
                file=sys.stderr,
            )
            return EXIT_INPUT
    _write_atomic(target, records)
    checked = "checked against the domain set" if test is not None else "no domain set to check against"
    suffix = f" ({checked})" if kind == "training" else ""
    print(f"[Feedback Loop] {kind} export {hashed}: wrote {len(records)} line(s) to {target}{suffix}")
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.feedback_exports", description="myRAG feedback-loop hand-off files")
    parser.add_argument("--tenant", required=True, help="tenant key (s:default, u:<uuid> or o:<uuid>)")
    parser.add_argument("--kind", required=True, choices=tuple(KINDS), help="dictionary (Phase 4.1.1) or training (Phase 6.1)")
    parser.add_argument("--base-url", required=True, help="app origin, e.g. https://app.example.com")
    parser.add_argument(
        "--token-env", default=DEFAULT_TOKEN_ENV, help=f"environment variable holding the admin access token (default {DEFAULT_TOKEN_ENV})"
    )
    parser.add_argument("--out", type=Path, help="output file inside eval/golden/private/ (default: exports/<tenant_hash>/<kind>-<date>.jsonl)")
    args = parser.parse_args(argv)
    return export(args.kind, args.tenant, base_url=args.base_url, token_env=args.token_env, out=args.out)


if __name__ == "__main__":
    raise SystemExit(main())
