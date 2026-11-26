export type TranslationRefusal =
  | 'switch_off'
  | 'monolingual'
  | 'languages_not_configured'
  | 'tenant_disabled'
  | 'no_targets'
  | 'invalid_argument'
  | 'unavailable';

export type TranslationStop = 'time_budget' | 'usd_budget' | 'model_unavailable' | 'aborted' | 'write_failed';

export interface TranslationLanguageCounts {
  translated: number;
  gaps: number;
  remaining: number;
}

export interface TranslationRunSummary {
  ok: true;
  translated: number;
  gaps: number;
  reembedded: number;
  remaining: number;
  stopped: TranslationStop | null;
  byLanguage: Record<string, TranslationLanguageCounts>;
  estimatedUsd: number;
}

export type TranslationRunResult = TranslationRunSummary | { ok: false; reason: TranslationRefusal };

export interface TranslationRunOptions {
  budgetMs?: number;
  budgetUsd?: number | null;
  languages?: readonly string[];
  signal?: AbortSignal;
  maxInputTokens?: number;
  pageSize?: number;
  reembedOnly?: boolean;
}

export async function translateDocumentChunks(_documentId: string, _tenantKey: string, _options: TranslationRunOptions = {}): Promise<TranslationRunResult> {
  return { ok: false, reason: 'unavailable' };
}

export async function translatePending(_tenantKey: string, _options: TranslationRunOptions = {}): Promise<TranslationRunResult> {
  return { ok: false, reason: 'unavailable' };
}
