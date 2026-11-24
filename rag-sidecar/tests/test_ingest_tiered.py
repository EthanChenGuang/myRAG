"""Tiered routing in the worker (plan 03.1-40): range parsing with cache, attempts, merge, dispatch and dry runs."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("docling_core.transforms.chunker.hybrid_chunker")
pytest.importorskip("tiktoken")
pytest.importorskip("pypdfium2")
pytest.importorskip("pdfplumber")

from docling_core.types.doc import Size  # noqa: E402

from ingest_fakes import AppScript, FakeApp, FakeLedger, FakeStorage  # noqa: E402
from rag_sidecar.contracts.ingest import ParseResult  # noqa: E402
from rag_sidecar.contracts.queue import IngestionJob  # noqa: E402
from rag_sidecar.contracts.routing import (  # noqa: E402
    DetectCounts,
    PageRange,
    PageSignals,
    PreflightResult,
)
from rag_sidecar.ingest import converters, tiered  # noqa: E402
from rag_sidecar.ingest.cache_keys import merged_options_hash  # noqa: E402
from rag_sidecar.ingest.merge import MergeInvariantError, premium_part  # noqa: E402
from rag_sidecar.ingest.process_job import JobOutcome, WorkerDeps  # noqa: E402
from rag_sidecar.parse import docling_adapter  # noqa: E402
from rag_sidecar.parse.converter import ConversionError  # noqa: E402
from rag_sidecar.preflight.config import load_routing_config  # noqa: E402
from rag_sidecar.preflight.run import PreflightOutput  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
PARSE_ROOT = REPO_ROOT / "eval" / "fixtures" / "parse"
MANIFEST = json.loads((PARSE_ROOT / "manifest.json").read_text(encoding="utf-8"))
SHA = {entry["id"]: entry["sha256"] for entry in MANIFEST["fixtures"]}
PDF = {entry["id"]: REPO_ROOT / "eval" / entry["pdf_path"] for entry in MANIFEST["fixtures"]}
RECORDED = PARSE_ROOT / "recorded"
ENCRYPTED = Path(__file__).parent / "fixtures" / "preflight" / "user-password.pdf"

_JOB_ID = "00000000-0000-4000-8000-000000000040"
_DOC_ID = "00000000-0000-4000-8000-0000000000d1"
_TENANT = "u:00000000-0000-4000-8000-0000000000a1"
_WORKER = "worker-tiered"
_BUCKET = "rag-originals"
_NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
_PAGE = Size(width=600, height=800)

_STAGE_STATUS = {
    "begin": "queued",
    "preflight": "preflight",
    "parse": "parsing",
    "check": "checking",
    "ready": "ready",
    "failed": "failed",
    "needs_review": "needs_review",
}
_FIELD_WHITELIST = {
    "doc_class", "tier", "parser_used", "parser_version", "pages", "page_ranges", "tier_page_counts",
    "detect_counts", "preflight_ref", "est_cost_usd", "embedding_profile", "document_id", "needs_review_reason",
    "routing_note", "provisional_published_at", "trace_id",
}
_TERMINAL = {"ready", "failed", "quarantined", "needs_review", "skipped_duplicate"}


class StrictLedger(FakeLedger):
    """The fake ledger with the SQL rules it leaves out: stage and status must match, only whitelisted fields, fields are stored."""

    async def advance(self, job_id, worker, *, stage, status, stage_state=None, timing_ms=None, fields=None):
        assert _STAGE_STATUS.get(stage) == status, f"stage {stage} cannot carry status {status}"
        assert set(fields or {}) <= _FIELD_WHITELIST, f"fields {sorted(set(fields) - _FIELD_WHITELIST)} are not allowed"
        job = await super().advance(job_id, worker, stage=stage, status=status, stage_state=stage_state, timing_ms=timing_ms)
        if fields:
            merged = {**job.model_dump(mode="json"), **fields}
            job = IngestionJob.model_validate(merged)
        if status in _TERMINAL:
            job = job.model_copy(update={"locked_by": None, "lease_until": None, "runner": None})
        self.jobs[job_id] = job
        return job


class PathStorage(FakeStorage):
    """FakeStorage with the real client's download (a local path) and get_bytes."""

    def __init__(self, root: Path) -> None:
        super().__init__()
        self.root = root

    def seed(self, bucket: str, path: str, data: bytes) -> None:
        self.objects[(bucket, path)] = data

    async def download(self, original_ref, *, dest_dir=None):
        self.calls.append(("download", original_ref.bucket, original_ref.path))
        out = self.root / "download" / Path(original_ref.path).name
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(self.objects[(original_ref.bucket, original_ref.path)])
        return out

    async def get_bytes(self, bucket: str, path: str) -> bytes:
        self.calls.append(("get", bucket, path))
        return self.objects[(bucket, path)]


