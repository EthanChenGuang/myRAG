import json
from collections.abc import Iterable, Mapping
from datetime import date
from pathlib import Path

import pytest
from rag_sidecar.contracts.judge import JudgeConfig, JudgeReport
from rag_sidecar.contracts.judge_calibration import JudgeCalibration, JudgeCalibrationCell, JudgeSeedCase
from rag_sidecar.contracts.quality_gates import QualityGates, default_quality_gates
from rag_sidecar.contracts.retrieval import ConfigProvenance
from test_absolute_gate import _report

import rag_eval.judge_calibration as calibration_module
from rag_eval.absolute_gate import evaluate
from rag_eval.judge.config import DEFAULT_CONFIG_PATH, JudgeCase, load_judge_config
from rag_eval.judge_calibration import (
    calibrate,
    calibrate_with_details,
    effective_status,
    judge_fingerprint,
    judge_roles,
    main,
    merge_cells,
)
from rag_eval.paths import REPO_ROOT

LANGUAGES = ("en", "it", "zh")
RECORDED_AT = "2026-11-20T00:00:00Z"
TODAY = date(2026, 11, 26)
FINGERPRINTS = {"nightly": "a" * 64, "online": "c" * 64}
GENERATOR = "anthropic/claude-sonnet-5-5"
COMMITTED = REPO_ROOT / "eval" / "config" / "judge-calibration.json"


def _gates() -> QualityGates:
    return default_quality_gates()


def _config() -> JudgeConfig:
    return load_judge_config(DEFAULT_CONFIG_PATH)


def _case(
    case_id: str,
    language: str,
    supported: bool,
    *,
    relevant: bool | None = None,
    variant: str = "base",
    base_id: str | None = None,
    pair_id: str | None = None,
    perturbation_group: str | None = None,
    review_status: str = "approved",
    extra: Mapping[str, bool] | None = None,
) -> JudgeSeedCase:
    expected = {"faithfulness": supported, "answer_relevance": supported if relevant is None else relevant}
    expected.update(extra or {})
    return JudgeSeedCase(
        id=case_id,
        language=language,
        question=f"Synthetic question {case_id}?",
        contexts=[f"Synthetic context sentence for case {case_id}."],
        answer=f"Synthetic answer {case_id}.",
        expected=expected,
        unsupported_content=not supported,
        variant=variant,
        base_id=base_id,
        pair_id=pair_id,
        perturbation_group=perturbation_group,
        review_status=review_status,
        reviewed_by="reviewer-1" if review_status == "approved" else None,
    )


def _base_cases(language: str, count: int, *, review_status: str = "approved") -> list[JudgeSeedCase]:
    return [_case(f"{language}-{i:03d}", language, i % 2 == 0, review_status=review_status) for i in range(count)]


def _all_languages(count: int) -> list[JudgeSeedCase]:
    return [case for language in LANGUAGES for case in _base_cases(language, count)]


class StubFactory:
    """Scores each case from its human label; inverted languages get the opposite verdict."""

    def __init__(
        self,
        cases: Iterable[JudgeSeedCase],
        *,
        invert: Iterable[str] = (),
        scores: Mapping[str, float] | None = None,
        constant: float | None = None,
    ) -> None:
        self.by_id = {case.id: case for case in cases}
        self.invert = set(invert)
        self.scores = dict(scores or {})
        self.constant = constant
        self.roles: list[str] = []

    def _score(self, case: JudgeSeedCase, metric: str) -> float:
        if case.id in self.scores:
            return self.scores[case.id]
        if self.constant is not None:
            return self.constant
        verdict = case.expected.get(metric, True)
        if case.language in self.invert:
            verdict = not verdict
        return 0.95 if verdict else 0.1

    def __call__(self, role: str, config: JudgeConfig):
        self.roles.append(role)
        libraries = ("deepeval", "ragas") if role == "nightly" else ("deepeval",)

        def score(cases: list[JudgeCase]) -> dict[tuple[str, str, str], float | None]:
            out: dict[tuple[str, str, str], float | None] = {}
            for judged in cases:
                seed = self.by_id[judged.item_id]
                for library in libraries:
                    for metric in ("faithfulness", "answer_relevance"):
                        out[(library, judged.item_id, metric)] = self._score(seed, metric)
            return out

        return score


def _run(cases: list[JudgeSeedCase], factory: StubFactory | None = None, *, source: str = "seed"):
    return calibrate(
        cases,
        factory or StubFactory(cases),
        _gates(),
        source,
        judges=judge_roles(_config()),
        fingerprints=FINGERPRINTS,
        recorded_at=RECORDED_AT,
    )


