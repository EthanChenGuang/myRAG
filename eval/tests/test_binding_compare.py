import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.profiles import BindingComparison, BindingComparisonHashes
from rag_sidecar.contracts.report import EvalReport, ItemResult

from rag_eval.binding_compare import BINDING_FIXTURE_NOTE, CandidateCatalog, compare
from rag_eval.binding_compare_cli import main as cli_main
from rag_eval.metrics import aggregate

NOISE_PATH = Path(__file__).resolve().parents[1] / "config" / "noise.json"
NOISE = NoiseConfig.model_validate_json(NOISE_PATH.read_text(encoding="utf-8"))
DOC = "contract_legal"
BASE_PROFILE = "openai-3-small-1536"
LAW = "voyage-law-2-1024"
WIDE = "voyage-4-large-1024-domain"
HASHES = BindingComparisonHashes(
    corpus_sha256="c" * 64,
    golden_sha256="a" * 64,
    noise_sha256="b" * 64,
    retrieval_params_hash="d" * 64,
    catalog_version=1,
)
RUN_IDS = {
    LAW: "00000000-0000-4000-8000-000000000001",
    WIDE: "00000000-0000-4000-8000-000000000002",
}
CATALOG = {
    LAW: CandidateCatalog(model="voyage-law-2", usd_per_million_tokens=0.12, supported_languages=("en", "zh", "de")),
    WIDE: CandidateCatalog(model="voyage-4-large", usd_per_million_tokens=0.12, supported_languages=("zh", "en", "it")),
}
LANGS = ("zh", "en", "it")


def _item(
    item_id: str,
    language: str,
    doc_type: str,
    hit: bool,
    *,
    provenance: str = "synthetic_fixture",
    category: str = "general",
    evidence_language: str | None = None,
    refused: bool = False,
    split: str = "dev",
) -> ItemResult:
    return ItemResult(
        item_id=item_id,
        language=language,
        category=category,
        evidence_language=evidence_language,
        split=split,
        provenance=provenance,
        answerable=True,
        refused=refused,
        span_count=1,
        spans_hit_at_5=1 if hit else 0,
        spans_hit_at_10=1 if hit else 0,
        first_hit_rank=1 if hit else None,
        doc_type=doc_type,
    )


def _report(items: list[ItemResult], run_id: str = "run") -> EvalReport:
    agg = aggregate(items, gate_split="dev")
    return EvalReport.model_validate(
        {
            "run_id": run_id,
            "tier": "smoke",
            "run_config_hash": "r" * 64,
            "corpus_sha256": "c" * 64,
            "golden_sha256": "a" * 64,
            "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
            "embedder_id": "fixture-embedder",
            "embedder_version": 3,
            "deployment_mode": "single-tenant",
            "request_options": {},
            "k_values": [5, 10],
            "overall": agg["overall"],
            "by_language": agg["by_language"],
            "by_category": agg["by_category"],
            "by_language_category": agg["by_language_category"],
            "by_language_pair": agg["by_language_pair"],
            "by_doc_type": agg["by_doc_type"],
            "by_split": agg["by_split"],
            "items": items,
        }
    )


def _arm(
    doc_hits: dict[str, list[bool]],
    general_hits: list[bool] | None = None,
    *,
    languages: tuple[str, ...] = LANGS,
    general_refused: bool = False,
    pair_hits: list[bool] | None = None,
) -> EvalReport:
    items: list[ItemResult] = []
    for language in languages:
        for index, hit in enumerate(doc_hits[language]):
            items.append(_item(f"doc-{language}-{index}", language, DOC, hit))
        for index, hit in enumerate(general_hits or [True, True, True, False]):
            items.append(_item(f"gen-{language}-{index}", language, "general", hit, refused=general_refused and index < 2))
    if pair_hits is not None and len(languages) > 1:
        for index, hit in enumerate(pair_hits):
            items.append(
                _item(
                    f"pair-{index}",
                    languages[0],
                    DOC,
                    hit,
                    category="cross_lingual",
                    evidence_language=languages[1],
                )
            )
    return _report(items)


HALF = [True, True, False, False]
FULL = [True, True, True, True]
NONE = [False, False, False, False]


def _baseline() -> EvalReport:
    return _arm({language: HALF for language in LANGS})


def _good() -> EvalReport:
    return _arm({language: FULL for language in LANGS})


def _compare(candidates: dict[str, EvalReport], *, control: EvalReport | None = None, **overrides):
    kwargs = dict(
        baseline_profile=BASE_PROFILE,
        catalog=CATALOG,
        hashes=HASHES,
        reembed_run_ids={profile: RUN_IDS[profile] for profile in candidates},
        fixture_embedder=False,
    )
    kwargs.update(overrides)
    baseline = kwargs.pop("baseline", None) or _baseline()
    return compare(baseline, control or _baseline(), candidates, NOISE, DOC, **kwargs)


