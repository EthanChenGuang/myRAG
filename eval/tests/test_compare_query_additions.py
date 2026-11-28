import hashlib
import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.query_additions import QueryAdditionsDecisionRecord
from rag_sidecar.contracts.report import EvalReport, ItemResult
from rag_sidecar.contracts.samples import build_samples

from rag_eval.compare import query_additions as qa
from rag_eval.compare.__main__ import main as compare_main

QUERY = "Which sample module reports status code QX-17?"
LETTERS = list("abcdefghi")
VOICE_KEY = "RAG_QUERY_VOICE_TRANSFORMS:translate"

REQUIRED_TESTS = [
    "tests/rag/query/glossary-translate.test.ts",
    "tests/rag/query/glossary-rewrite.test.ts",
    "tests/rag/ingest-translate-glossary.test.ts",
    "tests/rag/lang/detect-cases.test.ts",
    "tests/rag/lang/resolve-query-language.test.ts",
    "tests/rag/query/speculative.test.ts",
    "tests/rag/model-router.test.ts",
    "tests/rag/query/history-fallback.test.ts",
    "tests/whatsapp/history.test.ts",
    "tests/rag/scope/stage.test.ts",
]


def item(item_id: str, **update) -> dict:
    base = {
        "item_id": item_id,
        "language": "en",
        "category": "general",
        "split": "dev",
        "provenance": "synthetic_fixture",
        "answerable": True,
        "refused": False,
        "span_count": 1,
        "spans_hit_at_5": 1,
        "spans_hit_at_10": 1,
        "first_hit_rank": 1,
    }
    return ItemResult.model_validate({**base, **update}).model_dump(mode="json")


def subq(item_id: str, language: str, hits5: int, hits10: int, total: int = 2) -> dict:
    return item(
        item_id,
        language=language,
        category="scoped_compound",
        span_count=total,
        spans_hit_at_5=hits5,
        spans_hit_at_10=hits10,
        first_hit_rank=1 if hits10 else None,
        subq_total=total,
        subq_hit_at_5=hits5,
        subq_hit_at_10=hits10,
    )


def refusal_item(item_id: str, language: str, refused: bool) -> dict:
    return item(
        item_id,
        language=language,
        category="no_answer",
        answerable=False,
        refused=refused,
        span_count=0,
        spans_hit_at_5=0,
        spans_hit_at_10=0,
        first_hit_rank=None,
    )


def cross(item_id: str, language: str, evidence: str, hit: bool) -> dict:
    return item(
        item_id,
        language=language,
        category="cross_lingual",
        evidence_language=evidence,
        spans_hit_at_5=1 if hit else 0,
        spans_hit_at_10=1 if hit else 0,
        first_hit_rank=1 if hit else None,
    )


GENERAL = [item(f"{lang}-general-00{n}", language=lang) for lang in ("en", "it", "zh") for n in (1, 2)]
NO_ANSWER = [refusal_item(f"{lang}-no-answer-001", lang, refused=False) for lang in ("en", "it", "zh")]


def plan(variants=("original",), detection_source: str | None = None, language: str = "en") -> dict:
    payload = {
        "original": QUERY,
        "standalone": QUERY,
        "language": language,
        "gate": {"rewrite": True, "transforms": ["condense_history"], "reasons": ["R1"], "lang": language, "protected_tokens": []},
        "variants": [
            {"text": QUERY, "language": language, "kind": kind, "protected_ok": True, **({"sub_question_index": 0} if kind == "sub_question" else {})}
            for kind in variants
        ],
        "sub_questions": [],
        "skipped": [],
        "framework": "llamaindex",
    }
    if detection_source is not None:
        payload["language_detection"] = {"language": language, "confidence": 0.4, "source": detection_source}
    return payload


