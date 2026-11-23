import json
import shutil
import uuid

import pytest
from rag_sidecar.contracts.golden import DraftedItemProposal, GoldenItem, GoldSpan

from rag_eval.draft import writer
from rag_eval.draft.verify import verify_proposal
from rag_eval.draft.writer import DraftedEntry, PrivatePathError, write_drafted_items
from rag_eval.golden_io import load_golden
from rag_eval.matching import normalize_text
from rag_eval.paths import REPO_ROOT
from rag_eval.split import assign_split, load_manifest, write_manifest

DOCS = {"refund-policy.en.md": ["The annual plans refund window is 45 days from the purchase date.", "Exceptions apply to damaged devices."]}


def _proposal(question: str, quote: str = "The annual plans refund window is 45 days", **overrides) -> DraftedItemProposal:
    fields = dict(
        question=question,
        language="en",
        category="general",
        answerable=True,
        expected_answer="45 days",
        gold_evidence=[GoldSpan(document="refund-policy.en.md", section="Annual plans", quote=quote)],
    )
    fields.update(overrides)
    return DraftedItemProposal(**fields)


def _entry(question: str, provenance: str = "claude_draft", notes: dict | None = None, **overrides) -> DraftedEntry:
    return DraftedEntry(proposal=_proposal(question, **overrides), provenance=provenance, notes=notes or {})


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


def test_verify_accepts_a_verbatim_quote_and_matches_case_insensitively():
    assert verify_proposal(_proposal("q one"), DOCS) == []
    span = GoldSpan(document="REFUND-policy.en.md", section="s", quote="the annual plans refund window is 45 days")
    assert verify_proposal(_proposal("q two", gold_evidence=[span]), DOCS) == []


def test_verify_rejects_a_quote_not_in_any_chunk_of_the_named_document():
    problems = verify_proposal(_proposal("q", quote="The refund window is 90 days"), DOCS)
    assert len(problems) == 1 and "not found" in problems[0]
    other = {"refund-policy.en.md": ["x"], "b.md": ["The annual plans refund window is 45 days from the purchase date."]}
    assert verify_proposal(_proposal("q"), other)


def test_verify_rejects_a_span_naming_an_unknown_document():
    span = GoldSpan(document="missing.md", section="s", quote="anything here")
    problems = verify_proposal(_proposal("q", gold_evidence=[span]), DOCS)
    assert len(problems) == 1 and "unknown document" in problems[0]


def test_verify_reports_a_quote_that_normalizes_to_nothing():
    span = GoldSpan(document="refund-policy.en.md", section="s", quote="..")
    problems = verify_proposal(_proposal("q", gold_evidence=[span]), DOCS)
    assert len(problems) == 1 and "no text" in problems[0]


def test_write_refuses_a_path_outside_the_private_directory(tmp_path):
    out = tmp_path / "draft.jsonl"
    with pytest.raises(PrivatePathError):
        write_drafted_items([_entry("question one")], out)
    assert not out.exists()
    with pytest.raises(PrivatePathError):
        write_drafted_items([_entry("question one")], REPO_ROOT / "eval" / "fixtures" / "draft.jsonl")
    assert not (REPO_ROOT / "eval" / "fixtures" / "draft.jsonl").exists()


def test_write_refuses_traversal_out_of_the_private_directory():
    sneaky = REPO_ROOT / "eval" / "golden" / "private" / ".." / "leak.jsonl"
    with pytest.raises(PrivatePathError):
        write_drafted_items([_entry("question one")], sneaky)
    assert not (REPO_ROOT / "eval" / "golden" / "leak.jsonl").exists()


def test_write_accepts_an_ignored_private_path(private_out):
    out, manifest = private_out
    result = write_drafted_items([_entry("What is the annual refund window?")], out, manifest_path=manifest)
    assert out.exists() and len(result.written) == 1
    items = load_golden(out)
    assert items[0].review_status == "draft" and items[0].provenance == "claude_draft"
    assert items[0].id.startswith("draft-en-") and len(items[0].id) == len("draft-en-") + 10


def test_write_refuses_when_a_file_under_the_private_directory_is_tracked(private_out, monkeypatch):
    out, manifest = private_out
    real = writer._run_git

    def fake(args):
        if args[0] == "ls-files":
            return 0, "eval/golden/private/leaked.jsonl\n"
        return real(args)

    monkeypatch.setattr(writer, "_run_git", fake)
    with pytest.raises(PrivatePathError, match="tracked"):
        write_drafted_items([_entry("question one")], out, manifest_path=manifest)
    assert not out.exists()


def test_write_refuses_when_the_path_is_not_ignored(private_out, monkeypatch):
    out, manifest = private_out
    real = writer._run_git

    def fake(args):
        if args[0] == "check-ignore":
            return 1, ""
        return real(args)

    monkeypatch.setattr(writer, "_run_git", fake)
    with pytest.raises(PrivatePathError, match="ignored"):
        write_drafted_items([_entry("question one")], out, manifest_path=manifest)
    assert not out.exists()