class RecordingPool:
    """Runs submitted work at once and remembers how it was submitted."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def submit(self, fn, args, *, priority, deadline_s):
        self.calls.append({"fn": fn, "args": args, "priority": priority})
        future = asyncio.get_running_loop().create_future()
        try:
            future.set_result(fn(*args))
        except BaseException as exc:  # noqa: BLE001
            future.set_exception(exc)
        return future

    def convert_calls(self) -> list[tuple[Any, ...]]:
        return [call["args"][1:] for call in self.calls if getattr(call["args"][0], "__name__", "") == "convert"]


class StepClock:
    def __init__(self, step: float = 2.0) -> None:
        self.step = step
        self.now = 0.0

    def __call__(self) -> float:
        self.now += self.step
        return self.now


class Sleeps:
    async def __call__(self, seconds: float) -> None:
        return None


class SyntheticConverter:
    """Docling parts built from text, one line per page; remembers its calls."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, int, int, int]] = []

    def convert(self, path, file_sha256, preset, start, end, priority):
        self.calls.append((preset, start, end, priority))
        return _synthetic_doc(start, end), {"preset": preset, "start": start, "end": end}


class FlakyConverter:
    """Fails once on one preset, then delegates."""

    def __init__(self, inner, preset: str) -> None:
        self.inner = inner
        self.preset = preset
        self.armed = True

    def convert(self, path, file_sha256, preset, start, end, priority):
        if self.armed and preset == self.preset:
            self.armed = False
            raise ConversionError("timeout")
        return self.inner.convert(path, file_sha256, preset, start, end, priority)


def _page_text(page: int) -> str:
    return f"Synthetic page {page} text."


def _synthetic_doc(start: int, end: int):
    pages = list(range(start, end + 1))
    return premium_part([(page, _page_text(page)) for page in pages], {page: _PAGE for page in pages})


def _synthetic_preflight(page_count: int, ranges: list[tuple[int, int, str]], reusable=None):
    rows = [
        PageSignals(
            page=page,
            chars=len(_page_text(page)),
            text_layer=True,
            image_area_ratio=0,
            ruled_tables=0,
            aligned_number_rows=0,
            multi_column=False,
            has_figure=False,
            scanned=False,
            garbled_ratio=0,
            signals=[],
            layer="L1",
            tier="fast",
            preset="fast",
            continues_to_next=False,
        )
        for page in range(1, page_count + 1)
    ]
    page_ranges = [
        PageRange(start=s, end=e, tier="fast" if preset == "fast" else "structured", preset=preset, parser="docling", layer="L1", signals=[], status="pending")
        for s, e, preset in ranges
    ]
    result = PreflightResult(
        probe_version="test",
        page_count=page_count,
        encrypted=False,
        doc_class="text_pdf",
        pages=rows,
        ranges=page_ranges,
        tier_page_counts={"native": 0, "fast": page_count, "structured": 0, "premium": 0},
        detect_counts=DetectCounts(L1=page_count, L2=0, L3=0, gated_share=0),
        timings_ms={"preflight": 1},
    )

    def run(path, settings, cfg, converter, file_sha=None):
        return PreflightOutput(result=result, reusable_fast=reusable or {})

    return run


def _settings(**overrides) -> dict:
    base = {
        "routing": "tiered",
        "cloud_allowed": True,
        "escalation": True,
        "progressive": False,
        "premium_max_pages_per_doc": 50,
        "premium_page_budget": 0,
        "vlm_detect": False,
        "profile_id": "general@1",
        "profile_version": 1,
        "doc_type": "general",
        "min_tier": "fast",
        "max_tier": "premium",
        "embed_mode": "sync",
        "ocr_languages": ["en"],
        "routing_config_version": "1",
    }
    base.update(overrides)
    return base