def trace(item_id: str, latency: dict, *, query_plan=None, **extra) -> dict:
    payload = {
        "item_id": item_id,
        "query": QUERY,
        "query_context": {
            "is_temporal_query": False,
            "is_financial_query": False,
            "required_precision": "medium",
            "suggested_threshold": 0.3,
            "search_strategy": "semantic_only",
        },
        "retrieval_strategy": "standard",
        "candidates": [],
        "kept": [],
        "used_documents": [],
        "context": "",
        "refused": False,
        "citations": [],
        "stage_latency_ms": latency,
        "effective_config": {"rag_env": {}, "deployment_mode": "single-tenant", "embedding_model": "fixture", "endpoint_version": "1", "rag_prompt_sha256": {}},
        "config_hash": "a" * 64,
        **extra,
    }
    if query_plan is not None:
        payload["query_plan"] = query_plan
    return payload


BASE_LATENCY = {"query_gate": 1.0, "condense": 100.0, "semantic_cache": 2.0, "embed": 20.0, "search": 30.0, "fuse": 1.0}


def default_traces(items: list[dict], latency: dict | None = None, **extra) -> list[dict]:
    return [trace(entry["item_id"], dict(latency or BASE_LATENCY), **extra) for entry in items]


def write_arm(root: Path, name: str, items: list[dict], traces: list[dict] | None = None, *, passed=True, all_zero=None) -> Path:
    sample = build_samples()["samples"]["EvalReport"]
    report = EvalReport.model_validate({**sample, "items": items, "embedder_id": "fixture-ngram"})
    directory = root / f"q62-{name}"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "report.json").write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    gate = {"passed": passed, "offenders": [], "skipped": [], "mismatches": []}
    if all_zero is not None:
        gate["paired"] = {"seed": 1, "resamples": 1, "all_zero": all_zero, "slices": {}}
    (directory / "gate.json").write_text(json.dumps(gate) + "\n", encoding="utf-8")
    rows = traces if traces is not None else default_traces(items)
    (directory / "traces.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    return directory


def vitest_json(root: Path, failed: set[str] = frozenset()) -> Path:
    path = root / "vitest.json"
    results = [
        {"name": f"/checkout/{name}", "status": "failed" if name in failed else "passed", "assertionResults": [{"status": "passed"}]}
        for name in REQUIRED_TESTS
    ]
    path.write_text(json.dumps({"success": not failed, "testResults": results}), encoding="utf-8")
    return path


def whatsapp(root: Path, passed: bool = True) -> Path:
    directory = root / "q62-whatsapp-multi-turn"
    directory.mkdir(parents=True, exist_ok=True)
    counts = {"items": 3, "condense_eligible": 3, "condensed": 3, "eligible_passed": 3 if passed else 1, "gold_retrieved": 3}
    report = {
        "schema_version": 1,
        "name": "q62-whatsapp-multi-turn",
        "entry_point": "whatsapp",
        "whatsapp_history": True,
        "items": [],
        "by_language": {"en": counts},
        "totals": counts,
        "passed": passed,
    }
    (directory / "whatsapp-report.json").write_text(json.dumps(report), encoding="utf-8")
    return directory


def compound(hits: list[tuple[int, int]]) -> list[dict]:
    return [subq(f"{lang}-compound-00{n}", lang, *hits[i]) for i, (lang, n) in enumerate([("en", 1), ("it", 1), ("zh", 1), ("en", 2)])]


def arms(root: Path, **overrides) -> list[Path]:
    """A full synthetic set where every switch is eligible; overrides replace one arm's items or traces."""
    weak = compound([(0, 1), (1, 1), (0, 0), (1, 1)])
    better = compound([(1, 2), (1, 2), (1, 1), (2, 2)])
    best = compound([(2, 2), (2, 2), (1, 2), (2, 2)])
    plain = GENERAL + NO_ANSWER
    gate_refusals = GENERAL + [refusal_item(f"{lang}-no-answer-001", lang, refused=True) for lang in ("en", "it", "zh")]
    xl_off = [cross("xl-en-zh-01", "en", "zh", False), cross("xl-zh-en-01", "zh", "en", True)]
    xl_on = [cross("xl-en-zh-01", "en", "zh", True), cross("xl-zh-en-01", "zh", "en", True)]
    voice = {"query_gate": 1.0, "condense": 80.0, "normalize_dates": 1.0, "semantic_cache": 1.0}
    spec = {
        "single-pass": (plain + weak, None),
        "decompose": (plain + better, None),
        "completeness": (plain + best, None),
        "subq-filters": (plain + compound([(2, 2), (2, 2), (2, 2), (2, 2)]), None),
        "glossary": (plain + weak, None),
        "scope-gate": (gate_refusals + weak, default_traces(gate_refusals + weak, scope_gate={"label": "out_of_scope", "score": 0.1, "negative_score": None, "reason": "below_threshold", "centroid_count": 3, "latency_ms": 2.0})),
        "speculative": (plain + weak, default_traces(plain + weak, {**BASE_LATENCY, "condense": 40.0}, speculative={"started_ms": 1.0, "overlap_ms": 60.0, "cancelled_by_cache": False, "wasted_searches": 0})),
        "routing": (plain + weak, default_traces(plain + weak, {**BASE_LATENCY, "generation": 50.0}, model_route={"tier": "fast", "rule": "simple_lookup", "selection": "auto"})),
        "voice-no-translate": (xl_off, default_traces(xl_off, voice)),
        "voice-translate": (xl_on, default_traces(xl_on, {**voice, "translate": 120.0})),
    }
    spec.update(overrides)
    paths = []
    for name, (items, traces) in spec.items():
        if name == "single-pass" and traces is None:
            traces = default_traces(items, {**BASE_LATENCY, "generation": 200.0})
        paths.append(write_arm(root, name, items, traces))
    paths.append(write_arm(root, "30-defaults", plain, all_zero=True))
    paths.append(whatsapp(root))
    return paths


def run_tool(tmp_path: Path, runs: list[Path], *extra: str, tests: Path | None = None) -> tuple[int, Path, Path]:
    out = tmp_path / "report"
    decision = tmp_path / "decision.json"
    argv = ["query-additions", "--runs", *map(str, runs), "--out", str(out), "--decision", str(decision)]
    argv += ["--tests", str(tests if tests is not None else vitest_json(tmp_path))]
    argv += ["--recorded-at", "2026-11-27T00:00:00Z", *extra]
    return compare_main(argv), out, decision


def record(decision: Path) -> QueryAdditionsDecisionRecord:
    return QueryAdditionsDecisionRecord.model_validate_json(decision.read_text(encoding="utf-8"))


def entry(rec: QueryAdditionsDecisionRecord, name: str):
    return next(switch for switch in rec.switches if switch.name == name)


def test_every_switch_is_keyed_by_its_variable_and_eligible_on_the_synthetic_set(tmp_path):
    code, out, decision = run_tool(tmp_path, arms(tmp_path / "runs"))
    assert code == 0
    rec = record(decision)
    assert [switch.name for switch in rec.switches] == list(qa.SWITCH_NAMES)
    assert set(qa.SWITCH_NAMES) == {
        "RAG_QUERY_DECOMPOSE",
        "RAG_QUERY_DECOMPOSE_COMPLETENESS",
        "RAG_QUERY_SUBQ_FILTERS",
        "RAG_TRANSLATION_GLOSSARY",
        "RAG_SPECULATIVE_RETRIEVAL",
        "RAG_MODEL_ROUTING",
        "RAG_SCOPE_GATE",
        VOICE_KEY,
    }
    assert {switch.name: switch.eligible for switch in rec.switches} == {name: True for name in qa.SWITCH_NAMES}
    assert "category:scoped_compound" in entry(rec, "RAG_QUERY_DECOMPOSE_COMPLETENESS").improved_slices
    assert (out / "report.json").is_file() and (out / "report.md").is_file()


def test_completeness_with_a_drop_beyond_noise_on_another_slice_is_not_eligible(tmp_path):
    runs = tmp_path / "runs"
    best = compound([(2, 2), (2, 2), (1, 2), (2, 2)])
    dropped = [item(entry["item_id"], language=entry["language"], spans_hit_at_5=0, spans_hit_at_10=0, first_hit_rank=None) if entry["language"] == "it" else entry for entry in GENERAL]
    _, _, decision = run_tool(tmp_path, arms(runs, completeness=(dropped + NO_ANSWER + best, None)))
    completeness = entry(record(decision), "RAG_QUERY_DECOMPOSE_COMPLETENESS")
    assert completeness.eligible is False
    assert "category:scoped_compound" in completeness.improved_slices
    assert "language:it:recall_at_5" in completeness.regressions


def test_completeness_without_an_improvement_is_not_eligible(tmp_path):
    runs = tmp_path / "runs"
    better = compound([(1, 2), (1, 2), (1, 1), (2, 2)])
    _, _, decision = run_tool(tmp_path, arms(runs, completeness=(GENERAL + NO_ANSWER + better, None)))
    completeness = entry(record(decision), "RAG_QUERY_DECOMPOSE_COMPLETENESS")
    assert completeness.eligible is False
    assert completeness.improved_slices == []
    assert completeness.regressions == []


@pytest.mark.parametrize(("translate_ms", "eligible"), [(320.0, False), (280.0, True)])
def test_voice_translate_needs_the_improvement_within_the_voice_query_budget(tmp_path, translate_ms, eligible):
    xl_on = [cross("xl-en-zh-01", "en", "zh", True), cross("xl-zh-en-01", "zh", "en", True)]
    latency = {"query_gate": 1.0, "condense": 10.0, "normalize_dates": 1.0, "semantic_cache": 1.0, "translate": translate_ms - 12.0}
    _, out, decision = run_tool(tmp_path, arms(tmp_path / "runs", **{"voice-translate": (xl_on, default_traces(xl_on, latency))}))
    voice = entry(record(decision), VOICE_KEY)
    assert voice.eligible is eligible
    assert "pair:en->zh" in voice.improved_slices
    assert f"{translate_ms:g} ms" in voice.notes
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    pairs = report["voice_pairs"]
    assert set(pairs) == {"pair:en->zh", "pair:zh->en"}
    assert pairs["pair:en->zh"]["reference"]["recall_at_5"] == 0.0 and pairs["pair:en->zh"]["candidate"]["recall_at_5"] == 1.0


def test_voice_translate_without_a_cross_lingual_improvement_is_not_eligible(tmp_path):
    xl_off = [cross("xl-en-zh-01", "en", "zh", False), cross("xl-zh-en-01", "zh", "en", True)]
    latency = {"query_gate": 1.0, "condense": 10.0, "translate": 50.0}
    _, _, decision = run_tool(tmp_path, arms(tmp_path / "runs", **{"voice-translate": (xl_off, default_traces(xl_off, latency))}))
    assert entry(record(decision), VOICE_KEY).eligible is False


def test_speculative_is_judged_on_the_all_turns_p95(tmp_path):
    plain = GENERAL + NO_ANSWER + compound([(0, 1), (1, 1), (0, 0), (1, 1)])
    # New-variant turns are faster with speculation, the slowest (no-new-variant) turns are unchanged: all-turns p95 equal.
    new_variant = plan(variants=("original", "condensed"))
    reference = [trace(row["item_id"], {**BASE_LATENCY, "generation": 200.0, "condense": 300.0 if i == 0 else 100.0}, query_plan=new_variant if i else plan()) for i, row in enumerate(plain)]
    candidate = [
        trace(row["item_id"], {**BASE_LATENCY, "condense": 300.0 if i == 0 else 50.0}, query_plan=new_variant if i else plan(), speculative={"started_ms": 1.0, "overlap_ms": 0.0, "cancelled_by_cache": False, "wasted_searches": 0})
        for i, row in enumerate(plain)
    ]
    _, out, decision = run_tool(tmp_path, arms(tmp_path / "runs", **{"single-pass": (plain, reference), "speculative": (plain, candidate)}))
    speculative = entry(record(decision), "RAG_SPECULATIVE_RETRIEVAL")
    assert speculative.eligible is False
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    timing = report["arms"]["speculative"]["latency"]["pre_retrieval"]
    assert set(timing) == {"all_turns", "new_variant", "no_new_variant"}
    reference_timing = report["arms"]["single-pass"]["latency"]["pre_retrieval"]
    assert timing["all_turns"]["p95_ms"] == reference_timing["all_turns"]["p95_ms"]
    assert timing["new_variant"]["p95_ms"] < reference_timing["new_variant"]["p95_ms"]
    assert timing["all_turns"]["n"] == len(plain)
    assert timing["new_variant"]["n"] + timing["no_new_variant"]["n"] == len(plain)


def test_pre_retrieval_is_request_start_to_the_end_of_fuse():
    row = qa.RagTrace.model_validate(
        trace("x", {"query_gate": 1.0, "condense": 10.0, "expand": 30.0, "translate": 20.0, "semantic_cache": 2.0, "embed": 5.0, "search": 7.0, "fuse": 1.0, "rerank": 500.0, "generation": 900.0})
    )
    assert qa.pre_retrieval_ms(row) == 1.0 + 10.0 + 30.0 + 2.0 + 5.0 + 7.0 + 1.0
    overlapped = row.model_copy(update={"speculative": qa.SpeculativeTrace(started_ms=1.0, overlap_ms=12.0, cancelled_by_cache=False, wasted_searches=0)})
    assert qa.pre_retrieval_ms(overlapped) == 56.0 - 12.0
    assert qa.pre_retrieval_ms(qa.RagTrace.model_validate(trace("y", {"query_gate": 1.0}))) is None


@pytest.mark.parametrize(("refused", "generation", "eligible"), [(False, 50.0, True), (True, 50.0, False), (False, 200.0, False)])
def test_routing_needs_refusals_within_noise_and_a_lower_generation_p95(tmp_path, refused, generation, eligible):
    weak = compound([(0, 1), (1, 1), (0, 0), (1, 1)])
    no_answer = [refusal_item("en-no-answer-001", "en", refused=refused), *NO_ANSWER[1:]]
    items = GENERAL + no_answer + weak
    traces = default_traces(items, {**BASE_LATENCY, "generation": generation}, model_route={"tier": "fast", "rule": "simple_lookup", "selection": "auto"})
    _, _, decision = run_tool(tmp_path, arms(tmp_path / "runs", routing=(items, traces)))
    routing = entry(record(decision), "RAG_MODEL_ROUTING")
    assert routing.eligible is eligible
    if refused:
        assert "language:en:correct_refusal_rate" in routing.regressions


def test_scope_gate_needs_correct_refusals_up_false_refusals_in_band_and_off_equal_to_baseline(tmp_path):
    _, _, decision = run_tool(tmp_path, arms(tmp_path / "runs"))
    assert entry(record(decision), "RAG_SCOPE_GATE").eligible is True

    falsely = [item(row["item_id"], language=row["language"], refused=True) if row["language"] == "en" else row for row in GENERAL]
    gate_refusals = [refusal_item(f"{lang}-no-answer-001", lang, refused=True) for lang in ("en", "it", "zh")]
    weak = compound([(0, 1), (1, 1), (0, 0), (1, 1)])
    _, _, decision = run_tool(tmp_path / "b", arms(tmp_path / "b" / "runs", **{"scope-gate": (falsely + gate_refusals + weak, None)}))
    scope = entry(record(decision), "RAG_SCOPE_GATE")
    assert scope.eligible is False
    assert "language:en:false_refusal_rate" in scope.regressions

    runs = arms(tmp_path / "c" / "runs")
    write_arm(tmp_path / "c" / "runs", "30-defaults", GENERAL + NO_ANSWER, all_zero=False)
    _, _, decision = run_tool(tmp_path / "c", runs)
    rec = record(decision)
    assert entry(rec, "RAG_SCOPE_GATE").eligible is False
    assert next(check for check in rec.d31_checklist if check.letter == "a").passed is False


def test_the_record_carries_the_report_hash_and_every_d31_letter(tmp_path):
    _, out, decision = run_tool(tmp_path, arms(tmp_path / "runs"))
    rec = record(decision)
    assert rec.decided_by == "rag_eval.compare query-additions"
    assert rec.source == "fixture"
    assert rec.report_hash == hashlib.sha256((out / "report.json").read_bytes()).hexdigest()
    assert [check.letter for check in rec.d31_checklist] == LETTERS
    assert all(check.passed for check in rec.d31_checklist), [(c.letter, c.evidence) for c in rec.d31_checklist if not c.passed]
    assert all(check.evidence for check in rec.d31_checklist)


def test_missing_evidence_fails_its_letters(tmp_path):
    runs = [path for path in arms(tmp_path / "runs") if not path.name.startswith("q62-whatsapp")]
    tests = vitest_json(tmp_path, failed={"tests/rag/lang/detect-cases.test.ts"})
    _, _, decision = run_tool(tmp_path, runs, tests=tests)
    checks = {check.letter: check for check in record(decision).d31_checklist}
    assert checks["d"].passed is False and "detect-cases.test.ts" in checks["d"].evidence
    assert checks["g"].passed is False
    assert checks["c"].passed is True


def test_two_runs_write_identical_files_and_check_rederives_the_record(tmp_path):
    runs = arms(tmp_path / "runs")
    _, out, decision = run_tool(tmp_path, runs)
    first = (decision.read_bytes(), (out / "report.json").read_bytes(), (out / "report.md").read_bytes())
    code, _, _ = run_tool(tmp_path, runs)
    assert code == 0
    assert first == (decision.read_bytes(), (out / "report.json").read_bytes(), (out / "report.md").read_bytes())
    assert compare_main(["query-additions", "--check", str(decision), "--out", str(out)]) == 0

    edited = json.loads(decision.read_text(encoding="utf-8"))
    edited["switches"][0]["eligible"] = not edited["switches"][0]["eligible"]
    decision.write_text(json.dumps(edited, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    assert compare_main(["query-additions", "--check", str(decision), "--out", str(out)]) == qa.EXIT_STALE


def test_check_reads_the_committed_report_when_the_runs_are_gone(tmp_path):
    runs = arms(tmp_path / "runs")
    _, out, decision = run_tool(tmp_path, runs)
    for path in runs:
        for child in path.iterdir():
            child.unlink()
        path.rmdir()
    assert compare_main(["query-additions", "--check", str(decision), "--out", str(out)]) == 0


def test_language_source_slice_reports_items_resolved_by_the_lang08_chain(tmp_path):
    items = GENERAL + NO_ANSWER + compound([(0, 1), (1, 1), (0, 0), (1, 1)])
    traces = [
        trace(row["item_id"], {**BASE_LATENCY, "generation": 200.0}, query_plan=plan(detection_source="llm" if i < 2 else "detector"))
        for i, row in enumerate(items)
    ]
    _, out, _ = run_tool(tmp_path, arms(tmp_path / "runs", **{"single-pass": (items, traces)}))
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    slices = report["arms"]["single-pass"]["language_source_slices"]
    assert set(slices) == {"language_source:llm"}
    assert slices["language_source:llm"]["items"] == 2
    assert "language_source:llm" in (out / "report.md").read_text(encoding="utf-8")


def test_unknown_run_directories_are_listed_and_ignored(tmp_path):
    runs = arms(tmp_path / "runs")
    stray = write_arm(tmp_path / "runs", "scratch-arm", GENERAL)
    code, out, _ = run_tool(tmp_path, [*runs, stray])
    assert code == 0
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert report["ignored_runs"] == ["q62-scratch-arm"]


def test_a_missing_arm_makes_its_switch_ineligible_with_a_note(tmp_path):
    runs = [path for path in arms(tmp_path / "runs") if path.name != "q62-routing"]
    code, _, decision = run_tool(tmp_path, runs)
    assert code == 0
    routing = entry(record(decision), "RAG_MODEL_ROUTING")
    assert routing.eligible is False
    assert "routing" in routing.notes


def test_query_additions_is_registered_in_the_compare_cli(capsys):
    with pytest.raises(SystemExit):
        compare_main(["query-additions", "--help"])
    assert "--decision" in capsys.readouterr().out
