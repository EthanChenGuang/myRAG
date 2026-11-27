import datetime as dt
import json
import re

import httpx
import pytest
from _private_runs import item
from rag_sidecar.contracts.config_change import WeeklyGatesSection

from rag_eval import gates_report, golden_set
from rag_eval.gates_report import (
    GITHUB_NOT_READ,
    GithubSource,
    collect_gates_section,
    main,
    render_gates_markdown,
)

SINCE = dt.datetime(2026, 11, 1, tzinfo=dt.UTC)
TODAY = dt.date(2026, 11, 8)
BASE = "http://app.test"
TOKEN = "placeholder-admin-token"
GH_TOKEN = "placeholder-github-token"
REPO = "example-owner/example-repo"
ACTOR_UUID = "11111111-2222-4333-8444-555555555555"
SHA_A = "a" * 64
SHA_B = "b" * 64
RELEASE_SHA = "c" * 40
GH_SHA = "d" * 40
FINGERPRINT = "e" * 64
LONG_REASON = ("The neutral sample setting was saved after a reviewed exception. " * 6).strip()
TEXT_FIELDS = ("question", "answer", "query", "content")


def record(index: int, source: str, gate_result: str, *, reason: str | None = None, release: bool = False) -> dict:
    summary: dict = {"checks": 3, "failed": 1 if gate_result == "fail" else 0, "skipped": 0, "offenders": [], "layers": {}}
    if release:
        summary.update(release_sha=RELEASE_SHA, github_actor="octo-admin")
    return {
        "id": f"00000000-0000-4000-8000-{index:012d}",
        "created_at": f"2026-11-0{2 + index % 5}T10:00:00.000Z",
        "actor": "ci" if release else ACTOR_UUID,
        "source": source,
        "changed_keys": ["RAG_SAMPLE_SWITCH"],
        "before_hash": SHA_A,
        "after_hash": SHA_B,
        "retrieval_config_hash": None,
        "gate_result": gate_result,
        "gate_summary": summary,
        "override_reason": reason[:200] if reason else None,
        "uncalibrated_cells": [],
    }


def change_records() -> list[dict]:
    return [
        record(1, "config_ui", "fail", reason=LONG_REASON),
        record(2, "config_ui", "error", reason="Saved after the check errored on a neutral sample."),
        record(3, "config_ui", "pass"),
        record(4, "config_ui", "pass"),
        record(5, "config_ui", "pass"),
        record(6, "cli", "skipped"),
        record(7, "profile_activation", "not_required"),
        record(8, "release_override", "fail", reason="Release override after a reviewed neutral exception.", release=True),
    ]


def alert(index: int, rule: str) -> dict:
    return {"id": f"00000000-0000-4000-9000-{index:012d}", "rule": rule, "status": "open"}


def eval_requests() -> list[dict]:
    return [
        {"id": "r1", "status": "skipped", "skip_reason": "no_real_set", "updated_at": "2026-11-05T00:00:00Z", "requested_at": "2026-11-05T00:00:00Z"},
        {"id": "r2", "status": "skipped", "skip_reason": "no_real_set", "updated_at": "2026-11-04T00:00:00Z", "requested_at": "2026-11-04T00:00:00Z"},
        {"id": "r3", "status": "done", "skip_reason": None, "updated_at": "2026-11-03T00:00:00Z", "requested_at": "2026-11-03T00:00:00Z"},
        {"id": "r4", "status": "skipped", "skip_reason": "no_real_set", "updated_at": "2026-10-20T00:00:00Z", "requested_at": "2026-10-20T00:00:00Z"},
    ]


