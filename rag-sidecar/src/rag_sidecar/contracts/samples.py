import base64
from datetime import datetime, timezone
from typing import Any

from rag_sidecar.contracts import (
    AdvanceRequest,
    AdvanceResponse,
    BackfillDryRunReport,
    BackfillManifestEntry,
    DetectVlmRequest,
    DetectVlmResponse,
    IngestionJob,
    JobSettingsSnapshot,
    ParseExternalRequest,
    ParseExternalResponse,
    ParseGateReport,
    ParserEvalReport,
    ParserExpected,
    PageStructureVerdict,
    ParseAttempt,
    ParseRoutingConfig,
    PreflightResult,
    QualityCheckResult,
    Baseline,
    BaselineMetricStat,
    BaselineRun,
    ConversationTurn,
    DoclingOptions,
    DocTypeDetection,
    DraftedItemBatch,
    DraftedItemProposal,
    EvalReport,
    GateOffender,
    GoldenFilter,
    GateResult,
    GoldenItem,
    GoldenSplitManifest,
    GoldSpan,
    InjectionRule,
    InjectionRuleSet,
    InvoiceExtractRequest,
    InvoiceFields,
    InvoiceLineItem,
    InvoiceParty,
    ItemResult,
    JudgeConfig,
    JudgeItemScore,
    JudgeReport,
    LatencyBudgets,
    ActivationEvidence,
    ComparisonSliceBlock,
    EmbeddingProfileComparison,
    PreMigrationEvidence,
    PreMigrationSlice,
    ProfileComparisonEntry,
    ProfileMetricBlocks,
    MetricValue,
    NoiseConfig,
    OnlineJudgeConfig,
    PairedReport,
    PairedStat,
    ParseChunk,
    ParseJobAccepted,
    ParseJobRequest,
    ParseJobState,
    ParsePicture,
    ParseResult,
    ProcessingProfile,
    ProcessingProfileSet,
    ProfileBudget,
    ChunkingDecision,
    ChunkingProfile,
    ChunkingSweepReport,
    RefusalCalibrationConfig,
    RefusalCell,
    RefusalThresholds,
    RetrievalFilters,
    RetrievalOverrides,
    RetrievalParams,
    RagRunOptions,
    RagRunRequest,
    RagTrace,
    RunEmbedder,
    ReviewQueueItem,
    RunManifest,
    SidecarError,
    SidecarHealth,
    SidecarInfo,
    SidecarReady,
    SliceMetrics,
    StageLatency,
    TraceCandidate,
    TraceCitation,
    TraceEffectiveConfig,
    TraceKeptChunk,
    TraceQueryContext,
    TraceQueryTransform,
    TraceUsedDocument,
)

from rag_sidecar.contracts.parse_eval import (
    DuplicateCounts,
    ExpectedHeading,
    ExpectedPage,
    InventoryTotals,
    ModeProjection,
    PairedMetricDelta,
    ProjectedCostSplit,
    ReadingOrderAnchor,
    TableCell,
    TierParseMetrics,
    PageTierAccuracy,
)
from rag_sidecar.contracts.queue import (
    DetectVlmPageImage,
    DetectVlmPageResult,
    OriginalRef,
    ParseAttemptPages,
    ParseExternalPageText,
)
from rag_sidecar.contracts.routing import (
    DetectCounts,
    PageCheck,
    PageRange,
    PageSignals,
    ParseAttemptPages as RoutingParseAttemptPages,
    default_parse_routing_config,
)

_HASH_A = "a" * 64
_HASH_B = "b" * 64
_HASH_C = "c" * 64
_METRICS = ["recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate"]

_SAMPLE_JOB_ID = "00000000-0000-4000-8000-000000000001"
_SAMPLE_DOC_ID = "00000000-0000-4000-8000-000000000002"
_SAMPLE_NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
_TINY_PNG = base64.b64encode(b"\x89PNG" + b"\x00" * 8).decode("ascii")


