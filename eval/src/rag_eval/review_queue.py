import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.cache import TENANT_KEY_PATTERN
from rag_sidecar.contracts.feedback_loop import (
    Channel,
    ChunkId,
    ExpertLabel,
    LanguageCode,
    LogOutcome,
    MiningReason,
    TenantKey,
    UuidStr,
)
from rag_sidecar.contracts.golden import GoldenItem, GoldSpan, Split
from rag_sidecar.contracts.languages import LANGUAGE_CODES
from rag_sidecar.contracts.review import ReviewQueueItem

from rag_eval.draft import writer
from rag_eval.draft.writer import PrivatePathError, assert_private_path
from rag_eval.golden_io import load_golden, write_golden
from rag_eval.matching import normalize_text
from rag_eval.near_dup import matches as near_duplicate_matches
from rag_eval.paths import resolve_cli_path
from rag_eval.split import (
    assign_split,
    freeze_splits,
    load_manifest,
    plan_group_splits,
    write_group_manifest,
)

EXIT_OK, EXIT_INPUT, EXIT_API, EXIT_PRIVATE = 0, 2, 4, 6
SKIP_NOTICE = "::notice::langfuse keys not configured, skipping review queue"
QUEUE_SUBDIR = "review-queue"
REVIEW_TAG_PREFIX = "review:"
REVIEW_ROUTE = "/api/rag/admin/review-candidates"
DEFAULT_TOKEN_ENV = "RAG_ADMIN_BEARER"
SOURCES = ("langfuse", "db", "both")
_REASONS = ("sampled", "feedback_negative", "groundedness_flagged")
PROMOTED_NAME = "promoted.jsonl"
EXPORT_ROUTE = "/api/rag/admin/feedback-loop/export"
MARK_ROUTE = "/api/rag/admin/feedback-loop/export/mark"
DOMAIN_SUBDIR = "domain"
DOMAIN_GOLDEN_NAME = "golden.jsonl"
DOMAIN_MANIFEST_NAME = "split-manifest.json"
TENANT_HASH_LENGTH = 16
MARK_BATCH = 500
LANGUAGES: tuple[str, ...] = LANGUAGE_CODES

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
    reasons = _reasons_from_tags(tags)
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
            reasons=reasons,
        )
    except ValidationError:
        return None


def _reasons_from_tags(tags: list[str]) -> list[str]:
    tagged = [tag[len(REVIEW_TAG_PREFIX):] for tag in tags if tag.startswith(REVIEW_TAG_PREFIX)]
    reasons = [reason for reason in _REASONS[1:] if reason in tagged]
    return reasons or ["sampled"]


def _db_item(raw: Any) -> ReviewQueueItem | None:
    if not isinstance(raw, dict):
        return None
    try:
        item = ReviewQueueItem.model_validate(raw)
    except ValidationError:
        return None
    return item.model_copy(
        update={
            "query_masked": mask_text(item.query_masked),
            "answer_masked": mask_text(item.answer_masked),
            "context_masked": mask_text(item.context_masked),
            "model": mask_text(item.model),
        }
    )


def _merge(items: list[ReviewQueueItem]) -> list[ReviewQueueItem]:
    """One item per trace id: the earliest capture wins, reasons and tags are unioned in a stable order."""
    by_trace: dict[str, ReviewQueueItem] = {}
    for item in sorted(items, key=lambda entry: (entry.captured_at, entry.observation_id)):
        kept = by_trace.get(item.trace_id)
        if kept is None:
            by_trace[item.trace_id] = item
            continue
        reasons = [reason for reason in _REASONS if reason in kept.reasons or reason in item.reasons]
        tags = list(dict.fromkeys([*kept.tags, *item.tags]))
        update: dict[str, Any] = {"reasons": reasons, "tags": tags}
        for field in ("query_masked", "answer_masked", "context_masked", "model"):
            if not getattr(kept, field).strip() and getattr(item, field).strip():
                update[field] = getattr(item, field)
        if kept.language is None and item.language is not None:
            update["language"] = item.language
        by_trace[item.trace_id] = kept.model_copy(update=update)
    return sorted(by_trace.values(), key=lambda entry: (entry.captured_at, entry.observation_id))


