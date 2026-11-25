"""Phase 4.1 plan 08: capped live rerank quality and latency on the fixture corpus (CONTEXT D-12 G7, D-22).

Report-only. Vendor keys are always the placeholder `proxy-injected` (the network proxy supplies the credential), every vendor
request is counted against one hard cap, and nothing but durations, status codes and counts is kept from a request. The tool
never writes eval/config/refusal-thresholds.json or eval/config/retrieval-params.json."""

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from rag_sidecar.contracts.baseline import Baseline, NoiseConfig
from rag_sidecar.contracts.report import EvalReport

from rag_eval.defaults_gate import band_for
from rag_eval.golden_io import load_golden, write_golden
from rag_eval.harness_runner import dev_only_golden
from rag_eval.paths import REPO_ROOT, repo_relative, resolve_cli_path

PLACEHOLDER_KEY = "proxy-injected"
TOTAL_REQUEST_CAP = 600
PROBE_REQUESTS_PER_MODEL = 30
PROBE_CANDIDATES = 75
MAX_ITEMS_PER_PASS = 120
ERROR_RATE_STOP = 0.10
TASK3_REQUEST_LIMIT = 450
REQUEST_TIMEOUT_S = 30.0

EXIT_OK = 0
EXIT_STOPPED = 1
EXIT_INVALID = 2

Vendor = Literal["cohere", "voyage"]
Tier = Literal["chat", "voice"]

FIXTURE_CAVEAT = (
    "Fixture evidence only: a small synthetic corpus in three languages, retrieved with the lexical fixture embedder, so the "
    "candidate lists the rerankers see differ from production. The numbers show whether hosted rerank is worse than the local "
    "paths on this fixture and how fast the vendors answer 75 candidates; they are not a production quality estimate."
)


class LiveProbeError(RuntimeError):
    """Raised for a refused live action; the message never contains a key, header or body."""


class BudgetExceeded(LiveProbeError):
    pass


@dataclass(frozen=True)
class LiveModel:
    name: str
    vendor: Vendor
    model: str
    tier: Tier


LIVE_MODELS: tuple[LiveModel, ...] = (
    LiveModel("live-cohere-pro", "cohere", "rerank-v5.0-pro", "chat"),
    LiveModel("live-cohere-fast", "cohere", "rerank-v5.0-fast", "voice"),
    LiveModel("live-voyage-3", "voyage", "rerank-3", "chat"),
    LiveModel("live-voyage-3-lite", "voyage", "rerank-3-lite", "voice"),
)

VENDOR_URLS: Mapping[str, str] = {
    "cohere": "https://api.cohere.com/v2/rerank",
    "voyage": "https://api.voyageai.com/v1/rerank",
}
VENDOR_KEY_ENV: Mapping[str, str] = {
    "cohere": "COHERE_API_KEY",
    "voyage": "VOYAGE_API_KEY",
}

# Offline references on the same items, threshold refusal off like the live configs (keyless auto is local_bm25).
OFFLINE_REFERENCES: Mapping[str, str] = {
    "local_bm25": "v2-default-no-cells",
    "none": "v2-default-fallback-none-no-cells",
}


# ---------- plan, selection and budget


@dataclass(frozen=True)
class RequestPlan:
    dev_items_total: int
    items_per_pass: int
    probe_per_model: int
    models: int
    total: int

    @property
    def sampled(self) -> bool:
        return self.items_per_pass < self.dev_items_total


def plan_requests(
    dev_items: int,
    *,
    models: int = len(LIVE_MODELS),
    cap: int = TOTAL_REQUEST_CAP,
    probe: int = PROBE_REQUESTS_PER_MODEL,
    max_items: int = MAX_ITEMS_PER_PASS,
) -> RequestPlan:
    """One quality pass per model over min(dev items, max_items) items plus one probe per model; refused above the cap."""
    if dev_items < 0:
        raise LiveProbeError("dev item count must not be negative")
    per_pass = min(dev_items, max_items)
    total = models * (per_pass + probe)
    if total > cap:
        raise BudgetExceeded(f"planned {total} vendor requests exceed the cap of {cap}")
    return RequestPlan(dev_items, per_pass, probe, models, total)


