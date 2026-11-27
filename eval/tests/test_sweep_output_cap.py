import hashlib
import json
import shutil
from pathlib import Path

import pytest
from rag_sidecar.contracts.answers import CitationRecord
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.output_guard import OutputCaps
from test_report_runner import _manifest, _trace

from rag_eval.golden_io import load_golden, write_golden
from rag_eval.harness_runner import HarnessRun, dev_only_golden
from rag_eval.metrics import score_items
from rag_eval.report import build_report
from rag_eval.split import assign_split
from rag_eval.sweep.output_cap import (
    CAPS_PATH,
    DEFAULT_CANDIDATES,
    TRUNCATION_RATE_LIMIT,
    CandidateResult,
    OutputCapSweepError,
    build_caps,
    load_live_urls,
    run_output_cap_sweep,
    score_candidate,
    select_cap,
)
from rag_eval.sweep.retrieval import main

REPO_ROOT = Path(__file__).resolve().parents[2]
NOISE = NoiseConfig.model_validate_json((REPO_ROOT / "eval" / "config" / "noise.json").read_text(encoding="utf-8"))
BAND = max(NOISE.floor, 0.0)
QUOTE_A = "the blue panel holds item seven"
QUOTE_B = "the red panel holds item twelve"


def _result(mode: str, cap: int | None, *, correct: float = 0.9, recall: float = 0.9, truncation: float = 0.0) -> CandidateResult:
    return CandidateResult(
        mode=mode,  # type: ignore[arg-type]
        cap=cap,
        answer_correctness=correct,
        citation_recall=recall,
        mean_output_tokens=float(cap or 3000) / 2,
        generation_latency_p95_ms=10.0,
        truncation_rate=truncation,
        n_answers=50,
        n_scored=40,
        run_id=f"run-{mode}-{cap or 'off'}",
        run_config_hash=f"hash-{mode}-{cap or 'off'}",
    )


def test_the_candidate_list_starts_with_the_five_d34_values_and_the_limit_is_two_percent():
    assert DEFAULT_CANDIDATES == (512, 768, 1024, 1536, 2048)
    assert TRUNCATION_RATE_LIMIT == 0.02


def test_select_picks_the_smallest_cap_within_the_band_and_under_two_percent_truncation():
    results = [
        _result("strict", None),
        _result("strict", 512, correct=0.9 - BAND - 0.01),
        _result("strict", 768, truncation=0.05),
        _result("strict", 1024, correct=0.9 - BAND / 2, truncation=0.019),
        _result("strict", 1536),
    ]
    selection = select_cap(results, NOISE, "strict")
    assert selection.limit == 1024
    assert selection.qualifying == [1024, 1536]
    assert selection.reasons["512"] == ["answer_correctness_outside_band"]
    assert selection.reasons["768"] == ["truncation_rate_at_or_above_limit"]
    assert selection.run_ids == ["run-strict-off", "run-strict-1024"]
    assert selection.config_hash == "hash-strict-1024"


def test_a_cap_at_exactly_two_percent_truncation_does_not_qualify():
    results = [_result("strict", None), _result("strict", 512, truncation=0.02), _result("strict", 768, truncation=0.0199)]
    assert select_cap(results, NOISE, "strict").limit == 768


def test_a_cap_outside_the_band_on_citation_recall_is_never_chosen():
    results = [_result("balanced", None), _result("balanced", 512, recall=0.9 - BAND - 0.001)]
    selection = select_cap(results, NOISE, "balanced")
    assert selection.limit is None
    assert selection.reasons["512"] == ["citation_recall_outside_band"]


def test_no_qualifying_cap_leaves_the_mode_off_with_its_evidence():
    results = [_result("strict", None), _result("strict", 512, truncation=0.5), _result("balanced", None), _result("balanced", 512)]
    caps = build_caps([select_cap(results, NOISE, "strict"), select_cap(results, NOISE, "balanced")])
    cells = {cell.mode: cell for cell in caps.cells}
    assert cells["strict"].limit is None and cells["strict"].source == "sweep"
    assert cells["strict"].run_ids == ["run-strict-off"] and cells["strict"].config_hash == "hash-strict-off"
    assert cells["balanced"].limit == 512
    OutputCaps.model_validate(caps.model_dump(mode="json"))


