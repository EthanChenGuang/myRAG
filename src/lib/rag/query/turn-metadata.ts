import { RagTurnMetadataSchema, type QueryPlan, type RagTurnMetadata } from '@/lib/rag-eval/contracts.generated';
import { getLanguageSettings } from '../lang/settings';

export type { RagTurnMetadata };

const STANDALONE_MAX = 1000;

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** D-22: the caller-supplied `rag` of one message, or undefined when it does not pass the generated strict schema. */
export function parseRagTurnMetadata(value: unknown): RagTurnMetadata | undefined {
  const parsed = RagTurnMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** D-22, P-22: the turn's standalone query and language from the query plan; undefined when retrieval produced no plan. */
export function ragTurnMetadataFromPlan(plan: QueryPlan | null | undefined): RagTurnMetadata | undefined {
  if (!plan) return undefined;
  const text = typeof plan.standalone === 'string' && plan.standalone.trim() ? plan.standalone : plan.original;
  if (typeof text !== 'string' || !text.trim()) return undefined;
  return parseRagTurnMetadata({ standaloneQuery: capText(text, STANDALONE_MAX), queryLanguage: plan.language ?? null });
}

/** D-17: the code when it is one of the enabled languages, otherwise undefined. */
export function enabledLanguageOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 35) return undefined;
  const code = value.trim().toLowerCase();
  return getLanguageSettings().languages.includes(code) ? code : undefined;
}

function metadataRagOf(message: unknown): unknown {
  if (!message || typeof message !== 'object') return undefined;
  const metadata = (message as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  return (metadata as { rag?: unknown }).rag;
}

export interface QueryTurnInputs {
  previousStandaloneQuery?: string;
  previousTurnLanguage?: string;
  uiLanguage?: string;
}

/**
 * D-17, D-22: the previous user turn's stored standalone query and language, and the UI language, as runRetrieval inputs.
 * The values are query text and a language hint only; anything that fails validation is left out.
 */
export function queryTurnInputs(input: { messages: readonly unknown[] | null | undefined; uiLanguage?: unknown }): QueryTurnInputs {
  const out: QueryTurnInputs = {};
  const users = Array.isArray(input.messages)
    ? input.messages.filter((message) => (message as { role?: unknown } | null)?.role === 'user')
    : [];
  const raw = users.length >= 2 ? metadataRagOf(users[users.length - 2]) : undefined;
  const previous = raw === undefined ? undefined : parseRagTurnMetadata(raw);
  if (previous) {
    out.previousStandaloneQuery = previous.standaloneQuery;
    const language = enabledLanguageOf(previous.queryLanguage);
    if (language) out.previousTurnLanguage = language;
  }
  const uiLanguage = enabledLanguageOf(input.uiLanguage);
  if (uiLanguage) out.uiLanguage = uiLanguage;
  if (raw !== undefined) {
    console.log('[Query Layer] Previous turn metadata:', {
      present: true,
      valid: Boolean(previous),
      length: previous?.standaloneQuery.length ?? 0,
    });
  }
  return out;
}
