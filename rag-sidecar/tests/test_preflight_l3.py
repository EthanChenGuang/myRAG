"""L3 vision verdicts for disagreement pages (plan 03.1-41, D-49, D-50)."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import struct
import threading
from collections.abc import Sequence
from pathlib import Path

import pytest
from ingest_fakes import AppScript, FakeApp

from rag_sidecar.contracts.queue import DetectVlmPageResult, DetectVlmResponse, JobSettingsSnapshot
from rag_sidecar.contracts.routing import PageStructureVerdict, PreflightResult
from rag_sidecar.ingest import converters
from rag_sidecar.preflight.config import load_routing_config
from rag_sidecar.preflight.l1 import l1_signals
from rag_sidecar.preflight.l2 import L2Page, l2_refine
from rag_sidecar.preflight.l3 import L3Page, LoopVlmApp, l3_refine
from rag_sidecar.preflight.run import _to_tiered_pages, run_preflight

REPO_ROOT = Path(__file__).resolve().parents[2]
PARSE_ROOT = REPO_ROOT / "eval" / "fixtures" / "parse"
MANIFEST = json.loads((PARSE_ROOT / "manifest.json").read_text(encoding="utf-8"))
BY_ID = {entry["id"]: entry for entry in MANIFEST["fixtures"]}
RECORDED = PARSE_ROOT / "recorded"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
JOB = "10000000-0000-4000-8000-000000000001"


def pdf_of(fixture: str) -> Path:
    return REPO_ROOT / "eval" / BY_ID[fixture]["pdf_path"]


def recorded_verdict(fixture: str, page: int) -> PageStructureVerdict:
    path = RECORDED / BY_ID[fixture]["sha256"] / "vlm" / f"page-{page}.json"
    return PageStructureVerdict.model_validate_json(path.read_text(encoding="utf-8"))


def verdict(**overrides: object) -> PageStructureVerdict:
    base: dict[str, object] = {
        "has_table": False,
        "has_multi_column": False,
        "is_scanned": False,
        "has_formula": False,
        "has_chart": False,
        "complexity": "simple",
        "confidence": 0.9,
    }
    base.update(overrides)
    return PageStructureVerdict.model_validate(base)


class ScriptedVlm:
    """A synchronous stand-in for the app call. A page without an entry is a failed page: it is left out of the answer."""

    def __init__(
        self,
        answers: dict[int, PageStructureVerdict | str] | None = None,
        *,
        raises: Exception | None = None,
        extra: Sequence[tuple[int, PageStructureVerdict]] = (),
    ) -> None:
        self.answers = answers or {}
        self.raises = raises
        self.extra = list(extra)
        self.calls: list[list[int]] = []
        self.blobs: list[bytes] = []

    def detect(self, pages: Sequence[tuple[int, bytes]]) -> DetectVlmResponse:
        self.calls.append([number for number, _ in pages])
        self.blobs.extend(blob for _, blob in pages)
        if self.raises is not None:
            raise self.raises
        results: list[DetectVlmPageResult] = []
        for number, _blob in pages:
            answer = self.answers.get(number)
            if answer is None:
                continue
            if isinstance(answer, str):
                results.append(DetectVlmPageResult(page=number, refused=answer))  # type: ignore[arg-type]
            else:
                results.append(DetectVlmPageResult(page=number, verdict=answer))
        for number, extra_verdict in self.extra:
            results.append(DetectVlmPageResult(page=number, verdict=extra_verdict))
        return DetectVlmResponse(worker_id="worker-a", pages=results)


@pytest.fixture
def cfg():
    return load_routing_config()


@pytest.fixture
def recorded_converter():
    converters.reset_conversion_counter()
    yield converters.RecordedRangeConverter(RECORDED)
    converters.reset_conversion_counter()


def settings(**overrides: object) -> JobSettingsSnapshot:
    base: dict[str, object] = {
        "routing": "tiered",
        "cloud_allowed": True,
        "escalation": True,
        "progressive": False,
        "premium_max_pages_per_doc": 50,
        "premium_page_budget": 100,
        "vlm_detect": True,
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
    return JobSettingsSnapshot.model_validate(base)


def preflight(fixture: str, snapshot: JobSettingsSnapshot | None, cfg, converter, app: ScriptedVlm | None):
    return run_preflight(
        pdf_of(fixture),
        snapshot,
        cfg,
        converter,
        file_sha=BY_ID[fixture]["sha256"],
        vlm_app=app,
    )


def comparable(result: PreflightResult) -> dict:
    dump = result.model_dump(mode="json")
    dump.pop("timings_ms")
    return dump


def bare_pages(fixture: str, cfg, count: int | None = None) -> list[L2Page]:
    pages = l1_signals(pdf_of(fixture), cfg).pages
    return [L2Page(l1=page, uncertain=False, layer="L1") for page in pages[:count]]


def test_vlm_detect_false_never_calls_the_app(recorded_converter, cfg):
    app = ScriptedVlm({4: recorded_verdict("cross-boundary", 4), 5: recorded_verdict("cross-boundary", 5)})
    off = preflight("cross-boundary", settings(vlm_detect=False), cfg, recorded_converter, app)
    probe = preflight("cross-boundary", None, cfg, recorded_converter, app)
    assert app.calls == []
    assert off.result.detect_counts.L3 == 0
    assert probe.result.detect_counts.L3 == 0


def test_cloud_not_allowed_or_budget_zero_in_the_snapshot_never_calls_the_app(recorded_converter, cfg):
    app = ScriptedVlm({4: recorded_verdict("cross-boundary", 4)})
    preflight("cross-boundary", settings(cloud_allowed=False), cfg, recorded_converter, app)
    preflight("cross-boundary", settings(premium_page_budget=0), cfg, recorded_converter, app)
    preflight("cross-boundary", settings(routing="fixed"), cfg, recorded_converter, app)
    assert app.calls == []


def test_every_fixture_sends_nothing_with_cloud_off(recorded_converter, cfg):
    app = ScriptedVlm({1: verdict(complexity="complex")})
    for fixture in BY_ID:
        if fixture == "bench-100":
            continue
        preflight(fixture, settings(cloud_allowed=False), cfg, recorded_converter, app)
    assert app.calls == []


def test_at_most_twenty_pages_are_sent_in_page_order(cfg):
    pages = bare_pages("bench-100", cfg, 25)
    app = ScriptedVlm({number: verdict(has_table=True) for number in range(1, 26)})
    out = l3_refine(pages, list(reversed(range(1, 26))), pdf_of("bench-100"), settings(), app, cfg)
    assert app.calls == [list(range(1, 21))]
    refined = {page.page for page in out if isinstance(page, L3Page) and page.verdict is not None}
    assert refined == set(range(1, 21))
    for page in out:
        if page.page > 20:
            assert not isinstance(page, L3Page)
            assert page.layer == "L1"


def test_no_disagreement_pages_means_no_call(cfg):
    pages = bare_pages("bench-100", cfg, 5)
    app = ScriptedVlm()
    out = l3_refine(pages, [], pdf_of("bench-100"), settings(), app, cfg)
    assert app.calls == []
    assert out == pages


def test_complex_verdict_makes_the_page_premium_with_layer_l3(recorded_converter, cfg):
    app = ScriptedVlm({4: verdict(has_table=True, complexity="complex"), 5: recorded_verdict("cross-boundary", 5)})
    output = preflight("cross-boundary", settings(), cfg, recorded_converter, app)
    by_page = {row.page: row for row in output.result.pages}
    assert app.calls == [[4, 5]]
    assert by_page[4].tier == "premium"
    assert by_page[4].preset == "premium"
    assert by_page[4].layer == "L3"
    assert output.result.detect_counts.L3 == 2
    assert any(r.preset == "premium" and r.start <= 4 <= r.end for r in output.result.ranges)
    PreflightResult.model_validate(output.result.model_dump(mode="json"))


def test_simple_verdict_without_table_sets_fast_and_replaces_the_signals(recorded_converter, cfg):
    path = pdf_of("cross-boundary")
    l1 = l1_signals(path, cfg)
    pages, disagreements, _reusable = l2_refine(l1.pages, path, BY_ID["cross-boundary"]["sha256"], recorded_converter, cfg)
    page4_before = next(page for page in pages if page.page == 4)
    assert "tables" in page4_before.l1.signals or page4_before.l1.ruled_tables > 0 or page4_before.l1.aligned_number_rows >= 2
    app = ScriptedVlm({4: verdict(has_table=False, complexity="simple")})
    out = l3_refine(pages, disagreements, path, settings(), app, cfg)
    page4 = next(page for page in out if page.page == 4)
    assert isinstance(page4, L3Page)
    assert page4.layer == "L3"
    assert page4.l3_examined is True
    assert "tables" not in page4.l1.signals
    tiered = {item.page: item for item in _to_tiered_pages(out, "fast", "premium")}
    assert (tiered[4].tier, tiered[4].preset) == ("fast", "fast")
    assert tiered[4].layer == "L3"


def test_a_table_verdict_sets_structured_full(recorded_converter, cfg):
    path = pdf_of("cross-boundary")
    l1 = l1_signals(path, cfg)
    pages, disagreements, _reusable = l2_refine(l1.pages, path, BY_ID["cross-boundary"]["sha256"], recorded_converter, cfg)
    app = ScriptedVlm({4: recorded_verdict("cross-boundary", 4), 5: recorded_verdict("cross-boundary", 5)})
    out = l3_refine(pages, disagreements, path, settings(), app, cfg)
    tiered = {item.page: item for item in _to_tiered_pages(out, "fast", "premium")}
    assert tiered[4].preset == "structured_full"
    assert tiered[5].preset == "structured_full"
    assert "tables" in (tiered[4].signals or [])


def test_the_snapshot_max_tier_still_caps_a_complex_verdict(recorded_converter, cfg):
    path = pdf_of("cross-boundary")
    l1 = l1_signals(path, cfg)
    pages, disagreements, _reusable = l2_refine(l1.pages, path, BY_ID["cross-boundary"]["sha256"], recorded_converter, cfg)
    app = ScriptedVlm({4: verdict(has_table=True, complexity="complex")})
    out = l3_refine(pages, disagreements, path, settings(max_tier="structured"), app, cfg)
    tiered = {item.page: item for item in _to_tiered_pages(out, "fast", "structured")}
    assert tiered[4].tier == "structured"


@pytest.mark.parametrize("reason", ["cloud_not_allowed", "budget_exhausted", "over_page_cap", "batch_budget_exhausted"])
def test_refused_pages_keep_the_higher_tier_rule_and_the_job_continues(recorded_converter, cfg, reason):
    baseline = preflight("cross-boundary", settings(vlm_detect=False), cfg, recorded_converter, None)
    app = ScriptedVlm({4: reason, 5: reason})
    refused = preflight("cross-boundary", settings(), cfg, recorded_converter, app)
    assert app.calls == [[4, 5]]
    assert comparable(refused.result) | {"detect_counts": None} == comparable(baseline.result) | {"detect_counts": None}
    assert refused.result.detect_counts.L3 == 0
    by_page = {row.page: row for row in refused.result.pages}
    assert by_page[4].preset == "structured_full"


def test_failed_and_unknown_pages_are_ignored(recorded_converter, cfg):
    baseline = preflight("cross-boundary", settings(vlm_detect=False), cfg, recorded_converter, None)
    app = ScriptedVlm({}, extra=[(99, verdict(complexity="complex")), (1, verdict(complexity="complex"))])
    out = preflight("cross-boundary", settings(), cfg, recorded_converter, app)
    assert comparable(out.result) == comparable(baseline.result)


def test_a_duplicate_answer_for_a_page_is_ignored(cfg):
    pages = bare_pages("bench-100", cfg, 3)
    app = ScriptedVlm({1: verdict(has_table=True)}, extra=[(1, verdict(complexity="complex"))])
    out = l3_refine(pages, [1], pdf_of("bench-100"), settings(), app, cfg)
    page1 = next(page for page in out if page.page == 1)
    assert isinstance(page1, L3Page)
    assert page1.verdict is not None and page1.verdict.complexity == "simple"


@pytest.mark.parametrize("failure", [RuntimeError("transport down"), TimeoutError("slow"), ValueError("bad answer")])
def test_a_failing_app_call_changes_nothing_and_never_raises(recorded_converter, cfg, failure):
    baseline = preflight("cross-boundary", settings(vlm_detect=False), cfg, recorded_converter, None)
    app = ScriptedVlm(raises=failure)
    out = preflight("cross-boundary", settings(), cfg, recorded_converter, app)
    assert app.calls == [[4, 5]]
    assert comparable(out.result) | {"detect_counts": None} == comparable(baseline.result) | {"detect_counts": None}
    assert out.result.detect_counts.L3 == 0


def test_rendered_pages_are_png_images_of_bounded_size(cfg):
    pages = bare_pages("bench-100", cfg, 3)
    app = ScriptedVlm({1: verdict()})
    l3_refine(pages, [1, 2, 3], pdf_of("bench-100"), settings(), app, cfg)
    assert len(app.blobs) == 3
    for blob in app.blobs:
        assert blob.startswith(PNG_SIGNATURE)
        width, height = struct.unpack(">II", blob[16:24])
        assert 0 < width <= 2000 and 0 < height <= 2000
        assert len(blob) < 8 * 1024 * 1024


def test_page_images_are_never_logged(recorded_converter, cfg, caplog):
    caplog.set_level(logging.DEBUG)
    app = ScriptedVlm(raises=RuntimeError("provider echoed the image"))
    preflight("cross-boundary", settings(), cfg, recorded_converter, app)
    ok = ScriptedVlm({4: recorded_verdict("cross-boundary", 4)})
    preflight("cross-boundary", settings(), cfg, recorded_converter, ok)
    assert app.blobs and ok.blobs
    logged = caplog.text
    for blob in app.blobs + ok.blobs:
        assert base64.b64encode(blob[:60]).decode() not in logged
        assert repr(blob[:12]) not in logged
        assert "PNG" not in logged


def test_loop_adapter_sends_the_request_through_the_async_client(cfg):
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        fake = FakeApp()
        fake.script(
            "detect_vlm",
            [
                AppScript(
                    response={
                        "worker_id": "worker-a",
                        "pages": [
                            {"page": 2, "verdict": verdict(has_table=True).model_dump(mode="json"), "refused": None},
                            {"page": 3, "verdict": None, "refused": "budget_exhausted"},
                        ],
                    }
                )
            ],
        )
        app = LoopVlmApp(fake, JOB, "worker-a", 2, loop)
        pages = bare_pages("bench-100", cfg, 4)
        out = l3_refine(pages, [3, 2], pdf_of("bench-100"), settings(), app, cfg)
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
        loop.close()
    assert len(fake.calls) == 1
    action, job_id, request = fake.calls[0]
    assert (action, job_id) == ("detect_vlm", JOB)
    assert request["worker_id"] == "worker-a"
    assert request["attempt_no"] == 2
    assert [entry["page"] for entry in request["pages"]] == [2, 3]
    assert all(base64.b64decode(entry["png_base64"]).startswith(PNG_SIGNATURE) for entry in request["pages"])
    page2 = next(page for page in out if page.page == 2)
    page3 = next(page for page in out if page.page == 3)
    assert isinstance(page2, L3Page) and page2.layer == "L3"
    assert not isinstance(page3, L3Page)


def test_loop_adapter_failure_keeps_the_pages(cfg):
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        fake = FakeApp()
        fake.script("detect_vlm", [AppScript(status=503)])
        app = LoopVlmApp(fake, JOB, "worker-a", 1, loop)
        pages = bare_pages("bench-100", cfg, 3)
        out = l3_refine(pages, [1, 2], pdf_of("bench-100"), settings(), app, cfg)
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
        loop.close()
    assert len(fake.calls) == 1
    assert out == pages
