"""Judge calibration (Phase 5.3 D-28 to D-31): agreement of each judge role with confirmed human labels.

A cell (judge fingerprint, role, language, library.metric) gates only when it measurably agrees with confirmed labels;
`effective_status` demotes a cell whose fingerprint no longer matches the running judge or whose run has expired.
The committed calibration file holds numbers and codes only.
"""

import argparse
import hashlib
import importlib
import importlib.metadata
import inspect
import json
import math
import os
import sys
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Literal

from pydantic import ValidationError
from rag_sidecar.contracts.judge import JudgeConfig
from rag_sidecar.contracts.judge_calibration import (
    JudgeCalibration,
    JudgeCalibrationCell,
    JudgeLabelSource,
    JudgeRole,
    JudgeSeedCase,
)
from rag_sidecar.contracts.quality_gates import METRIC_FORMS, QualityGates
from rag_sidecar.contracts.retrieval import ConfigProvenance

import rag_eval.judge  # noqa: F401  (applies the telemetry opt-out before the judge libraries load)
from rag_eval.config_files import finalize_config, write_config_atomically
from rag_eval.draft import writer
from rag_eval.judge.config import (
    DEFAULT_CONFIG_PATH,
    JudgeCase,
    JudgeFamilyError,
    JudgeFatalError,
    assert_judge_family_differs,
    load_judge_config,
)
from rag_eval.judge.run import (
    EXIT_FAMILY,
    EXIT_INPUT,
    EXIT_KEY,
    EXIT_OK,
    EXIT_PROVIDER,
    MISSING_KEY_NOTICE,
)
from rag_eval.judge.telemetry import check_no_results_upload
from rag_eval.paths import REPO_ROOT, resolve_cli_path
from rag_eval.stats import accuracy, bootstrap_interval, cohen_kappa, recall_precision

DEFAULT_SEED_PATH = REPO_ROOT / "eval" / "fixtures" / "judge-calibration" / "seed.jsonl"
DEFAULT_CALIBRATION_PATH = REPO_ROOT / "eval" / "config" / "judge-calibration.json"
DEFAULT_GATES_PATH = REPO_ROOT / "eval" / "config" / "quality-gates.json"
DEFAULT_OUT = REPO_ROOT / "eval" / "out" / "judge-calibration"
REPORT_NAME = "judge-calibration.md"
CELLS_NAME = "judge-calibration-cells.json"
PRIVATE_SUBDIR = "judge-calibration"
EXPORT_ROUTE = "/api/rag/admin/judge-calibration/export"
TOKEN_ENV = "RAG_ADMIN_BEARER"
QUEUE_SKIP = "skipping the review-queue judge calibration"
QUEUE_REVIEWER = "review_queue"
QUEUE_ID_PREFIX = "rq-"
PARTIAL_ANSWER_METRIC = "partial_answer"

ROLE_LIBRARIES: dict[str, tuple[str, ...]] = {"nightly": ("deepeval", "ragas"), "online": ("deepeval",)}
ROLES: tuple[JudgeRole, ...] = ("nightly", "online")
CALIBRATED_METRICS = tuple(metric for metric, form in METRIC_FORMS.items() if form != "holistic")
INTERVAL_SEED = 20261123
INTERVAL_ROUNDS = 1000
DIGITS = 6

EffectiveStatus = Literal["gating", "report_only", "uncalibrated"]
Scores = Mapping[tuple[str, str, str], float | None]
JudgeScorer = Callable[[list[JudgeCase]], Scores]
JudgeFactory = Callable[[str, JudgeConfig], JudgeScorer]

_DEEPEVAL_TEMPLATES = {
    "faithfulness": ("FaithfulnessMetric", "FaithfulnessTemplate"),
    "answer_relevance": ("AnswerRelevancyMetric", "AnswerRelevancyTemplate"),
}
_RAGAS_PROMPT_MODULES = {
    "faithfulness": "ragas.metrics.collections.faithfulness.util",
    "answer_relevance": "ragas.metrics.collections.answer_relevancy.util",
}


