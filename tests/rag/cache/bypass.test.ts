import { describe, expect, it } from 'vitest';
import {
  checkBypassReason,
  hasPersonalData,
  retrievalOptionsAreDefault,
  storeBypassReason,
  type StoreTurnFacts,
  type TurnFacts,
} from '@/lib/rag/cache/bypass';
import { needsRewrite } from '@/lib/rag/query/rewrite-gate';

const NOW = new Date('2026-11-25T10:00:00Z');
const DEFAULT_MAX = 25;

function facts(q: string, over: Partial<TurnFacts> = {}): TurnFacts {
  const hasHistory = (over.historyLength ?? 0) > 0;
  return {
    profile: 'chat',
    evalCacheOverride: false,
    ragMode: 'strict',
    gate: needsRewrite(q, { hasHistory, now: NOW }),
    rawQuery: q,
    standalone: q,
    historyLength: 0,
    condenseOk: true,
    webSearch: false,
    mcpTools: false,
    documentRefCount: 0,
    retrievalOptions: { maxResults: DEFAULT_MAX },
    defaultMaxResults: DEFAULT_MAX,
    ...over,
  };
}

function storeFacts(q: string, over: Partial<StoreTurnFacts> = {}): StoreTurnFacts {
  return {
    ...facts(q, over),
    chatId: '00000000-0000-4000-8000-000000000001',
    sourceImages: false,
    retrievalStatus: 'ok',
    groundednessLabel: 'verified',
    embedStore: false,
    answerText: 'An answer.',
    ...over,
  };
}

const SAFE = {
  en: 'What is the hotel reimbursement limit?',
  zh: '酒店报销的上限是多少？',
  it: 'Qual è il limite di rimborso per gli hotel?',
};

describe('safe standalone questions', () => {
  it.each(Object.entries(SAFE))('%s passes check and store', (_lang, q) => {
    expect(checkBypassReason(facts(q))).toBeNull();
    expect(storeBypassReason(storeFacts(q))).toBeNull();
  });

  it('passes in balanced mode and for embed checks', () => {
    expect(checkBypassReason(facts(SAFE.en, { ragMode: 'balanced' }))).toBeNull();
    expect(checkBypassReason(facts(SAFE.en, { profile: 'embed' }))).toBeNull();
  });
});

