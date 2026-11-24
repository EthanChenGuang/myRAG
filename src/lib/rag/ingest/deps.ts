import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase';
import { embedBatch } from '../embeddings/openai';
import type { RpcClient } from '../backend/supabase-rpc';
import type { IngestEnvInput } from './config';

export interface IngestDeps {
  /** The admin client: the writer RPCs are executable by service_role only. */
  db: () => RpcClient | null;
  embedDocuments: (texts: string[], opts: { signal: AbortSignal }) => Promise<number[][]>;
  now: () => number;
  randomId: () => string;
  ingestEnv: () => IngestEnvInput;
}

const defaults: IngestDeps = {
  db: () => getSupabaseAdmin() as unknown as RpcClient | null,
  embedDocuments: (texts, opts) => embedBatch(texts, opts),
  now: () => Date.now(),
  randomId: () => randomUUID(),
  ingestEnv: () => ({
    RAG_INGEST_PIPELINE: env.RAG_INGEST_PIPELINE,
    RAG_PARSER: env.RAG_PARSER,
    RAG_PARSE_POLL_BUDGET_MS: env.RAG_PARSE_POLL_BUDGET_MS,
    RAG_DOC_TYPE_LLM_DETECT: env.RAG_DOC_TYPE_LLM_DETECT,
    RAG_INVOICE_LLM_EXTRACT: env.RAG_INVOICE_LLM_EXTRACT,
    RAG_EXACT_ID_LOOKUP: env.RAG_EXACT_ID_LOOKUP,
    RAG_PDF_IMAGE_CHUNKS: env.RAG_PDF_IMAGE_CHUNKS,
    RAG_INJECTION_SCAN: env.RAG_INJECTION_SCAN,
    RAG_EMBEDDING_PROFILES: env.RAG_EMBEDDING_PROFILES,
    RAG_QWEN_EMBED_FALLBACK: env.RAG_QWEN_EMBED_FALLBACK,
  }),
};

let overrides: Partial<IngestDeps> = {};

export function getIngestDeps(): IngestDeps {
  return { ...defaults, ...overrides };
}

export function setIngestDepsForTests(partial: Partial<IngestDeps>): void {
  overrides = { ...overrides, ...partial };
}

export function resetIngestDepsForTests(): void {
  overrides = {};
}
