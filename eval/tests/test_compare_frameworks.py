import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.report import EvalReport, ItemResult
from rag_sidecar.contracts.samples import build_samples

from rag_eval.compare import frameworks
from rag_eval.compare.__main__ import main as compare_main
from rag_eval.paired import RESAMPLES, SEED

QUERY = "Which sample module reports status code QX-17?"


def item(item_id: str, **update) -> ItemResult:
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
    return ItemResult.model_validate({**base, **update})


def candidate(rank: int, chunk_id: str, fused: float | None) -> dict:
    return {
        "rank": rank,
        "chunk_id": chunk_id,
        "document_id": "doc-1",
        "content": "synthetic sentence",
        "similarity": 0.5,
        "fused_score": fused,
        "has_image": False,
    }


def plan(framework: str, **update) -> dict:
    base = {
        "original": QUERY,
        "standalone": QUERY,
        "language": "en",
        "gate": {"rewrite": True, "transforms": ["condense_history"], "reasons": ["R1"], "lang": "en", "protected_tokens": ["QX-17"]},
        "variants": [{"text": QUERY, "language": "en", "kind": "original", "protected_ok": True}],
        "sub_questions": [],
        "skipped": [],
        "framework": framework,
    }
    return {**base, **update}


def trace(item_id: str, framework: str, *, candidates=None, query_plan=None, transforms=None) -> RagTrace:
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
        "query_transforms": transforms if transforms is not None else [{"kind": "condensed", "text": QUERY, "transform": "condense", "status": "ok"}],
        "query_plan": query_plan if query_plan is not None else plan(framework),
        "candidates": candidates if candidates is not None else [candidate(1, "c-1", 0.03), candidate(2, "c-2", 0.02)],
        "kept": [],
        "used_documents": [],
        "context": "",
        "refused": False,
        "citations": [],
        "stage_latency_ms": {"search": 1.0},
        "effective_config": {"rag_env": {}, "deployment_mode": "single-tenant", "embedding_model": "fixture", "endpoint_version": "1", "rag_prompt_sha256": {}},
        "config_hash": "a" * 64,
    }
    return RagTrace.model_validate(payload)


def run(framework: str, items: list[ItemResult], traces: list[RagTrace] | None = None) -> frameworks.FrameworkRun:
    return frameworks.FrameworkRun(
        framework=framework,
        items=items,
        traces=traces if traces is not None else [trace(entry.item_id, framework) for entry in items],
        run_config_hash="b" * 64,
        embedder="fixture-ngram",
    )


ITEMS = [
    item("en-general-001"),
    item("it-general-001", language="it"),
    item("zh-general-001", language="zh"),
    item("xl-en-zh-01", category="cross_lingual", evidence_language="zh"),
    item("en-no-answer-001", category="no_answer", answerable=False, refused=True, span_count=0, spans_hit_at_5=0, spans_hit_at_10=0, first_hit_rank=None),
]


def test_identical_runs_have_zero_differences_in_every_slice():
    report = frameworks.compare(run("llamaindex", ITEMS), run("langchain", ITEMS))
    assert report.all_zero is True
    assert report.seed == SEED and report.resamples == RESAMPLES
    assert set(report.languages) == {"en", "it", "zh"}
    assert set(report.categories) == {"general", "cross_lingual", "no_answer"}
    assert set(report.language_pairs) == {"en->zh"}
    for stats in [report.overall, *report.languages.values(), *report.categories.values(), *report.language_pairs.values()]:
        for stat in stats.values():
            assert stat.n_nonzero == 0
            assert stat.mean_d in (0.0, None)
    assert report.overall["mrr"].n == 4
    assert report.overall["correct_refusal_rate"].n == 1
    assert report.transforms == []
    assert report.fused_order.identical == len(ITEMS)
    assert report.fused_order.tie_only == 0 and report.fused_order.rank == 0
    assert report.problems == []


