import type { GateResult } from '../query/rewrite-gate';
import type { Profile, RagMode, RetrievalOptions, RetrievalStatus } from '../types';
import type { GroundednessLabel } from './types';

export type CheckBypassReason =
  | 'invalid_facts'
  | 'profile'
  | 'rag_mode'
  | 'skip_retrieval'
  | 'document_refs'
  | 'retrieval_options'
  | 'tools'
  | 'protected_tokens'
  | 'relative_time'
  | 'personal_data'
  | 'uncondensed_follow_up';

export type StoreOnlyBypassReason =
  | 'ghost_chat'
  | 'history_dependent'
  | 'source_images'
  | 'retrieval_status'
  | 'unreliable'
  | 'embed_check_only'
  | 'empty_answer';

export type BypassReason = CheckBypassReason | StoreOnlyBypassReason;

export type CacheRetrievalOptions = Pick<RetrievalOptions, 'mediaKind' | 'generalOverview' | 'maxResults' | 'degrade'>;

export interface TurnFacts {
  profile: Profile;
  evalCacheOverride: boolean;
  ragMode: RagMode;
  gate: Pick<GateResult, 'transforms' | 'reasons' | 'protectedTokens' | 'skipRetrieval'>;
  rawQuery: string;
  standalone: string;
  historyLength: number;
  condenseOk: boolean;
  webSearch: boolean;
  mcpTools: boolean;
  documentRefCount: number;
  retrievalOptions?: CacheRetrievalOptions;
  defaultMaxResults: number;
}

export interface StoreTurnFacts extends TurnFacts {
  chatId: string | null;
  sourceImages: boolean;
  retrievalStatus: RetrievalStatus;
  groundednessLabel: GroundednessLabel | null;
  embedStore: boolean;
  answerText: string;
}

export function hasPersonalData(_text: string): boolean {
  return false;
}

export function retrievalOptionsAreDefault(_options: CacheRetrievalOptions | undefined, _defaultMaxResults: number): boolean {
  return true;
}

export function checkBypassReason(_facts: TurnFacts): CheckBypassReason | null {
  return null;
}

export function storeBypassReason(_facts: StoreTurnFacts): BypassReason | null {
  return null;
}
