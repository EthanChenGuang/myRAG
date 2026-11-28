import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.retrieval import DupClusterParamsFile, compute_config_hash

from rag_eval.calibrate import __main__ as calibrate_main
from rag_eval.calibrate import dup_clusters
from rag_eval.calibrate.dup_clusters import (
    CalibrationError,
    DupPair,
    fit_dup_threshold,
    load_pairs,
    run_dup_cluster_calibration,
)
from rag_eval.config_files import CONFIG_TARGETS, finalize_config, write_config_atomically
from rag_eval.paths import REPO_ROOT

PROFILE = "fixture-profile"


def pair(i: int, cosine: float | None, same: bool, profile: str = PROFILE) -> DupPair:
    return DupPair(
        tenant="s:default",
        embedding_profile_id=profile,
        chunk_a=f"00000000-0000-4000-8000-{i:012d}",
        chunk_b=f"00000000-0000-4000-8000-{i + 500:012d}",
        hamming=4,
        cosine=cosine,
        same_template=same,
    )


SEPARABLE = [pair(1, 0.99, True), pair(2, 0.97, True), pair(3, 0.93, True), pair(4, 0.91, False), pair(5, 0.4, False)]


def write_pairs(path: Path, pairs: list[DupPair]) -> Path:
    path.write_text("".join(json.dumps(p.__dict__) + "\n" for p in pairs), encoding="utf-8")
    return path


def source(pairs: list[DupPair]):
    return lambda: list(pairs)


def test_fit_picks_the_smallest_precision_one_threshold():
    fit = fit_dup_threshold(SEPARABLE)
    assert fit.status == "calibrated"
    assert fit.threshold == pytest.approx(0.93)
    assert fit.precision == 1.0
    assert fit.recall == 1.0
    assert fit.n_pairs == 5
    assert fit.n_same_template == 3
    rows = {round(row.threshold, 4): row for row in fit.table}
    assert set(rows) == {0.99, 0.97, 0.93, 0.91, 0.4}
    assert rows[0.91].precision == pytest.approx(0.75)
    assert rows[0.97].recall == pytest.approx(2 / 3)
    assert rows[0.4].n == 5


def test_fit_reports_recall_when_a_negative_sits_between_positives():
    fit = fit_dup_threshold([pair(1, 0.99, True), pair(2, 0.96, False), pair(3, 0.95, True)])
    assert fit.status == "calibrated"
    assert fit.threshold == pytest.approx(0.99)
    assert fit.recall == pytest.approx(0.5)


def test_fit_is_uncalibrated_without_a_precision_one_threshold():
    fit = fit_dup_threshold([pair(1, 0.99, False), pair(2, 0.95, True)])
    assert fit.status == "uncalibrated"
    assert fit.threshold is None
    assert fit.reason


def test_fit_is_uncalibrated_without_template_pairs():
    fit = fit_dup_threshold([pair(1, 0.5, False)])
    assert fit.status == "uncalibrated"
    assert "same_template" in fit.reason


def test_fit_ignores_candidates_outside_the_contract_bounds():
    fit = fit_dup_threshold([pair(1, 0.99, True), pair(2, -0.2, False), pair(3, 0.0, True)])
    assert all(0 < row.threshold <= 1 for row in fit.table)
    assert fit.threshold == pytest.approx(0.99)


def test_uncalibrated_run_writes_nothing(tmp_path: Path):
    params = tmp_path / "dup-cluster-params.json"
    result = run_dup_cluster_calibration(
        tmp_path / "out", pair_source=source([pair(1, 0.99, False)]), write_params=True, params_path=params
    )
    assert result.status == "uncalibrated"
    assert not params.exists()
    assert not result.params_written
    assert "uncalibrated" in (tmp_path / "out" / dup_clusters.REPORT_NAME).read_text(encoding="utf-8")


def test_fixture_run_writes_a_fixture_entry_and_keeps_the_top_level(tmp_path: Path):
    params = tmp_path / "dup-cluster-params.json"
    result = run_dup_cluster_calibration(tmp_path / "out", pair_source=source(SEPARABLE), write_params=True, params_path=params)
    assert result.params_written
    model = DupClusterParamsFile.model_validate_json(params.read_text(encoding="utf-8"))
    assert model.threshold == 0.95
    assert model.by_profile[PROFILE].source == "fixture"
    assert model.by_profile[PROFILE].threshold == pytest.approx(0.93)
    assert model.provenance.source == "calibration"
    assert model.config_hash == compute_config_hash(model)
    report = (tmp_path / "out" / dup_clusters.REPORT_NAME).read_text(encoding="utf-8")
    assert "eval only" in report
    assert "0.9300" in report


def test_fixture_run_keeps_another_profiles_live_entry_byte_for_byte(tmp_path: Path):
    params = tmp_path / "dup-cluster-params.json"
    existing = finalize_config(
        DupClusterParamsFile.model_validate({"by_profile": {"real-model": {"threshold": 0.97, "source": "live"}}}),
        provenance_source="calibration",
    )
    write_config_atomically(params, existing)
    before = json.loads(params.read_text(encoding="utf-8"))["by_profile"]["real-model"]
    run_dup_cluster_calibration(tmp_path / "out", pair_source=source(SEPARABLE), write_params=True, params_path=params)
    after = json.loads(params.read_text(encoding="utf-8"))
    assert json.dumps(after["by_profile"]["real-model"], sort_keys=True) == json.dumps(before, sort_keys=True)
    assert after["by_profile"][PROFILE]["source"] == "fixture"
    assert after["threshold"] == 0.95


