import { ChunkingProfileSchema } from '@/lib/rag-eval/contracts.generated';
import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import { getActiveProfile } from '../embeddings/active-profile';
import { maxInputTokensFor } from '../embeddings/registry';
import { effectiveRetrievalParams } from '../v2/retrieval-params';

export type ChunkingFinding =
  | 'child_exceeds_embedding_input'
  | 'parent_below_twice_child'
  | 'parent_tokens_required'
  | 'ratio_outside_4_8'
  | 'top_k_parent_over_budget'
  | 'invalid_shape';

export interface ChunkingValidationContext {
  /** The largest child the embedding model accepts; defaults to the input limit of the active embedding profile's provider. */
  maxChildTokens?: number;
  /** Parents the context may carry; defaults to the committed final_top_k. */
  topK?: number;
  /** Token budget of the assembled context; defaults to RAG_CONTEXT_TOKEN_BUDGET. */
  contextBudget?: number;
}

export interface ChunkingValidationResult {
  errors: ChunkingFinding[];
  warnings: ChunkingFinding[];
}

async function resolveContext(context: ChunkingValidationContext): Promise<Required<ChunkingValidationContext>> {
  let { maxChildTokens, topK, contextBudget } = context;
  if (maxChildTokens === undefined) maxChildTokens = maxInputTokensFor((await getActiveProfile()).provider);
  if (topK === undefined || contextBudget === undefined) {
    const config = loadRagConfig(getRagDeps().ragEnv());
    topK ??= effectiveRetrievalParams('chat', config, null).final_top_k;
    contextBudget ??= config.v2.tokenBudget;
  }
  return { maxChildTokens, topK, contextBudget };
}

/**
 * The TypeScript copy of chunking_profile_findings in rag-sidecar contracts/retrieval.py: the same hard errors and warnings for the same
 * input, proven row by row against rag-sidecar/schemas/chunking-profile-cases.json. A profile that does not match the generated schema
 * reports `invalid_shape` (Pydantic raises a validation error for it instead).
 */
async function findings(input: unknown, context: ChunkingValidationContext): Promise<ChunkingValidationResult> {
  const parsed = ChunkingProfileSchema.safeParse(input);
  if (!parsed.success) return { errors: ['invalid_shape'], warnings: [] };
  const { maxChildTokens, topK, contextBudget } = await resolveContext(context);

  const profile = parsed.data;
  const child = profile.child_tokens;
  const parent = profile.parent_tokens;
  const errors: ChunkingFinding[] = [];
  const warnings: ChunkingFinding[] = [];

  if (profile.parent_mode === 'fixed' && parent === null) errors.push('parent_tokens_required');
  if (child > maxChildTokens) errors.push('child_exceeds_embedding_input');
  const parentTooSmall = parent !== null && parent < child * 2;
  if (parentTooSmall) errors.push('parent_below_twice_child');
  if (parent !== null && child > 0 && !parentTooSmall) {
    const ratio = parent / child;
    if (ratio < 4 || ratio > 8) warnings.push('ratio_outside_4_8');
  }
  if (parent !== null && topK * parent > contextBudget) warnings.push('top_k_parent_over_budget');
  return { errors, warnings };
}

export function validateChunkingProfile(input: unknown, context: ChunkingValidationContext = {}): Promise<ChunkingValidationResult> {
  return findings(input, context);
}
