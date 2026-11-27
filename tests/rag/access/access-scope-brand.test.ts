import { afterEach, describe, expect, test } from 'vitest';
import { resetRagConfigForTests } from '@/lib/rag/config';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import {
  AccessScopeMissingError,
  accessRpcArgs,
  assertAccessScope,
  hashAccessKeys,
  isAccessScope,
  mintAccessScope,
  scopeAccessFilter,
} from '@/lib/rag/tenant/access';
import { mintScope, withAccess } from '@/lib/rag/tenant/scope';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const GROUP_A = 'g:00000000-0000-4000-8000-0000000000f1';
const GROUP_B = 'g:00000000-0000-4000-8000-0000000000f2';

function switchTo(value: 'on' | 'off'): void {
  setRagDepsForTests({ ragEnv: () => ({ RAG_DOC_ACCESS_GROUPS: value }) });
  resetRagConfigForTests();
}

afterEach(() => {
  resetRagDepsForTests();
  resetRagConfigForTests();
  delete process.env.RAG_DOC_ACCESS_GROUPS;
});

describe('AccessScope brand (D-05)', () => {
  test('an object shaped like an AccessScope but not minted is refused', () => {
    const minted = mintAccessScope('keys', ['all', GROUP_A]);
    for (const forged of [{ ...minted }, JSON.parse(JSON.stringify(minted)), { mode: 'admin_all', keys: [], setHash: '' }]) {
      expect(isAccessScope(forged)).toBe(false);
      expect(() => assertAccessScope(forged)).toThrow('[RAG Access] unminted access scope');
    }
    expect(isAccessScope(minted)).toBe(true);
  });

  test('withAccess refuses an unminted scope or access scope', () => {
    const access = mintAccessScope('keys', ['all']);
    const scope = mintScope('personal', USER_A, null);
    expect(() => withAccess({ ...scope } as never, access)).toThrow('[RAG Tenant] unminted scope');
    expect(() => withAccess(scope, { ...access } as never)).toThrow('[RAG Access] unminted access scope');
  });

  test('a minted scope, its access and its keys are frozen; withAccess keeps kind, user and organization', () => {
    const base = mintScope('org', USER_A, ORG_O);
    const scope = withAccess(base, mintAccessScope('keys', [GROUP_A, 'all']));
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.access)).toBe(true);
    expect(Object.isFrozen(scope.access?.keys)).toBe(true);
    expect({ kind: scope.kind, userId: scope.userId, organizationId: scope.organizationId }).toEqual({
      kind: 'org',
      userId: USER_A,
      organizationId: ORG_O,
    });
    expect(base.access).toBeUndefined();
  });

  test('invalid keys and mode/key combinations are refused', () => {
    expect(() => mintAccessScope('keys', [])).toThrow();
    expect(() => mintAccessScope('keys', ['g:not-a-uuid'])).toThrow('[RAG Access] invalid access key');
    expect(() => mintAccessScope('keys', ['everyone'])).toThrow('[RAG Access] invalid access key');
    expect(() => mintAccessScope('off', ['all'])).toThrow();
    expect(() => mintAccessScope('unknown' as never, [])).toThrow('[RAG Access] unknown access mode');
  });

  test('hashAccessKeys is independent of key order and differs for different sets', () => {
    expect(hashAccessKeys(['all', GROUP_A, GROUP_B])).toBe(hashAccessKeys([GROUP_B, 'all', GROUP_A]));
    expect(hashAccessKeys(['all', GROUP_A])).not.toBe(hashAccessKeys(['all', GROUP_B]));
    expect(hashAccessKeys(['all'])).toMatch(/^[0-9a-f]{64}$/);
    expect(mintAccessScope('keys', [GROUP_B, 'all']).setHash).toBe(mintAccessScope('keys', ['all', GROUP_B]).setHash);
  });
});

describe('scopeAccessFilter (A-14 seam 1)', () => {
  test('returns exactly the three shapes', () => {
    switchTo('on');
    const base = mintScope('personal', USER_A, null);
    const keys = mintAccessScope('keys', [GROUP_A, 'all']);
    expect(scopeAccessFilter(withAccess(base, keys))).toEqual({ mode: 'keys', keys: ['all', GROUP_A], setHash: keys.setHash });
    expect(scopeAccessFilter(withAccess(base, mintAccessScope('admin_all', [])))).toEqual({ mode: 'admin_all' });
    expect(scopeAccessFilter(withAccess(base, mintAccessScope('off', [])))).toEqual({ mode: 'off' });
  });

  test('an unattached scope is off with the switch off and throws with it on', () => {
    const scope = mintScope('single', null, null);
    switchTo('off');
    expect(scopeAccessFilter(scope)).toEqual({ mode: 'off' });
    switchTo('on');
    expect(() => scopeAccessFilter(scope)).toThrow(AccessScopeMissingError);
  });

  test('the default deps read RAG_DOC_ACCESS_GROUPS from the environment', () => {
    resetRagDepsForTests();
    process.env.RAG_DOC_ACCESS_GROUPS = 'on';
    resetRagConfigForTests();
    expect(() => scopeAccessFilter(mintScope('single', null, null))).toThrow(AccessScopeMissingError);
  });

  test('an unminted scope is refused', () => {
    expect(() => scopeAccessFilter({ kind: 'single', userId: null, organizationId: null } as never)).toThrow('[RAG Tenant] unminted scope');
  });
});

describe('accessRpcArgs', () => {
  test('off is empty; admin_all and keys add exactly the two arguments', () => {
    expect(accessRpcArgs({ mode: 'off' })).toEqual({});
    expect(accessRpcArgs({ mode: 'admin_all' })).toEqual({ p_access_keys: ['all'], p_access_all: true });
    const keys = mintAccessScope('keys', ['all', GROUP_A]);
    expect(accessRpcArgs({ mode: 'keys', keys: keys.keys, setHash: keys.setHash })).toEqual({
      p_access_keys: ['all', GROUP_A],
      p_access_all: false,
    });
  });

  test('a keys filter without keys is refused rather than sent as an empty array', () => {
    expect(() => accessRpcArgs({ mode: 'keys', keys: [], setHash: hashAccessKeys([]) })).toThrow();
  });
});