def test_fixture_run_never_replaces_a_live_entry_of_the_same_profile(tmp_path: Path):
    params = tmp_path / "dup-cluster-params.json"
    write_config_atomically(
        params,
        finalize_config(
            DupClusterParamsFile.model_validate({"by_profile": {PROFILE: {"threshold": 0.97, "source": "live"}}}),
            provenance_source="calibration",
        ),
    )
    original = params.read_bytes()
    result = run_dup_cluster_calibration(tmp_path / "out", pair_source=source(SEPARABLE), write_params=True, params_path=params)
    assert not result.params_written
    assert result.write_skipped_reason
    assert params.read_bytes() == original


def test_without_write_params_nothing_is_written(tmp_path: Path):
    params = tmp_path / "dup-cluster-params.json"
    result = run_dup_cluster_calibration(tmp_path / "out", pair_source=source(SEPARABLE), params_path=params)
    assert result.status == "calibrated"
    assert not params.exists()
    assert (tmp_path / "out" / dup_clusters.RESULT_NAME).is_file()


def test_live_run_needs_pairs_and_profile(tmp_path: Path):
    with pytest.raises(CalibrationError):
        run_dup_cluster_calibration(tmp_path / "out", source="live", embedding_profile=PROFILE)
    with pytest.raises(CalibrationError):
        run_dup_cluster_calibration(tmp_path / "out", source="live", pairs_path=write_pairs(tmp_path / "p.jsonl", SEPARABLE))


def test_cli_live_without_pairs_is_a_usage_error(tmp_path: Path):
    code = calibrate_main.main(["dup-clusters", "--source", "live", "--embedding-profile", PROFILE, "--out", str(tmp_path / "out")])
    assert code == 2


def test_live_run_writes_only_that_profiles_live_entry(tmp_path: Path):
    params = tmp_path / "dup-cluster-params.json"
    write_config_atomically(
        params,
        finalize_config(
            DupClusterParamsFile.model_validate({"by_profile": {"other": {"threshold": 0.9, "source": "fixture"}}}),
            provenance_source="calibration",
        ),
    )
    pairs_file = write_pairs(tmp_path / "live-pairs.jsonl", SEPARABLE)
    result = run_dup_cluster_calibration(
        tmp_path / "out", source="live", pairs_path=pairs_file, embedding_profile=PROFILE, write_params=True, params_path=params
    )
    assert result.params_written
    model = DupClusterParamsFile.model_validate_json(params.read_text(encoding="utf-8"))
    assert model.by_profile[PROFILE].source == "live"
    assert model.by_profile["other"].source == "fixture"
    assert model.threshold == 0.95


def test_live_pairs_from_inside_the_repository_are_refused(tmp_path: Path):
    inside = REPO_ROOT / "eval" / "fixtures" / "live-pairs.jsonl"
    params = tmp_path / "dup-cluster-params.json"
    with pytest.raises(CalibrationError, match="inside the repository"):
        run_dup_cluster_calibration(
            tmp_path / "out", source="live", pairs_path=inside, embedding_profile=PROFILE, write_params=True, params_path=params
        )
    assert not params.exists()


def test_live_pairs_of_another_profile_are_refused(tmp_path: Path):
    pairs_file = write_pairs(tmp_path / "live-pairs.jsonl", [pair(1, 0.99, True, profile="other")])
    with pytest.raises(CalibrationError):
        run_dup_cluster_calibration(tmp_path / "out", source="live", pairs_path=pairs_file, embedding_profile=PROFILE)


def test_load_pairs_refuses_text_fields(tmp_path: Path):
    path = tmp_path / "pairs.jsonl"
    line = dict(pair(1, 0.9, True).__dict__, content="some chunk text")
    path.write_text(json.dumps(line) + "\n", encoding="utf-8")
    with pytest.raises(CalibrationError):
        load_pairs(path)
    good = write_pairs(tmp_path / "good.jsonl", SEPARABLE)
    assert load_pairs(good) == SEPARABLE


def test_fixture_run_spawns_the_pair_harness(tmp_path: Path):
    seen: list[list[str]] = []

    class Done:
        returncode = 0
        stdout = ""
        stderr = ""

    def spawner(argv: list[str], cwd: Path):
        seen.append(argv)
        out = Path(argv[argv.index("--out") + 1])
        write_pairs(out, SEPARABLE)
        return Done()

    result = run_dup_cluster_calibration(tmp_path / "out", spawner=spawner)
    assert result.status == "calibrated"
    assert "eval/harness/run-dup-pairs.mts" in seen[0]
    assert seen[0][seen[0].index("--deployment-mode") + 1] == "single-tenant"


def test_the_params_file_is_registered():
    registered = {rel: model for rel, model, _factory in CONFIG_TARGETS}
    assert registered.get("eval/config/dup-cluster-params.json") is DupClusterParamsFile
