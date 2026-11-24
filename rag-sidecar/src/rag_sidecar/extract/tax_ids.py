from dataclasses import dataclass

from rag_sidecar.contracts.ingest import TaxIdScheme


@dataclass(frozen=True)
class TaxIdCheck:
    scheme: TaxIdScheme
    valid: bool
    normalized: str


def classify_tax_id(raw: str) -> TaxIdCheck:
    return TaxIdCheck(scheme="unknown", valid=False, normalized="")


def render_tax_id_vectors() -> str:
    return ""
