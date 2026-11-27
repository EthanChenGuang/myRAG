import type { QueryPlan } from '@/lib/rag-eval/contracts.generated';
import type { Profile } from '../types';
import { detectLanguageWithConfidence } from './detect';

export type QueryLanguageSource = NonNullable<QueryPlan['language_detection']>['source'];

/** D-17: the resolved query language, its confidence in [0, 1] and the chain step that decided it. */
export interface QueryLanguageDetection {
  language: string;
  confidence: number;
  source: QueryLanguageSource;
}

export interface ResolveQueryLanguageParams {
  language_confidence_threshold: number;
  langid_timeout_ms: number;
}

export interface ResolveQueryLanguageInput {
  text: string;
  /** RAG_SUPPORTED_LANGUAGES, through getLanguageSettings(). */
  enabled: readonly string[];
  /** RAG_PRIMARY_LANGUAGE; the last step of the chain. */
  primary: string;
  previousTurnLanguage?: string | null;
  uiLanguage?: string | null;
  profile: Profile;
  params: ResolveQueryLanguageParams;
  signal?: AbortSignal;
}

/** Stub for the RED commit: the chain arrives with the implementation. */
export async function resolveQueryLanguage(input: ResolveQueryLanguageInput): Promise<QueryLanguageDetection> {
  return { language: input.primary, confidence: 0, source: 'primary' };
}
