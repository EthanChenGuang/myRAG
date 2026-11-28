import hashlib
import json
import subprocess
from pathlib import Path

import httpx
import pytest
from rag_sidecar.contracts.feedback_loop import DictionaryCandidate
from rag_sidecar.contracts.golden import GoldenItem

from rag_eval import feedback_exports
from rag_eval.draft import writer
from rag_eval.feedback_exports import main
from rag_eval.golden_io import write_golden
from rag_eval.split import freeze_group_splits, group_id

TENANT = "o:11111111-2222-4333-8444-555555555555"
TENANT_HASH = hashlib.sha256(TENANT.encode()).hexdigest()[:16]
REVIEW = "a0000000-0000-4000-8000-000000000001"


def _doc_with(split: str, start: int) -> str:
    n = start
    while True:
        candidate = f"{n:08x}-0000-4000-8000-000000000000"
        if (int(hashlib.sha256(candidate.encode()).hexdigest()[:8], 16) % 100 < 70) == (split == "dev"):
            return candidate
        n += 1


TEST_DOC = _doc_with("test", 0x100)
DEV_DOC = _doc_with("dev", 0x100)
OTHER_DOC = _doc_with("dev", 0x9000)


@pytest.fixture(autouse=True)
def _no_proxy(monkeypatch):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def private_root(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    private = repo / "eval" / "golden" / "private"
    private.mkdir(parents=True)
    (repo / ".gitignore").write_text("eval/golden/private/\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    monkeypatch.setattr(writer, "REPO_ROOT", repo)
    monkeypatch.setattr(writer, "PRIVATE_DIR", private)
    monkeypatch.setattr(writer, "DEFAULT_MANIFEST", private / "split-manifest.json")
    monkeypatch.setattr(feedback_exports, "_today", lambda: "2026-11-26")
    monkeypatch.setenv("RAG_ADMIN_BEARER", "admin-token-placeholder")
    return private


def _domain_set(private: Path) -> None:
    directory = private / "domain" / TENANT_HASH
    items = [
        GoldenItem(
            id=f"prod-en-{name}",
            question=f"synthetic question {name}",
            language="en",
            category="general",
            answerable=True,
            expected_answer="a synthetic answer",
            gold_evidence=[{"document": f"{name}.md", "section": "s", "quote": "a synthetic quote", "document_id": doc}],
            review_status="approved",
            provenance="production",
            split="dev",
        )
        for name, doc in (("testdoc01", TEST_DOC), ("devdoc001", DEV_DOC))
    ]
    frozen = freeze_group_splits(items, directory / "split-manifest.json")
    assert {item.id: item.split for item in frozen} == {"prod-en-testdoc01": "test", "prod-en-devdoc001": "dev"}
    write_golden(directory / "golden.jsonl", frozen)


def _pair(document_id: str, *, split: str = "train", group: str | None = None, n: int = 1) -> dict:
    return {
        "tenant_key": TENANT,
        "query_masked": "How does the synthetic widget behave?",
        "language": "en",
        "positive": {"chunk_id": f"chunk-{n}", "document_id": document_id, "quote": "a synthetic quote"},
        "hard_negatives": [{"chunk_id": "chunk-neg", "document_id": OTHER_DOC, "rank": 1, "score": 0.5, "confirmed": True}],
        "document_group": group or hashlib.sha256(document_id.encode()).hexdigest(),
        "split": split,
        "source": "production_feedback",
        "review_item_id": f"a0000000-0000-4000-8000-{n:012x}",
    }


def _candidate() -> dict:
    return {
        "tenant_key": TENANT,
        "language": "en",
        "observed_term": "synthetic abbreviation",
        "canonical_term": "synthetic canonical term",
        "relation": "abbreviation",
        "example_review_item_ids": [REVIEW],
        "occurrences": 2,
    }


def _install(monkeypatch, lines: list, status: int = 200, seen: list | None = None) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        if status != 200:
            return httpx.Response(status, json={"error": "nope"})
        body = "".join((line if isinstance(line, str) else json.dumps(line)) + "\n" for line in lines)
        return httpx.Response(200, text=body)

    monkeypatch.setattr(feedback_exports, "_http_client", lambda: httpx.Client(transport=httpx.MockTransport(handler), timeout=5.0))


def _run(kind: str, *extra: str) -> int:
    return main(["--tenant", TENANT, "--kind", kind, "--base-url", "https://app.example.test", *extra])


def _out(private: Path, kind: str) -> Path:
    return private / "exports" / TENANT_HASH / f"{kind}-2026-11-26.jsonl"


def test_dictionary_export_writes_one_validated_line_per_record(private_root, monkeypatch, capsys):
    seen: list[httpx.Request] = []
    _install(monkeypatch, [_candidate()], seen=seen)
    assert _run("dictionary") == 0
    rows = [json.loads(line) for line in _out(private_root, "dictionary").read_text(encoding="utf-8").splitlines()]
    assert [DictionaryCandidate.model_validate(row) for row in rows] == [DictionaryCandidate.model_validate(_candidate())]
    (request,) = seen
    assert request.url.path == "/api/rag/admin/feedback-loop/export"
    assert request.url.params["kind"] == "dictionary" and request.url.params["tenant"] == TENANT
    assert request.headers["authorization"] == "Bearer admin-token-placeholder"
    out = capsys.readouterr()
    assert "admin-token-placeholder" not in out.out + out.err
    assert "synthetic abbreviation" not in out.out + out.err


def test_training_export_writes_pairs_whose_positive_is_outside_the_test_groups(private_root, monkeypatch):
    _domain_set(private_root)
    _install(monkeypatch, [_pair(DEV_DOC), _pair(TEST_DOC, split="held_out", n=2), _pair(OTHER_DOC, n=3)])
    assert _run("training") == 0
    rows = [json.loads(line) for line in _out(private_root, "training").read_text(encoding="utf-8").splitlines()]
    assert [row["split"] for row in rows] == ["train", "held_out", "train"]
    assert "a synthetic quote" not in json.dumps([row["hard_negatives"] for row in rows])


def test_a_train_pair_on_a_test_group_document_exits_two_and_writes_nothing(private_root, monkeypatch, capsys):
    _domain_set(private_root)
    _install(monkeypatch, [_pair(DEV_DOC), _pair(TEST_DOC, n=2)])
    assert _run("training") == 2
    assert not _out(private_root, "training").exists()
    assert not list((private_root / "exports").rglob("*")) or not any(p.is_file() for p in (private_root / "exports").rglob("*"))
    assert "leak" in capsys.readouterr().err


def test_a_train_pair_in_a_test_group_by_document_group_exits_two(private_root, monkeypatch):
    _domain_set(private_root)
    _install(monkeypatch, [_pair(OTHER_DOC, group=group_id(TEST_DOC))])
    assert _run("training") == 2
    assert not _out(private_root, "training").exists()


def test_an_invalid_line_exits_four_and_writes_nothing(private_root, monkeypatch):
    bad = _candidate()
    bad["relation"] = "translation"
    _install(monkeypatch, [_candidate(), bad])
    assert _run("dictionary") == 4
    assert not _out(private_root, "dictionary").exists()
    _install(monkeypatch, [_candidate(), "{not json"])
    assert _run("dictionary") == 4
    assert not _out(private_root, "dictionary").exists()


def test_a_line_of_another_tenant_exits_four(private_root, monkeypatch):
    other = _candidate()
    other["tenant_key"] = "o:99999999-2222-4333-8444-555555555555"
    _install(monkeypatch, [other])
    assert _run("dictionary") == 4
    assert not _out(private_root, "dictionary").exists()


def test_an_http_failure_exits_four_without_the_token(private_root, monkeypatch, capsys):
    _install(monkeypatch, [], status=503)
    assert _run("training") == 4
    assert "admin-token-placeholder" not in capsys.readouterr().err


def test_a_failed_rewrite_keeps_the_previous_file(private_root, monkeypatch):
    _install(monkeypatch, [_candidate()])
    assert _run("dictionary") == 0
    before = _out(private_root, "dictionary").read_bytes()
    _install(monkeypatch, ["{not json"])
    assert _run("dictionary") == 4
    assert _out(private_root, "dictionary").read_bytes() == before
    assert not [p for p in _out(private_root, "dictionary").parent.iterdir() if p.name.endswith(".tmp")]


def test_missing_token_exits_two_naming_the_variable(private_root, monkeypatch, capsys):
    seen: list[httpx.Request] = []
    _install(monkeypatch, [_candidate()], seen=seen)
    monkeypatch.delenv("RAG_ADMIN_BEARER")
    assert _run("dictionary") == 2
    assert "RAG_ADMIN_BEARER" in capsys.readouterr().err
    assert seen == []


def test_an_output_outside_the_private_directory_exits_six(private_root, monkeypatch, tmp_path, capsys):
    _install(monkeypatch, [_candidate()])
    assert _run("dictionary", "--out", str(tmp_path / "elsewhere.jsonl")) == 6
    assert "eval/golden/private" in capsys.readouterr().err


def test_an_incomplete_domain_set_exits_two(private_root, monkeypatch):
    directory = private_root / "domain" / TENANT_HASH
    directory.mkdir(parents=True)
    (directory / "golden.jsonl").write_text("", encoding="utf-8")
    _install(monkeypatch, [_pair(DEV_DOC)])
    assert _run("training") == 2


def test_an_invalid_tenant_or_kind_is_refused(private_root, monkeypatch, capsys):
    _install(monkeypatch, [])
    assert main(["--tenant", "tenant-a", "--kind", "training", "--base-url", "https://app.example.test"]) == 2
    with pytest.raises(SystemExit):
        main(["--tenant", TENANT, "--kind", "golden", "--base-url", "https://app.example.test"])
