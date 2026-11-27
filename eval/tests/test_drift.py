import json
import random
import subprocess
from pathlib import Path

import httpx
import pytest
from rag_sidecar.contracts.judge import JudgeReport
from rag_sidecar.contracts.monitor import DriftReport, MonitorDriftBands

from rag_eval import drift
from rag_eval.draft import writer

TOKEN = "test-admin-token-placeholder"
BASE_URL = "https://app.example.test"
TENANT = "s:default"
TENANT_HASH = "0123456789abcdef"
WEEK = "2026-W48"
BANDS = MonitorDriftBands(
    jsd_warn=0.10,
    jsd_alert=0.20,
    under_covered_min_share=0.05,
    under_covered_ratio=0.5,
    gap_alert=0.15,
    min_test_items=50,
    null_percentile=0.95,
)


@pytest.fixture
def private_root(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    private = repo / "eval" / "golden" / "private"
    private.mkdir(parents=True)
    (repo / ".gitignore").write_text("eval/golden/private/\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    monkeypatch.setattr(writer, "REPO_ROOT", repo)
    monkeypatch.setattr(writer, "PRIVATE_DIR", private)
    return private


def _inputs(shares: dict[str, float], total: int = 3000, slices: list[dict] | None = None) -> dict:
    return {
        "tenant_hash": TENANT_HASH,
        "window": {"days": 30, "since": "2026-10-27T00:00:00Z", "until": "2026-11-26T00:00:00Z"},
        "total": total,
        "clusters": [{"id": cid, "n": round(share * total), "share": share} for cid, share in sorted(shares.items())],
        "slices": slices or [],
    }


def _strata(counts: dict[str, int]) -> dict:
    items = []
    for cluster, count in sorted(counts.items()):
        items.extend(
            {"item_id": f"item-{cluster}-{index:03d}", "cluster_id": cluster, "language": "en"} for index in range(count)
        )
    return {"items": items}


def _shifted() -> tuple[dict, dict]:
    production = {"c-07": 0.22, "novel": 0.40}
    production.update({f"c-0{i}": 0.38 / 6 for i in range(1, 7)})
    counts = {"c-07": 4}
    counts.update({f"c-0{i}": 16 for i in range(1, 7)})
    return _inputs(production), _strata(counts)


def _slice(name: str, mean: float | None, n: int, refusal: float | None = 0.1) -> dict:
    return {
        "slice": name,
        "online_judge": {"mean": mean, "n": n},
        "not_helpful_rate": {"value": 0.05, "count": 5, "n": 100},
        "refusal_rate": {"value": refusal, "count": 10, "n": 100},
    }


def _judge(faithfulness: float, language: float | None = None) -> JudgeReport:
    metric = {"faithfulness": {"value": faithfulness, "n": 80}}
    return JudgeReport.model_validate(
        {
            "run_id": "run-offline",
            "run_config_hash": "r" * 64,
            "judge_model": "judge-model",
            "judge_family": "family-a",
            "generator_model": "generator-model",
            "generator_family": "family-b",
            "items": [],
            "overall": metric,
            "by_language": {"en": {"faithfulness": {"value": language if language is not None else faithfulness, "n": 40}}},
            "by_category": {},
        }
    )


def _build(production, strata, **kwargs) -> DriftReport:
    return drift.build_drift_report(
        production, strata, kwargs.pop("offline", None), kwargs.pop("previous", []), BANDS, 7, week=WEEK, **kwargs
    )


def test_a_shift_towards_one_cluster_raises_the_alert_and_names_it_under_covered():
    production, strata = _shifted()
    report = _build(production, strata)
    assert report.divergence is not None and report.divergence > 0.20
    assert report.null_p95 is not None and report.divergence > report.null_p95
    assert report.state == "alert"
    states = {cluster.id: cluster.state for cluster in report.clusters}
    assert states["c-07"] == "under"
    assert states["novel"] == "under"
    c07 = next(cluster for cluster in report.clusters if cluster.id == "c-07")
    assert c07.production_share == pytest.approx(0.22)
    assert c07.test_share == pytest.approx(0.04)
    assert c07.test_items == 4
    assert report.limits.warn == 0.10 and report.limits.alert == 0.20 and report.limits.gap == 0.15


def test_sampling_noise_alone_stays_below_the_null_and_raises_nothing():
    clusters = [f"c-{i:02d}" for i in range(1, 42)]
    production = _inputs({cluster: 1 / 41 for cluster in clusters})
    rng = random.Random(11)
    counts: dict[str, int] = {}
    for cluster in rng.choices(clusters, k=70):
        counts[cluster] = counts.get(cluster, 0) + 1
    report = _build(production, _strata(counts))
    assert report.divergence is not None and report.null_p95 is not None
    assert report.divergence <= report.null_p95
    assert report.state == "ok"
    assert drift.state_and_reason(report.divergence, report.null_p95, 70, BANDS) == ("ok", "within_null")


def test_too_few_test_items_is_ok_with_a_reason():
    production, _ = _shifted()
    strata = _strata({"c-01": 20, "c-07": 10})
    report = _build(production, strata)
    assert report.state == "ok"
    assert drift.state_and_reason(report.divergence, report.null_p95, 30, BANDS) == ("ok", "insufficient_test_items")


def test_the_offline_online_gap_fails_with_enough_judgements_and_is_insufficient_without():
    production, strata = _shifted()
    production["slices"] = [_slice("all", 0.70, 60), _slice("language:en", 0.70, 10), _slice("channel:voice", 0.70, 90)]
    report = _build(production, strata, offline=_judge(0.90))
    gaps = {gap.slice: gap for gap in report.gaps}
    assert gaps["all"].offline == pytest.approx(0.90)
    assert gaps["all"].online == pytest.approx(0.70)
    assert gaps["all"].gap == pytest.approx(0.20)
    assert gaps["all"].result == "failed"
    assert gaps["language:en"].result == "insufficient_n"
    assert gaps["channel:voice"].offline is None and gaps["channel:voice"].result == "insufficient_n"


def test_a_small_gap_passes():
    production, strata = _shifted()
    production["slices"] = [_slice("all", 0.85, 200)]
    (gap,) = _build(production, strata, offline=_judge(0.90)).gaps
    assert gap.result == "passed"


def test_vote_and_refusal_rates_are_listed_side_by_side():
    production, strata = _shifted()
    production["slices"] = [_slice("all", 0.80, 60, refusal=0.12)]
    report = _build(production, strata)
    rates = {(rate.slice, rate.metric): rate for rate in report.rates}
    assert rates[("all", "refusal_rate")].online == pytest.approx(0.12)
    assert rates[("all", "refusal_rate")].online_n == 100
    assert rates[("all", "not_helpful_rate")].online == pytest.approx(0.05)


def test_the_trend_keeps_the_last_eight_earlier_weeks_in_order():
    production, strata = _shifted()
    previous = [
        DriftReport(week=f"2026-W{week:02d}", divergence=0.01 * week, state="ok", limits={"warn": 0.1, "alert": 0.2, "gap": 0.15})
        for week in range(38, 49)
    ]
    report = _build(production, strata, previous=list(reversed(previous)))
    assert [point.week for point in report.trend] == [f"2026-W{week:02d}" for week in range(40, 48)]


def _set(private: Path) -> Path:
    set_dir = private / "domain" / "tenant-a"
    set_dir.mkdir(parents=True)
    _, strata = _shifted()
    items = [
        {
            "id": entry["item_id"],
            "question": "Which colour is the abstract block?",
            "language": "en",
            "category": "no_answer",
            "answerable": False,
            "review_status": "approved",
            "provenance": "production",
            "split": "dev",
        }
        for entry in strata["items"]
    ]
    (set_dir / "golden.jsonl").write_text("".join(json.dumps(item) + "\n" for item in items), encoding="utf-8")
    (set_dir / "strata.json").write_text(json.dumps(strata), encoding="utf-8")
    return set_dir


def _mock(monkeypatch, handler):
    monkeypatch.setattr(drift, "_http_client", lambda: httpx.Client(transport=httpx.MockTransport(handler)))


def _args(set_dir: Path, *extra: str) -> list[str]:
    return ["--tenant", TENANT, "--set", str(set_dir), "--week", WEEK, *extra]


def test_main_reads_inputs_writes_private_files_and_posts_the_report(private_root, monkeypatch, capsys):
    set_dir = _set(private_root)
    production, _ = _shifted()
    posted: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        if request.method == "GET":
            assert request.url.path == "/api/rag/admin/monitor/drift-inputs"
            assert request.url.params["tenant"] == TENANT
            return httpx.Response(200, json={"success": True, **production})
        assert request.url.path == "/api/rag/admin/monitor/drift"
        posted.append(json.loads(request.content))
        return httpx.Response(200, json={"success": True, "week": WEEK, "state": "alert", "inserted": True, "alerts": {"opened": 1, "updated": 0}})

    _mock(monkeypatch, handler)
    monkeypatch.setenv("RAG_ADMIN_BEARER", TOKEN)
    assert drift.main(_args(set_dir, "--base-url", BASE_URL)) == drift.EXIT_OK

    (report_path,) = sorted((private_root / "reports").glob("drift-*.json"))
    report = DriftReport.model_validate_json(report_path.read_text(encoding="utf-8"))
    assert report.week == WEEK and report.state == "alert" and report.tenant_hash == TENANT_HASH
    shares = json.loads((set_dir / "production-shares.json").read_text(encoding="utf-8"))
    assert shares["shares"]["c-07"] == pytest.approx(0.22)
    assert posted and posted[0]["tenant"] == TENANT
    assert DriftReport.model_validate(posted[0]["report"]).divergence == report.divergence
    out = capsys.readouterr()
    assert TOKEN not in out.out + out.err
    assert "c-07" in out.out
    assert "Which colour" not in out.out + report_path.read_text(encoding="utf-8")


def test_main_without_base_url_or_token_writes_the_private_report_and_exits_zero(private_root, tmp_path, monkeypatch, capsys):
    set_dir = _set(private_root)
    production, _ = _shifted()
    inputs = private_root / "drift-inputs.json"
    inputs.write_text(json.dumps(production), encoding="utf-8")
    _mock(monkeypatch, lambda request: pytest.fail("no request without a base URL or token"))
    monkeypatch.delenv("RAG_ADMIN_BEARER", raising=False)
    assert drift.main(_args(set_dir, "--inputs", str(inputs))) == drift.EXIT_OK
    assert len(list((private_root / "reports").glob("drift-*.json"))) == 1
    assert "::notice::" in capsys.readouterr().out


def test_main_without_any_input_prints_a_notice_and_exits_zero(private_root, monkeypatch, capsys):
    set_dir = _set(private_root)
    monkeypatch.delenv("RAG_ADMIN_BEARER", raising=False)
    assert drift.main(_args(set_dir)) == drift.EXIT_OK
    assert "::notice::" in capsys.readouterr().out
    assert not (private_root / "reports").exists()


def test_main_without_a_private_set_prints_a_notice_and_exits_zero(private_root, capsys):
    assert drift.main(_args(private_root / "domain" / "missing")) == drift.EXIT_OK
    assert "::notice::" in capsys.readouterr().out


def test_main_prints_the_reason_for_too_few_items(private_root, monkeypatch, capsys):
    set_dir = _set(private_root)
    small = _strata({"c-01": 20})
    (set_dir / "strata.json").write_text(json.dumps(small), encoding="utf-8")
    production, _ = _shifted()
    inputs = private_root / "drift-inputs.json"
    inputs.write_text(json.dumps(production), encoding="utf-8")
    assert drift.main(_args(set_dir, "--inputs", str(inputs))) == drift.EXIT_OK
    assert "insufficient_test_items" in capsys.readouterr().out


def test_main_refuses_a_set_outside_the_private_directory(private_root, tmp_path, monkeypatch):
    public = tmp_path / "public-set"
    public.mkdir()
    _, strata = _shifted()
    (public / "golden.jsonl").write_text("", encoding="utf-8")
    (public / "strata.json").write_text(json.dumps(strata), encoding="utf-8")
    production, _ = _shifted()
    inputs = tmp_path / "drift-inputs.json"
    inputs.write_text(json.dumps(production), encoding="utf-8")
    assert drift.main(_args(public, "--inputs", str(inputs))) == drift.EXIT_PRIVATE
    assert not (private_root / "reports").exists()


def test_main_posts_nothing_and_reports_an_http_error_without_the_token(private_root, monkeypatch, capsys):
    set_dir = _set(private_root)
    _mock(monkeypatch, lambda request: httpx.Response(403, json={"error": "denied"}))
    monkeypatch.setenv("RAG_ADMIN_BEARER", TOKEN)
    assert drift.main(_args(set_dir, "--base-url", BASE_URL)) == drift.EXIT_API
    out = capsys.readouterr()
    assert "403" in out.err and TOKEN not in out.out + out.err


def test_the_module_uses_no_numeric_library():
    source = Path(drift.__file__).read_text(encoding="utf-8")
    for name in ("numpy", "scipy", "sklearn"):
        assert f"import {name}" not in source
