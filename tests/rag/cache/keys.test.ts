import { afterEach, describe, expect, it } from 'vitest';
import { cacheAccessKeyPart, computeCacheKeyHash, hashSystemPromptTemplate } from '@/lib/rag/cache/keys';
import type { CacheKeyParts } from '@/lib/rag/cache/types';
import { resetRagConfigForTests } from '@/lib/rag/config';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { AccessScopeMissingError, mintAccessScope } from '@/lib/rag/tenant/access';
import { mintScope, withAccess } from '@/lib/rag/tenant/scope';

const BASE: CacheKeyParts = {
  accessGroupSetHash: 'off',
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
    ['accessGroupSetHash', 'e'.repeat(64)],
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
    const partial: Omit<CacheKeyParts, 'systemPromptHash'> = { ...BASE };
    // @ts-expect-error systemPromptHash is required
    const missing: CacheKeyParts = partial;
    expect(missing).toBeDefined();
  });

  it('rejects a part missing at runtime', () => {
    const partial: Partial<CacheKeyParts> = { ...BASE };
    delete partial.entryProfile;
    expect(() => computeCacheKeyHash(partial as CacheKeyParts)).toThrow();
  });
});

describe('accessGroupSetHash key part (04.3-12, D-23, A-05)', () => {
  const USER_A = '00000000-0000-4000-8000-0000000000a1';
  const USER_B = '00000000-0000-4000-8000-0000000000b1';
  const GROUP_A = 'g:00000000-0000-4000-8000-0000000000f1';
  const GROUP_B = 'g:00000000-0000-4000-8000-0000000000f2';

  function accessSwitch(value: 'on' | 'off'): void {
    setRagDepsForTests({ ragEnv: () => ({ RAG_DOC_ACCESS_GROUPS: value }) });
    resetRagConfigForTests();
  }

  afterEach(() => {
    resetRagDepsForTests();
    resetRagConfigForTests();
  });

  it('rejects key parts without the access part, or with an empty one', () => {
    const partial: Partial<CacheKeyParts> = { ...BASE };
    delete partial.accessGroupSetHash;
    expect(() => computeCacheKeyHash(partial as CacheKeyParts)).toThrow(/accessGroupSetHash/);
    expect(() => computeCacheKeyHash({ ...BASE, accessGroupSetHash: '' })).toThrow(/accessGroupSetHash/);
  });

  it('requires the access part at the type level', () => {
    const partial: Omit<CacheKeyParts, 'accessGroupSetHash'> = { ...BASE };
    // @ts-expect-error accessGroupSetHash is required
    const missing: CacheKeyParts = partial;
    expect(missing).toBeDefined();
  });

  it('is the constant off with the switch off and an unattached scope', () => {
    accessSwitch('off');
    expect(cacheAccessKeyPart(mintScope('personal', USER_A, null))).toBe('off');
  });

  it('is the constant off for an off access scope and admin_all for an admin', () => {
    accessSwitch('on');
    const base = mintScope('personal', USER_A, null);
    expect(cacheAccessKeyPart(withAccess(base, mintAccessScope('off', [])))).toBe('off');
    expect(cacheAccessKeyPart(withAccess(base, mintAccessScope('admin_all', [])))).toBe('admin_all');
  });

  it('throws for an unattached scope while the switch is on, so no key is built', () => {
    accessSwitch('on');
    expect(() => cacheAccessKeyPart(mintScope('personal', USER_A, null))).toThrow(AccessScopeMissingError);
  });

  it('is the set hash of the effective keys: the same set gives the same key hash in any order, another set a different one', () => {
    accessSwitch('on');
    const a = withAccess(mintScope('personal', USER_A, null), mintAccessScope('keys', ['all', GROUP_A]));
    const sameSet = withAccess(mintScope('personal', USER_B, null), mintAccessScope('keys', [GROUP_A, 'all']));
    const other = withAccess(mintScope('personal', USER_A, null), mintAccessScope('keys', ['all', GROUP_B]));
    const part = cacheAccessKeyPart(a);
    expect(part).toMatch(HEX64);
    expect(cacheAccessKeyPart(sameSet)).toBe(part);
    expect(cacheAccessKeyPart(other)).not.toBe(part);
    const hashOf = (scope: typeof a) => computeCacheKeyHash({ ...BASE, accessGroupSetHash: cacheAccessKeyPart(scope) });
    expect(hashOf(sameSet)).toBe(hashOf(a));
    expect(hashOf(other)).not.toBe(hashOf(a));
    expect(hashOf(a)).not.toBe(computeCacheKeyHash(BASE));
    expect(computeCacheKeyHash({ ...BASE, accessGroupSetHash: 'admin_all' })).not.toBe(computeCacheKeyHash(BASE));
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