def _candidate(comparison: BindingComparison, profile_id: str):
    return next(candidate for candidate in comparison.candidates if candidate.profile_id == profile_id)


def test_candidate_beating_baseline_and_control_is_recommended():
    comparison = _compare({WIDE: _good()})
    result = _candidate(comparison, WIDE)
    assert result.beats_baseline and result.beats_control
    assert result.recommended
    assert comparison.gate_passed is True
    assert comparison.recommended_profile == WIDE
    assert result.deltas_vs_baseline["recall_at_10"] == pytest.approx(0.5)


def test_gain_explained_by_control_is_not_recommended():
    comparison = _compare({WIDE: _good()}, control=_good())
    result = _candidate(comparison, WIDE)
    assert result.beats_baseline and not result.beats_control
    assert not result.recommended
    assert comparison.gate_passed is False
    assert comparison.recommended_profile is None
    assert any("gain explained by filtered leg (control)" in note for note in comparison.notes)


def test_language_sub_slice_regression_blocks_recommendation():
    candidate = _arm({"zh": FULL, "en": FULL, "it": NONE})
    comparison = _compare({WIDE: candidate})
    result = _candidate(comparison, WIDE)
    assert result.beats_baseline and result.beats_control
    assert result.language_regressions == ["it"]
    assert not result.recommended
    assert comparison.gate_passed is False


def test_cross_lingual_pair_regression_of_the_doc_type_blocks_recommendation():
    baseline = _arm({language: HALF for language in LANGS}, pair_hits=FULL)
    candidate = _arm({language: FULL for language in LANGS}, pair_hits=NONE)
    comparison = _compare({WIDE: candidate}, baseline=baseline, control=baseline)
    result = _candidate(comparison, WIDE)
    assert result.pair_regressions == ["zh->en"]
    assert not result.recommended


def test_single_language_golden_has_no_pair_slices_and_still_decides():
    baseline = _arm({"en": HALF}, languages=("en",), pair_hits=FULL)
    candidate = _arm({"en": FULL}, languages=("en",), pair_hits=FULL)
    comparison = _compare({WIDE: candidate}, baseline=baseline, control=baseline)
    result = _candidate(comparison, WIDE)
    assert list(result.by_language) == ["en"]
    assert comparison.baseline.by_language_pair == {}
    assert result.pair_regressions == []
    assert result.recommended
    assert comparison.gate_passed is True


def test_language_outside_catalog_list_is_marked_undeclared():
    comparison = _compare({LAW: _good(), WIDE: _good()})
    assert _candidate(comparison, LAW).undeclared_languages == ["it"]
    assert _candidate(comparison, LAW).supported_languages == ["en", "zh", "de"]
    assert _candidate(comparison, WIDE).undeclared_languages == []


def test_other_doc_type_slice_regression_is_reported():
    candidate = _arm({language: FULL for language in LANGS}, general_hits=NONE)
    comparison = _compare({WIDE: candidate})
    result = _candidate(comparison, WIDE)
    assert "doc_type:general" in result.other_slice_regressions
    assert not result.recommended


def test_false_refusal_increase_is_a_refusal_regression():
    candidate = _arm({language: FULL for language in LANGS}, general_refused=True)
    comparison = _compare({WIDE: candidate})
    result = _candidate(comparison, WIDE)
    assert "false_refusal_rate" in result.refusal_regressions
    assert not result.recommended


def test_tie_goes_to_cheaper_then_lower_id():
    wide_all = CandidateCatalog(model="voyage-4-large", usd_per_million_tokens=0.12, supported_languages=LANGS)
    law_cheap = CandidateCatalog(model="voyage-law-2", usd_per_million_tokens=0.06, supported_languages=LANGS)
    comparison = _compare({LAW: _good(), WIDE: _good()}, catalog={LAW: law_cheap, WIDE: wide_all})
    assert comparison.recommended_profile == LAW
    assert [c.profile_id for c in comparison.candidates if c.recommended] == [LAW]

    law_equal = CandidateCatalog(model="voyage-law-2", usd_per_million_tokens=0.12, supported_languages=LANGS)
    comparison = _compare({LAW: _good(), WIDE: _good()}, catalog={LAW: law_equal, WIDE: wide_all})
    assert comparison.recommended_profile == WIDE


