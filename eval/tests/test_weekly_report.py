import json
import re

import httpx
from _private_runs import MARKERS, item, six_layer_run, trace, write_run
from rag_sidecar.contracts.feedback_loop import WeeklyReport

from rag_eval import weekly_report
from rag_eval.weekly_report import EXIT_PRIVATE, SKIP_NOTICE, main

SINCE = "2026-11-01"
TENANT_HASH = "0123456789abcdef"
SAFE_STRING = re.compile(r"^[A-Za-z0-9:._+-]*$")


def _metric(value):
    return {"value": value, "n": 10}


def _slice(recall5):
    return {
        "recall_at_5": _metric(recall5),
        "recall_at_10": _metric(min(1.0, recall5 + 0.1)),
        "mrr": _metric(recall5 / 2),
        "correct_refusal_rate": _metric(0.9),
        "false_refusal_rate": _metric(0.05),
    }


def eval_report(run_id: str, recall5: float, *, population: str = "real", golden_sha: str = "a" * 64) -> dict:
    return {
        "run_id": run_id,
        "tier": "live",
        "run_config_hash": f"cfg-{run_id}",
        "golden_sha256": golden_sha,
        "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
        "deployment_mode": "single",
        "request_options": {"max_results": 10},
        "k_values": [5, 10],
        "overall": _slice(recall5),
        "by_language": {},
        "by_category": {},
        "by_language_category": {},
        "by_split": {},
        "gate_population": population,
        "items": [],
        "notes": ["markerquestiontext must never be copied"],
    }


def _stats_payload() -> dict:
    return {
        "success": True,
        "stats": {
            "schema_version": 1,
            "since": "2026-11-01T00:00:00.000Z",
            "until": "2026-11-08T00:00:00.000Z",
            "tenants": [
                {
                    "tenant_hash": TENANT_HASH,
                    "retrievals": 40,
                    "retrievals_by_channel": {"chat": 30, "embed": 6, "voice": 4},
                    "outcomes": {"answered": 30, "refused_no_context": 8, "kb_unavailable": 1, "degraded_answer": 1, "unknown": 0},
                    "refusal_rate": 0.2,
                    "zero_result_rate": 0.1,
                    "low_score_rate": 0.05,
                    "votes": {"answer_up": 5, "answer_down": 2, "refusal_up": 1, "refusal_down": 3, "embed_up": 0, "embed_down": 1},
                    "thumbs_down_rate": 0.5,
                    "refusal_disputes": 3,
                    "source_open_rate": 0.4,
                    "items_mined": 9,
                    "items_labelled": 4,
                    "items_skipped": 1,
                    "items_exported": 2,
                    "triage": {"dictionary": 1, "training": 0, "golden": 2, "kb_gap": 1, "not_a_failure": 0},
                }
            ],
        },
    }


def _latest(private) -> tuple[WeeklyReport, str, str]:
    reports = private / "reports"
    raw = max(reports.glob("weekly-report-*.json")).read_text(encoding="utf-8")
    markdown = max(reports.glob("weekly-report-*.md")).read_text(encoding="utf-8")
    return WeeklyReport.model_validate_json(raw), raw, markdown


def _nine_runs(private) -> None:
    for day in range(1, 10):
        population = "production" if day == 6 else "real"
        write_run(
            private,
            f"run-{day:02d}",
            f"2026-10-{day + 10:02d}T00:00:00Z",
            [item("en-general-007")],
            [trace("en-general-007")],
            report=eval_report(f"run-{day:02d}", 0.5 + day / 100, population=population),
        )


