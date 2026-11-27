import json
import subprocess

import httpx
import pytest

from rag_eval import representativeness as rep
from rag_eval.draft import writer
from rag_eval.draft.writer import PrivatePathError

TOKEN = "test-admin-token-placeholder"
BASE_URL = "https://app.example.test"
TENANT = "s:default"


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


def _item(item_id: str, question: str, **overrides) -> dict:
    item = {
        "id": item_id,
        "question": question,
        "language": "en",
        "category": "no_answer",
        "answerable": False,
        "review_status": "approved",
        "provenance": "production",
        "split": "dev",
    }
    item.update(overrides)
    return item


def _write_set(directory, items) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "golden.jsonl").write_text("".join(json.dumps(i) + "\n" for i in items), encoding="utf-8")


def _set_items():
    return [
        _item("real-en-0001", "How does the neutral widget rotate? Contact sample.person@example.com"),
        _item("real-en-0002", "Which colour is the abstract block?"),
        _item("real-en-0003", "A draft question", review_status="draft"),
        _item("real-en-0004", "A test split question", split="test"),
        _item("real-en-0005", "A paraphrased question", provenance="paraphrased"),
        _item("real-it-0006", "Quale forma ha il blocco astratto?", language="it"),
    ]


def _mock(monkeypatch, handler):
    monkeypatch.setattr(rep, "_http_client", lambda: httpx.Client(transport=httpx.MockTransport(handler)))


def test_assign_writes_strata_for_gated_items_only_with_no_question_text(private_root, monkeypatch):
    set_dir = private_root / "domain" / "tenant-a"
    _write_set(set_dir, _set_items())
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/rag/admin/monitor/assign-clusters"
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        body = json.loads(request.content)
        seen.append(body)
        clusters = ["c-01", "c-02", "novel"]
        return httpx.Response(
            200,
            json={
                "success": True,
                "set_id": "11111111-1111-4111-8111-111111111111",
                "embedder": "embedder-a",
                "assignments": [
                    {"item_id": entry["item_id"], "cluster_id": clusters[index % 3]}
                    for index, entry in enumerate(body["items"])
                ],
            },
        )

    _mock(monkeypatch, handler)
    path = rep.assign(set_dir, TENANT, BASE_URL, TOKEN)

    assert path == set_dir / "strata.json"
    assert seen[0]["tenant"] == TENANT
    assert [entry["item_id"] for entry in seen[0]["items"]] == ["real-en-0001", "real-en-0002", "real-it-0006"]
    assert "sample.person@example.com" not in json.dumps(seen)
    raw = path.read_text(encoding="utf-8")
    strata = json.loads(raw)
    assert strata["items"] == [
        {"item_id": "real-en-0001", "cluster_id": "c-01", "language": "en"},
        {"item_id": "real-en-0002", "cluster_id": "c-02", "language": "en"},
        {"item_id": "real-it-0006", "cluster_id": "novel", "language": "it"},
    ]
    for item in _set_items():
        assert item["question"] not in raw
    assert TOKEN not in raw


def test_assign_masks_questions_before_sending(private_root, monkeypatch):
    set_dir = private_root / "domain" / "tenant-a"
    _write_set(set_dir, [_item("real-en-0001", "Reach me at sample.person@example.com about the block")])
    sent: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.extend(entry["question"] for entry in body["items"])
        return httpx.Response(
            200,
            json={"success": True, "set_id": "s", "embedder": "e", "assignments": [{"item_id": "real-en-0001", "cluster_id": "c-01"}]},
        )

    _mock(monkeypatch, handler)
    rep.assign(set_dir, TENANT, BASE_URL, TOKEN)
    assert sent and "sample.person@example.com" not in sent[0]
    assert sent[0] == rep.mask_text("Reach me at sample.person@example.com about the block")


def test_assign_refuses_a_set_outside_the_private_directory(private_root, tmp_path, monkeypatch):
    outside = tmp_path / "public-set"
    _write_set(outside, [_item("real-en-0001", "Which colour is the abstract block?")])
    _mock(monkeypatch, lambda request: pytest.fail("no request may leave for a public set"))
    with pytest.raises(PrivatePathError):
        rep.assign(outside, TENANT, BASE_URL, TOKEN)
    assert not (outside / "strata.json").exists()