def test_paired_differences_are_langchain_minus_llamaindex_per_slice():
    langchain_items = [entry.model_copy() for entry in ITEMS]
    langchain_items[3] = langchain_items[3].model_copy(update={"first_hit_rank": 2, "spans_hit_at_5": 0})
    langchain_items[4] = langchain_items[4].model_copy(update={"refused": False})
    report = frameworks.compare(run("llamaindex", ITEMS), run("langchain", langchain_items))
    assert report.all_zero is False
    pair = report.language_pairs["en->zh"]
    assert pair["mrr"].n == 1 and pair["mrr"].mean_d == -0.5
    assert pair["recall_at_5"].mean_d == -1.0
    assert (pair["recall_at_5"].ci_low, pair["recall_at_5"].ci_high) == (-1.0, -1.0)
    assert report.languages["en"]["mrr"].n == 2 and report.languages["en"]["mrr"].mean_d == -0.25
    assert report.languages["it"]["mrr"].n_nonzero == 0
    assert report.categories["no_answer"]["correct_refusal_rate"].mean_d == -1.0
    assert report.overall["mrr"].n_nonzero == 1


def test_transform_differences_name_items_and_fields_without_query_text():
    reference = [trace(entry.item_id, "llamaindex") for entry in ITEMS]
    candidate_traces = list(reference)
    changed = plan(
        "langchain",
        standalone="Which sample module reports the status code QX-17 today?",
        skipped=[{"transform": "hyde", "reason": "timeout"}],
    )
    candidate_traces[0] = trace(ITEMS[0].item_id, "langchain", query_plan=changed)
    candidate_traces[1] = trace(
        ITEMS[1].item_id,
        "langchain",
        transforms=[{"kind": "condensed", "text": QUERY, "transform": "condense", "status": "skipped", "reason": "error"}],
    )
    report = frameworks.compare(run("llamaindex", ITEMS, reference), run("langchain", ITEMS, candidate_traces))
    by_transform = {entry.transform: entry for entry in report.transforms}
    assert set(by_transform) == {"condense_history", "hyde"}
    condense = {row.item_id: row.fields for row in by_transform["condense_history"].items}
    assert condense == {"en-general-001": ["standalone"], "it-general-001": ["status"]}
    assert [(row.item_id, row.fields) for row in by_transform["hyde"].items] == [("en-general-001", ["skipped"])]
    assert by_transform["condense_history"].n_items == 2
    dumped = report.model_dump_json()
    assert QUERY not in dumped and "today" not in dumped
    assert any("condense_history" in problem and "error" in problem for problem in report.problems)


def test_tie_order_differences_are_counted_apart_from_rank_differences():
    tied = [candidate(1, "c-1", 0.03), candidate(2, "c-2", 0.03), candidate(3, "c-3", 0.01)]
    tied_swapped = [candidate(1, "c-2", 0.03), candidate(2, "c-1", 0.03), candidate(3, "c-3", 0.01)]
    distinct = [candidate(1, "c-1", 0.03), candidate(2, "c-2", 0.02)]
    distinct_swapped = [candidate(1, "c-2", 0.03), candidate(2, "c-1", 0.02)]
    boundary = [candidate(1, "c-1", 0.03), candidate(2, "c-2", 0.01)]
    boundary_other = [candidate(1, "c-1", 0.03), candidate(2, "c-9", 0.01)]
    pairs = [(tied, tied_swapped), (distinct, distinct_swapped), (boundary, boundary_other), (distinct, distinct), (tied, tied)]
    reference = [trace(entry.item_id, "llamaindex", candidates=a) for entry, (a, _) in zip(ITEMS, pairs)]
    other = [trace(entry.item_id, "langchain", candidates=b) for entry, (_, b) in zip(ITEMS, pairs)]
    report = frameworks.compare(run("llamaindex", ITEMS, reference), run("langchain", ITEMS, other))
    assert report.fused_order.identical == 2
    assert report.fused_order.tie_only == 2
    assert report.fused_order.rank == 1
    assert report.fused_order.tie_only_items == ["en-general-001", "zh-general-001"]
    assert report.fused_order.rank_items == ["it-general-001"]


