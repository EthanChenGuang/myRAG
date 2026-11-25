"""Progressive mode in the worker (plan 03.1-43, D-30): eligibility and the provisional run before the routed one."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

pytest.importorskip("docling_core.transforms.chunker.hybrid_chunker")
pytest.importorskip("tiktoken")
pytest.importorskip("pypdfium2")
pytest.importorskip("pdfplumber")

from ingest_fakes import AppScript
from test_ingest_tiered import (
    _WORKER,
    Env,
    SyntheticConverter,
    _advance_ready,
    _job,
    _merged_entries,
    _page_text,
    _settings,
)

from rag_sidecar.contracts.queue import JobSettingsSnapshot
from rag_sidecar.contracts.routing import (
    DetectCounts,
    PageRange,
    PageSignals,
    PreflightResult,
)
from rag_sidecar.ingest import progressive
from rag_sidecar.ingest.process_job import JobOutcome
from rag_sidecar.preflight.run import PreflightOutput

_PRESET = {"fast": "fast", "structured": "structured_full"}


def _preflight(pages: list[tuple[str, bool]]) -> PreflightResult:
    """One (tier, text_layer) per page; one range per page; the signals match the synthetic pages so no page escalates."""
    counts = {"native": 0, "fast": 0, "structured": 0, "premium": 0}
    for tier, _layer in pages:
        counts[tier] += 1
    return PreflightResult(
        probe_version="test",
        page_count=len(pages),
        encrypted=False,
        doc_class="tables",
        pages=[
            PageSignals(
                page=index,
                chars=len(_page_text(index)) if layer else 0,
                text_layer=layer,
                image_area_ratio=0 if layer else 1,
                ruled_tables=0,
                aligned_number_rows=0,
                multi_column=False,
                has_figure=False,
                scanned=False,
                garbled_ratio=0,
                signals=[],
                layer="L1",
                tier=tier,
                preset=_PRESET[tier],
                continues_to_next=False,
            )
            for index, (tier, layer) in enumerate(pages, start=1)
        ],
        ranges=[
            PageRange(
                start=index,
                end=index,
                tier=tier,
                preset=_PRESET[tier],
                parser="docling",
                layer="L1",
                signals=[],
                status="pending",
            )
            for index, (tier, _layer) in enumerate(pages, start=1)
        ],
        tier_page_counts=counts,
        detect_counts=DetectCounts(L1=len(pages), L2=0, L3=0, gated_share=0),
        timings_ms={},
    )


def _snapshot(**overrides) -> JobSettingsSnapshot:
    return JobSettingsSnapshot.model_validate(
        _settings(**{"progressive": True, **overrides})
    )


_MIXED = _preflight(
    [("fast", True)] * 6
    + [("structured", True)] * 2
    + [("structured", False), ("fast", True)]
)


def test_eligible_needs_progressive_an_incremental_job_a_page_above_fast_and_half_the_pages_with_text():
    assert progressive.eligible(_MIXED, _snapshot(), "incremental") is True
    assert progressive.eligible(_MIXED, _snapshot(), "backfill") is False
    assert (
        progressive.eligible(_MIXED, _snapshot(progressive=False), "incremental")
        is False
    )
    assert (
        progressive.eligible(
            _preflight([("fast", True)] * 4), _snapshot(), "incremental"
        )
        is False
    )
    assert (
        progressive.eligible(
            _preflight([("structured", True)] * 2 + [("structured", False)] * 2),
            _snapshot(),
            "incremental",
        )
        is True
    )
    assert (
        progressive.eligible(
            _preflight([("structured", True)] + [("structured", False)] * 2),
            _snapshot(),
            "incremental",
        )
        is False
    )


def test_job_kind_is_incremental_only_for_an_ingest_job_outside_a_batch():
    job = _job(sha="b" * 64)
    assert progressive.job_kind(job) == "incremental"
    assert (
        progressive.job_kind(
            job.model_copy(update={"batch_id": "00000000-0000-4000-8000-0000000000b9"})
        )
        == "backfill"
    )
    assert (
        progressive.job_kind(job.model_copy(update={"kind": "dry_run"})) == "backfill"
    )


def _env(
    tmp_path: Path, preflight: PreflightResult, *, advance: list[dict], **settings
) -> Env:
    job = _job(sha="b" * 64, **settings)
    env = Env(
        tmp_path,
        job,
        b"%PDF-1.4 synthetic",
        converter=SyntheticConverter(),
        preflight=lambda path, snapshot, cfg, converter, file_sha=None: PreflightOutput(
            result=preflight, reusable_fast={}
        ),
    )
    env.app.script("advance", [AppScript(response=response) for response in advance])
    return env


def _provisional_done() -> dict:
    return {"worker_id": _WORKER, "stage": "provisional", "done": True}


def test_an_eligible_job_publishes_the_fast_parse_provisionally_then_hands_over_the_routed_result(
    tmp_path,
):
    env = _env(
        tmp_path,
        _MIXED,
        advance=[_provisional_done(), _advance_ready()],
        progressive=True,
    )

    assert env.run() == JobOutcome(status="ready")

    calls = env.advance_calls()
    assert [call["provisional"] for call in calls] == [True, False]
    assert calls[0]["parse_cache_id"] != calls[1]["parse_cache_id"]
    attempts = env.job.attempts
    assert (
        attempts[0].reason,
        attempts[0].preset,
        attempts[0].pages.start,
        attempts[0].pages.end,
    ) == ("progressive_fast", "fast", 1, 10)
    assert [a.reason for a in attempts[1:]] == ["initial"] * (len(attempts) - 1)
    assert len(_merged_entries(env)) == 2, (
        "the provisional and the routed merged entries"
    )


def test_a_provisional_run_that_ends_the_job_skips_the_routed_run(tmp_path):
    quarantined = {
        "worker_id": _WORKER,
        "stage": "quarantined",
        "done": True,
        "status": "quarantined",
    }
    env = _env(tmp_path, _MIXED, advance=[quarantined], progressive=True)

    assert env.run() == JobOutcome(status="quarantined")
    assert [call["provisional"] for call in env.advance_calls()] == [True]
    assert [a.reason for a in env.job.attempts] == ["progressive_fast"]


def test_a_job_that_already_published_provisionally_runs_only_the_routed_flow(tmp_path):
    env = _env(tmp_path, _MIXED, advance=[_advance_ready()], progressive=True)
    env.ledger.jobs[env.claim_id] = env.job.model_copy(
        update={"provisional_published_at": datetime(2026, 1, 1, tzinfo=UTC)}
    )

    assert env.run() == JobOutcome(status="ready")
    assert [call["provisional"] for call in env.advance_calls()] == [False]
    assert all(a.reason == "initial" for a in env.job.attempts)


@pytest.mark.parametrize(
    "settings", [{"progressive": False}, {"progressive": True, "batch": True}]
)
def test_progressive_off_or_a_backfill_job_publishes_once(tmp_path, settings):
    batch = settings.pop("batch", False)
    env = _env(tmp_path, _MIXED, advance=[_advance_ready()], **settings)
    if batch:
        env.ledger.jobs[env.claim_id] = env.job.model_copy(
            update={"batch_id": "00000000-0000-4000-8000-0000000000b9"}
        )

    assert env.run() == JobOutcome(status="ready")
    assert [call["provisional"] for call in env.advance_calls()] == [False]
    assert all(a.reason == "initial" for a in env.job.attempts)


def test_the_routed_run_after_a_provisional_one_still_escalates_failing_pages(tmp_path):
    rows = list(_MIXED.pages)
    rows[0] = rows[0].model_copy(update={"ruled_tables": 1})
    preflight = _MIXED.model_copy(update={"pages": rows})
    env = _env(
        tmp_path,
        preflight,
        advance=[_provisional_done(), _advance_ready()],
        progressive=True,
        cloud_allowed=False,
    )

    assert env.run() == JobOutcome(status="ready")
    assert [call["provisional"] for call in env.advance_calls()] == [True, False]
    attempts = env.job.attempts
    assert attempts[0].reason == "progressive_fast"
    escalated = [a for a in attempts if a.reason == "escalation"]
    assert escalated and all((a.pages.start, a.pages.end) == (1, 1) for a in escalated)
    assert all(a.reason != "progressive_fast" for a in attempts[1:])
