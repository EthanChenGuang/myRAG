import json

from _private_runs import MARKERS, item, six_layer_run, trace, write_run
from rag_sidecar.contracts.feedback_loop import FailureReport

from rag_eval import failure_report
from rag_eval.failure_report import EXIT_PRIVATE, SKIP_NOTICE, main

SINCE = "2026-11-01"


def _report(private) -> tuple[FailureReport, str]:
    reports = private / "reports"
    jsons = sorted(reports.glob("failure-report-*.json"))
    mds = sorted(reports.glob("failure-report-*.md"))
    assert jsons and mds
    return FailureReport.model_validate_json(jsons[-1].read_text(encoding="utf-8")), mds[-1].read_text(encoding="utf-8")


def test_layer_six_failed_items_map_to_the_six_layers(private_runs_root):
    golden, traces = six_layer_run()
    write_run(private_runs_root, "run-a", "2026-11-02T00:00:00Z", golden, traces)
    assert main(["--since", SINCE]) == 0
    report, _ = _report(private_runs_root)
    layers = {entry.item_id: entry.layer for entry in report.entries}
    assert layers == {
        "en-general-001": "retrieval",
        "en-general-002": "rerank_or_assembly",
        "en-general-003": "refusal",
        "en-general-004": "generation",
        "en-colloquial-005": "groundedness",
        "en-injection-006": "injection",
    }
    assert report.by_layer.model_dump() == {layer: 1 for layer in report.by_layer.model_dump()}
    assert report.run_ids == ["run-a"]


def test_layer_earliest_layer_wins_when_several_rules_apply(private_runs_root):
    golden = [item("en-general-001")]
    traces = [trace("en-general-001", candidate=False, groundedness="possibly_unreliable", answer="markeranswertext wrong")]
    write_run(private_runs_root, "run-a", "2026-11-02T00:00:00Z", golden, traces)
    assert main(["--since", SINCE]) == 0
    report, _ = _report(private_runs_root)
    assert [(e.item_id, e.layer) for e in report.entries] == [("en-general-001", "retrieval")]


def test_layer_unanswerable_item_answered_is_a_refusal_failure(private_runs_root):
    golden = [item("en-no_answer-001", category="no_answer", answerable=False)]
    traces = [trace("en-no_answer-001", candidate=False)]
    write_run(private_runs_root, "run-a", "2026-11-02T00:00:00Z", golden, traces)
    assert main(["--since", SINCE]) == 0
    report, _ = _report(private_runs_root)
    assert [(e.item_id, e.layer, e.category) for e in report.entries] == [("en-no_answer-001", "refusal", "no_answer")]


def test_layer_classification_unit():
    golden, traces = six_layer_run()
    by_id = {t.item_id: t for t in traces}
    assert [failure_report.classify_layer(g, by_id[g.id]) for g in golden] == [
        "retrieval",
        "rerank_or_assembly",
        "refusal",
        "generation",
        "groundedness",
        "injection",
        None,
    ]


def test_a_failure_in_the_previous_report_is_not_listed_again(private_runs_root):
    golden, traces = six_layer_run()
    write_run(private_runs_root, "run-a", "2026-11-02T00:00:00Z", golden, traces)
    assert main(["--since", SINCE]) == 0
    first, _ = _report(private_runs_root)
    assert len(first.entries) == 6

    write_run(private_runs_root, "run-b", "2026-11-03T00:00:00Z", golden[:2] + [item("en-general-008")], traces[:2] + [trace("en-general-008", kept=False)])
    assert main(["--since", SINCE]) == 0
    second, _ = _report(private_runs_root)
    assert [(e.item_id, e.layer, e.run_id) for e in second.entries] == [("en-general-008", "rerank_or_assembly", "run-b")]
    assert second.previous_report_sha256 is not None
    assert second.by_layer.rerank_or_assembly == 1 and sum(second.by_layer.model_dump().values()) == 1


def test_runs_before_since_are_not_read(private_runs_root):
    golden, traces = six_layer_run()
    write_run(private_runs_root, "run-old", "2026-10-20T00:00:00Z", golden, traces)
    write_run(private_runs_root, "run-new", "2026-11-05T00:00:00Z", [item("en-general-007")], [trace("en-general-007")])
    assert main(["--since", SINCE]) == 0
    report, _ = _report(private_runs_root)
    assert report.entries == [] and report.run_ids == ["run-new"]


def test_no_private_data_prints_a_notice_and_exits_zero(private_runs_root, capsys):
    assert main(["--since", SINCE]) == 0
    assert SKIP_NOTICE in capsys.readouterr().out
    assert not (private_runs_root / "reports").exists()


def test_an_output_or_runs_dir_outside_the_private_directory_exits_private(private_runs_root, tmp_path, capsys):
    golden, traces = six_layer_run()
    write_run(private_runs_root, "run-a", "2026-11-02T00:00:00Z", golden, traces)
    outside = tmp_path / "outside"
    assert main(["--since", SINCE, "--out-dir", str(outside)]) == EXIT_PRIVATE
    assert main(["--since", SINCE, "--runs-dir", str(outside)]) == EXIT_PRIVATE
    assert not outside.exists()
    assert not (private_runs_root / "reports").exists()


def test_a_bad_since_is_an_input_error(private_runs_root):
    assert main(["--since", "last week"]) == failure_report.EXIT_INPUT


def test_markdown_groups_by_layer_then_category_and_outputs_carry_no_text(private_runs_root):
    golden, traces = six_layer_run()
    write_run(private_runs_root, "run-a", "2026-11-02T00:00:00Z", golden, traces)
    assert main(["--since", SINCE]) == 0
    _, markdown = _report(private_runs_root)
    raw = max((private_runs_root / "reports").glob("failure-report-*.json")).read_text(encoding="utf-8")
    for marker in MARKERS + ("seven marbles", "CANARY-0001"):
        assert marker not in raw
        assert marker not in markdown
    assert markdown.index("### retrieval") < markdown.index("### rerank_or_assembly") < markdown.index("### injection")
    assert "#### colloquial" in markdown and "en-colloquial-005" in markdown

    allowed = {"schema_version", "generated_at", "since", "run_ids", "previous_report_sha256", "by_layer", "entries"}
    data = json.loads(raw)
    assert set(data) <= allowed
    for entry in data["entries"]:
        assert set(entry) <= {"item_id", "run_id", "layer", "category", "language", "domain_set"}
