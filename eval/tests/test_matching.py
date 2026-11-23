from pathlib import Path

import pytest
from rag_sidecar.contracts.golden import GoldSpan

from rag_eval.matching import chunk_matches_span, normalize_text
from rag_eval.paths import REPO_ROOT, resolve_cli_path


def _span(document: str, quote: str) -> GoldSpan:
    return GoldSpan(document=document, section="s", quote=quote)


def test_normalize_width_case_whitespace_punctuation():
    assert normalize_text("Ｔｈｅ  １２-month, plan!") == normalize_text("the 12month plan")
    assert normalize_text("Ｔｈｅ  １２-month, plan!") == "the12monthplan"


def test_fullwidth_digits_match_ascii():
    assert chunk_matches_span("a.pdf", "Total: 12 items", _span("a.pdf", "１２ items"))


def test_italian_accents_casefold():
    assert normalize_text("Perché") == normalize_text("PERCHÉ")
    assert chunk_matches_span("a.pdf", "PERCHÉ non?", _span("a.pdf", "perché"))


def test_chinese_fullwidth_comma_matches_ascii_comma():
    assert chunk_matches_span("a.pdf", "退款政策：七天内，无理由退货。", _span("a.pdf", "七天内,无理由退货"))
    assert normalize_text("七天内，无理由") == normalize_text("七天内,无理由")


def test_wrong_document_name_does_not_match():
    text = "The refund window is thirty days."
    assert chunk_matches_span("policy.pdf", text, _span("policy.pdf", "refund window"))
    assert not chunk_matches_span("other.pdf", text, _span("policy.pdf", "refund window"))


def test_document_name_is_casefolded():
    assert chunk_matches_span("POLICY.PDF", "refund window", _span("policy.pdf", "refund window"))


def test_quote_not_in_chunk_does_not_match():
    assert not chunk_matches_span("a.pdf", "something else entirely", _span("a.pdf", "refund window"))


def test_empty_normalized_quote_raises():
    with pytest.raises(ValueError):
        chunk_matches_span("a.pdf", "text", _span("a.pdf", "!?"))


def test_resolve_cli_path_absolute_unchanged_relative_joined():
    absolute = Path("/tmp/some/abs/path.json")
    assert resolve_cli_path(absolute) == absolute
    assert resolve_cli_path("eval/out/x.json") == REPO_ROOT / "eval/out/x.json"
    assert resolve_cli_path("eval/out/x.json").is_absolute()


def test_repo_root_is_repository_root():
    assert (REPO_ROOT / "eval" / "pyproject.toml").is_file()
    assert (REPO_ROOT / "rag-sidecar" / "pyproject.toml").is_file()
