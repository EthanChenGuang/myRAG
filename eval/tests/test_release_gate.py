import hashlib
import json
from pathlib import Path

import httpx
import pytest
from rag_sidecar.contracts.release_gate import ReleaseGatePart, ReleaseGateResult

from rag_eval import release_gate
from rag_eval.nightly_run import NightlyOutcome
from rag_eval.release_gate import main, status_for

SHA = "a" * 40
OTHER_SHA = "b" * 40
TOKEN = "ghp-placeholder-token-value"
ADMIN_TOKEN = "admin-placeholder-bearer"
REPO = "example-owner/example-repo"
EFFECTIVE = "c" * 64


def _outcome(absolute=("passed", None), floors=("passed", None), effective=EFFECTIVE) -> NightlyOutcome:
    return NightlyOutcome(
        parts=(
            ReleaseGatePart(part="nightly_absolute", result=absolute[0], reason=absolute[1]),
            ReleaseGatePart(part="judge_floors", result=floors[0], reason=floors[1]),
        ),
        report_paths={},
        counts={"items": 3},
        effective_config_hash=effective,
    )


class GitHub:
    """httpx.MockTransport double of the three GitHub endpoints and the app's config-changes route."""

    def __init__(self, check_runs=None, permission="admin", permission_status=200, status_code=201, change_status=201):
        self.check_runs = check_runs if check_runs is not None else [{"status": "completed", "conclusion": "success", "id": 1}]
        self.permission = permission
        self.permission_status = permission_status
        self.status_code = status_code
        self.change_status = change_status
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path.endswith("/check-runs"):
            return httpx.Response(200, json={"total_count": len(self.check_runs), "check_runs": self.check_runs})
        if "/collaborators/" in path:
            if self.permission_status != 200:
                return httpx.Response(self.permission_status, json={"message": "Forbidden"})
            return httpx.Response(200, json={"permission": self.permission, "role_name": self.permission})
        if "/statuses/" in path:
            return httpx.Response(self.status_code, json={"id": 1})
        if path == "/api/rag/admin/config-changes":
            return httpx.Response(self.change_status, json={"record_id": "00000000-0000-4000-8000-000000000001"})
        return httpx.Response(404)

    def bodies(self, fragment: str) -> list[dict]:
        return [json.loads(r.content) for r in self.requests if fragment in r.url.path and r.method == "POST"]


@pytest.fixture
def env(tmp_path, monkeypatch):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    for name in ("quality-gates.json", "release-gate.json", "noise.json"):
        src = Path(release_gate.REPO_ROOT) / "eval" / "config" / name
        (config_dir / name).write_bytes(src.read_bytes())
    population = config_dir / "gate-population.json"
    population.write_text(json.dumps({"min_items": 100, "mode": "legacy", "provenances": ["production", "human"]}), encoding="utf-8")
    monkeypatch.setattr(
        release_gate,
        "GATE_FILES",
        {
            "quality_gates": config_dir / "quality-gates.json",
            "release_gate": config_dir / "release-gate.json",
            "noise": config_dir / "noise.json",
        },
    )
    monkeypatch.setattr(release_gate, "RELEASE_GATE_CONFIG", config_dir / "release-gate.json")
    monkeypatch.setattr(release_gate, "GATE_POPULATION", population)
    private = tmp_path / "private"
    monkeypatch.setattr(release_gate, "PRIVATE_DOMAIN_DIR", private / "domain")
    monkeypatch.setattr(release_gate, "_git_head", lambda: SHA)
    state = {"outcome": _outcome(), "calls": []}

    def fake_nightly(golden, out_dir, **kwargs):
        state["calls"].append(kwargs)
        return state["outcome"]

    monkeypatch.setattr(release_gate, "_run_nightly", fake_nightly)
    github = GitHub()
    monkeypatch.setattr(release_gate, "_http_client", lambda: httpx.Client(transport=httpx.MockTransport(github.handler)))
    monkeypatch.setenv("GITHUB_TOKEN", TOKEN)
    monkeypatch.delenv("RAG_ADMIN_BEARER", raising=False)
    return {"tmp": tmp_path, "config": config_dir, "population": population, "private": private, "state": state, "github": github}


def _run(env, *extra) -> tuple[int, ReleaseGateResult | None]:
    out = env["tmp"] / "out"
    code = main(["run", "--sha", SHA, "--out", str(out), "--repo", REPO, *extra])
    path = out / "release-gate.json"
    return code, ReleaseGateResult.model_validate_json(path.read_text()) if path.exists() else None