def _by(cells: list[JudgeCalibrationCell], **match: str) -> list[JudgeCalibrationCell]:
    return [cell for cell in cells if all(getattr(cell, key) == value for key, value in match.items())]


def test_agreeing_judge_on_120_confirmed_cases_gates_every_cell():
    cells = _run(_all_languages(120), source="review_queue")
    assert len(cells) == len(LANGUAGES) * (4 + 2)
    assert {cell.status for cell in cells} == {"gating"}
    for cell in cells:
        assert cell.kappa == pytest.approx(1.0)
        assert cell.accuracy == pytest.approx(1.0)
        assert cell.n == 120
        assert cell.source == "review_queue"
        assert cell.labels_human_confirmed
        assert cell.unsupported_recall == pytest.approx(1.0)
        assert cell.unsupported_precision == pytest.approx(1.0)
        assert cell.key == f"{cell.fingerprint}|{cell.role}|{cell.language}|{cell.library}.{cell.metric}"
        assert cell.fingerprint == FINGERPRINTS[cell.role]


def test_disagreeing_judge_in_one_language_is_report_only_there_and_gating_elsewhere():
    cases = _all_languages(120)
    cells = _run(cases, StubFactory(cases, invert={"it"}), source="review_queue")
    for cell in _by(cells, language="it"):
        assert cell.status == "report_only"
        assert "kappa_below_floor" in cell.reasons
        assert "accuracy_below_floor" in cell.reasons
    for language in ("en", "zh"):
        assert {cell.status for cell in _by(cells, language=language)} == {"gating"}


def test_disagreeing_judge_stops_only_that_language_floor_in_the_absolute_gate():
    cases = _all_languages(120)
    cells = _run(cases, StubFactory(cases, invert={"it"}), source="review_queue")
    calibration = merge_cells(None, cells, {"nightly": FINGERPRINTS["nightly"]})
    metrics = {
        f"{library}.{metric}": {"value": 0.5, "n": 30}
        for library in ("deepeval", "ragas")
        for metric in ("faithfulness", "answer_relevance", "context_recall")
    }
    judge = JudgeReport.model_validate(
        {
            "run_id": "run-x",
            "run_config_hash": "r" * 64,
            "judge_model": "judge/model",
            "judge_family": "judge",
            "generator_model": "gen/model",
            "generator_family": "gen",
            "items": [],
            "overall": metrics,
            "by_language": {language: metrics for language in LANGUAGES},
            "by_category": {},
        }
    )
    result = evaluate(
        _report(tier="nightly"),
        _gates(),
        tier="nightly",
        judge_report=judge,
        calibration=calibration,
        running_fingerprints=calibration.running_fingerprints,
        today=TODAY,
    )
    floors = [row for row in result.checks if row.check.startswith("floor_")]
    assert floors
    for row in floors:
        language = row.slice.split(":")[1]
        if language == "it":
            assert (row.result, row.reason) == ("report_only", "calibration_report_only")
        else:
            assert (row.result, row.reason) == ("failed", "floor_not_met")
    assert "floor_not_met" in result.failed


def test_sixty_seed_cases_can_gate_but_sixty_review_queue_cases_cannot():
    cases = _all_languages(60)
    seeded = _run(cases, source="seed")
    assert {cell.status for cell in seeded} == {"gating"}
    queued = _run(cases, source="review_queue")
    assert {cell.status for cell in queued} == {"report_only"}
    assert all(cell.reasons == ["n_below_minimum"] for cell in queued)


def test_a_draft_case_in_the_sample_forces_report_only():
    cases = _all_languages(60)
    cases[0] = _case(cases[0].id, cases[0].language, True, review_status="draft")
    cells = _run(cases)
    for cell in _by(cells, language=cases[0].language):
        assert cell.status == "report_only"
        assert cell.reasons == ["labels_not_confirmed"]
        assert not cell.labels_human_confirmed
    assert {cell.status for cell in _by(cells, language="zh")} == {"gating"}


def test_length_bias_delta_and_reason():
    cases = _base_cases("en", 60)
    long = _case("en-long", "en", True, variant="long", base_id="en-000", pair_id="en-pair")
    short = _case("en-short", "en", True, variant="short", base_id="en-000", pair_id="en-pair")
    cases += [long, short]
    cells = _run(cases, StubFactory(cases, scores={"en-long": 0.9, "en-short": 0.7}))
    assert len(cells) == 6
    for cell in cells:
        assert cell.length_bias_delta == pytest.approx(0.2)
        assert cell.status == "report_only"
        assert cell.reasons == ["length_bias"]
        assert cell.n == 60


