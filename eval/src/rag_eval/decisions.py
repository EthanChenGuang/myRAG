"""Shipped-default decisions computed from committed comparisons by a fixed rule.

`table-header-default` (Phase 3.2 D-19, CHK-06): reads the table_header_repeat arm of the per-switch comparison (plan 03.2-66,
`eval/reports/phase32/comparison.json`) and decides the default of RAG_TABLE_HEADER_REPEAT. The record is tool-written; `--check`
recomputes it from the committed comparison and fails when the committed record differs."""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Mapping

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig

from rag_eval.paths import REPO_ROOT, repo_relative

EXIT_OK = 0
EXIT_DIFFERS = 1
EXIT_USAGE = 2

TABLE_HEADER_SWITCH = "RAG_TABLE_HEADER_REPEAT"
TABLE_HEADER_OFF = "profile"
TABLE_HEADER_ON = "always"
TABLE_SPLIT_SLICE = "category:table_split"
COMPARISON_NAME = "comparison.json"
DEFAULT_NOISE = "eval/config/noise.json"
TOLERANCE = 1e-9

TABLE_HEADER_RULE = (
    "RAG_TABLE_HEADER_REPEAT defaults to always only if, in the table_header_repeat arm of the per-switch comparison "
    "(profile off, always on, paired on-minus-off over the items that count in gated slices), at least one metric of the "
    "category:table_split slice improves by more than the noise band and no gated slice, table_split included, drops on any "
    "metric by more than the noise band; otherwise it stays profile and the reason (no_gain, regression with the failing "
    "slices, or insufficient_evidence) is recorded."
)
WIRING_PROOF_CAVEAT = (
    "Fixture evidence: the runs use the fixture corpus and the fixture embedder (wiring proof, plan 03.2-66). The live checks "
    "of plan 03.2-53 re-observe the switch; this record is recomputed when the committed comparison changes."
)

