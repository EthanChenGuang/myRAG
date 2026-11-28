import json
import socket
from pathlib import Path

import pytest
from rag_sidecar.contracts.report import EvalReport

import rag_eval.live_rerank_probe as probe
from rag_eval.live_rerank_probe import (
    LIVE_MODELS,
    PLACEHOLDER_KEY,
    BudgetExceeded,
    LiveProbeError,
    ProbeRequest,
    RequestBudget,
    build_requests,
    harness_rerank_calls,
    percentile,
    plan_requests,
    request_headers,
    run_live,
    run_probe,
    select_items,
)

REPO = Path(__file__).resolve().parents[2]
RUNS = REPO / "eval" / "config" / "runs"
PLACEHOLDER_ENV = {"COHERE_API_KEY": PLACEHOLDER_KEY, "VOYAGE_API_KEY": PLACEHOLDER_KEY}


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("a test opened a network connection")

    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(probe, "urllib_transport", refuse)


class FakeTransport:
    def __init__(self, statuses: list[int] | None = None) -> None:
        self.statuses = list(statuses or [])
        self.calls: list[tuple[str, dict[str, str], bytes]] = []

    def __call__(
        self, url: str, headers: dict[str, str], body: bytes, timeout: float
    ) -> int:
        self.calls.append((url, dict(headers), body))
        return self.statuses.pop(0) if self.statuses else 200


class StepClock:
    """Each request takes `step` seconds; durations are therefore 1000 * step ms."""

    def __init__(self, steps: list[float]) -> None:
        self.steps = list(steps)
        self.now = 0.0
        self.pending: float | None = None

    def __call__(self) -> float:
        if self.pending is None:
            self.pending = self.steps.pop(0) if self.steps else 0.01
            return self.now
        self.now += self.pending
        self.pending = None
        return self.now


def candidates(count: int) -> list[str]:
    return [
        f"Synthetic passage number {index} about a neutral subject."
        for index in range(count)
    ]


def requests_of(count: int) -> list[ProbeRequest]:
    return build_requests(
        candidates(80), ["neutral question one", "neutral question two"], n=count
    )


# ---------- configs


@pytest.mark.parametrize("model", LIVE_MODELS, ids=lambda model: model.name)
def test_live_run_configs_use_placeholders_only(model: probe.LiveModel) -> None:
    payload = json.loads((RUNS / f"{model.name}.json").read_text(encoding="utf-8"))
    env = payload["env"]
    assert payload["name"] == model.name
    assert env["RAG_PIPELINE"] == "v2"
    assert env["RAG_LEXICAL_SEARCH"] == "true"
    assert env["RAG_REFUSAL_THRESHOLD"] == "false"
    assert env["RAG_REFUSAL_FLOOR"] == "legacy_rule"
    assert env["RAG_RERANKER"] == model.vendor
    assert payload["overrides"]["rerank_model"] == model.model
    key_name = "COHERE_API_KEY" if model.vendor == "cohere" else "VOYAGE_API_KEY"
    assert env[key_name] == PLACEHOLDER_KEY
    assert env[f"{model.vendor.upper()}_BASE_URL"] in {
        "https://api.cohere.com",
        "https://api.voyageai.com/v1",
    }
    for name, value in env.items():
        if name.endswith("_API_KEY"):
            assert value in {"", PLACEHOLDER_KEY}


def test_live_models_cover_the_four_hosted_models() -> None:
    assert [(m.vendor, m.model, m.tier) for m in LIVE_MODELS] == [
        ("cohere", "rerank-v5.0-pro", "chat"),
        ("cohere", "rerank-v5.0-fast", "voice"),
        ("voyage", "rerank-3", "chat"),
        ("voyage", "rerank-3-lite", "voice"),
    ]


# ---------- plan and selection


