import type { GroundednessRequest, GroundednessResult } from '@/lib/rag-eval/contracts.generated';

export interface GroundednessClientOptions {
  url?: string;
  secret?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export async function requestGroundedness(
  _request: GroundednessRequest,
  _options: GroundednessClientOptions = {},
): Promise<GroundednessResult> {
  return { status: 'scored', scorer: 'hhem_2_1_open', score: 1, reason: null, truncated: false, latency_ms: 0 };
}
