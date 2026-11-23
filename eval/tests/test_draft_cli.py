import json
import shutil
import uuid
from types import SimpleNamespace

import pytest
from rag_sidecar.contracts.golden import DraftedItemBatch

from rag_eval.draft import claude_drafter, ragas_drafter
from rag_eval.draft.claude_drafter import TOOL_NAME, draft_with_claude
from rag_eval.draft.cli import main
from rag_eval.draft.config import DEFAULT_CONFIG_PATH, DraftConfig, load_draft_config
from rag_eval.draft.ragas_drafter import detect_language, draft_with_ragas, plan_buckets, rows_to_proposals
from rag_eval.draft.sources import DirectoryWorkspaceSource
from rag_eval.draft.verify import index_documents, verify_proposal
from rag_eval.golden_io import load_golden
from rag_eval.paths import REPO_ROOT

CORPUS = REPO_ROOT / "eval" / "fixtures" / "corpus"
GOOD_QUOTE = "The annual plans refund window is 45 days from the purchase date"
CATEGORIES = ("multi_turn", "compound", "exact_term", "table", "scanned", "no_answer", "general")


def _claude_item(question: str, quote: str = GOOD_QUOTE, **overrides) -> dict:
    item = {
        "question": question,
        "conversation": [],
        "language": "en",
        "category": "general",
        "answerable": True,
        "expected_answer": "45 days",
        "gold_evidence": [{"document": "refund-policy.en.md", "section": "Annual plans", "quote": quote}],
    }
    item.update(overrides)
    return item


class StubClaude:
    def __init__(self, items: list[dict] | None = None, stop_reason: str = "tool_use", add_tool_block: bool = True):
        self.items = items or []
        self.stop_reason = stop_reason
        self.add_tool_block = add_tool_block
        self.calls: list[dict] = []
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        content = []
        if self.add_tool_block:
            content.append(SimpleNamespace(type="tool_use", name=TOOL_NAME, input={"items": self.items}))
        return SimpleNamespace(stop_reason=self.stop_reason, content=content)


def _default_claude_items() -> list[dict]:
    return [
        _claude_item("What is the annual refund window?"),
        _claude_item("How many days do annual subscribers have to ask for money back?"),
        _claude_item("What is the refund window for lunar plans?", quote="The lunar plans refund window is 99 days"),
        _claude_item("what is the ANNUAL refund window"),
        _claude_item(
            "What is the CEO's favourite colour?",
            category="no_answer",
            answerable=False,
            expected_answer=None,
            gold_evidence=[],
        ),
    ]


@pytest.fixture
def private_out():
    private = REPO_ROOT / "eval" / "golden" / "private"
    private_existed = private.exists()
    stem = f"test-{uuid.uuid4().hex[:10]}"
    out = private / f"{stem}.jsonl"
    manifest = private / f"{stem}.manifest.json"
    yield out, manifest
    for path in (
        out,
        out.with_name(out.name + ".tmp"),
        out.with_suffix(".notes.json"),
        manifest,
        manifest.with_name(manifest.name + ".tmp"),
    ):
        if path.exists():
            path.unlink()
    if not private_existed and private.exists() and not any(private.iterdir()):
        shutil.rmtree(private)
        golden = private.parent
        if golden.exists() and not any(golden.iterdir()):
            golden.rmdir()


