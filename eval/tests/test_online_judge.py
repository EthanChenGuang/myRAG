import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from fake_langfuse import FakeLangfuse
from judge_stubs import StubDeepEvalLLM
from rag_sidecar.contracts.judge import JudgeConfig

from rag_eval.judge.config import DEFAULT_CONFIG_PATH
from rag_eval.online_judge import judge_traces, main, select_sample

PUBLIC_KEY = "pk-test-placeholder"
SECRET_KEY = "sk-test-placeholder"
WINDOW = ["--from", "2026-11-01T00:00:00Z", "--to", "2026-11-30T00:00:00Z"]


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    for name in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "OPENROUTER_API_KEY", "CONFIDENT_API_KEY"):
        monkeypatch.delenv(name, raising=False)


def _keys(monkeypatch, fake: FakeLangfuse | None = None) -> None:
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", PUBLIC_KEY)
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", SECRET_KEY)
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-test-placeholder")
    if fake is not None:
        monkeypatch.setenv("LANGFUSE_BASE_URL", fake.url)


def _obs(n: int, model: str, **overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": f"{n:016x}",
        "traceId": f"{n:032x}",
        "name": "rag-request",
        "type": "SPAN",
        "startTime": f"2026-11-{n:02d}T10:00:00.000Z",
        "userId": "tenant-a",
        "tags": ["review_candidate"],
        "input": json.dumps("How many leave days do employees get?"),
        "output": json.dumps("Twenty days per year."),
        "metadata": {
            "tenantKey": json.dumps("tenant-a"),
            "context": json.dumps("Employees receive twenty days of leave per year."),
            "model": json.dumps(model),
        },
    }
    row.update(overrides)
    return row


def _config(tmp_path: Path, *, online: dict[str, Any] | None | str = "keep", sample_rate: float = 1.0) -> Path:
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    if online is None:
        raw.pop("online_judge", None)
    elif isinstance(online, dict):
        raw["online_judge"] = online
    else:
        raw["online_judge"]["sample_rate"] = sample_rate
    path = tmp_path / "judge.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    return path


class _Factory:
    def __init__(self) -> None:
        self.models: list[str] = []
        self.llms: list[StubDeepEvalLLM] = []

    def __call__(self, config: JudgeConfig) -> StubDeepEvalLLM:
        self.models.append(config.judge_model)
        llm = StubDeepEvalLLM()
        self.llms.append(llm)
        return llm


def _summary(capsys) -> dict[str, Any]:
    lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    assert lines, "no JSON summary printed"
    return json.loads(lines[-1])


def test_select_sample_is_deterministic_and_close_to_the_rate():
    ids = [f"trace-{n}" for n in range(1000)]
    first = select_sample(ids, 0.2, 20261123)
    assert first == select_sample(list(reversed(ids)), 0.2, 20261123)
    assert 150 <= len(first) <= 250
    assert set(first) <= set(ids)
    assert first != select_sample(ids, 0.2, 7)


def test_select_sample_bounds():
    ids = [f"trace-{n}" for n in range(50)]
    assert select_sample(ids, 0.0, 1) == []
    assert sorted(select_sample(ids, 1.0, 1)) == sorted(ids)


def test_scores_use_the_pinned_judge_for_google_traces_and_the_online_judge_for_openai_traces(monkeypatch, tmp_path, capsys):
    rows = [
        _obs(1, "google/gemini-2.5-flash"),
        _obs(2, "google/gemini-2.5-flash"),
        _obs(3, "openai/gpt-4o-mini"),
        _obs(4, "openai/gpt-4o-mini"),
    ]
    factory = _Factory()
    with FakeLangfuse(rows) as fake:
        _keys(monkeypatch, fake)
        rc = main([*WINDOW, "--config", str(_config(tmp_path))], judge_factory=factory)
        posts = fake.score_requests()
    assert rc == 0
    config = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    assert sorted(factory.models) == sorted([config["judge_model"], config["online_judge"]["judge_model"]])
    assert len(posts) == 1
    body = posts[0]["body"]
    assert isinstance(body, list) and len(body) == 8
    by_trace: dict[str, set[str]] = {}
    for entry in body:
        by_trace.setdefault(entry["traceId"], set()).add(entry["name"])
    assert all(names == {"faithfulness", "answer_relevance"} for names in by_trace.values())
    google_judges = {e["metadata"]["judge_model"] for e in body if e["traceId"] in (f"{1:032x}", f"{2:032x}")}
    openai_judges = {e["metadata"]["judge_model"] for e in body if e["traceId"] in (f"{3:032x}", f"{4:032x}")}
    assert google_judges == {config["judge_model"]}
    assert openai_judges == {config["online_judge"]["judge_model"]}
    summary = _summary(capsys)
    assert summary["candidates"] == 4 and summary["sampled"] == 4 and summary["scored"] == 4
    assert summary["post_status"] == 202 and summary["skipped"]["same_family"] == 0