class FakeApp:
    def __init__(self, *, fail: set[str] | None = None, statuses: list[dict] | None = None):
        self.fail = fail or set()
        self.seen: list[httpx.Request] = []
        self.statuses = statuses if statuses is not None else [
            {"context": "rag-release-gate", "state": "success", "description": "override by octo-admin", "created_at": "2026-11-03T09:00:00Z"},
            {"context": "rag-release-gate", "state": "success", "description": "gate passed", "created_at": "2026-11-03T08:00:00Z"},
            {"context": "other-check", "state": "success", "description": "override by someone-else", "created_at": "2026-11-03T08:00:00Z"},
        ]

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        path = request.url.path
        for name in self.fail:
            if name in path:
                return httpx.Response(503, json={"success": False})
        if request.url.host == "api.github.com":
            if path == f"/repos/{REPO}/commits":
                return httpx.Response(200, json=[{"sha": GH_SHA}])
            if path == f"/repos/{REPO}/commits/{GH_SHA}/statuses":
                return httpx.Response(200, json=self.statuses)
            return httpx.Response(404)
        if path == "/api/rag/admin/config-changes":
            return httpx.Response(200, json={"records": change_records(), "counts": {}})
        if path == "/api/rag/admin/monitor/alerts":
            alerts = [alert(1, "refusal_rate"), alert(2, "refusal_rate"), alert(3, "latency_p95")]
            return httpx.Response(200, json={"alerts": alerts, "next_cursor": None, "counts": {"open": 3}})
        if path == "/api/rag/admin/eval-run-requests":
            return httpx.Response(200, json={"requests": eval_requests(), "next_cursor": None})
        return httpx.Response(404)

    def factory(self):
        return lambda: httpx.Client(transport=httpx.MockTransport(self.handler))


def cell(language: str, status: str, recorded_at: str, fingerprint: str = FINGERPRINT) -> dict:
    payload = {
        "key": f"{fingerprint}|nightly|{language}|deepeval.faithfulness",
        "fingerprint": fingerprint,
        "role": "nightly",
        "language": language,
        "library": "deepeval",
        "metric": "faithfulness",
        "status": status,
        "reasons": [] if status == "gating" else ["n_below_minimum"],
        "kappa": 0.8,
        "accuracy": 0.9,
        "n": 120,
        "source": "seed",
        "labels_human_confirmed": True,
        "recorded_at": recorded_at,
    }
    return payload