def _walk_strings(value, path=""):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from _walk_strings(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _walk_strings(child, f"{path}[{index}]")
    elif isinstance(value, str):
        yield path, value


def test_trend_lists_the_last_eight_runs_in_time_order_and_flags_a_population_change(private_runs_root):
    _nine_runs(private_runs_root)
    assert main(["--since", SINCE]) == 0
    report, _, markdown = _latest(private_runs_root)
    assert [point.run_id for point in report.trend] == [f"run-{day:02d}" for day in range(2, 10)]
    assert [point.gate_population for point in report.trend][4] == "production"
    assert all(point.manifest_hash == "a" * 64 and point.config_hash == f"cfg-{point.run_id}" for point in report.trend)
    assert report.trend[0].recall_at_5 == 0.52 and report.trend[0].false_refusal_rate == 0.05
    rows = [line for line in markdown.splitlines() if line.startswith("| run-")]
    assert [row.split(" | ")[0] for row in rows] == [f"| run-{day:02d}" for day in range(2, 10)]
    assert "not comparable" in rows[4] and "not comparable" in rows[5]
    assert "not comparable" not in rows[3] and "not comparable" not in rows[6]


def test_a_manifest_change_is_flagged_not_comparable(private_runs_root):
    write_run(private_runs_root, "run-01", "2026-11-02T00:00:00Z", [item("en-general-007")], [trace("en-general-007")], report=eval_report("run-01", 0.5))
    write_run(
        private_runs_root,
        "run-02",
        "2026-11-03T00:00:00Z",
        [item("en-general-007")],
        [trace("en-general-007")],
        report=eval_report("run-02", 0.6, golden_sha="b" * 64),
    )
    assert main(["--since", SINCE]) == 0
    _, _, markdown = _latest(private_runs_root)
    rows = [line for line in markdown.splitlines() if line.startswith("| run-")]
    assert "not comparable" not in rows[0] and "not comparable" in rows[1]


def test_trend_is_grouped_per_domain_set(private_runs_root):
    write_run(private_runs_root, "run-a", "2026-11-02T00:00:00Z", [item("en-general-007")], [trace("en-general-007")], report=eval_report("run-a", 0.5))
    write_run(
        private_runs_root,
        "run-b",
        "2026-11-03T00:00:00Z",
        [item("en-general-007")],
        [trace("en-general-007")],
        golden_path="eval/golden/private/domain-b.jsonl",
        report=eval_report("run-b", 0.4, population="production"),
    )
    assert main(["--since", SINCE]) == 0
    report, _, markdown = _latest(private_runs_root)
    assert len({point.domain_set for point in report.trend}) == 2
    assert "not comparable" not in markdown


def test_stats_section_renders_per_tenant_hash_from_the_route(private_runs_root, monkeypatch):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_stats_payload())

    monkeypatch.setattr(weekly_report, "_http_client", lambda: httpx.Client(transport=httpx.MockTransport(handler)))
    monkeypatch.setenv("RAG_ADMIN_BEARER", "placeholder-token")
    golden, traces = six_layer_run()
    write_run(private_runs_root, "run-a", "2026-11-02T00:00:00Z", golden, traces, report=eval_report("run-a", 0.5))
    assert main(["--since", SINCE, "--until", "2026-11-08", "--base-url", "http://app.test/", "--token-env", "RAG_ADMIN_BEARER"]) == 0
    assert len(seen) == 1
    assert seen[0].url.path == "/api/rag/admin/feedback-loop/stats"
    assert seen[0].url.params["since"] == "2026-11-01T00:00:00Z" and seen[0].url.params["until"] == "2026-11-08T00:00:00Z"
    assert seen[0].headers["authorization"] == "Bearer placeholder-token"
    report, raw, markdown = _latest(private_runs_root)
    assert report.stats is not None and report.stats_skipped_reason is None
    assert report.stats.tenants[0].tenant_hash == TENANT_HASH
    assert f"| {TENANT_HASH} | 40 |" in markdown
    assert report.failures is not None and len(report.failures.entries) == 6
    assert "placeholder-token" not in raw and "placeholder-token" not in markdown


def test_stats_http_error_is_a_skip_reason(private_runs_root, monkeypatch):
    monkeypatch.setattr(
        weekly_report,
        "_http_client",
        lambda: httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(403, json={"error": "denied"}))),
    )
    monkeypatch.setenv("RAG_ADMIN_BEARER", "placeholder-token")
    write_run(private_runs_root, "run-a", "2026-11-02T00:00:00Z", [item("en-general-007")], [trace("en-general-007")], report=eval_report("run-a", 0.5))
    assert main(["--since", SINCE, "--base-url", "http://app.test", "--token-env", "RAG_ADMIN_BEARER"]) == 0
    report, _, markdown = _latest(private_runs_root)
    assert report.stats is None and report.stats_skipped_reason == "stats_http_403"
    assert "skipped (stats_http_403)" in markdown


def test_without_a_base_url_or_token_the_stats_section_is_skipped(private_runs_root, monkeypatch):
    monkeypatch.delenv("RAG_ADMIN_BEARER", raising=False)
    write_run(private_runs_root, "run-a", "2026-11-02T00:00:00Z", [item("en-general-007")], [trace("en-general-007")], report=eval_report("run-a", 0.5))
    assert main(["--since", SINCE]) == 0
    report, _, markdown = _latest(private_runs_root)
    assert report.stats is None and report.stats_skipped_reason == "no_base_url"
    assert "skipped (no_base_url)" in markdown
    assert main(["--since", SINCE, "--base-url", "http://app.test"]) == 0
    report, _, _ = _latest(private_runs_root)
    assert report.stats_skipped_reason == "no_token"


def test_no_private_data_prints_a_notice_and_exits_zero(private_runs_root, capsys):
    assert main(["--since", SINCE]) == 0
    assert SKIP_NOTICE in capsys.readouterr().out
    assert not (private_runs_root / "reports").exists()


def test_an_output_outside_the_private_directory_exits_private(private_runs_root, tmp_path):
    write_run(private_runs_root, "run-a", "2026-11-02T00:00:00Z", [item("en-general-007")], [trace("en-general-007")], report=eval_report("run-a", 0.5))
    outside = tmp_path / "outside"
    assert main(["--since", SINCE, "--out-dir", str(outside)]) == EXIT_PRIVATE
    assert not outside.exists()


def test_outputs_carry_ids_counts_hashes_and_codes_only(private_runs_root):
    golden, traces = six_layer_run()
    write_run(private_runs_root, "run-a", "2026-11-02T00:00:00Z", golden, traces, report=eval_report("run-a", 0.5))
    assert main(["--since", SINCE]) == 0
    _, raw, markdown = _latest(private_runs_root)
    for path, value in _walk_strings(json.loads(raw)):
        assert SAFE_STRING.match(value), f"{path} carries text: {value!r}"
    for marker in MARKERS + ("seven marbles", "CANARY-0001"):
        assert marker not in raw
        assert marker not in markdown


def test_the_failure_report_is_written_too_so_next_week_lists_only_new_failures(private_runs_root):
    golden, traces = six_layer_run()
    write_run(private_runs_root, "run-a", "2026-11-02T00:00:00Z", golden, traces, report=eval_report("run-a", 0.5))
    assert main(["--since", SINCE]) == 0
    assert len(list((private_runs_root / "reports").glob("failure-report-*.json"))) == 1
    assert main(["--since", SINCE]) == 0
    report, _, _ = _latest(private_runs_root)
    assert report.failures is not None and report.failures.entries == []
