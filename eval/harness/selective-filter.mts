import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from './fixture-embedder.mts';
import { createEmptyFixtureDatabase, type EmptyFixtureDatabase } from './pglite-supabase.mts';

export const SELECTIVE_IDS = {
  bigUser: '00000000-0000-4000-8000-0000000000b1',
  smallUser: '00000000-0000-4000-8000-0000000000c1',
  bigDoc: '00000000-0000-4000-8000-0000000000d1',
  smallDoc: '00000000-0000-4000-8000-0000000000d2',
  rareDocType: 'scanned_image',
} as const;

export const SELECTIVE_PROFILE = 'openai-3-small-1536';
export const SELECTIVE_QUERY_TEXT = 'selective filter retrieval eval anchor phrase';
const DIMENSIONS = 1536;
const CURRENT_CHUNKS = 600;
const SMALL_CURRENT = 18;
const RARE_TYPE_ROWS = 18;
const SUPERSEDED_ROWS = 20;
const CHUNK_INSERT_BATCH = 62;
const CREATED_AT = '2025-02-01T00:00:00.000Z';

interface ChunkInsertRow {
  id: string;
  documentId: string;
  content: string;
  embedding: string;
  chunkIndex: number;
  tenantKey: string;
  docType: string;
  isCurrent: boolean;
}

export type SelectiveFixtureDatabase = EmptyFixtureDatabase;

export type SelectiveScanMode = 'off' | 'relaxed_order' | 'strict_order' | 'exact';

export interface SelectiveModeMetrics {
  rows: number;
  recall_at_k: number;
  k: number;
}

export type SelectiveFilterReport = Record<SelectiveScanMode, SelectiveModeMetrics>;

