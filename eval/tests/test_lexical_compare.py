"""rag_eval.lexical_compare (D-37) on synthetic recorded arms. The committed arms under eval/tests/data/lexical_compare/ come from
write_fixture_arms below (`uv run --directory eval python tests/test_lexical_compare.py` rewrites them); a test checks that they
still match. Neutral text only (D-41)."""

import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_report_runner import _manifest, _trace

from rag_eval.golden_io import write_golden
from rag_eval.harness_runner import HarnessRun, golden_for_splits
from rag_eval.lexical_compare import (
    JSON_NAME,
    LEGS_DIR,
    LEGS_FILE,
    LEGS_MANIFEST,
    MARKDOWN_NAME,
    RRF_DIR,
    CompareError,
    RankedChunk,
    arm_grid,
    assert_private_out,
    compare_from_reports,
    doc_at_1,
    item_scores,
    main,
    run_rrf_arm,
    write_report,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA = REPO_ROOT / "eval" / "tests" / "data" / "lexical_compare"
QUOTES = {
    "en": "the plain sample line states a first neutral fact",
    "it": "la riga di prova indica un fatto neutro",
    "zh": "示例句子说明一个中性事实",
}
FILLER = "unrelated filler words for a synthetic chunk"
SCORING_ENV = {
    "ts_rank_cd": {"RAG_LEXICAL_SCORING": "ts_rank_cd", "RAG_RERANKER": "none"},
    "bm25": {"RAG_LEXICAL_SCORING": "bm25", "RAG_LEXICAL_BM25_K1": "1.2", "RAG_LEXICAL_BM25_B": "0.75", "RAG_RERANKER": "none"},
}


def _g(item_id: str, language: str, *, answerable: bool = True) -> GoldenItem:
    return GoldenItem(
        id=item_id,
        question=f"synthetic question {item_id}",
        language=language,
        category="general" if answerable else "no_answer",
        answerable=answerable,
        expected_answer="answer" if answerable else None,
        gold_evidence=[{"document": f"doc.{language}.md", "section": "s", "quote": QUOTES[language]}] if answerable else [],
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
    )


GOLDEN = [
    _g("en-general-001", "en"),
    _g("en-general-002", "en"),
    _g("en-general-004", "en"),
    _g("it-general-001", "it"),
    _g("it-general-003", "it"),
    _g("zh-general-001", "zh"),
    _g("en-general-005", "en", answerable=False),
]
ANSWERABLE = [item for item in GOLDEN if item.answerable]

# Rank of the gold chunk per arm and item (None: not in the list); other places hold filler chunks.
GOLD_RANK = {
    "ts_rank_cd": {"en-general-001": 3, "en-general-002": None, "en-general-004": 1, "it-general-001": 12, "it-general-003": 2, "zh-general-001": 1},
    "bm25": {"en-general-001": 1, "en-general-002": 30, "en-general-004": 1, "it-general-001": 2, "it-general-003": 2, "zh-general-001": 1},
}


def _ranked(item: GoldenItem, scoring: str) -> list[dict]:
    rank = GOLD_RANK[scoring].get(item.id) if item.answerable else None
    rows = []
    for position in range(1, 41):
        gold = position == rank
        rows.append(
            {
                "chunk_id": f"{item.id}-{scoring}-c{position}",
                "document_id": f"d-{'doc' if gold else 'other'}.{item.language}",
                "document_name": f"doc.{item.language}.md" if gold else "other.md",
                "content": f"intro {QUOTES[item.language]} outro" if gold else FILLER,
            }
        )
    return rows


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_fixture_arms(root: Path) -> None:
    """golden.jsonl, a lexical-leg run with both arms and the two RRF arm runs (run.json and traces.jsonl)."""
    root.mkdir(parents=True, exist_ok=True)
    golden_path = root / "golden.jsonl"
    write_golden(golden_path, GOLDEN)
    with tempfile.TemporaryDirectory() as tmp:
        dev_hash = _sha(golden_for_splits(golden_path, Path(tmp) / "dev.jsonl"))
    legs = root / LEGS_DIR
    legs.mkdir(parents=True, exist_ok=True)
    lines = [
        json.dumps({"item_id": item.id, "language": item.language, "token_count": 4, "arms": {s: _ranked(item, s)[:50] for s in ("ts_rank_cd", "bm25")}}, sort_keys=True)
        for item in GOLDEN
    ]
    (legs / LEGS_FILE).write_text("\n".join(lines) + "\n", encoding="utf-8")
    manifest = {
        "schema_version": 1,
        "created_at": "2026-01-01T00:00:00.000Z",
        "eval_set_sha256": _sha(golden_path),
        "tenant_hash": "0" * 12,
        "profile_id": "openai-3-small-1536",
        "limit": 50,
        "arms": [{"label": "ts_rank_cd", "scoring": "ts_rank_cd"}, {"label": "bm25", "scoring": "bm25", "k1": 1.2, "b": 0.75}],
        "lexical_options": {"stem_it": False, "dictionary_version": None, "identifier_patterns": 0, "quantity": False},
        "item_count": len(GOLDEN),
        "empty_token_items": 0,
    }
    (legs / LEGS_MANIFEST).write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    for scoring in ("ts_rank_cd", "bm25"):
        directory = root / RRF_DIR / f"rrf_{scoring}"
        directory.mkdir(parents=True, exist_ok=True)
        run = _manifest(dev_hash).model_copy(update={"run_config_hash": scoring[0] * 64})
        (directory / "run.json").write_text(json.dumps(run.model_dump(mode="json"), sort_keys=True, indent=2) + "\n", encoding="utf-8")
        traces = []
        for item in GOLDEN:
            raw = _trace(item.id, []).model_dump(mode="json")
            raw["effective_config"]["rag_env"] = dict(SCORING_ENV[scoring])
            raw["candidates"] = [{**row, "rank": index, "similarity": 0.5, "has_image": False} for index, row in enumerate(_ranked(item, scoring), start=1)]
            traces.append(RagTrace.model_validate(raw))
        (directory / "traces.jsonl").write_text("".join(json.dumps(t.model_dump(mode="json"), sort_keys=True) + "\n" for t in traces), encoding="utf-8")


def _compare(root: Path = DATA, **kwargs):
    return compare_from_reports(golden_path=root / "golden.jsonl", reports=root, lexical_leg_dir=None, arms=arm_grid(), **kwargs)


def _copy(tmp_path: Path) -> Path:
    root = tmp_path / "arms"
    shutil.copytree(DATA, root)
    return root


# ---------- metric helpers


def test_doc_at_1_is_one_only_when_the_top_chunk_belongs_to_a_gold_document():
    item = _g("en-general-001", "en")
    gold = RankedChunk(chunk_id="a", document_id="d1", document_name="DOC.en.md", content=FILLER)
    other = RankedChunk(chunk_id="b", document_id="d2", document_name="other.md", content=QUOTES["en"])
    assert doc_at_1([gold, other], item) == 1.0
    assert doc_at_1([other, gold], item) == 0.0
    assert doc_at_1([], item) == 0.0
    by_id = item.model_copy(update={"gold_evidence": [item.gold_evidence[0].model_copy(update={"document_id": "00000000-0000-4000-8000-000000000001"})]})
    renamed = RankedChunk(chunk_id="c", document_id="00000000-0000-4000-8000-000000000001", document_name="renamed.md", content=FILLER)
    assert doc_at_1([renamed], by_id) == 1.0


def test_item_scores_count_spans_within_10_and_50_and_the_first_hit_rank():
    item = _g("it-general-001", "it")
    ranked = [RankedChunk.model_validate(row) for row in _ranked(item, "ts_rank_cd")]
    assert item_scores(ranked, item) == {"recall_at_10": 0.0, "recall_at_50": 1.0, "mrr": 1 / 12, "doc_at_1": 0.0}


# ---------- the comparison


def test_the_four_arms_are_scored_per_arm_overall_and_per_language():
    report = _compare()
    assert [arm.label for arm in report.arms] == ["lexical_ts_rank_cd", "rrf_ts_rank_cd", "lexical_bm25", "rrf_bm25"]
    assert report.item_count == len(ANSWERABLE)
    by = {arm.label: arm for arm in report.arms}
    ts = by["lexical_ts_rank_cd"].overall
    assert ts.n == 6
    assert ts.recall_at_10 == pytest.approx(4 / 6)
    assert ts.recall_at_50 == pytest.approx(5 / 6)
    assert ts.mrr == pytest.approx((1 / 3 + 0 + 1 + 1 / 12 + 1 / 2 + 1) / 6)
    assert ts.doc_at_1 == pytest.approx(2 / 6)
    assert by["lexical_bm25"].overall.doc_at_1 == pytest.approx(3 / 6)
    assert sorted(by["rrf_bm25"].by_language) == ["en", "it", "zh"]
    assert by["rrf_bm25"].by_language["it"].n == 2
    assert by["rrf_bm25"].tokenizer_switches == {}
    assert by["lexical_bm25"].tokenizer_switches["stem_it"] == "false"
    assert by["rrf_ts_rank_cd"].config_hash == "t" * 64


def test_paired_differences_have_seeded_intervals_and_the_same_input_gives_the_same_output():
    first = _compare()
    second = _compare()
    assert first.model_dump() == second.model_dump()
    pair = next(p for p in first.pairs if p.kind == "lexical")
    assert (pair.baseline, pair.candidate) == ("lexical_ts_rank_cd", "lexical_bm25")
    mrr = pair.overall["mrr"]
    assert mrr.n == 6 and mrr.mean_d == pytest.approx(((1 - 1 / 3) + 1 / 30 + 0 + (1 / 2 - 1 / 12) + 0 + 0) / 6)
    assert mrr.ci_low is not None and mrr.ci_low <= mrr.mean_d <= mrr.ci_high
    assert pair.by_language["zh"]["mrr"].mean_d == 0.0 and pair.by_language["zh"]["mrr"].ci_low == 0.0
    other_seed = _compare(seed=7)
    assert other_seed.pairs[0].overall["mrr"].mean_d == mrr.mean_d
    assert {p.kind for p in first.pairs} == {"lexical", "rrf"}


def test_an_item_missing_from_one_arm_is_an_error_naming_the_item(tmp_path):
    root = _copy(tmp_path)
    traces = root / RRF_DIR / "rrf_bm25" / "traces.jsonl"
    kept = [line for line in traces.read_text(encoding="utf-8").splitlines() if '"item_id": "it-general-003"' not in line]
    traces.write_text("\n".join(kept) + "\n", encoding="utf-8")
    with pytest.raises(CompareError, match="arm rrf_bm25 has no result for item it-general-003"):
        _compare(root)


def test_arms_on_a_different_eval_set_or_golden_manifest_are_refused(tmp_path):
    root = _copy(tmp_path)
    manifest = json.loads((root / LEGS_DIR / LEGS_MANIFEST).read_text(encoding="utf-8"))
    manifest["eval_set_sha256"] = "f" * 64
    (root / LEGS_DIR / LEGS_MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(CompareError, match="eval-set hash differs"):
        _compare(root)
    root = _copy(tmp_path / "second")
    run = json.loads((root / RRF_DIR / "rrf_ts_rank_cd" / "run.json").read_text(encoding="utf-8"))
    run["golden_sha256"] = "f" * 64
    (root / RRF_DIR / "rrf_ts_rank_cd" / "run.json").write_text(json.dumps(run), encoding="utf-8")
    with pytest.raises(CompareError, match="golden set hash differs"):
        _compare(root)


def test_an_rrf_arm_that_ran_with_other_settings_is_refused(tmp_path):
    root = _copy(tmp_path)
    traces = root / RRF_DIR / "rrf_bm25" / "traces.jsonl"
    traces.write_text(traces.read_text(encoding="utf-8").replace('"RAG_RERANKER": "none"', '"RAG_RERANKER": "auto"'), encoding="utf-8")
    with pytest.raises(CompareError, match="RAG_RERANKER=auto, the arm needs none"):
        _compare(root)


def test_k1_and_b_lists_give_one_labelled_bm25_pair_per_combination_capped_at_9():
    arms = arm_grid([0.9, 1.2], [0.5])
    assert [a.label for a in arms] == [
        "lexical_ts_rank_cd",
        "rrf_ts_rank_cd",
        "lexical_bm25_k1=0.9_b=0.5",
        "rrf_bm25_k1=0.9_b=0.5",
        "lexical_bm25_k1=1.2_b=0.5",
        "rrf_bm25_k1=1.2_b=0.5",
    ]
    assert [a.leg_label for a in arms if a.kind == "lexical"] == ["ts_rank_cd", "bm25:k1=0.9,b=0.5", "bm25:k1=1.2,b=0.5"]
    assert len(arm_grid([0.6, 0.9, 1.2], [0.25, 0.5, 0.75])) == 2 + 2 * 9
    with pytest.raises(CompareError, match="capped at 9"):
        arm_grid([0.6, 0.9, 1.2, 1.5], [0.25, 0.5, 0.75])


def test_the_report_holds_no_question_answer_chunk_or_token_text(tmp_path):
    report = _compare()
    write_report(report, tmp_path)
    text = (tmp_path / JSON_NAME).read_text(encoding="utf-8") + (tmp_path / MARKDOWN_NAME).read_text(encoding="utf-8")
    for item in GOLDEN:
        assert item.question not in text
    for quote in [*QUOTES.values(), FILLER]:
        assert quote not in text
    assert "chunk_id" not in text and "content" not in text


def test_the_output_must_be_git_ignored_unless_allowed(tmp_path):
    with pytest.raises(CompareError, match="not git-ignored"):
        assert_private_out(REPO_ROOT / "eval" / "reports" / "phase-04.4", allow_committed=False)
    assert_private_out(REPO_ROOT / "eval" / "reports" / "phase-04.4" / "private", allow_committed=False)
    assert_private_out(REPO_ROOT / "eval" / "out" / "lexical-compare", allow_committed=False)
    assert_private_out(REPO_ROOT / "eval" / "reports" / "phase-04.4", allow_committed=True)
    code = main(["--golden", str(DATA / "golden.jsonl"), "--out", "eval/config/lexical-compare", "--from-reports", str(DATA)])
    assert code == 2


def test_main_computes_from_reports_into_a_private_directory(tmp_path, capsys):
    out = REPO_ROOT / "eval" / "out" / "test-lexical-compare" / tmp_path.name
    try:
        assert main(["--golden", str(DATA / "golden.jsonl"), "--out", str(out), "--from-reports", str(DATA)]) == 0
        payload = json.loads((out / JSON_NAME).read_text(encoding="utf-8"))
        assert payload["item_count"] == 6 and len(payload["pairs"]) == 2
        assert "6 item(s), 4 arm(s)" in capsys.readouterr().out
    finally:
        shutil.rmtree(out, ignore_errors=True)


def test_run_rrf_arm_runs_through_the_runner_and_checks_the_deployment_settings(tmp_path):
    from rag_eval.traces import load_traces

    calls: list[dict] = []
    traces = load_traces(DATA / RRF_DIR / "rrf_bm25" / "traces.jsonl")

    def runner(**kwargs):
        calls.append(kwargs)
        return HarnessRun(out_dir=kwargs["out"], golden_path=kwargs["golden"], run_config_path=kwargs["run_config"], argv=[], traces=traces)

    arm = next(a for a in arm_grid() if a.label == "rrf_bm25")
    target = run_rrf_arm(arm, golden=DATA / "golden.jsonl", out=tmp_path, base_url="https://eval.example.invalid", runner=runner)
    assert target == tmp_path / RRF_DIR / "rrf_bm25"
    assert calls[0]["base_url"] == "https://eval.example.invalid"
    assert calls[0]["env_overlay"] == SCORING_ENV["bm25"]
    ts_arm = next(a for a in arm_grid() if a.label == "rrf_ts_rank_cd")
    with pytest.raises(CompareError, match="RAG_LEXICAL_SCORING=bm25, the arm needs ts_rank_cd"):
        run_rrf_arm(ts_arm, golden=DATA / "golden.jsonl", out=tmp_path, base_url="https://eval.example.invalid", runner=runner)
    lexical_arm = next(a for a in arm_grid() if a.kind == "lexical")
    with pytest.raises(CompareError, match="lexical-alone arm"):
        run_rrf_arm(lexical_arm, golden=DATA / "golden.jsonl", out=tmp_path, base_url="https://eval.example.invalid", runner=runner)


# ---------- cluster DF mode (plan 04.4-18)

#: sha256 of lexical-compare.json and .md for the committed arms, computed with the module as it was before plan 04.4-18.
DEFAULT_REPORT_SHA256 = {
    JSON_NAME: "f832da96f359982472106c97a15ca9eff363a474edf55b700bab2b6b45c75e68",
    MARKDOWN_NAME: "19e5f416b6c16fb7b384224814a60c5fd42adcebcc14ae9300a8f1619d374d68",
}
CLUSTER_GOLD_RANK = {"en-general-001": 1, "en-general-002": 4, "en-general-004": 1, "it-general-001": 1, "it-general-003": 2, "zh-general-001": 1}


def _cluster_layout(tmp_path: Path) -> Path:
    """The committed arms rearranged as lexical-leg-run.mts --df-mode raw,cluster writes them, plus the two cluster arms."""
    root = _copy(tmp_path)
    legs = root / LEGS_DIR
    raw_dir, cluster_dir = legs / "raw", legs / "cluster"
    raw_dir.mkdir()
    for name in (LEGS_FILE, LEGS_MANIFEST):
        shutil.move(str(legs / name), str(raw_dir / name))
    manifest = json.loads((raw_dir / LEGS_MANIFEST).read_text(encoding="utf-8"))
    (raw_dir / LEGS_MANIFEST).write_text(json.dumps({**manifest, "df_mode": "raw"}), encoding="utf-8")
    cluster_dir.mkdir()
    (cluster_dir / LEGS_MANIFEST).write_text(json.dumps({**manifest, "df_mode": "cluster"}), encoding="utf-8")
    GOLD_RANK["bm25_cluster"] = CLUSTER_GOLD_RANK
    try:
        rows = [
            json.dumps({"item_id": item.id, "language": item.language, "token_count": 4, "arms": {"ts_rank_cd": _ranked(item, "ts_rank_cd"), "bm25": _ranked(item, "bm25_cluster")}})
            for item in GOLDEN
        ]
        (cluster_dir / LEGS_FILE).write_text("\n".join(rows) + "\n", encoding="utf-8")
        rrf = root / RRF_DIR / "rrf_bm25_cluster"
        shutil.copytree(root / RRF_DIR / "rrf_bm25", rrf)
        env = {**SCORING_ENV["bm25"], "RAG_LEXICAL_DF_MODE": "cluster", "RAG_DUP_CLUSTERS": "true"}
        traces = []
        for line in (rrf / "traces.jsonl").read_text(encoding="utf-8").splitlines():
            raw = json.loads(line)
            item = next(i for i in GOLDEN if i.id == raw["item_id"])
            raw["effective_config"]["rag_env"] = env
            raw["candidates"] = [{**row, "rank": index, "similarity": 0.5, "has_image": False} for index, row in enumerate(_ranked(item, "bm25_cluster"), start=1)]
            traces.append(json.dumps(raw, sort_keys=True))
        (rrf / "traces.jsonl").write_text("\n".join(traces) + "\n", encoding="utf-8")
    finally:
        del GOLD_RANK["bm25_cluster"]
    return root


def test_the_default_raw_report_is_byte_identical_to_the_report_before_the_df_mode(tmp_path):
    write_report(_compare(), tmp_path)
    for name, digest in DEFAULT_REPORT_SHA256.items():
        assert _sha(tmp_path / name) == digest, name
    assert [a.model_dump() for a in arm_grid()] == [a.model_dump() for a in arm_grid(df_modes=["raw"])]
    assert all(a.df_mode is None for a in arm_grid())


def test_df_mode_cluster_adds_two_arms_paired_against_ts_rank_cd_and_against_raw_bm25(tmp_path):
    arms = arm_grid(df_modes=["raw", "cluster"])
    assert [a.label for a in arms] == ["lexical_ts_rank_cd", "rrf_ts_rank_cd", "lexical_bm25", "rrf_bm25", "lexical_bm25_cluster", "rrf_bm25_cluster"]
    root = _cluster_layout(tmp_path)
    report = compare_from_reports(golden_path=root / "golden.jsonl", reports=root, lexical_leg_dir=None, arms=arms)
    pairs = [(p.baseline, p.candidate) for p in report.pairs]
    assert pairs == [
        ("lexical_ts_rank_cd", "lexical_bm25"),
        ("rrf_ts_rank_cd", "rrf_bm25"),
        ("lexical_ts_rank_cd", "lexical_bm25_cluster"),
        ("rrf_ts_rank_cd", "rrf_bm25_cluster"),
        ("lexical_bm25", "lexical_bm25_cluster"),
        ("rrf_bm25", "rrf_bm25_cluster"),
    ]
    by = {(p.baseline, p.candidate): p for p in report.pairs}
    mrr = by[("lexical_bm25", "lexical_bm25_cluster")].overall["mrr"]
    assert mrr.mean_d == pytest.approx(((1 / 4 - 1 / 30) + (1 - 1 / 2)) / 6)
    assert mrr.ci_low is not None and mrr.ci_low <= mrr.mean_d <= mrr.ci_high
    arm_by = {a.label: a for a in report.arms}
    assert arm_by["lexical_bm25_cluster"].config_hash != arm_by["lexical_bm25"].config_hash
    assert any("Cluster DF arms" in note for note in report.notes)
    raw_only = _compare()
    assert arm_by["rrf_bm25"].overall == {a.label: a for a in raw_only.arms}["rrf_bm25"].overall


def test_df_mode_cluster_is_refused_alone_and_checks_the_arm_settings(tmp_path):
    with pytest.raises(CompareError, match="list raw,cluster"):
        arm_grid(df_modes=["cluster"])
    with pytest.raises(CompareError, match="--df-mode takes"):
        arm_grid(df_modes=["raw", "unit"])
    root = _cluster_layout(tmp_path)
    traces = root / RRF_DIR / "rrf_bm25_cluster" / "traces.jsonl"
    traces.write_text(traces.read_text(encoding="utf-8").replace('"RAG_LEXICAL_DF_MODE": "cluster"', '"RAG_LEXICAL_DF_MODE": "raw"'), encoding="utf-8")
    with pytest.raises(CompareError, match="RAG_LEXICAL_DF_MODE=raw, the arm needs cluster"):
        compare_from_reports(golden_path=root / "golden.jsonl", reports=root, lexical_leg_dir=None, arms=arm_grid(df_modes=["raw", "cluster"]))
    root = _cluster_layout(tmp_path / "second")
    manifest = root / LEGS_DIR / "cluster" / LEGS_MANIFEST
    manifest.write_text(manifest.read_text(encoding="utf-8").replace('"df_mode": "cluster"', '"df_mode": "raw"'), encoding="utf-8")
    with pytest.raises(CompareError, match="is not a df_mode cluster lexical-leg run"):
        compare_from_reports(golden_path=root / "golden.jsonl", reports=root, lexical_leg_dir=None, arms=arm_grid(df_modes=["raw", "cluster"]))


def test_run_rrf_arm_sends_the_cluster_settings_for_a_cluster_arm(tmp_path):
    from rag_eval.traces import load_traces

    root = _cluster_layout(tmp_path)
    calls: list[dict] = []
    traces = load_traces(root / RRF_DIR / "rrf_bm25_cluster" / "traces.jsonl")

    def runner(**kwargs):
        calls.append(kwargs)
        return HarnessRun(out_dir=kwargs["out"], golden_path=kwargs["golden"], run_config_path=kwargs["run_config"], argv=[], traces=traces)

    arm = next(a for a in arm_grid(df_modes=["raw", "cluster"]) if a.label == "rrf_bm25_cluster")
    run_rrf_arm(arm, golden=root / "golden.jsonl", out=tmp_path / "out", base_url="https://eval.example.invalid", runner=runner)
    assert calls[0]["env_overlay"] == {**SCORING_ENV["bm25"], "RAG_LEXICAL_DF_MODE": "cluster", "RAG_DUP_CLUSTERS": "true"}
    code = main(["--golden", str(DATA / "golden.jsonl"), "--out", str(tmp_path / "o"), "--from-reports", str(DATA), "--df-mode", "cluster"])
    assert code == 2


def test_committed_arms_match_the_generator(tmp_path):
    write_fixture_arms(tmp_path)
    committed = sorted(p.relative_to(DATA) for p in DATA.rglob("*") if p.is_file())
    generated = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*") if p.is_file())
    assert committed == generated
    for rel in generated:
        assert (DATA / rel).read_bytes() == (tmp_path / rel).read_bytes(), str(rel)


if __name__ == "__main__":
    shutil.rmtree(DATA, ignore_errors=True)
    write_fixture_arms(DATA)
    print(f"wrote {DATA.relative_to(REPO_ROOT)}")
