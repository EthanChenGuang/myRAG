import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalTenantKey,
  isCanonicalTenantKey,
  qdrantCollectionName,
  weaviateCollectionName,
  weaviateTenantName,
} from '@/lib/rag/backend/tenant-key';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';

const keyOverride = vi.hoisted(() => ({ transform: null as ((key: string) => string) | null }));

vi.mock('@/lib/rag/tenant/scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/tenant/scope')>();
  return {
    ...actual,
    scopeKey: (scope: Parameters<typeof actual.scopeKey>[0]) => {
      const key = actual.scopeKey(scope);
      return keyOverride.transform ? keyOverride.transform(key) : key;
    },
  };
});

afterEach(() => {
  keyOverride.transform = null;
});

const USER_LOWER = '0f8e2c1a-9b7d-4c3e-8a21-5d6f7e8a9b0c';
const ORG_LOWER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TENANT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

describe('canonicalTenantKey', () => {
  it('lower-cases a personal scope minted from an upper-case UUID', () => {
    const upper = mintScope('personal', USER_LOWER.toUpperCase(), null);
    const lower = mintScope('personal', USER_LOWER, null);
    expect(canonicalTenantKey(upper)).toBe(`u:${USER_LOWER}`);
    expect(canonicalTenantKey(upper)).toBe(canonicalTenantKey(lower));
  });

  it('lower-cases an org scope minted from an upper-case UUID', () => {
    const scope = mintScope('org', USER_LOWER.toUpperCase(), ORG_LOWER.toUpperCase());
    expect(canonicalTenantKey(scope)).toBe(`o:${ORG_LOWER}`);
  });

  it('lower-cases an upper-case UUID even when the scope key arrives upper-case', () => {
    keyOverride.transform = (key) => key.replace(/^([uo]:)(.*)$/, (_m, p: string, id: string) => p + id.toUpperCase());
    const personal = mintScope('personal', USER_LOWER.toUpperCase(), null);
    const org = mintScope('org', null, ORG_LOWER.toUpperCase());
    expect(scopeKey(personal)).toBe(`u:${USER_LOWER.toUpperCase()}`);
    expect(canonicalTenantKey(personal)).toBe(`u:${USER_LOWER}`);
    expect(canonicalTenantKey(org)).toBe(`o:${ORG_LOWER}`);
  });

  it('gives s:default for the single scope', () => {
    expect(canonicalTenantKey(mintScope('single', null, null))).toBe('s:default');
  });

  it('equals the Postgres scopeKey for lower-case input', () => {
    const scope = mintScope('personal', USER_LOWER, null);
    expect(canonicalTenantKey(scope)).toBe(scopeKey(scope));
  });

  it('rejects a hand-built object shaped like a TenantScope', () => {
    const forged = { kind: 'personal', userId: USER_LOWER, organizationId: null } as unknown as TenantScope;
    expect(() => canonicalTenantKey(forged)).toThrow(/\[RAG Tenant\]/);
    expect(() => canonicalTenantKey(Object.freeze({ ...forged }) as TenantScope)).toThrow(/\[RAG Tenant\]/);
  });

  it('isCanonicalTenantKey accepts only the three lower-case shapes', () => {
    expect(isCanonicalTenantKey('s:default')).toBe(true);
    expect(isCanonicalTenantKey(`u:${USER_LOWER}`)).toBe(true);
    expect(isCanonicalTenantKey(`o:${ORG_LOWER}`)).toBe(true);
    for (const bad of ['', 's:other', `u:${USER_LOWER.toUpperCase()}`, `x:${USER_LOWER}`, USER_LOWER, `u:${USER_LOWER} `, 42, null]) {
      expect(isCanonicalTenantKey(bad)).toBe(false);
    }
  });
});

describe('weaviateTenantName', () => {
  it('maps the three key shapes', () => {
    expect(weaviateTenantName('s:default')).toBe('s_default');
    expect(weaviateTenantName(`u:${USER_LOWER}`)).toBe(`u_${USER_LOWER}`);
    expect(weaviateTenantName(`o:${ORG_LOWER}`)).toBe(`o_${ORG_LOWER}`);
  });

  it('produces names that match the vendor grammar', () => {
    const keys = [
      'single',
      'personal',
      'org',
    ].map((kind) =>
      canonicalTenantKey(
        kind === 'single'
          ? mintScope('single', null, null)
          : kind === 'personal'
            ? mintScope('personal', USER_LOWER.toUpperCase(), null)
            : mintScope('org', null, ORG_LOWER.toUpperCase()),
      ),
    );
    for (const key of keys) expect(weaviateTenantName(key)).toMatch(TENANT_NAME_RE);
  });

  it('rejects malformed keys', () => {
    for (const bad of [
      '',
      'sdefault',
      USER_LOWER,
      `u:${USER_LOWER.toUpperCase()}`,
      `x:${USER_LOWER}`,
      's:other',
      `u:${USER_LOWER}:extra`,
      `o_${ORG_LOWER}`,
    ]) {
      expect(() => weaviateTenantName(bad)).toThrow(/\[RAG Tenant\]/);
    }
  });
});

describe('collection names', () => {
  it('weaviateCollectionName is a valid class name with a hash suffix', () => {
    const a = weaviateCollectionName('voyage-4-large-2048');
    const b = weaviateCollectionName('voyage_4_large_2048');
    expect(a.startsWith('Myrag_chunks_')).toBe(true);
    expect(a).toMatch(/^[A-Z][A-Za-z0-9_]*$/);
    expect(b).toMatch(/^[A-Z][A-Za-z0-9_]*$/);
    expect(a).not.toBe(b);
    expect(a).toMatch(/_[0-9a-f]{8}$/);
    expect(weaviateCollectionName('voyage-4-large-2048')).toBe(a);
  });

  it('weaviateCollectionName rejects an empty profile id', () => {
    expect(() => weaviateCollectionName('')).toThrow(/\[RAG Tenant\]/);
  });

  it('qdrantCollectionName is myrag_chunks_<profileId>', () => {
    expect(qdrantCollectionName('openai-3-small-1536')).toBe('myrag_chunks_openai-3-small-1536');
    expect(qdrantCollectionName('voyage_4_large_2048')).toBe('myrag_chunks_voyage_4_large_2048');
  });

  it('qdrantCollectionName rejects characters outside [a-z0-9_-]', () => {
    for (const bad of ['', 'Voyage-4', 'a/b', 'a b', 'a.b', '../x', 'a:b']) {
      expect(() => qdrantCollectionName(bad)).toThrow(/\[RAG Tenant\]/);
    }
  });
});
