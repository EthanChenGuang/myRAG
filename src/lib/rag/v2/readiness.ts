import { RetrievalBackendError } from '../backend/supabase-rpc';
import { loadRagConfig, type RagEnvInput } from '../config';
import { getRagDeps } from '../deps';
import { IngestWriterError } from '../ingest/writer';
import type { PipelineSource } from '../lang/resolve';

export type PipelineFallback = 'none' | 'v2_unavailable' | 'languages_not_configured';

export interface EffectivePipeline {
  /** The pipeline that serves the request. */
  pipeline: 'legacy' | 'v2';
  source: PipelineSource;
  fallback: PipelineFallback;
}

/** The Phase 4 functions whose absence makes a defaulted v2 serve legacy (D-07). */
const PHASE4_FUNCTIONS: ReadonlySet<string> = new Set(['hybrid_search_chunks', 'rag_list_chunking_profiles']);
/** PostgREST "function not found in the schema cache" and Postgres undefined_function. */
const MISSING_FUNCTION_CODES: ReadonlySet<string> = new Set(['PGRST202', '42883']);

let v2Available = true;

interface BackendErrorShape {
  rpc: string;
  code: string | null;
}

function backendErrorShape(error: unknown): BackendErrorShape | null {
  if (error instanceof RetrievalBackendError) return { rpc: error.rpc, code: error.code };
  if (error instanceof IngestWriterError) return { rpc: error.rpc, code: error.code };
  return null;
}

/** True only for a backend error of hybrid_search_chunks or rag_list_chunking_profiles with code PGRST202 or 42883. */
export function isMissingPhase4Function(error: unknown): boolean {
  const shape = backendErrorShape(error);
  return shape !== null && PHASE4_FUNCTIONS.has(shape.rpc) && shape.code !== null && MISSING_FUNCTION_CODES.has(shape.code);
}

export function isV2Available(): boolean {
  return v2Available;
}

/** Per process: a defaulted v2 serves legacy from now on. Logs once; the log names the function, never an error body. */
export function markV2Unavailable(rpc: string): void {
  if (!v2Available) return;
  v2Available = false;
  console.error(
    '[RAG Config] a Phase 4 database function is missing; running the legacy pipeline until the Phase 4 migrations under supabase/migrations are applied, or set RAG_PIPELINE=legacy',
    { function: rpc },
  );
}

/**
 * D-07, D-24: the one place that decides which pipeline serves a request. An explicit RAG_PIPELINE is returned unchanged. A defaulted
 * v2 serves legacy when the languages are not configured (checked first) or when v2 was marked unavailable. Logs nothing.
 */
export function resolveEffectivePipeline(env: RagEnvInput = getRagDeps().ragEnv()): EffectivePipeline {
  const config = loadRagConfig(env);
  const source = config.pipelineSource;
  if (source === 'explicit') return { pipeline: config.pipeline, source, fallback: 'none' };
  if (config.pipelineServedLegacy) return { pipeline: 'legacy', source, fallback: 'languages_not_configured' };
  if (config.pipeline !== 'v2') return { pipeline: config.pipeline, source, fallback: 'none' };
  if (getRagDeps().languagesConfigured() === false) return { pipeline: 'legacy', source, fallback: 'languages_not_configured' };
  if (!v2Available) return { pipeline: 'legacy', source, fallback: 'v2_unavailable' };
  return { pipeline: 'v2', source, fallback: 'none' };
}

export function resetV2ReadinessForTests(): void {
  v2Available = true;
}