def _job(
    *,
    sha: str,
    kind: str = "ingest",
    filename: str = "doc.pdf",
    mime: str | None = "application/pdf",
    priority: int = 100,
    **settings,
) -> IngestionJob:
    return IngestionJob.model_validate(
        {
            "id": _JOB_ID,
            "kind": kind,
            "status": "preflight",
            "tenant_key": _TENANT,
            "document_id": None if kind == "dry_run" else _DOC_ID,
            "source": "config_upload",
            "source_key": f"root/{filename}",
            "file_sha256": sha,
            "filename": filename,
            "mime_type": mime,
            "original_ref": {"bucket": _BUCKET, "path": f"{_TENANT}/lineage/1/{filename}"},
            "priority": priority,
            "settings": _settings(**settings),
            "locked_by": _WORKER,
            "lease_until": (_NOW + timedelta(hours=1)).isoformat(),
            "created_at": _NOW.isoformat(),
            "updated_at": _NOW.isoformat(),
        }
    )


def _advance_ready() -> dict:
    return {"worker_id": _WORKER, "stage": "ready", "done": True, "status": "ready"}


class Env:
    """One job with its fakes: ledger, storage seeded with the original, app, optional pool and converter."""

    def __init__(self, tmp_path: Path, job: IngestionJob, original: bytes, **deps: Any) -> None:
        self.cfg = load_routing_config()
        self.ledger = StrictLedger()
        self.storage = PathStorage(tmp_path)
        self.app = FakeApp()
        self.app.script("advance", [AppScript(response=_advance_ready())])
        self.storage.seed(job.original_ref.bucket, job.original_ref.path, original)
        self.ledger.seed(job)
        self.claim_id = job.id
        self.claim()
        self.deps = WorkerDeps(
            ledger=self.ledger,
            app=self.app,
            worker_id=_WORKER,
            sleep=Sleeps(),
            storage=self.storage,
            routing_cfg=self.cfg,
            work_dir=tmp_path / "work",
            **deps,
        )

    def claim(self) -> None:
        job = self.ledger.jobs[self.claim_id]
        self.ledger.jobs[self.claim_id] = job.model_copy(
            update={"status": "preflight", "locked_by": _WORKER, "lease_until": self.ledger.clock.now() + timedelta(hours=1)}
        )

    @property
    def job(self) -> IngestionJob:
        return self.ledger.jobs[self.claim_id]

    def run(self) -> JobOutcome:
        return asyncio.run(tiered.run_tiered(self.job, self.deps))

    def advance_calls(self) -> list[dict[str, Any]]:
        return [call[2] for call in self.app.calls if call[0] == "advance"]


def _fixture_env(tmp_path: Path, fixture: str, **deps: Any) -> Env:
    job = _job(sha=SHA[fixture])
    deps.setdefault("converter", converters.RecordedRangeConverter(RECORDED))
    return Env(tmp_path, job, PDF[fixture].read_bytes(), **deps)


def _synthetic_env(tmp_path: Path, converter, preflight, *, priority: int = 100, pool=None, **deps: Any) -> Env:
    job = _job(sha="b" * 64, priority=priority)
    return Env(tmp_path, job, b"%PDF-1.4 synthetic", converter=converter, preflight=preflight, pool=pool, **deps)


def _merged_entries(env: Env):
    return [entry for entry in env.ledger.cache.values() if entry.parser == "merged"]


def _docling_entries(env: Env):
    return [entry for entry in env.ledger.cache.values() if entry.parser == "docling"]


def _object(env: Env, prefix: str, name: str) -> bytes:
    return env.storage.objects[(_BUCKET, f"{prefix.rstrip('/')}/{name}")]


@pytest.fixture(autouse=True)
def _reset_counter():
    converters.reset_conversion_counter()
    yield
    converters.reset_conversion_counter()


# ---------------------------------------------------------------------------------------------------------------------
# Task 1: range parsing with cache, attempts and merge
# ---------------------------------------------------------------------------------------------------------------------