@dataclass(frozen=True)
class CellDetail:
    """A cell plus the report-only extras that are not stored: the seeded kappa interval and the positive share."""

    cell: JudgeCalibrationCell
    kappa_interval: tuple[float | None, float | None]
    positive_share: float | None


def judge_roles(config: JudgeConfig) -> dict[str, JudgeConfig]:
    """The configured judge roles: nightly always, online when judge.json names an online judge."""
    roles: dict[str, JudgeConfig] = {"nightly": config}
    online = config.online_judge
    if online is not None:
        roles["online"] = config.model_copy(update={"judge_model": online.judge_model, "judge_family": online.judge_family})
    return roles


def _installed_versions(libraries: Iterable[str]) -> dict[str, str | None]:
    versions: dict[str, str | None] = {}
    for library in libraries:
        try:
            versions[library] = importlib.metadata.version(library)
        except importlib.metadata.PackageNotFoundError:
            versions[library] = None
    return versions


def _rubric_source(library: str, metric: str) -> str | None:
    try:
        if library == "deepeval":
            metric_name, template_name = _DEEPEVAL_TEMPLATES[metric]
            metrics = importlib.import_module("deepeval.metrics")
            module = sys.modules[getattr(metrics, metric_name).__module__]
            return inspect.getsource(getattr(module, template_name))
        if library == "ragas":
            return inspect.getsource(importlib.import_module(_RAGAS_PROMPT_MODULES[metric]))
    except (AttributeError, ImportError, KeyError, OSError, TypeError):
        return None
    return None


def installed_rubrics(libraries: Iterable[str]) -> dict[str, str | None]:
    """Prompt or rubric text per library.metric where the installed library exposes it; None where it does not."""
    return {f"{library}.{metric}": _rubric_source(library, metric) for library in libraries for metric in CALIBRATED_METRICS}


def judge_fingerprint(
    role: str,
    config: JudgeConfig,
    *,
    versions: Mapping[str, str | None] | None = None,
    rubrics: Mapping[str, str | None] | None = None,
) -> str:
    """sha256 of the role, model id, temperature, library versions and rubric text; a missing rubric leaves the version."""
    libraries = ROLE_LIBRARIES.get(role, ("deepeval",))
    resolved_versions = dict(versions) if versions is not None else _installed_versions(libraries)
    resolved_rubrics = dict(rubrics) if rubrics is not None else installed_rubrics(libraries)
    payload = {
        "role": role,
        "judge_model": config.judge_model,
        "judge_family": config.judge_family,
        "temperature": config.temperature,
        "libraries": {library: resolved_versions.get(library) for library in sorted(resolved_versions)},
        "rubrics": {
            key: None if text is None else hashlib.sha256(text.encode("utf-8")).hexdigest()
            for key, text in sorted(resolved_rubrics.items())
        },
    }
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, DIGITS)


def _mean(values: Sequence[float]) -> float | None:
    return math.fsum(values) / len(values) if values else None


def _judge_case(case: JudgeSeedCase) -> JudgeCase:
    return JudgeCase(item_id=case.id, question=case.question, answer=case.answer, contexts=list(case.contexts))


def _score(scores: Scores, library: str, case_id: str, metric: str) -> float | None:
    value = scores.get((library, case_id, metric))
    return None if value is None else float(value)


def _length_bias(cases: Sequence[JudgeSeedCase], scores: Scores, library: str, metric: str) -> float | None:
    """Mean of long minus short score over complete long/short pairs of correct answers."""
    pairs: dict[str, dict[str, float]] = {}
    for case in cases:
        if case.variant not in ("long", "short") or case.expected.get(metric) is False:
            continue
        value = _score(scores, library, case.id, metric)
        if value is not None:
            pairs.setdefault(case.pair_id or case.base_id or case.id, {})[case.variant] = value
    deltas = [pair["long"] - pair["short"] for _, pair in sorted(pairs.items()) if {"long", "short"} <= set(pair)]
    return _mean(deltas)


