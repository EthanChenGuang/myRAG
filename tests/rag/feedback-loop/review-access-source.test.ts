import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyFixtureDatabase } from '../../../eval/harness/pglite-supabase.mts';
import { ReviewItemSchema, type ReviewItem } from '@/lib/rag-eval/contracts.generated';
import {
  attachReviewSources,
  getReviewItemWithSource,
  listReviewItemsWithSource,
  ReviewListQuerySchema,
  REVIEW_PAGE_SIZE,
} from '@/lib/rag/feedback-loop/review-access';
import { pgliteClient } from '../../helpers/pglite-rest-client';

type Row = Record<string, unknown>;

const EXPERT_A = '00000000-0000-4000-8000-0000000547a1';
const EXPERT_B = '00000000-0000-4000-8000-0000000547b1';
const TENANT_A = 'o:00000000-0000-4000-8000-0000000547f1';
const TENANT_B = 'o:00000000-0000-4000-8000-0000000547f2';

let db: PGlite;
let calls: string[];

function clients(userId: string | null) {
  calls = [];
  return {
    ssr: pgliteClient(db, { role: 'authenticated', userId, label: 'ssr', calls }) as unknown as SupabaseClient,
    admin: pgliteClient(db, { role: 'service_role', label: 'admin', calls }) as unknown as SupabaseClient,
  };
}

