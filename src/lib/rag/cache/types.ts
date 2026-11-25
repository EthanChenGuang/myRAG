import type { CachedAnswer } from '@/lib/rag-eval/contracts.generated';
import type { TenantScope } from '../tenant/scope';
import type { RagMode } from '../types';

/** Key namespace: eval entries can never match chat or embed lookups. */
export type EntryProfile = 'chat' | 'embed' | 'eval';
export type CacheRagMode = Extract<RagMode, 'strict' | 'balanced'>;
export type QueryFramework = 'llamaindex' | 'langchain';
export type CacheAnswerLanguage = CachedAnswer['answer_language'];
export type GroundednessLabel = NonNullable<CachedAnswer['groundedness']['label']>;

/** Every part of key_hash. Document references and retrieval options are bypass rules, not key parts. */
export interface CacheKeyParts {
  answerLanguage: CacheAnswerLanguage;
  ragMode: CacheRagMode;
  generatorModel: string;
  retrievalConfigHash: string;
  queryFramework: QueryFramework;
  entryProfile: EntryProfile;
  /** hashSystemPromptTemplate of the template before {{context}} substitution. */
  systemPromptHash: string;
}

export interface CacheQuery extends CacheKeyParts {
  scope: TenantScope;
  standalone: string;
  vector: number[];
  embeddingProfileId: string;
}

export interface CacheHit {
  entryId: string;
  distance: number;
  answer: CachedAnswer;
}

export interface SemanticCache {
  check(q: CacheQuery): Promise<CacheHit | null>;
  store(q: CacheQuery, answer: CachedAnswer): Promise<void>;
  invalidateTenant(scope: TenantScope, documentIds?: string[]): Promise<number>;
}
