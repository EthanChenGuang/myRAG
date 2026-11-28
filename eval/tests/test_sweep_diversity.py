import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.report import EvalReport, MetricValue, SliceMetrics
from rag_sidecar.contracts.retrieval import RetrievalParams

from rag_eval.config_files import finalize_config, write_config_atomically
from rag_eval.harness_runner import HarnessRun
from rag_eval.paths import REPO_ROOT
from rag_eval.sweep import diversity
from rag_eval.sweep import retrieval as retrieval_sweep
from rag_eval.sweep.diversity import CHOICE_RULE, LAMBDA_GRID, choose_lambda, run_diversity_sweep

SAMPLE = json.loads((REPO_ROOT / "tests/fixtures/contracts/samples.json").read_text(encoding="utf-8"))["samples"]["EvalReport"]
NOISE = NoiseConfig.model_validate_json((REPO_ROOT / "eval/config/noise.json").read_text(encoding="utf-8"))


def mv(value: float | None) -> MetricValue:
    return MetricValue(value=value, n=10)


def slice_metrics(recall10: float, *, coverage: float | None = None, redundancy: float | None = None, ndcg: float = 0.5) -> SliceMetrics:
    return SliceMetrics(
        recall_at_5=mv(recall10),
        recall_at_10=mv(recall10),
        mrr=mv(0.5),
        correct_refusal_rate=mv(None),
        false_refusal_rate=mv(None),
        ndcg_at_context_k=mv(ndcg),
        topk_redundancy=mv(redundancy),
        intent_coverage=mv(coverage),
    )


def report(*, overall: float = 0.8, en: float = 0.8, general: float = 0.8, coverage: float = 0.5, redundancy: float = 0.5) -> EvalReport:
    base = EvalReport.model_validate(SAMPLE)
    dup = slice_metrics(0.8, coverage=coverage, redundancy=redundancy)
    return base.model_copy(
        update={
            "overall": slice_metrics(overall),
            "by_language": {"en": slice_metrics(en)},
            "by_category": {"general": slice_metrics(general), "duplicate_flood": dup},
            "by_split": {"dev": slice_metrics(overall)},
        }
    )


class FakeRunner:
    """Returns a synthetic report per lambda; the reference run (collapse) has no diversity override."""

    def __init__(self, by_lambda: dict[float, EvalReport], reference: EvalReport):
        self.by_lambda = by_lambda
        self.reference = reference
        self.calls: list[dict] = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        lam = ((kwargs.get("overrides") or {}).get("diversity") or {}).get("mmr_lambda")
        chosen = self.reference if lam is None else self.by_lambda[lam]
        out = Path(kwargs["out"])
        return HarnessRun(out_dir=out, golden_path=out / "g.jsonl", run_config_path=out / "rc.json", argv=[], report=chosen)


def cells_from(reports: dict[float, EvalReport]):
    return [diversity.cell_from_report(lam, rep, f"cells/{lam}") for lam, rep in reports.items()]


def all_cells(**per_lambda) -> dict[float, EvalReport]:
    return {lam: per_lambda.get(str(lam), report()) for lam in LAMBDA_GRID}


@pytest.fixture
def run_config(tmp_path: Path) -> Path:
    path = tmp_path / "run.json"
    path.write_text(json.dumps({"name": "div", "env": {"RAG_PIPELINE": "v2"}, "overrides": {"final_top_k": 8, "diversity": {"mmr_window_factor": 4}}}, indent=2) + "\n", encoding="utf-8")
    return path


@pytest.fixture
def params(tmp_path: Path) -> Path:
    path = tmp_path / "retrieval-params.json"
    write_config_atomically(path, finalize_config(RetrievalParams(), provenance_source="sweep"))
    return path


def test_grid_is_fixed():
    assert LAMBDA_GRID == (0.5, 0.6, 0.7, 0.8, 0.9)


def test_choice_prefers_coverage_then_redundancy_then_recall_then_largest():
    reference = diversity.cell_from_report(None, report(), "ref")
    reports = {
        0.5: report(coverage=0.9, redundancy=0.4),
        0.6: report(coverage=0.9, redundancy=0.3),
        0.7: report(coverage=0.9, redundancy=0.3, overall=0.85),
        0.8: report(coverage=0.9, redundancy=0.3, overall=0.85),
        0.9: report(coverage=0.5),
    }
    selection = choose_lambda(cells_from(reports), reference, NOISE)
    assert selection.chosen == 0.8
    assert selection.eligible == [0.5, 0.6, 0.7, 0.8, 0.9]


def test_a_slice_drop_beyond_the_band_makes_a_lambda_ineligible():
    reference = diversity.cell_from_report(None, report(), "ref")
    reports = {lam: report() for lam in LAMBDA_GRID}
    reports[0.9] = report(coverage=1.0, general=0.7)
    reports[0.5] = report(coverage=0.8, en=0.79)
    selection = choose_lambda(cells_from(reports), reference, NOISE)
    assert 0.9 not in selection.eligible
    assert selection.chosen == 0.5
    assert any("0.9" in line and "category:general" in line for line in selection.reasons)


def test_no_eligible_lambda_chooses_nothing():
    reference = diversity.cell_from_report(None, report(), "ref")
    reports = {lam: report(overall=0.5) for lam in LAMBDA_GRID}
    selection = choose_lambda(cells_from(reports), reference, NOISE)
    assert selection.chosen is None
    assert selection.eligible == []