async function insertItem(row: Row = {}): Promise<string> {
  const values: Row = {
    tenant_key: TENANT_A,
    trace_id: crypto.randomUUID(),
    query_masked: 'A synthetic question about the sample topic',
    query_fingerprint: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
    channel: 'chat',
    outcome: 'answered',
    reasons: ['low_score'],
    mining_window: '2026-11-23T00:00:00Z',
    ...row,
  };
  const names = Object.keys(values);
  const result = await db.query<{ id: string }>(
    `INSERT INTO rag_review_items (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    names.map((name) => values[name]),
  );
  return result.rows[0].id;
}

/** An item as 0967's enqueue writes it: no trace, no channel, a Phase 5.3 reason, and its strata row. */
async function enqueued(source: string, tenantKey = TENANT_A, over: Row = {}): Promise<string> {
  const id = await insertItem({
    tenant_key: tenantKey,
    trace_id: null,
    channel: null,
    outcome: null,
    reasons: ['representative'],
    ...over,
  });
  await db.query('INSERT INTO rag_review_item_strata (review_item_id, tenant_key, source, stratum, sampling_weight) VALUES ($1, $2, $3, $4, $5)', [
    id,
    tenantKey,
    source,
    'cluster:1|en|chat',
    1,
  ]);
  return id;
}

beforeAll(async () => {
  db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
  for (const id of [EXPERT_A, EXPERT_B]) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(-4)}@example.invalid`]);
  }
  await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2), ($3, $4)', [TENANT_A, EXPERT_A, TENANT_B, EXPERT_B]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.query('DELETE FROM rag_review_items');
  calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('source on review item reads', () => {
  it('list: historical for an imported item, pilot for a sampled pilot item, null for a mined item', async () => {
    const mined = await insertItem({ mined_at: '2026-11-20T00:00:00Z' });
    const imported = await enqueued('historical', TENANT_A, { mined_at: '2026-11-21T00:00:00Z' });
    const pilot = await enqueued('pilot', TENANT_A, { mined_at: '2026-11-22T00:00:00Z', reasons: ['re_review'] });
    const { ssr, admin } = clients(EXPERT_A);
    const result = await listReviewItemsWithSource(ssr, admin, {});
    if (!result.ok) throw new Error('expected items');
    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect(result.items.map((item) => item.id)).toEqual([pilot, imported, mined]);
    expect(byId.get(imported)?.source).toBe('historical');
    expect(byId.get(pilot)?.source).toBe('pilot');
    expect(byId.get(pilot)?.reasons).toEqual(['re_review']);
    expect(byId.get(mined)?.source).toBeNull();
    for (const item of result.items) expect(ReviewItemSchema.safeParse(item).success).toBe(true);
    expect(calls[0]).toBe('ssr:rag_review_items');
    expect(calls.filter((c) => c.startsWith('admin:'))).toEqual(['admin:rag_review_item_strata']);
  });

  it('item: an imported item without trace or channel is returned with its source; a mined item with null', async () => {
    const imported = await enqueued('historical');
    const mined = await insertItem();
    const { ssr, admin } = clients(EXPERT_A);
    const one = await getReviewItemWithSource(ssr, admin, imported);
    expect(one.ok && one.item).toMatchObject({ id: imported, source: 'historical', trace_id: null, channel: null, answer_masked: null });
    const two = await getReviewItemWithSource(ssr, admin, mined);
    expect(two.ok && two.item.source).toBeNull();
  });

  it("never returns another tenant's items or strata, and reads no strata when RLS shows nothing", async () => {
    await enqueued('historical', TENANT_B);
    const foreign = await enqueued('pilot', TENANT_B);
    const { ssr, admin } = clients(EXPERT_A);
    const list = await listReviewItemsWithSource(ssr, admin, {});
    expect(list.ok && list.items).toEqual([]);
    expect(calls.filter((c) => c.startsWith('admin:'))).toEqual([]);
    expect(await getReviewItemWithSource(ssr, admin, foreign)).toEqual({ ok: false, reason: 'not_found' });
    expect(calls.filter((c) => c.startsWith('admin:'))).toEqual([]);
  });

  it('the strata read is limited to the RLS-read ids and their tenant: a foreign-tenant row with a colliding id is ignored', async () => {
    const id = crypto.randomUUID();
    const item = { id, tenant_key: TENANT_A, source: null } as unknown as ReviewItem;
    const filters: Array<[string, unknown]> = [];
    const builder = {
      select: () => builder,
      in: (column: string, values: unknown) => {
        filters.push([`in:${column}`, values]);
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push([`eq:${column}`, value]);
        return builder;
      },
      then: (resolve: (value: unknown) => void) =>
        resolve({ data: [{ review_item_id: id, tenant_key: TENANT_B, source: 'historical' }], error: null }),
    };
    const admin = { from: (table: string) => (table === 'rag_review_item_strata' ? builder : null) } as unknown as SupabaseClient;
    const [out] = await attachReviewSources(admin, [item]);
    expect(out.source).toBeNull();
    expect(filters).toEqual([
      ['in:review_item_id', [id]],
      ['eq:tenant_key', TENANT_A],
    ]);
  });

  it('filters on source historical within the caller tenant and pages with a cursor', async () => {
    const imported: string[] = [];
    for (let i = 0; i < 3; i += 1) imported.push(await enqueued('historical', TENANT_A, { mined_at: `2026-11-1${i}T00:00:00Z` }));
    for (let i = 0; i < REVIEW_PAGE_SIZE + 5; i += 1) await insertItem({ mined_at: '2026-11-20T00:00:00Z' });
    await enqueued('historical', TENANT_B);
    const { ssr, admin } = clients(EXPERT_A);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await listReviewItemsWithSource(ssr, admin, { source: 'historical', ...(cursor ? { cursor } : {}) });
      if (!result.ok) throw new Error('expected a page');
      for (const item of result.items) {
        expect(item.source).toBe('historical');
        expect(item.tenant_key).toBe(TENANT_A);
        seen.push(item.id);
      }
      if (!result.next_cursor) break;
      cursor = result.next_cursor;
    }
    expect(seen.sort()).toEqual([...imported].sort());
  });

  it('the list query accepts the two Phase 5.3 reasons and the four sources, and nothing else', () => {
    for (const reason of ['representative', 're_review']) expect(ReviewListQuerySchema.safeParse({ reason }).success).toBe(true);
    for (const source of ['representative', 'pilot', 'drift_fill', 'historical']) expect(ReviewListQuerySchema.safeParse({ source }).success).toBe(true);
    expect(ReviewListQuerySchema.safeParse({ source: 'mined' }).success).toBe(false);
    expect(ReviewListQuerySchema.safeParse({ tenant_key: TENANT_B }).success).toBe(false);
  });
});
