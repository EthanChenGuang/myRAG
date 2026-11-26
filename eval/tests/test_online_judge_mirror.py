import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from fake_langfuse import FakeLangfuse
from judge_stubs import StubDeepEvalLLM
from rag_sidecar.contracts.judge import JudgeConfig

import rag_eval.online_judge as online_judge
from rag_eval.judge.config import DEFAULT_CONFIG_PATH
from rag_eval.online_judge import main

TOKEN = "placeholder-admin-bearer-0123456789"
APP = "https://app.example.test"
WINDOW = ["--from", "2026-11-01T00:00:00Z", "--to", "2026-11-30T00:00:00Z"]


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    for name in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "OPENROUTER_API_KEY", "CONFIDENT_API_KEY", "RAG_ADMIN_BEARER"):
        monkeypatch.delenv(name, raising=False)


def _keys(monkeypatch, fake: FakeLangfuse) -> None:
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-placeholder")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-placeholder")
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-test-placeholder")
    monkeypatch.setenv("LANGFUSE_BASE_URL", fake.url)


def _obs(n: int) -> dict[str, Any]:
    return {
        "id": f"{n:016x}",
        "traceId": f"{n:032x}",
        "name": "rag-request",
        "type": "SPAN",
        "startTime": f"2026-11-{n:02d}T10:00:00.000Z",
        "userId": "tenant-a",
        "tags": ["review_candidate"],
        "input": json.dumps("What colour is the sample object?"),
        "output": json.dumps("The sample object is blue."),
        "metadata": {
            "tenantKey": json.dumps("tenant-a"),
            "context": json.dumps("The sample object is blue."),
            "model": json.dumps("google/gemini-2.5-flash"),
        },
    }


def _config(tmp_path: Path) -> Path:
    raw = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    raw["online_judge"]["sample_rate"] = 1.0
    path = tmp_path / "judge.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    return path


def _factory(_config: JudgeConfig) -> StubDeepEvalLLM:
    return StubDeepEvalLLM()


class _App:
    def __init__(self, status: int = 200, raise_error: bool = False) -> None:
        self.status = status
        self.raise_error = raise_error
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.raise_error:
            raise httpx.ConnectError("refused", request=request)
        if self.status != 200:
            return httpx.Response(self.status, json={"success": False, "error": "denied"})
        body = json.loads(request.content)
        return httpx.Response(200, json={"stored": len(body["scores"]), "dropped": 0})

    def install(self, monkeypatch) -> None:
        monkeypatch.setattr(online_judge, "_http_client", lambda: httpx.Client(transport=httpx.MockTransport(self.handler)))


def _run(monkeypatch, tmp_path, app: _App, extra: list[str]) -> tuple[int, list[Any]]:
    app.install(monkeypatch)
    with FakeLangfuse([_obs(1), _obs(2)]) as fake:
        _keys(monkeypatch, fake)
        rc = main([*WINDOW, "--config", str(_config(tmp_path)), *extra], judge_factory=_factory)
        posts = fake.score_requests()
    return rc, posts


def test_scores_are_mirrored_to_the_app_after_the_langfuse_post(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("RAG_ADMIN_BEARER", TOKEN)
    app = _App()
    rc, posts = _run(monkeypatch, tmp_path, app, ["--base-url", APP + "/"])
    assert rc == 0
    assert len(posts) == 1
    langfuse_body = posts[0]["body"]
    assert len(app.requests) == 1
    request = app.requests[0]
    assert request.method == "POST"
    assert str(request.url) == APP + "/api/rag/admin/monitor/judge-scores"
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    body = json.loads(request.content)
    assert list(body) == ["scores"]
    assert all(sorted(entry) == ["judge_id", "metric", "score", "trace_id"] for entry in body["scores"])
    expected = sorted(
        (entry["traceId"], entry["name"], entry["value"], entry["metadata"]["judge_model"]) for entry in langfuse_body
    )
    assert sorted((e["trace_id"], e["metric"], e["score"], e["judge_id"]) for e in body["scores"]) == expected
    out = capsys.readouterr()
    assert TOKEN not in out.out and TOKEN not in out.err


def test_without_a_base_url_or_token_a_notice_is_printed_and_nothing_is_mirrored(monkeypatch, tmp_path, capsys):
    app = _App()
    rc, posts = _run(monkeypatch, tmp_path, app, [])
    assert rc == 0 and len(posts) == 1
    assert app.requests == []
    assert "::notice::" in capsys.readouterr().out

    rc, posts = _run(monkeypatch, tmp_path, app, ["--base-url", APP])
    assert rc == 0 and len(posts) == 1
    assert app.requests == []
    assert "::notice::" in capsys.readouterr().out


@pytest.mark.parametrize("app", [_App(status=401), _App(status=503), _App(raise_error=True)], ids=["401", "503", "refused"])
def test_a_refused_or_failed_mirror_prints_a_notice_and_keeps_the_exit_code(monkeypatch, tmp_path, capsys, app):
    monkeypatch.setenv("RAG_ADMIN_BEARER", TOKEN)
    rc, posts = _run(monkeypatch, tmp_path, app, ["--base-url", APP])
    assert rc == 0
    assert len(posts) == 1
    assert len(app.requests) == 1
    out = capsys.readouterr()
    notices = [line for line in out.out.splitlines() if line.startswith("::notice::")]
    assert notices
    assert TOKEN not in out.out and TOKEN not in out.err
    summary = json.loads([line for line in out.out.splitlines() if line.startswith("{")][-1])
    assert summary["post_status"] == 202


def test_a_dry_run_mirrors_nothing(monkeypatch, tmp_path):
    monkeypatch.setenv("RAG_ADMIN_BEARER", TOKEN)
    app = _App()
    rc, posts = _run(monkeypatch, tmp_path, app, ["--base-url", APP, "--dry-run"])
    assert rc == 0
    assert posts == []
    assert app.requests == []


def test_mirror_batches_at_most_500_scores_per_request(monkeypatch, capsys):
    monkeypatch.setenv("RAG_ADMIN_BEARER", TOKEN)
    app = _App()
    app.install(monkeypatch)
    scores = [
        {
            "traceId": f"{n:032x}",
            "name": "faithfulness",
            "value": 0.5,
            "metadata": {"judge_model": "example/judge-model"},
        }
        for n in range(1201)
    ]
    online_judge._mirror_scores(scores, APP, "RAG_ADMIN_BEARER")
    assert [len(json.loads(request.content)["scores"]) for request in app.requests] == [500, 500, 201]
