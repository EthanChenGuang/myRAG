import hashlib
import json
from pathlib import Path

import pytest
from rag_sidecar.contracts import GatePopulationConfig
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import EvalReport, ItemResult
from test_paired import _baseline, _noise, _rows
from test_paired import _item as _paired_item
from test_paired import _report as _paired_report_fixture
from test_report_runner import (
    _four_items,
    _item,
    _manifest,
    _score_args,
    _trace,
    _write_inputs,
)

from rag_eval.config_files import GATE_POPULATION_PATH, load_gate_population
from rag_eval.golden_io import load_golden
from rag_eval.metrics import RealSetTooSmall, aggregate, score_items
from rag_eval.paired import paired_report
from rag_eval.parse_gate import _gated_items as _parse_gate_items
from rag_eval.paths import REPO_ROOT
from rag_eval.report import build_report, write_report
from rag_eval.runner import EXIT_REAL_SET_TOO_SMALL, main

LEGACY_SNAPSHOT = Path(__file__).parent / "data" / "gate-population-legacy-aggregates.json"
FIXTURE_GOLDEN = REPO_ROOT / "eval" / "fixtures" / "golden.jsonl"
PRODUCTION_SHARE = 5


def _result_for(item: GoldenItem, index: int, provenance: str | None = None) -> ItemResult:
    rank = None if index % 4 == 3 else (index % 7) + 1
    hit5 = 1 if item.answerable and rank is not None and rank <= 5 else 0
    hit10 = 1 if item.answerable and rank is not None else 0
    return ItemResult(
        item_id=item.id,
        language=item.language,
        category=item.category,
        evidence_language=item.evidence_language,
        split=item.split,
        provenance=provenance or item.provenance,
        answerable=item.answerable,
        refused=(not item.answerable) == (index % 3 != 0),
        span_count=len(item.gold_evidence) if item.answerable else 0,
        spans_hit_at_5=hit5,
        spans_hit_at_10=hit10,
        first_hit_rank=rank if item.answerable and rank is not None else None,
    )


# Plans 06-38, 06-39 and 04.2-37 appended items after the snapshot was saved; the snapshot keeps the earlier set.
CACHE_PAIR_CATEGORIES = frozenset({"cache_paraphrase", "cache_near_miss"})
PHASE6_TAGS = frozenset(
    {"phase6_protected_followup", "phase6_elliptical", "phase6_relative_time", "phase6_compound", "phase6_cross_lingual", "phase42"}
)


def _added_after_snapshot(item: GoldenItem) -> bool:
    return item.category == "small_talk" or item.category in CACHE_PAIR_CATEGORIES or bool(PHASE6_TAGS & set(item.tags))


def fixture_shapes() -> dict[str, tuple[list[ItemResult], frozenset[str]]]:
    """Three deterministic shapes built from the committed fixture golden set."""
    golden = [item for item in load_golden(FIXTURE_GOLDEN) if not _added_after_snapshot(item)]
    plain = [_result_for(item, index) for index, item in enumerate(golden)]
    relabelled = [
        _result_for(item, index, "production" if index % PRODUCTION_SHARE == 0 else None)
        for index, item in enumerate(golden)
    ]
    every_id = frozenset(item.id for item in golden)
    unapproved_production = frozenset(r.item_id for r in relabelled if r.provenance != "production")
    return {
        "no_production": (plain, every_id),
        "approved_production": (relabelled, every_id),
        "unapproved_production": (relabelled, unapproved_production),
    }


def dump_aggregate(out: dict[str, object]) -> dict[str, object]:
    def encode(value: object) -> object:
        if isinstance(value, dict):
            return {key: encode(inner) for key, inner in value.items()}
        if hasattr(value, "model_dump"):
            return value.model_dump(mode="json")
        return value

    return {key: encode(value) for key, value in out.items()}


def _snapshot() -> dict[str, object]:
    return json.loads(LEGACY_SNAPSHOT.read_text(encoding="utf-8"))


@pytest.mark.parametrize("shape", ["no_production", "approved_production", "unapproved_production"])
@pytest.mark.parametrize("config", [None, GatePopulationConfig(), GatePopulationConfig(mode="legacy", min_items=10_000)])
def test_legacy_mode_reproduces_the_saved_aggregates(shape: str, config: GatePopulationConfig | None):
    results, approved = fixture_shapes()[shape]
    out = aggregate(results, approved_ids=approved, population=config)
    assert dump_aggregate(out) == _snapshot()[shape]


def test_saved_aggregates_cover_all_and_production_populations():
    snapshot = _snapshot()
    assert snapshot["no_production"]["gate_population"] == "all"
    assert snapshot["approved_production"]["gate_population"] == "production"
    assert snapshot["unapproved_production"]["gate_population"] == "all"


def _row(item_id: str, provenance: str, *, language: str = "en", category: str = "general", split: str = "test",
         rank: int | None = 1) -> ItemResult:
    hit = 1 if rank is not None and rank <= 5 else 0
    return ItemResult(
        item_id=item_id,
        language=language,
        category=category,
        split=split,
        provenance=provenance,
        answerable=True,
        refused=False,
        span_count=1,
        spans_hit_at_5=hit,
        spans_hit_at_10=hit,
        first_hit_rank=rank,
    )


