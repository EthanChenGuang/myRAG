import { describe, expect, it } from 'vitest';
import { computeCacheKeyHash, hashSystemPromptTemplate } from '@/lib/rag/cache/keys';
import type { CacheKeyParts } from '@/lib/rag/cache/types';

const BASE: CacheKeyParts = {
  answerLanguage: 'en',
  ragMode: 'strict',
  generatorModel: 'provider/model-a',
  retrievalConfigHash: 'a'.repeat(64),
  queryFramework: 'llamaindex',
  entryProfile: 'chat',
  systemPromptHash: 'b'.repeat(64),
};

const HEX64 = /^[0-9a-f]{64}$/;

describe('computeCacheKeyHash', () => {
  it('is a 64-character hex SHA-256', () => {
    expect(computeCacheKeyHash(BASE)).toMatch(HEX64);
  });

  it('does not depend on key order', () => {
    const reversed = Object.fromEntries(Object.entries(BASE).reverse()) as unknown as CacheKeyParts;
    expect(computeCacheKeyHash(reversed)).toBe(computeCacheKeyHash(BASE));
    expect(computeCacheKeyHash({ ...BASE })).toBe(computeCacheKeyHash(BASE));
  });

  const changes: Array<[keyof CacheKeyParts, CacheKeyParts[keyof CacheKeyParts]]> = [
    ['answerLanguage', 'zh'],
    ['ragMode', 'balanced'],
    ['generatorModel', 'provider/model-b'],
    ['retrievalConfigHash', 'c'.repeat(64)],
    ['queryFramework', 'langchain'],
    ['entryProfile', 'embed'],
    ['systemPromptHash', 'd'.repeat(64)],
  ];
  it.each(changes)('changing %s alone changes the hash', (key, value) => {
    const changed = { ...BASE, [key]: value } as CacheKeyParts;
    expect(computeCacheKeyHash(changed)).toMatch(HEX64);
    expect(computeCacheKeyHash(changed)).not.toBe(computeCacheKeyHash(BASE));
  });

  it('gives chat, embed and eval three different namespaces', () => {
    const hashes = (['chat', 'embed', 'eval'] as const).map((entryProfile) =>
      computeCacheKeyHash({ ...BASE, entryProfile }),
    );
    expect(new Set(hashes).size).toBe(3);
    for (const h of hashes) expect(h).toMatch(HEX64);
  });

  it('keeps field boundaries: moving text between parts changes the hash', () => {
    const a = computeCacheKeyHash({ ...BASE, generatorModel: 'x', retrievalConfigHash: 'yz' });
    const b = computeCacheKeyHash({ ...BASE, generatorModel: 'xy', retrievalConfigHash: 'z' });
    expect(a).not.toBe(b);
  });

  it('requires every part at the type level', () => {
    const { systemPromptHash: _omit, ...partial } = BASE;
    // @ts-expect-error systemPromptHash is required
    const missing: CacheKeyParts = partial;
    expect(missing).toBeDefined();
  });

  it('rejects a part missing at runtime', () => {
    const { entryProfile: _omit, ...partial } = BASE;
    expect(() => computeCacheKeyHash(partial as unknown as CacheKeyParts)).toThrow();
  });
});

describe('hashSystemPromptTemplate', () => {
  const template = 'Answer from the context.\n\n{{context}}\n\nBe concise.';

  it('hashes the template before substitution, so different context text gives the same hash', () => {
    const turnA = hashSystemPromptTemplate(template);
    const turnB = hashSystemPromptTemplate(template);
    expect(turnA).toMatch(HEX64);
    expect(turnA).toBe(turnB);
    const substituted = template.replace('{{context}}', 'chunk text one');
    expect(hashSystemPromptTemplate(substituted)).not.toBe(turnA);
  });

  it('gives different templates different hashes', () => {
    expect(hashSystemPromptTemplate(template)).not.toBe(hashSystemPromptTemplate(`${template} Cite sources.`));
  });
});