def test_score_entries_carry_deterministic_ids_and_timestamps(monkeypatch, tmp_path):
    rows = [_obs(1, "google/gemini-2.5-flash")]
    bodies = []
    for _ in range(2):
        with FakeLangfuse(rows) as fake:
            _keys(monkeypatch, fake)
            assert main([*WINDOW, "--config", str(_config(tmp_path))], judge_factory=_Factory()) == 0
            bodies.append(fake.score_requests()[0]["body"])
    assert bodies[0] == bodies[1]
    judge_model = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))["judge_model"]
    for entry in bodies[0]:
        expected = hashlib.sha256(f"{entry['traceId']}\n{entry['name']}\n{judge_model}".encode()).hexdigest()
        assert entry["id"] == expected
        assert entry["timestamp"] == "2026-11-01T10:00:00.000Z"
        assert isinstance(entry["value"], float) and 0.0 <= entry["value"] <= 1.0


def test_same_family_traces_are_skipped_and_counted(monkeypatch, tmp_path, capsys):
    rows = [_obs(1, "google/gemini-2.5-flash"), _obs(2, "openai/gpt-4o-mini")]
    factory = _Factory()
    with FakeLangfuse(rows) as fake:
        _keys(monkeypatch, fake)
        rc = main([*WINDOW, "--config", str(_config(tmp_path, online=None))], judge_factory=factory)
        posts = fake.score_requests()
    assert rc == 0
    summary = _summary(capsys)
    assert summary["skipped"]["same_family"] == 1
    assert summary["scored"] == 1
    assert {entry["traceId"] for entry in posts[0]["body"]} == {f"{1:032x}"}


def test_a_207_answer_is_reported_and_never_retried(monkeypatch, tmp_path, capsys):
    rows = [_obs(1, "google/gemini-2.5-flash"), _obs(2, "google/gemini-2.5-flash")]
    with FakeLangfuse(rows, scores_status=207, reject_indexes={0}) as fake:
        _keys(monkeypatch, fake)
        rc = main([*WINDOW, "--config", str(_config(tmp_path))], judge_factory=_Factory())
        posts = fake.score_requests()
    assert rc == 0
    assert len(posts) == 1
    summary = _summary(capsys)
    assert summary["post_status"] == 207
    assert summary["rejected"] == 1 and summary["accepted"] == 3


def test_missing_langfuse_keys_print_a_notice_and_make_no_request(monkeypatch, tmp_path, capsys):
    with FakeLangfuse([_obs(1, "google/gemini-2.5-flash")]) as fake:
        monkeypatch.setenv("LANGFUSE_BASE_URL", fake.url)
        monkeypatch.setenv("OPENROUTER_API_KEY", "or-test-placeholder")
        rc = main([*WINDOW, "--config", str(_config(tmp_path))], judge_factory=_Factory())
        assert fake.requests == []
    assert rc == 0
    assert "::notice::" in capsys.readouterr().out


def test_missing_judge_key_prints_a_notice_and_makes_no_request(monkeypatch, tmp_path, capsys):
    with FakeLangfuse([_obs(1, "google/gemini-2.5-flash")]) as fake:
        _keys(monkeypatch, fake)
        monkeypatch.delenv("OPENROUTER_API_KEY")
        rc = main([*WINDOW, "--config", str(_config(tmp_path))])
        assert fake.requests == []
    assert rc == 0
    assert "::notice::" in capsys.readouterr().out


