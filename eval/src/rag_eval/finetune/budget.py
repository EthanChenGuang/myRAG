"""Budget meter and token projection (Phase 6.1 D-06). Stub."""
from dataclasses import dataclass

from rag_sidecar.contracts.finetune import TokenPrice

from rag_eval.finetune.llm import Usage


class BudgetUnenforceable(ValueError):
    pass


def estimate_tokens(text: str, language: str) -> int:
    return 0


def cost_usd(usage: Usage, price: TokenPrice) -> float | None:
    return 0.0


@dataclass(frozen=True)
class Projection:
    input_tokens: int
    output_tokens: int
    cost_usd: float | None


def project(usage: Usage, price: TokenPrice) -> Projection:
    return Projection(0, 0, 0.0)


class Budget:
    def __init__(self, limit_usd: float, price: TokenPrice):
        self.limit_usd = limit_usd
        self.price = price
        self.spent_usd = 0.0
        self.usage = Usage()
        self.remaining_usd = limit_usd
        self.exhausted = False

    def would_exceed(self, estimate: Usage) -> bool:
        return False

    def charge(self, usage: Usage) -> float:
        return 0.0
