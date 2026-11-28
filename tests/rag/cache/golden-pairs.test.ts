import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBypassReason, storeBypassReason, type StoreTurnFacts } from '@/lib/rag/cache/bypass';
import { needsRewrite } from '@/lib/rag/query/rewrite-gate';

// Plan 06-39: the golden cache pairs reach the cache rules the pair run (plan 06-41) relies on. Paraphrase
// anchors are stored and their candidates checked; a code near miss is never checked (protected tokens).

type Item = { id: string; category: string; question: string; pair_of?: string | null; tags?: string[] };

const NOW = new Date('2026-11-25T10:00:00Z');
const DEFAULT_MAX = 25;
const items: Item[] = readFileSync(join(process.cwd(), 'eval/fixtures/golden.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as Item);
const byId = new Map(items.map((item) => [item.id, item]));

function facts(q: string): StoreTurnFacts {
  return {
    profile: 'eval',
    evalCacheOverride: true,
    ragMode: 'strict',
    gate: needsRewrite(q, { hasHistory: false, now: NOW }),
    rawQuery: q,
    standalone: q,
    historyLength: 0,
    condenseOk: true,
    webSearch: false,
    mcpTools: false,
    documentRefCount: 0,
    defaultMaxResults: DEFAULT_MAX,
    chatId: null,
    sourceImages: false,
    retrievalStatus: 'ok',
    groundednessLabel: 'not_checked',
    embedStore: false,
    answerText: 'An answer.',
  };
}

function pairs(category: string): Array<[Item, Item]> {
  const found = items.filter((item) => item.category === category);
  expect(found.length).toBeGreaterThanOrEqual(12);
  return found.map((item) => {
    const anchor = byId.get(item.pair_of ?? '');
    expect(anchor, item.id).toBeDefined();
    return [item, anchor as Item];
  });
}

describe('golden cache pairs against the cache bypass rules', () => {
  it('paraphrase anchors can be stored and paraphrase candidates are checked', () => {
    for (const [candidate, anchor] of pairs('cache_paraphrase')) {
      expect(storeBypassReason(facts(anchor.question)), anchor.id).toBeNull();
      expect(checkBypassReason(facts(candidate.question)), candidate.id).toBeNull();
    }
  });

  it('code near misses bypass the check through their protected tokens', () => {
    const code = pairs('cache_near_miss').filter(([candidate]) => candidate.tags?.includes('near_miss_code'));
    expect(code.length).toBeGreaterThanOrEqual(3);
    for (const [candidate] of code) {
      expect(checkBypassReason(facts(candidate.question)), candidate.id).toBe('protected_tokens');
    }
  });

  it('language, product and date near misses are checked by distance, not bypassed', () => {
    const kinds = ['near_miss_language', 'near_miss_product', 'near_miss_date'];
    const checked = pairs('cache_near_miss').filter(([candidate]) =>
      kinds.some((kind) => candidate.tags?.includes(kind)),
    );
    expect(checked.length).toBeGreaterThanOrEqual(9);
    for (const [candidate] of checked) {
      expect(checkBypassReason(facts(candidate.question)), candidate.id).toBeNull();
    }
  });
});
