"""Phase 5.3 D-51, research X-9: imported (historical) questions keep their provenance through promote-db into the real set."""

import json

from rag_sidecar.contracts.feedback_loop import GatePopulationConfig
from test_review_queue import (  # noqa: F401
    _App,
    _domain_dir,
    _golden_line,
    _install,
    _promote_db,
    private_root,
)

from rag_eval.config_files import (
    GATE_POPULATION_PATH,
    load_gate_population,
    write_gate_population,
)
from rag_eval.golden_io import load_golden


def _with_source(line: dict, source: str | None) -> dict:
    return {**line, "source": source}


def test_promote_db_maps_source_historical_to_provenance_historical(private_root, monkeypatch):  # noqa: F811
    _install(monkeypatch, _App([_with_source({**_golden_line(1), "reasons": ["representative"]}, "historical")]))
    assert _promote_db() == 0
    (item,) = load_golden(_domain_dir(private_root) / "golden.jsonl")
    assert item.provenance == "historical"
    assert item.review_status == "approved"


def test_promote_db_keeps_historical_when_the_expert_reworded_the_question(private_root, monkeypatch):  # noqa: F811
    line = _golden_line(1, paraphrased_question="How does the synthetic widget behave?")
    _install(monkeypatch, _App([_with_source(line, "historical")]))
    assert _promote_db() == 0
    (item,) = load_golden(_domain_dir(private_root) / "golden.jsonl")
    assert item.provenance == "historical"
    assert item.question == "How does the synthetic widget behave?"


def test_promote_db_without_a_source_or_with_another_source_promotes_as_before(private_root, monkeypatch):  # noqa: F811
    lines = [
        _golden_line(1),
        _with_source(_golden_line(2, question="What does synthetic feature two return?", paraphrased_question="What does the second synthetic feature return?"), None),
        _with_source(_golden_line(3, question="Where do synthetic records three move?"), "representative"),
    ]
    _install(monkeypatch, _App(lines))
    assert _promote_db() == 0
    items = load_golden(_domain_dir(private_root) / "golden.jsonl")
    by_question = {item.question: item.provenance for item in items}
    assert by_question == {
        "How does synthetic feature number 1 behave?": "production",
        "What does the second synthetic feature return?": "human",
        "Where do synthetic records three move?": "production",
    }


def test_promote_db_refuses_an_unknown_source(private_root, monkeypatch, capsys):  # noqa: F811
    app = _App([_with_source(_golden_line(1), "invented")])
    _install(monkeypatch, app)
    assert _promote_db() != 0
    assert not (_domain_dir(private_root) / "golden.jsonl").exists()
    assert app.marked == []


def test_committed_gate_population_lists_historical_and_keeps_its_mode():
    config, _ = load_gate_population()
    assert config.provenances == ["production", "human", "historical"]
    assert config.mode == "legacy"
    assert config.min_items == 100


def test_committed_gate_population_is_in_the_writer_format(tmp_path):
    config, _ = load_gate_population()
    rewritten = tmp_path / "gate-population.json"
    write_gate_population(GatePopulationConfig.model_validate(json.loads(GATE_POPULATION_PATH.read_text(encoding="utf-8"))), rewritten)
    assert rewritten.read_bytes() == GATE_POPULATION_PATH.read_bytes()
    assert load_gate_population(rewritten)[0] == config
