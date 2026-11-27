import json
import subprocess

import httpx
import pytest
from rag_sidecar.contracts.release_gate import ReleaseGatePart

from rag_eval import tenant_nightly
from rag_eval.draft import writer
from rag_eval.nightly_run import NightlyOutcome
from rag_eval.review_queue import tenant_hash
from rag_eval.tenant_nightly import main

BASE_URL = "https://app.example.test"
TOKEN = "admin-placeholder-bearer"
TENANT_A = "o:11111111-1111-4111-8111-111111111111"
TENANT_B = "o:22222222-2222-4222-8222-222222222222"
REQ_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
REQ_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


def _request(request_id: str, tenant: str) -> dict:
    return {
        "id": request_id,
        "tenant_key": tenant,
        "reason": "backfill_completed",
        "ref_id": "batch-1",
        "requested_at": "2026-11-27T00:00:00Z",
        "updated_at": "2026-11-27T00:00:00Z",
        "status": "running",
        "skip_reason": None,
        "result": None,
        "checks": [],
        "counts": {},
    }


class App:
    def __init__(self, requests=None, close_status=None):
        self.claimable = (
            requests
            if requests is not None
            else [_request(REQ_A, TENANT_A), _request(REQ_B, TENANT_B)]
        )
        self.close_status = close_status or {}
        self.calls: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        if (
            request.method == "POST"
            and request.url.path == "/api/rag/admin/eval-run-requests"
        ):
            return httpx.Response(200, json={"requests": self.claimable})
        if request.method == "PATCH" and request.url.path.startswith(
            "/api/rag/admin/eval-run-requests/"
        ):
            request_id = request.url.path.rsplit("/", 1)[1]
            status = self.close_status.get(request_id, 200)
            return httpx.Response(
                status,
                json={"request": {"id": request_id}}
                if status == 200
                else {"error": "not_running"},
            )
        return httpx.Response(404)

    def claims(self) -> list[dict]:
        return [json.loads(r.content) for r in self.calls if r.method == "POST"]

    def closes(self) -> dict[str, dict]:
        return {
            r.url.path.rsplit("/", 1)[1]: json.loads(r.content)
            for r in self.calls
            if r.method == "PATCH"
        }


def _outcome(
    absolute=("passed", None), floors=("passed", None), failed=()
) -> NightlyOutcome:
    return NightlyOutcome(
        parts=(
            ReleaseGatePart(
                part="nightly_absolute", result=absolute[0], reason=absolute[1]
            ),
            ReleaseGatePart(part="judge_floors", result=floors[0], reason=floors[1]),
        ),
        counts={"items": 12, "failed_checks": len(failed)},
        failed_checks=tuple(failed),
    )


