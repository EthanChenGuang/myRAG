import { extractProtectedTokens } from '../query/protected';
import lexicon from '../query/rewrite-gate.lexicon.json';
import { matchRelativeTime, type GateResult } from '../query/rewrite-gate';
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

const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}_])';
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}_])';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PERSONAL_PATTERNS: readonly RegExp[] = Object.values(lexicon.personal_data).map(
  (source) => new RegExp(source, 'u'),
);

const FIRST_PERSON_ZH = new RegExp(lexicon.first_person.zh.map(escapeRegex).join('|'), 'u');
const FIRST_PERSON_LATIN = new RegExp(
  `${NOT_WORD_BEFORE}(?:${[...lexicon.first_person.en, ...lexicon.first_person.it]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|')})${NOT_WORD_AFTER}`,
  'iu',
);

const CACHEABLE_MODES: ReadonlySet<RagMode> = new Set(['strict', 'balanced']);
const STORABLE_STATUSES: ReadonlySet<RetrievalStatus> = new Set(['ok', 'empty']);

/** Phone numbers, e-mail addresses, ID numbers and first-person requests (D-12 lexicon). */
export function hasPersonalData(text: string): boolean {
  const normalized = text.normalize('NFKC');
  if (PERSONAL_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  return FIRST_PERSON_ZH.test(normalized) || FIRST_PERSON_LATIN.test(normalized);
}

/** Off-default retrieval options change what is retrieved, so such turns never read or write the cache. */
export function retrievalOptionsAreDefault(options: CacheRetrievalOptions | undefined, defaultMaxResults: number): boolean {
  if (!options) return true;
  if (options.mediaKind !== undefined) return false;
  if (options.generalOverview === true) return false;
  if (options.degrade !== undefined) return false;
  if (options.maxResults !== undefined && options.maxResults !== defaultMaxResults) return false;
  return true;
}

function profileAllowed(facts: TurnFacts): boolean {
  if (facts.profile === 'chat' || facts.profile === 'embed') return true;
  return facts.profile === 'eval' && facts.evalCacheOverride === true;
}

function hasRelativeTime(facts: TurnFacts): boolean {
  if (facts.gate.reasons.includes('R2_RELATIVE_TIME')) return true;
  return matchRelativeTime(facts.rawQuery).length > 0 || matchRelativeTime(facts.standalone).length > 0;
}

function hasProtectedTokens(facts: TurnFacts): boolean {
  if (facts.gate.protectedTokens.length > 0) return true;
  return extractProtectedTokens(facts.rawQuery).length > 0 || extractProtectedTokens(facts.standalone).length > 0;
}

function normalizeQuery(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function checkRules(facts: TurnFacts): CheckBypassReason | null {
  if (!profileAllowed(facts)) return 'profile';
  if (!CACHEABLE_MODES.has(facts.ragMode)) return 'rag_mode';
  if (facts.gate.skipRetrieval === true) return 'skip_retrieval';
  if (!(facts.documentRefCount === 0)) return 'document_refs';
  if (!retrievalOptionsAreDefault(facts.retrievalOptions, facts.defaultMaxResults)) return 'retrieval_options';
  if (facts.webSearch || facts.mcpTools) return 'tools';
  if (hasProtectedTokens(facts)) return 'protected_tokens';
  if (hasRelativeTime(facts)) return 'relative_time';
  if (hasPersonalData(facts.rawQuery) || hasPersonalData(facts.standalone)) return 'personal_data';
  if (facts.gate.transforms.includes('condense_history') && !facts.condenseOk) return 'uncondensed_follow_up';
  return null;
}

/** Check-time rules (D-33, spec rules 2 and 4, plan-check B1). Never throws: malformed facts bypass. */
export function checkBypassReason(facts: TurnFacts): CheckBypassReason | null {
  try {
    return checkRules(facts);
  } catch {
    return 'invalid_facts';
  }
}

function storeRules(facts: StoreTurnFacts): StoreOnlyBypassReason | null {
  if (typeof facts.chatId === 'string' && facts.chatId.startsWith('ghost-')) return 'ghost_chat';
  if (!(facts.historyLength === 0) || normalizeQuery(facts.rawQuery) !== normalizeQuery(facts.standalone)) {
    return 'history_dependent';
  }
  if (facts.sourceImages) return 'source_images';
  if (!STORABLE_STATUSES.has(facts.retrievalStatus)) return 'retrieval_status';
  if (facts.groundednessLabel === 'possibly_unreliable') return 'unreliable';
  if (facts.profile === 'embed' && facts.embedStore !== true) return 'embed_check_only';
  if (typeof facts.answerText !== 'string' || facts.answerText.trim().length === 0) return 'empty_answer';
  return null;
}

/** Every check-time rule, then the A-3 store-only rules. not_checked groundedness is storable. */
export function storeBypassReason(facts: StoreTurnFacts): BypassReason | null {
  const atCheck = checkBypassReason(facts);
  if (atCheck !== null) return atCheck;
  try {
    return storeRules(facts);
  } catch {
    return 'invalid_facts';
  }
}