def test_the_tool_refuses_to_choose_when_the_uncapped_run_is_missing():
    with pytest.raises(OutputCapSweepError, match="uncapped run is missing"):
        select_cap([_result("strict", 512), _result("strict", 768)], NOISE, "strict")


def test_an_unswept_mode_keeps_its_existing_cell():
    existing = OutputCaps.model_validate_json(CAPS_PATH.read_text(encoding="utf-8"))
    caps = build_caps([select_cap([_result("strict", None), _result("strict", 512)], NOISE, "strict")], existing)
    cells = {cell.mode: cell for cell in caps.cells}
    assert cells["strict"].limit == 512
    assert cells["balanced"] == next(cell for cell in existing.cells if cell.mode == "balanced")


def _ids(split: str, count: int) -> list[str]:
    found: list[str] = []
    n = 0
    while len(found) < count:
        candidate = f"en-general-{n:03d}"
        if assign_split(candidate) == split:
            found.append(candidate)
        n += 1
    return found


def _item(item_id: str, *, answerable: bool = True, split: str = "dev") -> GoldenItem:
    return GoldenItem(
        id=item_id,
        question="Which panel holds the items?",
        language="en",
        category="general" if answerable else "no_answer",
        answerable=answerable,
        expected_answer="item seven and item twelve" if answerable else None,
        gold_evidence=[
            {"document": "panels.en.md", "section": "s", "quote": QUOTE_A},
            {"document": "panels.en.md", "section": "s", "quote": QUOTE_B},
        ]
        if answerable
        else [],
        review_status="approved",
        provenance="synthetic_fixture",
        split=split,
    )


def _citation(document: str) -> dict:
    return {
        "n": 1,
        "alias": "S1",
        "chunkIds": ["c1"],
        "documentId": f"d-{document}",
        "documentName": document,
        "quote": QUOTE_A,
        "quoteHash": hashlib.sha256(QUOTE_A.encode()).hexdigest(),
        "strategy": "chunk-alias",
    }


def _answered(item_id: str, cap: int | None, words_per_answer: int):
    full = f"{QUOTE_A} [S1]. " + " ".join(["filler"] * (words_per_answer - 12)) + f" {QUOTE_B} [S1]."
    words = full.split()
    truncated = cap is not None and len(words) > cap
    answer = " ".join(words[:cap]) if truncated else full
    trace = _trace(item_id, [("panels.en.md", f"{QUOTE_A}. {QUOTE_B}.")])
    return trace.model_copy(
        update={
            "answer": answer,
            "citations": [_citation_record()],
            "finish_reason": "length" if truncated else "stop",
            "stage_latency_ms": {"search": 5.0, "generation": float(len(answer.split()))},
        }
    )


class _CapStub:
    """Stand-in for run_harness: one answer per item that is cut at the run's cap, the way the cap-aware fake answers."""

    def __init__(self, words: dict[str, int]) -> None:
        self.words = words
        self.calls: list[dict] = []

    def __call__(self, *, run_config, golden, out, base_url=None, fixture_mode=None, env_overlay=None, answers=False, rag_mode=None, **_):
        self.calls.append({"env_overlay": env_overlay, "answers": answers, "rag_mode": rag_mode, "base_url": base_url})
        key = (env_overlay or {}).get("RAG_MAX_OUTPUT_TOKENS") or base_url.rsplit("/", 1)[-1]
        cap = None if key == "off" else int(key)
        dev = dev_only_golden(Path(golden), Path(out) / "inputs" / "golden.dev.jsonl")
        items = load_golden(dev)
        traces = [_answered(item.id, cap, self.words[item.id]) for item in items]
        manifest = _manifest().model_copy(update={"run_id": f"run-{rag_mode}-{key}", "run_config_hash": f"rc-{rag_mode}-{key}"})
        report = build_report(manifest, score_items(traces, items), items, traces)
        return HarnessRun(out_dir=Path(out), golden_path=dev, run_config_path=Path(run_config), argv=[], report=report, traces=traces)


def _citation_record() -> CitationRecord:
    return CitationRecord.model_validate(_citation("panels.en.md"))


