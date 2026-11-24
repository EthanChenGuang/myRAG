import { EmbeddingProfileMismatchError } from '../backend/supabase-rpc';
import { getRagDeps, type RagDeps } from '../deps';
import {
  ProfileUnavailableError,
  getActiveProfile,
  getStartupVerdict,
  isEmbeddingProfilesEnabled,
  refreshActiveProfile,
  type EmbeddingProfile,
} from './active-profile';
import { EmbeddingProfileMismatch } from './mrl';
import { canonicalModelId, getEmbeddingProvider } from './registry';

export interface QueryEmbedding {
  vector: number[];
  /** Null while RAG_EMBEDDING_PROFILES is off: the legacy embedder and the legacy RPCs are used. */
  profile: EmbeddingProfile | null;
}

export type ProfileFailureKind = 'mismatch' | 'unavailable';

const loggedCauses = new Set<string>();

function mismatchError(kind: EmbeddingProfileMismatchError['kind'], profile: EmbeddingProfile, actual: number | string | null) {
  return new EmbeddingProfileMismatchError(kind, { profile: profile.id, model: profile.model, dims: profile.dims, actual });
}

function assertDims(profile: EmbeddingProfile, length: number): void {
  if (length !== profile.dims) throw mismatchError('dims', profile, length);
}

/** The legacy embedder reports no model, so the configured provider model stands in for it; it only changes with a restart. */
function assertConfiguredModel(profile: EmbeddingProfile): void {
  let configured: string;
  try {
    configured = getEmbeddingProvider(profile.provider).model;
  } catch {
    throw mismatchError('provider', profile, profile.provider);
  }
  if (canonicalModelId(configured) !== canonicalModelId(profile.model)) throw mismatchError('model', profile, configured);
}

function fromProviderMismatch(profile: EmbeddingProfile, error: EmbeddingProfileMismatch): EmbeddingProfileMismatchError {
  if (error.kind === 'model') return mismatchError('model', profile, error.actual);
  if (error.kind === 'zero_norm') return mismatchError('vector', profile, error.actual);
  return mismatchError('dims', profile, error.actual);
}

async function embedWithProfile(
  text: string,
  signal: AbortSignal,
  profile: EmbeddingProfile,
  deps: RagDeps,
): Promise<QueryEmbedding> {
  if (profile.storage === 'legacy_column') {
    assertConfiguredModel(profile);
    const vector = await deps.embedder(text, { signal });
    assertDims(profile, vector.length);
    return { vector, profile };
  }

  let output;
  try {
    output = await deps.profileEmbedder(text, { signal, profile });
  } catch (error) {
    if (error instanceof EmbeddingProfileMismatch) throw fromProviderMismatch(profile, error);
    throw error;
  }
  assertDims(profile, output.vector.length);
  if (canonicalModelId(output.model) !== canonicalModelId(profile.model)) throw mismatchError('model', profile, output.model);
  return { vector: output.vector, profile };
}

/**
 * Embeds a retrieval query. With RAG_EMBEDDING_PROFILES off this is exactly the legacy embedder. With it on, the active profile
 * decides the model and the size, the vector length and the response model are asserted on every request, and a startup verdict of
 * mismatch fails every request without a provider call. An unreadable registry throws ProfileUnavailableError; it never falls back
 * to the legacy profile.
 */
/** Eval-only: embed with an explicit profile, bypassing the active pointer and startup mismatch gate. */
export async function embedQueryForEvalProfile(text: string, signal: AbortSignal, profile: EmbeddingProfile): Promise<QueryEmbedding> {
  return embedWithProfile(text, signal, profile, getRagDeps());
}

function assertNoStartupMismatch(): void {
  const verdict = getStartupVerdict();
  if (verdict.status === 'mismatch') {
    throw new EmbeddingProfileMismatchError('startup', {
      profile: verdict.profile,
      model: verdict.model,
      dims: verdict.dims,
      alreadyLogged: true,
    });
  }
}

export async function embedQuery(text: string, signal: AbortSignal): Promise<QueryEmbedding> {
  const deps = getRagDeps();
  if (!isEmbeddingProfilesEnabled()) return { vector: await deps.embedder(text, { signal }), profile: null };

  assertNoStartupMismatch();
  return embedWithProfile(text, signal, await getActiveProfile(), deps);
}