def _ragas_rows(docs) -> list[dict]:
    by_name = {doc.filename: doc for doc in docs}
    en = by_name["refund-policy.en.md"]
    zh = next(d for d in docs if d.filename.endswith(".zh.md") and "refund" in d.filename)
    it = next(d for d in docs if d.filename.endswith(".it.md") and "refund" in d.filename)
    rows = [
        {
            "user_input": "annual refund windw days??",
            "reference": "The annual plans refund window is 45 days from the purchase date.",
            "reference_contexts": [en.chunks[0]],
            "persona_name": "New employee",
            "query_style": "MISSPELLED",
            "query_length": "SHORT",
        },
        {
            "user_input": "年付套餐 退款 多久",
            "reference": zh.chunks[0],
            "reference_contexts": [zh.chunks[0]],
            "persona_name": "Non-native speaker",
            "query_style": "WEB_SEARCH_LIKE",
            "query_length": "SHORT",
        },
        {
            "user_input": "Qual è il periodo di rimborso per i piani annuali e come si richiede?",
            "reference": it.chunks[0],
            "reference_contexts": [it.chunks[0]],
            "persona_name": "Domain expert",
            "query_style": "PERFECT_GRAMMAR",
            "query_length": "LONG",
        },
        {
            "user_input": "text that maps to nothing in the workspace",
            "reference": "unmappable",
            "reference_contexts": ["This text was never in any chunk of the workspace at all."],
        },
    ]
    return rows


class StubRagas:
    def __init__(self, docs):
        self.docs = docs
        self.calls: list[dict] = []

    def __call__(self, chunks, buckets, personas):
        self.calls.append({"chunks": chunks, "buckets": buckets, "personas": personas})
        return _ragas_rows(self.docs)


def _run(argv, *, claude=None, ragas=None):
    return main(argv, claude_client=claude, ragas_generate=ragas)


def test_draft_json_validates_with_the_planned_values():
    config = load_draft_config(DEFAULT_CONFIG_PATH)
    assert isinstance(config, DraftConfig)
    assert config.claude_model == "claude-sonnet-5-5"
    assert (config.min_items, config.max_items, config.claude_share) == (50, 200, 0.5)
    assert config.languages == ["zh", "en", "it"]
    assert len(config.personas) >= 2
    assert len(set(config.ragas_styles)) >= 3


def test_claude_stub_proposals_keep_only_valid_unique_verified_items(private_out):
    out, manifest = private_out
    docs = DirectoryWorkspaceSource(CORPUS).documents()
    client = StubClaude(_default_claude_items())
    outcome = draft_with_claude(docs, 5, ["en"], client, load_draft_config())
    assert len(outcome.entries) == 5
    assert all(entry.provenance == "claude_draft" for entry in outcome.entries)
    index = index_documents(docs)
    verified = [e for e in outcome.entries if not verify_proposal(e.proposal, index)]
    assert len(verified) == 4

    from rag_eval.draft.writer import write_drafted_items

    result = write_drafted_items(verified, out, manifest_path=manifest)
    assert len(result.written) == 3 and result.duplicates == 1
    assert {item.question for item in load_golden(out)} == {
        "What is the annual refund window?",
        "How many days do annual subscribers have to ask for money back?",
        "What is the CEO's favourite colour?",
    }


def test_claude_request_names_categories_languages_and_the_real_user_mix():
    docs = DirectoryWorkspaceSource(CORPUS).documents()
    client = StubClaude([])
    draft_with_claude(docs, 60, ["zh", "en", "it"], client, load_draft_config())
    assert client.calls
    call = client.calls[0]
    text = call["system"] + json.dumps(call["messages"], ensure_ascii=False)
    for category in CATEGORIES:
        assert category in text
    for language in ("zh", "en", "it"):
        assert language in text
    for phrase in ("verbatim", "document", "section", "colloquial", "ambiguous", "no_answer"):
        assert phrase in text
    assert call["model"] == "claude-sonnet-5-5"
    assert "temperature" not in call
    assert call["tool_choice"] == {"type": "auto"}
    assert call["tools"][0]["name"] == TOOL_NAME
    assert call["tools"][0]["input_schema"] == DraftedItemBatch.model_json_schema()


def test_claude_batches_fit_the_character_budget(monkeypatch):
    docs = DirectoryWorkspaceSource(CORPUS).documents()
    config = load_draft_config().model_copy(update={"batch_chars": 6000})
    client = StubClaude([])
    draft_with_claude(docs, 60, ["en"], client, config)
    assert len(client.calls) > 1
    for call in client.calls:
        assert len(call["messages"][0]["content"]) < 6000 + 4000


