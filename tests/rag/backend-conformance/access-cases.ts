import { describe, expect, it } from 'vitest';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { mintAccessScope, scopeAccessFilter } from '@/lib/rag/tenant/access';
import { mintScope, withAccess, type TenantScope } from '@/lib/rag/tenant/scope';
import type { ConformanceContext } from './cases';

// 04.3-16 (EVAL-21, D-32, A-14): same-tenant access cases through the RetrievalBackend request contract. A backend opts in by calling
// runAccessConformance with a factory that loads ACCESS_DATASET into its store. Phase 7 backends (07-38, 07-39) can call it unchanged;
// the three-backend canary is 07-39's.

export const ACCESS_IDS = {
  org: '00000000-0000-4000-8000-0000000016c1',
  memberA: '00000000-0000-4000-8000-0000000016a1',
  outsider: '00000000-0000-4000-8000-0000000016b1',
  admin: '00000000-0000-4000-8000-0000000016a9',
  groupA: '00000000-0000-4000-8000-0000000016f1',
  docRestricted: '00000000-0000-4000-8000-0000000016d1',
  docOpen: '00000000-0000-4000-8000-0000000016d2',
  docPrivate: '00000000-0000-4000-8000-0000000016d3',
  chunkRestricted: '00000000-0000-4000-8000-0000000016e1',
  chunkOpen: '00000000-0000-4000-8000-0000000016e2',
  chunkPrivate: '00000000-0000-4000-8000-0000000016e3',
} as const;

const GROUP_A = `g:${ACCESS_IDS.groupA}`;
const MEMBER_A_KEY = `u:${ACCESS_IDS.memberA}`;

export const ACCESS_QUERY = 'quillfen harbor ledger note';

export interface AccessDatasetRow {
  documentId: string;
  chunkId: string;
  filename: string;
  body: string;
  language: string;
  /** D-02 keys: all, g:<group uuid>, u:<user uuid>. */
  accessGroups: string[];
}

/** One organization tenant with member-a (in group-a), an outsider and an admin; neutral synthetic sentences. */
export interface AccessDataset {
  orgId: string;
  members: { memberA: string; outsider: string; admin: string };
  groupA: string;
  rows: AccessDatasetRow[];
}

export const ACCESS_DATASET: AccessDataset = {
  orgId: ACCESS_IDS.org,
  members: { memberA: ACCESS_IDS.memberA, outsider: ACCESS_IDS.outsider, admin: ACCESS_IDS.admin },
  groupA: ACCESS_IDS.groupA,
  rows: [
    {
      documentId: ACCESS_IDS.docRestricted,
      chunkId: ACCESS_IDS.chunkRestricted,
      filename: 'access-restricted.md',
      body: 'quillfen harbor ledger note for the first neutral synthetic record',
      language: 'en',
      accessGroups: [GROUP_A],
    },
    {
      documentId: ACCESS_IDS.docOpen,
      chunkId: ACCESS_IDS.chunkOpen,
      filename: 'access-open.md',
      body: 'quillfen harbor ledger note for the second neutral synthetic record',
      language: 'en',
      accessGroups: ['all'],
    },
    {
      documentId: ACCESS_IDS.docPrivate,
      chunkId: ACCESS_IDS.chunkPrivate,
      filename: 'access-private.md',
      body: 'quillfen harbor ledger note for the third neutral synthetic record',
      language: 'en',
      accessGroups: [MEMBER_A_KEY],
    },
  ],
};

export type AccessConformanceContext = Pick<ConformanceContext, 'backend' | 'profileId' | 'embed' | 'queryTokens' | 'close'>;

export type AccessConformanceFactory = (dataset: AccessDataset) => Promise<AccessConformanceContext>;

type Caller = 'memberA' | 'outsider' | 'admin' | 'off';
type Leg = 'lexical' | 'dense' | 'combined';
const LEGS: readonly Leg[] = ['lexical', 'dense', 'combined'];

function baseScope(userId: string): TenantScope {
  return mintScope('org', userId, ACCESS_IDS.org);
}

