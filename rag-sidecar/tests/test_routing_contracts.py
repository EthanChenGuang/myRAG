import base64
from datetime import datetime, timezone
from typing import get_args

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.queue import (
    JobStatus,
    AdvanceRequest,
    AdvanceResponse,
    DetectVlmPageImage,
    DetectVlmPageResult,
    DetectVlmRequest,
    DetectVlmResponse,
    IngestionJob,
    JobSettingsSnapshot,
    ParseExternalRequest,
    ParseExternalResponse,
    ParseExternalPageText,
    REQUEST_BODY_MODELS,
    request_bodies_must_not_carry_tenant,
)
from rag_sidecar.contracts.routing import (
    DetectCounts,
    PageCheck,
    PageRange,
    PageSignals,
    PageStructureVerdict,
    ParseAttempt,
    ParseAttemptPages,
    ParseRoutingConfig,
    PreflightResult,
    QualityCheckResult,
    default_parse_routing_config,
)
from rag_sidecar.contracts.parse_eval import BackfillManifestEntry

_JOB_ID = "00000000-0000-4000-8000-000000000001"
_DOC_ID = "00000000-0000-4000-8000-000000000002"
_NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
_TINY_PNG = base64.b64encode(b"\x89PNG" + b"\x00" * 16).decode("ascii")


def _page(page: int, **changes) -> PageSignals:
    base = {
        "page": page,
        "chars": 120,
        "text_layer": True,
        "image_area_ratio": 0.0,
        "ruled_tables": 0,
        "aligned_number_rows": 0,
        "multi_column": False,
        "has_figure": False,
        "scanned": False,
        "garbled_ratio": 0.01,
        "signals": [],
        "layer": "L1",
        "tier": "fast",
        "preset": "fast",
        "continues_to_next": False,
    }
    base.update(changes)
    return PageSignals.model_validate(base)


def _range(start: int, end: int, **changes) -> PageRange:
    base = {
        "start": start,
        "end": end,
        "tier": "fast",
        "preset": "fast",
        "parser": "docling",
        "layer": "L1",
        "signals": [],
        "status": "pending",
    }
    base.update(changes)
    return PageRange.model_validate(base)


def _preflight(page_count: int = 2) -> PreflightResult:
    pages = [_page(index) for index in range(1, page_count + 1)]
    ranges = [_range(1, page_count)]
    return PreflightResult(
        probe_version="2026.1",
        page_count=page_count,
        encrypted=False,
        doc_class="text_pdf",
        pages=pages,
        ranges=ranges,
        tier_page_counts={"native": 0, "fast": page_count, "structured": 0, "premium": 0},
        detect_counts=DetectCounts(L1=page_count, L2=0, L3=0, gated_share=0.0),
        timings_ms={"preflight": 12},
    )


def _settings() -> JobSettingsSnapshot:
    return JobSettingsSnapshot(
        routing="tiered",
        cloud_allowed=True,
        escalation=True,
        progressive=False,
        premium_max_pages_per_doc=50,
        premium_page_budget=0,
        vlm_detect=False,
        profile_id="general@1",
        profile_version=1,
        doc_type="general",
        min_tier="fast",
        max_tier="premium",
        embed_mode="sync",
        ocr_languages=["en"],
        routing_config_version="1",
    )


def _ingestion_job() -> IngestionJob:
    attempt = ParseAttempt(
        attempt_no=1,
        tier="fast",
        preset="fast",
        parser="docling",
        parser_version="2.0",
        pages=ParseAttemptPages(start=1, end=2),
        reason="initial",
        ms=40,
        est_cost_usd=0.002,
        cache_hit=False,
        refused=False,
        check=QualityCheckResult(passed=True, pages=[], score=1.0, partial=False),
    )
    return IngestionJob(
        id=_JOB_ID,
        kind="ingest",
        status="parsing",
        stage="parse",
        tenant_key="u:tenant-a",
        document_id=_DOC_ID,
        source="upload",
        source_key="docs/a.pdf",
        settings=_settings(),
        attempts=[attempt],
        page_ranges=[_range(1, 2, status="ok")],
        tier_page_counts={"fast": 2},
        stage_state={"parse": {"cursor": "0"}},
        timings={"preflight": 20, "parse": 45},
        created_at=_NOW,
        updated_at=_NOW,
    )