def test_cells_run_on_dev_with_mmr_and_dup_clusters(tmp_path: Path, run_config: Path, params: Path):
    runner = FakeRunner(all_cells(), report())
    run_diversity_sweep(run_config, tmp_path / "out", runner=runner, params_path=params)
    lambdas = [((c.get("overrides") or {}).get("diversity") or {}).get("mmr_lambda") for c in runner.calls]
    assert lambdas == [None, 0.5, 0.6, 0.7, 0.8, 0.9]
    assert runner.calls[0]["env_overlay"] == {"RAG_RESULT_DIVERSITY": "collapse", "RAG_DUP_CLUSTERS": "true"}
    for call in runner.calls[1:]:
        assert call["env_overlay"] == {"RAG_RESULT_DIVERSITY": "mmr", "RAG_DUP_CLUSTERS": "true"}
        assert call["overrides"]["diversity"]["mmr_window_factor"] == 4
        assert call.get("splits", ("dev",)) == ("dev",)


def test_fixture_run_writes_only_the_run_config_lambda(tmp_path: Path, run_config: Path, params: Path):
    before_params = params.read_bytes()
    original = json.loads(run_config.read_text(encoding="utf-8"))
    reports = all_cells(**{"0.6": report(coverage=0.95)})
    result = run_diversity_sweep(run_config, tmp_path / "out", runner=FakeRunner(reports, report()), write_run_config=True, params_path=params)
    assert result.selection.chosen == 0.6
    after = json.loads(run_config.read_text(encoding="utf-8"))
    assert after["overrides"]["diversity"] == {"mmr_window_factor": 4, "mmr_lambda": 0.6}
    after["overrides"]["diversity"].pop("mmr_lambda")
    assert after == original
    assert params.read_bytes() == before_params
    assert result.run_config_written


def test_fixture_run_without_write_flag_changes_nothing(tmp_path: Path, run_config: Path, params: Path):
    before = run_config.read_bytes()
    run_diversity_sweep(run_config, tmp_path / "out", runner=FakeRunner(all_cells(), report()), params_path=params)
    assert run_config.read_bytes() == before


def test_no_choice_writes_nothing(tmp_path: Path, run_config: Path, params: Path):
    before = run_config.read_bytes()
    reports = {lam: report(overall=0.5) for lam in LAMBDA_GRID}
    result = run_diversity_sweep(run_config, tmp_path / "out", runner=FakeRunner(reports, report()), write_run_config=True, params_path=params)
    assert result.selection.chosen is None
    assert run_config.read_bytes() == before
    text = (tmp_path / "out" / diversity.REPORT_NAME).read_text(encoding="utf-8")
    assert "0.7" in text and "no eligible" in text


def test_write_params_without_base_url_is_refused(tmp_path: Path, run_config: Path, params: Path):
    before = params.read_bytes()
    with pytest.raises(retrieval_sweep.SweepUsageError, match="fixture run can never replace"):
        run_diversity_sweep(run_config, tmp_path / "out", runner=FakeRunner(all_cells(), report()), write_params=True, params_path=params)
    assert params.read_bytes() == before


def test_cli_write_params_without_base_url_exits_2(tmp_path: Path, run_config: Path):
    code = retrieval_sweep.main(["diversity", "--run-config", str(run_config), "--out", str(tmp_path / "out"), "--write-params"])
    assert code == 2


def test_live_run_writes_mmr_lambda_only(tmp_path: Path, run_config: Path, params: Path):
    before = RetrievalParams.model_validate_json(params.read_text(encoding="utf-8"))
    reports = all_cells(**{"0.8": report(coverage=0.95)})
    result = run_diversity_sweep(
        run_config, tmp_path / "out", runner=FakeRunner(reports, report()), base_url="https://app.example.invalid", write_params=True, params_path=params
    )
    after = RetrievalParams.model_validate_json(params.read_text(encoding="utf-8"))
    assert after.mmr_lambda == 0.8
    assert after.model_dump(exclude={"mmr_lambda", "config_hash", "provenance"}) == before.model_dump(exclude={"mmr_lambda", "config_hash", "provenance"})
    assert result.params_written


def test_live_run_never_writes_the_run_config(tmp_path: Path, run_config: Path, params: Path):
    with pytest.raises(retrieval_sweep.SweepUsageError):
        run_diversity_sweep(
            run_config, tmp_path / "out", runner=FakeRunner(all_cells(), report()), base_url="https://app.example.invalid", write_run_config=True, params_path=params
        )


def test_report_lists_every_lambda_and_the_rule(tmp_path: Path, run_config: Path, params: Path):
    run_diversity_sweep(run_config, tmp_path / "out", runner=FakeRunner(all_cells(), report()), params_path=params)
    text = (tmp_path / "out" / diversity.REPORT_NAME).read_text(encoding="utf-8")
    assert CHOICE_RULE and CHOICE_RULE in text
    for lam in LAMBDA_GRID:
        assert f"| {lam:.1f} |" in text
    assert "category:general" in text and "nDCG" in text
    assert (tmp_path / "out" / diversity.RESULT_NAME).is_file()


def test_a_report_with_test_split_items_is_refused(tmp_path: Path, run_config: Path, params: Path):
    leaky = report().model_copy(update={"by_split": {"dev": slice_metrics(0.8), "test": slice_metrics(0.8)}})
    with pytest.raises(retrieval_sweep.SweepUsageError, match="test split"):
        run_diversity_sweep(run_config, tmp_path / "out", runner=FakeRunner(all_cells(), leaky), params_path=params)


def test_committed_retrieval_params_untouched():
    path = REPO_ROOT / "eval/config/retrieval-params.json"
    assert diversity.PARAMS_PATH == path