def test_no_review_candidates_prints_a_notice_and_exits_zero(monkeypatch, tmp_path, capsys):
    with FakeLangfuse([]) as fake:
        _keys(monkeypatch, fake)
        rc = main([*WINDOW, "--config", str(_config(tmp_path))], judge_factory=_Factory())
        assert fake.score_requests() == []
    out = capsys.readouterr().out
    assert rc == 0
    assert "::notice::" in out and "nothing was judged" in out


def test_dry_run_scores_but_does_not_post(monkeypatch, tmp_path, capsys):
    with FakeLangfuse([_obs(1, "google/gemini-2.5-flash")]) as fake:
        _keys(monkeypatch, fake)
        rc = main([*WINDOW, "--dry-run", "--config", str(_config(tmp_path))], judge_factory=_Factory())
        assert fake.score_requests() == []
    assert rc == 0
    summary = _summary(capsys)
    assert summary["scored"] == 1 and summary["post_status"] == "dry_run"


def test_traces_without_query_answer_or_context_are_skipped_as_missing_content(monkeypatch, tmp_path, capsys):
    rows = [
        _obs(1, "google/gemini-2.5-flash", output=json.dumps("")),
        _obs(2, "google/gemini-2.5-flash", metadata={"model": json.dumps("google/gemini-2.5-flash")}),
        _obs(3, "google/gemini-2.5-flash"),
    ]
    with FakeLangfuse(rows) as fake:
        _keys(monkeypatch, fake)
        rc = main([*WINDOW, "--config", str(_config(tmp_path))], judge_factory=_Factory())
        posts = fake.score_requests()
    assert rc == 0
    summary = _summary(capsys)
    assert summary["skipped"]["missing_content"] == 2 and summary["scored"] == 1
    assert {entry["traceId"] for entry in posts[0]["body"]} == {f"{3:032x}"}


def test_a_trace_with_several_observations_is_judged_once(monkeypatch, tmp_path, capsys):
    rows = [_obs(1, "google/gemini-2.5-flash"), _obs(1, "google/gemini-2.5-flash", id="ffffffffffffffff")]
    with FakeLangfuse(rows) as fake:
        _keys(monkeypatch, fake)
        rc = main([*WINDOW, "--config", str(_config(tmp_path))], judge_factory=_Factory())
        body = fake.score_requests()[0]["body"]
    assert rc == 0
    assert len(body) == 2
    assert _summary(capsys)["candidates"] == 1


def test_a_failing_judge_call_is_counted_and_not_posted(monkeypatch, tmp_path, capsys):
    from judge_stubs import FAIL_MARKER

    rows = [_obs(1, "google/gemini-2.5-flash", output=json.dumps(f"{FAIL_MARKER} answer"))]
    with FakeLangfuse(rows) as fake:
        _keys(monkeypatch, fake)
        rc = main([*WINDOW, "--config", str(_config(tmp_path))], judge_factory=_Factory())
        assert fake.score_requests() == []
    assert rc == 0
    summary = _summary(capsys)
    assert summary["scored"] == 0 and summary["skipped"]["judge_error"] == 2


def test_judge_traces_orders_scores_by_trace_and_metric():
    from rag_sidecar.contracts.review import ReviewQueueItem

    from rag_eval.judge.config import load_judge_config

    def item(n: int) -> ReviewQueueItem:
        return ReviewQueueItem(
            trace_id=f"{n:032x}",
            observation_id=f"{n:016x}",
            captured_at=f"2026-11-{n:02d}T10:00:00.000Z",
            tenant_key="tenant-a",
            query_masked="How many leave days?",
            answer_masked="Twenty days.",
            context_masked="Employees receive twenty days of leave.",
            model="google/gemini-2.5-flash",
        )

    scores, skipped = judge_traces([item(2), item(1)], load_judge_config(), _Factory())
    assert [(s["traceId"], s["name"]) for s in scores] == sorted((s["traceId"], s["name"]) for s in scores)
    assert len(scores) == 4 and skipped.get("same_family", 0) == 0