def test_assertive_probe_delta_and_reason():
    cases = _base_cases("en", 60)
    assertive = _case("en-assert", "en", True, variant="assertive", base_id="en-000", perturbation_group="en-g")
    expanded = _case("en-expand", "en", True, variant="expanded", base_id="en-000", perturbation_group="en-g")
    cases += [assertive, expanded]
    cells = _run(cases, StubFactory(cases, scores={"en-000": 0.7, "en-assert": 0.95, "en-expand": 0.72}))
    assert len(cells) == 6
    for cell in cells:
        assert cell.assertive_delta == pytest.approx(0.25)
        assert cell.expanded_delta == pytest.approx(0.02)
        assert cell.reasons == ["perturbation"]
        assert cell.n == 60


def test_kappa_is_null_with_reason_when_both_raters_use_one_class():
    cases = [_case(f"en-{i:03d}", "en", True) for i in range(60)]
    cells = _run(cases, StubFactory(cases, constant=0.99))
    assert len(cells) == 6
    for cell in cells:
        assert cell.kappa is None
        assert cell.accuracy == pytest.approx(1.0)
        assert cell.status == "report_only"
        assert "kappa_undefined" in cell.reasons


def test_report_details_carry_n_and_a_seeded_interval():
    cases = _all_languages(60)
    first = calibrate_with_details(
        cases, StubFactory(cases), _gates(), "seed", judges=judge_roles(_config()), fingerprints=FINGERPRINTS,
        recorded_at=RECORDED_AT,
    )
    again = calibrate_with_details(
        cases, StubFactory(cases), _gates(), "seed", judges=judge_roles(_config()), fingerprints=FINGERPRINTS,
        recorded_at=RECORDED_AT,
    )
    assert len(first) == len(LANGUAGES) * 6
    assert [detail.kappa_interval for detail in first] == [detail.kappa_interval for detail in again]
    for detail in first:
        assert detail.cell.n == 60
        assert detail.kappa_interval[0] is not None
        assert detail.positive_share == pytest.approx(0.5)


def test_holistic_metrics_never_produce_a_cell():
    cases = [
        _case(f"en-{i:03d}", "en", i % 2 == 0, extra={"holistic_quality": i % 2 == 0}) for i in range(60)
    ]
    cells = _run(cases)
    assert cells
    assert all(cell.metric != "holistic_quality" for cell in cells)


def test_effective_status_rules():
    cells = _run(_all_languages(60))
    cell = cells[0]
    assert cell.status == "gating"
    running = cell.fingerprint
    assert effective_status(cell, running, TODAY, 35) == "gating"
    assert effective_status(cell, running, date(2026, 12, 26), 35) == "uncalibrated"
    assert effective_status(cell, "f" * 64, TODAY, 35) == "uncalibrated"
    assert effective_status(cell, None, TODAY, 35) == "uncalibrated"
    demoted = cell.model_copy(update={"status": "report_only", "reasons": ["n_below_minimum"]})
    assert effective_status(demoted, running, TODAY, 35) == "report_only"


def test_judge_fingerprint_changes_with_model_temperature_version_and_rubric():
    config = _config()
    versions = {"deepeval": "1.0.0", "ragas": "2.0.0"}
    rubrics = {"deepeval.faithfulness": "rubric one", "ragas.faithfulness": "rubric two"}
    base = judge_fingerprint("nightly", config, versions=versions, rubrics=rubrics)
    assert len(base) == 64
    assert base == judge_fingerprint("nightly", config, versions=versions, rubrics=rubrics)
    other_model = config.model_copy(update={"judge_model": "openai/gpt-5-nano"})
    assert judge_fingerprint("nightly", other_model, versions=versions, rubrics=rubrics) != base
    warmer = config.model_copy(update={"temperature": 0.5})
    assert judge_fingerprint("nightly", warmer, versions=versions, rubrics=rubrics) != base
    assert judge_fingerprint("nightly", config, versions={**versions, "ragas": "2.0.1"}, rubrics=rubrics) != base
    changed = {**rubrics, "ragas.faithfulness": "rubric two, edited"}
    assert judge_fingerprint("nightly", config, versions=versions, rubrics=changed) != base
    assert judge_fingerprint("online", config, versions=versions, rubrics=rubrics) != base


def test_installed_fingerprint_is_stable():
    config = _config()
    assert judge_fingerprint("nightly", config) == judge_fingerprint("nightly", config)


def test_merge_cells_replaces_same_key_and_keeps_others():
    cases = _all_languages(60)
    first = merge_cells(None, _run(cases), {"nightly": FINGERPRINTS["nightly"]})
    assert first.provenance.source == "calibration"
    assert first.config_hash is not None
    inverted = _run(cases, StubFactory(cases, invert={"en"}))
    merged = merge_cells(first, _by(inverted, language="en"), {"nightly": FINGERPRINTS["nightly"]})
    assert len(merged.cells) == len(first.cells)
    assert {cell.status for cell in merged.cells if cell.language == "en"} == {"report_only"}
    assert {cell.status for cell in merged.cells if cell.language != "en"} == {"gating"}