def test_claude_salvages_valid_items_and_reports_invalid_ones():
    docs = DirectoryWorkspaceSource(CORPUS).documents()
    items = [_claude_item("A valid question?"), {"question": "broken item"}]
    outcome = draft_with_claude(docs, 5, ["en"], StubClaude(items), load_draft_config())
    assert len(outcome.entries) == 1 and len(outcome.rejected) == 1


def test_claude_refusal_and_missing_tool_call_are_reported_not_raised():
    docs = DirectoryWorkspaceSource(CORPUS).documents()
    config = load_draft_config()
    refused = draft_with_claude(docs, 5, ["en"], StubClaude(stop_reason="refusal", add_tool_block=False), config)
    assert refused.entries == [] and any("refus" in reason for reason in refused.rejected)
    silent = draft_with_claude(docs, 5, ["en"], StubClaude(add_tool_block=False), config)
    assert silent.entries == [] and any("tool" in reason for reason in silent.rejected)


def test_claude_drops_items_in_languages_outside_the_request():
    docs = DirectoryWorkspaceSource(CORPUS).documents()
    items = [_claude_item("question in english"), _claude_item("domanda in italiano", language="it")]
    outcome = draft_with_claude(docs, 5, ["en"], StubClaude(items), load_draft_config())
    assert [e.proposal.language for e in outcome.entries] == ["en"]
    assert len(outcome.rejected) == 1


def test_detect_language():
    assert detect_language("年付套餐的退款期限是多久？") == "zh"
    assert detect_language("Qual è il periodo di rimborso per i piani annuali e come si richiede?") == "it"
    assert detect_language("What is the refund window for annual plans?") == "en"
    assert detect_language("refund window plan") == "en"


def test_ragas_rows_become_verbatim_span_proposals_with_style_and_persona_notes():
    docs = DirectoryWorkspaceSource(CORPUS).documents()
    outcome = draft_with_ragas(docs, 40, generate_fn=StubRagas(docs))
    assert len(outcome.entries) == 3 and len(outcome.rejected) == 1
    assert [e.proposal.language for e in outcome.entries] == ["en", "zh", "it"]
    assert all(e.provenance == "ragas_generated" for e in outcome.entries)
    index = index_documents(docs)
    for entry in outcome.entries:
        assert verify_proposal(entry.proposal, index) == []
        assert entry.proposal.gold_evidence[0].section
        assert entry.proposal.category in CATEGORIES
    first = outcome.entries[0]
    assert first.proposal.gold_evidence[0].quote == GOOD_QUOTE + "."
    assert first.notes == {"drafter": "ragas", "style": "MISSPELLED", "length": "SHORT", "persona": "New employee"}


def test_ragas_generate_is_called_with_more_than_one_style_length_and_persona():
    docs = DirectoryWorkspaceSource(CORPUS).documents()
    stub = StubRagas(docs)
    draft_with_ragas(docs, 40, generate_fn=stub)
    (call,) = stub.calls
    styles = {bucket.style for bucket in call["buckets"]}
    lengths = {bucket.length for bucket in call["buckets"]}
    assert len(styles) > 1 and len(lengths) > 1
    assert {"MISSPELLED", "WEB_SEARCH_LIKE", "POOR_GRAMMAR", "PERFECT_GRAMMAR"} <= styles
    assert sum(bucket.count for bucket in call["buckets"]) == 40
    assert len(call["personas"]) >= 2
    assert call["chunks"] == [chunk for doc in docs for chunk in doc.chunks]


def test_plan_buckets_spreads_small_counts_over_distinct_styles():
    buckets = plan_buckets(5, ["A", "B", "C", "D"], ["SHORT", "LONG"])
    assert sum(b.count for b in buckets) == 5
    assert len({b.style for b in buckets}) == 4
    assert plan_buckets(0, ["A"], ["SHORT"]) == []


