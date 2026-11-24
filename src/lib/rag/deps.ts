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
  ragEnv: () => ({
    RAG_PIPELINE: env.RAG_PIPELINE,
    RAG_DISABLED_STAGES: env.RAG_DISABLED_STAGES,
    RAG_STAGE_TIMEOUTS: env.RAG_STAGE_TIMEOUTS,
  }),
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
