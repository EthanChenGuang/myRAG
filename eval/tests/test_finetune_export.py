import hashlib
import json
import os
import stat
import subprocess
import sys

import httpx
import pytest
from pydantic import ValidationError
from rag_sidecar.contracts.finetune import ExportedChunk

from rag_eval.finetune import bundle, cli, export, textnorm
from rag_eval.paths import REPO_ROOT

DOC_A = "00000000-0000-4000-8000-00000000000a"


def _chunk(**overrides) -> dict:
    row = {
        "tenant_key": "s:default",
        "document_id": DOC_A,
        "chunk_id": "chunk-1",
        "chunk_index": 0,
        "content_hash": hashlib.sha256(b"x").hexdigest(),
        "language": "en",
        "split": "train",
        "text": "A neutral synthetic sentence.",
        "token_count": 5,
        "is_golden_test_evidence": False,
    }
    row.update(overrides)
    return row


# --- cli --------------------------------------------------------------------------------------------------------


def test_cli_table_names_every_d03_python_command():
    assert cli.COMMANDS == {
        "export": "rag_eval.finetune.export:main",
        "generate": "rag_eval.finetune.generate:main",
        "filter": "rag_eval.finetune.filters:main",
        "import-mined": "rag_eval.finetune.mined:main",
        "mine": "rag_eval.finetune.miner:main",
        "kit": "rag_eval.finetune.kit:main",
        "train": "rag_eval.finetune.train:main",
        "evaluate": "rag_eval.finetune.evaluate:main",
        "card": "rag_eval.finetune.card:main",
        "prune": "rag_eval.finetune.prune:main",
        "run": "rag_eval.finetune.pipeline:main",
    }


def test_cli_unknown_command_exits_2_with_usage(capsys):
    assert cli.main(["nonexistent"]) == 2
    err = capsys.readouterr().err
    assert "usage" in err
    assert "export" in err


def test_cli_no_command_exits_2(capsys):
    assert cli.main([]) == 2
    assert "usage" in capsys.readouterr().err


def test_cli_missing_module_exits_2_not_available(capsys, monkeypatch):
    monkeypatch.setitem(cli.COMMANDS, "train", "rag_eval.finetune._no_such_module_for_test:main")
    assert cli.main(["train"]) == 2
    assert "not available in this build" in capsys.readouterr().err


def test_cli_does_not_mask_a_missing_dependency_inside_an_existing_module(tmp_path, monkeypatch):
    pkg = tmp_path / "ft_cli_probe_pkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "broken.py").write_text("import ft_cli_probe_missing_dependency\n\ndef main(argv):\n    return 0\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setitem(cli.COMMANDS, "train", "ft_cli_probe_pkg.broken:main")
    with pytest.raises(ModuleNotFoundError):
        cli.main(["train"])


