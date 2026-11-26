"""Phase 5.3 D-53: paraphrased coverage variants of approved expert-written items, never in a gate population."""

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from rag_sidecar.contracts.golden import GoldenItem, GoldSpan

from rag_eval.draft import writer
from rag_eval.draft.cli import main
from rag_eval.draft.config import DEFAULT_CONFIG_PATH, load_draft_config
from rag_eval.draft.paraphrase import PARAPHRASE_STYLES, PARAPHRASE_TOOL_NAME, paraphrase_items
from rag_eval.golden_io import load_golden, write_golden
from rag_eval.metrics import ItemResult, aggregate
from rag_eval.split import document_groups, write_manifest

DOC_ONE = "d0000000-0000-4000-8000-0000000000a1"
DOC_TWO = "d0000000-0000-4000-8000-0000000000a2"


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
    return private


def _item(item_id: str, question: str, *, provenance: str, split: str, review_status: str = "approved", document_id: str | None = DOC_ONE) -> GoldenItem:
    evidence = (
        [GoldSpan(document="doc-one.md", section="Overview", quote="The widget accepts three inputs", document_id=document_id)]
        if document_id
        else []
    )
    return GoldenItem(
        id=item_id,
        question=question,
        language="en",
        category="general" if document_id else "no_answer",
        answerable=document_id is not None,
        expected_answer="Three inputs." if document_id else None,
        gold_evidence=evidence,
        review_status=review_status,
        provenance=provenance,
        split=split,
    )


PARENTS = [
    _item("prod-en-000000000001", "How many inputs does the synthetic widget accept?", provenance="production", split="dev"),
    _item("prod-en-000000000002", "What does the synthetic widget return?", provenance="human", split="test", document_id=DOC_TWO),
    _item("prod-en-000000000003", "Where is the synthetic archive kept?", provenance="historical", split="dev", document_id=None),
]
SKIPPED = [
    _item("prod-en-000000000004", "Is the synthetic widget still in draft review?", provenance="human", split="dev", review_status="draft"),
    _item("draft-en-0000000005", "What is a drafted synthetic question?", provenance="claude_draft", split="dev"),
]


def _write_set(private: Path) -> tuple[Path, Path]:
    path = private / "domain" / "set" / "golden.jsonl"
    path.parent.mkdir(parents=True)
    items = [*PARENTS, *SKIPPED]
    write_golden(path, items)
    manifest = path.parent / "split-manifest.json"
    write_manifest(manifest, {item.id: item.split for item in items})
    return path, manifest


class StubClaude:
    """Answers each call with one submit_paraphrase tool block whose question names the style it was asked for."""

    def __init__(self, question_for=None, add_tool_block: bool = True, stop_reason: str = "tool_use") -> None:
        self.calls: list[dict] = []
        self.question_for = question_for or (lambda question, style: f"{style} variant of: {question}")
        self.add_tool_block = add_tool_block
        self.stop_reason = stop_reason
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        content = kwargs["messages"][0]["content"]
        question = content.split("<question>\n", 1)[1].split("\n</question>", 1)[0]
        style = next(name for name in PARAPHRASE_STYLES if f"<style>{name}</style>" in content)
        blocks = []
        if self.add_tool_block:
            blocks.append(SimpleNamespace(type="tool_use", name=PARAPHRASE_TOOL_NAME, input={"question": self.question_for(question, style)}))
        return SimpleNamespace(stop_reason=self.stop_reason, content=blocks)


def _run(path: Path, *extra: str, client=None) -> int:
    return main(["paraphrase", "--set", str(path), "--styles", "colloquial,situation", *extra], claude_client=client or StubClaude())


def _variants(path: Path) -> list[GoldenItem]:
    return [item for item in load_golden(path) if item.provenance == "paraphrased"]


def test_paraphrase_writes_one_draft_variant_per_style_for_each_approved_expert_item(private_root, capsys):
    path, _ = _write_set(private_root)
    assert _run(path) == 0
    items = load_golden(path)
    variants = _variants(path)
    assert len(variants) == 2 * len(PARENTS)
    by_id = {item.id: item for item in items}
    groups = document_groups(items)
    seen: set[tuple[str, str]] = set()
    for variant in variants:
        (parent_tag,) = [tag for tag in variant.tags if tag.startswith("paraphrase_of:")]
        (style_tag,) = [tag for tag in variant.tags if tag.startswith("style:")]
        parent = by_id[parent_tag.split(":", 1)[1]]
        style = style_tag.split(":", 1)[1]
        seen.add((parent.id, style))
        assert variant.review_status == "draft"
        assert variant.split == parent.split
        assert groups[variant.id] == groups[parent.id]
        assert variant.gold_evidence == parent.gold_evidence
        assert (variant.language, variant.category, variant.answerable, variant.expected_answer) == (
            parent.language,
            parent.category,
            parent.answerable,
            parent.expected_answer,
        )
        assert variant.question == f"{style} variant of: {parent.question}"
    assert seen == {(parent.id, style) for parent in PARENTS for style in ("colloquial", "situation")}
    assert [item for item in items if item.provenance != "paraphrased"] == [*PARENTS, *SKIPPED]
    out = capsys.readouterr().out
    assert "6 written" in out
    assert "synthetic widget" not in out