def test_provenance_counts_come_from_the_doc_type_slice():
    items = [_item(f"h-{i}", "en", DOC, i % 2 == 0, provenance="human") for i in range(30)]
    items += [_item(f"s-{i}", "en", DOC, i % 2 == 0) for i in range(10)]
    items += [_item(f"g-{i}", "en", "general", True, provenance="human") for i in range(5)]
    tagged_no_answer = _item("tagged-0", "en", "general", False)
    items.append(tagged_no_answer)
    report = _report(items)
    comparison = _compare({WIDE: report}, baseline=report, control=report, golden_doc_types={"tagged-0": DOC})
    assert comparison.provenance_counts == {"human": 30, "synthetic_fixture": 11}
    assert BINDING_FIXTURE_NOTE not in comparison.notes


def test_all_synthetic_slice_or_fixture_embedder_adds_fixture_note():
    comparison = _compare({WIDE: _good()})
    assert comparison.provenance_counts == {"synthetic_fixture": 12}
    assert BINDING_FIXTURE_NOTE in comparison.notes
    fixture = _compare({WIDE: _good()}, fixture_embedder=True)
    assert fixture.fixture_embedder is True
    assert BINDING_FIXTURE_NOTE in fixture.notes


def test_no_language_code_is_hard_coded_in_the_rule():
    source = (Path(__file__).resolve().parents[1] / "src" / "rag_eval" / "binding_compare.py").read_text(encoding="utf-8")
    for code in ('"zh"', '"en"', '"it"', "'zh'", "'en'", "'it'"):
        assert code not in source


def _write(path: Path, report: EvalReport) -> Path:
    path.write_text(report.model_dump_json(), encoding="utf-8")
    return path


def test_cli_writes_a_comparison_that_round_trips(tmp_path: Path):
    baseline = _write(tmp_path / "baseline.json", _baseline())
    control = _write(tmp_path / "control.json", _baseline())
    law = _write(tmp_path / "law.json", _good())
    wide = _write(tmp_path / "wide.json", _good())
    golden = tmp_path / "golden.jsonl"
    golden.write_text("", encoding="utf-8")
    hashes = tmp_path / "hashes.json"
    hashes.write_text(HASHES.model_dump_json(), encoding="utf-8")
    catalog = tmp_path / "catalog.json"
    catalog.write_text(
        json.dumps(
            {
                LAW: {"model": "voyage-law-2", "usd_per_million_tokens": 0.12, "supported_languages": ["en", "zh", "de"]},
                WIDE: {"model": "voyage-4-large", "usd_per_million_tokens": 0.12, "supported_languages": list(LANGS)},
            }
        ),
        encoding="utf-8",
    )
    out = tmp_path / "out" / "comparison.json"
    code = cli_main(
        [
            "--doc-type", DOC,
            "--baseline-profile", BASE_PROFILE,
            "--baseline", str(baseline),
            "--control", str(control),
            "--candidate", f"{LAW}={law}",
            "--candidate", f"{WIDE}={wide}",
            "--golden", str(golden),
            "--noise", str(NOISE_PATH),
            "--reembed-run", f"{LAW}={RUN_IDS[LAW]}",
            "--reembed-run", f"{WIDE}={RUN_IDS[WIDE]}",
            "--hashes-json", str(hashes),
            "--catalog-json", str(catalog),
            "--fixture-embedder",
            "--out", str(out),
        ]
    )
    assert code == 0
    parsed = BindingComparison.model_validate_json(out.read_text(encoding="utf-8"))
    assert parsed.doc_type == DOC
    assert parsed.fixture_embedder is True
    assert {c.profile_id for c in parsed.candidates} == {LAW, WIDE}
    assert parsed.reembed_run_ids[LAW] is not None
    assert parsed.baseline.report_path.endswith("baseline.json")


def test_cli_rejects_a_candidate_without_a_reembed_run(tmp_path: Path):
    baseline = _write(tmp_path / "baseline.json", _baseline())
    hashes = tmp_path / "hashes.json"
    hashes.write_text(HASHES.model_dump_json(), encoding="utf-8")
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps({WIDE: {"model": "m", "usd_per_million_tokens": 0.1, "supported_languages": []}}))
    golden = tmp_path / "golden.jsonl"
    golden.write_text("", encoding="utf-8")
    code = cli_main(
        [
            "--doc-type", DOC,
            "--baseline-profile", BASE_PROFILE,
            "--baseline", str(baseline),
            "--control", str(baseline),
            "--candidate", f"{WIDE}={baseline}",
            "--golden", str(golden),
            "--noise", str(NOISE_PATH),
            "--hashes-json", str(hashes),
            "--catalog-json", str(catalog),
            "--out", str(tmp_path / "c.json"),
        ]
    )
    assert code == 2