def test_write_refuses_when_git_cannot_answer(private_out, monkeypatch):
    out, manifest = private_out
    monkeypatch.setattr(writer, "_run_git", lambda args: (128, ""))
    with pytest.raises(PrivatePathError):
        write_drafted_items([_entry("question one")], out, manifest_path=manifest)
    assert not out.exists()


def test_duplicate_questions_are_skipped_against_earlier_and_existing_items(private_out):
    out, manifest = private_out
    first = write_drafted_items(
        [_entry("What is the annual refund window?"), _entry("what is the ANNUAL refund window")],
        out,
        manifest_path=manifest,
    )
    assert len(first.written) == 1 and first.duplicates == 1
    existing = load_golden(out)
    second = write_drafted_items(
        [_entry("What is the annual refund window?!"), _entry("How long do I have to ask for a refund?")],
        out,
        existing_items=existing,
        manifest_path=manifest,
    )
    assert len(second.written) == 1 and second.duplicates == 1
    assert len(load_golden(out)) == 2


def test_ids_come_from_the_normalized_question_and_splits_are_frozen(private_out):
    out, manifest = private_out
    question = "What is the annual refund window?"
    import hashlib

    digest = hashlib.sha256(normalize_text(question).encode()).hexdigest()[:10]
    expected_id = f"draft-en-{digest}"
    opposite = "test" if assign_split(expected_id) == "dev" else "dev"
    write_manifest(manifest, {expected_id: opposite})
    write_drafted_items([_entry(question)], out, manifest_path=manifest)
    item = load_golden(out)[0]
    assert item.id == expected_id
    assert item.split == opposite
    assert load_manifest(manifest)[expected_id] == opposite


def test_new_ids_use_the_frozen_hash_rule_and_enter_the_manifest(private_out):
    out, manifest = private_out
    write_drafted_items([_entry(f"question number {n}") for n in range(12)], out, manifest_path=manifest)
    items = load_golden(out)
    recorded = load_manifest(manifest)
    assert set(recorded) == {item.id for item in items}
    for item in items:
        assert item.split == assign_split(item.id) == recorded[item.id]


def test_output_is_sorted_by_id_and_byte_identical_on_rerun(private_out):
    out, manifest = private_out
    entries = [_entry(f"question number {n}", notes={"drafter": "claude"}) for n in (5, 3, 9, 1)]
    write_drafted_items(entries, out, manifest_path=manifest)
    first = out.read_bytes()
    ids = [json.loads(line)["id"] for line in first.decode().splitlines()]
    assert ids == sorted(ids)
    write_drafted_items(entries, out, existing_items=load_golden(out), manifest_path=manifest)
    assert out.read_bytes() == first
    out.unlink()
    write_drafted_items(list(reversed(entries)), out, manifest_path=manifest)
    assert out.read_bytes() == first


def test_invalid_items_are_rejected_not_written(private_out):
    out, manifest = private_out
    bad = _entry("no evidence question", gold_evidence=[])
    good = _entry("a good question")
    result = write_drafted_items([bad, good], out, manifest_path=manifest)
    assert len(result.written) == 1 and len(result.invalid) == 1
    assert [item.question for item in load_golden(out)] == ["a good question"]


def test_no_answer_items_need_no_evidence_and_keep_provenance(private_out):
    out, manifest = private_out
    proposal = DraftedItemProposal(
        question="What is the CEO's favourite colour?",
        language="en",
        category="no_answer",
        answerable=False,
    )
    write_drafted_items([DraftedEntry(proposal=proposal, provenance="ragas_generated")], out, manifest_path=manifest)
    item = load_golden(out)[0]
    assert isinstance(item, GoldenItem) and item.provenance == "ragas_generated" and not item.gold_evidence


def test_notes_sidecar_records_style_and_persona_next_to_the_output(private_out):
    out, manifest = private_out
    entry = _entry("misspeled refnd windw?", provenance="ragas_generated", notes={"style": "MISSPELLED", "persona": "New employee"})
    write_drafted_items([entry], out, manifest_path=manifest)
    notes = json.loads(out.with_suffix(".notes.json").read_text(encoding="utf-8"))
    (only,) = notes.values()
    assert only == {"persona": "New employee", "style": "MISSPELLED"}


def test_nothing_is_written_when_there_are_no_valid_items(private_out):
    out, manifest = private_out
    result = write_drafted_items([_entry("no evidence", gold_evidence=[])], out, manifest_path=manifest)
    assert result.written == [] and not out.exists()


def test_a_reviewer_edited_question_does_not_abort_the_next_run(private_out):
    out, manifest = private_out
    original = "What is the annual refund window?"
    first = write_drafted_items([_entry(original)], out, manifest_path=manifest)
    assert len(first.written) == 1
    edited = [item.model_copy(update={"question": "What is the refund window for annual plans?"}) for item in load_golden(out)]
    result = write_drafted_items(
        [_entry(original), _entry("How long do I have to ask for a refund?")],
        out,
        existing_items=edited,
        manifest_path=manifest,
    )
    assert result.duplicates == 1 and len(result.written) == 1
    questions = sorted(item.question for item in load_golden(out))
    assert questions == ["How long do I have to ask for a refund?", "What is the refund window for annual plans?"]