@pytest.fixture
def env(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    private = repo / "eval" / "golden" / "private"
    private.mkdir(parents=True)
    (repo / ".gitignore").write_text("eval/golden/private/\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    monkeypatch.setattr(writer, "REPO_ROOT", repo)
    monkeypatch.setattr(writer, "PRIVATE_DIR", private)
    domain_a = private / "domain" / tenant_hash(TENANT_A)
    domain_a.mkdir(parents=True)
    (domain_a / "golden.jsonl").write_text("{}\n", encoding="utf-8")
    app = App()
    monkeypatch.setattr(
        tenant_nightly,
        "_http_client",
        lambda: httpx.Client(transport=httpx.MockTransport(app.handler)),
    )
    state = {"outcome": _outcome(), "calls": []}

    def fake_nightly(golden, out_dir, **kwargs):
        state["calls"].append({"golden": golden, "out_dir": out_dir, **kwargs})
        return state["outcome"]

    monkeypatch.setattr(tenant_nightly, "_run_nightly", fake_nightly)
    monkeypatch.setenv("RAG_ADMIN_BEARER", TOKEN)
    return {"app": app, "state": state, "private": private}


def _drain(*extra) -> int:
    return main(["--drain", "--base-url", BASE_URL, *extra])


def test_without_base_url_prints_a_notice_and_sends_nothing(env, capsys):
    assert main(["--drain"]) == 0
    assert "::notice::" in capsys.readouterr().out
    assert env["app"].calls == []


def test_without_admin_token_prints_a_notice_and_sends_nothing(
    env, monkeypatch, capsys
):
    monkeypatch.delenv("RAG_ADMIN_BEARER")
    assert _drain() == 0
    assert "::notice::" in capsys.readouterr().out
    assert env["app"].calls == []


def test_drain_closes_done_and_no_real_set(env):
    assert _drain() == 0
    assert env["app"].claims() == [{"action": "claim", "limit": 5}]
    closes = env["app"].closes()
    assert closes[REQ_A] == {
        "status": "done",
        "result_summary": {
            "result": "pass",
            "failed_checks": [],
            "counts": {"items": 12, "failed_checks": 0},
        },
    }
    assert closes[REQ_B] == {"status": "skipped", "skip_reason": "no_real_set"}
    assert len(env["state"]["calls"]) == 1
    call = env["state"]["calls"][0]
    assert call["base_url"] == BASE_URL
    assert str(call["golden"]).endswith(f"domain/{tenant_hash(TENANT_A)}/golden.jsonl")
    assert "RAG_ADMIN_BEARER" in call["exclude_env"]
    assert env["private"] in call["out_dir"].parents


def test_failed_absolute_gate_closes_done_with_result_fail(env):
    env["state"]["outcome"] = _outcome(
        absolute=("failed", "false_answer_rate_exceeded"),
        failed=["false_answer_rate_exceeded"],
    )
    assert _drain() == 0
    summary = env["app"].closes()[REQ_A]
    assert summary["status"] == "done"
    assert summary["result_summary"]["result"] == "fail"
    assert summary["result_summary"]["failed_checks"] == ["false_answer_rate_exceeded"]


def test_judge_keys_missing_closes_skipped(env):
    env["state"]["outcome"] = _outcome(
        absolute=("skipped", "judge_keys_missing"),
        floors=("skipped", "judge_keys_missing"),
    )
    _drain()
    assert env["app"].closes()[REQ_A] == {
        "status": "skipped",
        "skip_reason": "judge_keys_missing",
    }


def test_internal_error_closes_failed(env):
    env["state"]["outcome"] = _outcome(
        absolute=("failed", "internal_error"),
        floors=("failed", "internal_error"),
        failed=["internal_error"],
    )
    _drain()
    summary = env["app"].closes()[REQ_A]
    assert summary["status"] == "failed"
    assert summary["result_summary"]["result"] == "error"


def test_close_409_is_logged_and_the_drain_continues(env, capsys):
    env["app"].close_status = {REQ_A: 409}
    assert _drain() == 0
    assert set(env["app"].closes()) == {REQ_A, REQ_B}
    assert "409" in capsys.readouterr().err


def test_limit_is_sent(env):
    _drain("--limit", "2")
    assert env["app"].claims() == [{"action": "claim", "limit": 2}]


def test_output_carries_ids_hashes_and_counts_only(env, capsys):
    _drain()
    captured = capsys.readouterr()
    text = captured.out + captured.err
    assert TENANT_A not in text and TENANT_B not in text
    assert TOKEN not in text
    assert REQ_A in text and tenant_hash(TENANT_A) in text


def test_rejected_claim_prints_a_notice(env, capsys, monkeypatch):
    def denied(request):
        return httpx.Response(401, json={"error": "Unauthorized"})

    monkeypatch.setattr(
        tenant_nightly,
        "_http_client",
        lambda: httpx.Client(transport=httpx.MockTransport(denied)),
    )
    assert _drain() == 0
    assert "::notice::" in capsys.readouterr().out


def test_invalid_claimed_rows_are_dropped(env):
    env["app"].claimable = [
        _request("not-a-uuid", TENANT_A),
        _request(REQ_B, "tenant-without-pattern"),
    ]
    assert _drain() == 0
    assert env["app"].closes() == {}
    assert env["state"]["calls"] == []