def test_paraphrase_prompt_carries_only_the_question_and_a_neutral_style_instruction(private_root):
    path, _ = _write_set(private_root)
    client = StubClaude()
    assert _run(path, client=client) == 0
    config = load_draft_config(DEFAULT_CONFIG_PATH)
    assert len(client.calls) == 2 * len(PARENTS)
    for call in client.calls:
        assert call["model"] == config.claude_model
        assert "temperature" not in call
        assert "tool_choice" not in call
        assert [tool["name"] for tool in call["tools"]] == [PARAPHRASE_TOOL_NAME]
        content = call["messages"][0]["content"]
        question = content.split("<question>\n", 1)[1].split("\n</question>", 1)[0]
        assert question in {parent.question for parent in PARENTS}
        for forbidden in ("The widget accepts three inputs", "Three inputs.", "doc-one.md", "Overview", "prod-en-"):
            assert forbidden not in content
            assert forbidden not in call["system"]


def test_paraphrase_twice_adds_nothing_the_second_time(private_root):
    path, manifest = _write_set(private_root)
    assert _run(path) == 0
    before, manifest_before = path.read_bytes(), manifest.read_bytes()
    client = StubClaude()
    assert _run(path, client=client) == 0
    assert path.read_bytes() == before
    assert manifest.read_bytes() == manifest_before
    assert client.calls == []


def test_paraphrase_refuses_a_set_outside_the_private_directory(private_root, tmp_path, capsys):
    outside = tmp_path / "golden.jsonl"
    write_golden(outside, PARENTS)
    client = StubClaude()
    assert _run(outside, client=client) == 6
    assert client.calls == []
    assert "eval/golden/private" in capsys.readouterr().err


def test_paraphrase_refuses_an_unknown_style_with_exit_two(private_root, capsys):
    path, _ = _write_set(private_root)
    before = path.read_bytes()
    client = StubClaude()
    assert main(["paraphrase", "--set", str(path), "--styles", "colloquial,poetic"], claude_client=client) == 2
    assert path.read_bytes() == before
    assert client.calls == []
    assert "poetic" in capsys.readouterr().err


def test_paraphrase_without_the_anthropic_key_exits_three(private_root, monkeypatch):
    path, _ = _write_set(private_root)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert main(["paraphrase", "--set", str(path), "--styles", "colloquial"]) == 3


def test_paraphrase_drops_outputs_that_change_under_masking_or_repeat_the_question(private_root, capsys):
    path, _ = _write_set(private_root)

    def question_for(question: str, style: str) -> str:
        if style == "colloquial":
            return "Ask jane.doe@example.com how many inputs it takes?"
        return question

    assert _run(path, client=StubClaude(question_for=question_for)) == 0
    assert _variants(path) == []
    err = capsys.readouterr()
    assert "jane.doe" not in err.out + err.err


def test_paraphrase_items_records_a_refusal_or_a_missing_tool_call():
    outcome = paraphrase_items(PARENTS[:1], ["colloquial"], lambda question, language, style: None)
    assert outcome.entries == []
    assert outcome.rejected == ["paraphrase drafter returned nothing"]


def test_report_keeps_the_gated_population_equal_to_the_parents_and_lists_variants_as_paraphrased(private_root):
    path, _ = _write_set(private_root)
    assert _run(path) == 0
    approved_parents = [item for item in load_golden(path) if item.id in {parent.id for parent in PARENTS}]
    results = [
        ItemResult(
            item_id=item.id,
            language=item.language,
            category=item.category,
            split=item.split,
            provenance=item.provenance,
            answerable=item.answerable,
            refused=not item.answerable,
            span_count=len(item.gold_evidence),
            spans_hit_at_5=len(item.gold_evidence),
            spans_hit_at_10=len(item.gold_evidence),
            first_hit_rank=1 if item.gold_evidence else None,
        )
        for item in [*approved_parents, *_variants(path)]
    ]
    out = aggregate(results, gate_split="dev")
    dev_parents = [item for item in approved_parents if item.split == "dev" and item.answerable]
    dev_variants = [item for item in _variants(path) if item.split == "dev"]
    assert out["overall"].recall_at_5.n == len(dev_parents)
    assert out["by_provenance"]["paraphrased"].recall_at_5.n == len([item for item in dev_variants if item.answerable])
    assert out["population_exclusions"]["coverage_only"] == len(dev_variants)


def test_flat_draft_invocation_still_needs_source_and_out(capsys):
    with pytest.raises(SystemExit) as caught:
        main(["--out", "eval/golden/private/x.jsonl"])
    assert caught.value.code == 2
    assert "--source" in capsys.readouterr().err


def test_styles_are_neutral_and_named():
    assert set(PARAPHRASE_STYLES) == {"colloquial", "situation"}
    for instruction in PARAPHRASE_STYLES.values():
        assert instruction and "{" not in instruction
    assert json.dumps(PARAPHRASE_STYLES, ensure_ascii=True).isascii()
