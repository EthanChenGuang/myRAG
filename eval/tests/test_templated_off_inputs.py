"""Shared inputs of the templated-collection off-identity case: a report with no templated item (plan 03.3-22)."""

from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.report import EvalReport

from rag_eval.metrics import score_items
from rag_eval.report import build_report
from test_report_runner import QUOTE, _four_items, _manifest, _trace


def _with_candidates(trace: RagTrace, rows: list[tuple[str, str, dict[str, int]]]) -> RagTrace:
    candidates = [
        {
            "rank": index,
            "chunk_id": f"k{index}",
            "document_id": f"d-{doc}",
            "document_name": doc,
            "content": content,
            "similarity": 0.5,
            "has_image": False,
            "legs": legs,
        }
        for index, (doc, content, legs) in enumerate(rows, start=1)
    ]
    return RagTrace.model_validate({**trace.model_dump(mode="json"), "candidates": candidates})


def off_inputs():
    golden, traces = _four_items()
    traces = [
        _with_candidates(trace, [("doc.zh.md", f"intro {QUOTE}", {"dense": 1, "lexical": 2})]) if index == 0 else trace
        for index, trace in enumerate(traces)
    ]
    traces.append(_trace(None, [("doc.en.md", "unlinked")]))
    return golden, traces


def off_report() -> EvalReport:
    golden, traces = off_inputs()
    linked = [trace for trace in traces if trace.item_id is not None]
    return build_report(_manifest(), score_items(linked, golden), golden, linked)