@pytest.mark.parametrize("dev_items", [1, 60, 119, 120, 121, 300, 5000])
def test_plan_requests_fits_the_cap_at_any_split_size(dev_items: int) -> None:
    plan = plan_requests(dev_items)
    assert plan.items_per_pass == min(dev_items, 120)
    assert plan.probe_per_model == 30
    assert plan.total == 4 * (plan.items_per_pass + 30)
    assert plan.total <= 600
    assert plan.sampled == (dev_items > 120)
    assert plan.dev_items_total == dev_items


def test_plan_requests_rejects_a_plan_over_the_cap() -> None:
    with pytest.raises(BudgetExceeded):
        plan_requests(100, cap=200)


class Item:
    def __init__(self, item_id: str) -> None:
        self.id = item_id


def test_select_items_keeps_every_item_of_a_small_split_in_order() -> None:
    items = [Item(f"item-{index}") for index in range(50)]
    assert select_items(items, 120) == items


def test_select_items_is_a_deterministic_sha256_subset() -> None:
    items = [Item(f"item-{index}") for index in range(300)]
    first = select_items(items, 120)
    assert len(first) == 120
    assert [item.id for item in first] == [
        item.id for item in select_items(list(reversed(items)), 120)
    ]
    import hashlib

    expected = sorted(
        items, key=lambda item: hashlib.sha256(item.id.encode()).hexdigest()
    )[:120]
    assert [item.id for item in first] == [item.id for item in expected]


# ---------- budget


def test_budget_refuses_to_exceed_the_cap() -> None:
    budget = RequestBudget(10)
    budget.take(7)
    assert budget.remaining == 3
    with pytest.raises(BudgetExceeded):
        budget.take(4)
    assert budget.used == 7


# ---------- requests and percentiles


def test_build_requests_makes_thirty_requests_of_seventy_five_documents() -> None:
    built = build_requests(candidates(200), ["q1", "q2", "q3"])
    assert len(built) == 30
    assert all(len(request.documents) == 75 for request in built)
    assert [request.query for request in built[:4]] == ["q1", "q2", "q3", "q1"]
    assert built == build_requests(candidates(200), ["q1", "q2", "q3"])


def test_build_requests_needs_enough_candidates() -> None:
    with pytest.raises(LiveProbeError):
        build_requests(candidates(74), ["q"])


def test_percentile_on_fixed_samples() -> None:
    samples = [float(value) for value in range(1, 101)]
    assert percentile(samples, 50) == pytest.approx(50.5)
    assert percentile(samples, 95) == pytest.approx(95.05)
    assert percentile([42.0], 95) == 42.0
    assert percentile([10.0, 20.0], 50) == pytest.approx(15.0)
    with pytest.raises(ValueError):
        percentile([], 50)


def test_request_headers_carry_only_the_placeholder() -> None:
    headers = request_headers("cohere", PLACEHOLDER_ENV)
    assert headers["authorization"] == "Bearer " + PLACEHOLDER_KEY
    with pytest.raises(LiveProbeError) as caught:
        request_headers("cohere", {"COHERE_API_KEY": "not-the-placeholder-value"})
    assert "not-the-placeholder-value" not in str(caught.value)


# ---------- probe


def test_run_probe_records_durations_and_counts_only() -> None:
    model = LIVE_MODELS[0]
    transport = FakeTransport()
    budget = RequestBudget(600)
    result = run_probe(
        model,
        requests_of(30),
        budget,
        transport=transport,
        clock=StepClock([0.1] * 28 + [0.5] * 2),
        env=PLACEHOLDER_ENV,
    )
    assert len(transport.calls) == 30
    assert transport.calls[0][0] == "https://api.cohere.com/v2/rerank"
    body = json.loads(transport.calls[0][2])
    assert body["model"] == "rerank-v5.0-pro" and len(body["documents"]) == 75
    assert result.n == 30 and result.errors == 0 and result.requests == 30
    assert result.p50_ms == pytest.approx(100.0)
    assert result.p95_ms == pytest.approx(100.0 + 0.55 * 400.0)
    assert budget.used == 30
    dumped = json.dumps(result.model_dump())
    for forbidden in (
        "Bearer",
        PLACEHOLDER_KEY,
        "authorization",
        "Synthetic passage",
        "neutral question",
    ):
        assert forbidden not in dumped
    assert set(result.model_dump()) == {
        "name",
        "vendor",
        "model",
        "requests",
        "n",
        "ok",
        "errors",
        "p50_ms",
        "p95_ms",
        "status_counts",
    }


