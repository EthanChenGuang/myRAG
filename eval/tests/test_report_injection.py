import json

import pytest
from rag_sidecar.contracts.report import EvalReport
from test_injection_metrics import CANARY, INJECTED_QUOTE, _item, _trace
from test_report_runner import _four_items, _manifest

from rag_eval.metrics import score_items
from rag_eval.report import build_report, injection_config_label, write_report

RECOMMENDED = {
    "RAG_CONTEXT_TAGGING": "true",
    "RAG_INJECTION_CHECK": "drop",
    "RAG_INJECTION_PROMPT_GUARD": "false",
    "RAG_INJECTION_LAKERA": "false",
}


def _label(env: dict[str, str]) -> str:
    return injection_config_label([_trace("x-1", rag_env=env)])


def test_recommended_label():
    assert _label(RECOMMENDED) == "recommended"
    assert _label({"RAG_CONTEXT_TAGGING": "true", "RAG_INJECTION_CHECK": "drop"}) == "recommended"


def test_all_off_label_for_defaults_set_or_unset():
    assert _label({}) == "all_off"
    assert _label({"RAG_CONTEXT_TAGGING": "false", "RAG_INJECTION_CHECK": "off", "RAG_PIPELINE": "v2"}) == "all_off"


def test_tagging_only_label():
    assert _label({"RAG_CONTEXT_TAGGING": "true"}) == "tagging_only"
    assert _label({"RAG_CONTEXT_TAGGING": "true", "RAG_INJECTION_CHECK": "off"}) == "tagging_only"


def test_other_labels():
    assert _label({**RECOMMENDED, "RAG_INJECTION_LAKERA": "true"}) == "other"
    assert _label({**RECOMMENDED, "RAG_INJECTION_PROMPT_GUARD": "true"}) == "other"
    assert _label({"RAG_INJECTION_CHECK": "drop"}) == "other"
    assert _label({"RAG_CONTEXT_TAGGING": "true", "RAG_INJECTION_CHECK": "flag"}) == "other"


def test_traces_that_disagree_on_the_configuration_are_rejected():
    traces = [_trace("x-1", rag_env=RECOMMENDED), _trace("x-2", rag_env={})]
    with pytest.raises(ValueError, match="SEC configuration"):
        injection_config_label(traces)


def _injection_run(env: dict[str, str]):
    golden, traces = _four_items()
    golden = golden + [
        _item("en-injection-001", attack_doc="sec-attacks.en.md"),
        _item("zh-injection-001", language="zh", gold_doc="topic-sheet.zh.md", attack_doc="sec-attacks.zh.md"),
    ]
    traces = [t.model_copy(update={"effective_config": t.effective_config.model_copy(update={"rag_env": env})}) for t in traces]
    traces += [
        _trace("en-injection-001", context=INJECTED_QUOTE, answer=None, rag_env=env),
        _trace("zh-injection-001", answer=f"clean {CANARY}", rag_env=env),
    ]
    return golden, traces


def test_report_carries_the_injection_block_and_validates(tmp_path):
    golden, traces = _injection_run(RECOMMENDED)
    report = build_report(_manifest(), score_items(traces, golden), golden, traces)
    assert report.injection is not None
    assert report.injection.config_label == "recommended"
    assert report.injection.gate == "absolute_zero"
    assert report.injection.items == 2
    assert report.injection.exposure_rate["overall"].value == 0.5
    assert report.injection.attack_success_rate["overall"].value == 1.0
    assert report.injection.attack_success_rate["language_category:zh:injection"].value == 1.0

    json_path, md_path = write_report(report, tmp_path)
    EvalReport.model_validate(json.loads(json_path.read_text(encoding="utf-8")))
    markdown = md_path.read_text(encoding="utf-8")
    assert "## Injection" in markdown
    assert "Configuration: recommended" in markdown
    assert "| language_category:zh:injection |" in markdown
    assert "| category:injection |" in markdown


def test_non_recommended_report_is_report_only():
    golden, traces = _injection_run({})
    report = build_report(_manifest(), score_items(traces, golden), golden, traces)
    assert report.injection.config_label == "all_off"
    assert report.injection.gate == "report_only"


def test_report_without_injection_items_has_no_injection_block(tmp_path):
    golden, traces = _four_items()
    report = build_report(_manifest(), score_items(traces, golden), golden, traces)
    assert report.injection is None
    _, md_path = write_report(report, tmp_path)
    assert "## Injection" not in md_path.read_text(encoding="utf-8")
