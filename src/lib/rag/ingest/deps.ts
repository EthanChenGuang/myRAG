import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase';
import { embedBatch } from '../embeddings/openai';
import type { RpcClient } from '../backend/supabase-rpc';
import type { IngestEnvInput } from './config';
import type { RehydrateResult, StageContext } from './types';

export interface IngestDeps {
  /** The admin client: the writer RPCs are executable by service_role only. */
  db: () => RpcClient | null;
  embedDocuments: (texts: string[], opts: { signal: AbortSignal }) => Promise<number[][]>;
  now: () => number;
  randomId: () => string;
  ingestEnv: () => IngestEnvInput;
  /**
   * Rebuilds the in-memory work of a resumed run for the stages after lastCompleted. Unset, resume uses
   * rehydrateFromStore (the stored original and parse output); tests install a stand-in.
   */
  rehydrate?: (ctx: StageContext) => Promise<RehydrateResult>;
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
    RAG_LANGUAGE_AWARE_INGEST: env.RAG_LANGUAGE_AWARE_INGEST,
    RAG_TABLE_HEADER_REPEAT: env.RAG_TABLE_HEADER_REPEAT,
    RAG_TABLE_ROW_SERIALIZATION: env.RAG_TABLE_ROW_SERIALIZATION,
    RAG_CAPTION_LANGUAGE: env.RAG_CAPTION_LANGUAGE,
    RAG_DOC_TRANSLATION: env.RAG_DOC_TRANSLATION,
    RAG_DOC_TRANSLATION_MODEL: env.RAG_DOC_TRANSLATION_MODEL,
    RAG_HIDDEN_TEXT_CHECK: env.RAG_HIDDEN_TEXT_CHECK,
    RAG_INGEST_LINK_CHECK: env.RAG_INGEST_LINK_CHECK,
    RAG_OUTPUT_LINK_ALLOWLIST: env.RAG_OUTPUT_LINK_ALLOWLIST,
    RAG_UPLOAD_APPROVAL: env.RAG_UPLOAD_APPROVAL,
    RAG_SCOPE_TAGS: env.RAG_SCOPE_TAGS,
    RAG_SCOPE_TAG_SUGGEST: env.RAG_SCOPE_TAG_SUGGEST,
    RAG_SUPERSESSION_DETECT: env.RAG_SUPERSESSION_DETECT,
    RAG_EFFECTIVE_DATE_LLM_EXTRACT: env.RAG_EFFECTIVE_DATE_LLM_EXTRACT,
    RAG_DOMAIN_EMBEDDINGS: env.RAG_DOMAIN_EMBEDDINGS,
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