def test_rows_to_proposals_classifies_tables_and_exact_terms():
    docs = DirectoryWorkspaceSource(CORPUS).documents()
    specs = next(d for d in docs if d.filename == "product-specs.en.md")
    table_chunk = next(chunk for chunk in specs.chunks if chunk.count("|") >= 4)
    rows = [
        {
            "user_input": "price of the thermal probe for 1 to 9 units",
            "reference": table_chunk,
            "reference_contexts": [table_chunk],
        },
        {
            "user_input": "what does the XR-4420 do",
            "reference": specs.chunks[0],
            "reference_contexts": [specs.chunks[0]],
        },
    ]
    outcome = rows_to_proposals(rows, docs)
    assert [e.proposal.category for e in outcome.entries] == ["table", "exact_term"]


def test_pinned_synthesizer_forces_style_and_length():
    from ragas.testset.graph import Node, NodeType
    from ragas.testset.persona import Persona

    synth = ragas_drafter.build_pinned_synthesizer(llm=SimpleNamespace(), style="MISSPELLED", length="SHORT")
    scenario = synth.convert_to_scenario(
        {
            "term": "refund",
            "node": Node(type=NodeType.CHUNK, properties={"page_content": "x"}),
            "persona": Persona(name="New employee", role_description="colloquial"),
            "style": "PERFECT_GRAMMAR",
            "length": "LONG",
        }
    )
    assert scenario.style.name == "MISSPELLED" and scenario.length.name == "SHORT"


def test_cli_with_both_stubs_writes_only_verified_items_and_exits_0(private_out, capsys):
    out, manifest = private_out
    docs = DirectoryWorkspaceSource(CORPUS).documents()
    code = _run(
        ["--source", f"dir:{CORPUS}", "--out", str(out), "--n", "60", "--split-manifest", str(manifest)],
        claude=StubClaude(_default_claude_items()),
        ragas=StubRagas(docs),
    )
    assert code == 0
    items = load_golden(out)
    assert len(items) == 3 + 3
    assert {item.provenance for item in items} == {"claude_draft", "ragas_generated"}
    assert all(item.review_status == "draft" for item in items)
    assert [item.id for item in items] == sorted(item.id for item in items)
    printed = capsys.readouterr().out
    assert "drafted" in printed and "rejected" in printed and "written" in printed
    assert "annual plans refund window" not in printed
    notes = json.loads(out.with_suffix(".notes.json").read_text(encoding="utf-8"))
    assert any(note.get("style") == "MISSPELLED" for note in notes.values())


def test_cli_rerun_is_byte_identical(private_out):
    out, manifest = private_out
    docs = DirectoryWorkspaceSource(CORPUS).documents()
    argv = ["--source", f"dir:{CORPUS}", "--out", str(out), "--n", "60", "--split-manifest", str(manifest)]
    assert _run(argv, claude=StubClaude(_default_claude_items()), ragas=StubRagas(docs)) == 0
    first = out.read_bytes()
    notes_first = out.with_suffix(".notes.json").read_bytes()
    assert _run(argv, claude=StubClaude(_default_claude_items()), ragas=StubRagas(docs)) == 0
    assert out.read_bytes() == first
    assert out.with_suffix(".notes.json").read_bytes() == notes_first


@pytest.mark.parametrize("n", ["49", "201", "0"])
def test_cli_n_outside_the_range_exits_2(private_out, n):
    out, manifest = private_out
    code = _run(["--source", f"dir:{CORPUS}", "--out", str(out), "--n", n, "--split-manifest", str(manifest)], claude=StubClaude())
    assert code == 2 and not out.exists()


def test_cli_empty_workspace_exits_2_before_any_llm_call(private_out, tmp_path, capsys):
    out, manifest = private_out
    claude = StubClaude(_default_claude_items())
    ragas_calls = []
    code = _run(
        ["--source", f"dir:{tmp_path}", "--out", str(out), "--n", "60", "--split-manifest", str(manifest)],
        claude=claude,
        ragas=lambda *a: ragas_calls.append(a) or [],
    )
    assert code == 2
    assert "no documents" in capsys.readouterr().err
    assert claude.calls == [] and ragas_calls == []
    assert not out.exists()