def _sweep_inputs(tmp_path: Path, words: list[int]) -> tuple[Path, Path, dict[str, int]]:
    dev = _ids("dev", len(words))
    items = [_item(item_id) for item_id in dev] + [_item(item_id, split="test") for item_id in _ids("test", 2)]
    golden = tmp_path / "golden.jsonl"
    write_golden(golden, items)
    config = tmp_path / "run.json"
    config.write_text(json.dumps({"name": "cap-run", "env": {}, "generator_model": "fake/cap-aware-v1"}), encoding="utf-8")
    return config, golden, dict(zip(dev, words))


def test_score_candidate_records_the_five_quantities():
    items = [_item("en-general-a"), _item("en-general-b")]
    traces = [_answered("en-general-a", 600, 1000), _answered("en-general-b", 600, 100)]
    scored = score_candidate(traces, items, mode="strict", cap=600)
    assert scored.answer_correctness == pytest.approx(0.75)
    assert scored.citation_recall == 1.0
    assert scored.truncation_rate == 0.5
    assert scored.mean_output_tokens == pytest.approx((600 + 100) / 2, abs=1)
    assert scored.generation_latency_p95_ms == pytest.approx(600, abs=1)


def test_a_run_without_finish_reason_cannot_be_scored():
    items = [_item("en-general-a")]
    trace = _answered("en-general-a", None, 50).model_copy(update={"finish_reason": None})
    with pytest.raises(OutputCapSweepError, match="finish_reason"):
        score_candidate([trace], items, mode="strict", cap=None)


def test_fixture_sweep_writes_a_valid_caps_file_to_the_given_path_with_run_ids_and_config_hash(tmp_path: Path):
    # One long answer in 60 truncates under 768 (1.7%, qualifies); five long ones under 512 do not.
    words = [700] * 4 + [100] * 55 + [1000]
    config, golden, by_id = _sweep_inputs(tmp_path, words)
    stub = _CapStub(by_id)
    out = tmp_path / "caps.json"
    before = CAPS_PATH.read_bytes()
    result = run_output_cap_sweep(config, out, tmp_path / "report", runner=stub, golden=golden, candidates=(512, 768, 1024))
    assert CAPS_PATH.read_bytes() == before
    assert result.mode == "fixture" and result.caps_written
    assert [call["rag_mode"] for call in stub.calls] == ["strict"] * 4 + ["balanced"] * 4
    assert all(call["answers"] for call in stub.calls)
    assert [call["env_overlay"]["RAG_MAX_OUTPUT_TOKENS"] for call in stub.calls[:4]] == ["off", "512", "768", "1024"]
    caps = OutputCaps.model_validate_json(out.read_text(encoding="utf-8"))
    cells = {cell.mode: cell for cell in caps.cells}
    by_cap = {r.cap: r for r in result.results if r.mode == "strict"}
    assert by_cap[512].truncation_rate >= TRUNCATION_RATE_LIMIT
    assert 0 < by_cap[768].truncation_rate < TRUNCATION_RATE_LIMIT
    assert cells["strict"].limit == 768 and cells["strict"].source == "sweep"
    assert cells["strict"].run_ids == ["run-strict-off", "run-strict-768"]
    assert cells["strict"].config_hash == "rc-strict-768"
    assert cells["balanced"].limit == 768
    assert (tmp_path / "report" / "output-cap-sweep.md").is_file()
    saved = json.loads((tmp_path / "report" / "output-cap-sweep.json").read_text(encoding="utf-8"))
    assert saved["selections"][0]["reasons"]["512"] == ["answer_correctness_outside_band", "truncation_rate_at_or_above_limit"]


def test_a_fixture_sweep_is_refused_before_any_run_when_it_would_write_the_committed_file(tmp_path: Path):
    config, golden, by_id = _sweep_inputs(tmp_path, [100] * 5)
    stub = _CapStub(by_id)
    before = CAPS_PATH.read_bytes()
    with pytest.raises(OutputCapSweepError, match="never writes"):
        run_output_cap_sweep(config, CAPS_PATH, tmp_path / "report", runner=stub, golden=golden)
    assert stub.calls == []
    assert CAPS_PATH.read_bytes() == before


def test_the_cli_default_out_is_the_committed_file_and_a_fixture_run_exits_2(tmp_path: Path, capsys):
    before = CAPS_PATH.read_bytes()
    code = main(["output-cap", "--report-dir", str(tmp_path / "report")])
    assert code == 2
    assert "never writes" in capsys.readouterr().err
    assert CAPS_PATH.read_bytes() == before