def _probe(cases: Sequence[JudgeSeedCase], scores: Scores, library: str, metric: str, variant: str) -> float | None:
    """Mean of variant score minus its base case's score."""
    deltas: list[float] = []
    for case in cases:
        if case.variant != variant or case.base_id is None:
            continue
        value = _score(scores, library, case.id, metric)
        base = _score(scores, library, case.base_id, metric)
        if value is not None and base is not None:
            deltas.append(value - base)
    return _mean(deltas)


def _reasons(
    *,
    n: int,
    minimum: int,
    kappa: float | None,
    accuracy_value: float | None,
    length_bias: float | None,
    expanded: float | None,
    assertive: float | None,
    confirmed: bool,
    gates: QualityGates,
) -> list[str]:
    rules = gates.judge
    reasons: list[str] = []
    if n < minimum:
        reasons.append("n_below_minimum")
    if kappa is None:
        if n > 0:
            reasons.append("kappa_undefined")
    elif kappa < rules.kappa_floor:
        reasons.append("kappa_below_floor")
    if accuracy_value is not None and accuracy_value < rules.accuracy_floor:
        reasons.append("accuracy_below_floor")
    if length_bias is not None and abs(length_bias) > rules.length_bias_max_delta:
        reasons.append("length_bias")
    if any(delta is not None and abs(delta) > rules.perturbation_max_delta for delta in (expanded, assertive)):
        reasons.append("perturbation")
    if not confirmed:
        reasons.append("labels_not_confirmed")
    if n == 0 and not reasons:
        reasons.append("n_below_minimum")
    return reasons


def _minimum(gates: QualityGates, source: str) -> int:
    return gates.judge.seed_min_labels_per_language if source == "seed" else gates.judge.min_labels_per_language


def _cell_detail(
    *,
    role: str,
    fingerprint: str,
    language: str,
    library: str,
    metric: str,
    cases: Sequence[JudgeSeedCase],
    scores: Scores,
    gates: QualityGates,
    source: JudgeLabelSource,
    recorded_at: str,
) -> CellDetail | None:
    threshold = gates.judge.pass_threshold.get(metric)
    labelled = [case for case in cases if case.variant == "base" and metric in case.expected]
    if threshold is None or not labelled:
        return None
    agreement: list[tuple[bool, bool]] = []
    unsupported: list[tuple[bool, bool]] = []
    for case in labelled:
        value = _score(scores, library, case.id, metric)
        if value is None:
            continue
        verdict = value >= threshold
        agreement.append((verdict, case.expected[metric]))
        unsupported.append((not verdict, case.unsupported_content))
    kappa = cohen_kappa(agreement)
    accuracy_value = accuracy(agreement)
    recall, precision = recall_precision(unsupported)
    length_bias = _length_bias(cases, scores, library, metric)
    expanded = _probe(cases, scores, library, metric, "expanded")
    assertive = _probe(cases, scores, library, metric, "assertive")
    confirmed = all(case.review_status == "approved" for case in cases)
    reasons = _reasons(
        n=len(agreement),
        minimum=_minimum(gates, source),
        kappa=kappa,
        accuracy_value=accuracy_value,
        length_bias=length_bias,
        expanded=expanded,
        assertive=assertive,
        confirmed=confirmed,
        gates=gates,
    )
    cell = JudgeCalibrationCell(
        key=f"{fingerprint}|{role}|{language}|{library}.{metric}",
        fingerprint=fingerprint,
        role=role,
        language=language,
        library=library,
        metric=metric,
        status="report_only" if reasons else "gating",
        reasons=reasons,
        kappa=_round(kappa),
        accuracy=_round(accuracy_value),
        n=len(agreement),
        source=source,
        unsupported_recall=_round(recall),
        unsupported_precision=_round(precision),
        length_bias_delta=_round(length_bias),
        expanded_delta=_round(expanded),
        assertive_delta=_round(assertive),
        labels_human_confirmed=confirmed,
        recorded_at=recorded_at,
    )
    low, high = bootstrap_interval(agreement, cohen_kappa, seed=INTERVAL_SEED, rounds=INTERVAL_ROUNDS)
    positives = sum(1 for _, human in agreement if human)
    return CellDetail(
        cell=cell,
        kappa_interval=(_round(low), _round(high)),
        positive_share=positives / len(agreement) if agreement else None,
    )


