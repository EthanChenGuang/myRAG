import functools
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.retrieval import (
    ChunkingDecision,
    ChunkingProfile,
    ChunkingSweepReport,
)
from test_report_runner import QUOTE, _manifest, _trace

from rag_eval.golden_io import load_golden, write_golden
from rag_eval.harness_runner import dev_only_golden, golden_for_splits, run_harness
from rag_eval.metrics import score_items
from rag_eval.report import build_report, write_report
from rag_eval.split import assign_split
from rag_eval.sweep.chunking import (
    LEGACY_ID,
    ChunkingUsageError,
    decide_chunking_profile,
    parse_presets,
    run_chunking_sweep,
)
from rag_eval.sweep.retrieval import main

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_DOC = "contract-zh.pdf"
INVOICE_DOC = "invoice-en.pdf"
DOC_TYPES = {CONTRACT_DOC: "contract_legal", INVOICE_DOC: "invoice_receipt"}


def _ids(split: str, count: int, prefix: str) -> list[str]:
    found: list[str] = []
    n = 0
    while len(found) < count:
        candidate = f"{prefix}-{n:03d}"
        if assign_split(candidate) == split:
            found.append(candidate)
        n += 1
    return found


def _golden_item(item_id: str, language: str, document: str, *, answerable: bool = True, category: str = "general", tags=None, split="dev"):
    return GoldenItem(
        id=item_id,
        question="question",
        language=language,
        category=category if answerable else "no_answer",
        answerable=answerable,
        expected_answer="answer" if answerable else None,
        gold_evidence=[{"document": document, "section": "s", "quote": QUOTE}] if answerable else [],
        review_status="approved",
        provenance="synthetic_fixture",
        split=split,
        tags=list(tags or []),
    )


def _fixture_golden(tmp_path: Path) -> tuple[Path, Path, dict[str, list[str]]]:
    zh_clause = _ids("dev", 3, "zh-clause")
    en_general = _ids("dev", 3, "en-general")
    zh_invoice = _ids("dev", 2, "zh-invoice")
    en_no_answer = _ids("dev", 2, "en-noans")
    test_ids = _ids("test", 2, "zh-clause")
    main_items = [_golden_item(i, "en", INVOICE_DOC) for i in en_general]
    main_items += [_golden_item(i, "zh", INVOICE_DOC, category="exact_term") for i in zh_invoice]
    main_items += [_golden_item(i, "en", INVOICE_DOC, answerable=False) for i in en_no_answer]
    main_items += [_golden_item(i, "zh", CONTRACT_DOC, tags=["clause"], split="test") for i in test_ids]
    ingest_items = [_golden_item(i, "zh", CONTRACT_DOC, tags=["clause"]) for i in zh_clause]
    first = tmp_path / "golden.jsonl"
    second = tmp_path / "golden-ingest.jsonl"
    write_golden(first, main_items)
    write_golden(second, ingest_items)
    ids = {"zh_clause": zh_clause, "en_general": en_general, "zh_invoice": zh_invoice, "en_no_answer": en_no_answer, "test": test_ids}
    return first, second, ids


def _flag(argv: list[str], name: str) -> str:
    return argv[argv.index(name) + 1]


class _Spawner:
    """Stands in for run-smoke: writes one trace per golden item it is handed; `misses` decides per run which items lose their hit."""

    def __init__(self, misses=None, refusals=None, latency=10.0) -> None:
        self.misses = misses or (lambda config, item: False)
        self.refusals = refusals or (lambda config, item: not item.answerable)
        self.latency = latency
        self.configs: list[dict] = []
        self.golden_ids: list[list[str]] = []

    def __call__(self, argv: list[str], cwd: Path):
        config = json.loads(Path(_flag(argv, "--run-config")).read_text(encoding="utf-8"))
        golden_path = Path(_flag(argv, "--golden"))
        golden = load_golden(golden_path)
        self.configs.append(config)
        self.golden_ids.append([item.id for item in golden])
        out = Path(_flag(argv, "--out"))
        out.mkdir(parents=True, exist_ok=True)
        traces = []
        for item in golden:
            document = item.gold_evidence[0].document if item.gold_evidence else INVOICE_DOC
            content = "unrelated words" if self.misses(config, item) else f"intro {QUOTE} outro"
            trace = _trace(item.id, [(document, content)], refused=self.refusals(config, item))
            trace = trace.model_copy(update={"context_tokens": 100, "stage_latency_ms": {"search": self.latency, "generation": 999.0}})
            traces.append(trace)
        report = build_report(_manifest(), score_items(traces, golden), golden, traces)
        write_report(report, out)
        (out / "traces.jsonl").write_text("".join(t.model_dump_json() + "\n" for t in traces), encoding="utf-8")
        (out / "run.json").write_text(_manifest().model_dump_json(), encoding="utf-8")
        return SimpleNamespace(returncode=0, stdout="", stderr="")


