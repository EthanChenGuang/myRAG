import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoldenExportLineSchema } from '@/lib/rag/feedback-loop/exports';
import { pgliteClient } from '../helpers/pglite-rest-client';
import { ADMIN_ID, silenceConsole } from '../helpers/admin-guard-fixture';
import { CHUNK_A, CHUNK_B, DOC_A, DOC_B, TENANT_A, TENANT_B, candidate, createReviewFixture } from '../helpers/review-fixture';

/** Research X-9: every golden export line says where its item came from (rag_review_item_strata.source, null without a row). */

let db: PGlite;
const calls: string[] = [];
const strataFilters: Array<{ method: string; column: string; value: unknown }> = [];
const guard = { session: null as { id: string } | null };
let imported: string;
let sampled: string;
let mined: string;
let foreignImported: string;

function adminClient() {
  const data = pgliteClient(db, { role: 'service_role', label: 'admin', calls });
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    from(table: string) {
      if (table === 'rag_review_item_strata') return recordFilters(data.from(table));
      if (table !== 'admin_users') return data.from(table);
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        abortSignal: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: filters.id === ADMIN_ID ? { id: ADMIN_ID } : null, error: null }),
      };
      return builder;
    },
  };
}

function recordFilters<T extends object>(builder: T): T {
  const proxy: T = new Proxy(builder, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (property === 'eq' || property === 'in') strataFilters.push({ method: property, column: String(args[0]), value: args[1] });
        const result = value.apply(target, args);
        return result === target ? proxy : result;
      };
    },
  });
  return proxy;
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: guard.session } }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => adminClient(), getSupabase: () => ({}) }));
  return import('@/app/api/rag/admin/feedback-loop/export/route');
}

const get = (query: string) => new NextRequest(`http://localhost/api/rag/admin/feedback-loop/export${query}`);

function goldenLabel(chunkId: string, documentId: string, quote: string) {
  return {
    answerable: true,
    category: 'general',
    language: 'en',
    expected_answer: 'A synthetic answer.',
    evidence: [{ chunk_id: chunkId, document_id: documentId, document_name: 'synthetic.md', section: '', quote }],
    triage: ['golden'],
    pii_checked: true,
  };
}

interface ItemSpec {
  tenant: string;
  chunkId: string;
  documentId: string;
  quote: string;
  reasons: string[];
  traceId: string | null;
  source: string | null;
}

async function labelledItem(spec: ItemSpec): Promise<string> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO rag_review_items (tenant_key, trace_id, query_masked, query_fingerprint, channel, outcome, reasons, candidates, mining_window)
     VALUES ($1, $2, 'A synthetic question', $3, 'chat', 'unknown', $4, $5::jsonb, '2026-11-23T00:00:00Z') RETURNING id`,
    [
      spec.tenant,
      spec.traceId,
      crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
      spec.reasons,
      JSON.stringify(spec.traceId ? [candidate(spec.chunkId, spec.documentId, 1)] : []),
    ],
  );
  const id = inserted.rows[0].id;
  await db.query(`UPDATE rag_review_items SET status = 'labelled', triage = ARRAY['golden'], label = $2::jsonb WHERE id = $1`, [
    id,
    JSON.stringify(goldenLabel(spec.chunkId, spec.documentId, spec.quote)),
  ]);
  if (spec.source) {
    await db.query(
      `INSERT INTO rag_review_item_strata (review_item_id, tenant_key, source, stratum, sampling_weight) VALUES ($1, $2, $3, $4, 1)`,
      [id, spec.tenant, spec.source, `${spec.source}|en|import`],
    );
  }
  return id;
}

beforeAll(async () => {
  ({ db } = await createReviewFixture());
  imported = await labelledItem({
    tenant: TENANT_A,
    chunkId: CHUNK_A,
    documentId: DOC_A,
    quote: 'restarts every night',
    reasons: ['representative'],
    traceId: null,
    source: 'historical',
  });
  sampled = await labelledItem({
    tenant: TENANT_A,
    chunkId: CHUNK_A,
    documentId: DOC_A,
    quote: 'the sample component',
    reasons: ['representative'],
    traceId: crypto.randomUUID(),
    source: 'representative',
  });
  mined = await labelledItem({
    tenant: TENANT_A,
    chunkId: CHUNK_A,
    documentId: DOC_A,
    quote: 'restarts every night',
    reasons: ['low_score'],
    traceId: crypto.randomUUID(),
    source: null,
  });
  foreignImported = await labelledItem({
    tenant: TENANT_B,
    chunkId: CHUNK_B,
    documentId: DOC_B,
    quote: 'private sentence',
    reasons: ['representative'],
    traceId: null,
    source: 'historical',
  });
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  guard.session = { id: ADMIN_ID };
  calls.length = 0;
  strataFilters.length = 0;
  silenceConsole();
  vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'true');
  vi.stubEnv('MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
  vi.stubEnv('NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/supabase/server');
});

describe('golden export source (research X-9)', () => {
  it('carries historical for an imported item, representative for a sampled item and null for a mined item without strata', async () => {
    const route = await load();
    const response = await route.GET(get(`?kind=golden&tenant=${TENANT_A}`));
    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { id: string; source: unknown });
    for (const line of lines) expect(GoldenExportLineSchema.safeParse(line).success).toBe(true);
    const byId = new Map(lines.map((line) => [line.id, line.source]));
    expect(byId.get(imported)).toBe('historical');
    expect(byId.get(sampled)).toBe('representative');
    expect(byId.has(mined)).toBe(true);
    expect(byId.get(mined)).toBeNull();
    expect(byId.has(foreignImported)).toBe(false);
    expect(text).not.toContain(TENANT_B);
    expect(text).not.toMatch(/"(user_id|chat_id|trace_id|stratum|sampling_weight)"/);
  });

  it('limits the strata read to the exported item ids and the export tenant', async () => {
    const route = await load();
    expect((await route.GET(get(`?kind=golden&tenant=${TENANT_A}`))).status).toBe(200);
    expect(calls.filter((call) => call === 'admin:rag_review_item_strata').length).toBeGreaterThan(0);
    expect(strataFilters).toContainEqual({ method: 'eq', column: 'tenant_key', value: TENANT_A });
    const idFilters = strataFilters.filter((filter) => filter.method === 'in' && filter.column === 'review_item_id');
    expect(idFilters.length).toBeGreaterThan(0);
    const requested = idFilters.flatMap((filter) => filter.value as string[]);
    expect(new Set(requested)).toEqual(new Set([imported, sampled, mined]));
    expect(JSON.stringify(strataFilters)).not.toContain(TENANT_B);

    const foreign = await route.GET(get(`?kind=golden&tenant=${TENANT_B}`));
    const foreignLines = (await foreign.text())
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { id: string; source: unknown });
    expect(foreignLines.map((line) => [line.id, line.source])).toEqual([[foreignImported, 'historical']]);
  });
});
