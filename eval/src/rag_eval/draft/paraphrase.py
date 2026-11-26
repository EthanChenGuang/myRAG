from typing import Any, Callable, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.golden import DraftedItemProposal, GoldenItem

from rag_eval.draft.config import DraftConfig
from rag_eval.draft.writer import DraftedEntry, DraftOutcome
from rag_eval.matching import normalize_text
from rag_eval.review_queue import mask_text
from rag_eval.split import PARAPHRASE_OF_TAG

PARAPHRASE_TOOL_NAME = "submit_paraphrase"
STYLE_TAG = "style:"
PARAPHRASE_MAX_TOKENS = 1024
EXPERT_PROVENANCES = frozenset({"production", "human", "historical"})

# D-53: neutral style instructions; the drafter sees only these and the item's own question.
PARAPHRASE_STYLES: dict[str, str] = {
    "colloquial": (
        "Rewrite the question the way a hurried user would type it: short, casual everyday words instead of formal or "
        "technical terms, possibly a little vague. Keep its meaning and its language."
    ),
    "situation": (
        "Rewrite the question as a user who describes their own circumstances and asks what applies to them, instead of "
        "naming the subject the way the original does. Keep its meaning and its language, and add no fact the original "
        "does not imply."
    ),
}

ParaphraseDrafter = Callable[[str, str, str], str | None]
"""(question, language code, style name) -> the rewritten question, or None when the drafter gave none."""


class ParaphraseProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    question: str = Field(min_length=1, max_length=2000)


_SYSTEM_PROMPT = f"""You rewrite one evaluation question for a question answering system. A person will review every rewrite.

Call the {PARAPHRASE_TOOL_NAME} tool once with the rewritten question.

Rules:
- Follow the style instruction you are given.
- The rewrite must ask for exactly the same information as the original, so that the same answer is still correct.
- Write in the language given by the language code, the same language as the original.
- Do not answer the question, and do not add names, numbers, personal data or facts that the original does not contain."""


def claude_paraphraser(client: Any, config: DraftConfig) -> ParaphraseDrafter:
    """The Claude drafter's structured-output pattern (one tool, validated input) with the model pinned in draft.json."""
    tool = {
        "name": PARAPHRASE_TOOL_NAME,
        "description": "Submit the rewritten question.",
        "input_schema": ParaphraseProposal.model_json_schema(),
    }

    def draft(question: str, language: str, style: str) -> str | None:
        content = (
            f"<style>{style}</style>\n<instruction>{PARAPHRASE_STYLES[style]}</instruction>\n<language>{language}</language>\n"
            f"<question>\n{question}\n</question>\n\nRewrite the question and submit it with {PARAPHRASE_TOOL_NAME}."
        )
        response = client.messages.create(
            model=config.claude_model,
            max_tokens=min(config.max_tokens, PARAPHRASE_MAX_TOKENS),
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": content}],
            tools=[tool],
        )
        if getattr(response, "stop_reason", None) in ("refusal", "max_tokens"):
            return None
        block = next(
            (b for b in response.content if getattr(b, "type", None) == "tool_use" and getattr(b, "name", None) == PARAPHRASE_TOOL_NAME),
            None,
        )
        if block is None:
            return None
        try:
            return ParaphraseProposal.model_validate(block.input).question.strip() or None
        except ValidationError:
            return None

    return draft


def _done(items: Sequence[GoldenItem]) -> set[tuple[str, str]]:
    done: set[tuple[str, str]] = set()
    for item in items:
        if item.provenance != "paraphrased":
            continue
        parents = [tag[len(PARAPHRASE_OF_TAG) :] for tag in item.tags if tag.startswith(PARAPHRASE_OF_TAG)]
        styles = [tag[len(STYLE_TAG) :] for tag in item.tags if tag.startswith(STYLE_TAG)]
        done.update((parent, style) for parent in parents for style in styles)
    return done


def paraphrase_items(items: Sequence[GoldenItem], styles: Sequence[str], drafter: ParaphraseDrafter) -> DraftOutcome:
    """D-53: one draft variant per style for each approved expert-written item that has none yet for that style."""
    unknown = sorted(set(styles) - set(PARAPHRASE_STYLES))
    if unknown:
        raise ValueError(f"unknown paraphrase style: {', '.join(unknown)}")
    outcome = DraftOutcome()
    done = _done(items)
    for item in items:
        if item.review_status != "approved" or item.provenance not in EXPERT_PROVENANCES:
            continue
        for style in styles:
            if (item.id, style) in done:
                continue
            question = drafter(item.question, item.language, style)
            if question is None:
                outcome.rejected.append("paraphrase drafter returned nothing")
                continue
            if normalize_text(question) == normalize_text(item.question):
                outcome.rejected.append("paraphrase repeats the question")
                continue
            if mask_text(question) != question:
                outcome.rejected.append("paraphrase changes under masking")
                continue
            proposal = DraftedItemProposal(
                question=question,
                conversation=item.conversation,
                language=item.language,
                category=item.category,
                answerable=item.answerable,
                expected_answer=item.expected_answer,
                gold_evidence=item.gold_evidence,
                evidence_language=item.evidence_language,
            )
            outcome.entries.append(
                DraftedEntry(
                    proposal=proposal,
                    provenance="paraphrased",
                    notes={"drafter": "claude", "style": style},
                    base=item,
                    split=item.split,
                    tags=[f"{PARAPHRASE_OF_TAG}{item.id}", f"{STYLE_TAG}{style}"],
                )
            )
            done.add((item.id, style))
    return outcome