def _base_config(tmp_path: Path) -> Path:
    path = tmp_path / "v2-recommended.json"
    path.write_text(
        json.dumps({"name": "v2-recommended", "env": {"RAG_PIPELINE": "v2", "RAG_LEXICAL_SEARCH": "true"}, "overrides": {"rerank_model": "fake-quality-v1"}}),
        encoding="utf-8",
    )
    return path


def _sweep(tmp_path: Path, spawner: _Spawner, *, presets="128/512,256/1024", judge=None, golden=None):
    first, second, ids = _fixture_golden(tmp_path)
    runner = functools.partial(run_harness, spawner=spawner, repo_root=tmp_path)
    report = run_chunking_sweep(
        _base_config(tmp_path),
        parse_presets(presets),
        tmp_path / "out",
        runner=runner,
        judge=judge,
        golden=golden or [first, second],
        doc_types=DOC_TYPES,
    )
    return report, ids


def _entry(report: ChunkingSweepReport, profile_id: str):
    return next(entry for entry in report.profiles if entry.profile_id == profile_id)


def test_dev_only_golden_accepts_a_list_and_keeps_only_dev_items(tmp_path: Path):
    first, second, ids = _fixture_golden(tmp_path)
    merged = dev_only_golden([first, second], tmp_path / "dev.jsonl")
    kept = [item.id for item in load_golden(merged)]
    assert set(ids["zh_clause"]) <= set(kept)
    assert set(ids["en_general"]) <= set(kept)
    assert not set(ids["test"]) & set(kept)
    single = golden_for_splits(first, tmp_path / "one.jsonl")
    assert not set(ids["zh_clause"]) & {item.id for item in load_golden(single)}


def test_presets_parse_and_reject_bad_values():
    presets = parse_presets("128/512,256/1024,256/2048")
    assert [(p.child_tokens, p.parent_tokens, p.preset, p.slug) for p in presets] == [
        (128, 512, "128/512", "p128-512"),
        (256, 1024, "256/1024", "p256-1024"),
        (256, 2048, "256/2048", "p256-2048"),
    ]
    assert parse_presets("200/900")[0].preset == "custom"
    for bad in ("", "256", "256/400", "a/b", "256/1024,256/1024"):
        with pytest.raises(ChunkingUsageError):
            parse_presets(bad)


def test_sweep_builds_one_run_per_preset_plus_legacy_with_the_same_base_env(tmp_path: Path):
    spawner = _Spawner()
    report, _ = _sweep(tmp_path, spawner)
    assert len(spawner.configs) == 3
    legacy, *candidates = spawner.configs
    assert "chunking_profiles" not in legacy
    assert "chunking_profile_by_doc_type" not in (legacy.get("overrides") or {})
    for config in spawner.configs:
        assert config["env"] == {"RAG_PIPELINE": "v2", "RAG_LEXICAL_SEARCH": "true", "RAG_PARENT_CHILD": "true"}
        assert config["overrides"]["rerank_model"] == "fake-quality-v1"
    first = candidates[0]
    profiles = [ChunkingProfile.model_validate(entry) for entry in first["chunking_profiles"]]
    assert {p.doc_type for p in profiles} == {"contract_legal", "invoice_receipt", "general"}
    assert all(p.id == f"p128-512-{p.doc_type}" and p.status == "building" and p.parent_mode == "structure" for p in profiles)
    assert first["overrides"]["chunking_profile_by_doc_type"] == {p.doc_type: p.id for p in profiles}
    assert [entry.profile_id for entry in report.profiles] == [LEGACY_ID, "p128-512", "p256-1024"]
    assert report.provenance.source == "fixture"
    assert report.config_hash is not None
    assert ChunkingSweepReport.model_validate_json((tmp_path / "out" / "chunking-sweep.json").read_text(encoding="utf-8")) == report
    assert (tmp_path / "out" / "chunking-sweep.md").is_file()


