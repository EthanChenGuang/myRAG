import { getRagDeps } from '../deps';
import type { EmbeddingProfile } from './active-profile';

export interface QueryEmbedding {
  vector: number[];
  /** Null while RAG_EMBEDDING_PROFILES is off: the legacy embedder and the legacy RPCs are used. */
  profile: EmbeddingProfile | null;
}

export async function embedQuery(text: string, signal: AbortSignal): Promise<QueryEmbedding> {
  return { vector: await getRagDeps().embedder(text, { signal }), profile: null };
}

export function profileFailureReason(_error: unknown): 'embedding_profile_mismatch' | 'embedding_profile_unavailable' | null {
  return null;
}

export function resetProfileFailureLogForTests(): void {}
