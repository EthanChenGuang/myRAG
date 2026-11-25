export type IngestPipeline = 'legacy' | 'unified';
export type IngestParser = 'llamaparse' | 'docling';
export type InjectionScanMode = 'off' | 'quarantine';
export type EmbeddingProfilesMode = 'off' | 'on';
export type QwenEmbedFallback = 'openrouter' | 'none';
export type OffOn = 'off' | 'on';
export type TableHeaderRepeat = 'profile' | 'always';
export type CaptionLanguage = 'en' | 'document';
export type IngestCheckMode = 'off' | 'flag' | 'quarantine';
export type UploadApprovalMode = 'off' | 'members' | 'all';
export type DomainEmbeddingsMode = 'off' | 'on';

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
  RAG_LANGUAGE_AWARE_INGEST?: string;
  RAG_TABLE_HEADER_REPEAT?: string;
  RAG_TABLE_ROW_SERIALIZATION?: string;
  RAG_CAPTION_LANGUAGE?: string;
  RAG_DOC_TRANSLATION?: string;
  RAG_DOC_TRANSLATION_MODEL?: string;
  RAG_HIDDEN_TEXT_CHECK?: string;
  RAG_INGEST_LINK_CHECK?: string;
  RAG_OUTPUT_LINK_ALLOWLIST?: string;
  RAG_UPLOAD_APPROVAL?: string;
  RAG_SCOPE_TAGS?: string;
  RAG_SCOPE_TAG_SUGGEST?: string;
  RAG_SUPERSESSION_DETECT?: string;
  RAG_EFFECTIVE_DATE_LLM_EXTRACT?: string;
  RAG_DOMAIN_EMBEDDINGS?: string;
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
  languageAwareIngest: OffOn;
  tableHeaderRepeat: TableHeaderRepeat;
  tableRowSerialization: boolean;
  captionLanguage: CaptionLanguage;
  docTranslation: OffOn;
  /** Empty means the query model (RAG_QUERY_LLM_MODEL). */
  docTranslationModel: string;
  hiddenTextCheck: IngestCheckMode;
  ingestLinkCheck: IngestCheckMode;
  /** Raw comma-separated domains; the link check parses it. */
  outputLinkAllowlist: string;
  uploadApproval: UploadApprovalMode;
  scopeTags: boolean;
  scopeTagSuggest: boolean;
  supersessionDetect: OffOn;
  effectiveDateLlmExtract: boolean;
  domainEmbeddings: DomainEmbeddingsMode;
  warnings: string[];
}

export const DEFAULT_PARSE_POLL_BUDGET_MS = 45000;
const MIN_POLL_BUDGET_MS = 1000;
const MAX_POLL_BUDGET_MS = 55000;

const ENV_NAMES = [
  'RAG_INGEST_PIPELINE',
  'RAG_PARSER',
  'RAG_PARSE_POLL_BUDGET_MS',
  'RAG_DOC_TYPE_LLM_DETECT',
  'RAG_INVOICE_LLM_EXTRACT',
  'RAG_EXACT_ID_LOOKUP',
  'RAG_PDF_IMAGE_CHUNKS',
  'RAG_INJECTION_SCAN',
  'RAG_EMBEDDING_PROFILES',
  'RAG_QWEN_EMBED_FALLBACK',
  'RAG_LANGUAGE_AWARE_INGEST',
  'RAG_TABLE_HEADER_REPEAT',
  'RAG_TABLE_ROW_SERIALIZATION',
  'RAG_CAPTION_LANGUAGE',
  'RAG_DOC_TRANSLATION',
  'RAG_DOC_TRANSLATION_MODEL',
  'RAG_HIDDEN_TEXT_CHECK',
  'RAG_INGEST_LINK_CHECK',
  'RAG_OUTPUT_LINK_ALLOWLIST',
  'RAG_UPLOAD_APPROVAL',
  'RAG_SCOPE_TAGS',
  'RAG_SCOPE_TAG_SUGGEST',
  'RAG_SUPERSESSION_DETECT',
  'RAG_EFFECTIVE_DATE_LLM_EXTRACT',
  'RAG_DOMAIN_EMBEDDINGS',
] as const satisfies readonly (keyof IngestEnvInput)[];