def test_run_probe_uses_the_voyage_shape() -> None:
    transport = FakeTransport()
    run_probe(
        LIVE_MODELS[3],
        requests_of(2),
        RequestBudget(10),
        transport=transport,
        clock=StepClock([]),
        env=PLACEHOLDER_ENV,
    )
    url, _headers, raw = transport.calls[0]
    body = json.loads(raw)
    assert url == "https://api.voyageai.com/v1/rerank"
    assert (
        body["model"] == "rerank-3-lite"
        and body["truncation"] is True
        and body["return_documents"] is False
    )


def test_run_probe_refuses_to_start_over_the_remaining_cap() -> None:
    transport = FakeTransport()
    budget = RequestBudget(600)
    budget.take(580)
    with pytest.raises(BudgetExceeded):
        run_probe(
            LIVE_MODELS[0],
            requests_of(30),
            budget,
            transport=transport,
            clock=StepClock([]),
            env=PLACEHOLDER_ENV,
        )
    assert transport.calls == []
    assert budget.used == 580


def test_run_probe_refuses_a_real_looking_key() -> None:
    transport = FakeTransport()
    with pytest.raises(LiveProbeError):
        run_probe(
            LIVE_MODELS[0],
            requests_of(1),
            RequestBudget(10),
            transport=transport,
            clock=StepClock([]),
            env={"COHERE_API_KEY": "abc"},
        )
    assert transport.calls == []


@pytest.mark.parametrize("status", [429, 500, 503])
def test_retryable_status_is_retried_once_and_then_counted(status: int) -> None:
    transport = FakeTransport([status, status, status, 200])
    budget = RequestBudget(600)
    result = run_probe(
        LIVE_MODELS[0],
        requests_of(2),
        budget,
        transport=transport,
        clock=StepClock([]),
        env=PLACEHOLDER_ENV,
    )
    # first request: status, retry status -> error; second request: status, retry 200 -> ok
    assert len(transport.calls) == 4
    assert result.errors == 1 and result.ok == 1 and result.requests == 4
    assert budget.used == 4
    assert result.status_counts == {str(status): 3, "200": 1}


def test_client_error_is_not_retried() -> None:
    transport = FakeTransport([400, 200])
    result = run_probe(
        LIVE_MODELS[0],
        requests_of(2),
        RequestBudget(10),
        transport=transport,
        clock=StepClock([]),
        env=PLACEHOLDER_ENV,
    )
    assert len(transport.calls) == 2
    assert result.errors == 1 and result.ok == 1


def test_retry_never_crosses_the_cap() -> None:
    transport = FakeTransport([503, 503])
    budget = RequestBudget(1)
    result = run_probe(
        LIVE_MODELS[0],
        requests_of(1),
        budget,
        transport=transport,
        clock=StepClock([]),
        env=PLACEHOLDER_ENV,
    )
    assert len(transport.calls) == 1
    assert result.errors == 1 and budget.used == 1


def test_network_failure_is_an_error() -> None:
    transport = FakeTransport([0, 0])
    result = run_probe(
        LIVE_MODELS[0],
        requests_of(1),
        RequestBudget(10),
        transport=transport,
        clock=StepClock([]),
        env=PLACEHOLDER_ENV,
    )
    assert result.errors == 1 and result.p95_ms is None


# ---------- harness call counts


def test_harness_rerank_calls_counts_attempted_rerank_stages() -> None:
    statuses = [
        {"rerank": "ok"},
        {"rerank": "skipped"},
        {"rerank": "disabled"},
        {},
        {"rerank": "ok"},
    ]
    assert harness_rerank_calls(statuses) == 3


# ---------- orchestration (fake harness and fake transport, no vendor call)