def calibrate_with_details(
    cases: Sequence[JudgeSeedCase],
    judge_factory: JudgeFactory,
    gates: QualityGates,
    source: JudgeLabelSource | Mapping[str, JudgeLabelSource],
    *,
    judges: Mapping[str, JudgeConfig],
    fingerprints: Mapping[str, str] | None = None,
    recorded_at: str | None = None,
) -> list[CellDetail]:
    """Score every case with each judge role and measure agreement per language, library and metric (D-28, D-29).

    Agreement uses base cases only, so variants of one answer count once; variants feed the bias and probe deltas.
    """
    stamp = recorded_at or _now()
    ids = [case.id for case in cases]
    if len(set(ids)) != len(ids):
        raise ValueError("seed case ids must be unique")
    by_language: dict[str, list[JudgeSeedCase]] = {}
    for case in sorted(cases, key=lambda entry: entry.id):
        by_language.setdefault(case.language, []).append(case)
    judged = [_judge_case(case) for case in sorted(cases, key=lambda entry: entry.id)]
    details: list[CellDetail] = []
    for role in ROLES:
        config = judges.get(role)
        if config is None:
            continue
        fingerprint = (fingerprints or {}).get(role) or judge_fingerprint(role, config)
        scores = judge_factory(role, config)(judged)
        for language in sorted(by_language):
            for library in ROLE_LIBRARIES[role]:
                for metric in CALIBRATED_METRICS:
                    detail = _cell_detail(
                        role=role,
                        fingerprint=fingerprint,
                        language=language,
                        library=library,
                        metric=metric,
                        cases=by_language[language],
                        scores=scores,
                        gates=gates,
                        source=source if isinstance(source, str) else source[language],
                        recorded_at=stamp,
                    )
                    if detail is not None:
                        details.append(detail)
    return details


def calibrate(
    cases: Sequence[JudgeSeedCase],
    judge_factory: JudgeFactory,
    gates: QualityGates,
    source: JudgeLabelSource | Mapping[str, JudgeLabelSource],
    *,
    judges: Mapping[str, JudgeConfig],
    fingerprints: Mapping[str, str] | None = None,
    recorded_at: str | None = None,
) -> list[JudgeCalibrationCell]:
    details = calibrate_with_details(
        cases, judge_factory, gates, source, judges=judges, fingerprints=fingerprints, recorded_at=recorded_at
    )
    return [detail.cell for detail in details]


def _recorded_on(value: str) -> date | None:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed.astimezone(UTC).date() if parsed.tzinfo else parsed.date()


def effective_status(
    cell: JudgeCalibrationCell, running_fingerprint: str | None, today: date, max_age_days: int
) -> EffectiveStatus:
    """Read-time status (D-29): a changed judge or an expired run is uncalibrated, which means report-only."""
    if not running_fingerprint or cell.fingerprint != running_fingerprint:
        return "uncalibrated"
    recorded = _recorded_on(cell.recorded_at)
    if recorded is None or (today - recorded).days > max_age_days:
        return "uncalibrated"
    return cell.status


def _dimension(cell: JudgeCalibrationCell) -> tuple[str, str, str, str]:
    return cell.role, cell.language, cell.library, cell.metric


def merge_cells(
    existing: JudgeCalibration | None,
    cells: Iterable[JudgeCalibrationCell],
    running_fingerprints: Mapping[str, str],
) -> JudgeCalibration:
    """Replace cells with the same key; a new cell also retires older cells of its dimension under another fingerprint."""
    fresh = list(cells)
    replaced = {_dimension(cell) for cell in fresh}
    kept = {cell.key: cell for cell in (existing.cells if existing else []) if _dimension(cell) not in replaced}
    for cell in fresh:
        kept[cell.key] = cell
    running = {**(existing.running_fingerprints if existing else {}), **running_fingerprints}
    model = JudgeCalibration(
        cells=[kept[key] for key in sorted(kept)],
        running_fingerprints=dict(sorted(running.items())),
        provenance=ConfigProvenance(source="calibration"),
    )
    return finalize_config(model, provenance_source="calibration")