def test_mixed_fixture_parses_four_ranges_records_four_initial_attempts_and_hands_one_merged_entry_to_advance(tmp_path):
    env = _fixture_env(tmp_path, "mixed-routing")

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    job = env.job
    assert [(a.pages.start, a.pages.end, a.tier, a.preset, a.reason) for a in job.attempts] == [
        (1, 6, "fast", "fast", "initial"),
        (7, 8, "structured", "structured_full", "initial"),
        (9, 9, "structured", "structured_ocr", "initial"),
        (10, 10, "fast", "fast", "initial"),
    ]
    version = docling_adapter.parser_version()
    assert all(a.parser == "docling" and a.parser_version == version for a in job.attempts)
    assert all(a.check is not None and a.cache_hit is False and a.refused is False for a in job.attempts)
    assert [(r.start, r.end, r.preset, r.status) for r in job.page_ranges] == [
        (1, 6, "fast", "ok"),
        (7, 8, "structured_full", "ok"),
        (9, 9, "structured_ocr", "ok"),
        (10, 10, "fast", "ok"),
    ]
    assert all(r.cache_id for r in job.page_ranges)
    assert job.doc_class == "tables"
    assert job.tier == "structured"
    assert job.tier_page_counts == {"native": 0, "fast": 7, "structured": 3, "premium": 0}
    assert job.detect_counts is not None and job.detect_counts.L1 == 10
    assert job.pages == 10

    merged = _merged_entries(env)
    assert len(merged) == 1
    expected = merged_options_hash(
        [
            ("docling", version, tiered.range_options_hash(preset, start, end, ["en"], env.cfg))
            for start, end, preset in [(1, 6, "fast"), (7, 8, "structured_full"), (9, 9, "structured_ocr"), (10, 10, "fast")]
        ]
    )
    assert merged[0].options_hash == expected
    result = ParseResult.model_validate_json(_object(env, merged[0].object_prefix, "result.json"))
    assert result.page_count == 10
    assert {page for chunk in result.chunks for page in chunk.pages} <= set(range(1, 11))
    firsts = [chunk.pages[0] for chunk in result.chunks if chunk.pages]
    assert firsts == sorted(firsts)
    assert result.artifacts[0] == "docling.json"
    assert ("rag-originals", f"{merged[0].object_prefix}docling.json") in env.storage.objects

    advances = env.advance_calls()
    assert len(advances) == 1
    assert advances[0]["phase"] == "post_parse"
    assert advances[0]["parse_cache_id"] == merged[0].id


def test_preflight_result_is_stored_next_to_the_parse_cache_and_referenced_from_the_job(tmp_path):
    env = _fixture_env(tmp_path, "mixed-routing")

    env.run()

    ref = env.job.preflight_ref
    assert ref is not None
    assert ref.startswith(f"{_TENANT}/_parse-cache/{SHA['mixed-routing']}/preflight-")
    assert ref.endswith("/preflight.json")
    stored = PreflightResult.model_validate_json(env.storage.objects[(_BUCKET, ref)])
    assert stored.page_count == 10
    assert [(r.start, r.end) for r in stored.ranges] == [(1, 6), (7, 8), (9, 9), (10, 10)]


def test_a_second_run_of_the_same_job_hits_the_cache_for_every_finished_range(tmp_path):
    flaky = FlakyConverter(converters.RecordedRangeConverter(RECORDED), "structured_ocr")
    env = _fixture_env(tmp_path, "mixed-routing", converter=flaky)

    first = env.run()

    assert first.status == "queued" and first.error_class == "timeout"
    assert [(a.pages.start, a.pages.end) for a in env.job.attempts] == [(1, 6), (7, 8)]
    assert _merged_entries(env) == []
    before = converters.conversion_counter

    env.ledger.clock.advance(120)
    claimed = asyncio.run(env.ledger.claim_one(_JOB_ID, worker=_WORKER))
    assert claimed is not None
    env.claim()
    second = env.run()

    assert second == JobOutcome(status="ready")
    assert converters.conversion_counter - before == 2, "only pages 9 and 10 are converted again"
    assert [(a.pages.start, a.pages.end) for a in env.job.attempts] == [(1, 6), (7, 8), (9, 9), (10, 10)]
    assert len(_merged_entries(env)) == 1
    assert len(env.advance_calls()) == 1


def test_a_finished_job_run_again_converts_nothing_and_reuses_the_merged_entry(tmp_path):
    env = _fixture_env(tmp_path, "mixed-routing")
    env.run()
    merged_id = _merged_entries(env)[0].id
    before = converters.conversion_counter

    env.claim()
    again = env.run()

    assert again == JobOutcome(status="ready")
    assert converters.conversion_counter == before
    assert len(env.job.attempts) == 4
    assert [call["parse_cache_id"] for call in env.advance_calls()] == [merged_id, merged_id]


