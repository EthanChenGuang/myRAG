import type { InjectionClassifyResponse } from '@/lib/rag-eval/contracts.generated';

export interface PromptGuardItem {
  id: string;
  text: string;
}

export type PromptGuardResult = InjectionClassifyResponse['results'][number];

export type PromptGuardFailure =
  | 'not_configured'
  | 'timeout'
  | 'aborted'
  | 'malformed'
  | 'unreachable'
  | 'invalid_request'
  | `http_${number}`;

export type PromptGuardOutcome =
  | { ok: true; modelId: string | null; revision: string | null; results: PromptGuardResult[] }
  | { ok: false; reason: PromptGuardFailure };

export interface PromptGuardClientConfig {
  url: string;
  secret: string;
}

export interface PromptGuardOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  config?: PromptGuardClientConfig;
  fetch?: typeof fetch;
}

export async function classifyWithPromptGuard(
  _items: PromptGuardItem[],
  _options: PromptGuardOptions,
): Promise<PromptGuardOutcome> {
  return { ok: false, reason: 'malformed' };
}
