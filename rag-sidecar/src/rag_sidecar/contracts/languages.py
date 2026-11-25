"""Language-pack registry (Phase 3.2 D-04, D-05): one data file read by the app, the sidecar and eval.

Imported by the base install, so it uses the standard library and pydantic only (no `regex`, no extra).
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal

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

# D-04 completeness: the parts a pack needs before a deployment may enable it, in this order.
COMPLETENESS_PARTS: tuple[str, ...] = (
    "segmentation",
    "ocr_codes.docling",
    "ocr_codes.llamaparse",
    "rewrite_gate_lexicon",
    "texts.strict_refusal",
    "fixtures.corpus",
    "fixtures.golden_slices",
)


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


class GroundednessStateTexts(_Contract):
    verified: str
    possibly_unreliable: str
    not_checked: str


class LanguageTexts(_Contract):
    strict_refusal: str | None = Field(default=None, min_length=1)
    knowledge_base_unavailable: str
    citation_instruction: str
    attached_documents: str
    groundedness_badges: GroundednessStateTexts
    groundedness_tooltips: GroundednessStateTexts


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
    effective_date_end_patterns: list[str] = Field(default_factory=list)
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
        "texts.strict_refusal": pack.texts.strict_refusal is not None,
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
