"""Tiered routing in the worker: preflight, range parsing with cache, quality check, attempts, merge (D-12, D-15, D-53, D-56).

Under tiered routing a PDF is probed (L1 and L2) in the pool, split into page ranges by the page tiers, and every range is parsed
at its own preset: fast and structured ranges by Docling in the priority pool. Each range is one parse-cache entry; the ranges
are checked, merged in page order into one Docling document, chunked once and cached as the ``merged`` entry that ``advance``
reads. Nothing here writes a document row or a chunk (D-06).
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import tempfile
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from docling_core.types.doc import DoclingDocument

from rag_sidecar.contracts.ingest import ParseJobRequest, ParseResult, ProcessingProfile, ProcessingProfileSet
from rag_sidecar.contracts.queue import IngestionJob
from rag_sidecar.contracts.routing import PageRange, ParseRoutingConfig, PreflightResult, QualityCheckResult
from rag_sidecar.ingest import quality
from rag_sidecar.ingest.cache_keys import merged_options_hash, options_hash
from rag_sidecar.ingest.merge import MergeInvariantError, join_page_parts, merge, slice_pages
from rag_sidecar.ingest.pool import UPLOAD_PRIORITY, PoolCrashed
from rag_sidecar.parse import docling_adapter
from rag_sidecar.parse.converter import ConversionError
from rag_sidecar.preflight.config import load_routing_config

if TYPE_CHECKING:
    from rag_sidecar.ingest.process_job import JobOutcome, WorkerDeps

logger = logging.getLogger(__name__)

PREFLIGHT_PARSER = "preflight"
DOCLING_PARSER = "docling"
MERGED_PARSER = "merged"
MERGED_VERSION = "merged-v1"
PREFLIGHT_OBJECT = "preflight.json"
DOCLING_OBJECT = "docling.json"
RESULT_OBJECT = "result.json"

_STAGE_STATUS = {"preflight": "preflight", "parse": "parsing", "check": "checking", "ready": "ready"}
_TIER_RANK = {"native": 0, "fast": 1, "structured": 2, "premium": 3}
_PROFILES_PATH = Path(__file__).resolve().parents[4] / "config" / "rag" / "processing-profiles.json"
_PERMANENT_ERRORS = frozenset(
    {
        "encrypted_pdf",
        "unsupported_type",
        "unsupported_input",
        "file_missing",
        "recorded_miss",
        "no_parser_available",
        "page_cap",
        "configuration_error",
        "invalid_docling_json",
        "converter_unavailable",
        "profile_unavailable",
        "merge_invariant",
        "worker_not_configured",
    }
)
_profiles: dict[str, ProcessingProfile] | None = None


class TieredFailure(Exception):
    """A classified end of the tiered flow; the caller turns it into a ledger failure."""

    def __init__(self, error_class: str, *, retryable: bool | None = None) -> None:
        super().__init__(error_class)
        self.error_class = error_class
        self.retryable = error_class not in _PERMANENT_ERRORS if retryable is None else retryable


# -------------------------------------------------------------------------------------------------------------------------
# Cache keys
# -------------------------------------------------------------------------------------------------------------------------


def range_options(preset: str, start: int, end: int, ocr_languages: list[str], cfg: ParseRoutingConfig) -> dict[str, object]:
    """The conversion options of one page range; the page set is part of the key (D-56)."""
    from rag_sidecar.parse import presets

    options = presets.preset_option_dict(preset, cfg, ocr_languages=list(ocr_languages), pages=[start, end])
    options.pop("heading_hierarchy", None)
    options["input_format"] = "application/pdf"
    return options


def range_options_hash(preset: str, start: int, end: int, ocr_languages: list[str], cfg: ParseRoutingConfig) -> str:
    return options_hash(range_options(preset, start, end, ocr_languages, cfg))


# -------------------------------------------------------------------------------------------------------------------------
# CPU work: the pool, or a thread when there is none
# -------------------------------------------------------------------------------------------------------------------------


def _error_class_of(exc: Exception) -> str | None:
    if type(exc).__name__ == "EncryptedPdf":
        return "encrypted_pdf"
    if isinstance(exc, ConversionError):
        return exc.error_class
    return None


def _guarded(target: Callable[..., Any], *params: Any) -> tuple[Any, ...]:
    """Runs one job in a pool worker; classified errors travel as values so a pool does not turn them into a crash."""
    try:
        return ("ok", target(*params))
    except Exception as exc:  # noqa: BLE001
        error_class = _error_class_of(exc)
        if error_class is None:
            raise
        return ("err", error_class)


async def _blocking(deps: WorkerDeps, cfg: ParseRoutingConfig, priority: int, target: Callable[..., Any], *params: Any) -> Any:
    try:
        if deps.pool is None:
            outcome = await asyncio.to_thread(_guarded, target, *params)
        else:
            future = deps.pool.submit(_guarded, (target, *params), priority=priority, deadline_s=cfg.timeouts.parse_slice_ms / 1000)
            outcome = await future
    except PoolCrashed as exc:
        raise TieredFailure("pool_crashed", retryable=True) from exc
    if outcome[0] == "err":
        raise TieredFailure(outcome[1])
    return outcome[1]


def _preflight_job(preflight: Callable[..., Any], path: Path, settings: Any, cfg: ParseRoutingConfig, converter: Any, sha: str) -> Any:
    return preflight(path, settings, cfg, converter, file_sha=sha)


def _chunk_job(doc: DoclingDocument, request: ParseJobRequest, out_dir: Path, version: str, text_layer_share: float | None) -> ParseResult:
    return docling_adapter.to_parse_result(
        doc,
        request,
        out_dir,
        parser=DOCLING_PARSER,
        parser_version_text=version,
        text_layer_page_share=text_layer_share,
    )


# -------------------------------------------------------------------------------------------------------------------------
# Profile
# -------------------------------------------------------------------------------------------------------------------------


def load_profile(profile_id: str) -> ProcessingProfile:
    global _profiles
    if _profiles is None:
        try:
            raw = json.loads(_PROFILES_PATH.read_text(encoding="utf-8"))
            profile_set = ProcessingProfileSet.model_validate(raw)
        except (OSError, ValueError) as exc:
            raise TieredFailure("profile_unavailable") from exc
        _profiles = {profile.id: profile for profile in profile_set.profiles}
    profile = _profiles.get(profile_id)
    if profile is None:
        raise TieredFailure("profile_unavailable")
    return profile


def _parse_request(job: IngestionJob, profile: ProcessingProfile, input_format: str) -> ParseJobRequest:
    return ParseJobRequest(
        profile_id=profile.id,
        profile_version=profile.version,
        docling=profile.parser.docling,
        ocr_languages=list(job.settings.ocr_languages),
        tokenizer="cl100k_base",
        max_tokens=profile.chunker.max_tokens,
        repeat_table_header=profile.chunker.repeat_table_header,
        input_format=input_format,  # type: ignore[arg-type]
        page_cap=None,
    )


# -------------------------------------------------------------------------------------------------------------------------
# Per-run state
# -------------------------------------------------------------------------------------------------------------------------


@dataclass
class _RangeResult:
    page_range: PageRange
    parser: str
    version: str
    opts_hash: str
    cache_id: str
    passed: bool
    doc: DoclingDocument | None = None
    loader: Callable[[], Awaitable[DoclingDocument]] | None = None

    async def get_doc(self) -> DoclingDocument:
        if self.doc is None:
            assert self.loader is not None
            self.doc = await self.loader()
        return self.doc


@dataclass
class _Run:
    job: IngestionJob
    deps: WorkerDeps
    cfg: ParseRoutingConfig
    converter: Any
    work: Path
    path: Path
    sha: str
    bucket: str
    languages: list[str]
    docling_version: str
    last_attempt_no: int = 0
    est_cost: float = 0.0
    check_ms: int = 0
    reusable: dict[tuple[int, int], tuple[DoclingDocument, dict[str, Any]]] = field(default_factory=dict)

    def previous_attempt(self, start: int, end: int, preset: str) -> Any:
        for attempt in self.job.attempts:
            if (attempt.pages.start, attempt.pages.end, attempt.preset, attempt.reason) == (start, end, preset, "initial"):
                return attempt
        return None


def _converter_of(deps: WorkerDeps) -> Any:
    if deps.converter is not None:
        return deps.converter
    if deps.converter_factory is not None:
        try:
            return deps.converter_factory()
        except (ValueError, ConversionError) as exc:
            raise TieredFailure("converter_unavailable") from exc
    raise TieredFailure("converter_unavailable")


def _tier_cost(cfg: ParseRoutingConfig, tier: str, pages: int) -> float:
    return pages * getattr(cfg.costs.tier, tier).usd_per_page


async def _advance(
    run: _Run,
    stage: str,
    *,
    timing_ms: int | None = None,
    fields: dict[str, Any] | None = None,
    stage_state: dict[str, Any] | None = None,
) -> None:
    await run.deps.ledger.advance(
        run.job.id,
        run.deps.worker_id,
        stage=stage,
        status=_STAGE_STATUS[stage],
        stage_state=stage_state,
        timing_ms=timing_ms,
        fields=fields,
    )


async def _record_attempt(
    run: _Run,
    page_range: PageRange,
    *,
    parser: str,
    version: str,
    ms: int,
    cost: float,
    cache_hit: bool,
    check: QualityCheckResult | None,
    reason: str = "initial",
) -> None:
    attempt: dict[str, Any] = {
        "tier": page_range.tier,
        "preset": page_range.preset,
        "parser": parser,
        "parser_version": version,
        "pages": {"start": page_range.start, "end": page_range.end},
        "reason": reason,
        "ms": ms,
        "est_cost_usd": cost,
        "cache_hit": cache_hit,
        "refused": False,
    }
    if check is not None:
        attempt["check"] = check.model_dump(mode="json")
    run.last_attempt_no = await run.deps.ledger.record_attempt(run.job.id, run.deps.worker_id, attempt)
    run.est_cost += cost


# -------------------------------------------------------------------------------------------------------------------------
# Cache objects
# -------------------------------------------------------------------------------------------------------------------------


async def _entry_prefix(run: _Run, parser: str, version: str, opts_hash: str) -> str:
    prefix = await run.deps.ledger.cache_prefix(run.job.id, parser, version, opts_hash)
    if not prefix:
        raise TieredFailure("cache_prefix_unavailable", retryable=True)
    run.deps.storage.register_cache_prefix(prefix)
    return prefix


def _docling_bytes(doc: DoclingDocument, parser: str, version: str) -> bytes:
    payload = doc.export_to_dict()
    payload[docling_adapter.SIDECAR_METADATA_KEY] = {"parser": parser, "parser_version": version}
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _doc_from_bytes(data: bytes) -> DoclingDocument:
    payload = json.loads(data)
    if not isinstance(payload, dict):
        raise TieredFailure("invalid_docling_json")
    payload.pop(docling_adapter.SIDECAR_METADATA_KEY, None)
    return DoclingDocument.model_validate(payload)


async def _put_entry(
    run: _Run,
    parser: str,
    version: str,
    opts_hash: str,
    objects: list[tuple[str, bytes, str]],
    meta: dict[str, Any],
) -> Any:
    """Objects first, then the row: a reader trusts only rows (Pattern 8)."""
    prefix = await _entry_prefix(run, parser, version, opts_hash)
    total = 0
    for name, data, _content_type in objects:
        await run.deps.storage.put(run.bucket, prefix, name, data)
        total += len(data)
    result = {**meta, "artifacts": [{"name": name, "content_type": content_type} for name, _data, content_type in objects]}
    return await run.deps.ledger.cache_put(run.job.id, parser, version, opts_hash, prefix, result=result, byte_size=total)


async def _lookup(run: _Run, parser: str, version: str, opts_hash: str) -> Any:
    hits = await run.deps.ledger.cache_lookup(run.job.id, parser, version, opts_hash)
    return hits[0] if hits else None


def _entry_loader(run: _Run, entry: Any) -> Callable[[], Awaitable[DoclingDocument]]:
    async def load() -> DoclingDocument:
        data = await run.deps.storage.get_bytes(run.bucket, f"{entry.object_prefix}{DOCLING_OBJECT}")
        return _doc_from_bytes(data)

    return load


async def _put_range_entry(run: _Run, parser: str, version: str, opts_hash: str, doc: DoclingDocument) -> Any:
    return await _put_entry(
        run,
        parser,
        version,
        opts_hash,
        [(DOCLING_OBJECT, _docling_bytes(doc, parser, version), "application/json")],
        {"parser": parser, "parser_version": version, "page_count": len(doc.pages)},
    )


# -------------------------------------------------------------------------------------------------------------------------
# Preflight
# -------------------------------------------------------------------------------------------------------------------------


def _preflight_hash(job: IngestionJob) -> str:
    low = job.settings.min_tier or "none"
    high = job.settings.max_tier or "none"
    return options_hash({"preset": f"preflight:{low}:{high}", "input_format": "application/pdf"})


def _preflight_ref_ok(job: IngestionJob, sha: str, ref: str) -> bool:
    return ref.startswith(f"{job.tenant_key}/_parse-cache/{sha}/") and ref.endswith(f"/{PREFLIGHT_OBJECT}") and ".." not in ref


async def _resume_preflight(run: _Run) -> PreflightResult | None:
    """A reclaimed job reads the probe it stored before, from a path that must lie under its own tenant and file prefix."""
    ref = run.job.preflight_ref
    if not ref or not _preflight_ref_ok(run.job, run.sha, ref):
        return None
    try:
        data = await run.deps.storage.get_bytes(run.bucket, ref)
        return PreflightResult.model_validate_json(data)
    except Exception:  # noqa: BLE001 - a missing or unreadable copy only means the probe runs again
        return None


async def _run_preflight(run: _Run) -> PreflightResult:
    resumed = await _resume_preflight(run)
    if resumed is not None:
        return resumed
    preflight = run.deps.preflight
    if preflight is None:
        from rag_sidecar.preflight.run import run_preflight

        preflight = run_preflight
    started = time.perf_counter()
    output = await _blocking(
        run.deps, run.cfg, run.job.priority, _preflight_job, preflight, run.path, run.job.settings, run.cfg, run.converter, run.sha
    )
    elapsed = int((time.perf_counter() - started) * 1000)
    run.reusable = dict(output.reusable_fast)
    result: PreflightResult = output.result
    prefix = await _entry_prefix(run, PREFLIGHT_PARSER, result.probe_version, _preflight_hash(run.job))
    await run.deps.storage.put(run.bucket, prefix, PREFLIGHT_OBJECT, result.model_dump_json().encode("utf-8"))
    await _advance(run, "preflight", timing_ms=elapsed, fields={"preflight_ref": f"{prefix}{PREFLIGHT_OBJECT}"})
    return result


# -------------------------------------------------------------------------------------------------------------------------
# Range parsing
# -------------------------------------------------------------------------------------------------------------------------


def _slices(start: int, end: int, max_pages: int, priority: int) -> list[tuple[int, int]]:
    """Backfill conversions are cut into pieces of at most max_pages so an upload can run between them (A-4)."""
    if priority >= UPLOAD_PRIORITY or end - start + 1 <= max_pages:
        return [(start, end)]
    pieces: list[tuple[int, int]] = []
    cursor = start
    while cursor <= end:
        piece_end = min(cursor + max_pages - 1, end)
        pieces.append((cursor, piece_end))
        cursor = piece_end + 1
    return pieces


def _missing_runs(start: int, end: int, covered: set[int]) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    cursor: int | None = None
    for page in range(start, end + 1):
        if page in covered:
            if cursor is not None:
                runs.append((cursor, page - 1))
                cursor = None
        elif cursor is None:
            cursor = page
    if cursor is not None:
        runs.append((cursor, end))
    return runs


async def _convert_pages(run: _Run, preset: str, start: int, end: int) -> DoclingDocument:
    """Converts a page range in the pool; pages the L2 probe already converted with the fast preset are reused (A-3)."""
    parts: list[DoclingDocument] = []
    covered: set[int] = set()
    if preset == "fast":
        for (reuse_start, reuse_end), (doc, _meta) in sorted(run.reusable.items()):
            low, high = max(start, reuse_start), min(end, reuse_end)
            if low > high:
                continue
            pages = set(range(low, high + 1))
            parts.append(slice_pages(doc, pages))
            covered |= pages
    max_pages = run.cfg.ranges.max_pages_per_conversion
    for run_start, run_end in _missing_runs(start, end, covered):
        for piece_start, piece_end in _slices(run_start, run_end, max_pages, run.job.priority):
            document, _meta = await _blocking(
                run.deps,
                run.cfg,
                run.job.priority,
                run.converter.convert,
                run.path,
                run.sha,
                preset,
                piece_start,
                piece_end,
                run.job.priority,
            )
            parts.append(document)
    parts.sort(key=lambda part: min(part.pages))
    try:
        return join_page_parts(parts)
    except MergeInvariantError as exc:
        raise TieredFailure("merge_invariant", retryable=False) from exc


async def _cache_reusable(run: _Run) -> None:
    """The L2 batches are fast results of their own pages; cached once so an escalation or a retry finds them (A-3)."""
    for (start, end), (doc, _meta) in sorted(run.reusable.items()):
        opts_hash = range_options_hash("fast", start, end, run.languages, run.cfg)
        if await _lookup(run, DOCLING_PARSER, run.docling_version, opts_hash) is None:
            await _put_range_entry(run, DOCLING_PARSER, run.docling_version, opts_hash, doc)


async def _parse_docling_range(run: _Run, result: PreflightResult, page_range: PageRange, previous: _RangeResult | None) -> _RangeResult:
    preset, start, end = page_range.preset, page_range.start, page_range.end
    opts_hash = range_options_hash(preset, start, end, run.languages, run.cfg)
    version = run.docling_version
    prior = run.previous_attempt(start, end, preset)
    hit = await _lookup(run, DOCLING_PARSER, version, opts_hash)

    if hit is not None and prior is not None and prior.check is not None:
        return _RangeResult(page_range, DOCLING_PARSER, version, opts_hash, str(hit.id), prior.check.passed, loader=_entry_loader(run, hit))

    started = run.deps.clock()
    was_cached = hit is not None
    if hit is None:
        doc = await _convert_pages(run, preset, start, end)
        hit = await _put_range_entry(run, DOCLING_PARSER, version, opts_hash, doc)
    else:
        doc = await _entry_loader(run, hit)()
    boundary = False
    if previous is not None and previous.page_range.end + 1 == start:
        boundary = quality.page_has_table(await previous.get_doc(), previous.page_range.end)
    check_started = time.perf_counter()
    check = quality.check(
        doc,
        [row for row in result.pages if start <= row.page <= end],
        run.languages,
        run.cfg,
        boundary_prev_ends_in_table=boundary,
        first_page=start,
    )
    run.check_ms += int((time.perf_counter() - check_started) * 1000)
    if prior is None:
        await _record_attempt(
            run,
            page_range,
            parser=DOCLING_PARSER,
            version=version,
            ms=int((run.deps.clock() - started) * 1000),
            cost=0.0 if was_cached else _tier_cost(run.cfg, page_range.tier, end - start + 1),
            cache_hit=was_cached,
            check=check,
        )
    return _RangeResult(page_range, DOCLING_PARSER, version, opts_hash, str(hit.id), check.passed, doc=doc)


# -------------------------------------------------------------------------------------------------------------------------
# Merge and the merged entry
# -------------------------------------------------------------------------------------------------------------------------


def _content_type(name: str) -> str:
    if name.endswith(".json"):
        return "application/json"
    if name.endswith(".png"):
        return "image/png"
    return "application/octet-stream"


async def _merged_entry(run: _Run, result: PreflightResult, outcomes: list[_RangeResult], profile: ProcessingProfile) -> str:
    """The merged document of all ranges, chunked once; cached under parser ``merged`` with a hash over the ordered range entries."""
    merged_hash = merged_options_hash([(item.parser, item.version, item.opts_hash) for item in outcomes])
    version = f"{MERGED_VERSION}/{run.docling_version}/mt{profile.chunker.max_tokens}-rh{int(profile.chunker.repeat_table_header)}"
    hit = await _lookup(run, MERGED_PARSER, version, merged_hash)
    if hit is not None:
        return str(hit.id)

    docs = [await item.get_doc() for item in outcomes]
    try:
        document = docs[0] if len(docs) == 1 else merge(docs, result.page_count)
    except MergeInvariantError as exc:
        raise TieredFailure("merge_invariant", retryable=False) from exc

    request = _parse_request(run.job, profile, "pdf")
    out_dir = run.work / "merged"
    out_dir.mkdir(parents=True, exist_ok=True)
    layer_share = sum(1 for row in result.pages if row.text_layer) / max(1, len(result.pages))
    parsed: ParseResult = await _blocking(
        run.deps, run.cfg, run.job.priority, _chunk_job, document, request, out_dir, run.docling_version, layer_share
    )
    objects: list[tuple[str, bytes, str]] = [(RESULT_OBJECT, parsed.model_dump_json().encode("utf-8"), "application/json")]
    for name in parsed.artifacts:
        objects.append((name, (out_dir / name).read_bytes(), _content_type(name)))
    entry = await _put_entry(
        run,
        MERGED_PARSER,
        version,
        merged_hash,
        objects,
        {"parser": parsed.parser, "parser_version": parsed.parser_version, "page_count": parsed.page_count},
    )
    return str(entry.id)


# -------------------------------------------------------------------------------------------------------------------------
# PDF flow
# -------------------------------------------------------------------------------------------------------------------------


def _final_ranges(outcomes: list[_RangeResult]) -> list[dict[str, Any]]:
    return [
        item.page_range.model_copy(
            update={"status": "ok" if item.passed else "needs_review", "cache_id": item.cache_id, "parser": item.parser}
        ).model_dump(mode="json")
        for item in outcomes
    ]


async def _run_pdf(run: _Run) -> str | None:
    """Preflight, range parsing and the check; returns the merged cache id, or None for a dry run, which stops after checking."""
    job, deps = run.job, run.deps
    result = await _run_preflight(run)
    if deps.page_cap is not None and result.page_count > deps.page_cap:
        raise TieredFailure("page_cap", retryable=False)

    await _advance(
        run,
        "parse",
        fields={
            "doc_class": result.doc_class,
            "page_ranges": [item.model_dump(mode="json") for item in result.ranges],
            "tier_page_counts": dict(result.tier_page_counts),
            "detect_counts": result.detect_counts.model_dump(mode="json"),
            "pages": result.page_count,
        },
    )
    await _cache_reusable(run)

    outcomes: list[_RangeResult] = []
    parse_started = deps.clock() if deps.document_timeout_s is not None else 0.0
    parse_ms = 0
    for page_range in result.ranges:
        if deps.document_timeout_s is not None and deps.clock() - parse_started > deps.document_timeout_s:
            raise TieredFailure("parse_timeout", retryable=True)
        range_started = time.perf_counter()
        outcomes.append(await _parse_docling_range(run, result, page_range, outcomes[-1] if outcomes else None))
        parse_ms += int((time.perf_counter() - range_started) * 1000)

    fields: dict[str, Any] = {
        "page_ranges": _final_ranges(outcomes),
        "tier": max((item.page_range.tier for item in outcomes), key=lambda tier: _TIER_RANK[tier]),
        "parser_used": DOCLING_PARSER,
        "parser_version": run.docling_version,
        "est_cost_usd": run.est_cost,
    }
    if any(not item.passed for item in outcomes):
        fields["needs_review_reason"] = "quality_check_failed"
    await _advance(run, "parse", timing_ms=max(0, parse_ms - run.check_ms))
    await _advance(run, "check", timing_ms=run.check_ms, fields=fields)

    if job.kind == "dry_run":
        return None
    return await _merged_entry(run, result, outcomes, load_profile(job.settings.profile_id))


async def _prepare(job: IngestionJob, deps: WorkerDeps, work: Path) -> _Run:
    if deps.storage is None:
        raise TieredFailure("worker_not_configured")
    if job.original_ref is None or not job.file_sha256:
        raise TieredFailure("file_missing")
    cfg = deps.routing_cfg or load_routing_config()
    converter = _converter_of(deps)
    path = await deps.storage.download(job.original_ref, dest_dir=work)
    return _Run(
        job=job,
        deps=deps,
        cfg=cfg,
        converter=converter,
        work=work,
        path=Path(path),
        sha=job.file_sha256,
        bucket=job.original_ref.bucket,
        languages=list(job.settings.ocr_languages),
        docling_version=docling_adapter.parser_version(),
    )


def _new_work_dir(deps: WorkerDeps) -> Path:
    if deps.work_dir is not None:
        deps.work_dir.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix="rag-tiered-", dir=deps.work_dir))


async def run_tiered(job: IngestionJob, deps: WorkerDeps) -> JobOutcome:
    """Parses a PDF job under tiered routing and hands the merged entry to advance; a dry run stops after checking (D-33)."""
    from rag_sidecar.ingest.process_job import JobOutcome, _advance_until_done, _fail

    work = _new_work_dir(deps)
    try:
        run = await _prepare(job, deps, work)
        cache_id = await _run_pdf(run)
        if cache_id is None:
            await _advance(run, "ready", stage_state={"dry_run": True, "ended_at": "check"})
            return JobOutcome(status="ready")
        attempt_no = run.last_attempt_no or (job.attempts[-1].attempt_no if job.attempts else 1)
        return await _advance_until_done(deps, job, cache_id, attempt_no)
    except TieredFailure as failure:
        return await _fail(deps, job, failure.error_class, retryable=failure.retryable)
    finally:
        shutil.rmtree(work, ignore_errors=True)
