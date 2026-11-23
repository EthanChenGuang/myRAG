from typing import Any

from rag_sidecar.contracts import (
    Baseline,
    BaselineMetricStat,
    BaselineRun,
    ConversationTurn,
    DraftedItemBatch,
    DraftedItemProposal,
    EvalReport,
    GateOffender,
    GoldenFilter,
    GateResult,
    GoldenItem,
    GoldenSplitManifest,
    GoldSpan,
    ItemResult,
    JudgeConfig,
    JudgeItemScore,
    JudgeReport,
    MetricValue,
    NoiseConfig,
    RagRunOptions,
    RagRunRequest,
    RagTrace,
    RunEmbedder,
    RunManifest,
    SidecarError,
    SidecarHealth,
    SidecarInfo,
    SidecarReady,
    SliceMetrics,
    TraceCandidate,
    TraceCitation,
    TraceEffectiveConfig,
    TraceKeptChunk,
    TraceQueryContext,
    TraceQueryTransform,
    TraceUsedDocument,
)

_HASH_A = "a" * 64
_HASH_B = "b" * 64
_HASH_C = "c" * 64
_METRICS = ["recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate"]


def _golden_filter() -> GoldenFilter:
    return GoldenFilter(review_statuses=["approved"], gate_split="dev")


def _metric() -> MetricValue:
    return MetricValue(value=0.5, n=10)


def _slice_metrics() -> SliceMetrics:
    return SliceMetrics(
        recall_at_5=_metric(),
        recall_at_10=_metric(),
        mrr=_metric(),
        correct_refusal_rate=_metric(),
        false_refusal_rate=_metric(),
    )


def _span() -> GoldSpan:
    return GoldSpan(document="handbook.md", section="Leave policy", quote="twenty days")


def _golden_item() -> GoldenItem:
    return GoldenItem(
        id="en-general-001",
        question="How many leave days do employees get?",
        conversation=[
            ConversationTurn(role="user", content="Tell me about leave."),
            ConversationTurn(role="assistant", content="Which part of the policy?"),
        ],
        language="en",
        category="general",
        answerable=True,
        expected_answer="Twenty days per year.",
        gold_evidence=[_span()],
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
    )


def _no_answer_item() -> GoldenItem:
    return GoldenItem(
        id="en-no-answer-001",
        question="What is the CEO's favourite colour?",
        language="en",
        category="no_answer",
        answerable=False,
        expected_answer=None,
        review_status="approved",
        provenance="synthetic_fixture",
        split="test",
    )


def _trace(answer: str | None) -> RagTrace:
    return RagTrace(
        item_id="en-general-001",
        query="How many leave days do employees get?",
        query_context=TraceQueryContext(
            is_temporal_query=False,
            is_financial_query=False,
            required_precision="medium",
            suggested_threshold=0.3,
            search_strategy="semantic_only",
        ),
        retrieval_strategy="standard",
        query_transforms=[TraceQueryTransform(kind="rewrite", text="leave days per year")],
        candidates=[
            TraceCandidate(
                rank=1,
                chunk_id="chunk-001",
                document_id="doc-001",
                document_name="handbook.md",
                content="Employees receive twenty days of leave per year.",
                similarity=0.82,
                final_score=0.85,
                match_reason="vector",
                has_image=False,
            ),
            TraceCandidate(
                rank=2,
                chunk_id="chunk-002",
                document_id="doc-002",
                content="Office hours are nine to five.",
                similarity=0.41,
                has_image=False,
            ),
        ],
        kept=[
            TraceKeptChunk(
                rank=1,
                chunk_id="chunk-001",
                document_id="doc-001",
                document_name="handbook.md",
                content="Employees receive twenty days of leave per year.",
                similarity=0.82,
                kept_by="similarity",
            )
        ],
        used_documents=[
            TraceUsedDocument(
                document_id="doc-001",
                name="handbook.md",
                similarity=0.82,
                image_url="https://example.invalid/image.png",
            )
        ],
        context="Employees receive twenty days of leave per year.",
        refused=False,
        refusal_reason=None,
        answer=answer,
        citations=[TraceCitation(document_id="doc-001", chunk_id="chunk-001")],
        stage_latency_ms={"retrieval": 12.5, "generation": 0.0},
        effective_config=TraceEffectiveConfig(
            rag_env={"RAG_BEHAVIOR_MODE": "strict"},
            rag_prompt_sha256={"RAG_SYSTEM_PROMPT": _HASH_A},
            deployment_mode="single-tenant",
            embedding_model="text-embedding-3-small",
            endpoint_version="1",
            generator_model=None,
        ),
        config_hash=_HASH_B,
    )


def _eval_report() -> EvalReport:
    return EvalReport(
        run_id="run-001",
        tier="smoke",
        run_config_hash=_HASH_A,
        corpus_sha256=_HASH_B,
        golden_sha256=_HASH_C,
        golden_filter=_golden_filter(),
        embedder_id="fixture-embedder",
        embedder_version=1,
        deployment_mode="single-tenant",
        request_options=RagRunOptions(max_results=10, generator_model=None),
        k_values=[5, 10],
        overall=_slice_metrics(),
        by_language={"en": _slice_metrics()},
        by_category={"general": _slice_metrics()},
        by_language_category={"en:general": _slice_metrics()},
        by_split={"dev": _slice_metrics()},
        items=[
            ItemResult(
                item_id="en-general-001",
                language="en",
                category="general",
                split="dev",
                answerable=True,
                refused=False,
                span_count=1,
                spans_hit_at_5=1,
                spans_hit_at_10=1,
                first_hit_rank=1,
            )
        ],
        notes=["synthetic sample"],
    )


