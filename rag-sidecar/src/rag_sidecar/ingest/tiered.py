"""Tiered routing in the worker: preflight, range parsing with cache, quality check, escalation, merge (D-12, D-15, D-53, D-56).

Under tiered routing a PDF is probed (L1 and L2) in the pool, split into page ranges by the page tiers, and every range is parsed
at its own preset: fast and structured ranges by Docling in the priority pool. Each range is one parse-cache entry; the ranges
are checked, and each run of failing pages climbs the ladder one step at a time (``escalation``), re-parsing only those pages.
The kept result of every page is merged in page order into one Docling document, chunked once and cached as the ``merged``
entry that ``advance`` reads. Nothing here writes a document row or a chunk (D-06).
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

from docling_core.types.doc import DoclingDocument, Size

from rag_sidecar.contracts.ingest import ParseJobRequest, ParseResult, ProcessingProfile
from rag_sidecar.contracts.queue import IngestionJob, ParseAttemptPages, ParseExternalRequest
from rag_sidecar.contracts.routing import (
    PageRange,
    ParseRoutingConfig,
    PreflightResult,
    QualityCheckResult,
    QualityScoreWeights,
)
from rag_sidecar.ingest import escalation, progressive, quality
from rag_sidecar.ingest.cache_keys import chunker_key, effective_repeat_table_header, merged_options_hash, options_hash
from rag_sidecar.ingest.escalation import EscalationUnit, PageAttempt
from rag_sidecar.ingest.merge import MergeInvariantError, join_page_parts, merge, premium_part, slice_pages
from rag_sidecar.ingest.pool import UPLOAD_PRIORITY, PoolCrashed
from rag_sidecar.parse import docling_adapter
from rag_sidecar.parse.converter import ConversionError
from rag_sidecar.preflight.config import RagConfigMissing, load_processing_profiles, load_routing_config

if TYPE_CHECKING:
    from rag_sidecar.ingest.process_job import JobOutcome, WorkerDeps

logger = logging.getLogger(__name__)

PREFLIGHT_PARSER = "preflight"
DOCLING_PARSER = "docling"
MERGED_PARSER = "merged"
MERGED_VERSION = "merged-v1"
PREMIUM_PARSER = "llamaparse"
PREMIUM_PART_PARSER = "llamaparse_part"
PREMIUM_PART_VERSION = "premium-part-v1"
PREFLIGHT_OBJECT = "preflight.json"
DOCLING_OBJECT = "docling.json"
RESULT_OBJECT = "result.json"

_STAGE_STATUS = {"preflight": "preflight", "parse": "parsing", "check": "checking", "ready": "ready"}
_TIER_RANK = {"native": 0, "fast": 1, "structured": 2, "premium": 3}
_DEFAULT_LADDER = ["fast", "structured", "premium"]
_PRESET_RANK = {"native": 0, "fast": 1, "structured_layout": 2, "structured_full": 3, "structured_ocr": 4, "premium": 5}
_MAX_PREMIUM_POLLS = 400
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
        "unsupported_mode",
        "original_unavailable",
        "premium_pages_unavailable",
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
    except Exception as exc:
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


def _preflight_job(
    preflight: Callable[..., Any], path: Path, settings: Any, cfg: ParseRoutingConfig, converter: Any, sha: str, vlm_app: Any = None
) -> Any:
    if vlm_app is None:
        return preflight(path, settings, cfg, converter, file_sha=sha)
    return preflight(path, settings, cfg, converter, file_sha=sha, vlm_app=vlm_app)


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
            profile_set = load_processing_profiles()
        except RagConfigMissing as exc:
            logger.error("[RAG Ingest] processing profiles missing: %s", exc)
            raise TieredFailure("profile_unavailable") from exc
        except (OSError, ValueError) as exc:
            raise TieredFailure("profile_unavailable") from exc
        _profiles = {profile.id: profile for profile in profile_set.profiles}
    profile = _profiles.get(profile_id)
    if profile is None:
        raise TieredFailure("profile_unavailable")
    return profile


def _parse_request(job: IngestionJob, profile: ProcessingProfile, input_format: str | None) -> ParseJobRequest:
    return ParseJobRequest(
        profile_id=profile.id,
        profile_version=profile.version,
        docling=profile.parser.docling,
        ocr_languages=list(job.settings.ocr_languages),
        tokenizer="cl100k_base",
        max_tokens=profile.chunker.max_tokens,
        # D-22: the snapshot's repeat_table_header_effective, else the profile's flag.
        repeat_table_header=effective_repeat_table_header(job.settings, profile),
        input_format=input_format,  # type: ignore[arg-type]
        page_cap=None,
        carry_table_header=job.settings.carry_table_header,
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
    key_parser: str = ""
    blocked: str | None = None
    check: QualityCheckResult | None = None
    reason: str = "initial"

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
    converter: Any = None
    work: Path = Path(".")
    path: Path = Path(".")
    sha: str = ""
    bucket: str = ""
    languages: list[str] = field(default_factory=list)
    docling_version: str = ""
    last_attempt_no: int = 0
    est_cost: float = 0.0
    check_ms: int = 0
    reusable: dict[tuple[int, int], tuple[DoclingDocument, dict[str, Any]]] = field(default_factory=dict)
    # The hidden-text report made at preflight (D-33); None while the snapshot has the check off.
    hidden_text_report: Any = None

    def previous_attempt(self, start: int, end: int | None, preset: str, reason: str = "initial") -> Any:
        """The attempt an earlier run of this job recorded for the same pages, so a reclaimed job does not record it twice."""
        for attempt in self.job.attempts:
            if (attempt.pages.start, attempt.preset, attempt.reason) != (start, preset, reason):
                continue
            if end is None or attempt.pages.end == end:
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
    refused: bool = False,
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
        "refused": refused,
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


async def _put_range_entry(
    run: _Run, parser: str, version: str, opts_hash: str, doc: DoclingDocument, *, doc_parser: str | None = None
) -> Any:
    """``parser`` is the cache key; ``doc_parser`` is the parser the document's own metadata names (a premium part is llamaparse)."""
    named = doc_parser or parser
    return await _put_entry(
        run,
        parser,
        version,
        opts_hash,
        [(DOCLING_OBJECT, _docling_bytes(doc, named, version), "application/json")],
        {"parser": named, "parser_version": version, "page_count": len(doc.pages)},
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


def _vlm_app(run: _Run) -> Any:
    """The L3 bridge for this job, or None when the snapshot does not ask for L3 (vlm_detect, tiered, cloud allowed, budget).

    Preflight runs in a pool thread; the bridge hands each detect-vlm call back to this loop, which owns the app client.
    """
    from rag_sidecar.preflight.l3 import LoopVlmApp, l3_enabled

    if run.cfg.l3.max_pages_per_doc <= 0 or not l3_enabled(run.job.settings):
        return None
    if getattr(run.deps.app, "detect_vlm", None) is None:
        return None
    attempt_no = max(run.last_attempt_no, len(run.job.attempts)) + 1
    return LoopVlmApp(run.deps.app, run.job.id, run.deps.worker_id, attempt_no, asyncio.get_running_loop())


async def _run_preflight(run: _Run) -> PreflightResult:
    resumed = await _resume_preflight(run)
    if resumed is not None:
        return resumed
    preflight = run.deps.preflight
    if preflight is None:
        from rag_sidecar.preflight.run import run_preflight

        preflight = run_preflight
    vlm_app = _vlm_app(run)
    started = time.perf_counter()
    output = await _blocking(
        run.deps, run.cfg, run.job.priority, _preflight_job, preflight, run.path, run.job.settings, run.cfg, run.converter, run.sha, vlm_app
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


def _table_before(previous: _RangeResult | None, start: int) -> Callable[[], Awaitable[bool]]:
    """Whether the range just before ``start`` ends in a table (D-52); read only when the range is checked."""

    async def probe() -> bool:
        if previous is None or previous.page_range.end + 1 != start:
            return False
        return quality.page_has_table(await previous.get_doc(), previous.page_range.end)

    return probe


async def _parse_docling_range(
    run: _Run,
    result: PreflightResult,
    page_range: PageRange,
    table_before: Callable[[], Awaitable[bool]],
    *,
    reason: str = "initial",
) -> _RangeResult:
    preset, start, end = page_range.preset, page_range.start, page_range.end
    opts_hash = range_options_hash(preset, start, end, run.languages, run.cfg)
    version = run.docling_version
    prior = run.previous_attempt(start, end, preset, reason)
    hit = await _lookup(run, DOCLING_PARSER, version, opts_hash)

    if hit is not None and prior is not None and prior.check is not None:
        return _RangeResult(
            page_range, DOCLING_PARSER, version, opts_hash, str(hit.id), prior.check.passed,
            loader=_entry_loader(run, hit), check=prior.check, reason=reason,
        )

    started = run.deps.clock()
    was_cached = hit is not None
    if hit is None:
        doc = await _convert_pages(run, preset, start, end)
        hit = await _put_range_entry(run, DOCLING_PARSER, version, opts_hash, doc)
    else:
        doc = await _entry_loader(run, hit)()
    boundary = await table_before()
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
            reason=reason,
        )
    return _RangeResult(page_range, DOCLING_PARSER, version, opts_hash, str(hit.id), check.passed, doc=doc, check=check, reason=reason)


# -------------------------------------------------------------------------------------------------------------------------
# Premium ranges
# -------------------------------------------------------------------------------------------------------------------------


class _PremiumRefused(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _page_sizes(path: Path, pages: list[int]) -> dict[int, Size]:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(path))
    try:
        sizes: dict[int, Size] = {}
        for page in pages:
            width, height = pdf[page - 1].get_size()
            sizes[page] = Size(width=width, height=height)
        return sizes
    finally:
        pdf.close()


async def _premium_request(run: _Run, page_range: PageRange, pages: list[int], opts_hash: str) -> list[Any]:
    """Cuts the premium pages into a sub-PDF, stores it under the cache prefix and asks the app to parse it (guard, budget, polling)."""
    from rag_sidecar.ingest.subpdf import cut_subpdf

    deps, job = run.deps, run.job
    start, end = page_range.start, page_range.end
    name = f"premium-{start}-{end}.pdf"
    sub_path = run.work / name
    await _blocking(deps, run.cfg, job.priority, cut_subpdf, run.path, pages, sub_path)
    prefix = await _entry_prefix(run, "premium_subpdf", "v1", opts_hash)
    await deps.storage.put(run.bucket, prefix, name, sub_path.read_bytes())
    reference = f"{prefix}{name}"
    cursor = json.dumps({"original_pages": pages, "reserve_pages": len(pages)})
    attempt_no = max(run.last_attempt_no, len(job.attempts)) + 1
    continuation: str | None = None
    for _ in range(_MAX_PREMIUM_POLLS):
        response = await deps.app.parse_external(
            job.id,
            ParseExternalRequest(
                worker_id=deps.worker_id,
                attempt_no=attempt_no,
                mode="premium",
                pages=ParseAttemptPages(start=start, end=end),
                subpdf_ref=reference,
                options_hash=opts_hash,
                continuation=continuation,
                cursor=cursor,
            ),
        )
        if response.status == "pending":
            continuation = response.continuation
            await deps.sleep((response.retry_after_ms or 0) / 1000)
            continue
        if response.status == "refused":
            raise _PremiumRefused(response.reason or "refused")
        if response.status == "failed":
            raise TieredFailure(response.error_class or "parse_failed")
        if not response.pages:
            raise TieredFailure("premium_pages_unavailable")
        return list(response.pages)
    raise TieredFailure("parse_timeout", retryable=True)


def _premium_options_hash(start: int, end: int) -> str:
    return options_hash({"preset": "premium", "pages": [start, end], "input_format": "application/pdf"})


async def _premium_attempt(
    run: _Run,
    result: PreflightResult,
    page_range: PageRange,
    *,
    reason: str,
    refusal: str | None = None,
) -> _RangeResult | str:
    """One premium parse of a page range through parse-external, or the refusal that kept it local.

    ``refusal`` is the worker's own refusal from the job snapshot (D-18: the worker does not propose premium when the snapshot
    forbids it); no request is made then. A refusal is recorded as a refused attempt.
    """
    start, end = page_range.start, page_range.end
    pages = list(range(start, end + 1))
    opts_hash = _premium_options_hash(start, end)
    prior = run.previous_attempt(start, end, "premium", reason)
    hit = await _lookup(run, PREMIUM_PART_PARSER, PREMIUM_PART_VERSION, opts_hash)
    if hit is not None and prior is not None and not prior.refused and prior.check is not None:
        return _RangeResult(
            page_range, PREMIUM_PARSER, PREMIUM_PART_VERSION, opts_hash, str(hit.id), prior.check.passed,
            key_parser=PREMIUM_PART_PARSER, loader=_entry_loader(run, hit), check=prior.check, reason=reason,
        )

    started = run.deps.clock()
    was_cached = hit is not None
    if hit is None:
        if refusal is None:
            try:
                text_pages = await _premium_request(run, page_range, pages, opts_hash)
            except _PremiumRefused as refused:
                refusal = refused.reason
        if refusal is not None:
            if prior is None or not prior.refused:
                await _record_attempt(
                    run, page_range, parser=PREMIUM_PARSER, version=PREMIUM_PART_VERSION,
                    ms=int((run.deps.clock() - started) * 1000), cost=0.0, cache_hit=False, check=None, reason=reason, refused=True,
                )
            return refusal
        sizes = await asyncio.to_thread(_page_sizes, run.path, pages)
        doc = premium_part([(item.page, item.text) for item in sorted(text_pages, key=lambda item: item.page)], sizes)
        hit = await _put_range_entry(run, PREMIUM_PART_PARSER, PREMIUM_PART_VERSION, opts_hash, doc, doc_parser=PREMIUM_PARSER)
    else:
        doc = await _entry_loader(run, hit)()

    check_started = time.perf_counter()
    check = quality.check(doc, [row for row in result.pages if start <= row.page <= end], run.languages, run.cfg, first_page=start)
    run.check_ms += int((time.perf_counter() - check_started) * 1000)
    if prior is None or prior.refused:
        await _record_attempt(
            run, page_range, parser=PREMIUM_PARSER, version=PREMIUM_PART_VERSION,
            ms=int((run.deps.clock() - started) * 1000),
            cost=0.0 if was_cached else _tier_cost(run.cfg, "premium", len(pages)),
            cache_hit=was_cached, check=check, reason=reason,
        )
    return _RangeResult(
        page_range, PREMIUM_PARSER, PREMIUM_PART_VERSION, opts_hash, str(hit.id), check.passed,
        doc=doc, key_parser=PREMIUM_PART_PARSER, check=check, reason=reason,
    )


async def _parse_premium_range(
    run: _Run,
    result: PreflightResult,
    page_range: PageRange,
    table_before: Callable[[], Awaitable[bool]],
    refusal: str | None,
) -> _RangeResult:
    """A premium range becomes a Docling part with the original page numbers; a blocked range is parsed structured instead (D-16)."""
    outcome = await _premium_attempt(run, result, page_range, reason="initial", refusal=refusal)
    if not isinstance(outcome, str):
        return outcome
    lower = page_range.model_copy(update={"tier": "structured", "preset": "structured_full", "parser": DOCLING_PARSER})
    lowered = await _parse_docling_range(run, result, lower, table_before)
    lowered.blocked = outcome
    return lowered


def _snapshot_refusal(run: _Run, ranges: list[PageRange]) -> str | None:
    """The refusal the job snapshot already implies for the document's premium pages: cloud off, or more pages than the cap."""
    premium_pages = sum(item.end - item.start + 1 for item in ranges if item.preset == "premium")
    if premium_pages == 0:
        return None
    settings = run.job.settings
    if not settings.cloud_allowed:
        return escalation.CLOUD_NOT_ALLOWED
    if premium_pages > settings.premium_max_pages_per_doc:
        return escalation.OVER_PAGE_CAP
    return None


# -------------------------------------------------------------------------------------------------------------------------
# Escalation (D-15, D-16, D-52)
# -------------------------------------------------------------------------------------------------------------------------


@dataclass
class _History:
    """Every attempt each page has seen, in order, and the result behind each attempt number."""

    weights: QualityScoreWeights
    pages: dict[int, list[PageAttempt]] = field(default_factory=dict)
    results: dict[int, _RangeResult] = field(default_factory=dict)
    seq: int = 0

    def add(self, outcome: _RangeResult) -> None:
        if outcome.blocked is not None:
            self.refuse(outcome.page_range.start, outcome.page_range.end, outcome.blocked, outcome.reason)
        self.seq += 1
        self.results[self.seq] = outcome
        rows = {row.page: tuple(row.failed) for row in outcome.check.pages} if outcome.check is not None else {}
        missing: tuple[str, ...] = ("partial_conversion",) if outcome.check is not None else ()
        for page in range(outcome.page_range.start, outcome.page_range.end + 1):
            failed = rows.get(page, missing)
            self.pages.setdefault(page, []).append(
                PageAttempt(
                    seq=self.seq,
                    tier=outcome.page_range.tier,
                    preset=outcome.page_range.preset,
                    reason=outcome.reason,
                    failed=failed,
                    score=escalation.page_score(failed, self.weights),
                )
            )

    def refuse(self, start: int, end: int, refusal: str, reason: str) -> None:
        self.seq += 1
        for page in range(start, end + 1):
            self.pages.setdefault(page, []).append(PageAttempt(seq=self.seq, tier="premium", preset="premium", reason=reason, refused=refusal))

    def kept(self, page: int) -> PageAttempt | None:
        return escalation.choose_kept({page: self.pages.get(page, [])}).get(page)

    def table_before(self, start: int) -> Callable[[], Awaitable[bool]]:
        async def probe() -> bool:
            kept = self.kept(start - 1)
            if kept is None:
                return False
            return quality.page_has_table(await self.results[kept.seq].get_doc(), start - 1)

        return probe

    def flag(self, page: int, seq: int, condition: str) -> None:
        attempts = self.pages[page]
        for index, attempt in enumerate(attempts):
            if attempt.seq == seq and condition not in attempt.failed:
                failed = (*attempt.failed, condition)
                attempts[index] = PageAttempt(
                    seq=attempt.seq, tier=attempt.tier, preset=attempt.preset, reason=attempt.reason, failed=failed,
                    score=escalation.page_score(failed, self.weights), refused=attempt.refused,
                )


async def _table_continues(run: _Run, result: PreflightResult, history: _History, outcome: _RangeResult) -> None:
    """D-52 repeats until the table ends: after a pulled page, the next page with numeric rows and no table is pulled too."""
    end = outcome.page_range.end
    page = end + 1
    rows = {row.page: row for row in result.pages}
    if page not in history.pages or page not in rows or rows[page].aligned_number_rows <= 0:
        return
    if any(attempt.reason == escalation.TABLE_BOUNDARY for attempt in history.pages[page]):
        return
    kept = history.kept(page)
    if kept is None or not kept.passed or _PRESET_RANK[kept.preset] >= _PRESET_RANK[outcome.page_range.preset]:
        return
    if not quality.page_has_table(await outcome.get_doc(), end):
        return
    if quality.page_has_table(await history.results[kept.seq].get_doc(), page):
        return
    history.flag(page, kept.seq, escalation.TABLE_BOUNDARY)


async def _run_unit(run: _Run, result: PreflightResult, history: _History, unit: EscalationUnit) -> None:
    source = history.results[unit.source_seq].page_range
    premium = unit.preset == "premium"
    page_range = PageRange(
        start=unit.start,
        end=unit.end,
        tier=unit.tier,  # type: ignore[arg-type]
        preset=unit.preset,  # type: ignore[arg-type]
        parser=PREMIUM_PARSER if premium else DOCLING_PARSER,
        layer=source.layer,
        signals=list(source.signals),
        status="pending",
    )
    if premium:
        outcome = await _premium_attempt(run, result, page_range, reason=unit.reason)
        if isinstance(outcome, str):
            history.refuse(unit.start, unit.end, outcome, unit.reason)
            return
    else:
        outcome = await _parse_docling_range(run, result, page_range, history.table_before(unit.start), reason=unit.reason)
    history.add(outcome)
    if unit.reason == escalation.TABLE_BOUNDARY:
        await _table_continues(run, result, history, outcome)


async def _escalate(run: _Run, result: PreflightResult, history: _History, timed_out: Callable[[], bool]) -> dict[int, str]:
    """Re-parses failing pages one ladder step at a time until nothing is left to try; returns the blocked pages (D-15)."""
    ladder = run.cfg.ladder.get("pdf", _DEFAULT_LADDER)
    max_per_page = run.cfg.escalation.max_per_page
    blocked: dict[int, str] = {}
    for _round in range(max_per_page + result.page_count + 2):
        plan = escalation.plan_escalations(history.pages, run.job.settings, ladder, max_per_page=max_per_page)
        blocked = dict(plan.blocked)
        if not plan.units:
            break
        for unit in plan.units:
            if timed_out():
                raise TieredFailure("parse_timeout", retryable=True)
            await _run_unit(run, result, history, unit)
    return blocked


# -------------------------------------------------------------------------------------------------------------------------
# Merge and the merged entry
# -------------------------------------------------------------------------------------------------------------------------


def _content_type(name: str) -> str:
    if name.endswith(".json"):
        return "application/json"
    if name.endswith(".png"):
        return "image/png"
    return "application/octet-stream"


@dataclass(frozen=True)
class _Part:
    """Pages start..end of one result: the whole range, or the slice of it a page's kept result comes from."""

    result: _RangeResult
    start: int
    end: int

    @property
    def whole(self) -> bool:
        return (self.start, self.end) == (self.result.page_range.start, self.result.page_range.end)

    def cache_entry(self) -> tuple[str, str, str]:
        item = self.result
        opts_hash = item.opts_hash if self.whole else f"{item.opts_hash}#{self.start}-{self.end}"
        return (item.key_parser or item.parser, item.version, opts_hash)

    async def get_doc(self) -> DoclingDocument:
        doc = await self.result.get_doc()
        return doc if self.whole else slice_pages(doc, range(self.start, self.end + 1))


async def _merged_entry(
    run: _Run,
    parts: list[_Part],
    profile: ProcessingProfile,
    *,
    page_count: int,
    text_layer_share: float | None,
    input_format: str | None,
) -> str:
    """The merged document of the kept parts, chunked once; cached under parser ``merged`` with a hash over the ordered parts."""
    merged_hash = merged_options_hash([part.cache_entry() for part in parts])
    version = f"{MERGED_VERSION}/{run.docling_version}/{chunker_key(run.job.settings, profile)}"
    hit = await _lookup(run, MERGED_PARSER, version, merged_hash)
    if hit is not None:
        return str(hit.id)

    docs = [await part.get_doc() for part in parts]
    try:
        document = docs[0] if len(docs) == 1 else merge(docs, page_count)
    except MergeInvariantError as exc:
        raise TieredFailure("merge_invariant", retryable=False) from exc

    request = _parse_request(run.job, profile, input_format)
    out_dir = run.work / "merged"
    out_dir.mkdir(parents=True, exist_ok=True)
    parsed: ParseResult = await _blocking(
        run.deps, run.cfg, run.job.priority, _chunk_job, document, request, out_dir, run.docling_version, text_layer_share
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


def _kept_parts(history: _History, kept: dict[int, PageAttempt], page_count: int) -> list[_Part]:
    """Consecutive pages kept from the same attempt form one part (D-15, D-56)."""
    parts: list[_Part] = []
    for page in range(1, page_count + 1):
        result = history.results[kept[page].seq]
        last = parts[-1] if parts else None
        if last is not None and last.result is result and last.end + 1 == page:
            parts[-1] = _Part(result, last.start, page)
        else:
            parts.append(_Part(result, page, page))
    return parts


def _page_status(page: int, kept: PageAttempt, review: escalation.ReviewOutcome) -> str:
    if page in review.needs_review:
        return "needs_review"
    if kept.reason in (escalation.ESCALATION, escalation.TABLE_BOUNDARY):
        return "escalated"
    return "ok"


def _final_ranges(
    result: PreflightResult, history: _History, kept: dict[int, PageAttempt], review: escalation.ReviewOutcome
) -> list[dict[str, Any]]:
    """The final per-page state, run-length encoded (D-55): the kept result's tier, preset, parser and cache entry, and a status."""
    origin = {page: item for item in result.ranges for page in range(item.start, item.end + 1)}
    rows: list[dict[str, Any]] = []
    for page in range(1, result.page_count + 1):
        attempt = kept[page]
        outcome = history.results[attempt.seq]
        row = origin[page].model_copy(
            update={
                "start": page,
                "end": page,
                "tier": outcome.page_range.tier,
                "preset": outcome.page_range.preset,
                "parser": outcome.parser,
                "status": _page_status(page, attempt, review),
                "cache_id": outcome.cache_id,
            }
        ).model_dump(mode="json")
        previous = rows[-1] if rows else None
        if previous is not None and {k: v for k, v in previous.items() if k not in ("start", "end")} == {
            k: v for k, v in row.items() if k not in ("start", "end")
        }:
            previous["end"] = page
        else:
            rows.append(row)
    return rows


async def _hand_over(
    run: _Run,
    parts: list[_Part],
    *,
    page_ranges: list[dict[str, Any]],
    review_fields: dict[str, Any],
    parse_ms: int,
    page_count: int,
    text_layer_share: float | None,
    input_format: str | None,
) -> str | None:
    """Records the final ranges and the check, then returns the merged cache id; a dry run stops here and returns None (D-33)."""
    fields: dict[str, Any] = {
        "page_ranges": page_ranges,
        "tier": max((part.result.page_range.tier for part in parts), key=lambda tier: _TIER_RANK[tier]),
        "parser_used": DOCLING_PARSER,
        "parser_version": run.docling_version,
        "est_cost_usd": run.est_cost,
        **review_fields,
    }
    await _advance(run, "parse", timing_ms=max(0, parse_ms - run.check_ms))
    await _advance(run, "check", timing_ms=run.check_ms, fields=fields)
    if run.job.kind == "dry_run":
        return None
    return await _merged_entry(
        run,
        parts,
        load_profile(run.job.settings.profile_id),
        page_count=page_count,
        text_layer_share=text_layer_share,
        input_format=input_format,
    )


# -------------------------------------------------------------------------------------------------------------------------
# PDF flow
# -------------------------------------------------------------------------------------------------------------------------


def text_layer_share(result: PreflightResult) -> float:
    return sum(1 for row in result.pages if row.text_layer) / max(1, len(result.pages))


async def _hidden_text(run: _Run) -> Any:
    from rag_sidecar.ingest.process_job import hidden_text_preflight

    return await hidden_text_preflight(run.deps, run.job, run.path)


async def _run_pdf(run: _Run) -> str | None:
    """Preflight, range parsing, the check and escalation; returns the merged cache id, or None for a dry run."""
    deps = run.deps
    result = await _run_preflight(run)
    if deps.page_cap is not None and result.page_count > deps.page_cap:
        raise TieredFailure("page_cap", retryable=False)
    run.hidden_text_report = await _hidden_text(run)

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
    if run.job.provisional_published_at is None and progressive.eligible(result, run.job.settings, progressive.job_kind(run.job)):
        await progressive.publish_provisional(run, result)

    parse_started = deps.clock() if deps.document_timeout_s is not None else 0.0

    def timed_out() -> bool:
        return deps.document_timeout_s is not None and deps.clock() - parse_started > deps.document_timeout_s

    refusal = _snapshot_refusal(run, list(result.ranges))
    outcomes: list[_RangeResult] = []
    parse_clock = time.perf_counter()
    for page_range in result.ranges:
        if timed_out():
            raise TieredFailure("parse_timeout", retryable=True)
        previous = outcomes[-1] if outcomes else None
        table_before = _table_before(previous, page_range.start)
        if page_range.preset == "premium":
            outcomes.append(await _parse_premium_range(run, result, page_range, table_before, refusal))
        else:
            outcomes.append(await _parse_docling_range(run, result, page_range, table_before))

    history = _History(run.cfg.quality.score_weights)
    for outcome in outcomes:
        history.add(outcome)
    blocked = await _escalate(run, result, history, timed_out)
    parse_ms = int((time.perf_counter() - parse_clock) * 1000)

    kept = escalation.choose_kept(history.pages)
    review = escalation.review(history.pages, blocked)
    review_fields: dict[str, Any] = {}
    if review.reason is not None:
        review_fields["needs_review_reason"] = review.reason
    if review.routing_note is not None:
        review_fields["routing_note"] = review.routing_note

    layer_share = text_layer_share(result)
    return await _hand_over(
        run,
        _kept_parts(history, kept, result.page_count),
        page_ranges=_final_ranges(result, history, kept, review),
        review_fields=review_fields,
        parse_ms=parse_ms,
        page_count=result.page_count,
        text_layer_share=layer_share,
        input_format="pdf",
    )


# -------------------------------------------------------------------------------------------------------------------------
# Other types: native in the app, office files in the worker
# -------------------------------------------------------------------------------------------------------------------------

_TEXT_EXTENSIONS = frozenset({"txt", "md", "markdown", "csv"})
_IMAGE_EXTENSIONS = frozenset({"png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"})
_MIME_EXTENSIONS = {
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "text/html": "html",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
}
_MAX_NATIVE_POLLS = 400


def _kind_of_extension(ext: str, cfg: ParseRoutingConfig) -> str | None:
    if ext == "pdf":
        return "pdf"
    if ext in _TEXT_EXTENSIONS:
        return "native_text"
    if ext in _IMAGE_EXTENSIONS:
        return "image"
    office = cfg.office_formats.get(ext)
    if office == "native":
        return "office_native"
    if office == "structured":
        return "office_structured"
    return None


def classify_input(job: IngestionJob, cfg: ParseRoutingConfig) -> tuple[str, str] | None:
    """The parse path of a file and its extension: pdf, native_text, image, office_native or office_structured (D-12)."""
    name = (job.filename or "").lower()
    ext = name.rsplit(".", 1)[-1] if "." in name else ""
    ext = "html" if ext == "htm" else ext
    mime = (job.mime_type or "").split(";")[0].strip().lower()
    mime_ext = _MIME_EXTENSIONS.get(mime, "")
    if mime_ext in _TEXT_EXTENSIONS:
        # A text MIME wins over the name: a Config UI image caption is text/markdown under the image's filename.
        return "native_text", ext if ext in _TEXT_EXTENSIONS else mime_ext
    kind = _kind_of_extension(ext, cfg)
    if kind is None and mime:
        ext = "image" if mime.startswith("image/") else _MIME_EXTENSIONS.get(mime, "")
        kind = "image" if ext == "image" else _kind_of_extension(ext, cfg)
    return None if kind is None else (kind, ext)


async def _native_parse(run: _Run) -> tuple[str, list[Any] | None]:
    """Asks the app to parse a text or image file (parse-external native) and returns its cache id and page texts."""
    deps, job = run.deps, run.job
    fmt = job.mime_type or "application/octet-stream"
    opts = options_hash({"preset": "native", "pages": "all", "input_format": fmt})
    continuation: str | None = None
    for _ in range(_MAX_NATIVE_POLLS):
        response = await deps.app.parse_external(
            job.id,
            ParseExternalRequest(worker_id=deps.worker_id, attempt_no=1, mode="native", options_hash=opts, continuation=continuation),
        )
        if response.status == "pending":
            continuation = response.continuation
            await deps.sleep((response.retry_after_ms or 0) / 1000)
            continue
        if response.status == "refused":
            raise TieredFailure(response.reason or "refused", retryable=False)
        if response.status == "failed":
            raise TieredFailure(response.error_class or "parse_failed")
        assert response.cache_id is not None
        return response.cache_id, response.pages
    raise TieredFailure("parse_timeout", retryable=True)


def _bare_run(job: IngestionJob, deps: WorkerDeps, cfg: ParseRoutingConfig) -> _Run:
    return _Run(job=job, deps=deps, cfg=cfg, languages=list(job.settings.ocr_languages))


async def _run_native_app(job: IngestionJob, deps: WorkerDeps, cfg: ParseRoutingConfig, kind: str) -> JobOutcome:
    """txt, md and csv, and images: the app parses them (native mode); the worker records the attempt and the check."""
    from rag_sidecar.ingest.process_job import JobOutcome, _advance_until_done

    run = _bare_run(job, deps, cfg)
    image = kind == "image"
    parser, version = ("text", "image") if image else ("plain_text", "native")
    page_range = PageRange(start=1, end=1, tier="native", preset="native", parser=parser, layer="L1", signals=[], status="pending")
    await _advance(
        run,
        "parse",
        fields={
            "doc_class": "image" if image else "native",
            "page_ranges": [page_range.model_dump(mode="json")],
            "tier_page_counts": {"native": 1, "fast": 0, "structured": 0, "premium": 0},
            "pages": 1,
        },
    )
    dry = job.kind == "dry_run"
    started = deps.clock()
    cache_id: str | None = None
    check: QualityCheckResult | None = None
    if not dry:
        cache_id, pages = await _native_parse(run)
        if pages:
            check_started = time.perf_counter()
            check = quality.check_text_pages(
                [quality.TextPage(page=item.page, text=item.text, has_table=item.has_table) for item in pages],
                [],
                run.languages,
                cfg,
            )
            run.check_ms = int((time.perf_counter() - check_started) * 1000)
    if run.previous_attempt(1, 1, "native", "native") is None:
        await _record_attempt(
            run,
            page_range,
            parser=parser,
            version=version,
            ms=int((deps.clock() - started) * 1000),
            cost=0.0 if dry else _tier_cost(cfg, "native", 1),
            cache_hit=False,
            check=check,
            reason="native",
        )
    passed = check is None or check.passed
    fields: dict[str, Any] = {
        "page_ranges": [page_range.model_copy(update={"status": "ok" if passed else "needs_review", "cache_id": cache_id}).model_dump(mode="json")],
        "tier": "native",
        "parser_used": parser,
        "parser_version": version,
        "est_cost_usd": run.est_cost,
    }
    if not passed:
        fields["needs_review_reason"] = "quality_check_failed"
    await _advance(run, "check", timing_ms=run.check_ms, fields=fields)
    if dry or cache_id is None:
        await _advance(run, "ready", stage_state={"dry_run": True, "ended_at": "check"})
        return JobOutcome(status="ready")
    return await _advance_until_done(deps, job, cache_id, run.last_attempt_no or (job.attempts[-1].attempt_no if job.attempts else 1))


def _office_convert(path: Path, preset: str, ocr_languages: list[str]) -> DoclingDocument:
    return docling_adapter.convert_whole(path, preset, list(ocr_languages))


async def _run_office(job: IngestionJob, deps: WorkerDeps, cfg: ParseRoutingConfig, kind: str, ext: str, work: Path) -> JobOutcome:
    """docx and html as one native range, pptx and xlsx as one structured range, converted in the worker with Docling (D-12)."""
    from rag_sidecar.ingest.process_job import JobOutcome, _advance_until_done

    run = await _prepare(job, deps, work, cfg=cfg, need_converter=False)
    run.hidden_text_report = await _hidden_text(run)
    structured = kind == "office_structured"
    tier, preset, convert_preset = ("structured", "structured_layout", "structured_layout") if structured else ("native", "native", "fast")
    opts_hash = options_hash({"preset": preset, "pages": "all", "input_format": job.mime_type or ext})
    version = run.docling_version
    await _advance(run, "parse", fields={"doc_class": "layout" if structured else "native"})

    prior = run.previous_attempt(1, None, preset)
    hit = await _lookup(run, DOCLING_PARSER, version, opts_hash)
    started = deps.clock()
    parse_started = time.perf_counter()
    was_cached = hit is not None
    if hit is not None and prior is not None and prior.check is not None:
        doc: DoclingDocument | None = None
        page_count = prior.pages.end
        passed = prior.check.passed
        loader = _entry_loader(run, hit)
    else:
        convert = deps.office_converter or _office_convert
        if hit is None:
            doc = await _blocking(deps, cfg, job.priority, convert, run.path, convert_preset, run.languages)
            hit = await _put_range_entry(run, DOCLING_PARSER, version, opts_hash, doc)
        else:
            doc = await _entry_loader(run, hit)()
        page_count = max(1, max(doc.pages, default=0))
        check_started = time.perf_counter()
        check = quality.check(doc, [], run.languages, cfg, first_page=1)
        run.check_ms = int((time.perf_counter() - check_started) * 1000)
        passed = check.passed
        loader = None
        if prior is None:
            page_range = PageRange(start=1, end=page_count, tier=tier, preset=preset, parser=DOCLING_PARSER, layer="L1", signals=[], status="pending")  # type: ignore[arg-type]
            await _record_attempt(
                run,
                page_range,
                parser=DOCLING_PARSER,
                version=version,
                ms=int((deps.clock() - started) * 1000),
                cost=0.0 if was_cached else _tier_cost(cfg, tier, page_count),
                cache_hit=was_cached,
                check=check,
            )
    parse_ms = int((time.perf_counter() - parse_started) * 1000)
    page_range = PageRange(start=1, end=page_count, tier=tier, preset=preset, parser=DOCLING_PARSER, layer="L1", signals=[], status="pending")  # type: ignore[arg-type]
    await _advance(
        run,
        "parse",
        fields={
            "page_ranges": [page_range.model_dump(mode="json")],
            "tier_page_counts": {name: (page_count if name == tier else 0) for name in ("native", "fast", "structured", "premium")},
            "pages": page_count,
        },
    )
    outcome = _RangeResult(page_range, DOCLING_PARSER, version, opts_hash, str(hit.id), passed, doc=doc, loader=loader)
    input_format = ext if ext in ("docx", "html") else None
    final = page_range.model_copy(update={"status": "ok" if passed else "needs_review", "cache_id": outcome.cache_id, "parser": DOCLING_PARSER})
    cache_id = await _hand_over(
        run,
        [_Part(outcome, 1, page_count)],
        page_ranges=[final.model_dump(mode="json")],
        review_fields={} if passed else {"needs_review_reason": escalation.QUALITY_CHECK_FAILED},
        parse_ms=parse_ms,
        page_count=page_count,
        text_layer_share=None,
        input_format=input_format,
    )
    if cache_id is None:
        await _advance(run, "ready", stage_state={"dry_run": True, "ended_at": "check"})
        return JobOutcome(status="ready")
    return await _advance_until_done(
        deps,
        job,
        cache_id,
        run.last_attempt_no or (job.attempts[-1].attempt_no if job.attempts else 1),
        hidden_text_report=run.hidden_text_report,
    )


# -------------------------------------------------------------------------------------------------------------------------
# Entry
# -------------------------------------------------------------------------------------------------------------------------


async def _prepare(job: IngestionJob, deps: WorkerDeps, work: Path, *, cfg: ParseRoutingConfig, need_converter: bool) -> _Run:
    if deps.storage is None:
        raise TieredFailure("worker_not_configured")
    if job.original_ref is None or not job.file_sha256:
        raise TieredFailure("file_missing")
    converter = _converter_of(deps) if need_converter else None
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
    """Parses a job under tiered routing by file type and hands the cached result to advance; a dry run stops after checking (D-33)."""
    from rag_sidecar.ingest.process_job import JobOutcome, _advance_until_done, _fail

    cfg = deps.routing_cfg or load_routing_config()
    classified = classify_input(job, cfg)
    if classified is None:
        return await _fail(deps, job, "unsupported_type", retryable=False)
    kind, ext = classified
    work = _new_work_dir(deps)
    try:
        if kind in ("native_text", "image"):
            return await _run_native_app(job, deps, cfg, kind)
        if kind in ("office_native", "office_structured"):
            return await _run_office(job, deps, cfg, kind, ext, work)
        run = await _prepare(job, deps, work, cfg=cfg, need_converter=True)
        cache_id = await _run_pdf(run)
        if cache_id is None:
            await _advance(run, "ready", stage_state={"dry_run": True, "ended_at": "check"})
            return JobOutcome(status="ready")
        attempt_no = run.last_attempt_no or (job.attempts[-1].attempt_no if job.attempts else 1)
        return await _advance_until_done(deps, job, cache_id, attempt_no, hidden_text_report=run.hidden_text_report)
    except progressive.ProgressiveEnded as ended:
        return ended.outcome
    except TieredFailure as failure:
        return await _fail(deps, job, failure.error_class, retryable=failure.retryable)
    finally:
        shutil.rmtree(work, ignore_errors=True)