@pytest.fixture
def calibration(tmp_path):
    path = tmp_path / "judge-calibration.json"
    other = "f" * 64
    payload = {
        "schema_version": 1,
        "cells": sorted(
            [
                cell("en", "gating", "2026-11-01T00:00:00Z"),
                cell("zh", "report_only", "2026-11-01T00:00:00Z"),
                cell("it", "gating", "2026-08-01T00:00:00Z"),
                cell("en", "gating", "2026-11-01T00:00:00Z", fingerprint=other) | {"role": "online", "key": f"{other}|online|en|deepeval.faithfulness"},
            ],
            key=lambda entry: entry["key"],
        ),
        "running_fingerprints": {"nightly": FINGERPRINT, "online": "0" * 64},
        "provenance": {"source": "calibration"},
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def drift_report(tenant_hash: str, week: str, divergence: float, state: str) -> dict:
    return {
        "week": week,
        "tenant_hash": tenant_hash,
        "divergence": divergence,
        "state": state,
        "limits": {"warn": 0.1, "alert": 0.25, "gap": 0.15},
    }


@pytest.fixture
def private_layout(private_runs_root):
    reports = private_runs_root / "reports"
    reports.mkdir()
    for tenant_hash, week, divergence, state in (
        ("0123456789abcdef", "2026-W43", 0.05, "ok"),
        ("0123456789abcdef", "2026-W44", 0.31, "alert"),
        ("fedcba9876543210", "2026-W44", 0.12, "warn"),
    ):
        (reports / f"drift-{tenant_hash}-{week}.json").write_text(json.dumps(drift_report(tenant_hash, week, divergence, state)), encoding="utf-8")
    set_dir = private_runs_root / "domain" / "0123456789abcdef"
    set_dir.mkdir(parents=True)
    items = [item("en-general-001"), item("en-general-002"), item("en-general-003")]
    (set_dir / "golden.jsonl").write_text("".join(entry.model_dump_json() + "\n" for entry in items), encoding="utf-8")
    manifest = golden_set.build_manifest("tenant-set", items, today=dt.date(2026, 7, 1))
    fresh = manifest.model_copy(
        update={"items": [manifest.items[0], manifest.items[1], manifest.items[2].model_copy(update={"last_reviewed_at": dt.date(2026, 11, 1)})]}
    )
    golden_set.write_manifest(set_dir / gates_report.SET_MANIFEST_NAME, golden_set._seal(fresh.set_id, fresh.version, fresh.items, fresh.changelog))
    return private_runs_root


def collect(app: FakeApp, private_layout, calibration, *, github: GithubSource | None = None):
    return collect_gates_section(
        SINCE,
        BASE,
        TOKEN,
        github,
        [private_layout / "domain" / "0123456789abcdef"],
        client_factory=app.factory(),
        today=TODAY,
        calibration_path=calibration,
        reports_dir=private_layout / "reports",
    )


def test_overrides_are_listed_with_capped_reasons_and_the_rest_counted(private_layout, calibration):
    result = collect(FakeApp(), private_layout, calibration)
    section = result.section
    assert isinstance(section, WeeklyGatesSection)
    assert len(section.overrides) == 2
    first = next(entry for entry in section.overrides if entry.gate_result == "fail")
    assert first.actor == ACTOR_UUID and first.changed_keys == ["RAG_SAMPLE_SWITCH"]
    assert first.before_hash == SHA_A and first.after_hash == SHA_B and first.date == "2026-11-03"
    assert first.override_reason is not None and len(first.override_reason) == 200
    counts = {(entry.source, entry.gate_result): entry.count for entry in section.change_counts}
    assert counts == {("config_ui", "pass"): 3, ("cli", "skipped"): 1, ("profile_activation", "not_required"): 1}
    assert sum(counts.values()) == 5
    [release] = section.release_overrides
    assert release.sha == RELEASE_SHA and release.github_actor == "octo-admin"
    assert result.release_sources == ("database",)


def test_github_override_statuses_on_main_are_listed_with_source_github(private_layout, calibration):
    app = FakeApp()
    result = collect(app, private_layout, calibration, github=GithubSource(repository=REPO, token=GH_TOKEN))
    github = [entry for entry, source in zip(result.section.release_overrides, result.release_sources, strict=True) if source == "github"]
    assert [(entry.sha, entry.github_actor, entry.date) for entry in github] == [(GH_SHA, "octo-admin", "2026-11-03")]
    commits = next(request for request in app.seen if request.url.path.endswith("/commits"))
    assert commits.url.params["sha"] == "main"
    assert commits.headers["authorization"] == f"Bearer {GH_TOKEN}"
    assert "github" not in result.not_read


def test_without_a_github_token_the_section_says_github_was_not_read(private_layout, calibration):
    app = FakeApp()
    result = collect(app, private_layout, calibration)
    assert result.not_read.get("github") == "no_token"
    assert not any(request.url.host == "api.github.com" for request in app.seen)
    assert GITHUB_NOT_READ in render_gates_markdown(result)


def test_alerts_judge_cells_skipped_runs_drift_and_overdue_are_counted(private_layout, calibration):
    section = collect(FakeApp(), private_layout, calibration).section
    assert section.open_alerts == {"refusal_rate": 2, "latency_p95": 1}
    assert section.judge_cells == {"gating": 1, "report_only": 1, "uncalibrated": 2}
    assert section.skipped_runs == {"no_real_set": 2}
    assert section.overdue_re_reviews == 2
    drift = {entry.tenant_hash: (entry.week, entry.state) for entry in section.drift}
    assert drift == {"0123456789abcdef": ("2026-W44", "alert"), "fedcba9876543210": ("2026-W44", "warn")}


def test_overdue_items_are_listed_per_set(private_layout, calibration):
    result = collect(FakeApp(), private_layout, calibration)
    assert result.overdue_by_set == {"tenant-set": 2}
    assert "| tenant-set | 2 |" in render_gates_markdown(result)


@pytest.mark.parametrize(
    ("failing", "block"),
    [("config-changes", "config_changes"), ("monitor/alerts", "alerts"), ("eval-run-requests", "eval_runs"), ("/commits", "github")],
)
def test_an_unreachable_source_is_marked_not_read_without_an_exception(private_layout, calibration, failing, block):
    app = FakeApp(fail={failing})
    result = collect(app, private_layout, calibration, github=GithubSource(repository=REPO, token=GH_TOKEN))
    assert block in result.not_read
    assert f"{block}: not read" in render_gates_markdown(result)


def test_a_transport_error_is_not_read_too(private_layout, calibration):
    def broken():
        def handler(request):
            raise httpx.ConnectError("unreachable", request=request)

        return httpx.Client(transport=httpx.MockTransport(handler))

    result = collect_gates_section(
        SINCE, BASE, TOKEN, None, [], client_factory=broken, today=TODAY, calibration_path=calibration, reports_dir=private_layout / "reports"
    )
    assert {"config_changes", "alerts", "eval_runs"} <= set(result.not_read)


def test_without_a_base_url_or_token_the_app_blocks_are_not_read(private_layout, calibration):
    app = FakeApp()
    result = collect_gates_section(
        SINCE, None, None, None, [], client_factory=app.factory(), today=TODAY, calibration_path=calibration, reports_dir=private_layout / "reports"
    )
    assert result.not_read["config_changes"] == "no_base_url"
    assert app.seen == []
    assert result.section.drift


def test_missing_calibration_file_is_not_read(private_layout, tmp_path):
    result = collect(FakeApp(), private_layout, tmp_path / "absent.json")
    assert "judge_cells" in result.not_read


def _keys(value):
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from _keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from _keys(child)


def test_outputs_have_no_text_fields_and_no_tokens(private_layout, calibration):
    result = collect(FakeApp(), private_layout, calibration, github=GithubSource(repository=REPO, token=GH_TOKEN))
    payload = gates_report.collection_payload(result)
    keys = set(_keys(payload))
    assert not keys & set(TEXT_FIELDS)
    markdown = render_gates_markdown(result)
    for word in TEXT_FIELDS:
        assert not re.search(rf"\b{word}\b", markdown, re.IGNORECASE)
    raw = json.dumps(payload)
    for secret in (TOKEN, GH_TOKEN):
        assert secret not in raw and secret not in markdown
    assert "markerquestiontext" not in raw and "markerquestiontext" not in markdown


def test_main_writes_the_standalone_section_privately(private_layout, calibration, monkeypatch, capsys):
    monkeypatch.setattr(gates_report, "_http_client", FakeApp().factory())
    monkeypatch.setenv("RAG_ADMIN_BEARER", TOKEN)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    code = main(["--since", "2026-11-01", "--base-url", BASE, "--calibration", str(calibration)])
    assert code == 0
    reports = private_layout / "reports"
    raw = max(reports.glob("gates-report-*.json")).read_text(encoding="utf-8")
    markdown = max(reports.glob("gates-report-*.md")).read_text(encoding="utf-8")
    payload = json.loads(raw)
    WeeklyGatesSection.model_validate(payload["gates"])
    assert payload["not_read"]["github"] == "no_token"
    assert "## Gates" in markdown
    assert TOKEN not in raw and TOKEN not in capsys.readouterr().out


def test_main_refuses_an_output_outside_the_private_directory(private_layout, calibration, tmp_path):
    outside = tmp_path / "outside"
    assert main(["--since", "2026-11-01", "--out-dir", str(outside), "--calibration", str(calibration)]) == gates_report.EXIT_PRIVATE
    assert not outside.exists()
