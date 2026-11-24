export type IngestPipeline = 'legacy' | 'unified';
export type IngestParser = 'llamaparse' | 'docling';
export type InjectionScanMode = 'off' | 'quarantine';
export type EmbeddingProfilesMode = 'off' | 'on';
export type QwenEmbedFallback = 'openrouter' | 'none';

export interface IngestEnvInput {
  RAG_INGEST_PIPELINE?: string;
  RAG_PARSER?: string;
  RAG_PARSE_POLL_BUDGET_MS?: string;
  RAG_DOC_TYPE_LLM_DETECT?: string;
  RAG_INVOICE_LLM_EXTRACT?: string;
  RAG_EXACT_ID_LOOKUP?: string;
  RAG_PDF_IMAGE_CHUNKS?: string;
  RAG_INJECTION_SCAN?: string;
  RAG_EMBEDDING_PROFILES?: string;
  RAG_QWEN_EMBED_FALLBACK?: string;
}

export interface IngestConfig {
  pipeline: IngestPipeline;
  parser: IngestParser;
  parsePollBudgetMs: number;
  docTypeLlmDetect: boolean;
  invoiceLlmExtract: boolean;
  exactIdLookup: boolean;
  pdfImageChunks: boolean;
  injectionScan: InjectionScanMode;
  embeddingProfiles: EmbeddingProfilesMode;
  qwenFallback: QwenEmbedFallback;
  warnings: string[];
}

export function loadIngestConfig(_env: IngestEnvInput): IngestConfig {
  return {
    pipeline: 'legacy',
    parser: 'llamaparse',
    parsePollBudgetMs: 45000,
    docTypeLlmDetect: false,
    invoiceLlmExtract: false,
    exactIdLookup: false,
    pdfImageChunks: false,
    injectionScan: 'off',
    embeddingProfiles: 'off',
    qwenFallback: 'openrouter',
    warnings: [],
  };
}

export function resetIngestConfigForTests(): void {}
