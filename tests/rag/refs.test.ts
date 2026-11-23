import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRetrieval } from '@/lib/rag';
import { resolveDocumentRefs } from '@/lib/rag/refs/resolve';
import { mintScope, type TenantScope } from '@/lib/rag/tenant/scope';
import { SEMANTIC_QUERY, fakeEmbedder, fakeRpcClient, installDeps, rows, uninstallDeps } from './helpers/pipeline-fakes';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const DOC_A = '00000000-0000-4000-8000-0000000000d1';
const DOC_B = '00000000-0000-4000-8000-0000000000d2';
const DOC_O = '00000000-0000-4000-8000-0000000000d3';

interface Row extends Record<string, unknown> {
  id: string;
}

interface Call {
  table: string;
  ops: Array<{ op: string; args: unknown[] }>;
  signal: AbortSignal | null;
}

type Tables = Record<string, Row[]>;

function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Applies eq / is / ilike / in / limit like the database would, and records every builder call. */
function filteringAdmin(tables: Tables, missingColumns: Record<string, string[]> = {}) {
  const calls: Call[] = [];
  const admin = {
    from(table: string) {
      const call: Call = { table, ops: [], signal: null };
      let columns: string[] | null = null;
      const predicates: Array<(row: Row) => boolean> = [];
      let limit = Infinity;
      let single = false;
      const builder: Record<string, unknown> = {};
      const record = (op: string, args: unknown[]) => {
        call.ops.push({ op, args });
        return builder;
      };
      builder.select = (list: string) => {
        columns = list === '*' ? null : list.split(',').map((column) => column.trim());
        return record('select', [list]);
      };
      builder.eq = (column: string, value: unknown) => {
        predicates.push((row) => row[column] === value);
        return record('eq', [column, value]);
      };
      builder.is = (column: string, value: unknown) => {
        predicates.push((row) => (row[column] ?? null) === value);
        return record('is', [column, value]);
      };
      builder.in = (column: string, values: unknown[]) => {
        predicates.push((row) => values.includes(row[column]));
        return record('in', [column, values]);
      };
      builder.ilike = (column: string, pattern: string) => {
        const matcher = likeToRegExp(pattern);
        predicates.push((row) => matcher.test(String(row[column] ?? '')));
        return record('ilike', [column, pattern]);
      };
      builder.limit = (count: number) => {
        limit = count;
        return record('limit', [count]);
      };
      builder.single = () => {
        single = true;
        return record('single', []);
      };
      builder.abortSignal = (signal: AbortSignal) => {
        call.signal = signal;
        return builder;
      };
      builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
        calls.push(call);
        const missing = (columns ?? []).find((column) => (missingColumns[table] ?? []).includes(column));
        let response: { data: unknown; error: { message: string; code?: string } | null };
        if (missing) {
          response = { data: null, error: { message: `column ${missing} does not exist`, code: '42703' } };
        } else {
          const matched = (tables[table] ?? []).filter((row) => predicates.every((predicate) => predicate(row))).slice(0, limit);
          const projected = matched.map((row) =>
            columns ? Object.fromEntries(columns.map((column) => [column, row[column]])) : { ...row },
          );
          if (single) {
            response =
              projected.length === 1
                ? { data: projected[0], error: null }
                : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
          } else {
            response = { data: projected, error: null };
          }
        }
        return Promise.resolve(response).then(onFulfilled, onRejected);
      };
      return builder;
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

function opsOf(call: Call, op: string): unknown[][] {
  return call.ops.filter((entry) => entry.op === op).map((entry) => entry.args);
}

function documentCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.table === 'documents');
}

const CREATED_AT = '2025-01-15T00:00:00.000Z';

function seed(): Tables {
  return {
    documents: [
      {
        id: DOC_A,
        filename: 'alpha-handbook.md',
        created_at: CREATED_AT,
        content: 'Alpha handbook full text',
        user_id: USER_A,
        organization_id: null,
        metadata: { external_url: 'https://example.invalid/alpha' },
      },
      {
        id: DOC_B,
        filename: 'bravo-secrets.md',
        created_at: CREATED_AT,
        content: 'Bravo secret text',
        user_id: USER_B,
        organization_id: null,
        metadata: {},
      },
      {
        id: DOC_O,
        filename: 'org-policy.md',
        created_at: CREATED_AT,
        content: 'Organization policy text',
        user_id: USER_B,
        organization_id: ORG_O,
        metadata: {},
      },
    ],
    document_chunks: [
      { id: 'chunk-a1', document_id: DOC_A, content: 'alpha chunk one' },
      { id: 'chunk-a2', document_id: DOC_A, content: 'alpha chunk two' },
      { id: 'chunk-b1', document_id: DOC_B, content: 'bravo chunk one' },
      { id: 'chunk-o1', document_id: DOC_O, content: 'org chunk one' },
    ],
  };
}