def test_cli_missing_anthropic_key_exits_3(private_out, monkeypatch):
    out, manifest = private_out
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    code = _run(["--source", f"dir:{CORPUS}", "--out", str(out), "--n", "60", "--no-ragas", "--split-manifest", str(manifest)])
    assert code == 3 and not out.exists()


def test_cli_missing_ragas_keys_exit_3(private_out, monkeypatch):
    out, manifest = private_out
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    code = _run(["--source", f"dir:{CORPUS}", "--out", str(out), "--n", "60", "--no-claude", "--split-manifest", str(manifest)])
    assert code == 3 and not out.exists()


def test_cli_output_outside_the_private_directory_exits_6(tmp_path):
    out = tmp_path / "draft.jsonl"
    code = _run(["--source", f"dir:{CORPUS}", "--out", str(out), "--n", "60"], claude=StubClaude(_default_claude_items()))
    assert code == 6 and not out.exists()


def test_cli_supabase_source_needs_exactly_one_scope_and_credentials(private_out, monkeypatch):
    out, manifest = private_out
    base = ["--source", "supabase", "--out", str(out), "--n", "60", "--split-manifest", str(manifest)]
    assert _run(base, claude=StubClaude()) == 2
    assert _run(base + ["--org", "11111111-1111-4111-8111-111111111111", "--single-tenant"], claude=StubClaude()) == 2
    monkeypatch.delenv("NEXT_PUBLIC_SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setenv("NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE", "single-tenant")
    assert _run(base + ["--single-tenant"], claude=StubClaude()) == 3
    assert not out.exists()


@pytest.mark.parametrize("mode", [None, "multi-tenant"])
def test_cli_single_tenant_needs_single_tenant_deployment_mode(private_out, monkeypatch, capsys, mode):
    out, manifest = private_out
    monkeypatch.delenv("NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE", raising=False)
    monkeypatch.delenv("MYRAG_DEPLOYMENT_MODE", raising=False)
    if mode:
        monkeypatch.setenv("NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE", mode)
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", "https://example-project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key-not-real-0001")
    base = ["--source", "supabase", "--single-tenant", "--out", str(out), "--n", "60", "--split-manifest", str(manifest)]
    assert _run(base, claude=StubClaude()) == 2
    assert "NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE=single-tenant" in capsys.readouterr().err
    assert not out.exists()


def test_cli_scope_flags_are_refused_for_a_directory_source(private_out):
    out, manifest = private_out
    code = _run(
        ["--source", f"dir:{CORPUS}", "--org", "11111111-1111-4111-8111-111111111111", "--out", str(out), "--n", "60", "--split-manifest", str(manifest)],
        claude=StubClaude(),
    )
    assert code == 2


def test_cli_help_exits_0(capsys):
    with pytest.raises(SystemExit) as excinfo:
        main(["--help"])
    assert excinfo.value.code == 0
    assert "--source" in capsys.readouterr().out


def test_claude_module_does_not_import_the_anthropic_sdk_at_import_time():
    assert not hasattr(claude_drafter, "anthropic")


def test_ragas_evidence_is_not_attributed_to_a_short_chunk_from_another_document():
    from rag_eval.draft.ragas_drafter import _locate
    from rag_eval.draft.sources import WorkspaceDocument

    context = "Pricing table. Unit price is 159.00 dollars for 1 to 9 units of the XR-4420 thermal probe."
    doc_a = WorkspaceDocument(id="a", filename="a-heading.md", chunks=["Pricing table."])
    doc_b = WorkspaceDocument(id="b", filename="b-specs.md", chunks=[context + " Bulk orders ship in two weeks."])
    doc, chunk = _locate(context, [doc_a, doc_b])
    assert doc.id == "b" and chunk.startswith(context)

    near_whole = context.removesuffix(" thermal probe.")
    doc_c = WorkspaceDocument(id="c", filename="c.md", chunks=[near_whole])
    assert _locate(context, [doc_a, doc_c])[0].id == "c"
    assert _locate(context, [doc_a]) is None
