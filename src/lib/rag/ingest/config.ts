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

/** Pure function of an env snapshot; any invalid or unknown value resolves to today's behaviour. */
export function loadIngestConfig(env: IngestEnvInput): IngestConfig {
  const snapshot = JSON.stringify(ENV_NAMES.map((name) => env[name] ?? ''));
  const cached = memo.get(snapshot);
  if (cached) return cached;

  const warnings: string[] = [];
  const config: IngestConfig = {
    pipeline: parseChoice('RAG_INGEST_PIPELINE', env.RAG_INGEST_PIPELINE, ['legacy', 'unified'], 'legacy', warnings),
    parser: parseChoice('RAG_PARSER', env.RAG_PARSER, ['llamaparse', 'docling'], 'llamaparse', warnings),
    parsePollBudgetMs: parsePollBudget(env.RAG_PARSE_POLL_BUDGET_MS, warnings),
    docTypeLlmDetect: parseFlag('RAG_DOC_TYPE_LLM_DETECT', env.RAG_DOC_TYPE_LLM_DETECT, warnings),
    invoiceLlmExtract: parseFlag('RAG_INVOICE_LLM_EXTRACT', env.RAG_INVOICE_LLM_EXTRACT, warnings),
    exactIdLookup: parseFlag('RAG_EXACT_ID_LOOKUP', env.RAG_EXACT_ID_LOOKUP, warnings),
    pdfImageChunks: parseFlag('RAG_PDF_IMAGE_CHUNKS', env.RAG_PDF_IMAGE_CHUNKS, warnings),
    injectionScan: parseChoice('RAG_INJECTION_SCAN', env.RAG_INJECTION_SCAN, ['off', 'quarantine'], 'off', warnings),
    embeddingProfiles: parseChoice('RAG_EMBEDDING_PROFILES', env.RAG_EMBEDDING_PROFILES, ['off', 'on'], 'off', warnings),
    qwenFallback: parseChoice('RAG_QWEN_EMBED_FALLBACK', env.RAG_QWEN_EMBED_FALLBACK, ['openrouter', 'none'], 'openrouter', warnings),
    warnings,
  };
  memo.set(snapshot, config);
  return config;
}

export function resetIngestConfigForTests(): void {
  loggedProblems.clear();
  memo.clear();
}
