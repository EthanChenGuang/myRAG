"""Per-language sentence splitting, the twin of src/lib/rag/lang/sentences.ts (Phase 3.2 D-15, D-55).

Both runtimes are held equal by tests/fixtures/lang/sentence-cases.json. Sentence ends come from the language
registry; tokens are counted with tiktoken (cl100k_base unless the caller passes the chunker's own encoding).
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache

import tiktoken

from rag_sidecar.contracts.languages import get_language_pack

DEFAULT_ENCODING = "cl100k_base"

# JavaScript's \s and String.prototype.trim() set, so both runtimes drop the same whitespace.
_JS_SPACE = frozenset(
    "\t\n\v\f\r              "
    "    　﻿"
)
_JS_SPACE_CLASS = "".join(sorted(_JS_SPACE)).replace("\\", "\\\\").replace("]", "\\]").replace("-", "\\-")
# Today's shared set (Phase 3), used for a code outside the registry, as in sentences.ts.
_LEGACY_SENTENCE_END = re.compile(f"(?<=[.!?;。！？；])[{_JS_SPACE_CLASS}]+|(?<=[。！？；])")
_LEGACY_CJK_END = frozenset("。！？；")

UNSPACED_SCRIPTS = frozenset({"Hani", "Hans", "Hant", "Jpan", "Hira", "Kana", "Thai", "Laoo", "Khmr", "Mymr"})
CLOSERS = frozenset(['"', "'", "”", "’", "»", "›", ")", "]", "}", "）", "］", "｝", "】", "」", "』", "〉", "》", "〕", "〗", "〙", "〛", "＂", "＇"])


def _is_mark(char: str | None) -> bool:
    return char is not None and unicodedata.category(char).startswith("M")


def _is_space(char: str | None) -> bool:
    return char is not None and char in _JS_SPACE


def _js_trim(text: str) -> str:
    return text.strip("".join(_JS_SPACE))


@lru_cache(maxsize=4)
def _encoding(name: str) -> tiktoken.Encoding:
    return tiktoken.get_encoding(name)


def count_tokens(text: str, encoding: tiktoken.Encoding | None = None) -> int:
    if not text:
        return 0
    return len((encoding or _encoding(DEFAULT_ENCODING)).encode(text, disallowed_special=()))


def truncate_to_tokens(text: str, max_tokens: int, encoding: tiktoken.Encoding | None = None) -> str:
    """At most max_tokens tokens of text; a cut inside a multi-byte character drops the broken tail."""
    if not text or max_tokens <= 0:
        return ""
    enc = encoding or _encoding(DEFAULT_ENCODING)
    ids = enc.encode(text, disallowed_special=())
    if len(ids) <= max_tokens:
        return text
    return enc.decode_bytes(ids[:max_tokens]).decode("utf-8", errors="replace").rstrip("�")


def _legacy_hard_split(text: str, budget: int, encoding: tiktoken.Encoding | None = None) -> list[str]:
    pieces: list[str] = []
    rest = text
    while rest:
        piece = truncate_to_tokens(rest, max(1, budget), encoding)
        if not piece:
            pieces.append(rest)
            break
        pieces.append(piece)
        rest = rest[len(piece) :]
    return pieces


def _grapheme_safe_hard_split(text: str, budget: int, encoding: tiktoken.Encoding | None = None) -> list[str]:
    """Hard split that never leaves a combining mark at the start of the next piece."""
    pieces: list[str] = []
    rest = text
    while rest:
        piece = truncate_to_tokens(rest, max(1, budget), encoding)
        if not piece:
            pieces.append(rest)
            break
        cut = piece
        while cut and len(cut) < len(rest) and _is_mark(rest[len(cut)]):
            cut = cut[:-1]
        if cut:
            piece = cut
        pieces.append(piece)
        rest = rest[len(piece) :]
    return pieces


def _scan_sentences(text: str, ends: frozenset[str], needs_space: bool) -> list[str]:
    """Linear scan over code points, the same rules as scanSentences in sentences.ts."""
    chars = text
    n = len(chars)
    out: list[str] = []
    start = 0
    i = 0

    def push(begin: int, finish: int) -> None:
        piece = chars[begin:finish]
        if _js_trim(piece):
            out.append(piece)

    while i < n:
        if chars[i] not in ends:
            i += 1
            continue
        j = i + 1
        while j < n and (chars[j] in ends or _is_mark(chars[j])):
            j += 1
        while j < n and (chars[j] in CLOSERS or _is_mark(chars[j])):
            j += 1
        k = j
        while k < n and _is_space(chars[k]) and not _is_mark(chars[k + 1] if k + 1 < n else None):
            k += 1
        if j >= n:
            break
        if needs_space and k == j:
            i = j
            continue
        push(start, j)
        start = k
        i = k
    if start < n:
        push(start, n)
    return out


@dataclass(frozen=True)
class SentenceSplitter:
    """How a block of text is cut into sentences and how its pieces are put back together."""

    language: str | None
    split: Callable[[str], list[str]]
    join: Callable[[str], str]
    hard_split: Callable[..., list[str]]


def _legacy_split(text: str) -> list[str]:
    return [part for part in _LEGACY_SENTENCE_END.split(text) if part]


LEGACY_SPLITTER = SentenceSplitter(
    language=None,
    split=_legacy_split,
    join=lambda previous: "" if previous[-1:] in _LEGACY_CJK_END and previous else " ",
    hard_split=_legacy_hard_split,
)


@lru_cache(maxsize=64)
def _splitter(code: str, sentence_end: str, script: str) -> SentenceSplitter:
    ends = frozenset(sentence_end)
    unspaced = script in UNSPACED_SCRIPTS
    joiner = "" if unspaced else " "
    return SentenceSplitter(
        language=code,
        split=lambda text: _scan_sentences(text, ends, not unspaced),
        join=lambda _previous: joiner,
        hard_split=_grapheme_safe_hard_split,
    )


def splitter_for(code: str) -> SentenceSplitter:
    """The splitter of a registry language: its pack's sentence_end only; an unknown code gets the legacy splitter."""
    pack = get_language_pack(code)
    if pack is None:
        return LEGACY_SPLITTER
    return _splitter(pack.code, pack.sentence_end, pack.script)


def pack_pieces(
    parts: list[str],
    splitter: SentenceSplitter,
    budget: int,
    encoding: tiktoken.Encoding | None = None,
) -> list[str]:
    """Packs parts greedily into pieces of at most budget tokens; a part over the budget is hard split."""
    pieces: list[str] = []
    current = ""
    for part in parts:
        candidate = part if not current else f"{current}{splitter.join(current)}{part}"
        if count_tokens(candidate, encoding) <= budget:
            current = candidate
            continue
        if current:
            pieces.append(current)
        current = ""
        if count_tokens(part, encoding) <= budget:
            current = part
        else:
            pieces.extend(splitter.hard_split(part, budget, encoding))
    if current:
        pieces.append(current)
    return pieces


def split_sentences(
    text: str,
    language: str,
    budget_tokens: int | None = None,
    *,
    encoding: tiktoken.Encoding | None = None,
) -> list[str]:
    """The segments of text: its sentences by language, packed to budget_tokens when a budget is given."""
    splitter = splitter_for(language)
    sentences = splitter.split(text)
    if budget_tokens is None:
        return sentences
    return pack_pieces(sentences, splitter, budget_tokens, encoding)