def test_calibration_holds_numbers_and_codes_only():
    cases = _all_languages(60)
    calibration = merge_cells(None, _run(cases), dict(FINGERPRINTS))
    text = calibration.model_dump_json()
    assert "Synthetic" not in text
    assert "en-000" not in text


def _seed_file(tmp_path: Path, cases: list[JudgeSeedCase]) -> Path:
    path = tmp_path / "seed.jsonl"
    path.write_text("".join(case.model_dump_json() + "\n" for case in cases), encoding="utf-8")
    return path


def _calibration_file(tmp_path: Path) -> Path:
    path = tmp_path / "judge-calibration.json"
    empty = JudgeCalibration(cells=[], provenance=ConfigProvenance(source="defaults"))
    path.write_text(empty.model_dump_json(indent=2) + "\n", encoding="utf-8")
    return path


@pytest.fixture
def _keys(monkeypatch):
    monkeypatch.delenv("CONFIDENT_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-test-placeholder")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-placeholder")


def _cli(tmp_path: Path, cases: list[JudgeSeedCase], *extra: str) -> list[str]:
    return [
        "run",
        "--seed-only",
        "--seed",
        str(_seed_file(tmp_path, cases)),
        "--generator-model",
        GENERATOR,
        "--out",
        str(tmp_path / "out"),
        *extra,
    ]


def test_run_without_write_leaves_the_calibration_untouched(tmp_path: Path, _keys, capsys):
    cases = _all_languages(60)
    target = _calibration_file(tmp_path)
    before = target.read_bytes()
    committed = COMMITTED.read_bytes()
    code = main(_cli(tmp_path, cases, "--calibration", str(target)), judge_factory=StubFactory(cases))
    assert code == 0
    assert target.read_bytes() == before
    assert COMMITTED.read_bytes() == committed
    out = capsys.readouterr().out
    assert "gating" in out and "kappa" in out and "n=60" in out
    report = (tmp_path / "out" / "judge-calibration.md").read_text(encoding="utf-8")
    assert "Synthetic" not in report


def test_run_with_write_merges_into_the_calibration(tmp_path: Path, _keys):
    cases = _all_languages(60)
    target = _calibration_file(tmp_path)
    code = main(_cli(tmp_path, cases, "--calibration", str(target), "--write"), judge_factory=StubFactory(cases))
    assert code == 0
    written = JudgeCalibration.model_validate_json(target.read_text(encoding="utf-8"))
    assert written.provenance.source == "calibration"
    assert set(written.running_fingerprints) == {"nightly", "online"}
    assert len(written.cells) == len(LANGUAGES) * 6
    assert {cell.source for cell in written.cells} == {"seed"}


def test_run_with_a_missing_judge_key_prints_the_notice_and_exits_3(tmp_path: Path, monkeypatch, capsys):
    monkeypatch.delenv("CONFIDENT_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-placeholder")
    target = _calibration_file(tmp_path)
    before = target.read_bytes()
    code = main(_cli(tmp_path, _all_languages(60), "--calibration", str(target), "--write"))
    assert code == 3
    assert "judge key not configured" in capsys.readouterr().err
    assert target.read_bytes() == before


def test_run_with_a_same_family_generator_is_refused(tmp_path: Path, _keys, capsys):
    cases = _all_languages(60)
    argv = _cli(tmp_path, cases)
    argv[argv.index(GENERATOR)] = "openai/gpt-5"
    code = main(argv, judge_factory=StubFactory(cases))
    assert code == 5
    assert "family" in capsys.readouterr().err


def test_tenant_source_excludes_seed_only(tmp_path: Path, _keys, capsys):
    argv = ["run", "--seed-only", "--tenant", "s:default", "--base-url", "http://127.0.0.1:1"]
    code = main([*argv, "--generator-model", GENERATOR])
    assert code == 2
    assert "exclude each other" in capsys.readouterr().err


def test_seed_only_requires_a_seed_file(tmp_path: Path, _keys, capsys):
    code = main(["run", "--seed-only", "--seed", str(tmp_path / "missing.jsonl"), "--generator-model", GENERATOR])
    assert code == 2


def test_module_does_not_import_numeric_libraries():
    source = Path(calibration_module.__file__).read_text(encoding="utf-8")
    assert "numpy" not in source and "scipy" not in source and "sklearn" not in source


def test_committed_calibration_file_is_valid():
    JudgeCalibration.model_validate(json.loads(COMMITTED.read_text(encoding="utf-8")))
