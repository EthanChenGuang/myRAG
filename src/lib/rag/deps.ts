import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase';
import type { RagEnvInput } from './config';
import type { EmbeddingProfile } from './embeddings/active-profile';
import { EmbeddingProfileMismatch } from './embeddings/mrl';
import { embedText } from './embeddings/openai';
import { getEmbeddingProvider } from './embeddings/registry';

export interface ProfileQueryEmbedding {
  vector: number[];
  /** The model the provider reports having used, compared with the profile's model on every request. */
  model: string;
}

export interface RagDeps {
  adminClient: () => SupabaseClient | null;
  embedder: (text: string, opts: { signal: AbortSignal }) => Promise<number[]>;
  /** Used for a non-legacy active profile only: the profile's provider embeds the query at the profile's dims. */
  profileEmbedder: (text: string, opts: { signal: AbortSignal; profile: EmbeddingProfile }) => Promise<ProfileQueryEmbedding>;
  now: () => number;
  randomId: () => string;
  ragEnv: () => RagEnvInput;
  fetch: typeof fetch;
}

function readRagEnvInput(): RagEnvInput {
  return {
    RAG_PIPELINE: process.env.RAG_PIPELINE ?? env.RAG_PIPELINE,
    RAG_DISABLED_STAGES: process.env.RAG_DISABLED_STAGES ?? env.RAG_DISABLED_STAGES,
    RAG_STAGE_TIMEOUTS: process.env.RAG_STAGE_TIMEOUTS ?? env.RAG_STAGE_TIMEOUTS,
    RAG_EXACT_ID_LOOKUP: process.env.RAG_EXACT_ID_LOOKUP ?? env.RAG_EXACT_ID_LOOKUP,
    RAG_LEXICAL_SEARCH: process.env.RAG_LEXICAL_SEARCH ?? env.RAG_LEXICAL_SEARCH,
    RAG_RERANKER: process.env.RAG_RERANKER ?? env.RAG_RERANKER,
    RAG_RERANK_TIER_CHAT: process.env.RAG_RERANK_TIER_CHAT ?? env.RAG_RERANK_TIER_CHAT,
    RAG_RERANK_TIER_VOICE: process.env.RAG_RERANK_TIER_VOICE ?? env.RAG_RERANK_TIER_VOICE,
    RAG_RERANK_VOYAGE_MODEL_BY_LANG: process.env.RAG_RERANK_VOYAGE_MODEL_BY_LANG ?? env.RAG_RERANK_VOYAGE_MODEL_BY_LANG,
    COHERE_API_KEY: process.env.COHERE_API_KEY ?? env.COHERE_API_KEY,
    COHERE_BASE_URL: process.env.COHERE_BASE_URL ?? env.COHERE_BASE_URL,
    RAG_REFUSAL_THRESHOLD: process.env.RAG_REFUSAL_THRESHOLD ?? env.RAG_REFUSAL_THRESHOLD,
    RAG_CONTEXT_EDGE_ORDER: process.env.RAG_CONTEXT_EDGE_ORDER ?? env.RAG_CONTEXT_EDGE_ORDER,
    RAG_CONTEXT_COMPRESSION: process.env.RAG_CONTEXT_COMPRESSION ?? env.RAG_CONTEXT_COMPRESSION,
    RAG_CONTEXT_TOKEN_BUDGET: process.env.RAG_CONTEXT_TOKEN_BUDGET ?? env.RAG_CONTEXT_TOKEN_BUDGET,
    RAG_PARENT_CHILD: process.env.RAG_PARENT_CHILD ?? env.RAG_PARENT_CHILD,
    RAG_HNSW_ITERATIVE_SCAN: process.env.RAG_HNSW_ITERATIVE_SCAN ?? env.RAG_HNSW_ITERATIVE_SCAN,
    RAG_EXACT_SCAN_CUTOFF: process.env.RAG_EXACT_SCAN_CUTOFF ?? env.RAG_EXACT_SCAN_CUTOFF,
    RAG_LEXICAL_TRANSLATION: process.env.RAG_LEXICAL_TRANSLATION ?? env.RAG_LEXICAL_TRANSLATION,
    RAG_RETRIEVAL_PARAMS_OVERRIDE: process.env.RAG_RETRIEVAL_PARAMS_OVERRIDE ?? env.RAG_RETRIEVAL_PARAMS_OVERRIDE,
    VOYAGE_API_KEY: process.env.VOYAGE_API_KEY ?? env.VOYAGE_API_KEY,
    VOYAGE_BASE_URL: process.env.VOYAGE_BASE_URL ?? env.VOYAGE_BASE_URL,
  };
}

const defaults: RagDeps = {
  adminClient: () => getSupabaseAdmin() as SupabaseClient | null,
  embedder: embedText,
  profileEmbedder: async (text, { signal, profile }) => {
    const output = await getEmbeddingProvider(profile.provider).embedQuery(text, { dims: profile.dims, signal });
    const vector = output.vectors[0];
    if (!vector) throw new EmbeddingProfileMismatch('dims', 0, profile.dims);
    return { vector, model: output.model };
  },
  now: () => Date.now(),
  randomId: () => randomUUID(),
  ragEnv: () => readRagEnvInput(),
  fetch: globalThis.fetch.bind(globalThis),
};

let overrides: Partial<RagDeps> = {};

export function getRagDeps(): RagDeps {
  return { ...defaults, ...overrides };
}

export function setRagDepsForTests(partial: Partial<RagDeps>): void {
  overrides = { ...overrides, ...partial };
}

export function resetRagDepsForTests(): void {
  overrides = {};
}