async function embedManyWithProfile(
  texts: string[],
  signal: AbortSignal,
  profile: EmbeddingProfile,
  deps: RagDeps,
): Promise<QueryEmbedding[]> {
  if (profile.storage !== 'legacy_column' && deps.profileBatchEmbedder) {
    const outputs = await deps.profileBatchEmbedder(texts, { signal, profile });
    if (outputs) {
      if (outputs.length !== texts.length) throw mismatchError('vector', profile, outputs.length);
      return outputs.map((output) => {
        assertDims(profile, output.vector.length);
        if (canonicalModelId(output.model) !== canonicalModelId(profile.model)) throw mismatchError('model', profile, output.model);
        return { vector: output.vector, profile };
      });
    }
  }
  return Promise.all(texts.map((text) => embedWithProfile(text, signal, profile, deps)));
}

/**
 * Embeds several queries (the original and its translated variants) for one search. One text is exactly embedQuery. Several texts use
 * the provider's batch call when the active profile's provider offers one and run in parallel under the same signal otherwise.
 */
export async function embedQueries(texts: string[], signal: AbortSignal): Promise<QueryEmbedding[]> {
  if (texts.length <= 1) return Promise.all(texts.map((text) => embedQuery(text, signal)));
  const deps = getRagDeps();
  if (!isEmbeddingProfilesEnabled()) {
    return Promise.all(texts.map(async (text) => ({ vector: await deps.embedder(text, { signal }), profile: null })));
  }

  assertNoStartupMismatch();
  return embedManyWithProfile(texts, signal, await getActiveProfile(), deps);
}

export async function embedQueriesForEvalProfile(texts: string[], signal: AbortSignal, profile: EmbeddingProfile): Promise<QueryEmbedding[]> {
  if (texts.length <= 1) return Promise.all(texts.map((text) => embedQueryForEvalProfile(text, signal, profile)));
  return embedManyWithProfile(texts, signal, profile, getRagDeps());
}

/**
 * Runs a search once and, when the database reports that the profile the query was embedded for is no longer active, refreshes the
 * pointer and runs embed and search once more with the new active profile. A second failure propagates.
 */
export async function withStaleProfileRetry<T>(
  text: string,
  embedding: QueryEmbedding,
  signal: AbortSignal,
  run: (embedding: QueryEmbedding) => Promise<T>,
): Promise<T> {
  try {
    return await run(embedding);
  } catch (error) {
    const stale = error instanceof EmbeddingProfileMismatchError && error.kind === 'not_active' && embedding.profile !== null;
    if (!stale) throw error;
    const fresh = await refreshActiveProfile();
    if (fresh.id === embedding.profile?.id) throw error;
    return run(await embedWithProfile(text, signal, fresh, getRagDeps()));
  }
}

function logOnce(cause: string, line: () => void): void {
  if (loggedCauses.has(cause)) return;
  loggedCauses.add(cause);
  line();
}

/**
 * Classifies a stage failure that comes from the embedding profile and writes the operator line once per distinct cause. Returns null
 * for every other error.
 */
export function classifyProfileFailure(error: unknown): ProfileFailureKind | null {
  if (error instanceof EmbeddingProfileMismatchError) {
    if (!error.alreadyLogged) {
      logOnce(`mismatch|${error.kind}|${error.profile}|${error.dims}`, () =>
        console.error(
          `[Embedding Profile] MISMATCH ${JSON.stringify({ profile: error.profile, model: error.model, dims: error.dims, reason: error.kind, actual: error.actual })}`,
        ),
      );
    }
    return 'mismatch';
  }
  if (error instanceof ProfileUnavailableError) {
    logOnce(`unavailable|${error.reason}`, () =>
      console.error(`[Embedding Profile] REGISTRY UNAVAILABLE ${JSON.stringify({ reason: error.reason })}`),
    );
    return 'unavailable';
  }
  return null;
}

export function resetProfileFailureLogForTests(): void {
  loggedCauses.clear();
}