/** Scopes as the resolver would attach them (D-05): keys are all, the user key and the user's group keys. */
function scopeFor(caller: Caller): TenantScope {
  if (caller === 'memberA') return withAccess(baseScope(ACCESS_IDS.memberA), mintAccessScope('keys', ['all', MEMBER_A_KEY, GROUP_A]));
  if (caller === 'outsider') {
    return withAccess(baseScope(ACCESS_IDS.outsider), mintAccessScope('keys', ['all', `u:${ACCESS_IDS.outsider}`]));
  }
  if (caller === 'admin') return withAccess(baseScope(ACCESS_IDS.admin), mintAccessScope('admin_all', []));
  return withAccess(baseScope(ACCESS_IDS.outsider), mintAccessScope('off', []));
}

function request(ctx: AccessConformanceContext, scope: TenantScope, leg: Leg): BackendSearchRequest {
  const dense = leg !== 'lexical';
  const lexical = leg !== 'dense';
  return {
    scope,
    embeddingProfileId: ctx.profileId,
    denseVector: dense ? ctx.embed(ACCESS_QUERY) : null,
    lexicalTokens: lexical ? ctx.queryTokens(ACCESS_QUERY) : [],
    lexicalLanguages: null,
    access: scopeAccessFilter(scope),
    filters: { currentOnly: true },
    denseLimit: dense ? 10 : 0,
    lexicalLimit: lexical ? 10 : 0,
    signal: new AbortController().signal,
  };
}

function idsOf(legs: BackendLegs, leg: Leg): Set<string> {
  const rows = leg === 'lexical' ? legs.lexical : leg === 'dense' ? legs.dense : [...legs.dense, ...legs.lexical];
  return new Set(rows.map((row) => row.chunkId));
}

async function search(backend: RetrievalBackend, ctx: AccessConformanceContext, caller: Caller, leg: Leg): Promise<Set<string>> {
  return idsOf(await backend.search(request(ctx, scopeFor(caller), leg)), leg);
}

/**
 * The negative control: a backend that ignores the access filter. It drops req.access and searches the bare tenant scope, as an adapter
 * that only applies the tenant filter would.
 */
export function ignoringAccess(inner: RetrievalBackend): RetrievalBackend {
  return {
    ...inner,
    search: (req) => inner.search({ ...req, scope: baseScope(req.scope.userId ?? ACCESS_IDS.outsider), access: { mode: 'off' } }),
  };
}

export function runAccessConformance(name: string, factory: AccessConformanceFactory): void {
  describe(`backend access conformance (${name})`, () => {
    let ctx: AccessConformanceContext;

    it('loads the factory', async () => {
      ctx = await factory(ACCESS_DATASET);
    }, 120_000);

    for (const leg of LEGS) {
      it(`the outsider gets no restricted or other member's row on the ${leg} leg, and still gets the open row`, async () => {
        const ids = await search(ctx.backend, ctx, 'outsider', leg);
        expect(ids.has(ACCESS_IDS.chunkRestricted)).toBe(false);
        expect(ids.has(ACCESS_IDS.chunkPrivate)).toBe(false);
        expect(ids.has(ACCESS_IDS.chunkOpen)).toBe(true);
      });

      it(`member-a gets the restricted and own rows on the ${leg} leg`, async () => {
        const ids = await search(ctx.backend, ctx, 'memberA', leg);
        expect(ids.has(ACCESS_IDS.chunkRestricted)).toBe(true);
        expect(ids.has(ACCESS_IDS.chunkPrivate)).toBe(true);
        expect(ids.has(ACCESS_IDS.chunkOpen)).toBe(true);
      });

      it(`admin_all and mode off get every row on the ${leg} leg`, async () => {
        for (const caller of ['admin', 'off'] as const) {
          const ids = await search(ctx.backend, ctx, caller, leg);
          for (const row of ACCESS_DATASET.rows) expect(ids.has(row.chunkId), `${caller} ${row.filename}`).toBe(true);
        }
      });

      it(`negative control: a backend that ignores req.access leaks to the outsider on the ${leg} leg`, async () => {
        const ids = await search(ignoringAccess(ctx.backend), ctx, 'outsider', leg);
        expect(ids.has(ACCESS_IDS.chunkRestricted)).toBe(true);
      });
    }

    it('closes the factory', async () => {
      await ctx?.close();
    });
  });
}
