"""Terminology dictionary contracts (Phase 4.1.1). Placeholder; the models follow."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class TerminologyEntry(_Contract):
    pass


class TerminologyImportRow(_Contract):
    pass


class TerminologyParams(_Contract):
    pass


class TerminologyMatch(_Contract):
    pass


class TerminologyExpansion(_Contract):
    pass


class TerminologyValidationIssue(_Contract):
    pass


class TerminologyImportReport(_Contract):
    pass


class TerminologyPreviewRequest(_Contract):
    pass


class TerminologyPreviewResponse(_Contract):
    pass


class TerminologyCandidate(_Contract):
    pass


class TerminologyLexiconTerm(_Contract):
    pass


class TerminologyTranslationPair(_Contract):
    pass


class TerminologyLexicon(_Contract):
    pass


def terminology_params_sha256(params: TerminologyParams) -> str:
    return ""