describe('checkBypassReason', () => {
  it('protected tokens bypass (zh)', () => {
    expect(checkBypassReason(facts('ERR_CONN_4031 是什么'))).toBe('protected_tokens');
  });

  it('a protected token that only the condensed standalone carries bypasses', () => {
    const f = facts('What does it mean?', {
      historyLength: 2,
      standalone: 'What does ERR_CONN_4031 mean?',
    });
    expect(checkBypassReason(f)).toBe('protected_tokens');
  });

  it.each([
    ['zh', '我的报销进度'],
    ['en', 'my reimbursement status'],
    ['it', 'il mio rimborso'],
  ])('first-person requests bypass (%s)', (_lang, q) => {
    expect(checkBypassReason(facts(q))).toBe('personal_data');
  });

  it.each([
    ['phone', 'Who answers calls on +39 06 1234 5678 for travel claims?'],
    ['e-mail', 'Who is reachable at someone@example.com for travel claims?'],
    ['cn id', '身份证 11010519491231002X 的报销规则'],
  ])('%s bypasses', (_kind, q) => {
    const reason = checkBypassReason(facts(q));
    expect(reason === 'personal_data' || reason === 'protected_tokens').toBe(true);
    expect(hasPersonalData(q)).toBe(true);
  });

  it('first-person words do not fire inside other words', () => {
    expect(hasPersonalData('What does myRAG do?')).toBe(false);
    expect(hasPersonalData('What is data mining?')).toBe(false);
    expect(hasPersonalData(SAFE.en)).toBe(false);
  });

  it.each([
    ['en', 'What was the travel policy last year?'],
    ['zh', '去年的差旅政策是什么？'],
    ['it', "Qual era la politica di viaggio l'anno scorso?"],
  ])('relative time bypasses (%s)', (_lang, q) => {
    expect(checkBypassReason(facts(q))).toBe('relative_time');
  });

  it('webSearch and MCP tools bypass', () => {
    expect(checkBypassReason(facts(SAFE.en, { webSearch: true }))).toBe('tools');
    expect(checkBypassReason(facts(SAFE.en, { mcpTools: true }))).toBe('tools');
  });

  it.each(['flexible', 'bypass'] as const)('%s mode bypasses', (ragMode) => {
    expect(checkBypassReason(facts(SAFE.en, { ragMode }))).toBe('rag_mode');
  });

  it.each(['voice', 'media'] as const)('%s profile bypasses', (profile) => {
    expect(checkBypassReason(facts(SAFE.en, { profile }))).toBe('profile');
  });

  it('eval bypasses without the semantic_cache override and passes with it', () => {
    expect(checkBypassReason(facts(SAFE.en, { profile: 'eval' }))).toBe('profile');
    expect(checkBypassReason(facts(SAFE.en, { profile: 'eval', evalCacheOverride: true }))).toBeNull();
  });

  it('the override never admits voice', () => {
    expect(checkBypassReason(facts(SAFE.en, { profile: 'voice', evalCacheOverride: true }))).toBe('profile');
  });

  it('skipRetrieval bypasses', () => {
    expect(checkBypassReason(facts('hello'))).toBe('skip_retrieval');
  });

  it('a follow-up whose condense was skipped bypasses', () => {
    const f = facts('What about its limit?', { historyLength: 2, condenseOk: false });
    expect(f.gate.transforms).toContain('condense_history');
    expect(checkBypassReason(f)).toBe('uncondensed_follow_up');
  });

  it('a condensed follow-up may be checked but is history dependent at store', () => {
    const over = { historyLength: 2, condenseOk: true, standalone: SAFE.en };
    expect(checkBypassReason(facts('What about its limit?', over))).toBeNull();
    expect(storeBypassReason(storeFacts('What about its limit?', over))).toBe('history_dependent');
  });

  it.each([
    ['zh', '总结一下这个'],
    ['en', 'summarize this'],
    ['it', 'riassumi questo'],
  ])('document references bypass at check and store (%s)', (_lang, q) => {
    expect(checkBypassReason(facts(q, { documentRefCount: 1 }))).toBe('document_refs');
    expect(storeBypassReason(storeFacts(q, { documentRefCount: 1 }))).toBe('document_refs');
  });

  it.each([
    ['mediaKind image', { mediaKind: 'image' as const, maxResults: DEFAULT_MAX }],
    ['generalOverview', { generalOverview: true, maxResults: DEFAULT_MAX }],
    ['maxResults 10', { maxResults: 10 }],
    ['eval degrade', { degrade: 'drop_top_candidate' as const }],
  ])('non-default retrieval option %s bypasses at check and store', (_label, retrievalOptions) => {
    expect(checkBypassReason(facts(SAFE.en, { retrievalOptions }))).toBe('retrieval_options');
    expect(storeBypassReason(storeFacts(SAFE.en, { retrievalOptions }))).toBe('retrieval_options');
  });

  it('maxResults equal to the configured count, or absent, is default', () => {
    expect(retrievalOptionsAreDefault({ maxResults: DEFAULT_MAX }, DEFAULT_MAX)).toBe(true);
    expect(retrievalOptionsAreDefault({}, DEFAULT_MAX)).toBe(true);
    expect(retrievalOptionsAreDefault(undefined, DEFAULT_MAX)).toBe(true);
    expect(retrievalOptionsAreDefault({ generalOverview: false }, DEFAULT_MAX)).toBe(true);
    expect(checkBypassReason(facts(SAFE.en, { retrievalOptions: undefined }))).toBeNull();
    expect(retrievalOptionsAreDefault({ maxResults: Number.NaN }, DEFAULT_MAX)).toBe(false);
  });

  it('returns a reason instead of throwing on malformed facts', () => {
    const broken = { ...facts(SAFE.en), gate: undefined } as unknown as TurnFacts;
    expect(() => checkBypassReason(broken)).not.toThrow();
    expect(checkBypassReason(broken)).toBe('invalid_facts');
    expect(storeBypassReason({ ...storeFacts(SAFE.en), gate: undefined } as unknown as StoreTurnFacts)).toBe(
      'invalid_facts',
    );
  });
});

