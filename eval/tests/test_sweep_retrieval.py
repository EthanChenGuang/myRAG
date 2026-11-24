import json
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.retrieval import RetrievalParams, compute_config_hash

from rag_eval.golden_io import load_golden, write_golden
from rag_eval.harness_runner import HarnessError, HarnessRun, dev_only_golden, run_harness
from rag_eval.metrics import score_items
from rag_eval.report import build_report, write_report
from rag_eval.split import assign_split
from rag_eval.sweep.retrieval import (
    PARAMS_PATH,
    SweepCell,
    SweepGrid,
    SweepResult,
    SweepUsageError,
    choose_configuration,
    main,
    rerank_cap,
    run_retrieval_sweep,
)
from test_report_runner import QUOTE, _item, _manifest, _trace

REPO_ROOT = Path(__file__).resolve().parents[2]
NOISE = NoiseConfig.model_validate_json((REPO_ROOT / "eval" / "config" / "noise.json").read_text(encoding="utf-8"))


def _ids(split: str, count: int, prefix: str = "en-general") -> list[str]:
    found: list[str] = []
    n = 0
    while len(found) < count:
        candidate = f"{prefix}-{n:03d}"
        if assign_split(candidate) == split:
            found.append(candidate)
        n += 1
    return found


def _golden_file(tmp_path: Path, items: list[GoldenItem]) -> Path:
    path = tmp_path / "golden.jsonl"
    write_golden(path, items)
    return path


def _with_split(item: GoldenItem, split: str) -> GoldenItem:
    return item.model_copy(update={"split": split})


def _mixed_items() -> tuple[list[str], list[str], list[GoldenItem]]:
    dev_ids = _ids("dev", 3)
    test_ids = _ids("test", 2)
    items = [_item(i, "en", answerable=True) for i in dev_ids]
    items += [_with_split(_item(i, "en", answerable=True), "test") for i in test_ids]
    return dev_ids, test_ids, items


def _flag(argv: list[str], name: str) -> str:
    return argv[argv.index(name) + 1]


