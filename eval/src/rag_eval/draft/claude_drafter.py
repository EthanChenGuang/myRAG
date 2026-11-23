import html
import math
import sys
from typing import Any, Sequence

from pydantic import ValidationError
from rag_sidecar.contracts.golden import DraftedItemBatch, DraftedItemProposal

from rag_eval.draft.config import DraftConfig
from rag_eval.draft.sources import WorkspaceDocument
from rag_eval.draft.writer import DraftedEntry, DraftOutcome

TOOL_NAME = "submit_drafted_items"
MAX_ITEMS_PER_CALL = 15
CATEGORY_SHARES = (
    ("general", "straightforward questions answered by one passage"),
    ("exact_term", "questions built around a product name, code, SKU, number or other exact term"),
    ("compound", "questions that need two or more separate spans of evidence in the answer"),
    ("table", "questions answered by a cell or row of a table"),
    ("scanned", "questions about documents that look like OCR output or image captions, tolerating their noise"),
    ("multi_turn", "a short earlier conversation, then a follow-up question that only makes sense with it; fill the conversation field"),
    ("no_answer", "plausible questions on the workspace's topics whose answer is NOT in the documents; answerable false, no evidence, no expected answer"),
)


def _system_prompt(languages: Sequence[str]) -> str:
    categories = "\n".join(f"- {name}: {meaning}" for name, meaning in CATEGORY_SHARES)
    return f"""You draft evaluation questions for a retrieval-augmented question answering system. A person will review every item you submit.

You are given documents split into numbered chunks. Call the {TOOL_NAME} tool once with the items you draft.

Rules for every answerable item:
- gold_evidence lists spans. Each span has document (the exact document name from the document tag), section (the nearest heading above the quote, or an empty string) and quote.
- The quote must be copied verbatim from a single chunk of that document: same words, same order, no paraphrase, no ellipsis, no merged chunks. Quotes that are not verbatim are discarded automatically.
- expected_answer is a short, complete answer that the quoted spans support.
- Never use chunk numbers or ids as evidence.

Categories to cover (use the exact category value):
{categories}

Languages: write each question in one of {", ".join(languages)} (zh, en or it) and set language to match. Use the language of the document the question is about, and spread items across the languages present.

Real users do not write like documentation, so mix the question styles:
- colloquial wording that differs from the terms used in the document (everyday words instead of the document's vocabulary);
- ambiguous, short or underspecified questions a hurried user would type, a few words only;
- some questions with typos, missing accents or keyword-only phrasing;
- roughly one in seven items must be no_answer questions whose answer is not in the workspace.

Do not repeat a question. Do not include personal data. Submit only items you are confident about."""


def _render_units(units: Sequence[tuple[str, int, str]]) -> str:
    parts: list[str] = []
    current: str | None = None
    for name, index, text in units:
        if name != current:
            if current is not None:
                parts.append("</document>")
            parts.append(f'<document name="{html.escape(name, quote=True)}">')
            current = name
        parts.append(f"<chunk number=\"{index + 1}\">\n{text}\n</chunk>")
    if current is not None:
        parts.append("</document>")
    return "\n".join(parts)


def _batches(docs: Sequence[WorkspaceDocument], budget_chars: int) -> list[list[tuple[str, int, str]]]:
    batches: list[list[tuple[str, int, str]]] = []
    current: list[tuple[str, int, str]] = []
    size = 0
    for doc in docs:
        for index, text in enumerate(doc.chunks):
            cost = len(text) + 80
            if current and size + cost > budget_chars:
                batches.append(current)
                current, size = [], 0
            current.append((doc.filename, index, text))
            size += cost
    if current:
        batches.append(current)
    return batches


def _spread(batches: list[list[tuple[str, int, str]]], n: int) -> list[list[tuple[str, int, str]]]:
    if len(batches) <= n:
        return batches
    picked = [batches[math.floor(i * len(batches) / n)] for i in range(n)]
    print(
        f"[Draft] {len(batches) - n} of {len(batches)} workspace batches were not sampled because n={n}; "
        "raise n to draft from all of them",
        file=sys.stderr,
    )
    return picked


def _split_counts(n: int, parts: int) -> list[int]:
    base, extra = divmod(n, parts)
    return [base + (1 if i < extra else 0) for i in range(parts)]


def _parse_items(payload: Any, outcome: DraftOutcome, languages: Sequence[str]) -> list[DraftedItemProposal]:
    try:
        return list(DraftedItemBatch.model_validate(payload).items)
    except ValidationError:
        pass
    raw_items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(raw_items, list):
        outcome.rejected.append("claude returned no items list")
        return []
    items: list[DraftedItemProposal] = []
    for raw in raw_items:
        try:
            items.append(DraftedItemProposal.model_validate(raw))
        except ValidationError:
            outcome.rejected.append("claude item failed schema validation")
    return items


def draft_with_claude(
    docs: Sequence[WorkspaceDocument],
    n: int,
    languages: Sequence[str],
    client: Any,
    config: DraftConfig,
) -> DraftOutcome:
    outcome = DraftOutcome()
    batches = _batches(docs, config.batch_chars)
    if not batches or n <= 0:
        return outcome
    batches = _spread(batches, n)
    tool = {
        "name": TOOL_NAME,
        "description": "Submit the drafted golden-set items for this batch of documents.",
        "input_schema": DraftedItemBatch.model_json_schema(),
    }
    system = _system_prompt(languages)
    calls = [
        (units, part)
        for units, count in zip(batches, _split_counts(n, len(batches)))
        for part in _split_counts(count, max(1, math.ceil(count / MAX_ITEMS_PER_CALL)))
        if part > 0
    ]
    for number, (units, count) in enumerate(calls, start=1):
        content = f"{_render_units(units)}\n\nDraft {count} items from these documents and submit them with {TOOL_NAME}."
        response = client.messages.create(
            model=config.claude_model,
            max_tokens=config.max_tokens,
            system=system,
            messages=[{"role": "user", "content": content}],
            tools=[tool],
            tool_choice={"type": "tool", "name": TOOL_NAME},
        )
        stop_reason = getattr(response, "stop_reason", None)
        if stop_reason == "refusal":
            outcome.rejected.append(f"claude refused batch {number}")
            continue
        if stop_reason == "max_tokens":
            outcome.rejected.append(f"claude output truncated at max_tokens for batch {number}")
            continue
        block = next(
            (b for b in response.content if getattr(b, "type", None) == "tool_use" and getattr(b, "name", None) == TOOL_NAME),
            None,
        )
        if block is None:
            outcome.rejected.append(f"claude made no tool call for batch {number}")
            continue
        for proposal in _parse_items(block.input, outcome, languages):
            if proposal.language not in languages:
                outcome.rejected.append("claude item in a language that was not requested")
                continue
            outcome.entries.append(DraftedEntry(proposal=proposal, provenance="claude_draft", notes={"drafter": "claude"}))
    return outcome
