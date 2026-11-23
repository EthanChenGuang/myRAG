import hashlib
import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.golden import DraftedItemProposal, GoldenItem

from rag_eval.golden_io import write_golden
from rag_eval.matching import normalize_text
from rag_eval.paths import REPO_ROOT
from rag_eval.split import assign_split, freeze_splits, load_manifest

PRIVATE_DIR = REPO_ROOT / "eval" / "golden" / "private"
DEFAULT_MANIFEST = PRIVATE_DIR / "split-manifest.json"
_PRIVATE_REL = "eval/golden/private"


class PrivatePathError(RuntimeError):
    pass


class DraftedEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    proposal: DraftedItemProposal
    provenance: Literal["claude_draft", "ragas_generated"]
    notes: dict[str, str] = Field(default_factory=dict)


@dataclass
class WriteResult:
    written: list[GoldenItem] = field(default_factory=list)
    duplicates: int = 0
    invalid: list[str] = field(default_factory=list)
    total: int = 0
    notes_path: Path | None = None


def _run_git(args: list[str]) -> tuple[int, str]:
    try:
        completed = subprocess.run(
            ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return 128, ""
    return completed.returncode, completed.stdout


def assert_private_path(path: Path | str) -> Path:
    candidate = Path(path)
    resolved = (candidate if candidate.is_absolute() else REPO_ROOT / candidate).resolve()
    private = PRIVATE_DIR.resolve()
    if resolved == private or private not in resolved.parents:
        raise PrivatePathError(f"output must be a file inside {_PRIVATE_REL}/")
    try:
        relative = resolved.relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError:
        raise PrivatePathError(f"output must be a file inside {_PRIVATE_REL}/") from None
    code, _ = _run_git(["check-ignore", "-q", "--", relative])
    if code != 0:
        raise PrivatePathError(f"{_PRIVATE_REL}/ is not ignored by git (check-ignore exit {code}); refusing to write")
    code, tracked = _run_git(["ls-files", "--", _PRIVATE_REL])
    if code != 0:
        raise PrivatePathError("git could not list tracked files; refusing to write")
    if tracked.strip():
        raise PrivatePathError(f"files under {_PRIVATE_REL}/ are tracked by git; refusing to write")
    return resolved


def _question_key(question: str) -> str:
    return normalize_text(question)


def _item_id(language: str, question: str) -> str:
    digest = hashlib.sha256(_question_key(question).encode("utf-8")).hexdigest()[:10]
    return f"draft-{language}-{digest}"


def _write_notes(path: Path, notes: dict[str, dict[str, str]]) -> None:
    payload = json.dumps(notes, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, path)


def write_drafted_items(
    entries: Iterable[DraftedEntry | tuple],
    out_path: Path | str,
    existing_items: Iterable[GoldenItem] = (),
    *,
    manifest_path: Path | str | None = None,
    notes_path: Path | str | None = None,
) -> WriteResult:
    out = assert_private_path(out_path)
    manifest = assert_private_path(manifest_path) if manifest_path is not None else assert_private_path(DEFAULT_MANIFEST)
    notes_file = assert_private_path(notes_path) if notes_path is not None else assert_private_path(out.with_suffix(".notes.json"))

    existing = list(existing_items)
    seen_questions = {_question_key(item.question) for item in existing}
    assignments = load_manifest(manifest)
    result = WriteResult()
    new_items: list[GoldenItem] = []
    new_notes: dict[str, dict[str, str]] = {}

    for raw in entries:
        entry = raw if isinstance(raw, DraftedEntry) else DraftedEntry(proposal=raw[0], provenance=raw[1], notes=dict(raw[2]) if len(raw) > 2 else {})
        result.total += 1
        proposal = entry.proposal
        key = _question_key(proposal.question)
        if not key:
            result.invalid.append("empty question")
            continue
        if key in seen_questions:
            result.duplicates += 1
            continue
        item_id = _item_id(proposal.language, proposal.question)
        try:
            item = GoldenItem(
                id=item_id,
                question=proposal.question,
                conversation=proposal.conversation,
                language=proposal.language,
                category=proposal.category,
                answerable=proposal.answerable,
                expected_answer=proposal.expected_answer,
                gold_evidence=proposal.gold_evidence,
                review_status="draft",
                provenance=entry.provenance,
                split=assignments.get(item_id) or assign_split(item_id),
            )
        except ValidationError as exc:
            first = exc.errors()[0]
            result.invalid.append(f"invalid item: {first['msg']}")
            continue
        seen_questions.add(key)
        new_items.append(item)
        if entry.notes:
            new_notes[item_id] = dict(entry.notes)

    result.written = new_items
    all_items = existing + new_items
    if not all_items:
        return result
    frozen = freeze_splits(all_items, manifest)
    write_golden(out, frozen)

    if new_notes or notes_file.exists():
        merged: dict[str, dict[str, str]] = {}
        if notes_file.exists():
            merged.update(json.loads(notes_file.read_text(encoding="utf-8")))
        merged.update(new_notes)
        if merged:
            _write_notes(notes_file, merged)
            result.notes_path = notes_file
    return result