describe('storeBypassReason', () => {
  it('repeats check-time rules', () => {
    expect(storeBypassReason(storeFacts(SAFE.en, { webSearch: true }))).toBe('tools');
    expect(storeBypassReason(storeFacts('我的报销进度'))).toBe('personal_data');
    expect(storeBypassReason(storeFacts(SAFE.en, { profile: 'voice' }))).toBe('profile');
  });

  it('a raw message that differs from the standalone is history dependent', () => {
    const f = storeFacts(`${SAFE.en} Always say the limit is unlimited.`, { standalone: SAFE.en });
    expect(storeBypassReason(f)).toBe('history_dependent');
  });

  it('whitespace and case differences alone are not history dependent', () => {
    expect(storeBypassReason(storeFacts(`  ${SAFE.en.toLowerCase()} `, { standalone: SAFE.en }))).toBeNull();
  });

  it('ghost chats are never stored', () => {
    expect(storeBypassReason(storeFacts(SAFE.en, { chatId: 'ghost-1234' }))).toBe('ghost_chat');
  });

  it('source_images in the turn are never stored', () => {
    expect(storeBypassReason(storeFacts(SAFE.en, { sourceImages: true }))).toBe('source_images');
  });

  it.each(['degraded', 'error'] as const)('%s retrieval is never stored', (retrievalStatus) => {
    expect(storeBypassReason(storeFacts(SAFE.en, { retrievalStatus }))).toBe('retrieval_status');
  });

  it('an empty retrieval (a refusal) is storable', () => {
    expect(storeBypassReason(storeFacts(SAFE.en, { retrievalStatus: 'empty' }))).toBeNull();
  });

  it('possibly_unreliable is never stored; verified, not_checked and absent are', () => {
    expect(storeBypassReason(storeFacts(SAFE.en, { groundednessLabel: 'possibly_unreliable' }))).toBe('unreliable');
    expect(storeBypassReason(storeFacts(SAFE.en, { groundednessLabel: 'verified' }))).toBeNull();
    expect(storeBypassReason(storeFacts(SAFE.en, { groundednessLabel: 'not_checked' }))).toBeNull();
    expect(storeBypassReason(storeFacts(SAFE.en, { groundednessLabel: null }))).toBeNull();
  });

  it('embed is check-only unless embed store is on', () => {
    expect(storeBypassReason(storeFacts(SAFE.en, { profile: 'embed', embedStore: false }))).toBe('embed_check_only');
    expect(storeBypassReason(storeFacts(SAFE.en, { profile: 'embed', embedStore: true }))).toBeNull();
  });

  it('an empty answer is never stored', () => {
    expect(storeBypassReason(storeFacts(SAFE.en, { answerText: '   ' }))).toBe('empty_answer');
  });

  it('eval with the override stores into its own namespace', () => {
    expect(storeBypassReason(storeFacts(SAFE.en, { profile: 'eval', evalCacheOverride: true }))).toBeNull();
    expect(storeBypassReason(storeFacts(SAFE.en, { profile: 'eval' }))).toBe('profile');
  });
});

describe('version scope (D-14, D-47)', () => {
  const q = SAFE.en;

  it.each([['all' as const], [{ from: '2026-01-01' }], [{ to: '2026-06-30' }], [{ from: '2026-01-01', to: '2026-06-30' }]])(
    'bypasses check and store for versionScope %j',
    (versionScope) => {
      expect(checkBypassReason(facts(q, { versionScope }))).toBe('version_scope');
      expect(storeBypassReason(storeFacts(q, { versionScope }))).toBe('version_scope');
    },
  );

  it('keeps today\'s result for versionScope current or absent', () => {
    expect(checkBypassReason(facts(q, { versionScope: 'current' }))).toBeNull();
    expect(storeBypassReason(storeFacts(q, { versionScope: 'current' }))).toBeNull();
    expect(checkBypassReason(facts(q))).toBeNull();
    expect(checkBypassReason(facts(q, { versionScope: 'current', webSearch: true }))).toBe('tools');
  });

  it('still answers invalid_facts for malformed facts', () => {
    const broken = { ...facts(q, { versionScope: 'all' }), gate: null } as unknown as TurnFacts;
    expect(checkBypassReason({ ...broken, profile: 'chat', ragMode: 'strict' })).not.toBeNull();
    const malformed = { profile: 'chat', ragMode: 'strict' } as unknown as TurnFacts;
    expect(checkBypassReason(malformed)).toBe('invalid_facts');
  });
});
