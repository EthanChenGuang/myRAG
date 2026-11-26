import argparse
import hashlib
import json
import os
import sys
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

from rag_sidecar.contracts.judge import JudgeConfig
from rag_sidecar.contracts.review import ReviewQueueItem

import rag_eval.judge  # noqa: F401  (applies the telemetry opt-out before the judge libraries load)
from rag_eval.judge.config import (
    DEFAULT_CONFIG_PATH,
    JudgeCase,
    JudgeFamilyError,
    JudgeFatalError,
    assert_judge_family_differs,
    generator_family,
    load_judge_config,
)
from rag_eval.judge.telemetry import check_no_results_upload
from rag_eval.paths import resolve_cli_path
from rag_eval.review_queue import _http_client, _parse_time, _to_item

EXIT_OK, EXIT_INPUT, EXIT_API = 0, 2, 4
METRICS = ("faithfulness", "answer_relevance")
SOURCE = "rag_eval.online_judge"
LANGFUSE_NOTICE = "::notice::langfuse keys not configured, skipping online judge"
JUDGE_KEY_NOTICE = "::notice::judge key not configured, skipping online judge"
UNCONFIGURED_NOTICE = "::notice::online_judge is not configured in judge.json, skipping online judge"
NOTHING_NOTICE = (
    "::notice::no review candidates in the window, nothing was judged "
    "(LANGFUSE_REVIEW_SAMPLE_RATE defaults to 0, so traces are only exported for review when it is raised)"
)

JudgeFactory = Callable[[JudgeConfig], Any]

MIRROR_ROUTE = "/api/rag/admin/monitor/judge-scores"
DEFAULT_TOKEN_ENV = "RAG_ADMIN_BEARER"


def select_sample(trace_ids: list[str], sample_rate: float, seed: int) -> list[str]:
    """Pick a deterministic subset of trace ids: a seeded hash of each id is compared with the rate."""
    chosen: list[str] = []
    for trace_id in sorted(set(trace_ids)):
        digest = hashlib.sha256(f"{seed}:{trace_id}".encode("utf-8")).digest()
        if int.from_bytes(digest[:8], "big") / 2**64 < sample_rate:
            chosen.append(trace_id)
    return chosen


def _pick_judge(config: JudgeConfig, generator_model: str) -> JudgeConfig:
    chosen = config
    online = config.online_judge
    if online is not None and generator_family(generator_model) == config.judge_family.lower():
        chosen = config.model_copy(update={"judge_model": online.judge_model, "judge_family": online.judge_family})
    assert_judge_family_differs(chosen, generator_model)
    return chosen


def _score_id(trace_id: str, metric: str, judge_model: str) -> str:
    return hashlib.sha256(f"{trace_id}\n{metric}\n{judge_model}".encode("utf-8")).hexdigest()


