"""D-27 (GEN-11): judge calibration, the only writer of eval/config/groundedness-judge-thresholds.json."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from rag_sidecar.contracts.claims import GroundednessJudgeThresholdCell, GroundednessJudgeThresholds

from rag_eval.config_files import write_config_atomically
from rag_eval.paths import REPO_ROOT, repo_relative

FAKE_JUDGE = "fake"
# eval/harness/fake-answer-models.mts FAKE_JUDGE_MODEL: the only id a fixture cell may carry.
FAKE_JUDGE_MODEL = "fake/judge-v1"
HARNESS_SCRIPT = "eval/harness/run-judge.mts"
FIXTURES_DIR = REPO_ROOT / "eval" / "fixtures"
DEFAULT_LABELLED = FIXTURES_DIR / "judge" / "labelled-answers.jsonl"
THRESHOLDS_PATH = REPO_ROOT / "eval" / "config" / "groundedness-judge-thresholds.json"
EVAL_OUT = REPO_ROOT / "eval" / "out"
DEFAULT_REPORT_DIR = EVAL_OUT / "calibrate-groundedness-judge"
RESULT_NAME = "groundedness-judge-calibration.json"
REPORT_NAME = "groundedness-judge-calibration.md"
JUDGED_NAME = "judged.jsonl"
DEV_SPLIT = "dev"
TEST_SPLIT = "test"
DEV_MIN_PER_CLASS = 4
TEST_MIN_PER_CLASS = 3
CHANCE = 0.5
EPSILON = 1e-12
TAIL_LINES = 20

Spawner = Callable[[list[str], Path], Any]


class JudgeCalibrationError(RuntimeError):
    pass


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class LabelledPremise(_Model):
    ref: str = Field(pattern=r"^S[1-9][0-9]*$")
    text: str = Field(min_length=1)


class LabelledSentence(_Model):
    index: int = Field(ge=0)
    text: str = Field(min_length=1)
    premise_refs: list[str] = Field(min_length=1)
    label: Literal["supported", "unsupported"]


class LabelledAnswer(_Model):
    id: str = Field(min_length=1)
    language: str = Field(min_length=1)
    split: Literal["dev", "test"]
    premises: list[LabelledPremise] = Field(min_length=1)
    sentences: list[LabelledSentence] = Field(min_length=1)

    @model_validator(mode="after")
    def _unique(self) -> "LabelledAnswer":
        indexes = [sentence.index for sentence in self.sentences]
        refs = [premise.ref for premise in self.premises]
        if len(indexes) != len(set(indexes)) or len(refs) != len(set(refs)):
            raise ValueError("sentence indexes and premise refs must not repeat")
        return self

    @property
    def faithful(self) -> bool:
        return all(sentence.label == "supported" for sentence in self.sentences)


class JudgedVerdict(_Model):
    index: int = Field(ge=0)
    verdict: Literal["supported", "unsupported", "not_enough_info"]


class JudgedAnswer(_Model):
    id: str
    language: str
    split: Literal["dev", "test"]
    status: Literal["judged", "not_checked"]
    reason: str | None = None
    judge_model: str | None = None
    judge_version: str | None = None
    verdicts: list[JudgedVerdict] = Field(default_factory=list)


def load_labelled(path: Path) -> list[LabelledAnswer]:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise JudgeCalibrationError(f"cannot read labelled answers {path}: {exc}") from exc
    answers: list[LabelledAnswer] = []
    seen: set[str] = set()
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            answer = LabelledAnswer.model_validate_json(line)
        except ValidationError as exc:
            raise JudgeCalibrationError(f"{path}:{number}: malformed labelled answer: {exc}") from exc
        if answer.id in seen:
            raise JudgeCalibrationError(f"{path}:{number}: duplicate id {answer.id!r}")
        seen.add(answer.id)
        answers.append(answer)
    if not answers:
        raise JudgeCalibrationError(f"{path} holds no labelled answers")
    return answers


def default_spawner(argv: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, check=False, env=os.environ.copy())


def _tail(text: str | None) -> str:
    return "\n".join((text or "").splitlines()[-TAIL_LINES:])


def run_judge_harness(
    labelled: Path,
    out_file: Path,
    *,
    judge: str,
    generator_model: str | None = None,
    spawner: Spawner | None = None,
    repo_root: Path = REPO_ROOT,
) -> list[JudgedAnswer]:
    """Spawn eval/harness/run-judge.mts over the labelled file (as the refusal calibration spawns run-smoke) and read its JSONL."""
    argv = ["npx", "tsx", HARNESS_SCRIPT, "--labelled", str(labelled), "--out", str(out_file), "--judge", judge]
    if generator_model:
        argv.extend(["--generator-model", generator_model])
    Path(out_file).parent.mkdir(parents=True, exist_ok=True)
    result = (spawner or default_spawner)(argv, Path(repo_root))
    code = getattr(result, "returncode", None)
    if code != 0:
        raise JudgeCalibrationError(
            f"run-judge exited with exit code {code}\n--- stderr ---\n{_tail(getattr(result, 'stderr', ''))}"
        )
    try:
        lines = Path(out_file).read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise JudgeCalibrationError(f"run-judge wrote no {out_file}: {exc}") from exc
    try:
        return [JudgedAnswer.model_validate_json(line) for line in lines if line.strip()]
    except ValidationError as exc:
        raise JudgeCalibrationError(f"run-judge wrote an invalid line: {exc}") from exc


@dataclass(frozen=True)
class Row:
    answer_id: str
    language: str
    split: str
    faithful: bool
    share: float
    # (gold unsupported, judged unsupported) per sentence; a sentence without a verdict counts as judged unsupported.
    sentences: tuple[tuple[bool, bool], ...]


def build_rows(
    labelled: Sequence[LabelledAnswer], judged: Sequence[JudgedAnswer]
) -> tuple[list[Row], dict[str, dict[str, int]], str, str]:
    by_id = {answer.id: answer for answer in labelled}
    rows: list[Row] = []
    not_checked: dict[str, dict[str, int]] = {}
    models = {answer.judge_model for answer in judged if answer.status == "judged"}
    versions = {answer.judge_version for answer in judged if answer.status == "judged"}
    if len(models) != 1 or len(versions) != 1 or None in models or None in versions:
        raise JudgeCalibrationError("the judged answers must name exactly one judge model and judge version")
    if {answer.id for answer in judged} != set(by_id):
        raise JudgeCalibrationError("run-judge did not return exactly one line per labelled answer")
    for answer in judged:
        source = by_id[answer.id]
        if answer.language != source.language or answer.split != source.split:
            raise JudgeCalibrationError(f"{answer.id}: language or split differs from the labelled answer")
        if answer.status != "judged" or not answer.verdicts:
            bucket = not_checked.setdefault(source.language, {})
            reason = answer.reason or "invalid_output"
            bucket[reason] = bucket.get(reason, 0) + 1
            continue
        verdicts = {verdict.index: verdict.verdict for verdict in answer.verdicts}
        # judgeAnswerLabel: not_enough_info counts as unsupported, over the judgements returned.
        unsupported = sum(1 for verdict in answer.verdicts if verdict.verdict != "supported")
        pairs = tuple(
            (sentence.label == "unsupported", verdicts.get(sentence.index, "unsupported") != "supported")
            for sentence in source.sentences
        )
        rows.append(
            Row(
                answer_id=answer.id,
                language=source.language,
                split=source.split,
                faithful=source.faithful,
                share=unsupported / len(answer.verdicts),
                sentences=pairs,
            )
        )
    return rows, not_checked, next(iter(models)), next(iter(versions))  # type: ignore[return-value]


def balanced_accuracy(rows: Sequence[Row], max_share: float) -> float:
    faithful = [row for row in rows if row.faithful]
    unfaithful = [row for row in rows if not row.faithful]
    verified = sum(1 for row in faithful if row.share <= max_share + EPSILON) / len(faithful)
    flagged = sum(1 for row in unfaithful if row.share > max_share + EPSILON) / len(unfaithful)
    return (verified + flagged) / 2


def fit_max_share(rows: Sequence[Row]) -> tuple[float, float]:
    """The maximum unsupported share with the highest balanced accuracy on dev; ties go to the smaller (stricter) share."""
    candidates = sorted({0.0, *(row.share for row in rows)})
    best: tuple[float, float] | None = None
    for candidate in candidates:
        accuracy = balanced_accuracy(rows, candidate)
        if best is None or accuracy > best[1] + EPSILON:
            best = (candidate, accuracy)
    assert best is not None
    return best


def sentence_scores(rows: Sequence[Row]) -> dict[str, Any]:
    pairs = [pair for row in rows for pair in row.sentences]
    tp = sum(1 for gold, judged in pairs if gold and judged)
    fp = sum(1 for gold, judged in pairs if not gold and judged)
    fn = sum(1 for gold, judged in pairs if gold and not judged)
    return {
        "unsupported_sentences": tp + fn,
        "judged_unsupported": tp + fp,
        "recall": tp / (tp + fn) if tp + fn else 0.0,
        "precision": tp / (tp + fp) if tp + fp else 0.0,
    }


CellStatus = Literal["calibrated", "insufficient_data", "no_separation", "failed_holdout", "holdout_insufficient_data"]


class LanguageRecord(_Model):
    language: str
    status: CellStatus
    max_unsupported_share: float | None = None
    dev: dict[str, Any] = Field(default_factory=dict)
    holdout: dict[str, Any] | None = None
    cell: GroundednessJudgeThresholdCell | None = None


def _counts(rows: Sequence[Row]) -> dict[str, Any]:
    return {"faithful": sum(1 for r in rows if r.faithful), "unfaithful": sum(1 for r in rows if not r.faithful)}


def calibrate_language(
    language: str,
    rows: Sequence[Row],
    *,
    judge_model: str,
    judge_version: str,
    source: Literal["calibrated", "fixture"],
    run_id: str,
    config_hash: str,
    now: str,
) -> LanguageRecord:
    dev = [row for row in rows if row.language == language and row.split == DEV_SPLIT]
    test = [row for row in rows if row.language == language and row.split == TEST_SPLIT]
    dev_counts = _counts(dev)
    if min(dev_counts.values()) < DEV_MIN_PER_CLASS:
        return LanguageRecord(language=language, status="insufficient_data", dev=dev_counts)
    share, accuracy = fit_max_share(dev)
    dev_block = {**dev_counts, "balanced_accuracy": accuracy, **{f"sentence_{k}": v for k, v in sentence_scores(dev).items()}}
    if accuracy <= CHANCE + EPSILON:
        return LanguageRecord(language=language, status="no_separation", max_unsupported_share=share, dev=dev_block)
    # The test split is read once, here, after the fit.
    test_counts = _counts(test)
    if min(test_counts.values()) < TEST_MIN_PER_CLASS:
        return LanguageRecord(
            language=language, status="holdout_insufficient_data", max_unsupported_share=share, dev=dev_block, holdout=test_counts
        )
    holdout_accuracy = balanced_accuracy(test, share)
    zero_tolerance = balanced_accuracy(test, 0.0)
    scores = sentence_scores(test)
    holdout = {**test_counts, "balanced_accuracy": holdout_accuracy, "zero_tolerance_balanced_accuracy": zero_tolerance, **scores}
    if not (holdout_accuracy > CHANCE + EPSILON and holdout_accuracy + EPSILON >= zero_tolerance):
        return LanguageRecord(language=language, status="failed_holdout", max_unsupported_share=share, dev=dev_block, holdout=holdout)
    cell = GroundednessJudgeThresholdCell(
        judge_model=judge_model,
        judge_version=judge_version,
        language=language,
        max_unsupported_share=share,
        recall=scores["recall"],
        precision=scores["precision"],
        source=source,
        run_ids=[run_id],
        config_hash=config_hash,
        fitted_at=now,
    )
    return LanguageRecord(
        language=language, status="calibrated", max_unsupported_share=share, dev=dev_block, holdout=holdout, cell=cell
    )


def merge_cells(existing: GroundednessJudgeThresholds, records: Sequence[LanguageRecord], judge_model: str, judge_version: str) -> GroundednessJudgeThresholds:
    """Replace this judge's cell per calibrated language; a language that did not calibrate loses any old cell of this judge."""
    touched = {(judge_model, judge_version, record.language) for record in records}
    kept = [cell for cell in existing.cells if (cell.judge_model, cell.judge_version, cell.language) not in touched]
    fresh = [record.cell for record in records if record.cell is not None]
    ordered = sorted([*kept, *fresh], key=lambda cell: (cell.judge_model, cell.judge_version, cell.language))
    return GroundednessJudgeThresholds.model_validate(GroundednessJudgeThresholds(cells=ordered).model_dump(mode="json"))


class JudgeCalibrationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    judge: str
    judge_model: str
    judge_version: str
    source: Literal["calibrated", "fixture"]
    labelled_path: str
    labelled_sha256: str
    fixture_labelled: bool
    run_id: str
    config_hash: str
    rule: str = (
        "Score 1 - unsupported share (not_enough_info counts as unsupported); fit the maximum unsupported share on dev by balanced "
        f"accuracy (at least {DEV_MIN_PER_CLASS} per class, ties to the stricter share), check once on test (at least "
        f"{TEST_MIN_PER_CLASS} per class); calibrated only when the holdout beats chance and zero tolerance."
    )
    languages: list[LanguageRecord] = Field(default_factory=list)
    not_checked: dict[str, dict[str, int]] = Field(default_factory=dict)
    thresholds_written: bool = False
    thresholds_path: str | None = None


def _sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def is_fixture_labelled(path: Path) -> bool:
    resolved = Path(path).resolve()
    if resolved.is_relative_to(FIXTURES_DIR.resolve()):
        return True
    return DEFAULT_LABELLED.is_file() and resolved.is_file() and _sha256(resolved) == _sha256(DEFAULT_LABELLED)


def _check_report_dir(path: Path) -> None:
    resolved = Path(path).resolve()
    if resolved.is_relative_to(REPO_ROOT.resolve()) and not resolved.is_relative_to(EVAL_OUT.resolve()):
        raise JudgeCalibrationError(f"--report-dir must be under {repo_relative(EVAL_OUT)} inside the repository")


