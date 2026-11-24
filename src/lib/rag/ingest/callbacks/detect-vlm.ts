import type { DetectVlmRequest, DetectVlmResponse } from '@/lib/rag-eval/contracts.generated';
import { refuse, type CallbackResult } from './common';

export interface VlmDetectInput {
  png: Uint8Array;
  model: string;
  signal: AbortSignal;
}

export type VlmDetectFn = (_input: VlmDetectInput) => Promise<unknown>;

export function setVlmDetectorForTests(_fn: VlmDetectFn): void {}

export function resetVlmDetectorForTests(): void {}

export async function handleDetectVlm(
  _jobId: string,
  _body: DetectVlmRequest,
  _options: { signal: AbortSignal },
): Promise<CallbackResult<DetectVlmResponse>> {
  return refuse(500, 'not_implemented');
}