LANGUAGES = ("zh", "en", "it")


def _real_mix(production: int, human: int, synthetic: int) -> list[ItemResult]:
    rows = [_row(f"p{i}", "production", language=LANGUAGES[i % 3]) for i in range(production)]
    rows += [_row(f"h{i}", "human", language=LANGUAGES[i % 3], category="typo", rank=2) for i in range(human)]
    rows += [_row(f"s{i}", "synthetic_fixture", rank=None) for i in range(synthetic)]
    rows += [_row("d0", "claude_draft", rank=None), _row("r0", "ragas_generated", rank=None)]
    return rows


def _real(provenances: list[str], min_items: int = 100) -> GatePopulationConfig:
    return GatePopulationConfig(mode="real", provenances=provenances, min_items=min_items)


def test_real_mode_gates_on_the_approved_real_items_only():
    results = _real_mix(70, 50, 300)
    out = aggregate(results, gate_split="test", population=_real(["production", "human"]))
    assert out["gate_population"] == "real"
    assert out["overall"].recall_at_5.n == 120
    assert sum(metrics.recall_at_5.n for metrics in out["by_language"].values()) == 120
    assert set(out["by_category"]) == {"general", "typo"}
    assert out["by_category"]["general"].recall_at_5.n == 70
    assert set(out["by_provenance"]) == {"production", "human", "synthetic_fixture", "claude_draft", "ragas_generated"}
    assert out["by_provenance"]["synthetic_fixture"].recall_at_5.n == 300
    assert "synthetic_fixture/general" in out["by_provenance_category"]


def test_real_mode_drops_unapproved_items_and_other_splits():
    results = _real_mix(70, 50, 0) + [_row(f"x{i}", "production", split="dev") for i in range(30)]
    approved = frozenset(r.item_id for r in results if r.item_id != "p0")
    out = aggregate(results, gate_split="test", approved_ids=approved, population=_real(["production", "human"]))
    assert out["overall"].recall_at_5.n == 119


def test_real_mode_below_min_items_raises_instead_of_falling_back():
    with pytest.raises(RealSetTooSmall) as raised:
        aggregate(_real_mix(25, 15, 300), gate_split="test", population=_real(["production", "human"]))
    assert raised.value.count == 40
    assert raised.value.min_items == 100
    assert raised.value.reason == "real_set_too_small"


def test_real_mode_with_human_only_counts_human_items():
    out = aggregate(_real_mix(70, 50, 300), gate_split="test", population=_real(["human"], min_items=50))
    assert out["overall"].recall_at_5.n == 50
    assert set(out["by_category"]) == {"typo"}


def test_real_mode_with_production_only_counts_production_items():
    out = aggregate(_real_mix(70, 50, 300), gate_split="test", population=_real(["production"], min_items=70))
    assert out["overall"].recall_at_5.n == 70
    assert set(out["by_category"]) == {"general"}


def test_committed_gate_population_file_is_legacy_and_loads_with_its_sha256():
    config, digest = load_gate_population()
    assert config == GatePopulationConfig(mode="legacy", provenances=["production", "human"], min_items=100)
    assert digest == hashlib.sha256(GATE_POPULATION_PATH.read_bytes()).hexdigest()
    assert GATE_POPULATION_PATH == REPO_ROOT / "eval" / "config" / "gate-population.json"


def test_load_gate_population_rejects_an_invalid_file(tmp_path: Path):
    path = tmp_path / "gate-population.json"
    path.write_text(json.dumps({"mode": "real", "provenances": ["synthetic_fixture"]}), encoding="utf-8")
    with pytest.raises(ValueError):
        load_gate_population(path)


LOADED_SHA = "a" * 64


def _real_golden() -> tuple[list[GoldenItem], list[RagTrace]]:
    golden, traces = _four_items()
    extra = [
        _item("it-colloquial-001", "it", answerable=True, category="colloquial").model_copy(update={"provenance": "production"}),
        _item("en-typo-001", "en", answerable=True, category="typo").model_copy(update={"provenance": "human"}),
        _item("zh-typo-001", "zh", answerable=True, category="typo").model_copy(update={"provenance": "human"}),
    ]
    extra_traces = [
        _trace("it-colloquial-001", [("doc.it.md", "refunds are accepted within thirty days")]),
        _trace("en-typo-001", [], refused=True),
        _trace("zh-typo-001", [("doc.zh.md", "refunds are accepted within thirty days")]),
    ]
    return [*golden, *extra], [*traces, *extra_traces]