def _baseline() -> Baseline:
    stat = BaselineMetricStat(mean=0.5, spread=0.01, runs=[0.49, 0.5, 0.51], n=10)
    runs = [
        BaselineRun(
            run_id=f"run-00{index}",
            run_config_hash=_HASH_A,
            git_sha=None,
            created_at="2026-01-01T00:00:00Z",
        )
        for index in range(1, 4)
    ]
    return Baseline(
        spread_kind="stdev_ddof1",
        corpus_sha256=_HASH_B,
        golden_sha256=_HASH_C,
        golden_filter=_golden_filter(),
        embedder_id="fixture-embedder",
        embedder_version=1,
        run_config_hash=_HASH_A,
        runs=runs,
        slices={"overall": {name: stat for name in _METRICS}},
    )


def _judge_report() -> JudgeReport:
    return JudgeReport(
        run_id="run-001",
        run_config_hash=_HASH_A,
        judge_model="judge/model-a",
        judge_family="judge-family",
        generator_model="generator/model-b",
        generator_family="generator-family",
        items=[
            JudgeItemScore(
                item_id="en-general-001",
                language="en",
                category="general",
                library="ragas",
                metric="faithfulness",
                score=0.9,
            ),
            JudgeItemScore(
                item_id="en-general-001",
                language="en",
                category="general",
                library="deepeval",
                metric="answer_relevance",
                score=None,
                skipped_reason="no answer generated",
            ),
        ],
        overall={"faithfulness": _metric()},
        by_language={"en": {"faithfulness": _metric()}},
        by_category={"general": {"faithfulness": _metric()}},
    )


def _run_manifest() -> RunManifest:
    return RunManifest(
        run_id="run-001",
        tier="smoke",
        created_at="2026-01-01T00:00:00Z",
        git_sha=None,
        deployment_mode="single-tenant",
        embedder=RunEmbedder(id="fixture-embedder", version="1", source_sha256=_HASH_A),
        corpus_sha256=_HASH_B,
        golden_path="eval/fixtures/golden.jsonl",
        golden_sha256=_HASH_C,
        golden_filter=_golden_filter(),
        sql_sha256={"single-tenant-setup.sql": _HASH_A},
        request_options=RagRunOptions(max_results=10),
        effective_config_hash=_HASH_B,
        run_config_hash=_HASH_A,
        item_count=1,
        edge_errors=0,
    )


def _models() -> dict[str, Any]:
    return {
        "ConversationTurn": ConversationTurn(role="user", content="Tell me about leave."),
        "RagRunRequest": RagRunRequest(
            item_id="en-general-001",
            query="How many leave days do employees get?",
            conversation=[ConversationTurn(role="user", content="Tell me about leave.")],
            rag_mode="strict",
            options=RagRunOptions(max_results=10, generator_model="generator/model-b"),
            include_answer=True,
        ),
        "RagTrace": _trace("Twenty days per year."),
        "RunManifest": _run_manifest(),
        "GoldenItem": _golden_item(),
        "GoldenSplitManifest": GoldenSplitManifest(
            rule="sha256-first8hex-mod100-lt70-dev",
            assignments={"en-general-001": "dev", "en-no-answer-001": "test"},
        ),
        "DraftedItemBatch": DraftedItemBatch(
            items=[
                DraftedItemProposal(
                    question="How many leave days do employees get?",
                    language="en",
                    category="general",
                    answerable=True,
                    expected_answer="Twenty days per year.",
                    gold_evidence=[_span()],
                )
            ]
        ),
        "EvalReport": _eval_report(),
        "Baseline": _baseline(),
        "NoiseConfig": NoiseConfig(),
        "GateResult": GateResult(
            passed=False,
            offenders=[
                GateOffender(
                    slice="overall",
                    metric="recall_at_5",
                    baseline_mean=0.5,
                    threshold=0.45,
                    observed=0.3,
                    direction="higher",
                )
            ],
            skipped=["by_category:table"],
            mismatches=[],
        ),
        "JudgeConfig": JudgeConfig(
            judge_model="judge/model-a",
            judge_family="judge-family",
            provider="openrouter",
            base_url="https://example.invalid/api/v1",
            temperature=0.0,
            embedding_model="embed/model-c",
        ),
        "JudgeReport": _judge_report(),
        "SidecarHealth": SidecarHealth(status="ok"),
        "SidecarReady": SidecarReady(status="not_ready", reason="warming up"),
        "SidecarInfo": SidecarInfo(service="rag-sidecar", version="0.0.0", contracts_schema_version=1),
        "SidecarError": SidecarError(error="synthetic error"),
    }


def build_samples() -> dict[str, dict[str, Any]]:
    samples = {name: model.model_dump(mode="json") for name, model in _models().items()}
    variants: dict[str, dict[str, Any]] = {
        "GoldenItem:no_answer_null_expected": {
            "model": "GoldenItem",
            "value": _no_answer_item().model_dump(mode="json"),
        },
        "RagTrace:answer_null": {
            "model": "RagTrace",
            "value": _trace(None).model_dump(mode="json"),
        },
        "RagRunRequest:query_only": {
            "model": "RagRunRequest",
            "value": {"query": "How many leave days do employees get?"},
        },
    }
    return {"samples": samples, "variants": variants}
