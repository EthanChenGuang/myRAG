import { describe, expect, it } from 'vitest';
import { RetrievalBackendError, type RpcClient, type RpcRequest, type RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { countContextTokens, type BudgetCandidate } from '@/lib/rag/context/budget';
import {
  collapseByParent,
  expandParents,
  selectWithParents,
  type ExpandableChild,
  type ParentExpansion,
} from '@/lib/rag/parents/expand';
import { mintScope } from '@/lib/rag/tenant/scope';

const scope = mintScope('single', null, null);
const KEY = 's:default';

const P = 'parent-p';
const Q = 'parent-q';

interface Child extends ExpandableChild, BudgetCandidate {
  rank: number;
  parent?: ParentExpansion;
}

function child(chunkId: string, rank: number, parentId: string | null, content = `child ${chunkId}`, documentId = 'doc-1'): Child {
  return {
    chunk_id: chunkId,
    document_id: documentId,
    document_filename: 'guide.md',
    rank,
    content,
    parent_id: parentId,
  };
}

interface ParentRowInput {
  id: string;
  content: string;
  documentId?: string;
  tenantKey?: string;
  tokenCount?: number;
}

function parentRow(row: ParentRowInput) {
  return {
    id: row.id,
    document_id: row.documentId ?? 'doc-1',
    tenant_key: row.tenantKey ?? KEY,
    version: 1,
    is_current: true,
    chunking_profile_id: 'legacy',
    section_path: ['Guide', 'Setup'],
    content: row.content,
    token_count: row.tokenCount ?? 10,
    parent_index: 0,
  };
}

interface Call {
  fn: string;
  args: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

function capturingClient(
  rows: unknown[],
  options: { error?: { message: string; code?: string }; delayMs?: number } = {},
): { client: RpcClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: RpcClient = {
    rpc(fn: string, args: Record<string, unknown>): RpcRequest {
      const call: Call = { fn, args, signal: undefined };
      calls.push(call);
      const request: RpcRequest = {
        abortSignal(next: AbortSignal) {
          call.signal = next;
          return request;
        },
        then(onFulfilled, onRejected) {
          const settled = new Promise<RpcResponse>((resolve) => {
            const timer = setTimeout(
              () => resolve(options.error ? { data: null, error: options.error } : { data: rows, error: null }),
              options.delayMs ?? 0,
            );
            call.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve({ data: null, error: { message: 'aborted' } });
              },
              { once: true },
            );
          });
          return settled.then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

const signal = () => new AbortController().signal;

describe('expandParents', () => {
  it('fetches the distinct parent ids once in rank order and keeps one entry per parent at its best rank', async () => {
    const survivors = [child('c1', 1, P), child('c2', 2, Q), child('c3', 3, P)];
    const { client, calls } = capturingClient([
      parentRow({ id: Q, content: 'parent Q text' }),
      parentRow({ id: P, content: 'parent P text' }),
    ]);

    const result = await expandParents({ survivors, scope, admin: client, signal: signal() });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.fn).toBe('rag_fetch_parents');
    expect(calls[0]?.args).toEqual({ p_tenant_key: KEY, p_parent_ids: [P, Q] });
    expect(calls[0]?.signal).toBeDefined();
    expect(result.entries.map((entry) => entry.chunk_id)).toEqual(['c1', 'c2']);
    expect(result.entries.map((entry) => entry.parent?.id)).toEqual([P, Q]);
    expect(result.entries[0]?.parent?.content).toBe('parent P text');
    expect(result.entries[0]?.parent?.sectionPath).toEqual(['Guide', 'Setup']);
    expect(result.candidates.map((entry) => entry.parent?.id)).toEqual([P, Q, P]);
    expect(result.requested).toBe(2);
    expect(result.fetched).toBe(2);
  });

  it('keeps a child without a parent id as the child and makes no call when nothing has a parent', async () => {
    const { client, calls } = capturingClient([]);
    const survivors = [child('c1', 1, null), child('c2', 2, null)];

    const result = await expandParents({ survivors, scope, admin: client, signal: signal() });

    expect(calls).toHaveLength(0);
    expect(result.entries.map((entry) => entry.chunk_id)).toEqual(['c1', 'c2']);
    expect(result.entries.every((entry) => entry.parent === undefined)).toBe(true);
    expect(result.fetched).toBe(0);
  });

  it('makes no call and returns nothing for an empty survivor list', async () => {
    const { client, calls } = capturingClient([]);
    const result = await expandParents({ survivors: [], scope, admin: client, signal: signal() });
    expect(calls).toHaveLength(0);
    expect(result.entries).toEqual([]);
  });

  it('leaves a child alone when its parent did not come back', async () => {
    const survivors = [child('c1', 1, P), child('c2', 2, Q)];
    const { client } = capturingClient([parentRow({ id: Q, content: 'parent Q text' })]);

    const result = await expandParents({ survivors, scope, admin: client, signal: signal() });

    expect(result.entries.map((entry) => [entry.chunk_id, entry.parent?.id])).toEqual([
      ['c1', undefined],
      ['c2', Q],
    ]);
    expect(result.fetched).toBe(1);
  });

  it('never uses a row of another tenant, an unrequested row, or a parent of a different document', async () => {
    const survivors = [child('c1', 1, P), child('c2', 2, Q, 'child c2', 'doc-2'), child('c3', 3, 'parent-own')];
    const { client } = capturingClient([
      parentRow({ id: P, content: 'foreign text', tenantKey: 'u:00000000-0000-4000-8000-0000000000b1' }),
      parentRow({ id: Q, content: 'wrong document text', documentId: 'doc-9' }),
      parentRow({ id: 'parent-unrequested', content: 'never asked for' }),
      parentRow({ id: 'parent-own', content: 'own parent text' }),
    ]);

    const result = await expandParents({ survivors, scope, admin: client, signal: signal() });

    expect(result.entries.map((entry) => [entry.chunk_id, entry.parent?.content])).toEqual([
      ['c1', undefined],
      ['c2', undefined],
      ['c3', 'own parent text'],
    ]);
    expect(result.fetched).toBe(1);
  });

  it('skips children the eligibility check rules out', async () => {
    const survivors = [child('c1', 1, P), child('c2', 2, Q)];
    const { client, calls } = capturingClient([parentRow({ id: Q, content: 'parent Q text' })]);

    const result = await expandParents({
      survivors,
      scope,
      admin: client,
      signal: signal(),
      eligible: (item) => item.chunk_id !== 'c1',
    });

    expect(calls[0]?.args.p_parent_ids).toEqual([Q]);
    expect(result.entries.map((entry) => entry.parent?.id)).toEqual([undefined, Q]);
  });

  it('asks for at most 200 parent ids', async () => {
    const survivors = Array.from({ length: 250 }, (_, index) => child(`c${index}`, index + 1, `parent-${index}`));
    const { client, calls } = capturingClient([]);

    await expandParents({ survivors, scope, admin: client, signal: signal() });

    const ids = calls[0]?.args.p_parent_ids as string[];
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe('parent-0');
    expect(ids[199]).toBe('parent-199');
  });

  it('rejects when there is no admin client, and uses nothing else', async () => {
    const error = await expandParents({ survivors: [child('c1', 1, P)], scope, admin: null, signal: signal() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetrievalBackendError);
    expect((error as RetrievalBackendError).rpc).toBe('rag_fetch_parents');
    expect((error as RetrievalBackendError).code).toBe('admin_unavailable');
  });

  it('rejects with the RPC error code', async () => {
    const { client } = capturingClient([], { error: { message: 'boom', code: '42501' } });
    const error = await expandParents({ survivors: [child('c1', 1, P)], scope, admin: client, signal: signal() }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RetrievalBackendError);
    expect((error as RetrievalBackendError).rpc).toBe('rag_fetch_parents');
    expect((error as RetrievalBackendError).code).toBe('42501');
  });

  it('rejects with the abort reason when the signal fires during the fetch', async () => {
    const controller = new AbortController();
    const reason = new Error('request cancelled');
    const { client } = capturingClient([parentRow({ id: P, content: 'parent P text' })], { delayMs: 50 });

    const pending = expandParents({ survivors: [child('c1', 1, P)], scope, admin: client, signal: controller.signal });
    setTimeout(() => controller.abort(reason), 5);

    await expect(pending).rejects.toBe(reason);
  });

  it('rejects an unminted scope before any call', async () => {
    const { client, calls } = capturingClient([]);
    const forged = { kind: 'single', userId: null, organizationId: null } as unknown as typeof scope;
    await expect(expandParents({ survivors: [child('c1', 1, P)], scope: forged, admin: client, signal: signal() })).rejects.toThrow(
      /unminted scope/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('collapseByParent', () => {
  it('keeps the first child of each used parent and every child of a parent that is not used', () => {
    const parent: ParentExpansion = { id: P, documentId: 'doc-1', content: 'p', tokenCount: 1, sectionPath: [] };
    const list = [
      { ...child('c1', 1, P), parent },
      { ...child('c2', 2, null) },
      { ...child('c3', 3, P), parent },
    ];
    expect(collapseByParent(list, () => true).map((entry) => entry.chunk_id)).toEqual(['c1', 'c2']);
    expect(collapseByParent(list, () => false).map((entry) => entry.chunk_id)).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('selectWithParents', () => {
  const words = (word: string, count: number) => Array.from({ length: count }, () => word).join(' ');
  const estimate = (candidate: BudgetCandidate) => candidate.content;
  const options = { imageExtensions: ['.png'] };

  function annotated(list: Child[], parents: Record<string, string>): Child[] {
    return list.map((entry) => {
      const parentId = entry.parent_id;
      if (!parentId || parents[parentId] === undefined) return entry;
      const content = parents[parentId] as string;
      return {
        ...entry,
        parent: { id: parentId, documentId: entry.document_id, content, tokenCount: countContextTokens(content), sectionPath: [] },
      };
    });
  }

  it('uses the parent text once for a parent hit by several children, at the best child rank', () => {
    const list = annotated([child('c1', 1, P), child('c2', 2, Q), child('c3', 3, P)], {
      [P]: words('alpha', 40),
      [Q]: words('beta', 40),
    });

    const result = selectWithParents(list, 1000, estimate, options);

    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['c1', 'c2']);
    expect(result.selected[0]?.content).toBe(words('alpha', 40));
    expect(result.selected[1]?.content).toBe(words('beta', 40));
    expect([...result.parentIds].sort()).toEqual([P, Q]);
    expect([...result.parentChunkIds].sort()).toEqual(['c1', 'c2']);
  });

  it('keeps the child in place of a parent that does not fit the budget', () => {
    const pText = words('alpha', 60);
    const qText = words('beta', 400);
    const list = annotated([child('c1', 1, P), child('c2', 2, Q, 'short child two')], { [P]: pText, [Q]: qText });

    const budget = countContextTokens(pText) + 40;
    const result = selectWithParents(list, budget, estimate, options);

    expect(result.selected.map((entry) => [entry.chunk_id, entry.content])).toEqual([
      ['c1', pText],
      ['c2', 'short child two'],
    ]);
    expect([...result.parentIds]).toEqual([P]);
    expect([...result.parentChunkIds]).toEqual(['c1']);
    expect(result.usedTokens).toBeLessThanOrEqual(budget);
  });

  it('counts the parent against the budget, so a later hit is dropped that fit as a child', () => {
    const pText = words('alpha', 120);
    const list = annotated([child('c1', 1, P), child('c2', 2, null, words('gamma', 60), 'doc-2')], { [P]: pText });

    const withParent = selectWithParents(list, countContextTokens(pText) + 20, estimate, options);
    expect(withParent.selected.map((entry) => entry.chunk_id)).toEqual(['c1']);

    const childOnly = selectWithParents(
      list.map((entry) => ({ ...entry, parent: undefined })),
      countContextTokens(pText) + 20,
      estimate,
      options,
    );
    expect(childOnly.selected.map((entry) => entry.chunk_id)).toEqual(['c1', 'c2']);
  });

  it('brings back every child of a parent that does not fit', () => {
    const list = annotated([child('c1', 1, P, 'child one'), child('c2', 2, null, 'child two'), child('c3', 3, P, 'child three')], {
      [P]: words('alpha', 500),
    });

    const result = selectWithParents(list, 100, estimate, options);

    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['c1', 'c2', 'c3']);
    expect(result.selected.map((entry) => entry.content)).toEqual(['child one', 'child two', 'child three']);
    expect(result.parentIds.size).toBe(0);
  });

  it('never truncates a parent: a first-rank parent over the budget falls back to its child', () => {
    const list = annotated([child('c1', 1, P, 'tiny child')], { [P]: words('alpha', 500) });

    const result = selectWithParents(list, 50, estimate, options);

    expect(result.selected.map((entry) => entry.content)).toEqual(['tiny child']);
    expect(result.contentOverrides.size).toBe(0);
    expect(result.parentIds.size).toBe(0);
  });

  it('equals the plain selection when no candidate has a parent', () => {
    const list = [child('c1', 1, null), child('c2', 2, null)];
    const result = selectWithParents(list, 1000, estimate, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['c1', 'c2']);
    expect(result.parentIds.size).toBe(0);
  });
});