def _report_json(run_id: str, recall: float, mrr: float) -> str:
    block = {"value": recall, "n": 10}
    metrics = {
        "recall_at_5": block,
        "recall_at_10": block,
        "mrr": {"value": mrr, "n": 10},
        "correct_refusal_rate": {"value": None, "n": 0},
        "false_refusal_rate": {"value": 0.0, "n": 10},
    }
    data = {
        "tier": "smoke",
        "golden_sha256": "g" * 64,
        "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
        "deployment_mode": "single-tenant",
        "request_options": {},
        "run_id": run_id,
        "run_config_hash": "r" * 64,
        "k_values": [5, 10],
        "overall": metrics,
        "by_language": {"en": metrics},
        "by_category": {},
        "by_language_category": {},
        "by_split": {},
        "items": [],
    }
    return EvalReport.model_validate(data).model_dump_json()


def _golden_file(path: Path, count: int) -> Path:
    from rag_eval.split import assign_split

    lines = []
    index = 0
    while len(lines) < count:
        item_id = f"en-general-{index:04d}"
        index += 1
        if assign_split(item_id) != "dev":
            continue
        lines.append(
            json.dumps(
                {
                    "answerable": True,
                    "category": "general",
                    "conversation": [],
                    "evidence_language": None,
                    "expected_answer": "A neutral answer.",
                    "gold_evidence": [
                        {
                            "document": "doc.en.md",
                            "quote": "A neutral quote",
                            "section": "Part",
                        }
                    ],
                    "id": item_id,
                    "language": "en",
                    "provenance": "synthetic_fixture",
                    "question": f"neutral question {index}",
                    "review_status": "approved",
                    "split": "dev",
                }
            )
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


class FakeHarness:
    def __init__(
        self,
        rerank_status: str = "ok",
        skipped_for: str | None = None,
        calls_per_item: int = 1,
    ) -> None:
        self.argvs: list[list[str]] = []
        self.envs: list[dict[str, str]] = []
        self.rerank_status = rerank_status
        self.skipped_for = skipped_for
        self.calls_per_item = calls_per_item

    def __call__(self, argv: list[str], env: dict[str, str]) -> int:
        self.argvs.append(argv)
        self.envs.append(dict(env))
        out = Path(argv[argv.index("--out") + 1])
        golden = Path(argv[argv.index("--golden") + 1])
        config = Path(argv[argv.index("--run-config") + 1]).stem
        out.mkdir(parents=True, exist_ok=True)
        count = sum(
            1
            for line in golden.read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
        status = (
            "skipped"
            if config == self.skipped_for
            else ("disabled" if not config.startswith("live-") else self.rerank_status)
        )
        traces = [
            json.dumps({"stage_status": {"rerank": status}})
            for _ in range(count * self.calls_per_item)
        ]
        (out / "traces.jsonl").write_text("\n".join(traces) + "\n", encoding="utf-8")
        recall = 0.9 if config.startswith("live-") else 0.8
        (out / "report.json").write_text(
            _report_json(f"run-{config}", recall, 0.7), encoding="utf-8"
        )
        return 0


def _run(
    tmp_path: Path,
    harness: FakeHarness,
    transport: FakeTransport,
    *,
    offline_only: bool = False,
    dev: int = 20,
    env=None,
) -> int:
    corpus = tmp_path / "corpus" / "en"
    corpus.mkdir(parents=True)
    (corpus / "doc.en.md").write_text(
        "\n\n<!-- chunk -->\n\n".join(
            f"Passage {i} on a neutral subject." for i in range(80)
        ),
        encoding="utf-8",
    )
    return run_live(
        golden=_golden_file(tmp_path / "golden.jsonl", dev),
        corpus=tmp_path / "corpus",
        runs_dir=RUNS,
        out_dir=tmp_path / "out",
        report_dir=tmp_path / "report",
        baseline=REPO / "eval" / "baselines" / "fixture-baseline.json",
        noise=REPO / "eval" / "config" / "noise.json",
        budgets_path=REPO / "eval" / "config" / "latency-budgets.json",
        offline_only=offline_only,
        spawner=harness,
        transport=transport,
        env=PLACEHOLDER_ENV if env is None else env,
    )


def test_offline_only_makes_no_vendor_call(tmp_path: Path) -> None:
    harness, transport = FakeHarness(), FakeTransport()
    assert _run(tmp_path, harness, transport, offline_only=True) == 0
    result = json.loads(
        (tmp_path / "report" / "result.json").read_text(encoding="utf-8")
    )
    assert (
        result["status"] == "pending_live"
        and result["total_requests"] == 0
        and result["models"] == []
    )
    assert set(result["offline_references"]) == {"local_bm25", "none"}
    assert transport.calls == [] and len(harness.argvs) == 2


def test_full_run_records_four_models_within_the_cap(tmp_path: Path) -> None:
    harness, transport = FakeHarness(), FakeTransport()
    assert _run(tmp_path, harness, transport, dev=20) == 0
    result = json.loads(
        (tmp_path / "report" / "result.json").read_text(encoding="utf-8")
    )
    assert result["status"] == "complete"
    assert len(result["models"]) == 4
    assert (
        result["dev_items_total"] == 20
        and result["dev_items_used"] == 20
        and result["sampled"] is False
    )
    assert result["total_requests"] == 4 * (20 + 30) <= 600
    assert len(transport.calls) == 120
    assert all(model["p95_ms"] is not None for model in result["models"])
    live_envs = [
        env
        for argv, env in zip(harness.argvs, harness.envs, strict=True)
        if "live-" in argv[argv.index("--run-config") + 1]
    ]
    assert len(live_envs) == 4 and all(
        env["NODE_USE_ENV_PROXY"] == "1" for env in live_envs
    )
    assert result["g7"]["auto_chat_cohere"] == "pass"
    text = (tmp_path / "report" / "report.md").read_text(encoding="utf-8") + json.dumps(
        result
    )
    assert (
        "authorization" not in text.lower()
        and "Bearer" not in text
        and PLACEHOLDER_KEY not in text
    )


def test_a_large_split_uses_one_sha256_subset_for_every_pass(tmp_path: Path) -> None:
    harness, transport = FakeHarness(), FakeTransport()
    assert _run(tmp_path, harness, transport, dev=150) == 0
    result = json.loads(
        (tmp_path / "report" / "result.json").read_text(encoding="utf-8")
    )
    assert (
        result["dev_items_total"] == 150
        and result["dev_items_used"] == 120
        and result["sampled"] is True
    )
    goldens = {argv[argv.index("--golden") + 1] for argv in harness.argvs}
    assert len(goldens) == 1 and goldens.pop().endswith("golden.dev-subset.jsonl")
    assert result["total_requests"] == 600


def test_a_harness_pass_with_more_calls_than_items_aborts(tmp_path: Path) -> None:
    harness, transport = FakeHarness(calls_per_item=2), FakeTransport()
    with pytest.raises(BudgetExceeded):
        _run(tmp_path, harness, transport)
    assert transport.calls == []


def test_a_high_vendor_error_rate_stops_the_run(tmp_path: Path) -> None:
    harness, transport = FakeHarness(skipped_for="live-cohere-fast"), FakeTransport()
    assert _run(tmp_path, harness, transport) == 1
    result = json.loads(
        (tmp_path / "report" / "result.json").read_text(encoding="utf-8")
    )
    assert result["status"] == "stopped" and "live-cohere-fast" in result["stop_reason"]
    assert transport.calls == []
    assert (
        sum(
            1
            for argv in harness.argvs
            if "live-" in argv[argv.index("--run-config") + 1]
        )
        == 2
    )


def test_a_real_looking_key_in_the_environment_is_refused(tmp_path: Path) -> None:
    harness, transport = FakeHarness(), FakeTransport()
    with pytest.raises(LiveProbeError) as caught:
        _run(
            tmp_path,
            harness,
            transport,
            env={"COHERE_API_KEY": "abcdefgh-not-placeholder"},
        )
    assert "abcdefgh" not in str(caught.value)
    assert harness.argvs == []
