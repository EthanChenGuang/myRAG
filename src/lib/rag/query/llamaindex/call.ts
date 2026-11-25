import type { ZodType, ZodTypeDef } from 'zod/v3';
import type { RagDeps } from '../../deps';
import { QueryLlmError, type QueryLlmTransform } from '../llm';

export type NativeTransform = Extract<QueryLlmTransform, 'expand' | 'hyde' | 'decompose'>;
export type NativeVariantKind = 'expanded' | 'hyde' | 'sub_question';
export type NativeLegs = 'both' | 'dense';
export type NativeDeps = Pick<RagDeps, 'queryLlm'>;

/** A transform failure names the transform and the reason only; never query or model text. */
export type NativeTransformSkip = { transform: NativeTransform; reason: 'error' };

export type NativeCall<T> = { ok: true; value: T } | { ok: false; skip: NativeTransformSkip };

/**
 * One structured query-LLM call. An abort propagates so the stage runner records the timeout;
 * an unavailable client, a provider error or an output that fails the schema is a skip with reason error.
 */
export async function callNative<T>(
  deps: NativeDeps,
  request: {
    transform: NativeTransform;
    schema: ZodType<T, ZodTypeDef, unknown>;
    system: string;
    prompt: string;
    input: string;
    signal: AbortSignal;
  },
): Promise<NativeCall<T>> {
  try {
    return { ok: true, value: await deps.queryLlm().generate(request) };
  } catch (error) {
    if (request.signal.aborted || (error instanceof QueryLlmError && error.kind === 'aborted')) throw error;
    return { ok: false, skip: { transform: request.transform, reason: 'error' } };
  }
}