def test_cli_passes_remaining_arguments_and_returns_the_exit_code(tmp_path, monkeypatch):
    pkg = tmp_path / "ft_cli_probe_ok"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "cmd.py").write_text("SEEN = []\n\ndef main(argv):\n    SEEN.append(list(argv))\n    return 7\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setitem(cli.COMMANDS, "kit", "ft_cli_probe_ok.cmd:main")
    assert cli.main(["kit", "--x", "1"]) == 7
    import ft_cli_probe_ok.cmd as probe

    assert probe.SEEN == [["--x", "1"]]


def test_cli_module_entry_point_card_not_available_in_this_build():
    result = subprocess.run(
        [sys.executable, "-m", "rag_eval.finetune", "card"], capture_output=True, text=True, check=False, cwd=REPO_ROOT / "eval"
    )
    assert result.returncode == 2
    assert "not available in this build" in result.stderr


def test_cli_module_entry_point_unknown_command():
    result = subprocess.run(
        [sys.executable, "-m", "rag_eval.finetune", "nonexistent"], capture_output=True, text=True, check=False, cwd=REPO_ROOT / "eval"
    )
    assert result.returncode == 2
    assert "usage" in result.stderr


# --- textnorm ---------------------------------------------------------------------------------------------------


def test_textnorm_normalize_nfkc_casefold_strips_space_and_punctuation():
    assert textnorm.normalize("Ｈello, 世界！ ") == "hello世界"
    assert textnorm.normalize("  What is\tthe  PERIOD?\n") == "whatistheperiod"
    assert textnorm.normalize("") == ""


def test_textnorm_char_ngrams():
    assert textnorm.char_ngrams("abcd", 3) == {"abc", "bcd"}
    assert textnorm.char_ngrams("ab", 3) == {"ab"}
    assert textnorm.char_ngrams("", 3) == set()


def test_textnorm_jaccard_and_containment():
    a, b = {"abc", "bcd"}, {"bcd", "cde"}
    assert textnorm.jaccard(a, b) == pytest.approx(1 / 3)
    assert textnorm.jaccard(a, a) == 1.0
    assert textnorm.jaccard(set(), set()) == 0.0
    assert textnorm.containment({"abc"}, a) == 1.0
    assert textnorm.containment(a, {"abc"}) == 0.5
    assert textnorm.containment(set(), a) == 0.0


# --- bundle -----------------------------------------------------------------------------------------------------


def test_bundle_new_run_dir_is_0700_and_refuses_an_existing_run(tmp_path):
    run_dir = bundle.new_run_dir(tmp_path / "out", "run-1")
    assert run_dir == tmp_path / "out" / "run-1"
    assert run_dir.is_dir()
    assert stat.S_IMODE(run_dir.stat().st_mode) == 0o700
    with pytest.raises(FileExistsError):
        bundle.new_run_dir(tmp_path / "out", "run-1")


def test_bundle_new_run_dir_refuses_a_bad_run_id(tmp_path):
    with pytest.raises(ValueError):
        bundle.new_run_dir(tmp_path, "../escape")


def test_bundle_write_jsonl_validates_and_round_trips(tmp_path):
    path = tmp_path / "chunks.jsonl"
    digest = bundle.write_jsonl(path, [_chunk(), ExportedChunk.model_validate(_chunk(chunk_id="chunk-2"))], ExportedChunk)
    assert digest == hashlib.sha256(path.read_bytes()).hexdigest()
    rows = bundle.read_jsonl(path, ExportedChunk)
    assert [row.chunk_id for row in rows] == ["chunk-1", "chunk-2"]
    assert json.loads(path.read_text().splitlines()[0])["tenant_key"] == "s:default"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_bundle_write_jsonl_is_atomic_on_an_invalid_row(tmp_path):
    path = tmp_path / "chunks.jsonl"
    bundle.write_jsonl(path, [_chunk()], ExportedChunk)
    before = path.read_bytes()
    with pytest.raises(ValidationError):
        bundle.write_jsonl(path, [_chunk(chunk_id="ok"), _chunk(split="nope")], ExportedChunk)
    assert path.read_bytes() == before
    assert sorted(os.listdir(tmp_path)) == ["chunks.jsonl"]


def test_bundle_write_jsonl_refuses_a_row_of_another_model(tmp_path):
    from rag_sidecar.contracts.finetune import RetentionConfig

    with pytest.raises(TypeError):
        bundle.write_jsonl(tmp_path / "x.jsonl", [RetentionConfig(retention_days=3)], ExportedChunk)


# --- export -----------------------------------------------------------------------------------------------------

TENANT_A = "o:00000000-0000-4000-8000-0000000000aa"
TENANT_B = "o:00000000-0000-4000-8000-0000000000bb"
FIXTURE_CORPUS = REPO_ROOT / "eval" / "fixtures" / "corpus"
FIXTURE_SENTENCE = "The annual plans refund window is 45 days from the purchase date."
A_SENTENCE = "Neutral synthetic sentence number one for tenant alpha."
B_SENTENCE = "Neutral synthetic sentence number two for tenant beta."


def _uuid(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _documents():
    return [
        {"id": _uuid(1), "tenant_key": TENANT_A, "filename": "alpha-one.en.md", "content_hash": _sha("a1"), "language": "en"},
        {"id": _uuid(2), "tenant_key": TENANT_A, "filename": "alpha-two.en.md", "content_hash": None, "language": "en"},
        {"id": _uuid(3), "tenant_key": TENANT_B, "filename": "beta-one.en.md", "content_hash": _sha("b1"), "language": "en"},
    ]


def _chunks():
    rows = []
    for n, (doc, tenant, text) in enumerate(
        [
            (_uuid(1), TENANT_A, A_SENTENCE),
            (_uuid(1), TENANT_A, "Document: alpha-one.en.md. Chunk 2 of 2. Content: A second neutral alpha sentence."),
            (_uuid(2), TENANT_A, "A third neutral alpha sentence about item four."),
            (_uuid(3), TENANT_B, B_SENTENCE),
        ],
        start=101,
    ):
        rows.append(
            {
                "id": _uuid(n),
                "document_id": doc,
                "tenant_key": tenant,
                "chunk_index": None,
                "content": text,
                "content_hash": None,
                "language": "en",
                "metadata": {},
            }
        )
    return rows


class FakeSupabase:
    """PostgREST fake: honours tenant_key, is_current, status, id=gt. and limit unless leaky=True."""

    def __init__(self, *, refuse: str | None = None, leaky: bool = False, page: int | None = None):
        self.requests: list[httpx.Request] = []
        self.refuse = refuse
        self.leaky = leaky
        self.page = page
        self.tables = {"documents": _documents(), "document_chunks": _chunks()}

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        assert request.headers["apikey"] == "service-key-placeholder"
        if path.endswith("/rpc/rag_finetune_consent_for_export"):
            body = json.loads(request.content)
            if self.refuse and self.refuse in body["p_tenant_keys"]:
                return httpx.Response(
                    403, json={"code": "42501", "message": f"consent_refused: consent of {self.refuse} does not cover x"}
                )
            return httpx.Response(200, json=body["p_tenant_keys"])
        table = path.rsplit("/", 1)[-1]
        params = dict(request.url.params)
        rows = list(self.tables[table])
        if not self.leaky:
            tenant = params["tenant_key"].removeprefix("eq.")
            rows = [row for row in rows if row["tenant_key"] == tenant]
        if "id" in params:
            after = params["id"].removeprefix("gt.")
            rows = [row for row in rows if row["id"] > after]
        rows.sort(key=lambda row: row["id"])
        limit = int(params.get("limit", "1000"))
        return httpx.Response(200, json=rows[: min(limit, self.page or limit)])

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler))

    def gets(self, table: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.method == "GET" and r.url.path.endswith("/" + table)]