export interface SelectiveMeasurementSlice {
  small_tenant: SelectiveFilterReport;
  rare_doc_type: SelectiveFilterReport;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unitVector(seed: number): number[] {
  const rng = mulberry32(seed);
  const raw = Array.from({ length: DIMENSIONS }, () => rng() * 2 - 1);
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}




function chunkIdForSeed(seed: number): string {
  const suffix = (BigInt(seed) + 0x100000000000n).toString(16).padStart(12, '0').slice(-12);
  return `00000000-0000-4000-8000-${suffix}`;
}

function vectorLiteral(values: number[]): string {
  return `[${values.map((value) => (Number.isFinite(value) ? value : 0)).join(',')}]`;
}

function planChunkRow(
  seed: number,
  documentId: string,
  tenantKey: string,
  docType: string,
  isCurrent: boolean,
  smallTenantKey: string,
  rareDocType: string,
): ChunkInsertRow {
  const vectorSeed = tenantKey === smallTenantKey || docType === rareDocType ? seed + 1_000 : seed + 40_000;
  return {
    id: chunkIdForSeed(seed),
    documentId,
    content: `selective chunk seed ${seed} tenant ${tenantKey} type ${docType}`,
    embedding: vectorLiteral(unitVector(vectorSeed)),
    chunkIndex: seed,
    tenantKey,
    docType,
    isCurrent,
  };
}

async function insertChunkBatch(db: PGlite, rows: ChunkInsertRow[]): Promise<void> {
  if (rows.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const base = i * 9;
    const row = rows[i]!;
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::vector, $${base + 5}, '{}'::jsonb, $${base + 6}, $${base + 7}, $${base + 8}, 'ready', 'legacy', $${base + 9})`,
    );
    params.push(
      row.id,
      row.documentId,
      row.content,
      row.embedding,
      row.chunkIndex,
      row.tenantKey,
      row.docType,
      row.isCurrent,
      CREATED_AT,
    );
  }
  await db.query(
    `INSERT INTO document_chunks (
       id, document_id, content, embedding, chunk_index, metadata,
       tenant_key, doc_type, is_current, status, chunking_profile_id, created_at
     ) VALUES ${values.join(', ')}`,
    params,
  );
}

async function insertChunkRows(db: PGlite, rows: ChunkInsertRow[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += CHUNK_INSERT_BATCH) {
    await insertChunkBatch(db, rows.slice(offset, offset + CHUNK_INSERT_BATCH));
  }
}

export function selectiveQueryVectorLiteral(): string {
  return vectorLiteral(embedText(SELECTIVE_QUERY_TEXT));
}

export interface ExactRankingOptions {
  tenantKey: string;
  docTypes?: string[] | null;
  limit: number;
  queryVector?: string;
}

/** Brute-force cosine ranking over matching rows (no index hint). */
export async function exactFilteredRanking(db: PGlite, options: ExactRankingOptions): Promise<string[]> {
  const query = options.queryVector ?? selectiveQueryVectorLiteral();
  const result = await db.query<{ id: string }>(
    `SELECT c.id::text
     FROM document_chunks c
     WHERE c.tenant_key = $1
       AND c.is_current
       AND c.status IN ('ready', 'variant')
       AND c.embedding IS NOT NULL
       AND ($2::text[] IS NULL OR c.doc_type = ANY($2))
     ORDER BY c.embedding <=> $3::vector
     LIMIT $4`,
    [options.tenantKey, options.docTypes ?? null, query, options.limit],
  );
  return result.rows.map((row) => row.id);
}

export async function exactHybridTopK(
  db: PGlite,
  options: Omit<DenseSearchArgs, 'iterativeScan' | 'exactCutoff'> & { exactCutoff?: number },
): Promise<string[]> {
  const exactCutoff = options.exactCutoff ?? 1000;
  const search = await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    return hybridDenseIds(tx as unknown as PGlite, {
      tenantKey: options.tenantKey,
      docTypes: options.docTypes ?? null,
      iterativeScan: 'exact',
      exactCutoff,
      k: options.k,
      queryVector: options.queryVector,
    });
  });
  return search.ids;
}

function recallAtK(exact: string[], got: string[], k: number): number {
  const exactTop = new Set(exact.slice(0, k));
  if (exactTop.size === 0) return got.length === 0 ? 1 : 0;
  let hit = 0;
  for (const id of got.slice(0, k)) {
    if (exactTop.has(id)) hit += 1;
  }
  return hit / k;
}

interface DenseSearchArgs {
  tenantKey: string;
  docTypes?: string[] | null;
  iterativeScan: SelectiveScanMode | 'exact';
  exactCutoff: number;
  k: number;
  queryVector?: string;
}

async function hybridDenseIds(db: PGlite, args: DenseSearchArgs): Promise<{ ids: string[]; denseMode: string | null }> {
  const query = args.queryVector ?? selectiveQueryVectorLiteral();
  const iterative =
    args.iterativeScan === 'exact' ? 'off' : args.iterativeScan;
  const cutoff = args.iterativeScan === 'exact' ? args.exactCutoff : 0;

  await db.exec('SET LOCAL enable_seqscan = off');
  await db.exec('SET LOCAL enable_bitmapscan = off');
  try {
    const rows = await db.query<{ chunk_id: string; dense_mode: string | null }>(
      `SELECT chunk_id::text, dense_mode
       FROM hybrid_search_chunks(
         p_tenant_key => $1,
         p_profile_id => $2,
         p_query_embedding => $3::vector,
         p_lexical_tokens => '{}'::text[],
         p_dense_limit => $4,
         p_lexical_limit => 0,
         p_doc_types => $5,
         p_iterative_scan => $6,
         p_exact_scan_cutoff => $7
       )
       WHERE leg = 'dense'
       ORDER BY rank`,
      [
        args.tenantKey,
        SELECTIVE_PROFILE,
        query,
        args.k,
        args.docTypes ?? null,
        iterative,
        cutoff,
      ],
    );
    return {
      ids: rows.rows.map((row) => row.chunk_id),
      denseMode: rows.rows[0]?.dense_mode ?? null,
    };
  } finally {
    await db.exec('RESET enable_seqscan');
    await db.exec('RESET enable_bitmapscan');
  }
}

export interface MeasureSelectiveFilterOptions {
  k?: number;
  exactCutoff?: number;
  queryVector?: string;
}

export async function measureSelectiveFilter(
  db: PGlite,
  options: MeasureSelectiveFilterOptions = {},
): Promise<SelectiveMeasurementSlice> {
  const k = options.k ?? 10;
  const exactCutoff = options.exactCutoff ?? 1000;
  const smallKey = `u:${SELECTIVE_IDS.smallUser}`;
  const bigKey = `u:${SELECTIVE_IDS.bigUser}`;
  const rareTypes = [SELECTIVE_IDS.rareDocType];

  async function slice(tenantKey: string, docTypes: string[] | null): Promise<SelectiveFilterReport> {
    const exactIds = await exactHybridTopK(db, { tenantKey, docTypes, k, queryVector: options.queryVector, exactCutoff });
    const modes: SelectiveScanMode[] = ['off', 'relaxed_order', 'strict_order', 'exact'];
    const report = {} as SelectiveFilterReport;
    for (const mode of modes) {
      const search = await db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE service_role');
        if (mode === 'exact') {
          return hybridDenseIds(tx as unknown as PGlite, {
            tenantKey,
            docTypes,
            iterativeScan: 'exact',
            exactCutoff,
            k,
            queryVector: options.queryVector,
          });
        }
        return hybridDenseIds(tx as unknown as PGlite, {
          tenantKey,
          docTypes,
          iterativeScan: mode,
          exactCutoff: 0,
          k,
          queryVector: options.queryVector,
        });
      });
      report[mode] = {
        rows: search.ids.length,
        recall_at_k: recallAtK(exactIds, search.ids, k),
        k,
      };
    }
    return report;
  }

  return {
    small_tenant: await slice(smallKey, null),
    rare_doc_type: await slice(bigKey, rareTypes),
  };
}

export async function createSelectiveFilterDatabase(): Promise<SelectiveFixtureDatabase> {
  const started = Date.now();
  const fixture = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', supabaseGrants: true });
  const { db } = fixture;
  const ids = SELECTIVE_IDS;
  const bigKey = `u:${ids.bigUser}`;
  const smallKey = `u:${ids.smallUser}`;

  try {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [
      ids.bigUser,
      'selective-big@example.invalid',
      ids.smallUser,
      'selective-small@example.invalid',
    ]);

    await db.exec(`
      DROP INDEX IF EXISTS idx_document_chunks_embedding;
      DROP INDEX IF EXISTS idx_document_chunks_organization_id;
      DROP INDEX IF EXISTS idx_document_chunks_document_id;
      DROP INDEX IF EXISTS idx_chunks_org_embedding;
      DROP INDEX IF EXISTS idx_document_chunks_document_chunk_index;
      DROP INDEX IF EXISTS idx_document_chunks_lexical_tsv;
      DROP INDEX IF EXISTS idx_document_chunks_lexical_version;
      DROP INDEX IF EXISTS idx_document_chunks_parent_id;
      DROP INDEX IF EXISTS idx_document_chunks_tenant_key;
      DROP INDEX IF EXISTS idx_document_chunks_document_profile;
    `);

    await db.query(
      `INSERT INTO documents (id, filename, content, user_id, is_current, status, doc_type, created_at)
       VALUES ($1, $2, $3, $4, true, 'ready', 'general', $5), ($6, $7, $8, $9, true, 'ready', 'general', $5)`,
      [
        ids.bigDoc,
        'big-tenant.md',
        'synthetic big tenant corpus',
        ids.bigUser,
        CREATED_AT,
        ids.smallDoc,
        'small-tenant.md',
        'synthetic small tenant corpus',
        ids.smallUser,
      ],
    );

    const planned: ChunkInsertRow[] = [];
    const bigTotal = CURRENT_CHUNKS - SMALL_CURRENT;
    for (let i = 0; i < bigTotal - RARE_TYPE_ROWS; i += 1) {
      const seed = 10_000 + i;
      planned.push(planChunkRow(seed, ids.bigDoc, bigKey, 'general', true, smallKey, ids.rareDocType));
    }
    for (let i = 0; i < RARE_TYPE_ROWS; i += 1) {
      const seed = 15_000 + i;
      planned.push(planChunkRow(seed, ids.bigDoc, bigKey, ids.rareDocType, true, smallKey, ids.rareDocType));
    }
    for (let i = 0; i < SMALL_CURRENT; i += 1) {
      const seed = 20_000 + i;
      planned.push(planChunkRow(seed, ids.smallDoc, smallKey, 'general', true, smallKey, ids.rareDocType));
    }
    for (let i = 0; i < SUPERSEDED_ROWS; i += 1) {
      const seed = 90_000 + i;
      planned.push(planChunkRow(seed, ids.smallDoc, smallKey, 'general', false, smallKey, ids.rareDocType));
    }
    await db.transaction(async (tx) => {
      await insertChunkRows(tx as unknown as PGlite, planned);
    });

    await db.exec(
      `CREATE INDEX idx_document_chunks_embedding ON document_chunks
         USING hnsw (embedding vector_cosine_ops)
         WITH (m = 64, ef_construction = 200);
       ANALYZE document_chunks`,
    );
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }

  if (Date.now() - started > 15_000) {
    throw new Error(`[Selective Filter] database build exceeded 15s (${Date.now() - started}ms)`);
  }

  return fixture;
}

export async function writeSelectiveFilterReport(outputPath: string, report: SelectiveMeasurementSlice): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

const entry = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) === path.resolve(entry) : false;

if (invoked) {
  const reportFlag = process.argv.indexOf('--report');
  if (reportFlag >= 0) {
    const outPath = process.argv[reportFlag + 1];
    if (!outPath) {
      console.error('Usage: node --import tsx eval/harness/selective-filter.mts --report <path>');
      process.exit(1);
    }
    const fixture = await createSelectiveFilterDatabase();
    try {
      await fixture.db.exec('SET enable_seqscan = off');
      await fixture.db.exec('SET enable_bitmapscan = off');
      const report = await measureSelectiveFilter(fixture.db);
      await writeSelectiveFilterReport(path.resolve(outPath), report);
    } finally {
      await fixture.db.close();
    }
  }
}