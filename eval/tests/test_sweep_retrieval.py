import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from rag_sidecar.contracts.golden import GoldenItem

from rag_eval.golden_io import load_golden, write_golden
from rag_eval.harness_runner import HarnessError, HarnessRun, dev_only_golden, run_harness
from rag_eval.metrics import score_items
from rag_eval.report import build_report, write_report
from rag_eval.split import assign_split
from test_report_runner import QUOTE, _item, _manifest, _trace


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
