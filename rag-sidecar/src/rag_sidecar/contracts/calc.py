"""Phase 5.2.1 calculation contracts (05.2 D-66 to D-69, D-72 to D-75, D-95).

The model fills a `CalcRequest`; the evaluator returns a `CalcResult`; the check records a `CalcCheck`. No field
holds an expression: a step names a closed operation and its arguments are operand names or earlier step ids, and
every number is a decimal string. The request tree has no union in its JSON Schema, so it can serve as a tool input
schema as generated.
"""

from datetime import date
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from rag_sidecar.contracts.omit import omit_none_schema

RESERVED_NAMES = ("constructor", "prototype", "valueof", "tostring", "hasownproperty")
_IDENT = r"^(?!(?:" + "|".join(RESERVED_NAMES) + r")$)[a-z][a-z0-9_]{0,31}$"
_DECIMAL = r"-?[0-9]{1,30}(\.[0-9]{1,30})?"
_ISO_DATE = r"[0-9]{4}-[0-9]{2}-[0-9]{2}"
# Letters (Latin, Greek, Cyrillic, kana, CJK), digits, currency symbols, space, percent, slash, dot, underscore,
# degree and hyphen; written as \u escapes so the same pattern works without the JavaScript `u` flag.
_UNIT_CHARS = (
    r"A-Za-z0-9\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF"
    r"$\u00A2-\u00A5\u20A0-\u20CF %/._\u00B0\-"
)


def _single_line(value: str) -> str:
    if "\n" in value or "\r" in value:
        raise ValueError("must be a single line")
    return value


def _valid_date(value: str) -> str:
    if len(value) == 10 and value[4] == "-":
        date.fromisoformat(value)
    return value


Identifier = Annotated[str, Field(pattern=_IDENT), AfterValidator(_single_line)]
DecimalString = Annotated[str, Field(pattern="^" + _DECIMAL + "$"), AfterValidator(_single_line)]
OperandValue = Annotated[
    str,
    Field(pattern="^(" + _DECIMAL + "|" + _ISO_DATE + ")$"),
    AfterValidator(_single_line),
    AfterValidator(_valid_date),
]
Unit = Annotated[str, Field(pattern="^[" + _UNIT_CHARS + "]{1,32}$"), AfterValidator(_single_line)]
Label = Annotated[str, Field(pattern="^[" + _UNIT_CHARS + ",:]{1,80}$"), AfterValidator(_single_line)]
Alias = Annotated[str, Field(pattern=r"^[A-Z][0-9]{1,3}$"), AfterValidator(_single_line)]
SourceKey = Annotated[str, Field(pattern=r"^[A-Za-z0-9_.:-]{1,64}$"), AfterValidator(_single_line)]
ExactRational = Annotated[str, Field(pattern=r"^-?[0-9]+/[0-9]+$"), AfterValidator(_single_line)]
StepInput = Annotated[
    str, Field(pattern="^(" + _DECIMAL + "|" + _ISO_DATE + r"|-?[0-9]+/[0-9]+)$"), AfterValidator(_single_line)
]
TraceHash = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$"), AfterValidator(_single_line)]

CalcSourceKind = Literal["question", "chunk", "fact_tool"]
CalcOp = Literal[
    "add", "subtract", "multiply", "divide", "min", "max", "sum", "cap_each", "percentage", "round", "date_diff"
]
CalcRoundingMode = Literal["half_up", "half_even", "up", "down"]
CalcDateUnit = Literal["days", "months", "years"]
CalcOrigin = Literal["tool", "trailing_block"]
CalcRejectReason = Literal[
    "invalid_request",
    "unsourced_operand",
    "unknown_source",
    "unknown_argument",
    "mixed_units",
    "limit_exceeded",
    "division_by_zero",
    "invalid_value",
    "invalid_date",
    "unsupported_source",
]
CalcCheckStatus = Literal["verified", "corrected", "not_verified"]
CalcCheckReason = Literal["operand_not_located", "trace_missing", "trace_invalid", "stated_not_found", "check_error"]

# Operations whose argument count is fixed; the others take one or more arguments.
_FIXED_ARITY: dict[str, int] = {"subtract": 2, "divide": 2, "percentage": 2, "cap_each": 2, "date_diff": 2, "round": 1}


def _omit_none(value: object) -> bool:
    return value is None


def _optional(**kwargs: object) -> object:
    """An optional key that is absent rather than null, so the schema carries no `anyOf` null branch."""

    return Field(default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema, **kwargs)  # type: ignore[arg-type]


class _Contract(BaseModel):
    # Python's engine, because the identifier pattern uses a lookahead to reject reserved names.
    model_config = ConfigDict(extra="forbid", frozen=True, regex_engine="python-re")


class CalcSource(_Contract):
    """Where an operand comes from: the question, a cited context block (by alias) or a fact tool (reserved, SEC-05)."""

    kind: CalcSourceKind
    alias: Alias | None = _optional()
    tool: Identifier | None = _optional()
    key: SourceKey | None = _optional()

    @model_validator(mode="after")
    def _rules(self) -> "CalcSource":
        if self.kind == "chunk":
            if self.alias is None or self.tool is not None or self.key is not None:
                raise ValueError("a chunk source needs an alias and nothing else")
        elif self.kind == "question":
            if self.alias is not None or self.tool is not None or self.key is not None:
                raise ValueError("a question source carries no alias, tool or key")
        elif self.tool is None or self.key is None or self.alias is not None:
            raise ValueError("a fact_tool source needs a tool and a key and no alias")
        return self


