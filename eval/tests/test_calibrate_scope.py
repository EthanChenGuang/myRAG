import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.retrieval import RefusalCalibrationConfig
from rag_sidecar.contracts.scope_gate import ScopeGateCalibration

from rag_eval.calibrate import scope
from rag_eval.calibrate.__main__ import main
from rag_eval.calibrate.scope import ScopeCalibrationError, ScopeRow, fit_scope_cells, mode_targets, run_scope_calibration
from rag_eval.paths import REPO_ROOT
from rag_eval.split import assign_split

CONFIG = RefusalCalibrationConfig()
PROFILE = "openai-3-small-1536"
NOISE = 0.02
TARGETS = {"strict": 0.05, "balanced": 0.05, "flexible": 0.05}
COMMITTED = REPO_ROOT / "eval" / "config" / "scope-gate.json"


def _rows(dev_a: list[float], dev_n: list[float], test_a: list[float], test_n: list[float]) -> list[ScopeRow]:
    rows: list[ScopeRow] = []
    for split, answerable, scores, prefix in (
        ("dev", True, dev_a, "dev-a"),
        ("dev", False, dev_n, "dev-n"),
        ("test", True, test_a, "test-a"),
        ("test", False, test_n, "test-n"),
    ):
        rows += [ScopeRow(item_id=f"{prefix}-{i}", split=split, answerable=answerable, score=s) for i, s in enumerate(scores)]
    return rows


DEV_A = [0.9, 0.8, 0.7, 0.65, 0.6, 0.55]
DEV_N = [0.1, 0.2, 0.25]


def _cells(rows, targets=TARGETS):
    return {cell.rag_mode: cell for cell in fit_scope_cells(rows, PROFILE, targets, config=CONFIG, environment="fixture", noise_floor=NOISE)}


def test_threshold_lies_between_answerable_and_off_domain_scores_and_the_holdout_passes():
    cells = _cells(_rows(DEV_A, DEV_N, [0.75, 0.6, 0.85], [0.15]))
    assert set(cells) == {"strict", "balanced", "flexible"}
    for cell in cells.values():
        assert cell.status == "calibrated"
        assert cell.embedding_profile_id == PROFILE
        assert 0.3 < cell.threshold < 0.5
        assert cell.margin == 0
        assert cell.false_refusal_rate == 0
        assert cell.false_refusal_n == 3
        assert cell.correct_refusal_rate == 1
        assert cell.correct_refusal_n == 1


def test_per_mode_targets_are_used_when_present_and_the_single_target_otherwise():
    assert mode_targets(RefusalCalibrationConfig()) == TARGETS
    config = RefusalCalibrationConfig.model_validate(
        {"target_false_refusal": 0.05, "targets_by_mode": {"strict": {"target_false_refusal": 0.2}, "balanced": {}}}
    )
    assert mode_targets(config) == {"strict": 0.2, "balanced": 0.05, "flexible": 0.05}


def test_a_higher_mode_target_can_move_that_mode_only():
    dev_a = [0.9, 0.8, 0.7, 0.6, 0.15]
    cells = _cells(_rows(dev_a, DEV_N, [0.75, 0.6, 0.85], [0.12]), {"strict": 0.05, "balanced": 0.25, "flexible": 0.05})
    assert cells["balanced"].threshold > cells["strict"].threshold


def test_the_margin_is_the_smallest_step_whose_holdout_cut_passes():
    cells = _cells(_rows(DEV_A, DEV_N, [0.372, 0.36, 0.9, 0.8], [0.1]))
    strict = cells["strict"]
    assert strict.status == "calibrated"
    assert strict.threshold == pytest.approx(0.4)
    assert strict.margin == pytest.approx(0.03)
    assert strict.false_refusal_n == 4
    assert strict.false_refusal_rate == pytest.approx(0.25)


def test_a_holdout_failure_writes_the_cell_uncalibrated_with_its_rates():
    cells = _cells(_rows(DEV_A, DEV_N, [0.01, 0.02, 0.03, 0.9], [0.1]))
    assert len(cells) == 3
    for cell in cells.values():
        assert cell.status == "uncalibrated"
        assert cell.false_refusal_rate == pytest.approx(0.75)
        assert cell.false_refusal_n == 4
        assert cell.correct_refusal_rate == 1


def test_too_few_dev_items_or_a_fit_that_refuses_nothing_is_uncalibrated():
    few = _cells(_rows([0.9, 0.8], DEV_N, [0.9, 0.8], [0.1]))
    assert len(few) == 3
    assert all(cell.status == "uncalibrated" and cell.threshold is None for cell in few.values())
    overlap = _cells(_rows([0.1, 0.12, 0.14, 0.16, 0.18, 0.9], [0.95, 0.96, 0.97], [0.9, 0.8], [0.99]))
    assert all(cell.status == "uncalibrated" for cell in overlap.values())