def _phase31_contract_samples() -> dict[str, Any]:
    page = PageSignals(
        page=1,
        chars=120,
        text_layer=True,
        image_area_ratio=0.0,
        ruled_tables=0,
        aligned_number_rows=0,
        multi_column=False,
        has_figure=False,
        scanned=False,
        garbled_ratio=0.01,
        signals=[],
        layer="L1",
        tier="fast",
        preset="fast",
        continues_to_next=False,
    )
    page_range = PageRange(
        start=1,
        end=1,
        tier="fast",
        preset="fast",
        parser="docling",
        layer="L1",
        signals=[],
        status="ok",
    )
    settings = JobSettingsSnapshot(
        routing="tiered",
        cloud_allowed=True,
        escalation=True,
        progressive=False,
        premium_max_pages_per_doc=20,
        premium_page_budget=0,
        vlm_detect=False,
        profile_id="general@1",
        profile_version=1,
        doc_type="general",
        min_tier="fast",
        max_tier="premium",
        embed_mode="sync",
        ocr_languages=["en"],
        routing_config_version="1",
    )
    attempt = ParseAttempt(
        attempt_no=1,
        tier="fast",
        preset="fast",
        parser="docling",
        parser_version="2.0",
        pages=RoutingParseAttemptPages(start=1, end=1),
        reason="initial",
        ms=40,
        est_cost_usd=0.002,
        cache_hit=False,
        refused=False,
        check=QualityCheckResult(
            passed=True,
            pages=[PageCheck(page=1, failed=[])],
            score=1.0,
            partial=False,
        ),
    )
    verdict = PageStructureVerdict(
        has_table=False,
        has_multi_column=False,
        is_scanned=False,
        has_formula=False,
        has_chart=False,
        complexity="simple",
        confidence=0.92,
    )
    return {
        "PreflightResult": PreflightResult(
            probe_version="2026.1",
            page_count=1,
            encrypted=False,
            doc_class="text_pdf",
            pages=[page],
            ranges=[page_range],
            tier_page_counts={"native": 0, "fast": 1, "structured": 0, "premium": 0},
            detect_counts=DetectCounts(L1=1, L2=0, L3=0, gated_share=0.0),
            timings_ms={"preflight": 10},
        ),
        "PageStructureVerdict": verdict,
        "ParseRoutingConfig": default_parse_routing_config(),
        "ParseAttempt": attempt,
        "QualityCheckResult": QualityCheckResult(
            passed=False,
            pages=[PageCheck(page=1, failed=["low_chars"])],
            score=0.45,
            partial=False,
        ),
        "JobSettingsSnapshot": settings,
        "IngestionJob": IngestionJob(
            id=_SAMPLE_JOB_ID,
            kind="ingest",
            status="queued",
            tenant_key="tenant-a",
            source="upload",
            source_key="docs/sample.pdf",
            file_sha256=_HASH_A,
            filename="sample.pdf",
            mime_type="application/pdf",
            original_ref=OriginalRef(bucket="originals", path="tenant-a/sample.pdf"),
            settings=settings,
            attempts=[attempt],
            page_ranges=[page_range],
            tier_page_counts={"fast": 1},
            created_at=_SAMPLE_NOW,
            updated_at=_SAMPLE_NOW,
        ),
        "DetectVlmRequest": DetectVlmRequest(
            worker_id="worker-1",
            attempt_no=1,
            pages=[DetectVlmPageImage(page=1, png_base64=_TINY_PNG)],
        ),
        "DetectVlmResponse": DetectVlmResponse(
            worker_id="worker-1",
            pages=[DetectVlmPageResult(page=1, verdict=verdict)],
        ),
        "ParseExternalRequest": ParseExternalRequest(
            worker_id="worker-1",
            attempt_no=1,
            mode="native",
        ),
        "ParseExternalResponse": ParseExternalResponse(
            worker_id="worker-1",
            status="done",
            cache_id="cache-1",
        ),
        "AdvanceRequest": AdvanceRequest(
            worker_id="worker-1",
            attempt_no=1,
            phase="begin",
            deadline_ms=10_000,
        ),
        "AdvanceResponse": AdvanceResponse(
            worker_id="worker-1",
            stage="identify",
            done=False,
            wait_ms=0,
        ),
        "BackfillManifestEntry": BackfillManifestEntry(
            source_key="kb/doc-1",
            path="/data/doc-1.pdf",
            doc_type="general",
        ),
        "BackfillDryRunReport": BackfillDryRunReport(
            inventory=InventoryTotals(files=100, bytes=50_000_000, pages_estimated=500),
            duplicates=DuplicateCounts(in_inventory=3, already_existing=2),
            sample_size_by_class={"text_pdf": 5},
            class_shares={"text_pdf": 0.7},
            projected_pages_by_tier={"fast": 300, "structured": 150, "premium": 50},
            projected_l2_pages=40,
            projected_l3_pages=5,
            projected_cost=ProjectedCostSplit(
                premium_parse_usd=2.0,
                vlm_usd=0.5,
                embeddings_usd=1.0,
                total_usd=3.5,
            ),
            projected_wall_time_s=3600.0,
            embedding_cost_by_profile_usd={"general@1": 1.0},
            budget_usd=10.0,
            fits_budget=True,
        ),
        "ParserExpected": ParserExpected(
            fixture_id="digital-text",
            language="en",
            pages=[ExpectedPage(page=1, signals=[], tier="fast", preset="fast")],
            table_cells=[TableCell(row=0, col=0, text="A1")],
            reading_order=[ReadingOrderAnchor(text="intro", page=1, order=0)],
            headings=[ExpectedHeading(text="Overview", level=1, page=1)],
        ),
        "ParserEvalReport": ParserEvalReport(
            fixture_id="digital-text",
            by_tier={
                "fast": TierParseMetrics(
                    text_similarity=0.95,
                    table_cell_f1=0.9,
                    reading_order=0.98,
                    headings_f1=0.92,
                    s_per_page=0.8,
                    cost_per_page=0.001,
                    recall_at_k=0.88,
                )
            },
            page_tier_accuracy=[PageTierAccuracy(layer_combo="L1", pages_below_expected_tier=0)],
        ),
        "ParseGateReport": ParseGateReport(
            recall_at_k=[PairedMetricDelta(metric="recall_at_5", delta=0.01, within_noise_band=True)],
            correct_refusal=[PairedMetricDelta(metric="correct_refusal_rate", delta=0.0, within_noise_band=True)],
            noise_band_k=3.0,
            noise_band_floor=0.02,
            fixed=ModeProjection(premium_page_share=0.02, projected_cost_per_1000_pages_usd=4.0),
            tiered=ModeProjection(premium_page_share=0.05, projected_cost_per_1000_pages_usd=6.0),
            passed=True,
        ),
    }