def test_pages_that_layer_two_already_converted_with_the_fast_preset_are_cached_and_not_converted_again(tmp_path):
    reusable = {(2, 3): (_synthetic_doc(2, 3), {"preset": "fast", "start": 2, "end": 3})}
    converter = SyntheticConverter()
    env = _synthetic_env(tmp_path, converter, _synthetic_preflight(5, [(1, 5, "fast")], reusable))

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    assert [(start, end) for _preset, start, end, _priority in converter.calls] == [(1, 1), (4, 5)]
    fast_entries = {entry.options_hash for entry in _docling_entries(env)}
    assert tiered.range_options_hash("fast", 2, 3, ["en"], env.cfg) in fast_entries, "the L2 batch is a cached fast result"
    assert tiered.range_options_hash("fast", 1, 5, ["en"], env.cfg) in fast_entries
    merged = _merged_entries(env)[0]
    result = ParseResult.model_validate_json(_object(env, merged.object_prefix, "result.json"))
    assert result.page_count == 5
    for page in range(1, 6):
        assert _page_text(page) in result.markdown


def test_a_low_priority_fast_range_goes_to_the_pool_in_slices_of_24_pages_and_is_cached_as_one_entry(tmp_path):
    converter = SyntheticConverter()
    pool = RecordingPool()
    env = _synthetic_env(tmp_path, converter, _synthetic_preflight(60, [(1, 60, "fast")]), priority=10, pool=pool)

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    convert_calls = pool.convert_calls()
    assert [(call[3], call[4]) for call in convert_calls] == [(1, 24), (25, 48), (49, 60)]
    assert all(call[5] == 10 for call in convert_calls)
    assert all(call["priority"] == 10 for call in pool.calls)
    docling = _docling_entries(env)
    assert len(docling) == 1
    assert docling[0].options_hash == tiered.range_options_hash("fast", 1, 60, ["en"], env.cfg)
    assert len(env.job.attempts) == 1 and (env.job.attempts[0].pages.start, env.job.attempts[0].pages.end) == (1, 60)


def test_an_upload_range_is_converted_in_one_piece(tmp_path):
    converter = SyntheticConverter()
    env = _synthetic_env(tmp_path, converter, _synthetic_preflight(60, [(1, 60, "fast")]), priority=100)

    env.run()

    assert [(start, end) for _preset, start, end, _priority in converter.calls] == [(1, 60)]


def test_every_attempt_has_its_cost_from_the_routing_file_and_its_ms_from_the_clock(tmp_path):
    env = _fixture_env(tmp_path, "mixed-routing")
    env.deps = WorkerDeps(**{**env.deps.__dict__, "clock": StepClock(2.0)})

    env.run()

    for attempt in env.job.attempts:
        pages = attempt.pages.end - attempt.pages.start + 1
        per_page = getattr(env.cfg.costs.tier, attempt.tier).usd_per_page
        assert attempt.est_cost_usd == pytest.approx(pages * per_page)
        assert attempt.ms == 2000
    assert env.job.est_cost_usd == pytest.approx(sum(a.est_cost_usd for a in env.job.attempts))


def test_a_single_range_document_skips_the_merge_but_still_hands_over_a_cached_entry(tmp_path, monkeypatch):
    def boom(parts, n_pages):
        raise AssertionError("merge must not run for one range")

    monkeypatch.setattr(tiered, "merge", boom)
    env = _fixture_env(tmp_path, "digital-text")

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    assert len(env.job.attempts) == 1
    merged = _merged_entries(env)
    assert len(merged) == 1
    assert env.advance_calls()[0]["parse_cache_id"] == merged[0].id


def test_a_merge_invariant_failure_fails_the_job_without_a_retry(tmp_path, monkeypatch):
    def bad_merge(parts, n_pages):
        raise MergeInvariantError("merge_invariant:gap_or_order")

    monkeypatch.setattr(tiered, "merge", bad_merge)
    env = _fixture_env(tmp_path, "mixed-routing")

    outcome = env.run()

    assert outcome == JobOutcome(status="failed", error_class="merge_invariant")
    assert env.job.status == "failed"
    assert env.advance_calls() == []


def test_every_object_written_stays_under_the_tenant_cache_prefix_of_the_file(tmp_path):
    env = _fixture_env(tmp_path, "mixed-routing")

    env.run()

    prefix = f"{_TENANT}/_parse-cache/{SHA['mixed-routing']}/"
    puts = [call for call in env.storage.calls if call[0] == "put"]
    assert puts
    assert all(call[2].startswith(prefix) for call in puts)
    assert not [call for call in puts if "/" in call[3]]