const loggedProblems = new Set<string>();
const memo = new Map<string, IngestConfig>();

function problem(warnings: string[], key: string, message: string, data: Record<string, unknown>): void {
  warnings.push(`${message} (${Object.values(data).join(', ')})`);
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`[Ingest Config] ${message}`, data);
}

function parseChoice<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  warnings: string[],
): T {
  const value = (raw ?? '').trim();
  if (value === '') return fallback;
  const normalised = value.toLowerCase();
  const match = allowed.find((candidate) => candidate === normalised);
  if (match !== undefined) return match;
  problem(warnings, `${name}:${value}`, `Unsupported ${name} value, using ${fallback}`, { value });
  return fallback;
}

function parseFlag(name: string, raw: string | undefined, warnings: string[]): boolean {
  const value = (raw ?? '').trim();
  if (value === '') return false;
  const normalised = value.toLowerCase();
  if (normalised === 'true') return true;
  if (normalised === 'false') return false;
  problem(warnings, `${name}:${value}`, `Unsupported ${name} value, expected true or false, using false`, { value });
  return false;
}

function parsePollBudget(raw: string | undefined, warnings: string[]): number {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_PARSE_POLL_BUDGET_MS;
  const ms = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(ms) || ms < MIN_POLL_BUDGET_MS || ms > MAX_POLL_BUDGET_MS) {
    problem(
      warnings,
      `RAG_PARSE_POLL_BUDGET_MS:${value}`,
      `Invalid RAG_PARSE_POLL_BUDGET_MS, expected an integer from ${MIN_POLL_BUDGET_MS} to ${MAX_POLL_BUDGET_MS}, using ${DEFAULT_PARSE_POLL_BUDGET_MS}`,
      { value },
    );
    return DEFAULT_PARSE_POLL_BUDGET_MS;
  }
  return ms;
}

/** Domain bindings need the embedding profile registry, so RAG_EMBEDDING_PROFILES=off keeps them off. */
function parseDomainEmbeddings(raw: string | undefined, profiles: EmbeddingProfilesMode, warnings: string[]): DomainEmbeddingsMode {
  const requested = parseChoice('RAG_DOMAIN_EMBEDDINGS', raw, ['off', 'on'], 'off', warnings);
  if (requested === 'on' && profiles === 'off') {
    problem(warnings, 'domain-embeddings-profiles-off', 'domain-embeddings needs embedding profiles; RAG_DOMAIN_EMBEDDINGS stays off', {
      RAG_EMBEDDING_PROFILES: 'off',
    });
    return 'off';
  }
  return requested;
}