def load_seed(path: Path) -> list[JudgeSeedCase]:
    cases: list[JudgeSeedCase] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            cases.append(JudgeSeedCase.model_validate_json(line))
        except ValidationError as exc:
            raise ValueError(f"{path}:{number}: not a valid seed case: {exc.error_count()} error(s)") from exc
    if not cases:
        raise ValueError(f"{path}: no seed cases")
    return cases


class ReviewQueueSourceError(Exception):
    """The export could not be read; the message names the status or exception type only, never the token or text."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class ReviewQueuePull:
    cases: list[JudgeSeedCase]
    dropped: int


def _http_client():
    import httpx

    return httpx.Client(timeout=30.0)


def _queue_case(raw: object) -> JudgeSeedCase | None:
    """One exported case as a confirmed calibration case: the latest expert label is the human verdict."""
    if not isinstance(raw, dict):
        return None
    labels = raw.get("labels")
    contexts = raw.get("contexts")
    item_id = raw.get("item_id")
    if not isinstance(labels, list) or not labels or not isinstance(contexts, list) or not isinstance(item_id, str):
        return None
    dated = [label for label in labels if isinstance(label, dict)]
    if len(dated) != len(labels):
        return None
    latest = max(dated, key=lambda label: str(label.get("labelled_at") or ""))
    texts = [context.get("text") if isinstance(context, dict) else None for context in contexts]
    try:
        return JudgeSeedCase.model_validate(
            {
                "id": QUEUE_ID_PREFIX + item_id.lower(),
                "language": raw.get("language"),
                "question": raw.get("question"),
                "contexts": texts,
                "answer": raw.get("answer"),
                "expected": {"faithfulness": latest.get("supported"), "answer_relevance": latest.get("relevant")},
                "unsupported_content": latest.get("unsupported_content"),
                "review_status": "approved",
                "reviewed_by": QUEUE_REVIEWER,
            }
        )
    except ValidationError:
        return None


def pull_review_queue_cases(base_url: str, tenant_key: str, token: str) -> ReviewQueuePull:
    """Expert-labelled cases of one tenant from the app's judge-calibration/export route (D-31); text stays in memory."""
    url = base_url.rstrip("/") + EXPORT_ROUTE
    try:
        with _http_client() as client:
            response = client.get(url, params={"tenant": tenant_key}, headers={"Authorization": f"Bearer {token}"})
    except Exception as exc:  # noqa: BLE001  (any transport failure is a skip; only the type name is kept)
        raise ReviewQueueSourceError(f"judge-calibration export request failed: {type(exc).__name__}") from None
    if response.status_code != 200:
        raise ReviewQueueSourceError(
            f"judge-calibration export answered HTTP {response.status_code}", status=response.status_code
        )
    try:
        payload = response.json()
    except ValueError:
        raise ReviewQueueSourceError("judge-calibration export answered a body that is not JSON") from None
    raw_cases = payload.get("cases") if isinstance(payload, dict) else None
    if not isinstance(raw_cases, list):
        raise ReviewQueueSourceError("judge-calibration export answered without a cases list")
    cases: list[JudgeSeedCase] = []
    seen: set[str] = set()
    dropped = 0
    for raw in raw_cases:
        case = _queue_case(raw)
        if case is None or case.id in seen:
            dropped += 1
            continue
        seen.add(case.id)
        cases.append(case)
    return ReviewQueuePull(cases=cases, dropped=dropped)