# --- run-level: traces, golden items, ship gate ---------------------------------------------------------------------


def _ids(prefix: str, split: str, count: int) -> list[str]:
    found: list[str] = []
    n = 0
    while len(found) < count:
        candidate = f"{prefix}-{n:03d}"
        if assign_split(candidate) == split:
            found.append(candidate)
        n += 1
    return found


def _golden_line(item_id: str, split: str, answerable: bool, language: str) -> dict:
    return {
        "answerable": answerable,
        "category": "general" if answerable else "no_answer",
        "conversation": [],
        "evidence_language": None,
        "expected_answer": "A neutral answer." if answerable else None,
        "gold_evidence": [{"document": "neutral.md", "quote": "a neutral sentence", "section": "s"}] if answerable else [],
        "id": item_id,
        "language": language,
        "provenance": "synthetic_fixture",
        "question": "A neutral synthetic question?",
        "review_status": "approved",
        "split": split,
        "tags": [],
    }


def _trace_line(item_id: str, score: float | None, *, embedding_model: str = "fixture-ngram") -> dict:
    trace = {
        "item_id": item_id,
        "query": "q",
        "query_context": {
            "is_temporal_query": False,
            "is_financial_query": False,
            "required_precision": "low",
            "suggested_threshold": 0.3,
            "search_strategy": "semantic_only",
        },
        "retrieval_strategy": "standard",
        "candidates": [],
        "kept": [],
        "used_documents": [],
        "context": "",
        "refused": False,
        "refusal_reason": None,
        "citations": [],
        "stage_latency_ms": {},
        "effective_config": {
            "rag_env": {"RAG_PIPELINE": "v2", "RAG_QUERY_LAYER": "true", "RAG_SCOPE_GATE": "true"},
            "rag_prompt_sha256": {},
            "deployment_mode": "single",
            "embedding_model": embedding_model,
            "endpoint_version": "1",
        },
        "config_hash": "0" * 64,
    }
    if score is not None:
        trace["scope_gate"] = {
            "label": "unsure",
            "score": score,
            "negative_score": None,
            "reason": "no_calibration",
            "centroid_count": 4,
            "latency_ms": 0.5,
        }
    return trace


def _manifest(*, embedder: str = "fixture-ngram", profile: str | None = None) -> dict:
    return {
        "run_id": "run-scope",
        "tier": "smoke",
        "created_at": "2026-11-28T10:00:00Z",
        "git_sha": None,
        "deployment_mode": "single",
        "embedder": {"id": embedder, "version": "1", "source_sha256": "e" * 64},
        "corpus_sha256": "c" * 64,
        "golden_path": "eval/fixtures/golden.jsonl",
        "golden_sha256": "a" * 64,
        "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
        "sql_sha256": {},
        "request_options": {"max_results": 10},
        "embedding_profile": profile,
        "effective_config_hash": "h" * 64,
        "run_config_hash": "r" * 64,
        "item_count": 0,
        "edge_errors": 0,
    }


def _world(tmp_path: Path, *, embedder: str = "fixture-ngram", skipped: int = 2) -> tuple[Path, Path]:
    layout = [
        ("dev", True, DEV_A),
        ("dev", False, DEV_N),
        ("test", True, [0.75, 0.6, 0.85]),
        ("test", False, [0.15]),
    ]
    golden: list[dict] = []
    traces: list[dict] = []
    for split, answerable, scores in layout:
        prefix = f"s-{split}-{'a' if answerable else 'n'}"
        for item_id, score in zip(_ids(prefix, split, len(scores)), scores):
            golden.append(_golden_line(item_id, split, answerable, "en"))
            traces.append(_trace_line(item_id, score, embedding_model=embedder))
    for item_id in _ids("s-skip", "dev", skipped):
        golden.append(_golden_line(item_id, "dev", True, "zh"))
        traces.append(_trace_line(item_id, None, embedding_model=embedder))
    run = tmp_path / "run"
    run.mkdir()
    (run / "traces.jsonl").write_text("".join(json.dumps(t) + "\n" for t in traces), encoding="utf-8")
    (run / "run.json").write_text(json.dumps(_manifest(embedder=embedder)), encoding="utf-8")
    golden_path = tmp_path / "golden.jsonl"
    golden_path.write_text("".join(json.dumps(g, ensure_ascii=False) + "\n" for g in golden), encoding="utf-8")
    return run, golden_path