def test_assign_http_error_carries_no_token(private_root, monkeypatch, capsys):
    set_dir = private_root / "domain" / "tenant-a"
    _write_set(set_dir, [_item("real-en-0001", "Which colour is the abstract block?")])
    _mock(monkeypatch, lambda request: httpx.Response(409, json={"success": False, "error": "no_cluster_set"}))
    monkeypatch.setenv("RAG_ADMIN_BEARER", TOKEN)
    code = rep.main(["assign", "--set", str(set_dir), "--tenant", TENANT, "--base-url", BASE_URL])
    out = capsys.readouterr()
    assert code == rep.EXIT_API
    assert TOKEN not in out.out + out.err
    assert "409" in out.err
    assert not (set_dir / "strata.json").exists()


def test_assign_without_base_url_or_token_prints_a_notice_and_exits_zero(private_root, monkeypatch, capsys):
    set_dir = private_root / "domain" / "tenant-a"
    _write_set(set_dir, [_item("real-en-0001", "Which colour is the abstract block?")])
    monkeypatch.delenv("RAG_ADMIN_BEARER", raising=False)
    code = rep.main(["assign", "--set", str(set_dir), "--tenant", TENANT])
    assert code == rep.EXIT_OK
    assert "::notice::" in capsys.readouterr().out


def _strata(counts: dict[str, int]) -> dict:
    items = []
    for cluster, count in counts.items():
        for index in range(count):
            items.append({"item_id": f"item-{cluster}-{index:03d}", "cluster_id": cluster, "language": "en"})
    return {"items": items}


def test_quotas_reports_the_cluster_outside_the_tolerance():
    strata = _strata({"c-01": 25, "c-02": 35, "c-03": 25, "c-04": 15})
    production = {"c-01": 0.40, "c-02": 0.30, "c-03": 0.20, "c-04": 0.10}
    gaps = rep.quotas(strata, production, 0.10)
    assert [gap["cluster_id"] for gap in gaps] == ["c-01"]
    assert gaps[0]["production_share"] == pytest.approx(0.40)
    assert gaps[0]["test_share"] == pytest.approx(0.25)
    assert gaps[0]["delta"] == pytest.approx(-0.15)


def test_quotas_include_a_production_cluster_with_no_test_item():
    strata = _strata({"c-01": 10})
    gaps = rep.quotas(strata, {"c-01": 0.85, "c-09": 0.15}, 0.10)
    assert [gap["cluster_id"] for gap in gaps] == ["c-01", "c-09"]


def test_weighted_score_is_the_production_weighted_mean_of_cluster_means():
    strata = {
        "items": [
            {"item_id": "a1", "cluster_id": "c-01", "language": "en"},
            {"item_id": "a2", "cluster_id": "c-01", "language": "en"},
            {"item_id": "b1", "cluster_id": "c-02", "language": "en"},
            {"item_id": "b2", "cluster_id": "c-02", "language": "en"},
            {"item_id": "b3", "cluster_id": "c-02", "language": "en"},
        ]
    }
    scores = {"a1": 1.0, "a2": 0.0, "b1": 1.0, "b2": 1.0, "b3": 1.0}
    production = {"c-01": 0.6, "c-02": 0.2, "c-03": 0.2}
    weighted = rep.weighted_score(scores, strata, production)
    assert weighted == pytest.approx((0.6 * 0.5 + 0.2 * 1.0) / 0.8)
    assert rep.uncovered_share(strata, production, scores) == pytest.approx(0.2)


def test_uncovered_share_counts_only_clusters_with_scored_items():
    strata = {"items": [{"item_id": "a1", "cluster_id": "c-01", "language": "en"}, {"item_id": "b1", "cluster_id": "c-02", "language": "en"}]}
    production = {"c-01": 0.5, "c-02": 0.5}
    assert rep.uncovered_share(strata, production, {"a1": 1.0}) == pytest.approx(0.5)
    assert rep.weighted_score({"a1": 1.0}, strata, production) == pytest.approx(1.0)
    assert rep.weighted_score({}, strata, production) is None


def test_quotas_cli_writes_the_quota_report_privately(private_root, capsys):
    set_dir = private_root / "domain" / "tenant-a"
    _write_set(set_dir, [_item("real-en-0001", "Which colour is the abstract block?")])
    (set_dir / "strata.json").write_text(json.dumps(_strata({"c-01": 25, "c-02": 75})), encoding="utf-8")
    (set_dir / "production-shares.json").write_text(json.dumps({"shares": {"c-01": 0.5, "c-02": 0.5}}), encoding="utf-8")
    code = rep.main(["quotas", "--set", str(set_dir)])
    assert code == rep.EXIT_OK
    report = json.loads((set_dir / "quota-report.json").read_text(encoding="utf-8"))
    assert report["tolerance"] == pytest.approx(0.10)
    assert [gap["cluster_id"] for gap in report["gaps"]] == ["c-01", "c-02"]
    out = capsys.readouterr().out
    assert "c-01" in out and "Which colour" not in out
