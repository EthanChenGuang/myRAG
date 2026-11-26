"""Budget meter and token projection for the fine-tune LLM calls (Phase 6.1 D-06, D-26).

Token estimates come from character counts: DEFAULT_CHARS_PER_TOKEN for alphabetic scripts and
DENSE_SCRIPT_CHARS_PER_TOKEN for scripts written without spaces (Han, kana, Hangul), chosen from the language pack's
script in the registry. Prices come from the price table in eval/config/finetune.json (USD per million tokens); a missing
price makes the cost unknown, and a Budget cannot be enforced without both prices. Reused by `generate`, `filter` (judge)
and the false-negative audit of `mine`.
"""
import math
from dataclasses import dataclass

from rag_sidecar.contracts.finetune import TokenPrice
from rag_sidecar.contracts.languages import get_language_pack

from rag_eval.finetune.llm import Usage

DEFAULT_CHARS_PER_TOKEN = 4.0
DENSE_SCRIPT_CHARS_PER_TOKEN = 1.5
DENSE_SCRIPTS = frozenset({"Hani", "Hans", "Hant", "Hira", "Kana", "Jpan", "Hang", "Kore"})
TOKENS_PER_MILLION = 1_000_000


class BudgetUnenforceable(ValueError):
    """A budget was requested but the price table cannot turn usage into money."""


def chars_per_token(language: str) -> float:
    pack = get_language_pack(language)
    if pack is not None and pack.script in DENSE_SCRIPTS:
        return DENSE_SCRIPT_CHARS_PER_TOKEN
    return DEFAULT_CHARS_PER_TOKEN


def estimate_tokens(text: str, language: str) -> int:
    if not text:
        return 0
    return math.ceil(len(text) / chars_per_token(language))


def prices_known(price: TokenPrice) -> bool:
    return price.input_usd_per_mtok is not None and price.output_usd_per_mtok is not None


def cost_usd(usage: Usage, price: TokenPrice) -> float | None:
    if not prices_known(price):
        return None
    return (
        usage.input_tokens * price.input_usd_per_mtok + usage.output_tokens * price.output_usd_per_mtok
    ) / TOKENS_PER_MILLION


@dataclass(frozen=True)
class Projection:
    input_tokens: int
    output_tokens: int
    cost_usd: float | None


def project(usage: Usage, price: TokenPrice) -> Projection:
    return Projection(usage.input_tokens, usage.output_tokens, cost_usd(usage, price))


class Budget:
    """Charges actual usage; would_exceed(estimate) is checked before each call so no call starts past the limit."""

    def __init__(self, limit_usd: float, price: TokenPrice):
        if limit_usd is None or not math.isfinite(limit_usd) or limit_usd < 0:
            raise ValueError("budget limit must be a finite, non-negative USD amount")
        if not prices_known(price):
            raise BudgetUnenforceable("prices_unknown: set input and output prices in finetune.json")
        self.limit_usd = float(limit_usd)
        self.price = price
        self.spent_usd = 0.0
        self.usage = Usage()

    @property
    def remaining_usd(self) -> float:
        return max(0.0, self.limit_usd - self.spent_usd)

    @property
    def exhausted(self) -> bool:
        return self.spent_usd >= self.limit_usd

    def would_exceed(self, estimate: Usage) -> bool:
        return self.spent_usd + (cost_usd(estimate, self.price) or 0.0) > self.limit_usd

    def charge(self, usage: Usage) -> float:
        cost = cost_usd(usage, self.price) or 0.0
        self.spent_usd += cost
        self.usage = self.usage + usage
        return cost
