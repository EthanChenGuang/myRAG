"""T-07-94 follow-up: the sibling <target>.tmp of the private writers is 0600 and never follows a symlink."""

import os
import stat
from pathlib import Path

import pytest
from pydantic import BaseModel
from rag_sidecar.contracts.golden import GoldenItem

from rag_eval import feedback_exports, review_queue
from rag_eval.golden_io import write_golden


class _Line(BaseModel):
    value: str


def _item() -> GoldenItem:
    return GoldenItem(
        id="tmpwrite-001",
        question="What does the synthetic sample component do?",
        language="en",
        category="general",
        answerable=True,
        expected_answer="It restarts every night.",
        gold_evidence=[{"document": "synthetic.en.md", "section": "Sample", "quote": "It restarts every night."}],
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
    )


def _golden(path: Path) -> None:
    write_golden(path, [_item()])


def _queue(path: Path) -> None:
    review_queue._write_text(path, '{"synthetic": true}\n')


def _export(path: Path) -> None:
    feedback_exports._write_atomic(path, [_Line(value="synthetic")])


WRITERS = [
    pytest.param(_golden, id="golden_io.write_golden"),
    pytest.param(_queue, id="review_queue._write_text"),
    pytest.param(_export, id="feedback_exports._write_atomic"),
]


@pytest.mark.parametrize("write", WRITERS)
def test_written_file_is_owner_only(tmp_path: Path, write) -> None:
    previous = os.umask(0o022)
    try:
        target = tmp_path / "out" / "items.jsonl"
        write(target)
    finally:
        os.umask(previous)
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert not (target.parent / (target.name + ".tmp")).exists()


@pytest.mark.parametrize("write", WRITERS)
def test_symlinked_tmp_sibling_is_refused_and_its_target_untouched(tmp_path: Path, write) -> None:
    victim = tmp_path / "victim.txt"
    victim.write_text("original\n")
    target = tmp_path / "out" / "items.jsonl"
    target.parent.mkdir()
    (target.parent / (target.name + ".tmp")).symlink_to(victim)
    with pytest.raises(ValueError, match="symlink"):
        write(target)
    assert victim.read_text() == "original\n"
    assert not target.exists()


@pytest.mark.parametrize("write", WRITERS)
def test_symlinked_target_is_refused(tmp_path: Path, write) -> None:
    victim = tmp_path / "victim.txt"
    victim.write_text("original\n")
    target = tmp_path / "out" / "items.jsonl"
    target.parent.mkdir()
    target.symlink_to(victim)
    with pytest.raises(ValueError, match="symlink"):
        write(target)
    assert victim.read_text() == "original\n"
    assert target.is_symlink()


@pytest.mark.parametrize("write", WRITERS)
def test_stale_regular_tmp_is_replaced(tmp_path: Path, write) -> None:
    target = tmp_path / "out" / "items.jsonl"
    target.parent.mkdir()
    stale = target.parent / (target.name + ".tmp")
    stale.write_text("stale\n")
    os.chmod(stale, 0o644)
    write(target)
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert "stale" not in target.read_text()