def test_real_report_names_the_population_counts_and_report_only_provenances(tmp_path: Path):
    golden, traces = _real_golden()
    config = _real(["production", "human"], min_items=3)
    report = build_report(_manifest(), score_items(traces, golden), golden, gate_population_config=(config, LOADED_SHA))
    assert report.gate_population == "real"
    assert report.overall.recall_at_5.n == 3
    assert set(report.by_category) == {"colloquial", "typo"}
    assert "synthetic_fixture" in report.by_provenance
    _, md_path = write_report(report, tmp_path)
    md = md_path.read_text(encoding="utf-8")
    assert "Gate population: real" in md
    note = next(note for note in report.notes if note.startswith("Gate population is real"))
    assert "3 approved item(s)" in note
    assert "en 1, it 1, zh 1" in note
    assert "provenances production, human" in note
    assert "synthetic_fixture, claude_draft and ragas_generated items are report-only" in note
    assert any(LOADED_SHA in note and "mode real" in note for note in report.notes)


def test_report_records_the_gate_population_sha256_in_every_mode():
    golden, traces = _four_items()
    report = build_report(
        _manifest(), score_items(traces, golden), golden, gate_population_config=(GatePopulationConfig(), LOADED_SHA)
    )
    assert report.gate_population == "all"
    assert any(LOADED_SHA in note and "mode legacy" in note for note in report.notes)
    assert not any(note.startswith("Gate population is real") for note in report.notes)


def test_report_without_a_loaded_config_is_unchanged():
    golden, traces = _four_items()
    plain = build_report(_manifest(), score_items(traces, golden), golden)
    legacy = build_report(
        _manifest(), score_items(traces, golden), golden, gate_population_config=(GatePopulationConfig(), LOADED_SHA)
    )
    assert plain.notes == [note for note in legacy.notes if LOADED_SHA not in note]
    assert plain.model_dump(exclude={"notes"}) == legacy.model_dump(exclude={"notes"})


def _write_config(tmp_path: Path, config: GatePopulationConfig) -> Path:
    path = tmp_path / "gate-population.json"
    path.write_text(config.model_dump_json(), encoding="utf-8")
    return path


def test_runner_fails_a_small_real_set_with_its_own_exit_code_and_writes_no_report(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    golden, traces = _real_golden()
    traces_path, golden_path, manifest_path, out = _write_inputs(tmp_path, traces, golden)
    config_path = _write_config(tmp_path, _real(["production", "human"], min_items=100))
    out.mkdir()
    (out / "report.json").write_text("{}", encoding="utf-8")
    code = main([*_score_args(traces_path, golden_path, manifest_path, out), "--gate-population", str(config_path)])
    assert code == EXIT_REAL_SET_TOO_SMALL
    assert code not in (0, 1, 2)
    assert not (out / "report.json").exists() and not (out / "report.md").exists()
    err = capsys.readouterr().err
    assert "real_set_too_small" in err and "3" in err and "100" in err


def test_runner_records_the_loaded_config_sha256(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    golden, traces = _real_golden()
    traces_path, golden_path, manifest_path, out = _write_inputs(tmp_path, traces, golden)
    config_path = _write_config(tmp_path, _real(["production", "human"], min_items=3))
    digest = hashlib.sha256(config_path.read_bytes()).hexdigest()
    assert main([*_score_args(traces_path, golden_path, manifest_path, out), "--gate-population", str(config_path)]) == 0
    report = EvalReport.model_validate_json((out / "report.json").read_text(encoding="utf-8"))
    assert report.gate_population == "real"
    assert any(digest in note for note in report.notes)
    assert f"gate_population=real sha256={digest}" in capsys.readouterr().out


def test_runner_defaults_to_the_committed_legacy_file(tmp_path: Path):
    golden, traces = _four_items()
    traces_path, golden_path, manifest_path, out = _write_inputs(tmp_path, traces, golden)
    assert main(_score_args(traces_path, golden_path, manifest_path, out)) == 0
    report = EvalReport.model_validate_json((out / "report.json").read_text(encoding="utf-8"))
    _, digest = load_gate_population()
    assert any(digest in note and "mode legacy" in note for note in report.notes)


def test_paired_report_under_real_pairs_only_the_configured_provenances():
    items = [
        _paired_item("p1", provenance="production", hit5=1, hit10=1, rank=1),
        _paired_item("h1", provenance="human", language="zh", hit5=0, hit10=1, rank=6),
        _paired_item("f1", provenance="synthetic_fixture", hit5=1, hit10=1, rank=1),
        _paired_item("c1", provenance="claude_draft", hit5=1, hit10=1, rank=1),
    ]
    baseline = _baseline(_rows(items))
    real_report = _paired_report_fixture(items, "real")
    both = paired_report(real_report, baseline, _noise(), population=_real(["production", "human"], min_items=1))
    human = paired_report(real_report, baseline, _noise(), population=_real(["human"], min_items=1))
    assert both is not None and human is not None
    assert both.slices["overall"]["recall_at_5"].n == 2
    assert human.slices["overall"]["recall_at_5"].n == 1


def test_parse_gate_selects_real_items_from_the_committed_config_provenances():
    items = [
        _paired_item("p1", provenance="production"),
        _paired_item("h1", provenance="human"),
        _paired_item("f1", provenance="synthetic_fixture"),
        _paired_item("t1", provenance="production", split="test"),
    ]
    selected = _parse_gate_items(_paired_report_fixture(items, "real"))
    assert [item.item_id for item in selected] == ["p1", "h1"]