const personalA: TenantScope = mintScope('personal', USER_A, null);
const orgO: TenantScope = mintScope('org', USER_A, ORG_O);
const single: TenantScope = mintScope('single', null, null);
const signal = new AbortController().signal;

describe('resolveDocumentRefs', () => {
  let warn: { mock: { calls: unknown[][] } };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('personal scope resolves the caller filename and nothing of another tenant, with the predicate on every documents query', async () => {
    const { admin, calls } = filteringAdmin(seed());

    const result = await resolveDocumentRefs({
      scope: personalA,
      mentions: ['alpha-handbook', 'bravo-secrets'],
      documentParts: [],
      admin,
      signal,
    });

    expect(result.usedDocuments.map((doc) => doc.id)).toEqual([DOC_A]);
    expect(result.context).toContain('alpha chunk one');
    expect(result.context).not.toContain('bravo');
    expect(JSON.stringify(result)).not.toContain('Bravo');

    const queries = documentCalls(calls);
    expect(queries.length).toBeGreaterThanOrEqual(3);
    for (const call of queries) {
      expect(opsOf(call, 'eq')).toContainEqual(['user_id', USER_A]);
      expect(opsOf(call, 'is')).toContainEqual(['organization_id', null]);
    }
  });

  it('org scope puts the organization predicate on every documents query and reads only org documents', async () => {
    const { admin, calls } = filteringAdmin(seed());

    const result = await resolveDocumentRefs({
      scope: orgO,
      mentions: ['org-policy', 'alpha-handbook'],
      documentParts: [{ id: DOC_A, name: 'alpha-handbook.md' }],
      admin,
      signal,
    });

    expect(result.usedDocuments.map((doc) => doc.id)).toEqual([DOC_O]);
    expect(result.context).toContain('org chunk one');
    expect(result.context).not.toContain('alpha chunk');
    expect(result.ignored).toBe(1);

    const queries = documentCalls(calls);
    expect(queries.length).toBeGreaterThanOrEqual(3);
    for (const call of queries) {
      expect(opsOf(call, 'eq')).toContainEqual(['organization_id', ORG_O]);
      expect(opsOf(call, 'eq').some(([column]) => column === 'user_id')).toBe(false);
    }
  });

  it('single scope adds no predicate and issues the same queries as the inline code did', async () => {
    const { admin, calls } = filteringAdmin(seed());

    const result = await resolveDocumentRefs({
      scope: single,
      mentions: ['bravo-secrets'],
      documentParts: [],
      admin,
      signal,
    });

    expect(result.usedDocuments.map((doc) => doc.id)).toEqual([DOC_B]);
    expect(calls.map((call) => [call.table, call.ops.map((entry) => entry.op)])).toEqual([
      ['documents', ['select', 'ilike', 'limit']],
      ['documents', ['select', 'eq', 'single']],
      ['document_chunks', ['select', 'eq', 'limit']],
    ]);
    expect(opsOf(calls[0], 'ilike')).toEqual([['filename', '%bravo-secrets%']]);
    expect(opsOf(calls[2], 'limit')).toEqual([[30]]);
    for (const call of calls) {
      expect(call.ops.some((entry) => entry.op === 'is')).toBe(false);
    }
  });

  it('skips a document part owned by another tenant, logs one RAG Tenant warning and never queries its chunks', async () => {
    const { admin, calls } = filteringAdmin(seed());

    const result = await resolveDocumentRefs({
      scope: personalA,
      mentions: [],
      documentParts: [
        { id: DOC_B, name: 'bravo-secrets.md' },
        { id: DOC_A, name: 'alpha-handbook.md' },
      ],
      admin,
      signal,
    });

    expect(result.ignored).toBe(1);
    expect(result.usedDocuments.map((doc) => doc.id)).toEqual([DOC_A]);
    expect(result.context).not.toContain('bravo');

    const chunkCalls = calls.filter((call) => call.table === 'document_chunks');
    expect(chunkCalls).toHaveLength(1);
    expect(opsOf(chunkCalls[0], 'eq')).toEqual([['document_id', DOC_A]]);
    expect(JSON.stringify(calls)).not.toContain(`"document_id","${DOC_B}"`);

    const tenantWarnings = warn.mock.calls.filter((args: unknown[]) => String(args[0]).startsWith('[RAG Tenant]'));
    expect(tenantWarnings).toHaveLength(1);
    expect(tenantWarnings[0][1]).toEqual({ ignoredReferences: 1 });
  });

  it('does not warn when every reference is inside the scope', async () => {
    const { admin } = filteringAdmin(seed());

    await resolveDocumentRefs({ scope: personalA, mentions: [], documentParts: [{ id: DOC_A, name: 'alpha-handbook.md' }], admin, signal });

    expect(warn.mock.calls.filter((args: unknown[]) => String(args[0]).startsWith('[RAG Tenant]'))).toHaveLength(0);
  });

  it('produces the same used document entry and context section as the inline route code', async () => {
    const { admin } = filteringAdmin(seed());

    const result = await resolveDocumentRefs({
      scope: single,
      mentions: [],
      documentParts: [{ id: DOC_A, name: 'Alpha Handbook' }],
      admin,
      signal,
    });

    expect(result.usedDocuments).toEqual([
      {
        id: DOC_A,
        name: 'Alpha Handbook',
        filename: 'alpha-handbook.md',
        created_at: CREATED_AT,
        content_preview: 'Alpha handbook full text...',
        explicitly_referenced: true,
        external_url: 'https://example.invalid/alpha',
      },
    ]);
    expect(result.context).toBe('\n\n=== DOCUMENT: "Alpha Handbook" ===\nalpha chunk one\n\nalpha chunk two\n=== END OF DOCUMENT ===\n');
  });

  it('truncates the preview at 200 characters and leaves it undefined for an empty document', async () => {
    const tables = seed();
    tables.documents[0].content = 'x'.repeat(300);
    tables.documents[1].content = '';
    const { admin } = filteringAdmin(tables);

    const result = await resolveDocumentRefs({
      scope: single,
      mentions: [],
      documentParts: [
        { id: DOC_A, name: 'a' },
        { id: DOC_B, name: 'b' },
      ],
      admin,
      signal,
    });

    expect(result.usedDocuments[0].content_preview).toBe(`${'x'.repeat(200)}...`);
    expect(result.usedDocuments[1].content_preview).toBeUndefined();
  });

  it('falls back to the full document text when there are no chunks', async () => {
    const tables = seed();
    tables.document_chunks = [];
    tables.documents[0].text = 'Alpha full text column';
    const { admin } = filteringAdmin(tables);

    const result = await resolveDocumentRefs({ scope: personalA, mentions: [], documentParts: [{ id: DOC_A, name: 'alpha' }], admin, signal });

    expect(result.context).toBe('\n\n=== DOCUMENT: "alpha" ===\nAlpha full text column\n=== END OF DOCUMENT ===\n');
  });

  it('says no content could be retrieved when chunks and text are both unavailable', async () => {
    const tables = seed();
    tables.document_chunks = [];
    const { admin } = filteringAdmin(tables, { documents: ['text'] });

    const result = await resolveDocumentRefs({ scope: personalA, mentions: [], documentParts: [{ id: DOC_A, name: 'alpha' }], admin, signal });

    expect(result.context).toBe('\n\nDocument "alpha" was referenced but no content could be retrieved.\n');
    expect(result.usedDocuments).toHaveLength(1);
  });

  it('passes the abort signal to every query', async () => {
    const controller = new AbortController();
    const { admin, calls } = filteringAdmin(seed());

    await resolveDocumentRefs({ scope: personalA, mentions: ['alpha'], documentParts: [], admin, signal: controller.signal });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.signal).toBe(controller.signal);
  });
});

