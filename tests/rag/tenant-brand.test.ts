import { afterEach, describe, expect, test, vi } from 'vitest';
import { evalScope, isTenantScope, runRetrieval } from '@/lib/rag';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { checkEvalScope } from '@/lib/rag-eval/auth';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';

function spies() {
  const embedder = vi.fn(async () => [0]);
  const adminClient = vi.fn(() => {
    throw new Error('admin client must not be used');
  });
  setRagDepsForTests({ embedder, adminClient: adminClient as never });
  return { embedder, adminClient };
}

const run = (scope: unknown) =>
  runRetrieval({ scope: scope as TenantScope, query: 'q', profile: 'eval', signal: new AbortController().signal });

afterEach(() => resetRagDepsForTests());

describe('runtime brand check', () => {
  test('a minted scope is recognised and frozen', () => {
    const scope = mintScope('personal', USER_A, null);
    expect(isTenantScope(scope)).toBe(true);
    expect(Object.isFrozen(scope)).toBe(true);
  });

  test('a spread copy of a minted scope is rejected before any stage runs', async () => {
    const { embedder, adminClient } = spies();
    const copy = { ...mintScope('single', null, null) };
    await expect(run(copy)).rejects.toThrow('[RAG Tenant] unminted scope');
    expect(embedder).not.toHaveBeenCalled();
    expect(adminClient).not.toHaveBeenCalled();
  });

  test('a JSON round-trip of a minted scope is rejected', async () => {
    const { embedder } = spies();
    const roundTripped = JSON.parse(JSON.stringify(mintScope('org', USER_A, ORG_O)));
    expect(isTenantScope(roundTripped)).toBe(false);
    await expect(run(roundTripped)).rejects.toThrow('[RAG Tenant] unminted scope');
    expect(embedder).not.toHaveBeenCalled();
  });

  test('a hand-built literal is rejected', async () => {
    spies();
    await expect(run({ kind: 'single', userId: null, organizationId: null })).rejects.toThrow('[RAG Tenant] unminted scope');
  });

  test('mintScope refuses malformed combinations', () => {
    expect(() => mintScope('single', USER_A, null)).toThrow();
    expect(() => mintScope('personal', 'not-a-uuid', null)).toThrow();
    expect(() => mintScope('personal', USER_A, ORG_O)).toThrow();
    expect(() => mintScope('org', USER_A, 'nope')).toThrow();
    expect(() => mintScope('org', 'nope', ORG_O)).toThrow();
  });
});

describe('evalScope', () => {
  const base = { organizationId: null, userId: null, allowedScopes: '' };

  test('single-tenant mints s:default', () => {
    const result = evalScope({ ...base, deploymentMode: 'single-tenant' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(scopeKey(result.scope)).toBe('s:default');
      expect(isTenantScope(result.scope)).toBe(true);
    }
  });

  test('multi-tenant with an allow-listed organization mints o:<id>', () => {
    const result = evalScope({ deploymentMode: 'multi-tenant', organizationId: ORG_O, userId: null, allowedScopes: `org:${ORG_O}` });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scope.kind).toBe('org');
      expect(scopeKey(result.scope)).toBe(`o:${ORG_O}`);
    }
  });

  test('multi-tenant with an allow-listed user mints u:<id>', () => {
    const result = evalScope({ deploymentMode: 'multi-tenant', organizationId: null, userId: USER_A, allowedScopes: `user:${USER_A}` });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scope.kind).toBe('personal');
      expect(scopeKey(result.scope)).toBe(`u:${USER_A}`);
    }
  });

  test('an organization wins over a user, as the allow-list key does', () => {
    const result = evalScope({ deploymentMode: 'multi-tenant', organizationId: ORG_O, userId: USER_A, allowedScopes: `org:${ORG_O}` });
    expect(result.ok && scopeKey(result.scope)).toBe(`o:${ORG_O}`);
  });

  test('anything outside the allow-list answers exactly as checkEvalScope does', () => {
    const cases = [
      { deploymentMode: 'multi-tenant', organizationId: ORG_O, userId: null, allowedScopes: '' },
      { deploymentMode: 'multi-tenant', organizationId: null, userId: USER_A, allowedScopes: `org:${ORG_O}` },
      { deploymentMode: 'multi-tenant', organizationId: null, userId: null, allowedScopes: `org:${ORG_O}` },
    ];
    for (const input of cases) {
      const expected = checkEvalScope(input);
      expect(expected.ok).toBe(false);
      expect(evalScope(input)).toEqual(expected);
    }
  });
});
