"""Real-set paths of rag_eval.golden_set (Phase 5.3 D-48 to D-50): register, stale-scan --base-url and re-review over the app's
admin evidence routes, mocked with httpx.MockTransport. Sets live in a temporary file under eval/golden/private/."""

import datetime as dt
import json
import shutil
import uuid
from pathlib import Path

import httpx
import pytest
from rag_sidecar.contracts.golden import GoldenItem

from rag_eval import golden_set
from rag_eval.matching import normalize_text
from rag_eval.paths import REPO_ROOT

DAY1 = dt.date(2026, 6, 1)
TODAY = dt.date(2026, 11, 26)
BASE = "http://app.invalid"
DOC_A = "00000000-0000-4000-8000-0000000074a1"
DOC_B = "00000000-0000-4000-8000-0000000074a2"
VECTORS = REPO_ROOT / "eval" / "fixtures" / "normalize-text-vectors.json"


def _item(item_id: str, document: str = "doc-a.md", quote: str = "alpha beta gamma") -> GoldenItem:
    return GoldenItem.model_validate(
        {
            "id": item_id,
            "question": f"What does the synthetic note {item_id} state?",
            "language": "en",
            "category": "general",
            "answerable": True,
            "expected_answer": "a synthetic value",
            "gold_evidence": [{"document": document, "section": "Section one", "quote": quote}],
            "review_status": "approved",
            "provenance": "synthetic_fixture",
            "split": "dev",
        }
    )


class FakeApp:
    """Answers the three golden routes from a map of (document name -> status, document id)."""

    def __init__(self, statuses: dict[str, tuple[str, str | None]], pending: list[str] | None = None, inserted: int | None = None):
        self.statuses = statuses
        self.pending = list(pending or [])
        self.inserted = inserted
        self.requests: list[tuple[str, str, dict | None, dict]] = []
        self.registered: list[dict] = []
        self.cleared: list[str] = []
        self.re_review: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        route = request.url.path.rsplit("/golden/", 1)[-1]
        self.requests.append((request.method, route, body, dict(request.url.params)))
        assert request.headers["authorization"] == "Bearer test-token-value"
        if route == "evidence-check":
            assert len(body["spans"]) <= 500
            results = []
            for span in body["spans"]:
                status, doc = self.statuses.get(span["document"], ("document_missing", None))
                results.append({"item_id": span["item_id"], "status": status, "document_id": doc})
            return httpx.Response(200, json={"success": True, "results": results})
        if route == "register" and request.method == "GET":
            return httpx.Response(200, json={"success": True, "item_ids": self.pending, "count": len(self.pending)})
        if route == "register" and body.get("action") == "clear":
            self.cleared.extend(body["item_ids"])
            return httpx.Response(200, json={"success": True, "cleared": len(body["item_ids"])})
        if route == "register":
            self.registered.extend(body["rows"])
            return httpx.Response(200, json={"success": True, "stored": len(body["rows"]), "dropped": 0})
        if route == "re-review":
            assert len(body["items"]) <= 100
            self.re_review.extend(body["items"])
            count = len(body["items"]) if self.inserted is None else self.inserted
            return httpx.Response(200, json={"success": True, "requested": len(body["items"]), "inserted": count})
        return httpx.Response(404, json={"success": False})


@pytest.fixture
def app(monkeypatch):
    holder: dict[str, FakeApp] = {}

    def use(fake: FakeApp) -> FakeApp:
        holder["app"] = fake
        monkeypatch.setattr(golden_set, "_http_client", lambda: httpx.Client(transport=httpx.MockTransport(fake.handler)))
        return fake

    monkeypatch.setenv("RAG_ADMIN_BEARER", "test-token-value")
    return use


