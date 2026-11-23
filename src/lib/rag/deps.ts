import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import { getSupabase, getSupabaseAdmin } from '@/lib/supabase';
import type { RagEnvInput } from './config';
import { embedText } from './embeddings/openai';
import type { RpcClient } from './backend/supabase-rpc';

export interface RagDeps {
  anonClient: () => RpcClient;
  adminClient: () => SupabaseClient | null;
  embedder: (text: string, opts: { signal: AbortSignal }) => Promise<number[]>;
  now: () => number;
  randomId: () => string;
  ragEnv: () => RagEnvInput;
}

const defaults: RagDeps = {
  anonClient: () => getSupabase() as unknown as RpcClient,
  adminClient: () => getSupabaseAdmin() as SupabaseClient | null,
  embedder: embedText,
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
