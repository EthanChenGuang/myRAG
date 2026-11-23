import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import ValidationError
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.review import ReviewQueueItem

from rag_eval.draft import writer
from rag_eval.draft.writer import PrivatePathError, assert_private_path
from rag_eval.golden_io import load_golden, write_golden
from rag_eval.matching import normalize_text
from rag_eval.paths import resolve_cli_path
from rag_eval.split import assign_split, freeze_splits, load_manifest

EXIT_OK, EXIT_INPUT, EXIT_API, EXIT_PRIVATE = 0, 2, 4, 6
SKIP_NOTICE = "::notice::langfuse keys not configured, skipping review queue"
QUEUE_SUBDIR = "review-queue"
PROMOTED_NAME = "promoted.jsonl"
LANGUAGES = ("zh", "en", "it")

# Python twin of src/lib/rag/trace/mask.ts; keep the patterns and their order identical.
_EMAIL = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE | re.ASCII)
_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b", re.ASCII)
_CN_RESIDENT_ID = re.compile(r"\b\d{17}[\dXx]\b", re.ASCII)
_IT_CODICE_FISCALE = re.compile(r"\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b", re.IGNORECASE | re.ASCII)
_CARD_CANDIDATE = re.compile(r"\b\d(?:[ -]?\d){12,18}\b", re.ASCII)
_PHONE_INTERNATIONAL = re.compile(r"(?:\+|00)\d[\d ()-]{7,}\d", re.ASCII)
_PHONE_CN_MOBILE = re.compile(r"\b1[3-9]\d{9}\b", re.ASCII)

_CJK = re.compile(r"[㐀-䶿一-鿿]")
_WORDS = re.compile(r"[a-zà-ÿ']+")
_ITALIAN_MARKERS = frozenset(
    {
        "il", "lo", "gli", "che", "di", "del", "della", "dei", "per", "non", "come", "sono", "una", "quanti",
        "quanto", "quali", "quale", "cosa", "dove", "quando", "posso", "possiamo", "ho", "è", "con", "nel",
        "nella", "giorni", "anno", "ferie", "devo", "vorrei",
    }
)


def _luhn_valid(digits: str) -> bool:
    total = 0
    double = False
    for char in reversed(digits):
        digit = ord(char) - 48
        if double:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
        double = not double
    return total % 10 == 0


def mask_text(text: str) -> str:
    masked = _EMAIL.sub("[EMAIL]", text)
    masked = _IBAN.sub("[IBAN]", masked)
    masked = _CN_RESIDENT_ID.sub("[ID]", masked)
    masked = _IT_CODICE_FISCALE.sub("[ID]", masked)
    masked = _CARD_CANDIDATE.sub(
        lambda match: "[CARD]" if _luhn_valid(re.sub(r"\D", "", match.group(0))) else match.group(0), masked
    )
    masked = _PHONE_INTERNATIONAL.sub("[PHONE]", masked)
    return _PHONE_CN_MOBILE.sub("[PHONE]", masked)


def detect_language(text: str) -> str:
    if _CJK.search(text):
        return "zh"
    hits = {word for word in _WORDS.findall(text.lower()) if word in _ITALIAN_MARKERS}
    return "it" if len(hits) >= 2 else "en"


def _decode_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return value
        return parsed if isinstance(parsed, str) else value
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return str(value)


def _metadata(row: dict[str, Any]) -> dict[str, Any]:
    value = row.get("metadata")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


def _to_item(row: dict[str, Any]) -> ReviewQueueItem | None:
    observation_id, trace_id, captured_at = row.get("id"), row.get("traceId"), row.get("startTime")
    if not all(isinstance(value, str) and value for value in (observation_id, trace_id, captured_at)):
        return None
    metadata = _metadata(row)
    query = mask_text(_decode_text(row.get("input")))
    answer = mask_text(_decode_text(row.get("output")))
    if not query.strip() and not answer.strip():
        return None
    tenant = row.get("userId")
    if not isinstance(tenant, str) or not tenant:
        tenant = _decode_text(metadata.get("tenantKey"))
    language = _decode_text(metadata.get("language"))
    raw_tags = row.get("tags") or row.get("traceTags") or []
    tags = [tag for tag in raw_tags if isinstance(tag, str)] if isinstance(raw_tags, list) else []
    try:
        return ReviewQueueItem(
            trace_id=trace_id,
            observation_id=observation_id,
            captured_at=captured_at,
            tenant_key=tenant,
            language=language if language in LANGUAGES else None,
            query_masked=query,
            answer_masked=answer,
            context_masked=mask_text(_decode_text(metadata.get("context"))),
            model=mask_text(_decode_text(metadata.get("model"))),
            tags=tags,
        )
    except ValidationError:
        return None


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _stamp(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "-", value)


def _queue_dir() -> Path:
    return writer.PRIVATE_DIR / QUEUE_SUBDIR