class TestRoutingContracts:
    def test_default_parse_routing_config_parses(self):
        assert default_parse_routing_config().l1.garbled_ratio == 0.05
        assert default_parse_routing_config().l3.max_pages_per_doc == 20

    def test_page_signals_rejects_page_zero(self):
        with pytest.raises(ValidationError):
            _page(0)

    def test_page_signals_rejects_garbled_outside_unit_interval(self):
        with pytest.raises(ValidationError):
            _page(1, garbled_ratio=1.1)

    @pytest.mark.parametrize("signal", ["tables", "multi_col", "garbled"])
    def test_page_signals_accepts_listed_signal_values(self, signal):
        assert signal in _page(1, signals=[signal]).signals

    def test_page_range_rejects_inverted_bounds(self):
        with pytest.raises(ValidationError):
            PageRange.model_validate(
                {
                    "start": 3,
                    "end": 1,
                    "tier": "fast",
                    "preset": "fast",
                    "parser": "docling",
                    "layer": "L1",
                    "signals": [],
                    "status": "pending",
                }
            )

    def test_preflight_rejects_ranges_that_do_not_tile(self):
        payload = _preflight(2).model_dump()
        payload["ranges"] = [_range(1, 1).model_dump()]
        with pytest.raises(ValidationError):
            PreflightResult.model_validate(payload)

    def test_preflight_rejects_tier_counts_not_summing_to_page_count(self):
        payload = _preflight(2).model_dump()
        payload["tier_page_counts"] = {"fast": 1, "structured": 0, "native": 0, "premium": 0}
        with pytest.raises(ValidationError):
            PreflightResult.model_validate(payload)

    def test_page_structure_verdict_requires_confidence_in_unit_interval(self):
        with pytest.raises(ValidationError):
            PageStructureVerdict(
                has_table=False,
                has_multi_column=False,
                is_scanned=False,
                has_formula=False,
                has_chart=False,
                complexity="simple",
                confidence=1.2,
            )

    def test_parse_routing_config_rejects_cost_without_source(self):
        config = default_parse_routing_config()
        broken = config.model_dump()
        broken["costs"]["tier"]["fast"]["source"] = ""
        with pytest.raises(ValidationError):
            ParseRoutingConfig.model_validate(broken)


class TestQueueContracts:
    def test_job_status_literal_count(self):
        assert len(get_args(JobStatus)) == 12

    def test_ingestion_job_round_trips(self):
        job = _ingestion_job()
        clone = IngestionJob.model_validate(job.model_dump(mode="json"))
        assert clone == job

    def test_settings_rejects_min_tier_above_max_tier(self):
        payload = _settings().model_dump()
        payload["min_tier"] = "premium"
        payload["max_tier"] = "fast"
        with pytest.raises(ValidationError):
            JobSettingsSnapshot.model_validate(payload)

    def test_detect_vlm_request_caps_page_count(self):
        with pytest.raises(ValidationError):
            DetectVlmRequest(
                worker_id="worker-1",
                attempt_no=1,
                pages=[DetectVlmPageImage(page=index, png_base64=_TINY_PNG) for index in range(1, 22)],
            )

    def test_detect_vlm_request_rejects_oversized_image(self):
        huge = base64.b64encode(b"x" * 500_000).decode("ascii")
        with pytest.raises(ValidationError):
            DetectVlmRequest(worker_id="worker-1", attempt_no=1, pages=[DetectVlmPageImage(page=1, png_base64=huge)])

    def test_parse_external_premium_requires_subpdf(self):
        with pytest.raises(ValidationError):
            ParseExternalRequest(worker_id="w", attempt_no=1, mode="premium")

    def test_parse_external_chain_forbids_subpdf_ref(self):
        with pytest.raises(ValidationError):
            ParseExternalRequest(
                worker_id="w",
                attempt_no=1,
                mode="chain",
                subpdf_ref="cache/sub.pdf",
            )

    def test_request_bodies_have_no_tenant_fields(self):
        request_bodies_must_not_carry_tenant()
        for model in REQUEST_BODY_MODELS:
            assert "tenant" not in model.model_fields
            assert "tenant_key" not in model.model_fields

    def test_advance_post_parse_requires_cache_id(self):
        with pytest.raises(ValidationError):
            AdvanceRequest(worker_id="w", attempt_no=1, phase="post_parse", deadline_ms=1_000)

    def test_advance_deadline_capped(self):
        with pytest.raises(ValidationError):
            AdvanceRequest(worker_id="w", attempt_no=1, phase="begin", deadline_ms=50_000)

    def test_advance_response_shape(self):
        AdvanceResponse(worker_id="w", stage="chunk", done=False, wait_ms=100)


class TestParseEvalContracts:
    def test_manifest_requires_exactly_one_location(self):
        with pytest.raises(ValidationError):
            BackfillManifestEntry(source_key="a")
        with pytest.raises(ValidationError):
            BackfillManifestEntry(source_key="a", path="x", url="https://example.com/x")
        with pytest.raises(ValidationError):
            BackfillManifestEntry(source_key="a", url="http://example.com/x")
        assert BackfillManifestEntry(source_key="a", path="/data/x.pdf").path == "/data/x.pdf"

    def test_quality_check_accepts_failure_reasons(self):
        QualityCheckResult(
            passed=False,
            pages=[PageCheck(page=1, failed=["missing_table", "garbled"])],
            score=0.2,
            partial=True,
        )

    def test_detect_vlm_response_carries_verdict_or_refusal(self):
        verdict = PageStructureVerdict(
            has_table=True,
            has_multi_column=False,
            is_scanned=False,
            has_formula=False,
            has_chart=False,
            complexity="simple",
            confidence=0.9,
        )
        DetectVlmResponse(
            worker_id="w",
            pages=[
                DetectVlmPageResult(page=1, verdict=verdict),
                DetectVlmPageResult(page=2, refused="cloud_not_allowed"),
            ],
        )

    def test_parse_external_response_pending(self):
        ParseExternalResponse(
            worker_id="w",
            status="pending",
            continuation="opaque",
            retry_after_ms=500,
        )

    def test_parse_external_response_done(self):
        ParseExternalResponse(worker_id="w", status="done", cache_id="cache-1")