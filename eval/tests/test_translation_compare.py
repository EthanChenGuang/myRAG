import json
from pathlib import Path

from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.report import ItemResult

from rag_eval.translation_compare import (
    NO_MEASURABLE_GAIN,
    WIRING_PROOF_LABEL,
    TranslationCost,
    build_translation_comparison,
    main,
    render_markdown,
)

NOISE_PATH = Path(__file__).resolve().parents[1] / "config" / "noise.json"


def _noise() -> NoiseConfig:
    return NoiseConfig.model_validate_json(NOISE_PATH.read_text(encoding="utf-8"))


def _item(item_id: str, language: str, evidence: str | None, hits: int, *, category: str = "cross_lingual") -> ItemResult:
    return ItemResult(
        item_id=item_id,
        language=language,
        category=category,
        evidence_language=evidence,
        split="dev",
        provenance="synthetic_fixture",
        answerable=True,
        refused=False,
        span_count=1,
        spans_hit_at_5=hits,
        spans_hit_at_10=hits,
        first_hit_rank=1 if hits else None,
    )


def _arms() -> tuple[list[ItemResult], list[ItemResult]]:
    arm_a: list[ItemResult] = []
    arm_b: list[ItemResult] = []
    for index in range(20):
        arm_a.append(_item(f"en-it-{index}", "en", "it", 1 if index < 8 else 0))
        arm_b.append(_item(f"en-it-{index}", "en", "it", 1 if index < 16 else 0))
    for index in range(20):
        hit = 1 if index % 2 == 0 else 0
        arm_a.append(_item(f"zh-en-{index}", "zh", "en", hit))
        arm_b.append(_item(f"zh-en-{index}", "zh", "en", hit))
    arm_a.append(_item("plain-en", "en", None, 1, category="general"))
    arm_b.append(_item("plain-en", "en", None, 0, category="general"))
    return arm_a, arm_b


def _cost() -> TranslationCost:
    return TranslationCost.model_validate(
        {
            "by_direction": {
                "it->en": {"rows": 120, "bytes": 48000, "usd": 0.0123, "ingestion_seconds": 4.5},
                "en->zh": {"rows": 80, "bytes": 30000, "usd": 0.0081, "ingestion_seconds": 2.0},
            },
            "translator": "openrouter/some-model",
        }
    )


def test_one_row_per_cross_lingual_pair_with_recall_paired_difference_and_cost_columns() -> None:
    arm_a, arm_b = _arms()
    report = build_translation_comparison(arm_a, arm_b, _cost(), _noise(), wiring_proof=False)
    assert [row.pair for row in report.pairs] == ["en->it", "zh->en"]
    en_it = report.pairs[0]
    assert en_it.n == 20
    assert en_it.recall_a == 0.4
    assert en_it.recall_b == 0.8
    assert en_it.paired.mean_d == 0.4
    assert en_it.band == _noise().floor
    assert en_it.verdict == "gain"
    assert en_it.added_rows == 120
    assert en_it.added_bytes == 48000
    assert en_it.translation_usd == 0.0123
    assert en_it.added_ingestion_seconds == 4.5
    zh_en = report.pairs[1]
    assert zh_en.paired.mean_d == 0.0
    assert zh_en.verdict == NO_MEASURABLE_GAIN
    assert zh_en.added_rows == 80
    for row in report.pairs:
        dumped = row.model_dump()
        for column in ("added_rows", "added_bytes", "translation_usd", "added_ingestion_seconds", "recall_a", "recall_b"):
            assert column in dumped


def test_a_pair_without_cost_data_still_has_every_cost_column_as_zero() -> None:
    arm_a, arm_b = _arms()
    report = build_translation_comparison(arm_a, arm_b, TranslationCost(), _noise(), wiring_proof=False)
    for row in report.pairs:
        assert (row.added_rows, row.added_bytes, row.translation_usd, row.added_ingestion_seconds) == (0, 0, 0.0, 0.0)


def test_a_gain_inside_the_noise_band_is_no_measurable_gain() -> None:
    arm_a = [_item(f"en-it-{index}", "en", "it", 0) for index in range(100)]
    arm_b = [_item(f"en-it-{index}", "en", "it", 1 if index == 0 else 0) for index in range(100)]
    report = build_translation_comparison(arm_a, arm_b, _cost(), _noise(), wiring_proof=False)
    assert report.pairs[0].paired.mean_d == 0.01
    assert report.pairs[0].verdict == NO_MEASURABLE_GAIN


def test_the_recommendation_turns_the_feature_on_only_where_the_gain_is_beyond_the_band() -> None:
    arm_a, arm_b = _arms()
    report = build_translation_comparison(arm_a, arm_b, _cost(), _noise(), wiring_proof=False)
    assert report.recommendation is not None
    assert "en->it" in report.recommendation
    assert "zh->en" not in report.recommendation
    assert "beyond the noise band" in report.recommendation
    flat = build_translation_comparison(arm_a, arm_a, _cost(), _noise(), wiring_proof=False)
    assert flat.recommendation is not None
    assert "off" in flat.recommendation
    assert all(row.verdict == NO_MEASURABLE_GAIN for row in flat.pairs)


def test_a_fixture_run_is_labelled_wiring_proof_and_carries_no_recommendation() -> None:
    arm_a, arm_b = _arms()
    report = build_translation_comparison(arm_a, arm_b, _cost(), _noise(), wiring_proof=True)
    assert report.wiring_proof is True
    assert report.label == WIRING_PROOF_LABEL
    assert "wiring proof" in report.label
    assert report.recommendation is None
    text = render_markdown(report)
    assert "wiring proof" in text
    assert "Recommendation" not in text
    assert "en->it" in text


def test_cli_writes_json_and_markdown_and_detects_a_fixture_run(tmp_path: Path) -> None:
    arm_a, arm_b = _arms()

    def report_file(name: str, items: list[ItemResult]) -> Path:
        path = tmp_path / f"{name}.json"
        path.write_text(
            json.dumps({"embedder_id": "fixture-ngram", "items": [item.model_dump(mode="json", exclude_none=True) for item in items]}),
            encoding="utf-8",
        )
        return path

    cost_path = tmp_path / "cost.json"
    cost_path.write_text(json.dumps({"by_direction": {"it->en": {"rows": 3, "bytes": 90, "usd": 0.0, "ingestion_seconds": 0.1}}, "translator": "fixture-translator"}))
    out = tmp_path / "out"
    code = main(
        [
            "--arm-a",
            str(report_file("a", arm_a)),
            "--arm-b",
            str(report_file("b", arm_b)),
            "--cost",
            str(cost_path),
            "--noise",
            str(NOISE_PATH),
            "--out",
            str(out),
        ]
    )
    assert code == 0
    written = json.loads((out / "translation-compare.json").read_text(encoding="utf-8"))
    assert written["wiring_proof"] is True
    assert written["recommendation"] is None
    assert [row["pair"] for row in written["pairs"]] == ["en->it", "zh->en"]
    assert "wiring proof" in (out / "translation-compare.md").read_text(encoding="utf-8")