def test_report_carries_every_chk05_slice(tmp_path: Path):
    report, _ = _sweep(tmp_path, _Spawner())
    metrics = _entry(report, "p128-512").metrics
    assert set(metrics.by_doc_type) == {"contract_legal", "invoice_receipt", "general"}
    assert set(metrics.by_language) == {"en", "zh"}
    assert {"context_heavy", "fact_lookup", "clause"} <= set(metrics.by_question_kind)
    assert metrics.by_question_kind["clause"].recall_at_k.n == 3
    assert metrics.by_question_kind["context_heavy"].recall_at_k.n == 3
    overall = metrics.overall
    assert overall.recall_at_k.value == 1.0
    assert overall.mrr.value == 1.0
    assert overall.correct_refusal_rate.value == 1.0 and overall.correct_refusal_rate.n == 2
    assert overall.correct_refusal_rate.upper_95 == 1.0
    assert overall.false_refusal_rate.value == 0.0 and overall.false_refusal_rate.upper_95 is not None
    assert 0 < overall.false_refusal_rate.upper_95 < 1
    assert overall.context_tokens.value == 100.0
    assert overall.latency_p50_ms.value == 10.0 and overall.latency_p95_ms.value == 10.0


def test_candidate_dropping_zh_mrr_beyond_the_band_fails_and_names_the_slice(tmp_path: Path):
    def misses(config, item):
        return "chunking_profiles" in config and config["chunking_profiles"][0]["id"].startswith("p128-512") and item.language == "zh"

    report, _ = _sweep(tmp_path, _Spawner(misses=misses))
    failed = _entry(report, "p128-512").gate
    passed = _entry(report, "p256-1024").gate
    assert failed is not None and failed.passed is False and failed.baseline_profile_id == LEGACY_ID
    slices = {(r.slice, r.metric) for r in failed.regressions}
    assert ("language:zh", "mrr") in slices
    assert ("overall", "mrr") in slices
    assert all(not r.slice.startswith("category:") and not r.slice.startswith("pair:") for r in failed.regressions)
    assert all(r.band == pytest.approx(0.02) for r in failed.regressions)
    assert passed is not None and passed.passed is True and passed.regressions == []
    assert _entry(report, LEGACY_ID).gate is None