/** Pure function of an env snapshot; any invalid or unknown value resolves to today's behaviour. */
export function loadIngestConfig(env: IngestEnvInput): IngestConfig {
  const snapshot = JSON.stringify(ENV_NAMES.map((name) => env[name] ?? ''));
  const cached = memo.get(snapshot);
  if (cached) return cached;

  const warnings: string[] = [];
  const embeddingProfiles = parseChoice('RAG_EMBEDDING_PROFILES', env.RAG_EMBEDDING_PROFILES, ['off', 'on'], 'off', warnings);
  const config: IngestConfig = {
    pipeline: parseChoice('RAG_INGEST_PIPELINE', env.RAG_INGEST_PIPELINE, ['legacy', 'unified'], 'legacy', warnings),
    parser: parseChoice('RAG_PARSER', env.RAG_PARSER, ['llamaparse', 'docling'], 'llamaparse', warnings),
    parsePollBudgetMs: parsePollBudget(env.RAG_PARSE_POLL_BUDGET_MS, warnings),
    docTypeLlmDetect: parseFlag('RAG_DOC_TYPE_LLM_DETECT', env.RAG_DOC_TYPE_LLM_DETECT, warnings),
    invoiceLlmExtract: parseFlag('RAG_INVOICE_LLM_EXTRACT', env.RAG_INVOICE_LLM_EXTRACT, warnings),
    exactIdLookup: parseFlag('RAG_EXACT_ID_LOOKUP', env.RAG_EXACT_ID_LOOKUP, warnings),
    pdfImageChunks: parseFlag('RAG_PDF_IMAGE_CHUNKS', env.RAG_PDF_IMAGE_CHUNKS, warnings),
    injectionScan: parseChoice('RAG_INJECTION_SCAN', env.RAG_INJECTION_SCAN, ['off', 'quarantine'], 'off', warnings),
    embeddingProfiles,
    qwenFallback: parseChoice('RAG_QWEN_EMBED_FALLBACK', env.RAG_QWEN_EMBED_FALLBACK, ['openrouter', 'none'], 'openrouter', warnings),
    languageAwareIngest: parseChoice('RAG_LANGUAGE_AWARE_INGEST', env.RAG_LANGUAGE_AWARE_INGEST, ['off', 'on'], 'off', warnings),
    tableHeaderRepeat: parseChoice('RAG_TABLE_HEADER_REPEAT', env.RAG_TABLE_HEADER_REPEAT, ['profile', 'always'], 'profile', warnings),
    tableRowSerialization: parseFlag('RAG_TABLE_ROW_SERIALIZATION', env.RAG_TABLE_ROW_SERIALIZATION, warnings),
    captionLanguage: parseChoice('RAG_CAPTION_LANGUAGE', env.RAG_CAPTION_LANGUAGE, ['en', 'document'], 'en', warnings),
    docTranslation: parseChoice('RAG_DOC_TRANSLATION', env.RAG_DOC_TRANSLATION, ['off', 'on'], 'off', warnings),
    docTranslationModel: (env.RAG_DOC_TRANSLATION_MODEL ?? '').trim(),
    hiddenTextCheck: parseChoice('RAG_HIDDEN_TEXT_CHECK', env.RAG_HIDDEN_TEXT_CHECK, ['off', 'flag', 'quarantine'], 'off', warnings),
    ingestLinkCheck: parseChoice('RAG_INGEST_LINK_CHECK', env.RAG_INGEST_LINK_CHECK, ['off', 'flag', 'quarantine'], 'off', warnings),
    outputLinkAllowlist: (env.RAG_OUTPUT_LINK_ALLOWLIST ?? '').trim(),
    uploadApproval: parseChoice('RAG_UPLOAD_APPROVAL', env.RAG_UPLOAD_APPROVAL, ['off', 'members', 'all'], 'off', warnings),
    scopeTags: parseFlag('RAG_SCOPE_TAGS', env.RAG_SCOPE_TAGS, warnings),
    scopeTagSuggest: parseFlag('RAG_SCOPE_TAG_SUGGEST', env.RAG_SCOPE_TAG_SUGGEST, warnings),
    supersessionDetect: parseChoice('RAG_SUPERSESSION_DETECT', env.RAG_SUPERSESSION_DETECT, ['off', 'on'], 'off', warnings),
    effectiveDateLlmExtract: parseFlag('RAG_EFFECTIVE_DATE_LLM_EXTRACT', env.RAG_EFFECTIVE_DATE_LLM_EXTRACT, warnings),
    domainEmbeddings: parseDomainEmbeddings(env.RAG_DOMAIN_EMBEDDINGS, embeddingProfiles, warnings),
    warnings,
  };
  memo.set(snapshot, config);
  return config;
}

export function resetIngestConfigForTests(): void {
  loggedProblems.clear();
  memo.clear();
}
