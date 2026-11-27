export interface LangidAnswer {
  language: string;
  confidence: number;
}

export interface LangidClientOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  url?: string;
  secret?: string;
  fetch?: typeof fetch;
}

/** Stub for the RED commit. */
export function langidConfigured(_options: Pick<LangidClientOptions, 'url' | 'secret'> = {}): boolean {
  return false;
}

/** Stub for the RED commit. */
export async function requestLanguageId(_text: string, _candidates: readonly string[], _options: LangidClientOptions): Promise<LangidAnswer | null> {
  return null;
}