def _parts(result: ReleaseGateResult) -> dict[str, tuple[str, str | None]]:
    return {part.part: (part.result, part.reason) for part in result.parts}


def test_run_refuses_a_sha_that_is_not_head(env, monkeypatch):
    monkeypatch.setattr(release_gate, "_git_head", lambda: OTHER_SHA)
    code, result = _run(env)
    assert code == 2
    assert result is None
    assert env["state"]["calls"] == []


def test_run_refuses_a_malformed_sha(env):
    assert main(["run", "--sha", "abc", "--out", str(env["tmp"] / "out")]) == 2


def test_legacy_population_all_parts_pass(env):
    code, result = _run(env)
    assert code == 0
    assert result.result == "passed"
    assert result.source == "ci"
    assert _parts(result) == {
        "nightly_absolute": ("passed", None),
        "judge_floors": ("passed", None),
        "ship_check": ("not_applicable", None),
        "pr_smoke": ("passed", None),
    }
    assert set(result.gate_file_hashes) == {"quality_gates", "release_gate", "noise"}
    expected = hashlib.sha256((env["config"] / "noise.json").read_bytes()).hexdigest()
    assert result.gate_file_hashes["noise"] == expected
    check_runs = [r for r in env["github"].requests if r.url.path.endswith("/check-runs")]
    assert check_runs and check_runs[0].url.params["check_name"] == "pr-smoke"
    assert check_runs[0].url.path == f"/repos/{REPO}/commits/{SHA}/check-runs"


def test_nightly_runs_without_the_github_token(env):
    _run(env)
    assert "GITHUB_TOKEN" in env["state"]["calls"][0]["exclude_env"]


def test_judge_keys_missing_is_skipped_not_passed(env):
    env["state"]["outcome"] = _outcome(absolute=("skipped", "judge_keys_missing"), floors=("skipped", "judge_keys_missing"))
    code, result = _run(env)
    assert code == 1
    assert result.result == "skipped"
    assert result.skip_reason == "judge_keys_missing"


def test_real_population_without_private_data_is_skipped(env):
    env["population"].write_text(json.dumps({"min_items": 100, "mode": "real", "provenances": ["production", "human"]}))
    code, result = _run(env)
    assert result.result == "skipped"
    assert result.skip_reason == "private_data_missing"
    assert _parts(result)["ship_check"] == ("skipped", "private_data_missing")


def test_absent_pr_smoke_check_run_is_skipped(env):
    env["github"].check_runs = []
    _, result = _run(env)
    assert result.result == "skipped"
    assert result.skip_reason == "pr_smoke_not_completed"


def test_in_progress_pr_smoke_is_skipped(env):
    env["github"].check_runs = [{"status": "in_progress", "conclusion": None, "id": 2}]
    _, result = _run(env)
    assert _parts(result)["pr_smoke"] == ("skipped", "pr_smoke_not_completed")


def test_failed_pr_smoke_fails(env):
    env["github"].check_runs = [{"status": "completed", "conclusion": "failure", "id": 3}]
    _, result = _run(env)
    assert result.result == "failed"
    assert _parts(result)["pr_smoke"] == ("failed", "pr_smoke_failed")


def test_no_token_never_passes_pr_smoke(env, monkeypatch):
    monkeypatch.delenv("GITHUB_TOKEN")
    _, result = _run(env)
    assert _parts(result)["pr_smoke"] == ("skipped", "pr_smoke_not_completed")
    assert env["github"].requests == []


def test_failing_absolute_gate_fails_with_its_check_names(env):
    env["state"]["outcome"] = _outcome(absolute=("failed", "false_answer_rate_exceeded"))
    code, result = _run(env)
    assert code == 1
    assert result.result == "failed"
    assert _parts(result)["nightly_absolute"] == ("failed", "false_answer_rate_exceeded")


def test_changed_gate_file_against_previous_prints_a_notice(env, capsys):
    _, first = _run(env)
    previous = env["tmp"] / "previous.json"
    previous.write_text(first.model_dump_json())
    gates = env["config"] / "quality-gates.json"
    gates.write_text(gates.read_text() + "\n")
    _, second = _run(env, "--previous", str(previous))
    assert second.changed_gate_files == ["quality_gates"]
    assert "::notice::" in capsys.readouterr().out