describe('refs stage in runRetrieval', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    uninstallDeps();
  });

  function pipelineTables(): Tables {
    const tables = seed();
    tables.documents.push({ id: 'doc-1', filename: 'doc-1.md', created_at: CREATED_AT, content: null, metadata: null });
    tables.document_chunks.push({ id: 'chunk-1', document_id: 'doc-1', content: 'fixture chunk body 1', metadata: null });
    return tables;
  }

  function install(admin: SupabaseClient, env: { RAG_DISABLED_STAGES?: string } = {}) {
    const rpc = fakeRpcClient({ rows: rows(1) });
    installDeps({
      anonClient: () => rpc.client,
      embedder: fakeEmbedder().embedder,
      ragEnv: () => env,
      adminClient: (() => admin) as never,
    });
  }

  function run(documentRefs?: { mentions: string[]; documentParts: Array<{ id: string; name: string }> }) {
    return runRetrieval({
      scope: single,
      query: SEMANTIC_QUERY,
      profile: 'chat',
      documentRefs,
      signal: new AbortController().signal,
    });
  }

  it('runs refs before analyze and hands the referenced documents to the assembly', async () => {
    install(filteringAdmin(pipelineTables()).admin);

    const result = await run({ mentions: ['alpha-handbook'], documentParts: [] });

    expect(result.status).toBe('ok');
    expect(result.stages.map((stage) => stage.name)).toEqual(['refs', 'analyze', 'embed', 'search', 'legacy_rank', 'post_filter', 'assemble']);
    expect(result.stages[0]).toMatchObject({ status: 'ok', candidates_out: 1 });
    expect(result.usedDocuments[0]).toMatchObject({ id: DOC_A, explicitly_referenced: true });
    expect(result.usedDocuments.map((doc) => doc.id)).toContain('doc-1');
    expect(result.context).toContain('=== DOCUMENT: "alpha-handbook.md" ===');
    expect(result.context).toContain('alpha chunk one');
  });

  it('keeps the referenced context first and does not refuse when the search finds nothing else', async () => {
    const rpc = fakeRpcClient({ rows: [] });
    installDeps({
      anonClient: () => rpc.client,
      embedder: fakeEmbedder().embedder,
      ragEnv: () => ({}),
      adminClient: (() => filteringAdmin(pipelineTables()).admin) as never,
    });

    const result = await run({ mentions: [], documentParts: [{ id: DOC_A, name: 'alpha-handbook.md' }] });

    expect(result.status).toBe('ok');
    expect(result.usedDocuments.map((doc) => doc.id)).toEqual([DOC_A]);
    expect(result.context).toBe('\n\n=== DOCUMENT: "alpha-handbook.md" ===\nalpha chunk one\n\nalpha chunk two\n=== END OF DOCUMENT ===\n');
    expect(result.refusalCandidate).toBe(false);
  });

  it('adds no refs stage when no references are given', async () => {
    install(filteringAdmin(pipelineTables()).admin);

    const empty = await run({ mentions: [], documentParts: [] });
    const absent = await run();

    for (const result of [empty, absent]) {
      expect(result.stages.map((stage) => stage.name)).not.toContain('refs');
    }
  });

  it('RAG_DISABLED_STAGES=refs skips the lookup and records the stage as disabled', async () => {
    const { admin, calls } = filteringAdmin(pipelineTables());
    install(admin, { RAG_DISABLED_STAGES: 'refs' });

    const result = await run({ mentions: ['alpha-handbook'], documentParts: [] });

    expect(result.stages[0]).toMatchObject({ name: 'refs', status: 'disabled' });
    expect(result.usedDocuments.map((doc) => doc.id)).not.toContain(DOC_A);
    expect(calls.some((call) => opsOf(call, 'ilike').length > 0)).toBe(false);
    expect(result.status).toBe('ok');
  });

  it('a failing refs stage is skipped and the result is degraded, not an error', async () => {
    const working = filteringAdmin(pipelineTables()).admin;
    const failing = {
      from(table: string) {
        if (table === 'documents') {
          const builder = working.from(table) as unknown as { ilike: (...args: unknown[]) => unknown };
          builder.ilike = () => {
            throw new Error('documents lookup unavailable');
          };
          return builder;
        }
        return working.from(table);
      },
    } as unknown as SupabaseClient;
    install(failing);

    const result = await run({ mentions: ['alpha-handbook'], documentParts: [] });

    expect(result.stages[0]).toMatchObject({ name: 'refs', status: 'skipped', reason: 'failed' });
    expect(result.status).toBe('degraded');
    expect(result.usedDocuments.map((doc) => doc.id)).toEqual(['doc-1']);
  });
});
