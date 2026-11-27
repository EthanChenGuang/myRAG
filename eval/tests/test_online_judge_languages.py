import json
from pathlib import Path
from typing import Any

import pytest
from fake_langfuse import FakeLangfuse
from judge_stubs import StubDeepEvalLLM
from rag_sidecar.contracts.judge import JudgeConfig

from rag_eval.judge.config import DEFAULT_CONFIG_PATH
from rag_eval.online_judge import by_language, main

WINDOW = ["--from", "2026-11-01T00:00:00Z", "--to", "2026-11-30T00:00:00Z"]
QUERY = "What does the synthetic sample section describe?"
ANSWER = "It describes the sample procedure in three steps."
CONTEXT = "The synthetic sample section describes the sample procedure in three steps."
MODEL = "google/gemini-2.5-flash"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    for name in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "OPENROUTER_API_KEY", "CONFIDENT_API_KEY"):
        monkeypatch.delenv(name, raising=False)


def _keys(monkeypatch, fake: FakeLangfuse) -> None:
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-placeholder")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-placeholder")
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-test-placeholder")
    monkeypatch.setenv("LANGFUSE_BASE_URL", fake.url)


def _obs(n: int, language: str | None) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "tenantKey": json.dumps("tenant-a"),
        "context": json.dumps(CONTEXT),
        "model": json.dumps(MODEL),
    }
    if language is not None:
        metadata["query_language"] = json.dumps(language)
        metadata["chunk_languages"] = json.dumps([language, "en"])
    return {
        "id": f"{n:016x}",
        "traceId": f"{n:032x}",
        "name": "rag-request",
        "type": "SPAN",
        "startTime": f"2026-11-{n:02d}T10:00:00.000Z",
        "userId": "tenant-a",
        "tags": ["review_candidate"],
        "input": json.dumps(QUERY),
        "output": json.dumps(ANSWER),
        "metadata": metadata,
    }


def _config(tmp_path: Path) -> Path:
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["online_judge"]["sample_rate"] = 1.0
    path = tmp_path / "judge.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    return path


def _factory(_config: JudgeConfig) -> StubDeepEvalLLM:
    return StubDeepEvalLLM()


def _run(monkeypatch, tmp_path, capsys, rows: list[dict[str, Any]]) -> tuple[dict[str, Any], str]:
    with FakeLangfuse(rows) as fake:
        _keys(monkeypatch, fake)
        rc = main([*WINDOW, "--config", str(_config(tmp_path)), "--dry-run"], judge_factory=_factory)
    assert rc == 0
    out = capsys.readouterr().out
    lines = [line for line in out.splitlines() if line.startswith("{")]
    return json.loads(lines[-1]), out


def test_summary_reports_scores_per_query_language_with_und_for_traces_without_the_block(monkeypatch, tmp_path, capsys):
    rows = [_obs(1, "zh"), _obs(2, "en"), _obs(3, "it"), _obs(4, None)]
    summary, out = _run(monkeypatch, tmp_path, capsys, rows)
    assert summary["candidates"] == 4 and summary["sampled"] == 4 and summary["scored"] == 4
    assert sorted(summary["by_language"]) == ["en", "it", "und", "zh"]
    for cell in summary["by_language"].values():
        assert cell["traces"] == 1
        for metric in ("faithfulness", "answer_relevance"):
            assert cell[metric]["n"] == 1
            assert 0.0 <= cell[metric]["mean"] <= 1.0
    for text in (QUERY, ANSWER, CONTEXT):
        assert text not in out


def test_the_existing_totals_do_not_change_with_the_language_block(monkeypatch, tmp_path, capsys):
    with_block, _ = _run(monkeypatch, tmp_path, capsys, [_obs(1, "zh"), _obs(2, "en")])
    without_block, _ = _run(monkeypatch, tmp_path, capsys, [_obs(1, None), _obs(2, None)])
    assert {key: value for key, value in with_block.items() if key != "by_language"} == {
        key: value for key, value in without_block.items() if key != "by_language"
    }
    assert list(without_block["by_language"]) == ["und"]
    assert without_block["by_language"]["und"]["traces"] == 2


def test_by_language_counts_and_means_only():
    scores = [
        {"traceId": "t1", "name": "faithfulness", "value": 1.0},
        {"traceId": "t1", "name": "answer_relevance", "value": 0.5},
        {"traceId": "t2", "name": "faithfulness", "value": 0.0},
        {"traceId": "t3", "name": "faithfulness", "value": 0.25},
    ]
    summary = by_language(scores, {"t1": "zh", "t2": "zh"})
    assert summary == {
        "und": {"traces": 1, "faithfulness": {"n": 1, "mean": 0.25}, "answer_relevance": {"n": 0, "mean": None}},
        "zh": {"traces": 2, "faithfulness": {"n": 2, "mean": 0.5}, "answer_relevance": {"n": 1, "mean": 0.5}},
    }


def test_a_query_language_that_is_not_a_code_counts_under_und(monkeypatch, tmp_path, capsys):
    row = _obs(1, None)
    row["metadata"]["query_language"] = json.dumps("A sentence instead of a code")
    summary, _ = _run(monkeypatch, tmp_path, capsys, [row])
    assert list(summary["by_language"]) == ["und"]