def _write_ship(env, *, passed=True, effective=EFFECTIVE):
    private = env["private"]
    domain = private / "domain" / "0123456789ab"
    domain.mkdir(parents=True)
    (domain / "golden.jsonl").write_text("{}\n")
    candidate = private / "candidate-report.json"
    candidate.write_text(json.dumps({"run_config_hash": "d" * 64}))
    manifest = private / "candidate-run.json"
    manifest.write_text(json.dumps({"run_config_hash": "d" * 64, "effective_config_hash": effective}))
    ship = private / "ship-check.json"
    ship.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "passed": passed,
                "reasons": [] if passed else ["target_not_improved"],
                "target_metric": "recall_at_5",
                "baseline_hash": "e" * 64,
                "candidate_hash": hashlib.sha256(candidate.read_bytes()).hexdigest(),
                "gate_population": "real",
            }
        )
    )
    env["population"].write_text(json.dumps({"min_items": 100, "mode": "real", "provenances": ["production", "human"]}))
    return ["--ship-result", str(ship), "--ship-candidate", str(candidate), "--ship-candidate-manifest", str(manifest)]


def test_real_population_passing_ship_check_with_matching_defaults(env):
    args = _write_ship(env)
    _, result = _run(env, *args)
    assert _parts(result)["ship_check"] == ("passed", None)
    assert result.result == "passed"
    assert "ship_check" in result.report_hashes


def test_real_population_ship_check_for_other_defaults_fails(env):
    args = _write_ship(env, effective="f" * 64)
    _, result = _run(env, *args)
    assert _parts(result)["ship_check"] == ("failed", "ship_check_config_mismatch")


def test_real_population_failed_ship_check_fails(env):
    args = _write_ship(env, passed=False)
    _, result = _run(env, *args)
    assert _parts(result)["ship_check"] == ("failed", "ship_check_failed")


def test_real_population_unchanged_defaults_since_release_passes(env):
    args = _write_ship(env)
    _, first = _run(env, *args)
    previous = env["tmp"] / "previous.json"
    previous.write_text(first.model_dump_json())
    _, second = _run(env, "--previous", str(previous))
    assert _parts(second)["ship_check"] == ("passed", "defaults_unchanged")
    assert second.report_hashes["ship_check"] == first.report_hashes["ship_check"]


def test_real_population_without_ship_result_is_unavailable(env):
    _write_ship(env)
    _, result = _run(env)
    assert _parts(result)["ship_check"] == ("skipped", "ship_check_unavailable")


# override


def _override(env, monkeypatch, reason="Emergency release after a reviewed incident fix", actor="octo-admin"):
    monkeypatch.setenv("OVERRIDE_REASON", reason)
    out = env["tmp"] / "override"
    code = main(["override", "--sha", SHA, "--actor", actor, "--reason-env", "OVERRIDE_REASON", "--repo", REPO, "--out", str(out)])
    path = out / "release-gate.json"
    return code, ReleaseGateResult.model_validate_json(path.read_text()) if path.exists() else None


def test_override_by_admin_writes_an_override_result(env, monkeypatch):
    code, result = _override(env, monkeypatch)
    assert code == 0
    assert result.source == "override"
    assert result.result == "passed"
    assert result.actor == "octo-admin"
    assert result.override_reason == "Emergency release after a reviewed incident fix"
    permission = [r for r in env["github"].requests if "/collaborators/" in r.url.path]
    assert permission[0].url.path == f"/repos/{REPO}/collaborators/octo-admin/permission"


def test_override_by_write_permission_is_refused(env, monkeypatch):
    env["github"].permission = "write"
    code, result = _override(env, monkeypatch)
    assert code == 3
    assert result is None


def test_override_permission_call_refused_means_not_admin(env, monkeypatch, capsys):
    env["github"].permission_status = 403
    code, result = _override(env, monkeypatch)
    assert code == 3
    assert result is None
    captured = capsys.readouterr()
    assert TOKEN not in captured.out + captured.err


def test_override_reason_length_is_checked(env, monkeypatch):
    code, result = _override(env, monkeypatch, reason="short")
    assert code == 2
    assert result is None