def _write_text(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(payload.encode("utf-8"))
    os.replace(tmp, path)


def pull(from_time: str, to_time: str, *, out_dir: Path | str | None = None, out: Path | str | None = None) -> int:
    try:
        start, end = _parse_time(from_time), _parse_time(to_time)
    except ValueError:
        print("error: --from and --to must be ISO 8601 timestamps", file=sys.stderr)
        return EXIT_INPUT
    if start > end:
        print("error: --from must not be later than --to", file=sys.stderr)
        return EXIT_INPUT

    if out is not None:
        target = resolve_cli_path(out)
    else:
        directory = resolve_cli_path(out_dir) if out_dir is not None else _queue_dir()
        target = directory / f"{_stamp(from_time)}_{_stamp(to_time)}.jsonl"
    try:
        target = assert_private_path(target)
    except PrivatePathError as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_PRIVATE

    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
    if not public_key or not secret_key:
        print(SKIP_NOTICE)
        return EXIT_OK

    from rag_eval.langfuse_api import DEFAULT_BASE_URL, LangfuseApi, LangfuseApiError

    base_url = os.environ.get("LANGFUSE_BASE_URL") or DEFAULT_BASE_URL
    items: dict[str, ReviewQueueItem] = {}
    total = 0
    try:
        with LangfuseApi(base_url, public_key, secret_key) as api:
            for row in api.observations(from_time, to_time):
                total += 1
                item = _to_item(row)
                if item is not None:
                    items.setdefault(item.observation_id, item)
    except LangfuseApiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_API

    ordered = sorted(items.values(), key=lambda item: (item.captured_at, item.observation_id))
    _write_text(
        target,
        "".join(json.dumps(item.model_dump(mode="json"), ensure_ascii=False, sort_keys=True) + "\n" for item in ordered),
    )
    print(f"[Review Queue] pulled {total} observations, wrote {len(ordered)} items to {target}")
    return EXIT_OK


def _find_item(queue_files: list[Path], item_id: str) -> ReviewQueueItem | None:
    for path in queue_files:
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                item = ReviewQueueItem.model_validate_json(line)
            except ValidationError:
                continue
            if item_id in (item.trace_id, item.observation_id):
                return item
    return None


def promote(
    item_id: str,
    *,
    queue: Path | str | None = None,
    out: Path | str | None = None,
    language: str | None = None,
) -> int:
    try:
        out_path = assert_private_path(resolve_cli_path(out) if out is not None else writer.PRIVATE_DIR / PROMOTED_NAME)
        manifest = assert_private_path(writer.DEFAULT_MANIFEST)
        if queue is not None:
            queue_files = [assert_private_path(resolve_cli_path(queue))]
        else:
            queue_files = sorted(_queue_dir().glob("*.jsonl")) if _queue_dir().is_dir() else []
    except PrivatePathError as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_PRIVATE

    found = _find_item(queue_files, item_id)
    if found is None:
        print(f"error: review queue item {item_id} not found", file=sys.stderr)
        return EXIT_INPUT
    question = found.query_masked.strip()
    if not question:
        print(f"error: review queue item {item_id} has no query to promote", file=sys.stderr)
        return EXIT_INPUT

    chosen = language or found.language or detect_language(question)
    golden_id = f"prod-{chosen}-{hashlib.sha256(found.trace_id.encode('utf-8')).hexdigest()[:10]}"
    try:
        existing = load_golden(out_path) if out_path.exists() else []
        if any(item.id == golden_id for item in existing):
            print(f"[Review Queue] {golden_id} is already promoted; nothing written")
            return EXIT_OK
        if any(normalize_text(item.question) == normalize_text(question) for item in existing):
            print("[Review Queue] a golden item with the same question already exists; nothing written")
            return EXIT_OK
        assignments = load_manifest(manifest)
        item = GoldenItem(
            id=golden_id,
            question=question,
            language=chosen,
            category="no_answer",
            answerable=False,
            expected_answer=None,
            gold_evidence=[],
            review_status="draft",
            provenance="production",
            split=assignments.get(golden_id) or assign_split(golden_id),
        )
        write_golden(out_path, freeze_splits(existing + [item], manifest))
    except ValueError as exc:
        print(f"error: cannot promote {item_id}: {exc}", file=sys.stderr)
        return EXIT_INPUT
    print(f"[Review Queue] promoted {golden_id} to {out_path}")
    print("note: the draft is a no_answer placeholder; set category, answerable, expected_answer and gold_evidence before approving")
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.review_queue", description="myRAG production review queue")
    commands = parser.add_subparsers(dest="command", required=True)

    pull_cmd = commands.add_parser("pull", help="pull masked review-candidate observations from Langfuse into the private queue")
    pull_cmd.add_argument("--from", dest="from_time", required=True, help="window start, ISO 8601")
    pull_cmd.add_argument("--to", dest="to_time", required=True, help="window end, ISO 8601")
    pull_cmd.add_argument("--out-dir", type=Path, help="queue directory inside eval/golden/private/")
    pull_cmd.add_argument("--out", type=Path, help="queue file inside eval/golden/private/ (overrides --out-dir)")

    promote_cmd = commands.add_parser("promote", help="turn a queue item into a draft golden item")
    promote_cmd.add_argument("item_id", help="trace id or observation id of the queue item")
    promote_cmd.add_argument("--queue", type=Path, help="queue file (default: every file in the queue directory)")
    promote_cmd.add_argument("--out", type=Path, help="golden JSONL inside eval/golden/private/")
    promote_cmd.add_argument("--language", choices=LANGUAGES)

    args = parser.parse_args(argv)
    if args.command == "pull":
        return pull(args.from_time, args.to_time, out_dir=args.out_dir, out=args.out)
    return promote(args.item_id, queue=args.queue, out=args.out, language=args.language)


if __name__ == "__main__":
    raise SystemExit(main())