@pytest.fixture
def switch_on(monkeypatch, tmp_path):
    monkeypatch.setattr(export, "ENV_LOCAL_PATH", tmp_path / "absent.env.local")
    monkeypatch.setenv("RAG_FINETUNE", "on")
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key-placeholder")


def _main(args, fake=None):
    return export.main(args, client=fake.client() if fake else None)


def test_export_refuses_with_the_switch_unset(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(export, "ENV_LOCAL_PATH", tmp_path / "absent.env.local")
    monkeypatch.delenv("RAG_FINETUNE", raising=False)
    fake = FakeSupabase()
    assert _main(["--tenant", TENANT_A, "--purpose", "private", "--out", str(tmp_path / "out")], fake) == 3
    assert "RAG_FINETUNE is off" in capsys.readouterr().err
    assert fake.requests == []
    assert not (tmp_path / "out").exists()


def test_export_reads_the_switch_from_env_local(monkeypatch, tmp_path):
    env_local = tmp_path / ".env.local"
    env_local.write_text("# comment\nRAG_FINETUNE='on'\n", encoding="utf-8")
    monkeypatch.setattr(export, "ENV_LOCAL_PATH", env_local)
    monkeypatch.delenv("RAG_FINETUNE", raising=False)
    assert export.finetune_enabled() is True
    monkeypatch.setenv("RAG_FINETUNE", "off")
    assert export.finetune_enabled() is False
    env_local.write_text("RAG_FINETUNE=off\n", encoding="utf-8")
    monkeypatch.delenv("RAG_FINETUNE", raising=False)
    assert export.finetune_enabled() is False


def test_export_without_tenant_exits_2(switch_on, tmp_path):
    fake = FakeSupabase()
    assert _main(["--purpose", "deployment", "--out", str(tmp_path / "out")], fake) == 2
    assert fake.requests == []


def test_export_private_with_two_tenants_exits_2(switch_on, tmp_path):
    fake = FakeSupabase()
    args = ["--tenant", TENANT_A, "--tenant", TENANT_B, "--purpose", "private", "--out", str(tmp_path / "out")]
    assert _main(args, fake) == 2
    assert fake.requests == []


def test_export_refuses_malformed_or_repeated_tenant_keys(switch_on, tmp_path):
    fake = FakeSupabase()
    assert _main(["--tenant", "all", "--purpose", "deployment", "--out", str(tmp_path)], fake) == 2
    assert _main(["--tenant", TENANT_A, "--tenant", TENANT_A, "--purpose", "deployment", "--out", str(tmp_path)], fake) == 2
    assert fake.requests == []


def test_export_stops_on_consent_refused_before_any_read(switch_on, tmp_path, capsys):
    fake = FakeSupabase(refuse=TENANT_B)
    out = tmp_path / "out"
    args = ["--tenant", TENANT_A, "--tenant", TENANT_B, "--purpose", "deployment", "--out", str(out), "--run-id", "r1"]
    assert _main(args, fake) == 4
    assert "consent_refused" in capsys.readouterr().err
    assert len(fake.requests) == 1
    body = json.loads(fake.requests[0].content)
    assert body == {"p_tenant_keys": [TENANT_A, TENANT_B], "p_purpose": "deployment"}
    assert not (out / "r1").exists()


def test_export_one_tenant_writes_only_that_tenant(switch_on, tmp_path, capsys):
    fake = FakeSupabase()
    out = tmp_path / "out"
    assert _main(["--tenant", TENANT_A, "--purpose", "private", "--out", str(out), "--run-id", "r-a"], fake) == 0
    assert fake.requests[0].url.path.endswith("/rpc/rag_finetune_consent_for_export")
    for request in fake.gets("documents") + fake.gets("document_chunks"):
        params = dict(request.url.params)
        assert params["tenant_key"] == f"eq.{TENANT_A}"
        assert params["is_current"] == "eq.true"
        assert params["status"] == "eq.ready"
        assert params["order"] == "id.asc"
    rows = bundle.read_jsonl(out / "r-a" / "chunks.jsonl", ExportedChunk)
    assert len(rows) == 3
    assert {row.tenant_key for row in rows} == {TENANT_A}
    assert B_SENTENCE not in (out / "r-a" / "chunks.jsonl").read_text()
    assert any(row.text == "A second neutral alpha sentence." for row in rows)
    manifest = bundle.read_manifest(out / "r-a")
    assert manifest.tenant_keys == [TENANT_A]
    assert manifest.purpose == "private"
    assert manifest.split_rule == "ft-sha256-first8hex-mod100-80-10-10"
    assert sum(manifest.chunks.values()) == 3
    assert manifest.files["chunks.jsonl"] == bundle.sha256_file(out / "r-a" / "chunks.jsonl")
    manifest_text = (out / "r-a" / "manifest.json").read_text()
    assert A_SENTENCE not in manifest_text and "neutral" not in manifest_text
    assert stat.S_IMODE((out / "r-a").stat().st_mode) == 0o700
    captured = capsys.readouterr()
    assert "neutral" not in captured.out + captured.err


def test_export_split_follows_the_document_rule(switch_on, tmp_path):
    from rag_eval.finetune.split import assign_document_split

    fake = FakeSupabase()
    out = tmp_path / "out"
    assert _main(["--tenant", TENANT_A, "--purpose", "private", "--out", str(out), "--run-id", "r-s"], fake) == 0
    rows = bundle.read_jsonl(out / "r-s" / "chunks.jsonl", ExportedChunk)
    for row in rows:
        content_hash = _sha("a1") if row.document_id == _uuid(1) else None
        assert row.split == assign_document_split(TENANT_A, row.document_id, content_hash)
        assert row.document_content_hash == content_hash


def test_export_two_tenants_keyset_pages_each_tenant(switch_on, tmp_path):
    fake = FakeSupabase(page=1)
    out = tmp_path / "out"
    args = ["--tenant", TENANT_B, "--tenant", TENANT_A, "--purpose", "deployment", "--out", str(out), "--run-id", "r-ab"]
    assert _main(args + ["--batch-rows", "1"], fake) == 0
    rows = bundle.read_jsonl(out / "r-ab" / "chunks.jsonl", ExportedChunk)
    assert sorted(row.tenant_key for row in rows) == [TENANT_A] * 3 + [TENANT_B]
    assert json.loads(fake.requests[0].content)["p_tenant_keys"] == [TENANT_A, TENANT_B]
    chunk_gets = [dict(r.url.params) for r in fake.gets("document_chunks")]
    assert any(params.get("id") == f"gt.{_uuid(101)}" for params in chunk_gets)
    assert all(params["limit"] == "1" for params in chunk_gets)
    assert bundle.read_manifest(out / "r-ab").tenant_keys == [TENANT_A, TENANT_B]


def test_export_refuses_a_row_of_another_tenant_and_writes_nothing(switch_on, tmp_path, capsys):
    fake = FakeSupabase(leaky=True)
    out = tmp_path / "out"
    assert _main(["--tenant", TENANT_A, "--purpose", "private", "--out", str(out), "--run-id", "r-leak"], fake) == 5
    assert "tenant_mismatch" in capsys.readouterr().err
    assert not (out / "r-leak").exists()
    assert [p.name for p in out.iterdir()] == [] if out.exists() else True


def test_run_export_raises_tenant_mismatch(switch_on, tmp_path):
    fake = FakeSupabase(leaky=True)
    source = export.SupabaseExportSource("http://supabase.invalid", "service-key-placeholder", client=fake.client())
    with pytest.raises(export.ExportRefused) as info:
        export.run_export(tenants=[TENANT_A], purpose="private", out=tmp_path / "out", run_id="r", source=source)
    assert info.value.code == "tenant_mismatch"


def test_export_forces_golden_test_evidence_documents_to_test(switch_on, tmp_path):
    golden_line = json.loads((REPO_ROOT / "eval" / "fixtures" / "golden.jsonl").read_text().splitlines()[0])
    golden_line.update(
        {
            "id": "en-ambiguous-990",
            "split": "test",
            "gold_evidence": [{"document": "Alpha-Two.en.md", "section": "S", "quote": "a neutral quote"}],
        }
    )
    golden = tmp_path / "golden.jsonl"
    golden.write_text(json.dumps(golden_line) + "\n", encoding="utf-8")
    fake = FakeSupabase()
    out = tmp_path / "out"
    args = ["--tenant", TENANT_A, "--purpose", "private", "--out", str(out), "--run-id", "r-g", "--golden", str(golden)]
    assert _main(args, fake) == 0
    rows = bundle.read_jsonl(out / "r-g" / "chunks.jsonl", ExportedChunk)
    forced = [row for row in rows if row.document_id == _uuid(2)]
    assert forced and all(row.split == "test" and row.is_golden_test_evidence for row in forced)
    assert all(not row.is_golden_test_evidence for row in rows if row.document_id != _uuid(2))


def test_export_fixture_mode_needs_no_http_and_hides_text(switch_on, tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("NEXT_PUBLIC_SUPABASE_URL")
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY")
    out = tmp_path / "out"
    args = ["--tenant", "s:default", "--purpose", "private", "--source-dir", str(FIXTURE_CORPUS), "--out", str(out), "--run-id", "fx"]
    assert export.main(args) == 0
    rows = bundle.read_jsonl(out / "fx" / "chunks.jsonl", ExportedChunk)
    assert rows and {row.tenant_key for row in rows} == {"s:default"}
    assert {row.language for row in rows} >= {"en", "zh", "it"}
    assert any(FIXTURE_SENTENCE in row.text for row in rows)
    assert all(row.token_count > 0 for row in rows)
    forced = {row.document_id for row in rows if row.is_golden_test_evidence}
    assert forced and all(row.split == "test" for row in rows if row.document_id in forced)
    captured = capsys.readouterr()
    assert FIXTURE_SENTENCE not in captured.out + captured.err
    assert "Lumen Valley" not in captured.out + captured.err
    again = ["--tenant", "s:default", "--purpose", "private", "--source-dir", str(FIXTURE_CORPUS), "--out", str(out), "--run-id", "fx2"]
    assert export.main(again) == 0
    assert (out / "fx2" / "chunks.jsonl").read_bytes() == (out / "fx" / "chunks.jsonl").read_bytes()


def test_export_fixture_mode_still_requires_the_switch(monkeypatch, tmp_path):
    monkeypatch.setattr(export, "ENV_LOCAL_PATH", tmp_path / "absent.env.local")
    monkeypatch.setenv("RAG_FINETUNE", "off")
    args = ["--tenant", "s:default", "--purpose", "private", "--source-dir", str(FIXTURE_CORPUS), "--out", str(tmp_path / "o")]
    assert export.main(args) == 3


def test_export_fixture_dir_outside_eval_fixtures_is_refused(switch_on, tmp_path, capsys):
    outside = tmp_path / "corpus"
    (outside / "en").mkdir(parents=True)
    (outside / "en" / "x.en.md").write_text("## H\n\nA neutral line.\n", encoding="utf-8")
    for source in [outside, REPO_ROOT / "eval" / "out", REPO_ROOT / "eval" / "fixtures" / ".." / "out"]:
        args = ["--tenant", "s:default", "--purpose", "private", "--source-dir", str(source), "--out", str(tmp_path / "o")]
        assert export.main(args) == 2
        assert "fixture_dir_refused" in capsys.readouterr().err
    assert not (tmp_path / "o").exists()


def test_export_fixture_dir_symlink_out_of_the_fixtures_root_is_refused(switch_on, tmp_path, monkeypatch, capsys):
    fixtures = tmp_path / "fixtures"
    fixtures.mkdir()
    previous_bundle = tmp_path / "out" / "finetune" / "old-run"
    (previous_bundle / "en").mkdir(parents=True)
    (previous_bundle / "en" / "x.en.md").write_text("## H\n\nA neutral line.\n", encoding="utf-8")
    (fixtures / "link").symlink_to(previous_bundle, target_is_directory=True)
    monkeypatch.setattr(export, "FIXTURES_ROOT", fixtures)
    args = ["--tenant", "s:default", "--purpose", "private", "--source-dir", str(fixtures / "link"), "--out", str(tmp_path / "o")]
    assert export.main(args) == 2
    assert "fixture_dir_refused" in capsys.readouterr().err
    (fixtures / "real").symlink_to(FIXTURE_CORPUS, target_is_directory=True)
    monkeypatch.setattr(export, "FIXTURES_ROOT", REPO_ROOT / "eval" / "fixtures")
    assert export.check_fixture_dir(FIXTURE_CORPUS) == FIXTURE_CORPUS.resolve()


def test_export_http_mode_needs_the_service_key(switch_on, monkeypatch, tmp_path, capsys):
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY")
    assert export.main(["--tenant", TENANT_A, "--purpose", "private", "--out", str(tmp_path / "o")]) == 2
    assert "SUPABASE_SERVICE_ROLE_KEY" in capsys.readouterr().err


def test_export_refuses_an_existing_run_directory(switch_on, tmp_path):
    out = tmp_path / "out"
    (out / "dup").mkdir(parents=True)
    fake = FakeSupabase()
    assert _main(["--tenant", TENANT_A, "--purpose", "private", "--out", str(out), "--run-id", "dup"], fake) == 2
    assert fake.requests == []