def test_override_transport_error_means_not_admin(env, monkeypatch):
    def broken(request):
        raise httpx.ConnectError(f"cannot reach host with {TOKEN}")

    monkeypatch.setattr(release_gate, "_http_client", lambda: httpx.Client(transport=httpx.MockTransport(broken)))
    code, _ = _override(env, monkeypatch)
    assert code == 3


# status_for and post


def _result(**overrides) -> ReleaseGateResult:
    base = {
        "sha": SHA,
        "result": "passed",
        "parts": [{"part": "nightly_absolute", "result": "passed"}],
        "source": "ci",
        "created_at": "2026-11-27T00:00:00Z",
    }
    base.update(overrides)
    return ReleaseGateResult.model_validate(base)


def test_status_for_maps_only_passed_and_override_to_success():
    assert status_for(_result())[0] == "success"
    override = _result(source="override", actor="octo-admin", override_reason="Emergency release after review")
    assert status_for(override) == ("success", "override by octo-admin")
    skipped = _result(result="skipped", skip_reason="judge_keys_missing", parts=[{"part": "judge_floors", "result": "skipped", "reason": "judge_keys_missing"}])
    assert status_for(skipped) == ("failure", "skipped: judge_keys_missing")
    failed = _result(result="failed", parts=[{"part": "nightly_absolute", "result": "failed", "reason": "x" * 150}])
    state, description = status_for(failed)
    assert state == "failure"
    assert description.startswith("failed: ")
    assert len(description) <= 100


def test_status_for_legacy_not_applicable_ship_check_passes():
    result = _result(parts=[{"part": "nightly_absolute", "result": "passed"}, {"part": "ship_check", "result": "not_applicable"}])
    assert status_for(result)[0] == "success"


def _post(env, result: ReleaseGateResult, *extra) -> int:
    path = env["tmp"] / "result.json"
    path.write_text(result.model_dump_json())
    return main(["post", "--result", str(path), "--repo", REPO, *extra])


def test_post_of_passed_sends_success(env):
    assert _post(env, _result()) == 0
    body = env["github"].bodies("/statuses/")[0]
    assert body == {"state": "success", "context": "rag-release-gate", "description": "passed"}
    request = next(r for r in env["github"].requests if "/statuses/" in r.url.path)
    assert request.url.path == f"/repos/{REPO}/statuses/{SHA}"
    assert request.headers["Authorization"] == f"Bearer {TOKEN}"


def test_post_of_skipped_sends_failure(env):
    skipped = _result(result="skipped", skip_reason="judge_keys_missing", parts=[{"part": "judge_floors", "result": "skipped", "reason": "judge_keys_missing"}])
    assert _post(env, skipped) == 0
    assert env["github"].bodies("/statuses/")[0]["state"] == "failure"
    assert env["github"].bodies("/statuses/")[0]["description"] == "skipped: judge_keys_missing"


def test_post_error_hides_the_token(env, capsys):
    env["github"].status_code = 401
    assert _post(env, _result()) != 0
    captured = capsys.readouterr()
    assert TOKEN not in captured.out + captured.err
    assert "401" in captured.err


def test_post_without_token_fails(env, monkeypatch):
    monkeypatch.delenv("GITHUB_TOKEN")
    assert _post(env, _result()) == 2
    assert env["github"].requests == []


def test_post_local_prerelease_records_the_change(env, monkeypatch):
    monkeypatch.setenv("RAG_ADMIN_BEARER", ADMIN_TOKEN)
    result = _result(source="local_prerelease")
    code = _post(env, result, "--source", "local_prerelease", "--base-url", "https://app.example.test", "--actor", "octo-admin")
    assert code == 0
    records = env["github"].bodies("/api/rag/admin/config-changes")
    assert records == [{"source": "local_prerelease", "gate_result": "pass", "release_sha": SHA, "github_actor": "octo-admin"}]
    request = next(r for r in env["github"].requests if r.url.path == "/api/rag/admin/config-changes")
    assert request.headers["Authorization"] == f"Bearer {ADMIN_TOKEN}"


def test_post_local_prerelease_without_admin_token_prints_a_notice(env, capsys):
    result = _result(source="local_prerelease")
    assert _post(env, result, "--source", "local_prerelease", "--base-url", "https://app.example.test") == 0
    assert env["github"].bodies("/api/rag/admin/config-changes") == []
    assert "::notice::" in capsys.readouterr().out


def test_post_source_must_match_the_result(env):
    assert _post(env, _result(), "--source", "local_prerelease") == 2
