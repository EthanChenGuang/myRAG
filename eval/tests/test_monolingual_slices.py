"""D-03: a monolingual run skips the cross-lingual, language-pair and other-language slices."""

import json
from pathlib import Path

from rag_sidecar.contracts.golden import GoldenItem

from rag_eval.metrics import score_items
from rag_eval.report import build_report, run_supported_languages, write_report
from test_report_runner import QUOTE, _item, _manifest, _trace


def _cross(item_id: str, language: str, evidence_language: str) -> GoldenItem:
    base = _item(item_id, language, answerable=True).model_dump(mode="json")
    evidence = [{"document": f"doc.{evidence_language}.md", "section": "s", "quote": QUOTE}]
    return GoldenItem.model_validate(
        {**base, "category": "cross_lingual", "gold_evidence": evidence, "evidence_language": evidence_language}
    )


def _golden_and_traces():
    golden = [
        _item("en-general-001", "en", answerable=True),
        _item("zh-general-001", "zh", answerable=True),
        _item("it-general-001", "it", answerable=True),
        _cross("en-cross-001", "en", "zh"),
        _item("en-none-001", "en", answerable=False),
    ]
    traces = [
        _trace("en-general-001", [("doc.en.md", QUOTE)]),
        _trace("zh-general-001", [("doc.zh.md", QUOTE)]),
        _trace("it-general-001", [("doc.it.md", QUOTE)]),
        _trace("en-cross-001", [("doc.zh.md", QUOTE)]),
        _trace("en-none-001", [], refused=True),
    ]
    return golden, traces


def _build(languages):
    golden, traces = _golden_and_traces()
    return build_report(_manifest(), score_items(traces, golden), golden, traces, supported_languages=languages)


def test_monolingual_run_skips_cross_lingual_pair_and_other_language_slices(tmp_path: Path):
    report = _build(("en",))
    assert set(report.by_language) == {"en"}
    assert "cross_lingual" not in report.by_category
    assert report.by_language_pair == {}
    assert all(key.startswith("en/") and not key.endswith("/cross_lingual") for key in report.by_language_category)
    skipped = [note for note in report.notes if note.startswith("Monolingual run")]
    assert len(skipped) == 1
    assert "cross_lingual" in skipped[0] and "it, zh" in skipped[0]
    _, md_path = write_report(report, tmp_path)
    assert skipped[0] in md_path.read_text(encoding="utf-8")


def test_three_language_run_is_unchanged():
    pinned = _build(("zh", "en", "it"))
    unset = _build(())
    assert pinned.model_dump() == unset.model_dump()
    assert {"en", "zh", "it"} <= set(pinned.by_language)
    assert "cross_lingual" in pinned.by_category
    assert not any(note.startswith("Monolingual run") for note in pinned.notes)


def test_language_set_comes_from_the_run_config_then_the_eval_pin(tmp_path: Path):
    pin = tmp_path / "pin.json"
    pin.write_text(json.dumps({"RAG_SUPPORTED_LANGUAGES": "zh,en,it"}), encoding="utf-8")
    assert run_supported_languages(_manifest(), pin) == ("zh", "en", "it")
    manifest = _manifest()
    configured = type(manifest).model_validate(
        {**manifest.model_dump(mode="json"), "run_config": {"name": "mono", "env": {"RAG_SUPPORTED_LANGUAGES": " EN "}}}
    )
    assert run_supported_languages(configured, pin) == ("en",)
    assert run_supported_languages(_manifest(), tmp_path / "missing.json") == ()


def test_the_shipped_eval_pin_is_three_languages():
    assert run_supported_languages(_manifest()) == ("zh", "en", "it")