def _fmt(value: Any) -> str:
    return f"{value:.3f}" if isinstance(value, float) else "-" if value is None else str(value)


def render_report(result: JudgeCalibrationResult) -> str:
    lines = [
        "# Groundedness judge calibration",
        "",
        f"- judge: `{result.judge_model}` version `{result.judge_version}` (source {result.source})",
        f"- labelled: `{result.labelled_path}` (sha256 {result.labelled_sha256[:12]}){' — fixture answers' if result.fixture_labelled else ''}",
        f"- run id: `{result.run_id}`, config hash `{result.config_hash[:12]}`",
        f"- rule: {result.rule}",
        "",
        "| language | status | max unsupported share | dev BA | holdout BA | zero-tolerance BA | recall | precision |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for record in result.languages:
        holdout = record.holdout or {}
        lines.append(
            f"| {record.language} | {record.status} | {_fmt(record.max_unsupported_share)} | {_fmt(record.dev.get('balanced_accuracy'))} | "
            f"{_fmt(holdout.get('balanced_accuracy'))} | {_fmt(holdout.get('zero_tolerance_balanced_accuracy'))} | "
            f"{_fmt(holdout.get('recall'))} | {_fmt(holdout.get('precision'))} |"
        )
    if result.not_checked:
        lines += ["", "| language | not checked reason | count |", "| --- | --- | --- |"]
        for language in sorted(result.not_checked):
            for reason, count in sorted(result.not_checked[language].items()):
                lines.append(f"| {language} | {reason} | {count} |")
    lines += ["", f"Thresholds: {'written to `' + str(result.thresholds_path) + '`' if result.thresholds_written else 'not written'}."]
    return "\n".join(lines) + "\n"


def run_judge_calibration(
    labelled: Path,
    out: Path | None,
    report_dir: Path,
    *,
    judge: str,
    generator_model: str | None = None,
    spawner: Spawner | None = None,
    now: str | None = None,
) -> JudgeCalibrationResult:
    labelled_path = Path(labelled)
    report = Path(report_dir)
    _check_report_dir(report)
    fake = judge == FAKE_JUDGE
    fixture = is_fixture_labelled(labelled_path)
    if not fake and not generator_model:
        raise JudgeCalibrationError("a real judge needs --generator-model (the D-25 family rule)")
    if out is not None and not fake and fixture:
        raise JudgeCalibrationError(
            "refusing to write cells for a real judge from the synthetic fixture answers; pass a real labelled file"
        )
    source: Literal["calibrated", "fixture"] = "fixture" if fake else "calibrated"
    existing = GroundednessJudgeThresholds(cells=[])
    if out is not None and Path(out).is_file():
        try:
            existing = GroundednessJudgeThresholds.model_validate_json(Path(out).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise JudgeCalibrationError(f"{out} is not a valid judge thresholds file: {exc}") from exc

    answers = load_labelled(labelled_path)
    judged = run_judge_harness(
        labelled_path, report / JUDGED_NAME, judge=judge, generator_model=generator_model, spawner=spawner
    )
    rows, not_checked, judge_model, judge_version = build_rows(answers, judged)
    if fake and judge_model != FAKE_JUDGE_MODEL:
        raise JudgeCalibrationError(f"the fake judge must report {FAKE_JUDGE_MODEL}, got {judge_model}")
    if not fake and judge_model == FAKE_JUDGE_MODEL:
        raise JudgeCalibrationError("a real judge run reported the fake judge model id")
    labelled_sha = _sha256(labelled_path)
    config_hash = hashlib.sha256(
        json.dumps({"judge_model": judge_model, "judge_version": judge_version, "labelled_sha256": labelled_sha}, sort_keys=True).encode()
    ).hexdigest()
    run_id = f"judge-calibration-{judge_version}-{labelled_sha[:12]}"
    day = now or datetime.now(timezone.utc).date().isoformat()
    languages = sorted({answer.language for answer in answers})
    records = [
        calibrate_language(
            language,
            rows,
            judge_model=judge_model,
            judge_version=judge_version,
            source=source,
            run_id=run_id,
            config_hash=config_hash,
            now=day,
        )
        for language in languages
    ]
    result = JudgeCalibrationResult(
        judge=judge,
        judge_model=judge_model,
        judge_version=judge_version,
        source=source,
        labelled_path=repo_relative(labelled_path),
        labelled_sha256=labelled_sha,
        fixture_labelled=fixture,
        run_id=run_id,
        config_hash=config_hash,
        languages=records,
        not_checked=not_checked,
    )
    if out is not None:
        write_config_atomically(Path(out), merge_cells(existing, records, judge_model, judge_version))
        result.thresholds_written = True
        result.thresholds_path = repo_relative(Path(out))
    report.mkdir(parents=True, exist_ok=True)
    (report / RESULT_NAME).write_text(
        json.dumps(result.model_dump(mode="json"), sort_keys=True, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (report / REPORT_NAME).write_text(render_report(result), encoding="utf-8")
    return result