_DOC_TYPES = [
    "general",
    "financial_report",
    "contract_legal",
    "invoice_receipt",
    "product_technical",
    "scanned_image",
]
_SAMPLE_CLAUSE_PATTERNS = [r"^Art\.?\s*\d+", r"^Article\s+\d+"]


def _processing_profile(doc_type: str) -> ProcessingProfile:
    legal = doc_type == "contract_legal"
    scanned = doc_type == "scanned_image"
    return ProcessingProfile.model_validate(
        {
            "id": f"{doc_type}@1",
            "version": 1,
            "doc_type": doc_type,
            "parser": {
                "preference": ["docling"] if scanned else ["configured"],
                "docling": {
                    "ocr": True,
                    "force_full_page_ocr": scanned,
                    "table_mode": "accurate" if doc_type == "financial_report" else "fast",
                    "heading_hierarchy": True,
                    "generate_picture_images": True,
                },
                "ocr_languages": ["zh", "en", "it"],
            },
            "chunker": {
                "kind": "legal_clauses" if legal else "markdown_sections",
                "max_tokens": 768 if legal else 512,
                "overlap_tokens": 0 if legal else 64,
                "repeat_table_header": doc_type == "financial_report",
                "min_chunk_tokens": 32,
                "clause_patterns": _SAMPLE_CLAUSE_PATTERNS if legal else [],
                "lead_in_phrases": ["except as follows"] if legal else [],
            },
            "extractors": ["dates"],
            "embedding_text_template": {"version": 1, "header": "Contract {title}" if legal else None},
            "scan_injection": True,
            "min_tier": "fast" if legal else None,
            "max_tier": "premium" if legal else None,
            "parent_child": {"parent_max_tokens": 2048, "child_max_tokens": 256} if legal else None,
        }
    )


def _injection_rules() -> InjectionRuleSet:
    return InjectionRuleSet(
        rules=[
            InjectionRule(
                id="en-ignore-previous",
                language="en",
                pattern="ignore previous instructions",
                kind="phrase",
                severity="high",
            ),
            InjectionRule(
                id="zh-ignore-previous",
                language="zh",
                pattern="忽略之前的指令",
                kind="phrase",
                severity="high",
            ),
            InjectionRule(
                id="any-you-are-now",
                language="any",
                pattern=r"you\s+are\s+now\b",
                kind="regex",
                severity="low",
            ),
        ]
    )


