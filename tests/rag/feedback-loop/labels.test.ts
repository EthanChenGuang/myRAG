import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LabelRequestSchema, normalizeQuoteText } from '@/lib/rag';
import { pgliteClient } from '../../helpers/pglite-rest-client';
import {
  CHUNK_A,
  CHUNK_A_IT,
  CHUNK_A_QUARANTINED,
  CHUNK_A_SUPERSEDED,
  CHUNK_A_ZH,
  DOC_A,
  DOC_A_QUARANTINED,
  EXPERT_A,
  TEXT_A,
  createReviewFixture,
} from '../../helpers/review-fixture';

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/feedback-loop/normalize-quotes.json', import.meta.url), 'utf8')) as {
  cases: Array<{ input: string; expected: string }>;
};

let db: PGlite;
let itemA: string;
const calls: string[] = [];
const session: { userId: string | null } = { userId: null };

function span(overrides: Record<string, unknown> = {}) {
  return { chunk_id: CHUNK_A, document_id: DOC_A, document_name: 'whatever.md', section: '', quote: 'the sample component restarts every night', ...overrides };
}

function label(overrides: Record<string, unknown> = {}) {
  return {
    answerable: true,
    category: 'general',
    language: 'en',
    expected_answer: 'It restarts every night.',
    evidence: [span()],
    triage: ['training'],
    ...overrides,
  };
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => pgliteClient(db, { role: 'authenticated', userId: session.userId, label: 'ssr', calls }),
  }));
  vi.doMock('@/lib/supabase', () => ({
    getSupabaseAdmin: () => pgliteClient(db, { role: 'service_role', label: 'admin', calls }),
    getSupabase: () => ({}),
  }));
  return import('@/app/api/rag/review/items/[id]/label/route');
}