def _confirmed_seed(cases: Sequence[JudgeSeedCase]) -> list[JudgeSeedCase]:
    approved = {case.id for case in cases if case.review_status == "approved" and case.variant == "base"}
    return [
        case
        for case in cases
        if case.review_status == "approved" and (case.variant == "base" or case.base_id in approved)
    ]


def combine_sources(
    queue: Sequence[JudgeSeedCase], seed: Sequence[JudgeSeedCase], gates: QualityGates
) -> tuple[list[JudgeSeedCase], dict[str, JudgeLabelSource]]:
    """Queue cases per language; confirmed seed cases fill a language that has fewer than the review-queue minimum."""
    minimum = gates.judge.min_labels_per_language
    confirmed = _confirmed_seed(seed)
    languages = sorted({case.language for case in queue} | {case.language for case in confirmed})
    combined: list[JudgeSeedCase] = []
    sources: dict[str, JudgeLabelSource] = {}
    for language in languages:
        own = [case for case in queue if case.language == language]
        fill = [case for case in confirmed if case.language == language]
        if len(own) >= minimum or not fill:
            sources[language] = "review_queue"
            combined.extend(own)
        elif not own:
            sources[language] = "seed"
            combined.extend(fill)
        else:
            sources[language] = "mixed"
            combined.extend(own + fill)
    return combined, sources


def _fmt(value: float | None, digits: int = 3) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def _interval(detail: CellDetail) -> str:
    low, high = detail.kappa_interval
    return "n/a" if low is None or high is None else f"[{_fmt(low)}, {_fmt(high)}]"


def summary_line(detail: CellDetail) -> str:
    cell = detail.cell
    reasons = ",".join(cell.reasons) or "-"
    return (
        f"{cell.role} {cell.language} {cell.library}.{cell.metric}: {cell.status} "
        f"kappa={_fmt(cell.kappa)} {_interval(detail)} n={cell.n} accuracy={_fmt(cell.accuracy)} reasons={reasons}"
    )


def render_markdown(
    details: Sequence[CellDetail], fingerprints: Mapping[str, str], rubric_missing: Mapping[str, list[str]]
) -> str:
    lines = ["# Judge calibration", ""]
    lines += ["| Role | Fingerprint | Rubric text |", "| --- | --- | --- |"]
    for role in sorted(fingerprints):
        missing = rubric_missing.get(role) or []
        note = "hashed" if not missing else "version stands in for " + ", ".join(missing)
        lines.append(f"| {role} | `{fingerprints[role]}` | {note} |")
    lines += [
        "",
        ("Kappa uses base cases only (variants count once); the interval is a seeded 95% bootstrap. "
        "A cell gates only with enough confirmed labels, kappa and accuracy at their floors and bias and probe "
        "deltas within tolerance."),
        "",
        ("| Role | Language | Metric | Status | Reasons | Kappa | 95% interval | Accuracy | n | Positive share | "
        "Unsupported recall | Unsupported precision | Length bias | Expanded | Assertive | Source |"),
        "|" + " --- |" * 16,
    ]
    for detail in details:
        cell = detail.cell
        lines.append(
            f"| {cell.role} | {cell.language} | {cell.library}.{cell.metric} | {cell.status} | "
            f"{', '.join(cell.reasons) or '-'} | {_fmt(cell.kappa)} | {_interval(detail)} | {_fmt(cell.accuracy)} | "
            f"{cell.n} | {_fmt(detail.positive_share)} | {_fmt(cell.unsupported_recall)} | "
            f"{_fmt(cell.unsupported_precision)} | {_fmt(cell.length_bias_delta)} | {_fmt(cell.expanded_delta)} | "
            f"{_fmt(cell.assertive_delta)} | {cell.source} |"
        )
    if not details:
        lines.append("| - | - | - | - | - | - | - | - | 0 | - | - | - | - | - | - | - |")
    return "\n".join(lines) + "\n"


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def _live_factory(openrouter_key: str, openai_key: str) -> JudgeFactory:
    def build(role: str, config: JudgeConfig) -> JudgeScorer:
        from rag_eval.judge.deepeval_judge import OpenRouterDeepEvalLLM, score_deepeval

        deepeval_llm = OpenRouterDeepEvalLLM(config, openrouter_key)
        ragas = None
        if "ragas" in ROLE_LIBRARIES[role]:
            from rag_eval.judge.ragas_judge import build_ragas_live

            ragas = build_ragas_live(config, openrouter_key, openai_key)

        def score(cases: list[JudgeCase]) -> Scores:
            out: dict[tuple[str, str, str], float | None] = {}
            for (item_id, metric), (value, _reason) in score_deepeval(cases, deepeval_llm, config.max_concurrency).items():
                out[("deepeval", item_id, metric)] = value
            if ragas is not None:
                from rag_eval.judge.ragas_judge import score_ragas

                llm, embeddings = ragas
                for (item_id, metric), (value, _reason) in score_ragas(cases, llm, embeddings, config.max_concurrency).items():
                    out[("ragas", item_id, metric)] = value
            return out

        return score

    return build


