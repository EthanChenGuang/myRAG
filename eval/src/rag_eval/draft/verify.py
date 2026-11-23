from collections.abc import Mapping, Sequence

from rag_sidecar.contracts.golden import DraftedItemProposal

from rag_eval.draft.sources import WorkspaceDocument
from rag_eval.matching import chunk_matches_span


def index_documents(docs: Sequence[WorkspaceDocument]) -> dict[str, list[str]]:
    index: dict[str, list[str]] = {}
    for doc in docs:
        index.setdefault(doc.filename, []).extend(doc.chunks)
    return index


def verify_proposal(proposal: DraftedItemProposal, docs_by_filename: Mapping[str, Sequence[str]]) -> list[str]:
    problems: list[str] = []
    for span in proposal.gold_evidence:
        names = [name for name in docs_by_filename if name.casefold() == span.document.casefold()]
        if not names:
            problems.append(f"unknown document {span.document!r}")
            continue
        try:
            found = any(chunk_matches_span(name, chunk, span) for name in names for chunk in docs_by_filename[name])
        except ValueError:
            problems.append(f"quote has no text after normalization in {span.document!r}")
            continue
        if not found:
            problems.append(f"quote not found verbatim in any chunk of {span.document!r}")
    return problems
