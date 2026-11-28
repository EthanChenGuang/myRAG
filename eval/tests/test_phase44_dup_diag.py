"""quick-44 (Phase 4.4 G1): the report-only duplicate diagnostic's pure parts. Neutral synthetic data only."""

from rag_eval import phase44_dup_diag as diag


def _arm(dup_tie: int, cut10: int) -> dict:
    return {
        "items_with_tie": dup_tie,
        "items_with_duplicate_tie": dup_tie,
        "items_with_tie_at_cut_5": 0,
        "items_with_tie_at_cut_10": cut10,
        "mean_tied_hits": 0.0,
        "mean_duplicate_pairs": 0.0,
        "mean_distinct_documents": 10.0,
        "mean_duplicate_gap": None,
    }


def _ties(bm25: tuple[int, int], ts: tuple[int, int]) -> dict:
    return {"items": 6, "bm25": _arm(*bm25), "ts_rank_cd": _arm(*ts)}


def test_no_baseline_drop_is_no_drop():
    assert diag.verdict({"baseline": [], "dup_clusters": [], "collapse": []}, None)["cause"] == "no_drop"


def test_dedup_fixes_and_bm25_ties_more():
    v = diag.verdict({"baseline": ["x"], "dup_clusters": [], "collapse": []}, _ties((3, 2), (0, 0)))
    assert v["cause"] == "score_ties_among_duplicates"
    assert v["fixed_by"] == ["dup_clusters", "collapse"]


def test_dedup_fixes_without_excess_ties():
    v = diag.verdict({"baseline": ["x"], "dup_clusters": ["x"], "collapse": []}, _ties((1, 0), (1, 0)))
    assert v["cause"] == "missing_deduplication"
    assert v["fixed_by"] == ["collapse"]


def test_drop_survives_dedup():
    assert diag.verdict({"baseline": ["x"], "dup_clusters": ["x"], "collapse": ["x"]}, _ties((0, 0), (0, 0)))["cause"] == "bm25_ranking"
    assert diag.verdict({"baseline": ["x"], "dup_clusters": ["x"], "collapse": ["x"]}, _ties((2, 0), (0, 0)))["cause"] == "bm25_ranking_with_ties"


def test_tie_summary_counts_only_the_category():
    row = {"hits": 10, "distinct_documents": 4, "tie_groups": 1, "tied_hits": 2, "duplicate_tie_groups": 1, "duplicate_pairs": 3, "tie_at_cut_5": True, "tie_at_cut_10": False, "mean_duplicate_gap": 0.0}
    other = {**row, "tie_groups": 0, "duplicate_tie_groups": 0, "tie_at_cut_5": False}
    report = {
        "items": [
            {"item_id": "a", "category": "duplicate_flood", "arms": {"bm25": row, "ts_rank_cd": other}},
            {"item_id": "b", "category": "general", "arms": {"bm25": row, "ts_rank_cd": row}},
        ]
    }
    summary = diag.tie_summary(report, "duplicate_flood")
    assert summary["items"] == 1
    assert summary["bm25"]["items_with_duplicate_tie"] == 1
    assert summary["ts_rank_cd"]["items_with_duplicate_tie"] == 0
    assert summary["bm25"]["items_with_tie_at_cut_5"] == 1
    assert diag.tie_summary(None, "duplicate_flood") is None


def test_run_names_and_configs_follow_the_gate_pair():
    assert diag.run_name("dup_clusters", "bm25", "ingest") == "diag-dup-clusters-bm25-ingest"
    ref = diag.run_config("collapse", "ts_rank_cd")["env"]
    on = diag.run_config("collapse", "bm25")["env"]
    assert ref["RAG_LEXICAL_SCORING"] == "ts_rank_cd" and on["RAG_LEXICAL_SCORING"] == "bm25"
    for env in (ref, on):
        assert env["RAG_DUP_CLUSTERS"] == "true" and env["RAG_RESULT_DIVERSITY"] == "collapse"
    assert "RAG_DUP_CLUSTERS" not in diag.run_config("baseline", "bm25")["env"]