def test_the_page_cap_fails_a_document_without_a_retry(tmp_path):
    env = _fixture_env(tmp_path, "mixed-routing", page_cap=5)

    outcome = env.run()

    assert outcome == JobOutcome(status="failed", error_class="page_cap")
    assert env.advance_calls() == []
    assert not [call for call in env.storage.calls if call[0] == "put" and "docling" in call[3]]


def test_the_document_timeout_fails_between_ranges_with_a_retryable_error(tmp_path):
    env = _fixture_env(tmp_path, "mixed-routing", document_timeout_s=1.0)
    env.deps = WorkerDeps(**{**env.deps.__dict__, "clock": StepClock(2.0)})

    outcome = env.run()

    assert outcome.status == "queued" and outcome.error_class == "parse_timeout"
    assert len(env.job.attempts) <= 1


def test_cache_objects_are_written_with_upsert_so_a_resumed_job_can_write_them_again():
    import httpx

    from rag_sidecar.ingest.storage_client import StorageClient

    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("x-upsert"))
        return httpx.Response(200)

    async def run() -> None:
        client = StorageClient(
            base_url="https://example.supabase.co",
            service_key="sb_secret_placeholder_value_for_tests",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        client.register_cache_prefix("tenant/_parse-cache/hash/parser/")
        await client.put("rag-originals", "tenant/_parse-cache/hash/parser/", "docling.json", b"{}")
        await client.aclose()

    asyncio.run(run())

    assert seen == ["true"]


# ---------------------------------------------------------------------------------------------------------------------
# Task 2: dispatch by routing and type, and dry-run jobs
# ---------------------------------------------------------------------------------------------------------------------

_CACHE_ID = "00000000-0000-4000-8000-0000000000c1"
_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


def _process(env: Env) -> JobOutcome:
    from rag_sidecar.ingest.process_job import process_job

    return asyncio.run(process_job(env.job, env.deps))


def _native_done(text: str = "# Notes\n\nThe teal ledger lists every cart.") -> dict:
    return {"worker_id": _WORKER, "status": "done", "cache_id": _CACHE_ID, "pages": [{"page": 1, "text": text, "has_table": False}]}


class OfficeConverter:
    def __init__(self, pages: int = 2) -> None:
        self.pages = pages
        self.calls: list[tuple[str, str, list[str]]] = []

    def __call__(self, path, preset, ocr_languages):
        self.calls.append((Path(path).name, preset, list(ocr_languages)))
        return _synthetic_doc(1, self.pages)


def _plain_env(tmp_path: Path, filename: str, mime: str, **deps: Any) -> Env:
    job = _job(sha="c" * 64, filename=filename, mime=mime)
    return Env(tmp_path, job, b"original bytes", **deps)


class ExplodingStorage:
    def __getattr__(self, name):
        raise AssertionError(f"fixed routing must not use storage ({name})")


def test_fixed_routing_keeps_the_chain_path_and_never_touches_storage_the_pool_or_the_converter(tmp_path):
    job = _job(sha="c" * 64, routing="fixed")
    env = Env(tmp_path, job, b"%PDF-1.4", pool=RecordingPool())
    env.deps = WorkerDeps(**{**env.deps.__dict__, "storage": ExplodingStorage()})
    env.app.script("parse_external", [AppScript(response={"worker_id": _WORKER, "status": "done", "cache_id": _CACHE_ID})])

    outcome = _process(env)

    assert outcome == JobOutcome(status="ready")
    assert [call[2]["mode"] for call in env.app.calls if call[0] == "parse_external"] == ["chain"]
    assert [attempt.reason for attempt in env.job.attempts] == ["fixed_chain"]
    assert env.deps.pool.calls == []


def test_a_tiered_markdown_file_goes_to_parse_external_native_and_never_to_storage(tmp_path):
    env = _plain_env(tmp_path, "notes.md", "text/markdown")
    env.app.script("parse_external", [AppScript(response=_native_done())])

    outcome = _process(env)

    assert outcome == JobOutcome(status="ready")
    calls = [call[2] for call in env.app.calls if call[0] == "parse_external"]
    assert len(calls) == 1
    assert calls[0]["mode"] == "native" and calls[0]["subpdf_ref"] is None and calls[0]["pages"] is None
    assert len(calls[0]["options_hash"]) == 64
    assert [call for call in env.storage.calls if call[0] in ("download", "put")] == []
    (attempt,) = env.job.attempts
    assert (attempt.tier, attempt.preset, attempt.reason, attempt.parser) == ("native", "native", "native", "plain_text")
    assert (attempt.pages.start, attempt.pages.end) == (1, 1)
    assert attempt.check is not None and attempt.check.passed
    assert [(r.start, r.end, r.tier, r.status, r.cache_id) for r in env.job.page_ranges] == [(1, 1, "native", "ok", _CACHE_ID)]
    assert env.job.doc_class == "native" and env.job.tier == "native"
    assert env.advance_calls()[0]["parse_cache_id"] == _CACHE_ID


@pytest.mark.parametrize("filename,mime", [("scan.png", "image/png"), ("photo.JPG", "image/jpeg")])
def test_a_tiered_image_goes_to_native_captioning(tmp_path, filename, mime):
    env = _plain_env(tmp_path, filename, mime)
    env.app.script("parse_external", [AppScript(response=_native_done("A dock with teal carts."))])

    outcome = _process(env)

    assert outcome == JobOutcome(status="ready")
    assert [call[2]["mode"] for call in env.app.calls if call[0] == "parse_external"] == ["native"]
    (attempt,) = env.job.attempts
    assert (attempt.tier, attempt.parser, attempt.parser_version) == ("native", "text", "image")
    assert env.job.doc_class == "image"


@pytest.mark.parametrize("filename,mime,pages", [("report.docx", _DOCX, 2), ("page.html", "text/html", 1)])
def test_tiered_docx_and_html_are_converted_in_process_as_one_native_range(tmp_path, filename, mime, pages):
    office = OfficeConverter(pages)
    env = _plain_env(tmp_path, filename, mime, office_converter=office)

    outcome = _process(env)

    assert outcome == JobOutcome(status="ready")
    assert office.calls == [(filename, "fast", ["en"])]
    assert [call for call in env.app.calls if call[0] == "parse_external"] == []
    (attempt,) = env.job.attempts
    assert (attempt.tier, attempt.preset, attempt.parser, attempt.reason) == ("native", "native", "docling", "initial")
    assert (attempt.pages.start, attempt.pages.end) == (1, pages)
    assert [(r.start, r.end, r.preset, r.parser) for r in env.job.page_ranges] == [(1, pages, "native", "docling")]
    merged = _merged_entries(env)
    assert len(merged) == 1
    assert env.advance_calls()[0]["parse_cache_id"] == merged[0].id
    assert env.job.doc_class == "native" and env.job.tier == "native"


def test_a_tiered_pptx_is_one_structured_range(tmp_path):
    office = OfficeConverter(3)
    env = _plain_env(tmp_path, "deck.pptx", _PPTX, office_converter=office)

    outcome = _process(env)

    assert outcome == JobOutcome(status="ready")
    assert office.calls == [("deck.pptx", "structured_layout", ["en"])]
    (attempt,) = env.job.attempts
    assert (attempt.tier, attempt.preset) == ("structured", "structured_layout")
    assert [(r.start, r.end, r.tier) for r in env.job.page_ranges] == [(1, 3, "structured")]
    assert env.job.tier == "structured"


def test_a_tiered_pdf_goes_through_the_page_range_flow(tmp_path):
    env = _fixture_env(tmp_path, "digital-text")

    outcome = _process(env)

    assert outcome == JobOutcome(status="ready")
    assert [attempt.reason for attempt in env.job.attempts] == ["initial"]
    assert [call[2]["mode"] for call in env.app.calls if call[0] == "parse_external"] == []


def test_an_encrypted_pdf_fails_at_once_and_is_not_retried(tmp_path):
    job = _job(sha="d" * 64)
    env = Env(tmp_path, job, ENCRYPTED.read_bytes(), converter=converters.RecordedRangeConverter(RECORDED))

    outcome = _process(env)

    assert outcome == JobOutcome(status="failed", error_class="encrypted_pdf")
    assert env.job.status == "failed" and env.job.retries == 1
    assert env.advance_calls() == []
    assert [call for call in env.storage.calls if call[0] == "put"] == []


def test_a_file_type_nothing_can_parse_fails_without_a_retry(tmp_path):
    env = _plain_env(tmp_path, "archive.zip", "application/zip")

    outcome = _process(env)

    assert outcome == JobOutcome(status="failed", error_class="unsupported_type")
    assert env.job.status == "failed"


def test_a_dry_run_stops_after_checking_records_its_attempts_and_publishes_nothing(tmp_path):
    job = _job(sha=SHA["mixed-routing"], kind="dry_run")
    env = Env(tmp_path, job, PDF["mixed-routing"].read_bytes(), converter=converters.RecordedRangeConverter(RECORDED))

    outcome = _process(env)

    assert outcome == JobOutcome(status="ready")
    assert env.advance_calls() == [], "no post_parse advance for a dry run"
    done = env.job
    assert done.status == "ready" and done.document_id is None
    assert done.stage_state == {"dry_run": True, "ended_at": "check"}
    assert isinstance(done.timings.get("check"), int)
    assert [(a.pages.start, a.pages.end, a.preset) for a in done.attempts] == [
        (1, 6, "fast"),
        (7, 8, "structured_full"),
        (9, 9, "structured_ocr"),
        (10, 10, "fast"),
    ]
    assert all(a.check is not None for a in done.attempts)
    assert [(r.start, r.end, r.preset, r.status) for r in done.page_ranges] == [
        (1, 6, "fast", "ok"),
        (7, 8, "structured_full", "ok"),
        (9, 9, "structured_ocr", "ok"),
        (10, 10, "fast", "ok"),
    ]
    assert done.tier_page_counts == {"native": 0, "fast": 7, "structured": 3, "premium": 0}
    assert done.preflight_ref
    assert _merged_entries(env) == []
    assert len(_docling_entries(env)) == 4, "the parse results stay in the cache"


def test_a_dry_run_of_a_text_file_records_a_native_attempt_without_calling_the_app(tmp_path):
    job = _job(sha="c" * 64, kind="dry_run", filename="notes.md", mime="text/markdown")
    env = Env(tmp_path, job, b"# Notes")

    outcome = _process(env)

    assert outcome == JobOutcome(status="ready")
    assert env.app.calls == []
    assert [(a.tier, a.reason) for a in env.job.attempts] == [("native", "native")]
    assert env.job.status == "ready" and env.job.doc_class == "native"


# ---------------------------------------------------------------------------------------------------------------------
# Wiring: the worker loop and the one-shot runner hand the tiered dependencies to process_job
# ---------------------------------------------------------------------------------------------------------------------


class _WorkerSettings:
    ingest_worker_concurrency = 1
    worker_id = "sidecar-test"
    page_cap = 123

    def build_range_converter(self):
        return "converter"


def test_the_ingest_worker_hands_its_storage_pool_and_converter_factory_to_process_job(monkeypatch):
    import random

    from rag_sidecar.ingest import worker as worker_module

    seen: list[WorkerDeps] = []

    async def fake_process_job(job, deps):
        seen.append(deps)
        return JobOutcome(status="ready")

    monkeypatch.setattr(worker_module, "process_job", fake_process_job)
    storage, pool = object(), object()
    ingest_worker = worker_module.IngestWorker(
        _WorkerSettings(), FakeLedger(), storage, FakeApp(), pool, worker_module.RealClock(), random.Random(1)
    )

    asyncio.run(ingest_worker._execute(_job(sha="c" * 64)))

    (deps,) = seen
    assert deps.storage is storage and deps.pool is pool
    assert deps.page_cap == 123
    assert deps.converter_factory is not None and deps.converter_factory() == "converter"


def test_run_once_hands_its_storage_and_converter_factory_to_process_job(monkeypatch):
    from rag_sidecar.ingest import run_once as run_once_module

    seen: list[WorkerDeps] = []

    async def fake_process_job(job, deps):
        seen.append(deps)
        return JobOutcome(status="ready")

    monkeypatch.setattr(run_once_module, "process_job", fake_process_job)
    ledger = FakeLedger()
    ledger.seed(_job(sha="c" * 64).model_copy(update={"status": "queued", "locked_by": None, "lease_until": None}))
    storage = object()

    code = asyncio.run(
        run_once_module.run_once(
            _JOB_ID,
            ledger=ledger,
            app=FakeApp(),
            worker_id=_WORKER,
            storage=storage,
            converter_factory=lambda: "converter",
            page_cap=77,
            heartbeat_seconds=3600,
        )
    )

    assert code == 0
    (deps,) = seen
    assert deps.storage is storage and deps.page_cap == 77 and deps.converter_factory() == "converter"
