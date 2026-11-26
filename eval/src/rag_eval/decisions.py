"""Shipped-default decisions computed from committed comparisons by a fixed rule (stub)."""

from typing import Any, Mapping

from pydantic import BaseModel


class TableHeaderDecision(BaseModel):
    decision: str = "profile"


def decide_table_header_default(comparison: Mapping[str, Any] | None, noise: Any, **_: Any) -> dict[str, Any]:
    return {"decision": "profile"}


def main(argv: list[str] | None = None) -> int:
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
