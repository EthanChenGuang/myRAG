from typing import Any

from rag_sidecar.contracts import (
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

_HASH_A = "a" * 64
_HASH_B = "b" * 64
_HASH_C = "c" * 64
_METRICS = ["recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate"]


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
        by_split={"dev": _slice_metrics()},
        by_provenance={"synthetic_fixture": _slice_metrics()},
        by_provenance_category={"synthetic_fixture/general": _slice_metrics()},
        gate_population="all",
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