def _fail(message: str, code: int) -> int:
    print(f"error: {message}", file=sys.stderr)
    return code


def _read_calibration(path: Path) -> JudgeCalibration | None:
    if not path.is_file():
        return None
    return JudgeCalibration.model_validate_json(path.read_text(encoding="utf-8"))


def _private_out(args: argparse.Namespace) -> Path:
    """The tenant path writes only under eval/golden/private/ (D-31)."""
    out_dir = resolve_cli_path(args.out) if args.out is not None else writer.PRIVATE_DIR / PRIVATE_SUBDIR
    for name in (REPORT_NAME, CELLS_NAME):
        writer.assert_private_path(out_dir / name)
    return out_dir


def _pull_queue(args: argparse.Namespace) -> ReviewQueuePull | int:
    token = os.environ.get(TOKEN_ENV) or None
    if token is None:
        print(f"::notice::{TOKEN_ENV} is not set, {QUEUE_SKIP}")
        return EXIT_OK
    try:
        pulled = pull_review_queue_cases(args.base_url, args.tenant, token)
    except ReviewQueueSourceError as exc:
        if exc.status == 400:
            return _fail(str(exc), EXIT_INPUT)
        print(f"::notice::{exc}, {QUEUE_SKIP}")
        return EXIT_OK
    print(f"pulled {len(pulled.cases)} review-queue case(s)")
    if pulled.dropped:
        print(f"dropped {pulled.dropped} export case(s) that failed validation")
    return pulled