class _Stub:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.calls: list[tuple[list[str], Path]] = []
        self.golden_seen: list[str] = []
        self.run_config_seen: list[dict] = []
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    def __call__(self, argv: list[str], cwd: Path):
        self.calls.append((list(argv), Path(cwd)))
        golden_path = Path(_flag(argv, "--golden"))
        self.golden_seen = [json.loads(line)["id"] for line in golden_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.run_config_seen.append(json.loads(Path(_flag(argv, "--run-config")).read_text(encoding="utf-8")))
        if self.returncode == 0:
            out = Path(_flag(argv, "--out"))
            golden = load_golden(golden_path)
            traces = [_trace(item.id, [("doc.en.md", f"intro {QUOTE} outro")]) for item in golden]
            report = build_report(_manifest(), score_items(traces, golden), golden, traces)
            write_report(report, out)
            (out / "traces.jsonl").write_text("".join(t.model_dump_json() + "\n" for t in traces), encoding="utf-8")
            (out / "run.json").write_text(_manifest().model_dump_json(), encoding="utf-8")
        return SimpleNamespace(returncode=self.returncode, stdout=self.stdout, stderr=self.stderr)


def _base_config(tmp_path: Path, *, overrides: dict | None = None, env: dict | None = None) -> Path:
    path = tmp_path / "base-run.json"
    payload: dict = {"name": "base-run", "env": env if env is not None else {"RAG_PIPELINE": "v2"}}
    if overrides is not None:
        payload["overrides"] = overrides
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_harness_dev_only_golden_keeps_exactly_the_dev_items(tmp_path: Path):
    dev_ids, test_ids, items = _mixed_items()
    source = _golden_file(tmp_path, items)
    out = dev_only_golden(source, tmp_path / "dev.jsonl")
    kept = [item.id for item in load_golden(out)]
    assert sorted(kept) == sorted(dev_ids)
    assert not set(kept) & set(test_ids)


def test_harness_dev_only_golden_drops_items_whose_split_field_disagrees_with_the_rule(tmp_path: Path):
    dev_id = _ids("dev", 1, "it-exact")[0]
    test_id = _ids("test", 1, "it-exact")[0]
    mislabelled_dev = _with_split(_item(dev_id, "it", answerable=True), "test")
    mislabelled_test = _item(test_id, "it", answerable=True)
    source = _golden_file(tmp_path, [mislabelled_dev, mislabelled_test])
    out = dev_only_golden(source, tmp_path / "dev.jsonl")
    assert load_golden(out) == []


def test_harness_dev_only_golden_default_destination_is_a_temporary_file(tmp_path: Path):
    _, _, items = _mixed_items()
    source = _golden_file(tmp_path, items)
    out = dev_only_golden(source)
    try:
        assert out != source
        assert out.exists()
        assert all(assign_split(item.id) == "dev" for item in load_golden(out))
    finally:
        out.unlink(missing_ok=True)


def test_harness_run_spawns_run_smoke_with_the_exact_argv(tmp_path: Path):
    _, _, items = _mixed_items()
    golden = _golden_file(tmp_path, items)
    stub = _Stub()
    out = tmp_path / "cell"
    run = run_harness(
        run_config=_base_config(tmp_path),
        golden=golden,
        out=out,
        overrides={"candidate_pool_size": 50, "rerank_input_cap": 50, "final_top_k": 8},
        fixture_mode="prechunked",
        spawner=stub,
        repo_root=tmp_path,
    )
    assert isinstance(run, HarnessRun)
    assert len(stub.calls) == 1
    argv, cwd = stub.calls[0]
    assert cwd == tmp_path
    assert argv[:3] == ["npx", "tsx", "eval/harness/run-smoke.mts"]
    assert _flag(argv, "--run-config") == str(run.run_config_path)
    assert _flag(argv, "--golden") == str(run.golden_path)
    assert "--no-gate" in argv
    assert _flag(argv, "--out") == str(out)
    assert _flag(argv, "--fixture-mode") == "prechunked"
    assert "--base-url" not in argv


def test_harness_run_with_base_url_passes_it_and_drops_the_env_overlay(tmp_path: Path):
    _, _, items = _mixed_items()
    golden = _golden_file(tmp_path, items)
    stub = _Stub()
    run_harness(
        run_config=_base_config(tmp_path),
        golden=golden,
        out=tmp_path / "cell",
        overrides={"final_top_k": 5},
        base_url="http://127.0.0.1:9",
        spawner=stub,
        repo_root=tmp_path,
    )
    argv, _ = stub.calls[0]
    assert _flag(argv, "--base-url") == "http://127.0.0.1:9"
    assert "--fixture-mode" not in argv
    assert stub.run_config_seen[0]["env"] == {}


def test_harness_run_config_merges_overrides_over_the_base_file(tmp_path: Path):
    _, _, items = _mixed_items()
    golden = _golden_file(tmp_path, items)
    stub = _Stub()
    run_harness(
        run_config=_base_config(tmp_path, overrides={"rerank_model": "fake-quality-v1", "final_top_k": 3}),
        golden=golden,
        out=tmp_path / "cell",
        overrides={"candidate_pool_size": 25, "rerank_input_cap": 50, "final_top_k": 10},
        spawner=stub,
        repo_root=tmp_path,
    )
    written = stub.run_config_seen[0]
    assert written["name"] == "base-run"
    assert written["env"] == {"RAG_PIPELINE": "v2"}
    assert written["overrides"] == {
        "rerank_model": "fake-quality-v1",
        "candidate_pool_size": 25,
        "rerank_input_cap": 50,
        "final_top_k": 10,
    }


def test_harness_run_never_hands_a_test_split_item_to_the_harness(tmp_path: Path):
    dev_ids, test_ids, items = _mixed_items()
    golden = _golden_file(tmp_path, items)
    stub = _Stub()
    run = run_harness(run_config=_base_config(tmp_path), golden=golden, out=tmp_path / "cell", spawner=stub, repo_root=tmp_path)
    assert sorted(stub.golden_seen) == sorted(dev_ids)
    assert not set(stub.golden_seen) & set(test_ids)
    assert sorted(t.item_id for t in run.traces) == sorted(dev_ids)


def test_harness_run_parses_report_traces_and_manifest(tmp_path: Path):
    dev_ids, _, items = _mixed_items()
    golden = _golden_file(tmp_path, items)
    run = run_harness(run_config=_base_config(tmp_path), golden=golden, out=tmp_path / "cell", spawner=_Stub(), repo_root=tmp_path)
    assert run.report is not None
    assert run.report.overall.recall_at_5.n == len(dev_ids)
    assert len(run.traces) == len(dev_ids)
    assert run.manifest is not None
    assert run.manifest.run_id == "run-test"
    assert run.out_dir == tmp_path / "cell"


def test_harness_nonzero_exit_raises_with_the_code_and_only_the_last_twenty_lines(tmp_path: Path):
    _, _, items = _mixed_items()
    golden = _golden_file(tmp_path, items)
    stdout = "\n".join(f"stdout line {n}" for n in range(1, 61))
    stub = _Stub(returncode=3, stdout=stdout)
    with pytest.raises(HarnessError) as excinfo:
        run_harness(run_config=_base_config(tmp_path), golden=golden, out=tmp_path / "cell", spawner=stub, repo_root=tmp_path)
    message = str(excinfo.value)
    assert "exit code 3" in message
    assert "stdout line 60" in message
    assert "stdout line 41" in message
    assert "stdout line 40" not in message
    assert excinfo.value.exit_code == 3


def test_harness_missing_report_after_a_clean_exit_is_an_error(tmp_path: Path):
    _, _, items = _mixed_items()
    golden = _golden_file(tmp_path, items)

    def spawner(argv: list[str], cwd: Path):
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    with pytest.raises(HarnessError, match="report.json"):
        run_harness(run_config=_base_config(tmp_path), golden=golden, out=tmp_path / "cell", spawner=spawner, repo_root=tmp_path)


def _cell(pool: int, top_k: int, recall: float, mrr: float, tokens: float = 1000.0, latency: float = 100.0) -> SweepCell:
    return SweepCell(
        candidate_pool_size=pool,
        rerank_input_cap=rerank_cap(pool),
        final_top_k=top_k,
        recall_at_k=recall,
        mrr=mrr,
        mean_context_tokens=tokens,
        latency_p95_ms=latency,
        n_items=10,
    )


def test_rerank_cap_clamps_the_pool_to_50_through_100():
    assert [rerank_cap(p) for p in (1, 25, 50, 75, 100, 150, 200)] == [50, 50, 50, 75, 100, 100, 100]


def test_choose_picks_the_smaller_pool_within_the_noise_band_of_the_best():
    cells = [_cell(75, 8, 0.90, 0.80), _cell(50, 8, 0.89, 0.79), _cell(100, 8, 0.88, 0.78)]
    selection = choose_configuration(cells, NOISE)
    assert (selection.chosen.candidate_pool_size, selection.chosen.final_top_k) == (50, 8)
    assert selection.best_recall == 0.90
    assert selection.best_mrr == 0.80
    assert selection.noise_band == pytest.approx(0.02)
    assert sorted(selection.within_band) == [(50, 8), (75, 8), (100, 8)]


def test_choose_never_picks_a_cell_outside_the_band_on_either_metric_even_if_smaller():
    cells = [
        _cell(75, 8, 0.90, 0.80),
        _cell(25, 5, 0.85, 0.80),
        _cell(50, 5, 0.90, 0.70),
    ]
    selection = choose_configuration(cells, NOISE)
    assert (selection.chosen.candidate_pool_size, selection.chosen.final_top_k) == (75, 8)
    assert selection.within_band == [(75, 8)]


def test_choose_breaks_a_size_tie_by_context_tokens_then_latency():
    cells = [
        _cell(50, 10, 0.90, 0.80, tokens=2500, latency=90),
        _cell(50, 8, 0.90, 0.80, tokens=2000, latency=200),
        _cell(50, 5, 0.90, 0.80, tokens=2000, latency=120),
    ]
    selection = choose_configuration(cells, NOISE)
    assert (selection.chosen.final_top_k, selection.chosen.latency_p95_ms) == (5, 120)


def test_choose_widens_the_band_with_run_to_run_spread():
    cells = [_cell(75, 8, 0.90, 0.80), _cell(25, 8, 0.85, 0.75)]
    assert choose_configuration(cells, NOISE).chosen.candidate_pool_size == 75
    wide = choose_configuration(cells, NOISE, spread=0.02)
    assert wide.noise_band == pytest.approx(NOISE.k * 0.02)
    assert wide.chosen.candidate_pool_size == 25


def test_choose_rejects_an_empty_grid():
    with pytest.raises(ValueError):
        choose_configuration([], NOISE)


class _SweepStub:
    """Stand-in for run_harness: the gold chunk sits at rank `gold_rank(pool, k)`, filler chunks fill the rest, kept is cut to top-k."""

    def __init__(self, gold_rank, context_tokens=lambda pool, k: 100 * k, latency=lambda pool, k: 10.0 * pool, golden_override: Path | None = None):
        self.gold_rank = gold_rank
        self.context_tokens = context_tokens
        self.latency = latency
        self.golden_override = golden_override
        self.calls: list[dict] = []

    def __call__(self, *, run_config, golden, out, overrides=None, base_url=None, fixture_mode=None, **_ignored):
        self.calls.append(
            {"run_config": run_config, "golden": golden, "out": out, "overrides": dict(overrides or {}), "base_url": base_url, "fixture_mode": fixture_mode}
        )
        pool, k = overrides["candidate_pool_size"], overrides["final_top_k"]
        dev = Path(out) / "inputs" / "golden.dev.jsonl"
        dev_path = dev_only_golden(Path(golden), dev)
        used = self.golden_override or dev_path
        items = load_golden(used)
        rank = self.gold_rank(pool, k)
        traces = []
        for item in items:
            chunks = [("filler.md", "nothing relevant")] * (rank - 1) + [("doc.en.md", f"intro {QUOTE} outro")] + [("filler.md", "more")] * 30
            trace = _trace(item.id, chunks[:k])
            trace = trace.model_copy(
                update={"context_tokens": self.context_tokens(pool, k), "stage_latency_ms": {"search": self.latency(pool, k)}}
            )
            traces.append(trace)
        report = build_report(_manifest(), score_items(traces, items), items, traces)
        write_report(report, Path(out))
        return HarnessRun(out_dir=Path(out), golden_path=used, run_config_path=Path(run_config), argv=[], report=report, traces=traces)


def _fixture_inputs(tmp_path: Path) -> tuple[Path, Path]:
    _, _, items = _mixed_items()
    return _base_config(tmp_path, overrides={"rerank_model": "fake-quality-v1"}), _golden_file(tmp_path, items)


def test_sweep_runs_every_cell_with_pool_cap_and_top_k_overrides(tmp_path: Path):
    config, golden = _fixture_inputs(tmp_path)
    stub = _SweepStub(gold_rank=lambda pool, k: 1)
    run_retrieval_sweep(config, SweepGrid(pools=(25, 50, 75, 100), top_ks=(5, 20)), tmp_path / "out", runner=stub, golden=golden)
    assert len(stub.calls) == 8
    seen = {(c["overrides"]["candidate_pool_size"], c["overrides"]["rerank_input_cap"], c["overrides"]["final_top_k"]) for c in stub.calls}
    assert seen == {(25, 50, 5), (25, 50, 20), (50, 50, 5), (50, 50, 20), (75, 75, 5), (75, 75, 20), (100, 100, 5), (100, 100, 20)}
    assert all(c["base_url"] is None for c in stub.calls)


def test_sweep_scores_recall_at_the_cell_top_k_and_picks_the_smallest_cell_within_noise(tmp_path: Path):
    config, golden = _fixture_inputs(tmp_path)
    stub = _SweepStub(gold_rank=lambda pool, k: 6)
    result = run_retrieval_sweep(config, SweepGrid(pools=(50, 75), top_ks=(5, 8)), tmp_path / "out", runner=stub, golden=golden)
    by_cell = {(c.candidate_pool_size, c.final_top_k): c for c in result.cells}
    assert by_cell[(50, 5)].recall_at_k == 0.0
    assert by_cell[(50, 5)].mrr == 0.0
    assert by_cell[(75, 8)].recall_at_k == 1.0
    assert by_cell[(75, 8)].mrr == pytest.approx(1 / 6)
    assert result.selection is not None
    assert (result.selection.chosen.candidate_pool_size, result.selection.chosen.final_top_k) == (50, 8)
    assert result.selection.chosen.mean_context_tokens == 800


def test_sweep_reads_only_dev_items_and_refuses_a_run_that_carries_a_test_item(tmp_path: Path):
    config, golden = _fixture_inputs(tmp_path)
    dev_ids, test_ids, items = _mixed_items()
    leaky = tmp_path / "leaky.jsonl"
    write_golden(leaky, items)
    stub = _SweepStub(gold_rank=lambda pool, k: 1, golden_override=leaky)
    with pytest.raises(SweepUsageError, match="test split"):
        run_retrieval_sweep(config, SweepGrid(pools=(50,), top_ks=(5,)), tmp_path / "out", runner=stub, golden=golden)


def test_sweep_writes_json_and_markdown_with_every_recorded_number(tmp_path: Path):
    config, golden = _fixture_inputs(tmp_path)
    out = tmp_path / "out"
    result = run_retrieval_sweep(
        config, SweepGrid(pools=(50, 75), top_ks=(5, 8)), out, runner=_SweepStub(gold_rank=lambda pool, k: 6), golden=golden
    )
    recorded = SweepResult.model_validate_json((out / "retrieval-sweep.json").read_text(encoding="utf-8"))
    assert recorded == result
    assert recorded.mode == "fixture"
    assert recorded.dev_only is True
    assert recorded.grid == SweepGrid(pools=(50, 75), top_ks=(5, 8))
    assert len(recorded.cells) == 4
    assert recorded.noise is not None and recorded.noise.band == pytest.approx(0.02)
    assert len(recorded.run_config_sha256) == 64
    assert len(recorded.golden_sha256) == 64
    assert len(recorded.grid_sha256) == 64
    assert recorded.proposed_params is not None
    assert recorded.params_written is False

    report = (out / "retrieval-sweep.md").read_text(encoding="utf-8")
    for cell in recorded.cells:
        assert f"| {cell.candidate_pool_size} | {cell.rerank_input_cap} | {cell.final_top_k} |" in report
    assert report.count("chosen") >= 1
    assert "dev split only" in report
    assert "test split is never read" in report
    assert "Recall@k" in report and "MRR" in report and "Context tokens" in report and "Latency p95" in report


def test_sweep_fixture_run_never_writes_the_params_file(tmp_path: Path):
    config, golden = _fixture_inputs(tmp_path)
    params = tmp_path / "retrieval-params.json"
    result = run_retrieval_sweep(
        config, SweepGrid(pools=(50,), top_ks=(8,)), tmp_path / "out", runner=_SweepStub(gold_rank=lambda p, k: 1), golden=golden, params_path=params
    )
    assert result.params_written is False
    assert not params.exists()


def test_sweep_write_params_without_a_base_url_is_refused_before_any_run(tmp_path: Path):
    config, golden = _fixture_inputs(tmp_path)
    params = tmp_path / "retrieval-params.json"
    params.write_text(PARAMS_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    before = params.read_bytes()
    stub = _SweepStub(gold_rank=lambda p, k: 1)
    with pytest.raises(SweepUsageError, match="base-url"):
        run_retrieval_sweep(
            config, SweepGrid(pools=(50,), top_ks=(8,)), tmp_path / "out", write_params=True, runner=stub, golden=golden, params_path=params
        )
    assert stub.calls == []
    assert params.read_bytes() == before


def test_sweep_cli_write_params_without_a_base_url_exits_2_and_leaves_the_committed_params_untouched(tmp_path: Path, capsys):
    config, golden = _fixture_inputs(tmp_path)
    before = PARAMS_PATH.read_bytes()
    code = main(["retrieval", "--run-config", str(config), "--golden", str(golden), "--out", str(tmp_path / "out"), "--write-params"])
    assert code == 2
    assert "--base-url" in capsys.readouterr().err
    assert PARAMS_PATH.read_bytes() == before
    assert not (tmp_path / "out").exists()


def test_sweep_live_run_with_write_params_writes_a_valid_params_file_with_sweep_provenance(tmp_path: Path):
    config, golden = _fixture_inputs(tmp_path)
    params = tmp_path / "retrieval-params.json"
    params.write_text(PARAMS_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    existing = RetrievalParams.model_validate_json(params.read_text(encoding="utf-8"))
    stub = _SweepStub(gold_rank=lambda pool, k: 6)
    result = run_retrieval_sweep(
        config,
        SweepGrid(pools=(25, 50, 75), top_ks=(5, 8)),
        tmp_path / "out",
        base_url="http://127.0.0.1:9",
        write_params=True,
        runner=stub,
        golden=golden,
        params_path=params,
    )
    assert all(call["base_url"] == "http://127.0.0.1:9" for call in stub.calls)
    assert result.mode == "live"
    assert result.params_written is True
    written = RetrievalParams.model_validate_json(params.read_text(encoding="utf-8"))
    assert written.provenance.source == "sweep"
    assert (written.candidate_pool_size, written.rerank_input_cap, written.final_top_k) == (25, 50, 8)
    assert written.rrf_k == existing.rrf_k
    assert written.leg_weights == existing.leg_weights
    assert written.config_hash == compute_config_hash(written)
    assert result.proposed_params is not None and result.proposed_params["config_hash"] == written.config_hash


def test_sweep_cli_rejects_a_grid_value_outside_the_params_contract(tmp_path: Path, capsys):
    config, golden = _fixture_inputs(tmp_path)
    code = main(["retrieval", "--run-config", str(config), "--golden", str(golden), "--out", str(tmp_path / "out"), "--pools", "300"])
    assert code == 2
    assert "pool" in capsys.readouterr().err


@pytest.mark.harness_integration
@pytest.mark.skipif(
    shutil.which("npx") is None or not (REPO_ROOT / "node_modules" / ".bin" / "tsx").exists(),
    reason="needs node and the repository node_modules",
)
def test_sweep_integration_two_real_cells_through_the_harness_with_v2_recommended(tmp_path: Path):
    out = tmp_path / "out"
    result = run_retrieval_sweep(
        REPO_ROOT / "eval" / "config" / "runs" / "v2-recommended.json",
        SweepGrid(pools=(50, 75), top_ks=(8,)),
        out,
        golden=REPO_ROOT / "eval" / "fixtures" / "golden.jsonl",
        fixture_mode="prechunked",
    )
    assert [c.candidate_pool_size for c in result.cells] == [50, 75]
    assert all(c.n_items > 0 for c in result.cells)
    assert result.selection is not None
    assert result.params_written is False
    assert (out / "retrieval-sweep.md").is_file()
    manifest = json.loads((out / "cells" / "pool-75_k-8" / "run.json").read_text(encoding="utf-8"))
    assert manifest["run_config"]["overrides"]["candidate_pool_size"] == 75
    assert manifest["run_config"]["overrides"]["rerank_input_cap"] == 75
    assert manifest["golden_filter"]["gate_split"] == "dev"


def test_sweep_records_cell_directories_relative_to_the_repo_root(tmp_path: Path, monkeypatch):
    import rag_eval.paths as paths

    config, golden = _fixture_inputs(tmp_path)
    monkeypatch.setattr(paths, "REPO_ROOT", tmp_path)
    stub = _SweepStub(gold_rank=lambda pool, k: 1)
    result = run_retrieval_sweep(config, SweepGrid(pools=(50,), top_ks=(5,)), tmp_path / "out", runner=stub, golden=golden)
    assert [cell.out_dir for cell in result.cells] == ["out/cells/pool-50_k-5"]
    written = json.loads((tmp_path / "out" / "retrieval-sweep.json").read_text(encoding="utf-8"))
    assert str(tmp_path) not in json.dumps(written)