def _parse_result() -> ParseResult:
    table_header = "| Item | Amount |\n| --- | --- |"
    return ParseResult(
        markdown="# Report\n\n## Results\n\nRevenue grew in the second quarter.\n\n" + table_header + "\n| Fees | 10 |\n",
        chunks=[
            ParseChunk(
                text="Revenue grew in the second quarter.",
                contextualized_text="Report > Results\nRevenue grew in the second quarter.",
                headings=["Report", "Results"],
                pages=[1],
                is_table=False,
            ),
            ParseChunk(
                text=table_header + "\n| Fees | 10 |",
                contextualized_text="Report > Tables\n" + table_header + "\n| Fees | 10 |",
                headings=["Report", "Tables"],
                pages=[2, 3],
                is_table=True,
                table_header=table_header,
            ),
        ],
        pictures=[ParsePicture(page=2, bbox=[10.0, 20.0, 110.0, 220.0], image_ref="picture-1.png", page_area_share=0.12)],
        page_count=3,
        language="en",
        parser="docling",
        parser_version="0.0.0-sample",
        warnings=["synthetic sample"],
        partial=False,
        artifacts=["docling.json", "picture-1.png"],
        text_layer_page_share=1.0,
    )


def _invoice_fields() -> InvoiceFields:
    return InvoiceFields(
        invoice_number="INV-2026-0001",
        issue_date="2026-01-31",
        due_date="2026-02-28",
        supplier=InvoiceParty(name="示例供应商有限公司", tax_id="91000000MA0000000N", tax_id_scheme="cn_uscc"),
        buyer=InvoiceParty(name="Esempio Acquirente S.r.l.", tax_id="99999999990", tax_id_scheme="it_iva"),
        currency="EUR",
        net_total="100.00",
        tax_total="22.00",
        gross_total="122.00",
        line_items=[
            InvoiceLineItem(description="咨询服务", quantity="2", unit_price="50.00", amount="100.00", tax_rate="22")
        ],
        confidence=0.9,
        errors=[],
    )


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
        false_refusal_upper_95=0.25,
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


def _cross_lingual_item() -> GoldenItem:
    return GoldenItem(
        id="xl-en-zh-01",
        question="How many days of annual leave does a new employee get?",
        language="en",
        category="cross_lingual",
        answerable=True,
        expected_answer="Five days per year.",
        gold_evidence=[GoldSpan(document="handbook.zh.md", section="Leave policy", quote="每年 5 天")],
        evidence_language="zh",
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
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
        stage_latency_ms={"analyze": 1.5, "embed": 4.0, "search": 7.0, "generation": 0.0},
        stage_status={"analyze": "ok", "embed": "ok", "search": "ok", "generation": "ok"},
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
        embedder_source_sha256=_HASH_A,
        deployment_mode="single-tenant",
        request_options=RagRunOptions(max_results=10, generator_model=None),
        k_values=[5, 10],
        overall=_slice_metrics(),
        by_language={"en": _slice_metrics()},
        by_category={"general": _slice_metrics()},
        by_language_category={"en:general": _slice_metrics()},
        by_language_pair={"en->zh": _slice_metrics()},
        by_doc_type={"general": _slice_metrics()},
        by_question_kind={"fact_lookup": _slice_metrics()},
        by_split={"dev": _slice_metrics()},
        by_provenance={"synthetic_fixture": _slice_metrics()},
        by_provenance_category={"synthetic_fixture/general": _slice_metrics()},
        gate_population="all",
        rerank_skipped_rate=MetricValue(value=0.25, n=4),
        lexical_leg_hit_rate_at_10=MetricValue(value=0.75, n=4),
        items=[
            ItemResult(
                item_id="en-general-001",
                language="en",
                category="general",
                split="dev",
                provenance="synthetic_fixture",
                answerable=True,
                refused=False,
                span_count=1,
                spans_hit_at_5=1,
                spans_hit_at_10=1,
                first_hit_rank=1,
                doc_type="general",
                question_kind="fact_lookup",
                rerank_status="ok",
                lexical_hit_at_10=True,
            )
        ],
        latency={
            "embed": StageLatency(p50_ms=4.0, p95_ms=6.0, n=12),
            "retrieval_total": StageLatency(p50_ms=12.0, p95_ms=20.0, n=12),
        },
        notes=["synthetic sample"],
    )


