from typing import Callable, Sequence

from rag_sidecar.contracts.golden import GoldenItem

from rag_eval.draft.writer import DraftOutcome

PARAPHRASE_TOOL_NAME = "submit_paraphrase"
PARAPHRASE_STYLES: dict[str, str] = {"colloquial": "", "situation": ""}

ParaphraseDrafter = Callable[[str, str, str], str | None]


def paraphrase_items(items: Sequence[GoldenItem], styles: Sequence[str], drafter: ParaphraseDrafter) -> DraftOutcome:
    return DraftOutcome()