def _run(args: argparse.Namespace, judge_factory: JudgeFactory | None) -> int:
    try:
        check_no_results_upload()
    except RuntimeError as exc:
        return _fail(str(exc), EXIT_INPUT)
    tenant_path = bool(args.tenant or args.base_url)
    if tenant_path:
        if not (args.tenant and args.base_url):
            return _fail("--tenant and --base-url go together", EXIT_INPUT)
        if args.seed_only:
            return _fail("--seed-only and --tenant exclude each other", EXIT_INPUT)
        try:
            out_dir = _private_out(args)
        except writer.PrivatePathError as exc:
            return _fail(str(exc), EXIT_INPUT)
    else:
        out_dir = resolve_cli_path(args.out if args.out is not None else DEFAULT_OUT)
    try:
        config = load_judge_config(resolve_cli_path(args.config))
        gates = QualityGates.model_validate_json(resolve_cli_path(args.gates).read_text(encoding="utf-8"))
        seed_path = resolve_cli_path(args.seed)
        seed = load_seed(seed_path) if not tenant_path or seed_path.is_file() else []
        calibration_path = resolve_cli_path(args.calibration)
        existing = _read_calibration(calibration_path) if args.write else None
    except (OSError, ValidationError, ValueError) as exc:
        return _fail(str(exc), EXIT_INPUT)
    judges = judge_roles(config)
    try:
        for role_config in judges.values():
            assert_judge_family_differs(role_config, args.generator_model)
    except JudgeFamilyError as exc:
        return _fail(str(exc), EXIT_FAMILY)
    factory = judge_factory
    if factory is None:
        openrouter_key = os.environ.get("OPENROUTER_API_KEY") or None
        openai_key = os.environ.get("OPENAI_API_KEY") or None
        for name, value in (("OPENROUTER_API_KEY", openrouter_key), ("OPENAI_API_KEY", openai_key)):
            if value is None:
                print(f"{MISSING_KEY_NOTICE}: {name} is not set", file=sys.stderr)
                return EXIT_KEY
        assert openrouter_key is not None and openai_key is not None
        factory = _live_factory(openrouter_key, openai_key)
    sources: JudgeLabelSource | dict[str, JudgeLabelSource] = "seed"
    cases = seed
    if tenant_path:
        pulled = _pull_queue(args)
        if isinstance(pulled, int):
            return pulled
        cases, sources = combine_sources(pulled.cases, seed, gates)
        if not cases:
            print(f"::notice::no labelled cases to calibrate, {QUEUE_SKIP}")
            return EXIT_OK
    if PARTIAL_ANSWER_METRIC not in METRIC_FORMS:
        print(f"::notice::the {PARTIAL_ANSWER_METRIC} judge metric is not defined on this branch; it is not calibrated")
    fingerprints: dict[str, str] = {}
    rubric_missing: dict[str, list[str]] = {}
    for role, role_config in judges.items():
        libraries = ROLE_LIBRARIES[role]
        rubrics = installed_rubrics(libraries)
        fingerprints[role] = judge_fingerprint(role, role_config, rubrics=rubrics)
        rubric_missing[role] = sorted(key for key, text in rubrics.items() if text is None)
    try:
        details = calibrate_with_details(cases, factory, gates, sources, judges=judges, fingerprints=fingerprints)
    except JudgeFatalError as exc:
        return _fail(str(exc), EXIT_PROVIDER)
    except JudgeFamilyError as exc:
        return _fail(str(exc), EXIT_FAMILY)
    except ValueError as exc:
        return _fail(str(exc), EXIT_INPUT)
    for detail in details:
        print(summary_line(detail))
    _write_text(out_dir / REPORT_NAME, render_markdown(details, fingerprints, rubric_missing))
    cells_payload = {
        "cells": [detail.cell.model_dump(mode="json") for detail in details],
        "running_fingerprints": fingerprints,
    }
    _write_text(out_dir / CELLS_NAME, json.dumps(cells_payload, indent=2, sort_keys=True) + "\n")
    print(f"wrote {out_dir / REPORT_NAME}")
    if args.write:
        merged = merge_cells(existing, [detail.cell for detail in details], fingerprints)
        write_config_atomically(calibration_path, merged)
        print(f"wrote {calibration_path}")
    return EXIT_OK


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rag_eval.judge_calibration", description="myRAG judge calibration (D-28)")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="score a labelled sample with each judge role and report agreement per cell")
    run.add_argument("--seed-only", action="store_true", help="use the seed set only (minimum 50 labels per language)")
    run.add_argument("--seed", type=Path, default=DEFAULT_SEED_PATH)
    run.add_argument("--tenant", help="tenant key whose expert-labelled review-queue cases are pulled (D-31)")
    run.add_argument("--base-url", help="app base URL for the judge-calibration export (admin Bearer in RAG_ADMIN_BEARER)")
    run.add_argument("--generator-model", required=True, help="generator model id; the judge family must differ")
    run.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    run.add_argument("--gates", type=Path, default=DEFAULT_GATES_PATH)
    run.add_argument("--calibration", type=Path, default=DEFAULT_CALIBRATION_PATH)
    run.add_argument("--write", action="store_true", help="merge the cells into the calibration file")
    run.add_argument(
        "--out", type=Path, default=None, help="report directory; with --tenant it must be inside eval/golden/private/"
    )
    return parser


def main(argv: list[str] | None = None, *, judge_factory: JudgeFactory | None = None) -> int:
    args = _parser().parse_args(argv)
    return _run(args, judge_factory)


if __name__ == "__main__":
    raise SystemExit(main())