@pytest.fixture
def private_set():
    private = REPO_ROOT / "eval" / "golden" / "private"
    existed = private.exists()
    stem = f"test-real-{uuid.uuid4().hex[:10]}"
    golden = private / f"{stem}.jsonl"
    manifest = private / f"{stem}.manifest.json"
    private.mkdir(parents=True, exist_ok=True)
    yield golden, manifest
    for path in (golden, manifest, manifest.with_name(manifest.name + ".tmp")):
        if path.exists():
            path.unlink()
    if not existed and private.exists() and not any(private.iterdir()):
        shutil.rmtree(private)
        parent = private.parent
        if parent.exists() and not any(parent.iterdir()):
            parent.rmdir()


def _write(golden: Path, manifest_path: Path, items: list[GoldenItem], reviewed: dict[str, dt.date] | None = None) -> None:
    golden.write_text("".join(json.dumps(i.model_dump(mode="json"), ensure_ascii=False) + "\n" for i in items), encoding="utf-8")
    manifest = golden_set.build_manifest("domain-alpha", items, today=DAY1)
    if reviewed:
        entries = [e.model_copy(update={"last_reviewed_at": reviewed.get(e.id, e.last_reviewed_at)}) for e in manifest.items]
        manifest = golden_set._seal(manifest.set_id, manifest.version, entries, list(manifest.changelog))
    manifest_path.write_text(manifest.model_dump_json(indent=2) + "\n", encoding="utf-8")


def _args(golden: Path, manifest: Path, *extra: str) -> list[str]:
    return ["--golden", str(golden), "--manifest", str(manifest), "--tenant", "s:default", "--base-url", BASE, *extra]


# --- shared normalisation vectors --------------------------------------------------------------------------------


def test_normalize_text_matches_the_shared_vectors():
    vectors = json.loads(VECTORS.read_text(encoding="utf-8"))["vectors"]
    assert len(vectors) > 10
    for vector in vectors:
        assert normalize_text(vector["input"]) == vector["expected"]


# --- register ----------------------------------------------------------------------------------------------------


def test_register_sends_ids_and_hashes_and_skips_a_missing_document(private_set, app, capsys):
    golden, manifest = private_set
    _write(golden, manifest, [_item("syn-a"), _item("syn-b", document="gone.md")])
    fake = app(FakeApp({"doc-a.md": ("ok", DOC_A)}))
    assert golden_set.main(["register", *_args(golden, manifest)]) == 0
    assert fake.registered == [{"item_id": "syn-a", "document_id": DOC_A, "quote_sha256": golden_set.quote_sha256("alpha beta gamma")}]
    register_calls = [r for r in fake.requests if r[1] == "register"]
    assert register_calls[0][2]["set_id"] == "domain-alpha" and register_calls[0][2]["tenant"] == "s:default"
    out = capsys.readouterr().out
    assert "not registered: syn-b (document_missing)" in out
    assert "stored 1" in out
    assert "alpha beta gamma" not in json.dumps([r[2] for r in register_calls])


def test_register_refuses_a_set_outside_the_private_directory(tmp_path, app, capsys):
    golden = tmp_path / "golden.jsonl"
    manifest = tmp_path / "golden.manifest.json"
    _write(golden, manifest, [_item("syn-a")])
    fake = app(FakeApp({}))
    assert golden_set.main(["register", *_args(golden, manifest)]) == 2
    assert "eval/golden/private" in capsys.readouterr().err
    assert fake.requests == []


def test_register_without_a_token_exits_2_and_names_the_variable(private_set, app, monkeypatch, capsys):
    golden, manifest = private_set
    _write(golden, manifest, [_item("syn-a")])
    fake = app(FakeApp({}))
    monkeypatch.delenv("RAG_ADMIN_BEARER")
    assert golden_set.main(["register", *_args(golden, manifest)]) == 2
    err = capsys.readouterr().err
    assert "RAG_ADMIN_BEARER" in err and "test-token-value" not in err
    assert fake.requests == []


# --- stale-scan --base-url ---------------------------------------------------------------------------------------