const post = (id: string, body: unknown) =>
  new NextRequest(`http://localhost/api/rag/review/items/${id}/label`, { method: 'POST', body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function stored(id: string) {
  const { rows } = await db.query<{ status: string; triage: string[]; label: Record<string, unknown> | null; labelled_by: string | null; labelled_at: string | null }>(
    'SELECT status, triage, label, labelled_by::text AS labelled_by, labelled_at::text AS labelled_at FROM rag_review_items WHERE id = $1',
    [id],
  );
  return rows[0];
}

async function reset(id: string) {
  await db.query("UPDATE rag_review_items SET status = 'open', triage = '{}', label = NULL, labelled_by = NULL, labelled_at = NULL WHERE id = $1", [id]);
}

beforeAll(async () => {
  ({ db, itemA } = await createReviewFixture());
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  calls.length = 0;
  session.userId = EXPERT_A;
  vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'true');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await reset(itemA);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('normalizeQuoteText (TypeScript twin of eval normalize_text)', () => {
  it('equals the Python result on every shared fixture string', () => {
    expect(fixture.cases).toHaveLength(20);
    for (const entry of fixture.cases) expect(normalizeQuoteText(entry.input), JSON.stringify(entry.input)).toBe(entry.expected);
  });
});

describe('LabelRequestSchema (D-18 rules)', () => {
  it('accepts a labelled body and a skip', () => {
    expect(LabelRequestSchema.safeParse({ status: 'labelled', label: label() }).success).toBe(true);
    expect(LabelRequestSchema.safeParse({ status: 'skipped' }).success).toBe(true);
  });

  it('rejects golden triage without pii_checked, and accepts it with pii_checked', () => {
    expect(LabelRequestSchema.safeParse({ status: 'labelled', label: label({ triage: ['golden'] }) }).success).toBe(false);
    expect(LabelRequestSchema.safeParse({ status: 'labelled', label: label({ triage: ['golden'], pii_checked: true }) }).success).toBe(true);
  });

  it('applies the contract rules: evidence and answer when answerable, none when not, dictionary terms, distinct spans', () => {
    const bad = [
      label({ evidence: [] }),
      label({ expected_answer: '  ' }),
      label({ answerable: false, category: 'no_answer' }),
      label({ answerable: true, category: 'no_answer' }),
      label({ triage: ['dictionary'] }),
      label({ evidence: [span(), span()] }),
      label({ not_relevant_chunk_ids: [CHUNK_A] }),
    ];
    for (const entry of bad) expect(LabelRequestSchema.safeParse({ status: 'labelled', label: entry }).success, JSON.stringify(entry)).toBe(false);
    expect(
      LabelRequestSchema.safeParse({ status: 'labelled', label: label({ answerable: false, category: 'no_answer', evidence: [], expected_answer: null }) }).success,
    ).toBe(true);
  });

  it('rejects exported or open as a client status, unknown keys and a tenant key in the body', () => {
    for (const body of [
      { status: 'exported', label: label() },
      { status: 'open' },
      { status: 'skipped', tenant_key: 's:default' },
      { status: 'labelled', label: { ...label(), extra: true } },
    ]) {
      expect(LabelRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('POST /api/rag/review/items/{id}/label', () => {
  it('stores a label whose quote is in the chunk after normalisation, with names from the database and labelled_by from the trigger', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { POST } = await loadRoute();
    const body = {
      status: 'labelled',
      label: label({
        evidence: [
          span({ quote: 'THE SAMPLE component   restarts, every night!' }),
          span({ chunk_id: CHUNK_A_ZH, quote: '示例组件每天晚上重新启动,并写入日志' }),
          span({ chunk_id: CHUNK_A_IT, quote: 'Il componente di esempio È riavviato ogni notte' }),
        ],
      }),
    };
    const res = await POST(post(itemA, body), params(itemA));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ item_id: itemA, status: 'labelled', triage: ['training'] });
    expect(JSON.stringify(json)).not.toContain(TEXT_A);

    const row = await stored(itemA);
    expect(row.status).toBe('labelled');
    expect(row.triage).toEqual(['training']);
    expect(row.labelled_by).toBe(EXPERT_A);
    expect(row.labelled_at).not.toBeNull();
    const evidence = (row.label as { evidence: Array<Record<string, unknown>> }).evidence;
    expect(evidence[0]).toMatchObject({ chunk_id: CHUNK_A, document_id: DOC_A, document_name: 'alpha-guide.md', section: 'Part one > Detail' });

    const lines = log.mock.calls.filter((args) => args[0] === '[Review] label');
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual({ expert: EXPERT_A, item: expect.stringMatching(/^[0-9a-f]{16}$/), status: 'labelled', triage: ['training'] });
    expect(JSON.stringify(log.mock.calls)).not.toContain(TEXT_A);
    expect(JSON.stringify(log.mock.calls)).not.toContain(itemA);
  });

  it('answers 400 quote_not_found with the span index for a quote that differs by one word, without chunk text, and stores nothing', async () => {
    const { POST } = await loadRoute();
    const body = { status: 'labelled', label: label({ evidence: [span(), span({ quote: 'the sample component restarts every morning' })] }) };
    const res = await POST(post(itemA, body), params(itemA));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: 'invalid_evidence', span: 1, reason: 'quote_not_found' });
    expect((await stored(itemA)).status).toBe('open');
  });

  it('rejects quarantined, superseded and mismatched-document evidence with its own reason', async () => {
    const { POST } = await loadRoute();
    const cases: Array<[Record<string, unknown>, string]> = [
      [span({ chunk_id: CHUNK_A_QUARANTINED, document_id: DOC_A_QUARANTINED, quote: 'quarantined sentence' }), 'chunk_not_servable'],
      [span({ chunk_id: CHUNK_A_SUPERSEDED, quote: 'superseded sentence' }), 'chunk_not_servable'],
      [span({ document_id: DOC_A_QUARANTINED }), 'document_mismatch'],
      [span({ chunk_id: '00000000-0000-4000-8000-00000000ffff' }), 'chunk_not_in_tenant'],
      [span({ chunk_id: 'not-a-uuid' }), 'chunk_not_in_tenant'],
      [span({ quote: '...' }), 'quote_empty'],
    ];
    for (const [evidence, reason] of cases) {
      const res = await POST(post(itemA, { status: 'labelled', label: label({ evidence: [evidence] }) }), params(itemA));
      expect(res.status, reason).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_evidence', span: 0, reason });
    }
    expect((await stored(itemA)).status).toBe('open');
  });

  it('rejects not-relevant ids that are not in the snapshot', async () => {
    const { POST } = await loadRoute();
    const res = await POST(post(itemA, { status: 'labelled', label: label({ not_relevant_chunk_ids: [CHUNK_A_IT, CHUNK_A_SUPERSEDED] }) }), params(itemA));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_not_relevant', index: 1, reason: 'not_in_snapshot' });
  });

  it('replaces an earlier label (latest wins) and clears it on skip', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { POST } = await loadRoute();
    expect((await POST(post(itemA, { status: 'labelled', label: label() }), params(itemA))).status).toBe(200);
    const second = label({ triage: ['kb_gap'], expected_answer: 'A second answer.' });
    expect((await POST(post(itemA, { status: 'labelled', label: second }), params(itemA))).status).toBe(200);
    let row = await stored(itemA);
    expect(row.triage).toEqual(['kb_gap']);
    expect(row.label).toMatchObject({ expected_answer: 'A second answer.', triage: ['kb_gap'] });

    expect((await POST(post(itemA, { status: 'skipped' }), params(itemA))).status).toBe(200);
    row = await stored(itemA);
    expect(row).toMatchObject({ status: 'skipped', triage: [], label: null, labelled_by: EXPERT_A });
  });

  it('answers 409 for an exported item and leaves it unchanged', async () => {
    await db.query("UPDATE rag_review_items SET status = 'exported' WHERE id = $1", [itemA]);
    const { POST } = await loadRoute();
    const res = await POST(post(itemA, { status: 'labelled', label: label() }), params(itemA));
    expect(res.status).toBe(409);
    expect((await stored(itemA)).status).toBe('exported');
  });

  it('answers 400 for a schema violation, 404 with the switch off and 401 without a session', async () => {
    const { POST } = await loadRoute();
    const invalid = await POST(post(itemA, { status: 'labelled', label: label({ triage: ['golden'] }) }), params(itemA));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).success).toBe(false);
    session.userId = null;
    expect((await POST(post(itemA, { status: 'skipped' }), params(itemA))).status).toBe(401);
    vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'false');
    session.userId = EXPERT_A;
    calls.length = 0;
    expect((await POST(post(itemA, { status: 'skipped' }), params(itemA))).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