def judge_traces(
    items: list[ReviewQueueItem], config: JudgeConfig, judge_factory: JudgeFactory
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    from rag_eval.judge.deepeval_judge import score_deepeval

    skipped = {"same_family": 0, "missing_content": 0, "judge_error": 0}
    groups: dict[str, tuple[JudgeConfig, list[tuple[ReviewQueueItem, JudgeCase]]]] = {}
    for item in sorted(items, key=lambda entry: entry.trace_id):
        query, answer, context = item.query_masked.strip(), item.answer_masked.strip(), item.context_masked.strip()
        if not (query and answer and context):
            skipped["missing_content"] += 1
            continue
        try:
            chosen = _pick_judge(config, item.model)
        except JudgeFamilyError:
            skipped["same_family"] += 1
            continue
        case = JudgeCase(item_id=item.trace_id, question=query, answer=answer, contexts=[context])
        groups.setdefault(chosen.judge_model, (chosen, []))[1].append((item, case))

    scores: list[dict[str, Any]] = []
    for judge_model in sorted(groups):
        chosen, members = groups[judge_model]
        outcomes = score_deepeval([case for _, case in members], judge_factory(chosen), config.max_concurrency)
        for item, _case in members:
            for metric in METRICS:
                value, _reason = outcomes.get((item.trace_id, metric), (None, "judge_error"))
                if value is None:
                    skipped["judge_error"] += 1
                    continue
                scores.append(
                    {
                        "id": _score_id(item.trace_id, metric, chosen.judge_model),
                        "traceId": item.trace_id,
                        "name": metric,
                        "value": value,
                        "dataType": "NUMERIC",
                        "timestamp": item.captured_at,
                        "comment": "online judge",
                        "metadata": {
                            "source": SOURCE,
                            "judge_model": chosen.judge_model,
                            "judge_family": chosen.judge_family,
                        },
                    }
                )
    scores.sort(key=lambda entry: (entry["traceId"], entry["name"]))
    return scores, skipped


def _fail(message: str, code: int) -> int:
    print(f"error: {message}", file=sys.stderr)
    return code


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _collect(rows: Any) -> dict[str, ReviewQueueItem | None]:
    found: dict[str, ReviewQueueItem | None] = {}
    for row in rows:
        trace_id = row.get("traceId")
        if not isinstance(trace_id, str) or not trace_id:
            continue
        item = _to_item(row)
        current = found.get(trace_id)
        if trace_id not in found or current is None:
            found[trace_id] = item
        elif item is not None and (item.captured_at, item.observation_id) < (current.captured_at, current.observation_id):
            found[trace_id] = item
    return found


def _summary(
    candidates: int, sampled: int, scored: int, skipped: dict[str, int], post_status: int | str, accepted: int, rejected: int
) -> dict[str, Any]:
    return {
        "candidates": candidates,
        "sampled": sampled,
        "scored": scored,
        "skipped": {"same_family": 0, "missing_content": 0, "judge_error": 0, **skipped},
        "post_status": post_status,
        "accepted": accepted,
        "rejected": rejected,
    }


def _mirror_scores(scores: list[dict[str, Any]], base_url: str | None, token_env: str) -> None:
    return None


def _live_factory(api_key: str) -> JudgeFactory:
    def build(config: JudgeConfig) -> Any:
        from rag_eval.judge.deepeval_judge import OpenRouterDeepEvalLLM

        return OpenRouterDeepEvalLLM(config, api_key)

    return build


def main(argv: list[str] | None = None, *, judge_factory: JudgeFactory | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.online_judge", description="myRAG online judge for review-candidate traces")
    parser.add_argument("--from", dest="from_time", help="window start, ISO 8601 (default: 24 hours ago)")
    parser.add_argument("--to", dest="to_time", help="window end, ISO 8601 (default: now)")
    parser.add_argument("--config", type=str, default=str(DEFAULT_CONFIG_PATH))
    parser.add_argument("--dry-run", action="store_true", help="score the sample but do not post to Langfuse")
    parser.add_argument("--base-url", help="app origin; when set with the admin token, the scores are also mirrored to the app")
    parser.add_argument(
        "--token-env", default=DEFAULT_TOKEN_ENV, help=f"environment variable holding the admin access token (default {DEFAULT_TOKEN_ENV})"
    )
    args = parser.parse_args(argv)

    now = datetime.now(timezone.utc)
    from_time = args.from_time or _iso(now - timedelta(hours=24))
    to_time = args.to_time or _iso(now)
    try:
        start, end = _parse_time(from_time), _parse_time(to_time)
        config = load_judge_config(resolve_cli_path(args.config))
    except (OSError, ValueError) as exc:
        return _fail(f"invalid input: {type(exc).__name__}", EXIT_INPUT)
    if start > end:
        return _fail("--from must not be later than --to", EXIT_INPUT)

    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
    if not public_key or not secret_key:
        print(LANGFUSE_NOTICE)
        return EXIT_OK
    openrouter_key = os.environ.get("OPENROUTER_API_KEY")
    if not openrouter_key:
        print(JUDGE_KEY_NOTICE)
        return EXIT_OK
    online = config.online_judge
    if online is None:
        print(UNCONFIGURED_NOTICE)
        return EXIT_OK
    try:
        check_no_results_upload()
    except RuntimeError as exc:
        return _fail(str(exc), EXIT_INPUT)

    from rag_eval.langfuse_api import DEFAULT_BASE_URL, LangfuseApi, LangfuseApiError

    base_url = os.environ.get("LANGFUSE_BASE_URL") or DEFAULT_BASE_URL
    factory = judge_factory if judge_factory is not None else _live_factory(openrouter_key)
    try:
        with LangfuseApi(base_url, public_key, secret_key) as api:
            candidates = _collect(api.observations(from_time, to_time))
            if not candidates:
                print(NOTHING_NOTICE)
                print(json.dumps(_summary(0, 0, 0, {}, "none", 0, 0), sort_keys=True))
                return EXIT_OK

            sampled = select_sample(list(candidates), online.sample_rate, online.seed)
            items = [item for item in (candidates[trace_id] for trace_id in sampled) if item is not None]
            scores, skipped = judge_traces(items, config, factory)
            skipped["missing_content"] += len(sampled) - len(items)

            post_status: int | str = "dry_run" if args.dry_run else "none"
            accepted = rejected = 0
            if scores and not args.dry_run:
                result = api.post_scores(scores)
                post_status, accepted, rejected = result.status, result.accepted, result.rejected
                for message in result.errors:
                    print(f"[Online Judge] score rejected: {message}", file=sys.stderr)
    except (JudgeFatalError, LangfuseApiError) as exc:
        return _fail(str(exc), EXIT_API)

    scored = len({entry["traceId"] for entry in scores})
    print(json.dumps(_summary(len(candidates), len(sampled), scored, skipped, post_status, accepted, rejected), sort_keys=True))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
