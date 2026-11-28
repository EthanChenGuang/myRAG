import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { ChunkingActivationRefused, ChunkingInputError, RetrievalBackendError } from '@/lib/rag';
import type { ChunkingFinding } from '@/lib/rag';
import { ChunkingProfileSchema } from '@/lib/rag-eval/contracts.generated';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Chunking profile ids as the registry stores them: a lower-case slug. */
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const DocTypeSchema = ChunkingProfileSchema.shape.doc_type;

/** A new profile: the generated ChunkingProfile shape, created as building. The id `legacy` is reserved. */
export const CreateChunkingProfileBodySchema = ChunkingProfileSchema.omit({ status: true }).extend({
  id: z
    .string()
    .regex(PROFILE_ID_PATTERN)
    .refine((id) => id !== 'legacy', { message: 'legacy is reserved' }),
  status: z.literal('building').optional(),
});

export type ChunkingAdminAction = 'list' | 'create' | 'validate' | 'report' | 'build' | 'activate' | 'rollback';

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export function invalidRequest(details: Array<{ path: string; message: string }>): NextResponse {
  return jsonNoStore({ success: false, error: 'Invalid request data', details }, 400);
}

export function zodDetails(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** Reads an optional JSON body: empty is `{}`, anything else must parse. */
export async function optionalJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  const raw = await request.text();
  if (raw.trim() === '') return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: invalidRequest([{ path: '', message: 'Body is not valid JSON' }]) };
  }
}

const FINDING_PATH: Record<ChunkingFinding, string> = {
  child_exceeds_embedding_input: 'child_tokens',
  parent_below_twice_child: 'parent_tokens',
  parent_tokens_required: 'parent_tokens',
  ratio_outside_4_8: 'parent_tokens',
  top_k_parent_over_budget: 'parent_tokens',
  invalid_shape: '',
};

export function invalidProfile(errors: ChunkingFinding[], warnings: ChunkingFinding[]): NextResponse {
  return jsonNoStore(
    {
      success: false,
      error: 'invalid_chunking_profile',
      details: errors.map((code) => ({ path: FINDING_PATH[code], message: code })),
      warnings,
    },
    400,
  );
}

function reasonOf(error: unknown): string {
  if (error instanceof RetrievalBackendError) return error.code ?? 'backend_error';
  if (error instanceof ChunkingActivationRefused) return error.reason;
  if (error instanceof ChunkingInputError) return 'invalid_input';
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : 'unexpected';
}

/** Anything not mapped to a named refusal: only the reason code is logged and nothing of the database message is answered. */
export function chunkingUnavailable(action: ChunkingAdminAction, profileId: string | null, error: unknown): NextResponse {
  console.error('[RAG Admin] chunking profile action failed', { action, profileId, reason: reasonOf(error) });
  return jsonNoStore({ success: false, error: 'chunking_admin_unavailable' }, 503);
}

/** A named refusal of the activation or rollback gate: 404 for an unknown profile, 409 with the gate's reason for the rest. */
export function refusalResponse(action: 'activate' | 'rollback', profileId: string | null, refusal: ChunkingActivationRefused): NextResponse {
  console.warn('[RAG Admin] chunking profile action refused', { action, profileId, reason: refusal.reason });
  if (refusal.reason === 'unknown_profile') return jsonNoStore({ success: false, error: 'profile_not_found' }, 404);
  return jsonNoStore({ success: false, error: action === 'activate' ? 'activation_refused' : 'rollback_refused', reason: refusal.reason }, 409);
}