def test_stale_scan_marks_a_superseded_flagged_item_and_changes_only_the_manifest(private_set, app, capsys):
    golden, manifest = private_set
    items = [_item("syn-a"), _item("syn-b", document="doc-b.md"), _item("syn-c", document="doc-c.md")]
    _write(golden, manifest, items)
    before = golden.read_bytes()
    fake = app(FakeApp({"doc-a.md": ("ok", DOC_A), "doc-b.md": ("document_superseded", DOC_B), "doc-c.md": ("quote_not_found", DOC_A)}, pending=["syn-b"]))
    assert golden_set.main(["stale-scan", *_args(golden, manifest, "--date", TODAY.isoformat())]) == 0
    assert golden.read_bytes() == before
    scanned = golden_set.load_manifest(manifest)
    status = {e.id: e for e in scanned.items}
    assert status["syn-a"].status == "active"
    assert (status["syn-b"].status, status["syn-b"].stale_reason, status["syn-b"].stale_since) == ("stale", "document_superseded", TODAY)
    assert (status["syn-c"].status, status["syn-c"].stale_reason) == ("stale", "quote_not_found")
    assert scanned.version == 2 and scanned.changelog[-1].stale == ["syn-b", "syn-c"]
    checks = [r[2] for r in fake.requests if r[1] == "evidence-check"]
    assert [s["item_id"] for s in checks[0]["spans"]][0] == "syn-b"
    assert fake.cleared == ["syn-b"]
    out = capsys.readouterr().out
    assert "stale: syn-b (document_superseded)" in out and "flagged 1, cleared 1, 2 newly stale" in out
    assert golden_set.verify_manifest(golden_set.load_golden_set([golden]), scanned) == []


def test_stale_scan_keeps_ok_items_and_writes_nothing(private_set, app, capsys):
    golden, manifest = private_set
    _write(golden, manifest, [_item("syn-a")])
    before = manifest.read_bytes()
    fake = app(FakeApp({"doc-a.md": ("ok", DOC_A)}, pending=["syn-a"]))
    assert golden_set.main(["stale-scan", *_args(golden, manifest)]) == 0
    assert manifest.read_bytes() == before
    assert fake.cleared == ["syn-a"]
    assert "0 newly stale" in capsys.readouterr().out


def test_a_stale_item_leaves_the_gate_until_relabel(private_set, app):
    golden, manifest = private_set
    _write(golden, manifest, [_item("syn-a"), _item("syn-b", document="doc-b.md")])
    app(FakeApp({"doc-a.md": ("ok", DOC_A), "doc-b.md": ("document_superseded", DOC_B)}, pending=["syn-b"]))
    assert golden_set.main(["stale-scan", *_args(golden, manifest)]) == 0
    active = {e.id for e in golden_set.load_manifest(manifest).items if e.status == "active"}
    assert active == {"syn-a"}
    base = ["--golden", str(golden), "--manifest", str(manifest)]
    assert golden_set.main(["relabel", *base, "--id", "syn-b"]) == 0
    assert {e.id for e in golden_set.load_manifest(manifest).items if e.status == "active"} == {"syn-a", "syn-b"}


def test_stale_scan_without_a_tenant_or_outside_private_is_refused(tmp_path, private_set, app, capsys):
    golden, manifest = private_set
    _write(golden, manifest, [_item("syn-a")])
    fake = app(FakeApp({}))
    assert golden_set.main(["stale-scan", "--golden", str(golden), "--manifest", str(manifest), "--base-url", BASE]) == 2
    assert "--tenant" in capsys.readouterr().err
    other_golden, other_manifest = tmp_path / "g.jsonl", tmp_path / "g.manifest.json"
    _write(other_golden, other_manifest, [_item("syn-a")])
    assert golden_set.main(["stale-scan", *_args(other_golden, other_manifest)]) == 2
    assert fake.requests == []