def _latency_budgets() -> LatencyBudgets:
    return LatencyBudgets(
        profiles={
            "chat": ProfileBudget(
                total_p50_ms=1000, total_p95_ms=2000, stages={"embed": 200, "search": 400, "assemble": 100}
            ),
            "voice": ProfileBudget(total_p50_ms=400, total_p95_ms=800),
        }
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
        tier="smoke",
        deployment_mode="single-tenant",
        request_options=RagRunOptions(max_results=10),
        corpus_sha256=_HASH_B,
        golden_sha256=_HASH_C,
        golden_filter=_golden_filter(),
        embedder_id="fixture-embedder",
        embedder_version=1,
        embedder_source_sha256=_HASH_A,
        run_config_hash=_HASH_A,
        runs=runs,
        slices={"overall": {name: stat for name in _METRICS}},
        items={"item-001": {name: [0.5, 0.5, 0.5] for name in _METRICS}},
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


def _comparison_block() -> ComparisonSliceBlock:
    metrics = _slice_metrics()
    return ComparisonSliceBlock(
        overall=metrics,
        by_language={"en": metrics},
        by_category={"general": metrics, "cross_lingual": metrics},
        by_language_pair={"en->zh": metrics},
    )


def _profile_comparison() -> EmbeddingProfileComparison:
    profile_metrics = ProfileMetricBlocks(gated=_comparison_block(), candidates=_comparison_block())
    return EmbeddingProfileComparison(
        baseline_profile="openai-3-small-1536",
        active_profile="openai-3-small-1536",
        profiles=[
            ProfileComparisonEntry(profile_id="openai-3-small-1536", metrics=profile_metrics),
            ProfileComparisonEntry(
                profile_id="voyage-4-large-2048",
                metrics=profile_metrics,
                default_candidate=False,
                default_candidate_note="does not beat baseline on cross_lingual",
            ),
        ],
        pre_migration=PreMigrationSlice(
            n=2,
            passed=True,
            recall_at_5=MetricValue(value=0.5, n=2),
            recall_at_10=MetricValue(value=0.5, n=2),
            mrr=MetricValue(value=0.25, n=2),
        ),
        gate_passed=True,
        backfill_run_id="01234567-0123-4012-8012-0123456789ab",
        notes=["Fixture sample only."],
    )


def _activation_evidence() -> ActivationEvidence:
    return ActivationEvidence(
        target_profile="voyage-4-large-2048",
        baseline_profile="openai-3-small-1536",
        gate_passed=True,
        pre_migration=PreMigrationEvidence(passed=True, n=2),
        backfill_run_id="01234567-0123-4012-8012-0123456789ab",
        recorded_at="2026-11-24T12:00:00.000Z",
    )


def _models() -> dict[str, Any]:
    return {
        "ConversationTurn": ConversationTurn(role="user", content="Tell me about leave."),
        "ProcessingProfileSet": ProcessingProfileSet(profiles=[_processing_profile(name) for name in _DOC_TYPES]),
        "DocTypeDetection": DocTypeDetection(
            doc_type="invoice_receipt", confidence=0.85, signals=["keyword:invoice", "pattern:invoice_number"], method="rules"
        ),
        "InjectionRuleSet": _injection_rules(),
        "ParseJobRequest": ParseJobRequest(
            profile_id="financial_report@1",
            profile_version=1,
            docling=DoclingOptions(
                ocr=True,
                force_full_page_ocr=False,
                table_mode="accurate",
                heading_hierarchy=True,
                generate_picture_images=True,
            ),
            ocr_languages=["zh", "en", "it"],
            tokenizer="cl100k_base",
            max_tokens=512,
            repeat_table_header=True,
            input_format="pdf",
            page_cap=200,
        ),
        "ParseJobAccepted": ParseJobAccepted(job_id="job-0123abcd"),
        "ParseJobState": ParseJobState(job_id="job-0123abcd", status="succeeded", result=_parse_result()),
        "ParseResult": _parse_result(),
        "InvoiceExtractRequest": InvoiceExtractRequest(
            markdown="发票号码：INV-2026-0001\n\n| 项目 | 金额 |\n| --- | --- |\n| 咨询服务 | 100.00 |\n",
            tables=["| 项目 | 金额 |\n| --- | --- |\n| 咨询服务 | 100.00 |"],
            language_hint="zh",
        ),
        "InvoiceFields": _invoice_fields(),
        "RagRunRequest": RagRunRequest(
            item_id="en-general-001",
            query="How many leave days do employees get?",
            conversation=[ConversationTurn(role="user", content="Tell me about leave.")],
            rag_mode="strict",
            options=RagRunOptions(max_results=10, generator_model="generator/model-b", degrade="drop_top_candidate"),
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
        "LatencyBudgets": _latency_budgets(),
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
            paired=PairedReport(
                seed=20261123,
                resamples=10000,
                all_zero=False,
                slices={
                    "overall": {
                        "mrr": PairedStat(n=4, n_nonzero=1, mean_d=0.25, ci_low=0.0, ci_high=0.5),
                        "false_refusal_rate": PairedStat(n=0, n_nonzero=0, mean_d=None, ci_low=None, ci_high=None),
                    }
                },
            ),
        ),
        "JudgeConfig": JudgeConfig(
            judge_model="judge/model-a",
            judge_family="judge-family",
            provider="openrouter",
            base_url="https://example.invalid/api/v1",
            temperature=0.0,
            embedding_model="embed/model-c",
            online_judge=OnlineJudgeConfig(
                sample_rate=0.2,
                seed=1,
                judge_model="online-judge/model-d",
                judge_family="online-judge-family",
            ),
        ),
        "JudgeReport": _judge_report(),
        "ReviewQueueItem": ReviewQueueItem(
            trace_id="0123456789abcdef0123456789abcdef",
            observation_id="0123456789abcdef",
            captured_at="2026-01-01T00:00:00.000Z",
            tenant_key="tenant-a",
            language="en",
            query_masked="How many leave days do employees get?",
            answer_masked="Twenty days per year.",
            context_masked="Employees receive twenty days of leave per year.",
            model="generator/model-b",
            tags=["review_candidate"],
        ),
        "SidecarHealth": SidecarHealth(status="ok"),
        "SidecarReady": SidecarReady(status="not_ready", reason="warming up"),
        "SidecarInfo": SidecarInfo(service="rag-sidecar", version="0.0.0", contracts_schema_version=1),
        "SidecarError": SidecarError(error="synthetic error"),
        "EmbeddingProfileComparison": _profile_comparison(),
        "ActivationEvidence": _activation_evidence(),
        "RetrievalParams": RetrievalParams(),
        "RetrievalOverrides": RetrievalOverrides(final_top_k=10),
        "RetrievalFilters": RetrievalFilters(sources=["manual"], languages=["en"]),
        "RefusalThresholds": RefusalThresholds(),
        "RefusalCalibrationConfig": RefusalCalibrationConfig(),
        "ChunkingProfile": ChunkingProfile.model_validate(
            {
                "id": "general@256x1024",
                "doc_type": "general",
                "child_tokens": 256,
                "parent_mode": "structure",
                "parent_tokens": 512,
                "status": "ready",
                "preset": "256/1024",
            },
            context={"max_child_tokens": 8191, "top_k": 8, "context_budget": 6000},
        ),
        "ChunkingSweepReport": ChunkingSweepReport(profiles=[], provenance={"source": "defaults"}),
        "ChunkingDecision": ChunkingDecision(
            doc_type="general",
            profile_id="general@256x1024",
            chosen_on={"recall_at_5": 0.72},
            gate_passed=True,
            regressions=[],
            build_run_id="build-run-001",
            report_hash=_HASH_A,
            decided_by="admin",
            recorded_at="2026-01-01T00:00:00.000Z",
            source="fixture",
        ),
        **_phase31_contract_samples(),
    }


def build_samples() -> dict[str, dict[str, Any]]:
    samples = {name: model.model_dump(mode="json") for name, model in _models().items()}
    variants: dict[str, dict[str, Any]] = {
        "GoldenItem:no_answer_null_expected": {
            "model": "GoldenItem",
            "value": _no_answer_item().model_dump(mode="json"),
        },
        "GoldenItem:cross_lingual": {
            "model": "GoldenItem",
            "value": _cross_lingual_item().model_dump(mode="json"),
        },
        "RagTrace:answer_null": {
            "model": "RagTrace",
            "value": _trace(None).model_dump(mode="json"),
        },
        "RagRunRequest:query_only": {
            "model": "RagRunRequest",
            "value": {"query": "How many leave days do employees get?"},
        },
        "ParseJobState:running_without_result": {
            "model": "ParseJobState",
            "value": ParseJobState(job_id="job-0123abcd", status="running").model_dump(mode="json"),
        },
        "ParseJobState:failed_with_error_class": {
            "model": "ParseJobState",
            "value": ParseJobState(job_id="job-0123abcd", status="failed", error_class="ocr_failed").model_dump(
                mode="json"
            ),
        },
        "InvoiceFields:nothing_extracted": {
            "model": "InvoiceFields",
            "value": InvoiceFields(confidence=0.0, errors=["no invoice number found"]).model_dump(mode="json"),
        },
    }
    return {"samples": samples, "variants": variants}