def _id_digest(item_id: str) -> str:
    return hashlib.sha256(item_id.encode("utf-8")).hexdigest()


def select_items[T](items: Sequence[T], limit: int = MAX_ITEMS_PER_PASS) -> list[T]:
    """Every item when the split fits; otherwise the first `limit` items ordered by the sha256 of the item id."""
    if len(items) <= limit:
        return list(items)
    return sorted(items, key=lambda item: _id_digest(item.id))[:limit]  # type: ignore[attr-defined]


class RequestBudget:
    def __init__(self, cap: int = TOTAL_REQUEST_CAP) -> None:
        self.cap = cap
        self.used = 0

    @property
    def remaining(self) -> int:
        return self.cap - self.used

    def take(self, count: int) -> None:
        if count < 0:
            raise LiveProbeError("request count must not be negative")
        if self.used + count > self.cap:
            raise BudgetExceeded(
                f"{count} more vendor request(s) would exceed the cap of {self.cap} ({self.used} used)"
            )
        self.used += count


# ---------- probe requests


@dataclass(frozen=True)
class ProbeRequest:
    query: str
    documents: tuple[str, ...]


def build_requests(
    candidates: Sequence[str],
    queries: Sequence[str],
    n: int = PROBE_REQUESTS_PER_MODEL,
    k: int = PROBE_CANDIDATES,
) -> list[ProbeRequest]:
    """n requests of k documents each, deterministic: request i asks query i mod len(queries) over a rotation of candidates."""
    if len(candidates) < k:
        raise LiveProbeError(
            f"the probe needs at least {k} candidate passages, the fixture gave {len(candidates)}"
        )
    if not queries:
        raise LiveProbeError("the probe needs at least one query")
    total = len(candidates)
    built: list[ProbeRequest] = []
    for index in range(n):
        start = (index * k) % total
        documents = tuple(candidates[(start + offset) % total] for offset in range(k))
        built.append(
            ProbeRequest(query=queries[index % len(queries)], documents=documents)
        )
    return built


CHUNK_MARKER = re.compile(r"<!--\s*chunk\s*-->")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)


def corpus_candidates(corpus_dir: Path) -> list[str]:
    """Fixture chunks (split on the corpus chunk marker) of every markdown file, in path order."""
    passages: list[str] = []
    for path in sorted(Path(corpus_dir).rglob("*.md")):
        for part in CHUNK_MARKER.split(path.read_text(encoding="utf-8")):
            text = HTML_COMMENT.sub("", part).strip()
            if text:
                passages.append(text)
    return passages


def request_body(vendor: str, model: str, request: ProbeRequest) -> bytes:
    payload: dict[str, Any] = {
        "model": model,
        "query": request.query,
        "documents": list(request.documents),
    }
    if vendor == "voyage":
        payload.update({"truncation": True, "return_documents": False})
    return json.dumps(payload).encode("utf-8")


def request_headers(vendor: str, env: Mapping[str, str]) -> dict[str, str]:
    """Headers for one vendor request. The key must be the proxy placeholder; any other value is refused unread."""
    name = VENDOR_KEY_ENV[vendor]
    if env.get(name) != PLACEHOLDER_KEY:
        raise LiveProbeError(
            f"{name} must be set to the placeholder {PLACEHOLDER_KEY} for a live probe"
        )
    return {
        "authorization": "Bearer " + PLACEHOLDER_KEY,
        "content-type": "application/json",
    }


# ---------- transport and probe

Transport = Callable[[str, Mapping[str, str], bytes, float], int]