def test_framework_fallback_and_unpaired_items_are_problems():
    fallback = [trace(entry.item_id, "llamaindex") for entry in ITEMS]
    report = frameworks.compare(run("llamaindex", ITEMS), run("langchain", ITEMS, fallback))
    assert any("framework" in problem for problem in report.problems)
    with pytest.raises(frameworks.ComparisonError):
        frameworks.compare(run("llamaindex", ITEMS), run("langchain", ITEMS[:-1]))


def write_run(directory: Path, framework: str, items: list[ItemResult], traces: list[RagTrace] | None = None) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    sample = build_samples()["samples"]["EvalReport"]
    report = EvalReport.model_validate({**sample, "items": [entry.model_dump(mode="json") for entry in items]})
    (directory / "report.json").write_text(report.model_dump_json(), encoding="utf-8")
    rows = traces if traces is not None else [trace(entry.item_id, framework) for entry in items]
    (directory / "traces.jsonl").write_text("".join(row.model_dump_json() + "\n" for row in rows), encoding="utf-8")
    return directory


def test_cli_compares_two_run_directories_and_writes_json_and_markdown(tmp_path: Path):
    a = write_run(tmp_path / "a", "llamaindex", ITEMS)
    b = write_run(tmp_path / "b", "langchain", ITEMS)
    out = tmp_path / "out"
    code = compare_main(["frameworks", "--llamaindex", str(a), "--langchain", str(b), "--out", str(out)])
    assert code == frameworks.EXIT_OK
    payload = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert len(payload["languages"]) == 3
    markdown = (out / "report.md").read_text(encoding="utf-8")
    assert "plumbing" in markdown
    assert "tie" in markdown
    assert "lexical fixture embedder" in markdown


def test_cli_exit_codes(tmp_path: Path):
    a = write_run(tmp_path / "a", "llamaindex", ITEMS)
    missing = tmp_path / "missing"
    assert compare_main(["frameworks", "--llamaindex", str(a), "--langchain", str(missing), "--out", str(tmp_path / "o1")]) == frameworks.EXIT_INVALID
    short = write_run(tmp_path / "short", "langchain", ITEMS[:-1])
    assert compare_main(["frameworks", "--llamaindex", str(a), "--langchain", str(short), "--out", str(tmp_path / "o2")]) == frameworks.EXIT_INVALID
    fallback = write_run(tmp_path / "fallback", "langchain", ITEMS, [trace(entry.item_id, "llamaindex") for entry in ITEMS])
    code = compare_main(["frameworks", "--llamaindex", str(a), "--langchain", str(fallback), "--out", str(tmp_path / "o3")])
    assert code == frameworks.EXIT_INVALID
    assert (tmp_path / "o3" / "report.json").is_file()
    with pytest.raises(SystemExit):
        compare_main(["frameworks", "--out", str(tmp_path / "o4")])


def test_fixtures_mode_runs_both_run_configs_in_process(tmp_path: Path):
    seen: list[tuple[str, dict, str]] = []

    def runner(request):
        seen.append((request.name, request.run_config, request.fixture_mode))
        write_run(Path(request.out_dir), request.name, ITEMS)
        return frameworks.load_run(Path(request.out_dir), request.name)

    out = tmp_path / "out"
    code = frameworks.main(["--fixtures", "--out", str(out), "--work", str(tmp_path / "work")], runner=runner)
    assert code == frameworks.EXIT_OK
    assert [name for name, _, _ in seen] == ["llamaindex", "langchain"]
    assert seen[0][1]["env"] == {"RAG_PIPELINE": "v2", "RAG_QUERY_LAYER": "true"}
    assert seen[1][1]["env"]["RAG_QUERY_FRAMEWORK"] == "langchain"
    assert {mode for _, _, mode in seen} == {"prechunked"}
    assert (out / "report.md").is_file()
