"""Language-pack registry (Phase 3.2 D-04, D-05): one data file read by the app, the sidecar and eval.

Imported by the base install, so it uses the standard library and pydantic only (no `regex`, no extra).
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, ClassVar, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    WithJsonSchema,
    field_validator,
    model_validator,
)

from rag_sidecar.config_files import resolve_config_file

LANGUAGE_PACKS_FILE = "language-packs.json"

Segmentation = Literal["intl_segmenter_han_bigrams", "whitespace"]
GroundednessSupport = Literal["hhem_2_3", "hhem_2_1_open", "none"]

# Phase 5.2 D-08: the named parameters each parameterized text must carry, in every language.
TEXT_PLACEHOLDERS: dict[str, tuple[str, ...]] = {
    "notices.calc_corrected": ("value",),
    "labels.version": ("version",),
    "labels.effective_from": ("date",),
    "instructions.relevance": ("sentinel",),
    "instructions.relevance_web": ("sentinel",),
    "instructions.relevance_open": ("general_knowledge",),
    "instructions.partial_answer": ("sentinel", "not_covered"),
    "instructions.general_knowledge": ("general_knowledge",),
    "instructions.web_separation": ("from_documents", "from_web"),
}


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class LanguageStopwords(_Contract):
    detection: list[str]
    lexical: list[str]


class LanguageFolding(_Contract):
    accents: bool
    elision_prefixes: list[str]
    elision_suffixes: list[str]


class DoclingOcrCodes(_Contract):
    rapidocr: str = Field(min_length=1)


class LanguageOcrCodes(_Contract):
    docling: DoclingOcrCodes | None = None
    llamaparse: str | None = Field(default=None, min_length=1)


_PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


class _TextGroup(_Contract):
    """One group of fixed texts (Phase 5.2 D-08). A missing key is None and makes the pack incomplete; an empty text is invalid."""

    _group: ClassVar[str] = ""

    @model_validator(mode="after")
    def _placeholders_match(self) -> _TextGroup:
        for key in type(self).model_fields:
            value = getattr(self, key)
            if value is None:
                continue
            dotted = f"{self._group}.{key}"
            found = set(_PLACEHOLDER_RE.findall(value))
            declared = set(TEXT_PLACEHOLDERS.get(dotted, ()))
            if found != declared:
                missing = ", ".join(sorted(declared - found)) or "-"
                undeclared = ", ".join(sorted(found - declared)) or "-"
                raise ValueError(f"{dotted}: placeholder mismatch (missing {missing}; undeclared {undeclared})")
        return self


def _text() -> Any:
    return Field(default=None, min_length=1)


class NoticeTexts(_TextGroup):
    _group: ClassVar[str] = "notices"

    no_information: str | None = _text()
    no_information_web: str | None = _text()
    kb_unavailable: str | None = _text()
    answer_truncated: str | None = _text()
    link_removed: str | None = _text()
    credential_request_blocked: str | None = _text()
    credential_request_warning: str | None = _text()
    not_confirmed: str | None = _text()
    uncited: str | None = _text()
    calc_corrected: str | None = _text()
    calc_not_verified: str | None = _text()
    document_updated_or_removed: str | None = _text()
    prompt_too_long: str | None = _text()


class LabelTexts(_TextGroup):
    _group: ClassVar[str] = "labels"

    from_documents: str | None = _text()
    from_web: str | None = _text()
    general_knowledge: str | None = _text()
    not_covered: str | None = _text()
    version: str | None = _text()
    effective_from: str | None = _text()
    older_version: str | None = _text()
    badge_verified: str | None = _text()
    badge_possibly_unreliable: str | None = _text()
    badge_not_checked: str | None = _text()
    badge_tooltip_verified: str | None = _text()
    badge_tooltip_possibly_unreliable: str | None = _text()
    badge_tooltip_not_checked: str | None = _text()


class InstructionTexts(_TextGroup):
    _group: ClassVar[str] = "instructions"

    citation: str | None = _text()
    citation_per_sentence: str | None = _text()
    attached_documents: str | None = _text()
    relevance: str | None = _text()
    relevance_web: str | None = _text()
    relevance_open: str | None = _text()
    partial_answer: str | None = _text()
    general_knowledge: str | None = _text()
    web_separation: str | None = _text()
    version: str | None = _text()
    concise: str | None = _text()
    calculation: str | None = _text()


class LanguageTexts(_Contract):
    notices: NoticeTexts = Field(default_factory=NoticeTexts)
    labels: LabelTexts = Field(default_factory=LabelTexts)
    instructions: InstructionTexts = Field(default_factory=InstructionTexts)


_TEXT_GROUPS: tuple[tuple[str, type[_TextGroup]], ...] = (
    ("notices", NoticeTexts),
    ("labels", LabelTexts),
    ("instructions", InstructionTexts),
)

# Every fixed-text key as `<group>.<key>`, in group then field order.
TEXT_KEYS: tuple[str, ...] = tuple(f"{group}.{key}" for group, model in _TEXT_GROUPS for key in model.model_fields)


# D-04 completeness (extended by Phase 5.2 D-08 to every text key): the parts a pack needs before a
# deployment may enable it, in this order.
COMPLETENESS_PARTS: tuple[str, ...] = (
    "segmentation",
    "ocr_codes.docling",
    "ocr_codes.llamaparse",
    "rewrite_gate_lexicon",
    *(f"texts.{key}" for key in TEXT_KEYS),
    "fixtures.corpus",
    "fixtures.golden_slices",
)


def text_value(texts: LanguageTexts, dotted: str) -> str | None:
    group, key = dotted.split(".", 1)
    return getattr(getattr(texts, group), key)


class LanguageFixtures(_Contract):
    corpus: bool
    golden_slices: bool


class LanguagePack(_Contract):
    code: str = Field(pattern=r"^[a-z]{2,3}$")
    name: str = Field(min_length=1)
    native_name: str = Field(min_length=1)
    script: str = Field(pattern=r"^[A-Z][a-z]{3}$")
    sentence_end: str = Field(min_length=1)
    list_separator: str = Field(min_length=1)
    segmentation: Segmentation | None = None
    stemmer: str | None = None
    folding: LanguageFolding
    stopwords: LanguageStopwords
    ocr_codes: LanguageOcrCodes
    rewrite_gate_lexicon: str | None = Field(default=None, min_length=1)
    texts: LanguageTexts
    groundedness: GroundednessSupport
    effective_date_patterns: list[str]
    effective_date_end_patterns: list[str] = Field(default=[])
    version_markers: list[str]
    fixtures: LanguageFixtures
    pack_version: int = Field(ge=1)

    @field_validator("effective_date_patterns", "effective_date_end_patterns", "version_markers")
    @classmethod
    def _patterns_compile(cls, patterns: list[str]) -> list[str]:
        for index, pattern in enumerate(patterns):
            try:
                re.compile(pattern)
            except re.error as exc:
                raise ValueError(f"pattern {index} does not compile") from exc
        return patterns


class LanguageRegistry(_Contract):
    schema_version: Literal[1] = 1
    packs: list[LanguagePack] = Field(min_length=1)

    @model_validator(mode="after")
    def _unique_codes(self) -> LanguageRegistry:
        codes = [pack.code for pack in self.packs]
        duplicates = sorted({code for code in codes if codes.count(code) > 1})
        if duplicates:
            raise ValueError(f"duplicate language codes: {', '.join(duplicates)}")
        return self


def pack_missing_parts(pack: LanguagePack) -> list[str]:
    """The D-04 completeness parts this pack lacks, in COMPLETENESS_PARTS order; empty when complete."""
    present = {
        "segmentation": pack.segmentation is not None,
        "ocr_codes.docling": pack.ocr_codes.docling is not None,
        "ocr_codes.llamaparse": pack.ocr_codes.llamaparse is not None,
        "rewrite_gate_lexicon": pack.rewrite_gate_lexicon is not None,
        **{f"texts.{key}": text_value(pack.texts, key) is not None for key in TEXT_KEYS},
        "fixtures.corpus": pack.fixtures.corpus,
        "fixtures.golden_slices": pack.fixtures.golden_slices,
    }
    return [part for part in COMPLETENESS_PARTS if not present[part]]


def default_language_packs_path() -> Path:
    return resolve_config_file(LANGUAGE_PACKS_FILE)


def load_language_registry(path: Path | None = None) -> LanguageRegistry:
    """Load and validate the registry; the default file is read once per process."""
    if path is None:
        return _default_registry()
    return LanguageRegistry.model_validate(json.loads(path.read_text(encoding="utf-8")))


@lru_cache(maxsize=1)
def _default_registry() -> LanguageRegistry:
    return LanguageRegistry.model_validate(
        json.loads(default_language_packs_path().read_text(encoding="utf-8"))
    )


def reset_language_registry_cache() -> None:
    _default_registry.cache_clear()


def get_language_pack(code: str, registry: LanguageRegistry | None = None) -> LanguagePack | None:
    for pack in (registry or load_language_registry()).packs:
        if pack.code == code:
            return pack
    return None


def complete_packs(registry: LanguageRegistry | None = None) -> list[LanguagePack]:
    return [pack for pack in (registry or load_language_registry()).packs if not pack_missing_parts(pack)]


def language_codes(registry: LanguageRegistry | None = None) -> tuple[str, ...]:
    """The registry's language codes, in registry order."""
    return tuple(pack.code for pack in (registry or load_language_registry()).packs)


def build_language_type(codes: Iterable[str], extra: Iterable[str] = ()) -> Any:
    """A string type limited to `codes` (plus `extra`), exported to JSON Schema as an enum in that order (D-06)."""
    allowed = tuple(dict.fromkeys([*codes, *extra]))
    if not allowed:
        raise ValueError("a language type needs at least one code")
    accepted = frozenset(allowed)

    def _known(value: str) -> str:
        if value not in accepted:
            raise ValueError(f"unknown language code {value!r}; expected one of {', '.join(allowed)}")
        return value

    return Annotated[str, AfterValidator(_known), WithJsonSchema({"type": "string", "enum": list(allowed)})]


LANGUAGE_CODES: tuple[str, ...] = language_codes()
Language = build_language_type(LANGUAGE_CODES)