def urllib_transport(
    url: str, headers: Mapping[str, str], body: bytes, timeout: float
) -> int:
    """POST and return the status code (0 on a network error). The response body is read and dropped."""
    request = urllib.request.Request(
        url, data=body, headers=dict(headers), method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read()
            return int(response.status)
    except urllib.error.HTTPError as exc:
        exc.read()
        return int(exc.code)
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0


def _retryable(status: int) -> bool:
    return status == 0 or status == 429 or status >= 500


def _ok(status: int) -> bool:
    return 200 <= status < 300


def percentile(samples: Sequence[float], q: float) -> float:
    """Linear interpolation between closest ranks (the numpy default)."""
    if not samples:
        raise ValueError("percentile of an empty sample")
    ordered = sorted(samples)
    position = (len(ordered) - 1) * q / 100.0
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ProbeResult(_Model):
    name: str
    vendor: Vendor
    model: str
    requests: int = Field(ge=0)
    n: int = Field(ge=0)
    ok: int = Field(ge=0)
    errors: int = Field(ge=0)
    p50_ms: float | None
    p95_ms: float | None
    status_counts: dict[str, int]


def run_probe(
    model: LiveModel,
    requests: Sequence[ProbeRequest],
    budget: RequestBudget,
    *,
    transport: Transport | None = None,
    clock: Callable[[], float] = time.perf_counter,
    env: Mapping[str, str] | None = None,
    timeout_s: float = REQUEST_TIMEOUT_S,
) -> ProbeResult:
    """Send each request once (a 429, 5xx or network error is retried once while the cap allows) and keep durations only."""
    headers = request_headers(model.vendor, os.environ if env is None else env)
    if len(requests) > budget.remaining:
        raise BudgetExceeded(
            f"the {model.name} probe needs {len(requests)} requests, {budget.remaining} remain under the cap"
        )
    send = transport or urllib_transport
    url = VENDOR_URLS[model.vendor]
    durations: list[float] = []
    statuses: Counter[str] = Counter()
    sent = 0
    errors = 0
    for request in requests:
        body = request_body(model.vendor, model.model, request)
        attempts = 0
        while True:
            budget.take(1)
            sent += 1
            attempts += 1
            started = clock()
            status = send(url, headers, body, timeout_s)
            elapsed_ms = (clock() - started) * 1000.0
            statuses[str(status)] += 1
            if _ok(status):
                durations.append(elapsed_ms)
                break
            if attempts == 1 and _retryable(status) and budget.remaining >= 1:
                continue
            errors += 1
            break
    return ProbeResult(
        name=model.name,
        vendor=model.vendor,
        model=model.model,
        requests=sent,
        n=len(requests),
        ok=len(durations),
        errors=errors,
        p50_ms=percentile(durations, 50) if durations else None,
        p95_ms=percentile(durations, 95) if durations else None,
        status_counts=dict(sorted(statuses.items())),
    )


def harness_rerank_calls(stage_statuses: Sequence[Mapping[str, str]]) -> int:
    """Upper bound of the vendor calls of one harness pass: one per trace whose rerank stage was attempted (not disabled)."""
    return sum(
        1
        for statuses in stage_statuses
        if statuses.get("rerank") not in (None, "disabled")
    )


# ---------- result


class SplitQuality(_Model):
    run_config: str
    run_id: str
    n: int = Field(ge=0)
    recall_at_10: float | None
    mrr: float | None
    recall_at_10_by_language: dict[str, float | None]


class LiveModelResult(SplitQuality):
    name: str
    vendor: Vendor
    model: str
    tier: Tier
    harness_requests: int = Field(ge=0)
    rerank_skipped: int = Field(ge=0)
    p50_ms: float | None
    p95_ms: float | None
    errors: int = Field(ge=0)
    request_count: int = Field(ge=0)
    probe: ProbeResult


class Verdict(_Model):
    model: str
    check: Literal[
        "quality_vs_local_bm25", "quality_vs_none", "chat_p95", "voice_fast_p95"
    ]
    status: Literal["pass", "fail", "skipped"]
    detail: str


class IndicativeFit(_Model):
    status: Literal["skipped", "pending_operator"]
    reason: str


class LiveRerankResult(_Model):
    schema_version: Literal[1] = 1
    status: Literal["complete", "stopped", "pending_live"]
    stop_reason: str | None = None
    created_at: str
    git_sha: str | None
    cap: int
    total_requests: int = Field(ge=0)
    dev_items_total: int = Field(ge=0)
    dev_items_used: int = Field(ge=0)
    sampled: bool
    golden_sha256: str
    baseline_sha256: str
    band: dict[str, float]
    latency_budgets_ms: dict[str, float]
    offline_references: dict[str, SplitQuality]
    models: list[LiveModelResult]
    verdicts: list[Verdict]
    g7: dict[str, str]
    indicative_refusal_fit: IndicativeFit
    caveat: str = FIXTURE_CAVEAT


def split_quality(report: EvalReport, run_config: str) -> SplitQuality:
    return SplitQuality(
        run_config=run_config,
        run_id=report.run_id,
        n=report.overall.recall_at_10.n,
        recall_at_10=report.overall.recall_at_10.value,
        mrr=report.overall.mrr.value,
        recall_at_10_by_language={
            lang: metrics.recall_at_10.value
            for lang, metrics in sorted(report.by_language.items())
        },
    )


def _at_least(value: float | None, reference: float | None, band: float) -> bool | None:
    if value is None or reference is None:
        return None
    return value >= reference - band - 1e-12


def quality_verdicts(
    model: LiveModelResult,
    references: Mapping[str, SplitQuality],
    band: Mapping[str, float],
) -> list[Verdict]:
    verdicts: list[Verdict] = []
    for ref_name, check in (
        ("local_bm25", "quality_vs_local_bm25"),
        ("none", "quality_vs_none"),
    ):
        reference = references.get(ref_name)
        if reference is None:
            verdicts.append(
                Verdict(
                    model=model.name,
                    check=check,
                    status="skipped",
                    detail=f"no {ref_name} reference",
                )
            )
            continue
        outcomes = {
            "recall_at_10": _at_least(
                model.recall_at_10, reference.recall_at_10, band["recall_at_10"]
            ),
            "mrr": _at_least(model.mrr, reference.mrr, band["mrr"]),
        }
        if any(outcome is None for outcome in outcomes.values()):
            status: Literal["pass", "fail", "skipped"] = "skipped"
        else:
            status = "pass" if all(outcomes.values()) else "fail"
        detail = (
            f"Recall@10 {model.recall_at_10} vs {reference.recall_at_10} - {band['recall_at_10']}; "
            f"MRR {model.mrr} vs {reference.mrr} - {band['mrr']}"
        )
        verdicts.append(
            Verdict(model=model.name, check=check, status=status, detail=detail)
        )
    return verdicts


def latency_verdict(model: LiveModelResult, budgets: Mapping[str, float]) -> Verdict:
    check: Literal["chat_p95", "voice_fast_p95"] = (
        "chat_p95" if model.tier == "chat" else "voice_fast_p95"
    )
    limit = budgets[model.tier]
    if model.p95_ms is None:
        return Verdict(
            model=model.name,
            check=check,
            status="skipped",
            detail="no successful probe request",
        )
    status: Literal["pass", "fail"] = "pass" if model.p95_ms <= limit else "fail"
    return Verdict(
        model=model.name,
        check=check,
        status=status,
        detail=f"p95 {model.p95_ms:.1f} ms vs {limit:.0f} ms",
    )


def g7_summary(verdicts: Sequence[Verdict]) -> dict[str, str]:
    """G7 inputs for 04.1-07: auto's hosted provider (Cohere) for chat (pro: quality and chat p95) and voice (fast p95, D-09)."""

    def combined(model: str, checks: Sequence[str]) -> str:
        found = [v.status for v in verdicts if v.model == model and v.check in checks]
        if len(found) < len(checks):
            return "not_run"
        if "fail" in found:
            return "fail"
        return "pass" if all(status == "pass" for status in found) else "skipped"

    return {
        "auto_chat_cohere": combined(
            "live-cohere-pro", ("quality_vs_local_bm25", "quality_vs_none", "chat_p95")
        ),
        "auto_voice_cohere": combined("live-cohere-fast", ("voice_fast_p95",)),
        "alternative_chat_voyage": combined(
            "live-voyage-3", ("quality_vs_local_bm25", "quality_vs_none", "chat_p95")
        ),
        "alternative_voice_voyage": combined("live-voyage-3-lite", ("voice_fast_p95",)),
    }


def indicative_fit(
    total_requests: int, status: str, planned_total: int
) -> IndicativeFit:
    if status == "pending_live":
        verdict = (
            f"will be skipped (at or above {TASK3_REQUEST_LIMIT})"
            if planned_total >= TASK3_REQUEST_LIMIT
            else f"can run (below {TASK3_REQUEST_LIMIT})"
        )
        return IndicativeFit(
            status="skipped",
            reason=(
                f"skipped for now: it follows the live checks, which plan {planned_total} requests for the dev split in force, "
                f"so it {verdict}"
            ),
        )
    if status != "complete":
        return IndicativeFit(
            status="skipped",
            reason="the live quality and latency checks did not complete",
        )
    if total_requests >= TASK3_REQUEST_LIMIT:
        return IndicativeFit(
            status="skipped",
            reason=f"skipped: the live checks used {total_requests} requests, at or above {TASK3_REQUEST_LIMIT}, so the remaining cap does not cover a calibration pass",
        )
    return IndicativeFit(
        status="pending_operator",
        reason=(
            "budget allows it: run `uv run --directory eval python -m rag_eval.calibrate refusal --run-config "
            "eval/config/runs/live-cohere-pro.json --out eval/out/p41-live-calibrate` without --write-thresholds and append the "
            "per-cell fit to report.md as indicative: real reranker, synthetic fixture corpus; not applied"
        ),
    )


# ---------- report


def _fmt(value: float | None, digits: int = 3) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def render_report(result: LiveRerankResult) -> str:
    lines = ["# Phase 4.1 live rerank check (G7, report-only)", ""]
    lines.append(
        f"Status: **{result.status}**"
        + (f" ({result.stop_reason})" if result.stop_reason else "")
    )
    lines.append("")
    lines.append(
        f"Vendor requests: {result.total_requests} of a cap of {result.cap}. Dev split: {result.dev_items_used} of "
        f"{result.dev_items_total} items used"
        + (" (deterministic sha256 subset)." if result.sampled else " (whole split).")
    )
    lines.append(
        f"Golden sha256 `{result.golden_sha256}`; baseline sha256 `{result.baseline_sha256}`."
    )
    lines.append(
        f"Noise band: Recall@10 {result.band['recall_at_10']}, MRR {result.band['mrr']}. Rerank p95 budgets: chat "
        f"{result.latency_budgets_ms['chat']:.0f} ms, voice {result.latency_budgets_ms['voice']:.0f} ms."
    )
    lines += [
        "",
        f"> {result.caveat}",
        "",
        "## Offline references (same items, threshold refusal off)",
        "",
    ]
    lines.append(
        "| Reference | Run config | Run id | n | Recall@10 | MRR | Recall@10 by language |"
    )
    lines.append("| --- | --- | --- | --- | --- | --- | --- |")
    for name, ref in result.offline_references.items():
        langs = ", ".join(
            f"{lang} {_fmt(value)}"
            for lang, value in ref.recall_at_10_by_language.items()
        )
        lines.append(
            f"| {name} | {ref.run_config} | {ref.run_id} | {ref.n} | {_fmt(ref.recall_at_10)} | {_fmt(ref.mrr)} | {langs} |"
        )
    lines += ["", "## Hosted rerankers", ""]
    if not result.models:
        lines.append(
            "No live pass has run yet: the live checks are an operator action (see the plan 04.1-08 SUMMARY)."
        )
    else:
        lines.append(
            "| Model | Tier | Run id | n | Recall@10 | MRR | Recall@10 by language | Rerank skipped | p50 ms | p95 ms | Probe errors | Requests |"
        )
        lines.append(
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
        )
        for model in result.models:
            langs = ", ".join(
                f"{lang} {_fmt(value)}"
                for lang, value in model.recall_at_10_by_language.items()
            )
            lines.append(
                f"| {model.vendor} {model.model} | {model.tier} | {model.run_id} | {model.n} | {_fmt(model.recall_at_10)} | "
                f"{_fmt(model.mrr)} | {langs} | {model.rerank_skipped} | {_fmt(model.p50_ms, 1)} | {_fmt(model.p95_ms, 1)} | "
                f"{model.errors} | {model.request_count} |"
            )
    lines += ["", "## G7 verdicts (inputs for plan 04.1-07)", ""]
    for key, value in result.g7.items():
        lines.append(f"- {key}: **{value}**")
    if result.verdicts:
        lines += [
            "",
            "| Model | Check | Status | Detail |",
            "| --- | --- | --- | --- |",
        ]
        for verdict in result.verdicts:
            lines.append(
                f"| {verdict.model} | {verdict.check} | {verdict.status} | {verdict.detail} |"
            )
    lines += [
        "",
        "## Indicative refusal fit (Task 3)",
        "",
        f"{result.indicative_refusal_fit.status}: {result.indicative_refusal_fit.reason}",
        "",
    ]
    lines.append(
        "Nothing here writes eval/config/refusal-thresholds.json or eval/config/retrieval-params.json."
    )
    return "\n".join(lines) + "\n"


# ---------- orchestration

Spawner = Callable[[list[str], Mapping[str, str]], int]


def default_spawner(argv: list[str], env: Mapping[str, str]) -> int:
    return subprocess.run(argv, cwd=REPO_ROOT, env=dict(env), check=False).returncode


def harness_argv(run_config: Path, golden: Path, out: Path) -> list[str]:
    return [
        "npm",
        "run",
        "--silent",
        "test-rag",
        "--",
        "--run-config",
        str(run_config),
        "--no-gate",
        "--golden",
        str(golden),
        "--out",
        str(out),
    ]


def _sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _git_sha() -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def _harness_pass(
    run_config: Path, golden: Path, out: Path, env: Mapping[str, str], spawner: Spawner
) -> tuple[EvalReport, list[Mapping[str, str]]]:
    code = spawner(harness_argv(run_config, golden, out), env)
    if code != 0:
        raise LiveProbeError(f"harness run {run_config.name} exited with {code}")
    report = EvalReport.model_validate_json(
        (out / "report.json").read_text(encoding="utf-8")
    )
    statuses: list[Mapping[str, str]] = []
    for line in (out / "traces.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            statuses.append(json.loads(line).get("stage_status") or {})
    return report, statuses


def _load_band(baseline_path: Path, noise_path: Path) -> dict[str, float]:
    baseline = Baseline.model_validate_json(baseline_path.read_text(encoding="utf-8"))
    noise = NoiseConfig.model_validate_json(noise_path.read_text(encoding="utf-8"))
    overall = baseline.slices["overall"]
    return {
        metric: band_for(overall[metric], noise) for metric in ("recall_at_10", "mrr")
    }


def _load_budgets(path: Path) -> dict[str, float]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {
        tier: float(payload["profiles"][tier]["stages"]["rerank"])
        for tier in ("chat", "voice")
    }


def run_live(
    *,
    golden: Path,
    corpus: Path,
    runs_dir: Path,
    out_dir: Path,
    report_dir: Path,
    baseline: Path,
    noise: Path,
    budgets_path: Path,
    offline_only: bool,
    spawner: Spawner = default_spawner,
    transport: Transport | None = None,
    env: Mapping[str, str] | None = None,
) -> int:
    process_env = dict(os.environ if env is None else env)
    inputs = out_dir / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    dev_path = dev_only_golden(golden, inputs / "golden.dev.jsonl")
    dev_items = load_golden(dev_path)
    plan = plan_requests(len(dev_items))
    selected = select_items(dev_items, plan.items_per_pass)
    pass_golden = dev_path
    if plan.sampled:
        pass_golden = inputs / "golden.dev-subset.jsonl"
        write_golden(pass_golden, selected)

    if not offline_only:
        for key_name in VENDOR_KEY_ENV.values():
            if process_env.get(key_name, "") not in ("", PLACEHOLDER_KEY):
                raise LiveProbeError(
                    f"{key_name} must be unset or the placeholder {PLACEHOLDER_KEY}"
                )
            process_env[key_name] = PLACEHOLDER_KEY

    budget = RequestBudget(TOTAL_REQUEST_CAP)
    band = _load_band(baseline, noise)
    budgets = _load_budgets(budgets_path)

    references: dict[str, SplitQuality] = {}
    for ref_name, config_name in OFFLINE_REFERENCES.items():
        config = runs_dir / f"{config_name}.json"
        report, _ = _harness_pass(
            config, pass_golden, out_dir / f"ref-{config_name}", process_env, spawner
        )
        references[ref_name] = split_quality(report, config_name)

    models: list[LiveModelResult] = []
    stop_reason: str | None = None
    if not offline_only:
        live_env = {**process_env, "NODE_USE_ENV_PROXY": "1"}
        queries = [item.question for item in selected]
        probe_requests = build_requests(
            corpus_candidates(corpus), queries, n=plan.probe_per_model
        )
        quality: dict[str, tuple[EvalReport, int, int]] = {}
        for model in LIVE_MODELS:
            budget.take(len(selected))
            report, statuses = _harness_pass(
                runs_dir / f"{model.name}.json",
                pass_golden,
                out_dir / f"p41-live-{model.name}",
                live_env,
                spawner,
            )
            calls = harness_rerank_calls(statuses)
            if calls > len(selected):
                raise BudgetExceeded(
                    f"{model.name} made {calls} rerank calls for {len(selected)} items"
                )
            budget.used -= len(selected) - calls
            skipped = sum(1 for status in statuses if status.get("rerank") == "skipped")
            quality[model.name] = (report, calls, skipped)
            if calls and skipped / calls > ERROR_RATE_STOP:
                stop_reason = f"{model.name}: {skipped} of {calls} rerank calls failed or timed out (above {ERROR_RATE_STOP:.0%})"
                break
        if stop_reason is None:
            for model in LIVE_MODELS:
                probe = run_probe(
                    model, probe_requests, budget, transport=transport, env=process_env
                )
                report, calls, skipped = quality[model.name]
                base = split_quality(report, model.name)
                models.append(
                    LiveModelResult(
                        **base.model_dump(),
                        name=model.name,
                        vendor=model.vendor,
                        model=model.model,
                        tier=model.tier,
                        harness_requests=calls,
                        rerank_skipped=skipped,
                        p50_ms=probe.p50_ms,
                        p95_ms=probe.p95_ms,
                        errors=probe.errors,
                        request_count=calls + probe.requests,
                        probe=probe,
                    )
                )
                if probe.n and probe.errors / probe.n > ERROR_RATE_STOP:
                    stop_reason = f"{model.name}: {probe.errors} of {probe.n} probe requests failed (above {ERROR_RATE_STOP:.0%})"
                    break

    status: Literal["complete", "stopped", "pending_live"]
    status = (
        "pending_live" if offline_only else ("stopped" if stop_reason else "complete")
    )
    verdicts: list[Verdict] = []
    for model in models:
        verdicts.extend(quality_verdicts(model, references, band))
        verdicts.append(latency_verdict(model, budgets))
    result = LiveRerankResult(
        status=status,
        stop_reason=stop_reason,
        created_at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        git_sha=_git_sha(),
        cap=TOTAL_REQUEST_CAP,
        total_requests=budget.used,
        dev_items_total=plan.dev_items_total,
        dev_items_used=plan.items_per_pass,
        sampled=plan.sampled,
        golden_sha256=_sha256(pass_golden),
        baseline_sha256=_sha256(baseline),
        band=band,
        latency_budgets_ms=budgets,
        offline_references=references,
        models=models,
        verdicts=verdicts,
        g7=g7_summary(verdicts),
        indicative_refusal_fit=indicative_fit(budget.used, status, plan.total),
    )
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "result.json").write_text(
        json.dumps(result.model_dump(mode="json"), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (report_dir / "report.md").write_text(render_report(result), encoding="utf-8")
    print(
        f"[Live Rerank] {status}: {budget.used} of {TOTAL_REQUEST_CAP} vendor requests; wrote {repo_relative(report_dir / 'result.json')}"
    )
    return EXIT_STOPPED if status == "stopped" else EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="rag_eval.live_rerank_probe",
        description="Phase 4.1 capped live rerank check (report-only)",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser(
        "plan", help="print the request plan for the dev split in force; no vendor call"
    )
    run = commands.add_parser(
        "run",
        help="offline references, then the capped live quality passes and latency probes",
    )
    for sub in (plan, run):
        sub.add_argument("--golden", default="eval/fixtures/golden.jsonl")
        sub.add_argument("--out", default="eval/out/p41-live")
    run.add_argument("--corpus", default="eval/fixtures/corpus")
    run.add_argument("--runs-dir", default="eval/config/runs")
    run.add_argument("--report-dir", default="eval/reports/phase-04.1/live")
    run.add_argument("--baseline", default="eval/baselines/fixture-baseline.json")
    run.add_argument("--noise", default="eval/config/noise.json")
    run.add_argument("--latency-budgets", default="eval/config/latency-budgets.json")
    run.add_argument(
        "--offline-only",
        action="store_true",
        help="run only the local_bm25 and none references; no vendor call",
    )
    args = parser.parse_args(argv)
    try:
        if args.command == "plan":
            out = resolve_cli_path(args.out) / "inputs"
            out.mkdir(parents=True, exist_ok=True)
            items = load_golden(
                dev_only_golden(resolve_cli_path(args.golden), out / "golden.dev.jsonl")
            )
            request_plan = plan_requests(len(items))
            print(
                json.dumps(
                    {
                        **request_plan.__dict__,
                        "sampled": request_plan.sampled,
                        "cap": TOTAL_REQUEST_CAP,
                    },
                    sort_keys=True,
                )
            )
            return EXIT_OK
        return run_live(
            golden=resolve_cli_path(args.golden),
            corpus=resolve_cli_path(args.corpus),
            runs_dir=resolve_cli_path(args.runs_dir),
            out_dir=resolve_cli_path(args.out),
            report_dir=resolve_cli_path(args.report_dir),
            baseline=resolve_cli_path(args.baseline),
            noise=resolve_cli_path(args.noise),
            budgets_path=resolve_cli_path(args.latency_budgets),
            offline_only=args.offline_only,
        )
    except LiveProbeError as exc:
        print(f"[Live Rerank] refused: {exc}", file=sys.stderr)
        return EXIT_INVALID


if __name__ == "__main__":
    raise SystemExit(main())