def test_two_runs_over_one_report_write_identical_bytes_that_validate(tmp_path):
    run, golden = _world(tmp_path)
    first = tmp_path / "a.json"
    second = tmp_path / "b.json"
    result = run_scope_calibration(run, out_path=first, golden_path=golden)
    run_scope_calibration(run, out_path=second, golden_path=golden)
    assert first.read_bytes() == second.read_bytes()
    parsed = ScopeGateCalibration.model_validate_json(first.read_text(encoding="utf-8"))
    assert parsed.source == "fixture"
    assert parsed.recorded_at.isoformat().startswith("2026-11-28T10:00:00")
    assert sorted(cell.rag_mode for cell in parsed.cells) == ["balanced", "flexible", "strict"]
    assert {cell.embedding_profile_id for cell in parsed.cells} == {PROFILE}
    assert all(cell.status == "calibrated" for cell in parsed.cells)
    assert result.source == "fixture"
    assert result.profile_id == PROFILE


def test_items_without_a_scope_score_are_excluded_and_counted(tmp_path):
    run, golden = _world(tmp_path, skipped=3)
    result = run_scope_calibration(run, out_path=tmp_path / "out.json", golden_path=golden)
    assert result.excluded == {"no_scope_score": 3}
    assert result.rows == len(DEV_A) + len(DEV_N) + 4


def test_live_source_without_a_separation_report_is_refused_and_writes_nothing(tmp_path):
    run, golden = _world(tmp_path, embedder="openai:text-embedding-3-small")
    out = tmp_path / "out.json"
    with pytest.raises(ScopeCalibrationError, match="separation"):
        run_scope_calibration(run, out_path=out, golden_path=golden, source="live")
    assert not out.exists()


def test_live_source_with_a_fixture_separation_report_is_refused(tmp_path):
    run, golden = _world(tmp_path, embedder="openai:text-embedding-3-small")
    report = tmp_path / "separation.json"
    report.write_text(json.dumps({"embedder": "fixture-ngram", "verdict": {"d34_separates_at_least_as_well": True}}), encoding="utf-8")
    out = tmp_path / "out.json"
    with pytest.raises(ScopeCalibrationError, match="fixture-ngram"):
        run_scope_calibration(run, out_path=out, golden_path=golden, source="live", separation_report=report)
    assert not out.exists()


def test_live_source_on_a_fixture_run_is_refused_even_with_a_real_report(tmp_path):
    run, golden = _world(tmp_path)
    report = tmp_path / "separation.json"
    report.write_text(json.dumps({"embedder": "openai:text-embedding-3-small", "verdict": {"d34_separates_at_least_as_well": True}}))
    out = tmp_path / "out.json"
    with pytest.raises(ScopeCalibrationError, match="fixture"):
        run_scope_calibration(run, out_path=out, golden_path=golden, source="live", separation_report=report)
    assert not out.exists()


def test_a_real_embedder_run_needs_the_live_source(tmp_path):
    run, golden = _world(tmp_path, embedder="openai:text-embedding-3-small")
    out = tmp_path / "out.json"
    with pytest.raises(ScopeCalibrationError, match="--source live"):
        run_scope_calibration(run, out_path=out, golden_path=golden)
    assert not out.exists()


def test_live_source_with_a_real_report_on_a_real_run_writes_live_cells(tmp_path):
    run, golden = _world(tmp_path, embedder="openai:text-embedding-3-small")
    report = tmp_path / "separation.json"
    report.write_text(json.dumps({"embedder": "openai:text-embedding-3-small", "verdict": {"d34_separates_at_least_as_well": True}}))
    out = tmp_path / "out.json"
    result = run_scope_calibration(run, out_path=out, golden_path=golden, source="live", separation_report=report)
    assert result.source == "live"
    assert ScopeGateCalibration.model_validate_json(out.read_text(encoding="utf-8")).source == "live"


def test_a_cell_for_another_profile_than_the_scored_run_is_refused(tmp_path):
    run, golden = _world(tmp_path)
    out = tmp_path / "out.json"
    with pytest.raises(ScopeCalibrationError, match="profile"):
        run_scope_calibration(run, out_path=out, golden_path=golden, profile_id="bge-m3-1024")
    assert not out.exists()


def test_the_cli_subcommand_writes_the_file_and_refuses_live_without_a_report(tmp_path, capsys):
    run, golden = _world(tmp_path)
    out = tmp_path / "out.json"
    assert main(["scope", "--report", str(run), "--golden", str(golden), "--out", str(out)]) == 0
    assert out.exists()
    out.unlink()
    assert main(["scope", "--report", str(run), "--golden", str(golden), "--out", str(out), "--source", "live"]) == 2
    assert not out.exists()
    assert "separation" in capsys.readouterr().err