def test_a_live_sweep_runs_each_candidate_against_its_own_deployment(tmp_path: Path):
    config, golden, by_id = _sweep_inputs(tmp_path, [100] * 5)
    urls = tmp_path / "urls.json"
    urls.write_text(json.dumps({"off": "https://preview.invalid/off", "512": "https://preview.invalid/512"}), encoding="utf-8")
    live = load_live_urls(urls, (512,))
    stub = _CapStub(by_id)
    out = tmp_path / "caps.json"
    result = run_output_cap_sweep(config, out, tmp_path / "report", runner=stub, golden=golden, candidates=(512,), modes=("strict",), live_urls=live)
    assert result.mode == "live"
    assert [call["base_url"] for call in stub.calls] == ["https://preview.invalid/off", "https://preview.invalid/512"]
    assert all(call["env_overlay"] is None for call in stub.calls)
    cells = {cell.mode: cell for cell in OutputCaps.model_validate_json(out.read_text(encoding="utf-8")).cells}
    assert cells["strict"].limit == 512
    assert cells["balanced"].source == "default"


def test_live_urls_must_name_every_candidate(tmp_path: Path):
    urls = tmp_path / "urls.json"
    urls.write_text(json.dumps({"off": "https://preview.invalid/off"}), encoding="utf-8")
    with pytest.raises(OutputCapSweepError, match="512"):
        load_live_urls(urls, (512,))


def test_candidates_below_the_app_floor_are_refused(tmp_path: Path):
    config, golden, by_id = _sweep_inputs(tmp_path, [100] * 5)
    with pytest.raises(OutputCapSweepError, match="floor"):
        run_output_cap_sweep(config, tmp_path / "caps.json", tmp_path / "r", runner=_CapStub(by_id), golden=golden, candidates=(128,))


@pytest.mark.harness_integration
@pytest.mark.skipif(
    shutil.which("npx") is None or not (REPO_ROOT / "node_modules" / ".bin" / "tsx").exists(),
    reason="needs node and the repository node_modules",
)
def test_output_cap_sweep_integration_with_the_cap_aware_fake(tmp_path: Path):
    out = tmp_path / "caps.json"
    before = CAPS_PATH.read_bytes()
    result = run_output_cap_sweep(
        REPO_ROOT / "eval" / "config" / "runs" / "p52-output-cap.json",
        out,
        tmp_path / "report",
        candidates=(512,),
    )
    assert CAPS_PATH.read_bytes() == before
    caps = OutputCaps.model_validate_json(out.read_text(encoding="utf-8"))
    for cell in caps.cells:
        assert cell.source == "sweep" and len(cell.run_ids) >= 1 and cell.config_hash
    assert all(row.n_answers > 0 for row in result.results)
    report = json.loads((tmp_path / "report" / "runs" / "balanced-512" / "report.json").read_text(encoding="utf-8"))
    assert report["rag_mode"] == "balanced"
    assert "rag_mode" not in json.loads((tmp_path / "report" / "runs" / "strict-512" / "report.json").read_text(encoding="utf-8"))


def test_run_harness_answers_and_passes_the_mode_for_the_output_cap_sweep(tmp_path: Path):
    from types import SimpleNamespace

    from rag_eval.harness_runner import HarnessError, run_harness

    seen: list[list[str]] = []

    def spawner(argv, cwd):
        seen.append(list(argv))
        return SimpleNamespace(returncode=1, stdout="", stderr="")

    config, golden, _ = _sweep_inputs(tmp_path, [100] * 3)
    with pytest.raises(HarnessError):
        run_harness(run_config=config, golden=golden, out=tmp_path / "a", spawner=spawner, answers=True, rag_mode="balanced")
    with pytest.raises(HarnessError):
        run_harness(run_config=config, golden=golden, out=tmp_path / "b", spawner=spawner)
    assert "--no-answers" not in seen[0] and seen[0][seen[0].index("--rag-mode") + 1] == "balanced"
    assert "--no-answers" in seen[1] and "--rag-mode" not in seen[1]
    with pytest.raises(HarnessError, match="rag_mode"):
        run_harness(run_config=config, golden=golden, out=tmp_path / "c", spawner=spawner, rag_mode="flexible")