class _DbSourceError(Exception):
    pass


def _pull_db(from_time: str, to_time: str, base_url: str, token: str) -> list[ReviewQueueItem]:
    url = base_url.rstrip("/") + REVIEW_ROUTE
    try:
        with _http_client() as client:
            response = client.get(url, params={"from": from_time, "to": to_time}, headers={"Authorization": f"Bearer {token}"})
    except Exception as exc:
        raise _DbSourceError(f"review-candidates request failed: {type(exc).__name__}") from None
    if response.status_code != 200:
        raise _DbSourceError(f"review-candidates answered HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError:
        raise _DbSourceError("review-candidates answered a body that is not JSON") from None
    raw_items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(raw_items, list):
        raise _DbSourceError("review-candidates answered without an items list")
    return [item for item in (_db_item(raw) for raw in raw_items) if item is not None]


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


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


def pull(
    from_time: str,
    to_time: str,
    *,
    out_dir: Path | str | None = None,
    out: Path | str | None = None,
    source: str = "langfuse",
    base_url: str | None = None,
    token_env: str = DEFAULT_TOKEN_ENV,
) -> int:
    if source not in SOURCES:
        print(f"error: --source must be one of {', '.join(SOURCES)}", file=sys.stderr)
        return EXIT_INPUT
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

    token = ""
    if source in ("db", "both"):
        if not base_url:
            print("error: --source db needs --base-url (the app origin)", file=sys.stderr)
            return EXIT_INPUT
        token = os.environ.get(token_env, "").strip()
        if not token:
            print(f"error: set {token_env} to an admin access token for --source {source}", file=sys.stderr)
            return EXIT_INPUT

    collected: list[ReviewQueueItem] = []
    total = 0
    if source in ("langfuse", "both"):
        public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
        secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
        if not public_key or not secret_key:
            print(SKIP_NOTICE)
            if source == "langfuse":
                return EXIT_OK
        else:
            from rag_eval.langfuse_api import (
                DEFAULT_BASE_URL,
                LangfuseApi,
                LangfuseApiError,
            )

            langfuse_url = os.environ.get("LANGFUSE_BASE_URL") or DEFAULT_BASE_URL
            by_observation: dict[str, ReviewQueueItem] = {}
            try:
                with LangfuseApi(langfuse_url, public_key, secret_key) as api:
                    for row in api.observations(from_time, to_time):
                        total += 1
                        item = _to_item(row)
                        if item is not None:
                            by_observation.setdefault(item.observation_id, item)
            except LangfuseApiError as exc:
                print(f"error: {exc}", file=sys.stderr)
                return EXIT_API
            collected.extend(by_observation.values())

    db_count = 0
    if source in ("db", "both"):
        try:
            db_items = _pull_db(from_time, to_time, base_url or "", token)
        except _DbSourceError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_API
        db_count = len(db_items)
        collected.extend(db_items)

    ordered = _merge(collected)
    _write_text(
        target,
        "".join(json.dumps(item.model_dump(mode="json"), ensure_ascii=False, sort_keys=True) + "\n" for item in ordered),
    )
    print(f"[Review Queue] pulled {total} observations and {db_count} flagged records, wrote {len(ordered)} items to {target}")
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


# --- promote-db (Phase 5.1.1 D-20, D-21, D-22, D-29) ---


class _ExportEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    chunk_id: ChunkId
    document_id: UuidStr
    document_name: str = Field(min_length=1, max_length=512)
    section: str = Field(max_length=512)
    quote: str = Field(min_length=2, max_length=2000)
    chunk_text: str | None
    quote_verified: bool


class _GoldenExportLine(BaseModel):
    """Python twin of GoldenExportLineSchema in src/lib/rag/feedback-loop/exports.ts (plan 05.1.1-14)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: UuidStr
    tenant_key: TenantKey
    query_masked: str | None = None
    query_language: LanguageCode | None = None
    channel: Channel
    outcome: LogOutcome
    reasons: list[MiningReason] = Field(default_factory=list)
    occurrences: int = Field(ge=1)
    labelled_at: str | None = None
    split: Split | None = None
    split_group: str | None = Field(default=None, min_length=1, max_length=128)
    mining_window: str | None = None
    mined_at: str
    label: ExpertLabel
    evidence: list[_ExportEvidence] = Field(default_factory=list, max_length=20)


class _ExportError(Exception):
    pass


def tenant_hash(tenant_key: str) -> str:
    """Same hash as tenantHash() in src/lib/rag/feedback-loop/mining.ts."""
    return hashlib.sha256(tenant_key.encode("utf-8")).hexdigest()[:TENANT_HASH_LENGTH]


def _item_ref(review_item_id: str) -> str:
    return hashlib.sha256(review_item_id.encode("utf-8")).hexdigest()[:12]


def _read_token(token_env: str) -> str | None:
    token = os.environ.get(token_env, "").strip()
    return token or None


def fetch_export(base_url: str, token: str, kind: str, tenant: str) -> list[str]:
    """NDJSON lines of one export kind; raises _ExportError without the token or any body text."""
    url = base_url.rstrip("/") + EXPORT_ROUTE
    try:
        with _http_client() as client:
            response = client.get(url, params={"kind": kind, "tenant": tenant}, headers={"Authorization": f"Bearer {token}"})
    except Exception as exc:
        raise _ExportError(f"export request failed: {type(exc).__name__}") from None
    if response.status_code != 200:
        raise _ExportError(f"export answered HTTP {response.status_code}")
    return [line for line in response.text.split("\n") if line.strip()]


def _parse_golden_lines(lines: list[str], tenant: str) -> list[_GoldenExportLine]:
    parsed: list[_GoldenExportLine] = []
    for number, line in enumerate(lines, start=1):
        try:
            item = _GoldenExportLine.model_validate_json(line)
        except ValidationError as exc:
            raise _ExportError(f"export line {number} fails the golden export contract ({exc.error_count()} error(s))") from None
        if item.tenant_key != tenant:
            raise _ExportError(f"export line {number} belongs to another tenant")
        parsed.append(item)
    return parsed


def _post_marks(base_url: str, token: str, tenant: str, entries: list[dict[str, str]]) -> None:
    url = base_url.rstrip("/") + MARK_ROUTE
    for start in range(0, len(entries), MARK_BATCH):
        body = {"tenant": tenant, "items": entries[start : start + MARK_BATCH]}
        try:
            with _http_client() as client:
                response = client.post(url, json=body, headers={"Authorization": f"Bearer {token}"})
        except Exception as exc:
            raise _ExportError(f"mark request failed: {type(exc).__name__}") from None
        if response.status_code != 200:
            raise _ExportError(f"mark answered HTTP {response.status_code}")


def _golden_id(line: _GoldenExportLine) -> str:
    return f"prod-{line.label.language}-{_item_ref(line.id)}"


def _quote_problem(line: _GoldenExportLine) -> str | None:
    for index, span in enumerate(line.evidence, start=1):
        quote = normalize_text(span.quote)
        if not span.quote_verified:
            return f"evidence span {index}: the server could not verify the quote against the current chunk"
        if span.chunk_text is None or not quote or quote not in normalize_text(span.chunk_text):
            return f"evidence span {index}: the quote is no longer in its current chunk"
    labelled = [(span.chunk_id, span.document_id, span.quote) for span in line.label.evidence]
    exported = [(span.chunk_id, span.document_id, span.quote) for span in line.evidence]
    if labelled != exported:
        return "the exported evidence does not match the label's evidence"
    return None


def _build_item(line: _GoldenExportLine, question: str, tags: list[str]) -> GoldenItem:
    label = line.label
    return GoldenItem(
        id=_golden_id(line),
        question=question,
        language=label.language,
        category=label.category,
        answerable=label.answerable,
        expected_answer=label.expected_answer if label.answerable else None,
        gold_evidence=[
            GoldSpan(document=span.document_name, section=span.section, quote=span.quote, document_id=span.document_id.lower())
            for span in label.evidence
        ],
        review_status="approved",
        provenance="human" if label.paraphrased_question else "production",
        split="dev",
        tags=tags,
    )


def _candidate(line: _GoldenExportLine, accepted: list[GoldenItem]) -> tuple[GoldenItem | None, str | None]:
    """The golden item for one export line, or the reason it is refused (ids and codes only, never text)."""
    ref = _item_ref(line.id)
    if "golden" not in line.label.triage or not line.label.pii_checked:
        return None, f"review item {ref}: not triaged golden with pii_checked"
    question = (line.label.paraphrased_question or line.query_masked or "").strip()
    if not question:
        return None, f"review item {ref}: no question to promote"
    if mask_text(question) != question:
        return None, f"review item {ref}: the question still changes under masking; paraphrase it before promotion"
    problem = _quote_problem(line)
    if problem:
        return None, f"review item {ref}: {problem}"
    found = near_duplicate_matches(question, [(item.id, item.question) for item in accepted])
    confirmed = line.label.confirm_near_duplicate_of
    tags: list[str] = []
    if confirmed is not None:
        if confirmed not in {item.id for item in accepted}:
            return None, f"review item {ref}: confirm_near_duplicate_of names {confirmed}, which is not in the domain set"
        tags.append(f"near_duplicate_confirmed:{confirmed}")
    if found and confirmed not in {item_id for item_id, _ in found}:
        names = ", ".join(item_id for item_id, _ in found)
        return None, f"review item {ref}: near-duplicate of {names}; set confirm_near_duplicate_of to promote it"
    try:
        return _build_item(line, question, tags), None
    except ValidationError as exc:
        first = exc.errors()[0]
        return None, f"review item {ref}: the label cannot form a golden item ({first.get('msg', 'invalid')})"


def promote_db(
    tenant: str,
    *,
    base_url: str,
    token_env: str = DEFAULT_TOKEN_ENV,
    out_dir: Path | str | None = None,
) -> int:
    """D-20: promote one tenant's labelled golden candidates; all or nothing, then mark them exported with their splits."""
    if not re.fullmatch(TENANT_KEY_PATTERN, tenant):
        print("error: --tenant must be s:default, u:<uuid> or o:<uuid>", file=sys.stderr)
        return EXIT_INPUT
    try:
        directory = resolve_cli_path(out_dir) if out_dir is not None else writer.PRIVATE_DIR / DOMAIN_SUBDIR / tenant_hash(tenant)
        golden_path = assert_private_path(Path(directory) / DOMAIN_GOLDEN_NAME)
        manifest_path = assert_private_path(Path(directory) / DOMAIN_MANIFEST_NAME)
    except PrivatePathError as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_PRIVATE
    token = _read_token(token_env)
    if token is None:
        print(f"error: set {token_env} to an admin access token for promote-db", file=sys.stderr)
        return EXIT_INPUT

    try:
        lines = _parse_golden_lines(fetch_export(base_url, token, "golden", tenant), tenant)
    except _ExportError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_API

    try:
        existing = load_golden(golden_path) if golden_path.exists() else []
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INPUT
    existing_ids = {item.id for item in existing}
    accepted = list(existing)
    new_items: list[GoldenItem] = []
    review_of: dict[str, str] = {}
    refusals: list[str] = []
    for line in sorted(lines, key=lambda entry: entry.id):
        golden_id = _golden_id(line)
        review_of[golden_id] = line.id
        if golden_id in existing_ids:
            continue
        item, reason = _candidate(line, accepted)
        if reason is not None:
            refusals.append(reason)
            continue
        assert item is not None
        accepted.append(item)
        new_items.append(item)
    if refusals:
        print(f"error: {len(refusals)} of {len(lines)} golden candidate(s) refused; nothing written:", file=sys.stderr)
        for reason in refusals:
            print(f"  {reason}", file=sys.stderr)
        return EXIT_INPUT

    try:
        plan = plan_group_splits(accepted, manifest_path)
    except ValueError as exc:
        print(f"error: cannot freeze the domain set splits: {exc}", file=sys.stderr)
        return EXIT_INPUT
    by_id = {item.id: item for item in plan.items}
    for line in lines:
        frozen = by_id.get(_golden_id(line))
        if frozen is not None and line.split is not None and line.split != frozen.split:
            print(f"error: review item {_item_ref(line.id)} is frozen {line.split} on the server but {frozen.split} here", file=sys.stderr)
            return EXIT_INPUT
    if new_items:
        write_golden(golden_path, plan.items)
    if plan.changed and plan.items:
        write_group_manifest(manifest_path, plan.assignments, plan.group_assignments)

    marks = [
        {"id": review_of[golden_id], "split": by_id[golden_id].split, "split_group": plan.item_groups[golden_id]}
        for golden_id in sorted(review_of)
    ]
    if marks:
        try:
            _post_marks(base_url, token, tenant, marks)
        except _ExportError as exc:
            print(f"error: {exc}; the domain set is written, run promote-db again to mark the items", file=sys.stderr)
            return EXIT_API
    print(
        f"[Review Queue] domain set {tenant_hash(tenant)}: {len(new_items)} promoted, "
        f"{len(marks) - len(new_items)} already present, {len(marks)} marked exported"
    )
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.review_queue", description="myRAG production review queue")
    commands = parser.add_subparsers(dest="command", required=True)

    pull_cmd = commands.add_parser("pull", help="pull masked review-candidate observations from Langfuse into the private queue")
    pull_cmd.add_argument("--from", dest="from_time", required=True, help="window start, ISO 8601")
    pull_cmd.add_argument("--to", dest="to_time", required=True, help="window end, ISO 8601")
    pull_cmd.add_argument("--out-dir", type=Path, help="queue directory inside eval/golden/private/")
    pull_cmd.add_argument("--out", type=Path, help="queue file inside eval/golden/private/ (overrides --out-dir)")
    pull_cmd.add_argument("--source", choices=SOURCES, default="langfuse", help="langfuse (default), db (the admin review route) or both")
    pull_cmd.add_argument("--base-url", help="app origin for --source db or both, e.g. https://app.example.com")
    pull_cmd.add_argument(
        "--token-env", default=DEFAULT_TOKEN_ENV, help=f"environment variable holding the admin access token (default {DEFAULT_TOKEN_ENV})"
    )

    promote_cmd = commands.add_parser("promote", help="turn a queue item into a draft golden item")
    promote_cmd.add_argument("item_id", help="trace id or observation id of the queue item")
    promote_cmd.add_argument("--queue", type=Path, help="queue file (default: every file in the queue directory)")
    promote_cmd.add_argument("--out", type=Path, help="golden JSONL inside eval/golden/private/")
    promote_cmd.add_argument("--language", choices=LANGUAGES)

    db_cmd = commands.add_parser(
        "promote-db",
        help="promote expert-approved golden candidates of one tenant into its private domain set (docgroup split)",
    )
    db_cmd.add_argument("--tenant", required=True, help="tenant key (s:default, u:<uuid> or o:<uuid>)")
    db_cmd.add_argument("--base-url", required=True, help="app origin, e.g. https://app.example.com")
    db_cmd.add_argument(
        "--token-env", default=DEFAULT_TOKEN_ENV, help=f"environment variable holding the admin access token (default {DEFAULT_TOKEN_ENV})"
    )
    db_cmd.add_argument(
        "--out-dir", type=Path, help="domain set directory inside eval/golden/private/ (default: domain/<tenant_hash>/)"
    )

    args = parser.parse_args(argv)
    if args.command == "promote-db":
        return promote_db(args.tenant, base_url=args.base_url, token_env=args.token_env, out_dir=args.out_dir)
    if args.command == "pull":
        return pull(
            args.from_time,
            args.to_time,
            out_dir=args.out_dir,
            out=args.out,
            source=args.source,
            base_url=args.base_url,
            token_env=args.token_env,
        )
    return promote(args.item_id, queue=args.queue, out=args.out, language=args.language)


if __name__ == "__main__":
    raise SystemExit(main())
