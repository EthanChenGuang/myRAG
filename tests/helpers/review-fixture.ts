import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

/** Two personal tenants with one granted expert each, synthetic documents and one review item per tenant (multi-tenant PGlite). */

export const OWNER_A = '00000000-0000-4000-8000-0000000071a0';
export const OWNER_B = '00000000-0000-4000-8000-0000000071b0';
export const EXPERT_A = '00000000-0000-4000-8000-0000000071a1';
export const EXPERT_B = '00000000-0000-4000-8000-0000000071b1';
export const TENANT_A = `u:${OWNER_A}`;
export const TENANT_B = `u:${OWNER_B}`;

export const DOC_A = '00000000-0000-4000-8000-0000000071d1';
export const DOC_A_QUARANTINED = '00000000-0000-4000-8000-0000000071d2';
export const DOC_A_MANY = '00000000-0000-4000-8000-0000000071d4';
export const DOC_B = '00000000-0000-4000-8000-0000000071d3';
export const CHUNK_A = '00000000-0000-4000-8000-0000000071e1';
export const CHUNK_A_ZH = '00000000-0000-4000-8000-0000000071e5';
export const CHUNK_A_IT = '00000000-0000-4000-8000-0000000071e6';
export const CHUNK_A_QUARANTINED = '00000000-0000-4000-8000-0000000071e2';
export const CHUNK_A_SUPERSEDED = '00000000-0000-4000-8000-0000000071e3';
export const CHUNK_B = '00000000-0000-4000-8000-0000000071e4';

export const TEXT_A = 'Tenant alpha evidence sentence: the sample component restarts every night.';
export const TEXT_A_ZH = '示例组件每天晚上重新启动，并写入日志。';
export const TEXT_A_IT = 'Il componente di esempio è riavviato ogni notte, però non sempre.';
export const TEXT_A_QUARANTINED = 'Tenant alpha quarantined sentence that must stay hidden.';
export const TEXT_A_SUPERSEDED = 'Tenant alpha superseded sentence from an older version.';
export const TEXT_B = 'Tenant bravo private sentence that tenant alpha must never read.';

export const MANY_A_CHUNKS = Array.from({ length: 35 }, (_, index) => `00000000-0000-4000-8000-0000000072${String(index).padStart(2, '0')}`);

export function candidate(chunkId: string, documentId: string, rank: number) {
  return { chunk_id: chunkId, document_id: documentId, rank, similarity: 0.5, kept: rank === 1 };
}

export async function insertReviewItem(db: PGlite, tenantKey: string, candidates: unknown[]): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO rag_review_items (tenant_key, trace_id, query_masked, query_fingerprint, channel, outcome, reasons, candidates, mining_window)
     VALUES ($1, $2, $3, $4, 'chat', 'answered', ARRAY['low_score'], $5::jsonb, '2026-11-23T00:00:00Z') RETURNING id`,
    [tenantKey, crypto.randomUUID(), 'A synthetic question', crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'), JSON.stringify(candidates)],
  );
  return result.rows[0].id;
}

export interface ReviewFixture {
  db: PGlite;
  itemA: string;
  itemB: string;
}

export async function createReviewFixture(): Promise<ReviewFixture> {
  const db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
  for (const id of [OWNER_A, OWNER_B, EXPERT_A, EXPERT_B]) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(-4)}@example.invalid`]);
  }
  await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2), ($3, $4)', [TENANT_A, EXPERT_A, TENANT_B, EXPERT_B]);
  for (const [id, owner, name] of [
    [DOC_A, OWNER_A, 'alpha-guide.md'],
    [DOC_A_QUARANTINED, OWNER_A, 'alpha-quarantined.md'],
    [DOC_A_MANY, OWNER_A, 'alpha-many.md'],
    [DOC_B, OWNER_B, 'bravo-private.md'],
  ]) {
    await db.query('INSERT INTO documents (id, filename, content, user_id) VALUES ($1, $2, $3, $4)', [id, name, 'body', owner]);
  }
  const chunks: Array<[string, string, string]> = [
    [CHUNK_A, DOC_A, TEXT_A],
    [CHUNK_A_ZH, DOC_A, TEXT_A_ZH],
    [CHUNK_A_IT, DOC_A, TEXT_A_IT],
    [CHUNK_A_QUARANTINED, DOC_A_QUARANTINED, TEXT_A_QUARANTINED],
    [CHUNK_A_SUPERSEDED, DOC_A, TEXT_A_SUPERSEDED],
    [CHUNK_B, DOC_B, TEXT_B],
    ...MANY_A_CHUNKS.map((id, index): [string, string, string] => [id, DOC_A_MANY, `Tenant alpha filler sentence number ${index}.`]),
  ];
  for (const [id, doc, text] of chunks) {
    await db.query("INSERT INTO document_chunks (id, document_id, content, section_path) VALUES ($1, $2, $3, ARRAY['Part one', 'Detail'])", [id, doc, text]);
  }
  await db.query("UPDATE documents SET status = 'quarantined' WHERE id = $1", [DOC_A_QUARANTINED]);
  await db.query("UPDATE document_chunks SET status = 'quarantined' WHERE document_id = $1", [DOC_A_QUARANTINED]);
  await db.query('UPDATE document_chunks SET is_current = false WHERE id = $1', [CHUNK_A_SUPERSEDED]);

  const itemA = await insertReviewItem(db, TENANT_A, [candidate(CHUNK_A, DOC_A, 1), candidate(CHUNK_A_ZH, DOC_A, 2), candidate(CHUNK_A_IT, DOC_A, 3)]);
  const itemB = await insertReviewItem(db, TENANT_B, [candidate(CHUNK_B, DOC_B, 1)]);
  return { db, itemA, itemB };
}