def test_judge_absence_is_a_notice_and_a_stub_judge_fills_correctness(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    report, _ = _sweep(tmp_path / "a", _Spawner())
    for entry in report.profiles:
        assert entry.metrics.overall.judge_skipped is True
        assert entry.metrics.overall.judge_correctness.value is None
    assert any("judge" in note and "skipped" in note for note in report.notes)

    def judge(run, items):
        return {item.id: 0.5 for item in items if item.answerable}, None

    judged, _ = _sweep(tmp_path / "b", _Spawner(), judge=judge)
    overall = _entry(judged, "p128-512").metrics.overall
    assert overall.judge_skipped is False
    assert overall.judge_correctness.value == 0.5
    assert overall.judge_correctness.n == 8


def test_a_poisoned_test_item_never_reaches_the_runner_or_the_report(tmp_path: Path):
    spawner = _Spawner()
    report, ids = _sweep(tmp_path / "a", spawner)
    for seen in spawner.golden_ids:
        assert not set(ids["test"]) & set(seen)

    first, second, _ = _fixture_golden(tmp_path / "b")
    poisoned = [item.model_copy(update={"question": "poison", "expected_answer": "poison"}) if item.split == "test" else item for item in load_golden(first)]
    write_golden(first, poisoned)
    again, _ = _sweep(tmp_path / "b", _Spawner(), golden=[first, second])
    strip = lambda r: [(e.profile_id, e.metrics.model_dump(exclude={"overall": {"latency_p50_ms", "latency_p95_ms"}})) for e in r.profiles]
    assert strip(again) == strip(report)


def test_decide_writes_a_valid_decision_and_index_and_is_byte_identical_on_rerun(tmp_path: Path):
    _sweep(tmp_path, _Spawner())
    report_path = tmp_path / "out" / "chunking-sweep.json"
    out_dir = tmp_path / "decisions"
    decision = decide_chunking_profile(report_path, "contract_legal", "p256-1024", "fixture-demo", out_dir, recorded_at="2026-11-25")
    path = out_dir / "contract_legal.json"
    assert ChunkingDecision.model_validate_json(path.read_text(encoding="utf-8")) == decision
    assert decision.profile_id == "p256-1024-contract_legal"
    assert decision.gate_passed is True and decision.regressions == []
    assert decision.source == "fixture"
    assert decision.chosen_on["recall_at_k"] == 1.0
    assert "clause_recall_at_k" in decision.chosen_on
    index = json.loads((out_dir / "index.json").read_text(encoding="utf-8"))
    assert [ChunkingDecision.model_validate(entry) for entry in index] == [decision]

    first = path.read_bytes()
    first_index = (out_dir / "index.json").read_bytes()
    decide_chunking_profile(report_path, "contract_legal", "p256-1024", "fixture-demo", out_dir)
    assert path.read_bytes() == first
    assert (out_dir / "index.json").read_bytes() == first_index

    decide_chunking_profile(report_path, "invoice_receipt", LEGACY_ID, "fixture-demo", out_dir, recorded_at="2026-11-25")
    index = json.loads((out_dir / "index.json").read_text(encoding="utf-8"))
    assert [entry["doc_type"] for entry in index] == ["contract_legal", "invoice_receipt"]
    assert index[1]["profile_id"] == LEGACY_ID and index[1]["gate_passed"] is True


def test_decide_refuses_a_failed_gate_candidate_with_exit_2(tmp_path: Path, capsys):
    def misses(config, item):
        return "chunking_profiles" in config and item.language == "zh"

    _sweep(tmp_path, _Spawner(misses=misses))
    report_path = tmp_path / "out" / "chunking-sweep.json"
    out_dir = tmp_path / "decisions"
    with pytest.raises(ChunkingUsageError):
        decide_chunking_profile(report_path, "contract_legal", "p128-512", "fixture-demo", out_dir)
    assert not (out_dir / "contract_legal.json").exists()
    code = main(["chunking-decide", "--report", str(report_path), "--doc-type", "contract_legal", "--profile", "p128-512", "--decided-by", "fixture-demo", "--out-dir", str(out_dir)])
    assert code == 2
    assert "gate" in capsys.readouterr().err
    code = main(["chunking-decide", "--report", str(report_path), "--doc-type", "contract_legal", "--profile", LEGACY_ID, "--decided-by", "fixture-demo", "--out-dir", str(out_dir)])
    assert code == 0
    assert ChunkingDecision.model_validate_json((out_dir / "contract_legal.json").read_text(encoding="utf-8")).profile_id == LEGACY_ID


def test_decide_rejects_unknown_profile_and_doc_type(tmp_path: Path):
    _sweep(tmp_path, _Spawner())
    report_path = tmp_path / "out" / "chunking-sweep.json"
    with pytest.raises(ChunkingUsageError):
        decide_chunking_profile(report_path, "contract_legal", "p999-9999", "x", tmp_path / "d")
    with pytest.raises(ChunkingUsageError):
        decide_chunking_profile(report_path, "financial_report", "p256-1024", "x", tmp_path / "d")


def test_cli_registers_chunking_next_to_retrieval(tmp_path: Path, capsys):
    with pytest.raises(SystemExit):
        main(["chunking", "--help"])
    assert "--presets" in capsys.readouterr().out
    code = main(["chunking", "--run-config", str(_base_config(tmp_path)), "--presets", "256/400", "--out", str(tmp_path / "o")])
    assert code == 2
