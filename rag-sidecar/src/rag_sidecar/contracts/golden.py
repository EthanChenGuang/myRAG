import unicodedata
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from rag_sidecar.contracts.eval_run import ConversationTurn
from rag_sidecar.contracts.retrieval import RetrievalFilters

Language = Literal["zh", "en", "it"]
Category = Literal[
    "multi_turn",
    "compound",
    "exact_term",
    "table",
    "scanned",
    "no_answer",
    "general",
    "colloquial",
    "ambiguous",
    "typo",
    "cross_lingual",
    "selective_filter",
    "injection",
    "injection_evasive",
    "cache_paraphrase",
    "cache_near_miss",
    "small_talk",
]
INJECTION_CATEGORIES = frozenset({"injection", "injection_evasive"})
CACHE_PAIR_CATEGORIES = frozenset({"cache_paraphrase", "cache_near_miss"})
UNANSWERABLE_CATEGORIES = frozenset({"no_answer", "small_talk"})
ITEM_ID_PATTERN = r"^[a-z0-9][a-z0-9._-]{2,63}$"
ReviewStatus = Literal["draft", "approved", "rejected"]
Provenance = Literal["synthetic_fixture", "claude_draft", "ragas_generated", "human", "production"]
Split = Literal["dev", "test"]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class GoldSpan(_Contract):
    document: str
    section: str
    quote: str = Field(min_length=2)


def _fold(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


class AttackSpec(_Contract):
    canary: str = Field(min_length=6, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    injected_quotes: list[GoldSpan] = Field(min_length=1)
    forbidden_claims: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_attack(self) -> "AttackSpec":
        if any(not claim.strip() for claim in self.forbidden_claims):
            raise ValueError("forbidden_claims must be non-empty literal strings")
        if any("<" in span.quote or ">" in span.quote for span in self.injected_quotes):
            raise ValueError("injected quotes must not contain < or >")
        return self


class GoldenItem(_Contract):
    id: str = Field(pattern=ITEM_ID_PATTERN)
    question: str
    conversation: list[ConversationTurn] = Field(default_factory=list)
    language: Language
    category: Category
    answerable: bool
    expected_answer: str | None = None
    gold_evidence: list[GoldSpan] = Field(default_factory=list)
    evidence_language: Language | None = None
    review_status: ReviewStatus
    provenance: Provenance
    split: Split
    retrieval_filters: RetrievalFilters | None = None
    tags: list[str] = Field(default_factory=list)
    attack: AttackSpec | None = None
    pair_of: str | None = Field(default=None, pattern=ITEM_ID_PATTERN)

    @model_validator(mode="after")
    def _check_rules(self) -> "GoldenItem":
        if self.category in INJECTION_CATEGORIES and not self.answerable:
            raise ValueError("injection items must be answerable")
        if (self.category in UNANSWERABLE_CATEGORIES) == self.answerable:
            raise ValueError("category no_answer or small_talk if and only if answerable is false")
        if self.answerable:
            if not self.gold_evidence:
                raise ValueError("answerable items need at least one gold_evidence span")
            if not (self.expected_answer and self.expected_answer.strip()):
                raise ValueError("answerable items need a non-empty expected_answer")
        elif self.gold_evidence:
            raise ValueError("no_answer and small_talk items must have no gold_evidence spans")
        if self.category == "multi_turn" and not self.conversation:
            raise ValueError("multi_turn items need a non-empty conversation")
        if len(set(self.gold_evidence)) != len(self.gold_evidence):
            raise ValueError("gold_evidence contains identical spans")
        if self.category == "cross_lingual":
            if self.evidence_language is None:
                raise ValueError("cross_lingual items need an evidence_language")
            if self.evidence_language == self.language:
                raise ValueError("cross_lingual evidence_language must differ from the question language")
        elif self.evidence_language is not None and self.evidence_language != self.language:
            raise ValueError("evidence_language must equal the question language outside cross_lingual items")
        self._check_pair()
        self._check_attack()
        return self

    def _check_pair(self) -> None:
        if (self.category in CACHE_PAIR_CATEGORIES) != (self.pair_of is not None):
            raise ValueError("pair_of is required exactly for cache_paraphrase and cache_near_miss items")
        if self.pair_of is not None and self.pair_of == self.id:
            raise ValueError("pair_of must name another item")

    def _check_attack(self) -> None:
        if (self.category in INJECTION_CATEGORIES) != (self.attack is not None):
            raise ValueError("attack is required exactly for injection and injection_evasive items")
        if self.attack is None:
            return
        canary = _fold(self.attack.canary)
        if canary in _fold(self.expected_answer or ""):
            raise ValueError("attack canary must not appear in expected_answer")
        if any(canary in _fold(span.quote) for span in self.gold_evidence):
            raise ValueError("attack canary must not appear in any gold_evidence quote")
        gold_documents = {span.document for span in self.gold_evidence}
        if any(span.document in gold_documents for span in self.attack.injected_quotes):
            raise ValueError("injected documents must not be gold documents")


class GoldenSplitManifest(_Contract):
    schema_version: Literal[1] = 1
    rule: Literal["sha256-first8hex-mod100-lt70-dev"]
    assignments: dict[str, Split]


class DraftedItemProposal(_Contract):
    question: str
    conversation: list[ConversationTurn] = Field(default_factory=list)
    language: Language
    category: Category
    answerable: bool
    expected_answer: str | None = None
    gold_evidence: list[GoldSpan] = Field(default_factory=list)
    evidence_language: Language | None = None


class DraftedItemBatch(_Contract):
    items: list[DraftedItemProposal]