class CalcOperand(_Contract):
    """One sourced input: a single decimal or ISO date (`value`) or a list of decimals (`values`)."""

    name: Identifier
    value: OperandValue | None = _optional()
    values: list[DecimalString] | None = _optional(min_length=1, max_length=200)
    unit: Unit | None = _optional()
    unit_from: Unit | None = _optional()
    unit_to: Unit | None = _optional()
    source: CalcSource

    @model_validator(mode="after")
    def _rules(self) -> "CalcOperand":
        if (self.value is None) == (self.values is None):
            raise ValueError("an operand needs exactly one of value and values")
        if (self.unit_from is None) != (self.unit_to is None):
            raise ValueError("unit_from and unit_to go together")
        return self


class CalcRounding(_Contract):
    """Rounding to `places` decimal places, applied only where a step states it.

    Modes: `half_up` rounds ties away from zero; `half_even` (the default rule) rounds ties to even; `up` rounds
    away from zero; `down` rounds toward zero.
    """

    mode: CalcRoundingMode = "half_even"
    places: int = Field(ge=0, le=20)


class CalcStep(_Contract):
    id: Identifier
    op: CalcOp
    args: list[Identifier] = Field(min_length=1, max_length=50)
    rounding: CalcRounding | None = _optional()
    label: Label | None = _optional()
    date_unit: CalcDateUnit | None = _optional()
    inclusive: bool | None = _optional()

    @model_validator(mode="after")
    def _rules(self) -> "CalcStep":
        if self.op != "date_diff" and (self.date_unit is not None or self.inclusive is not None):
            raise ValueError("date_unit and inclusive apply only to date_diff")
        if self.op == "round" and self.rounding is None:
            raise ValueError("a round step needs rounding")
        arity = _FIXED_ARITY.get(self.op)
        if arity is not None and len(self.args) != arity:
            raise ValueError(f"{self.op} takes exactly {arity} argument(s)")
        return self


class CalcRequest(_Contract):
    """A structured calculation; each step argument names an operand or an earlier step, never a literal."""

    operands: list[CalcOperand] = Field(min_length=1, max_length=50)
    steps: list[CalcStep] = Field(min_length=1, max_length=30)
    result: Identifier

    @model_validator(mode="after")
    def _references(self) -> "CalcRequest":
        known = set()
        for operand in self.operands:
            if operand.name in known:
                raise ValueError("operand names must not repeat")
            known.add(operand.name)
        step_ids = set()
        for step in self.steps:
            for arg in step.args:
                if arg not in known:
                    raise ValueError("a step argument must name an operand or an earlier step")
            if step.id in known:
                raise ValueError("step ids must not repeat or reuse an operand name")
            known.add(step.id)
            step_ids.add(step.id)
        if self.result not in step_ids:
            raise ValueError("result must name a step")
        return self


class CalcStepResult(_Contract):
    id: Identifier
    op: CalcOp
    inputs: list[StepInput] = Field(default_factory=list)
    exact: ExactRational
    display: DecimalString
    # True when `display` is a rounded rendering of `exact` rather than its exact decimal form.
    display_rounded: bool = False


class CalcResult(_Contract):
    status: Literal["ok", "rejected"]
    value: DecimalString | None = None
    unit: Unit | None = None
    steps: list[CalcStepResult] = Field(default_factory=list)
    reject_reason: CalcRejectReason | None = None

    @model_validator(mode="after")
    def _rules(self) -> "CalcResult":
        if self.status == "ok":
            if self.value is None or self.reject_reason is not None:
                raise ValueError("an ok result needs a value and no reject_reason")
        elif self.reject_reason is None or self.value is not None:
            raise ValueError("a rejected result needs a reject_reason and no value")
        return self


class CalcTrace(_Contract):
    origin: CalcOrigin
    request: CalcRequest
    result: CalcResult | None = None
    anchor_offset: int | None = Field(default=None, ge=0)


class CalcSpan(_Contract):
    """UTF-16 code-unit offsets of the stated number in the answer text."""

    start: int = Field(ge=0)
    end: int = Field(ge=0)

    @model_validator(mode="after")
    def _ordered(self) -> "CalcSpan":
        if self.end <= self.start:
            raise ValueError("end must be greater than start")
        return self


class CalcCheck(_Contract):
    status: CalcCheckStatus
    stated: DecimalString | None = None
    recomputed: DecimalString | None = None
    unit: Unit | None = None
    trace_hash: TraceHash | None = None
    origin: CalcOrigin | None = None
    reason: CalcCheckReason | None = None
    stated_span: CalcSpan | None = None

    @model_validator(mode="after")
    def _rules(self) -> "CalcCheck":
        if self.status == "not_verified":
            if self.reason is None:
                raise ValueError("a not_verified check needs a reason")
            return self
        if self.reason is not None:
            raise ValueError("only a not_verified check carries a reason")
        if self.recomputed is None or self.trace_hash is None or self.origin is None:
            raise ValueError("a verified or corrected check needs recomputed, trace_hash and origin")
        if self.status == "corrected" and self.stated is None:
            raise ValueError("a corrected check needs the stated value")
        return self


class CalcLimits(_Contract):
    """Evaluator bounds in `config/rag/calc-limits.json` (D-69, Pitfall C3); each at most the schema bound."""

    version: int = Field(ge=1)
    max_operands: int = Field(ge=1, le=50)
    max_list_items: int = Field(ge=1, le=200)
    max_steps: int = Field(ge=1, le=30)
    max_depth: int = Field(ge=1, le=30)
    max_digits: int = Field(ge=1, le=60)
    max_round_places: int = Field(ge=0, le=20)
    max_bits: int = Field(ge=64, le=65536)