Decision = Literal["always", "profile"]
Reason = Literal["gain_without_regression", "no_gain", "regression", "insufficient_evidence"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SourceRef(_Model):
    path: str = Field(min_length=1)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class RunIds(_Model):
    off: str | None
    on: str | None


class SliceDifference(_Model):
    slice: str
    metric: str
    n: int = Field(ge=0)
    off: float | None
    on: float | None
    mean_d: float
    ci_low: float | None
    ci_high: float | None
    higher_is_better: bool
    beyond_band: bool
    direction: Literal["up", "down", "none"]


class TableHeaderDecision(_Model):
    schema_version: Literal[1] = 1
    decision: Decision
    reason: Reason
    switch: Literal["RAG_TABLE_HEADER_REPEAT"] = TABLE_HEADER_SWITCH
    off_value: Literal["profile"] = TABLE_HEADER_OFF
    on_value: Literal["always"] = TABLE_HEADER_ON
    rule: str
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    source: SourceRef | None
    band: float = Field(ge=0)
    wiring_proof: bool | None
    caveat: str | None
    runs: RunIds | None
    table_split: list[SliceDifference]
    other_gated: list[SliceDifference]
    failing_slices: list[str]
    evidence_problems: list[str]


def _difference(row: Mapping[str, Any], noise: NoiseConfig, band: float) -> SliceDifference | None:
    paired = row.get("paired") or {}
    mean_d = paired.get("mean_d")
    if not isinstance(mean_d, (int, float)) or not isinstance(row.get("slice"), str) or not isinstance(row.get("metric"), str):
        return None
    higher = noise.metrics.get(row["metric"], "higher") == "higher"
    better = mean_d > 0 if higher else mean_d < 0
    return SliceDifference(
        slice=row["slice"],
        metric=row["metric"],
        n=int(row.get("n") or 0),
        off=row.get("off"),
        on=row.get("on"),
        mean_d=float(mean_d),
        ci_low=paired.get("ci_low"),
        ci_high=paired.get("ci_high"),
        higher_is_better=higher,
        beyond_band=abs(mean_d) > band + TOLERANCE,
        direction="none" if mean_d == 0 else ("up" if better else "down"),
    )


def _is_drop(row: SliceDifference) -> bool:
    return row.beyond_band and row.direction == "down"


def _is_gain(row: SliceDifference) -> bool:
    return row.beyond_band and row.direction == "up"


def _find_arm(comparison: Mapping[str, Any]) -> Mapping[str, Any] | None:
    for arm in comparison.get("arms") or []:
        if (
            isinstance(arm, Mapping)
            and arm.get("switch") == TABLE_HEADER_SWITCH
            and arm.get("off_value") == TABLE_HEADER_OFF
            and arm.get("on_value") == TABLE_HEADER_ON
        ):
            return arm
    return None


def _failure_slice(failure: str) -> str:
    return failure.split(" dropped by ", 1)[0]


def decide_table_header_default(
    comparison: Mapping[str, Any] | None,
    noise: NoiseConfig,
    *,
    date: str | None = None,
    source: SourceRef | None = None,
) -> TableHeaderDecision:
    """The D-19 rule (TABLE_HEADER_RULE) applied to the table_header_repeat arm of a schema-3 comparison.

    Beyond-band is recomputed from each paired difference and the noise floor; the rows' own flags are not trusted."""
    band = noise.floor
    base: dict[str, Any] = {
        "rule": TABLE_HEADER_RULE,
        "date": date or datetime.now(timezone.utc).date().isoformat(),
        "source": source,
        "band": band,
    }

    def insufficient(problem: str, **fields: Any) -> TableHeaderDecision:
        empty: dict[str, Any] = {"wiring_proof": None, "caveat": None, "runs": None, "table_split": [], "other_gated": []}
        return TableHeaderDecision(
            **base, **{**empty, **fields}, decision="profile", reason="insufficient_evidence", failing_slices=[], evidence_problems=[problem]
        )

    if comparison is None:
        return insufficient("comparison missing")
    if comparison.get("schema_version") != 3:
        return insufficient("comparison is not schema 3 (per-switch arms)")
    arm = _find_arm(comparison)
    if arm is None:
        return insufficient("no table_header_repeat arm (RAG_TABLE_HEADER_REPEAT profile against always) in the comparison")
    wiring = arm.get("wiring_proof")
    runs_raw = arm.get("runs")
    context: dict[str, Any] = {
        "wiring_proof": wiring if isinstance(wiring, bool) else None,
        "caveat": WIRING_PROOF_CAVEAT if wiring is True else None,
        "runs": RunIds(off=runs_raw.get("off"), on=runs_raw.get("on")) if isinstance(runs_raw, Mapping) else None,
    }
    if arm.get("status") == "not_run":
        return insufficient("the arm was not run", **context)
    if "gated_rows" not in arm:
        return insufficient("the arm records no counting rows for the gated slices (comparison predates gated_rows)", **context)
    rows = [row for row in (_difference(raw, noise, band) for raw in arm.get("gated_rows") or []) if row is not None]
    rows.sort(key=lambda row: (row.slice, row.metric))
    split = [row for row in rows if row.slice == TABLE_SPLIT_SLICE]
    others = [row for row in rows if row.slice != TABLE_SPLIT_SLICE]
    context.update(table_split=split, other_gated=others)
    if not split:
        return insufficient(f"{TABLE_SPLIT_SLICE} has no counting item in the arm's runs", **context)

    failing = {f"{row.slice}:{row.metric}" for row in rows if _is_drop(row)}
    failing |= {_failure_slice(failure) for failure in arm.get("failures") or [] if isinstance(failure, str)}
    if arm.get("status") == "failed" and not failing:
        failing.add("arm failed without a named slice")
    if failing:
        reason: Reason = "regression"
    elif any(_is_gain(row) for row in split):
        reason = "gain_without_regression"
    else:
        reason = "no_gain"
    return TableHeaderDecision(
        **base,
        **context,
        decision="always" if reason == "gain_without_regression" else "profile",
        reason=reason,
        failing_slices=sorted(failing),
        evidence_problems=[],
    )


def render(record: TableHeaderDecision) -> str:
    return json.dumps(record.model_dump(mode="json"), indent=2, sort_keys=False, ensure_ascii=False) + "\n"


def _resolve(raw: str, *, parent_must_exist: bool = False) -> Path:
    path = Path(raw)
    if path.is_absolute():
        return path
    local = Path.cwd() / path
    probe = local.parent if parent_must_exist else local
    return local if probe.exists() else REPO_ROOT / path


def _load_comparison(report: Path) -> tuple[dict[str, Any] | None, SourceRef | None]:
    path = report / COMPARISON_NAME if report.is_dir() else report
    if not path.is_file():
        return None, None
    data = path.read_bytes()
    try:
        payload = json.loads(data)
    except json.JSONDecodeError:
        payload = None
    source = SourceRef(path=repo_relative(path), sha256=hashlib.sha256(data).hexdigest())
    return (payload if isinstance(payload, dict) else None), source


def _recorded_date(out: Path) -> str | None:
    try:
        return TableHeaderDecision.model_validate_json(out.read_text(encoding="utf-8")).date
    except (OSError, ValidationError, ValueError):
        return None


def _table_header_default(args: argparse.Namespace) -> int:
    noise_path = _resolve(args.noise)
    try:
        noise = NoiseConfig.model_validate_json(noise_path.read_text(encoding="utf-8"))
    except (OSError, ValidationError) as exc:
        print(f"error: noise config {noise_path}: {exc}", file=sys.stderr)
        return EXIT_USAGE
    out = _resolve(args.out, parent_must_exist=True)
    comparison, source = _load_comparison(_resolve(args.report))
    date = args.date or _recorded_date(out)
    record = decide_table_header_default(comparison, noise, date=date, source=source)
    text = render(record)
    if args.check:
        current = out.read_text(encoding="utf-8") if out.is_file() else None
        if current != text:
            print(f"[Decisions] {repo_relative(out)} differs from the record recomputed from the committed comparison", file=sys.stderr)
            return EXIT_DIFFERS
        print(f"[Decisions] {repo_relative(out)} is current: {record.decision} ({record.reason})")
        return EXIT_OK
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(out)
    print(f"[Decisions] {repo_relative(out)}: {record.decision} ({record.reason})")
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.decisions", description="Shipped-default decisions computed by a fixed rule")
    commands = parser.add_subparsers(dest="command", required=True)
    table = commands.add_parser("table-header-default", help="D-19: the default of RAG_TABLE_HEADER_REPEAT")
    table.add_argument("--report", required=True, help="directory holding comparison.json, or the file itself")
    table.add_argument("--out", required=True)
    table.add_argument("--noise", default=DEFAULT_NOISE)
    table.add_argument("--date", help="record date (YYYY-MM-DD); default: the date already recorded in --out, else today (UTC)")
    table.add_argument("--check", action="store_true", help="recompute and fail when the committed record differs; writes nothing")
    args = parser.parse_args(argv)
    if args.command == "table-header-default":
        return _table_header_default(args)
    return EXIT_USAGE


if __name__ == "__main__":
    raise SystemExit(main())
