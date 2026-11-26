import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { contentHash } from '@/lib/rag/ingest/hash';
import type { TenantScope } from '@/lib/rag/tenant/scope';

type Row = Record<string, unknown>;

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const MIGRATION = 'supabase/migrations/0857_dup_cluster_functions.sql';
const COPIES = 30;
const THRESHOLD = 0.95;
const DUP_FUNCTIONS = [
  'rag_dup_write_hashes',
  'rag_dup_candidates',
  'rag_dup_assign',
  'rag_dup_clusters_recompute',
  'rag_dup_backfill_candidates',
] as const;

/**
 * The synthetic fixture (D-20): one passage of invented words pasted with small surface variations into 30 generated documents, each
 * document also holding a unique paragraph. Nothing is committed: every text comes from these generators.
 */
const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'su', 'ta', 'vo', 'ri', 'pe', 'du', 'zo', 'fa', 'gi', 'ho', 'ju', 'be', 'qa', 'wy'];

function inventedWord(seed: number): string {
  let n = (seed * 2654435761) >>> 0;
  let out = '';
  for (let i = 0; i < 3; i += 1) {
    out += SYLLABLES[n % SYLLABLES.length];
    n = Math.floor(n / SYLLABLES.length) + 11 * (i + 1);
  }
  return `${out}${seed % 89}`;
}

const SHARED_WORDS = Array.from({ length: 80 }, (_, i) => inventedWord(10_000 + i));
const VARIANT_SLOTS = [7, 33, 61];

/** Copy `copy` of the shared passage: up to two of three slots get a substitute word, and every fifth copy changes case and adds a full stop. */
export function sharedPassage(copy: number): string {
  const words = SHARED_WORDS.slice();
  const slot = VARIANT_SLOTS[copy % VARIANT_SLOTS.length] as number;
  if (copy > 0) words[slot] = inventedWord(20_000 + copy);
  if (copy % 4 === 3) words[VARIANT_SLOTS[(copy + 1) % VARIANT_SLOTS.length] as number] = inventedWord(30_000 + copy);
  let text = words.join(' ');
  if (copy % 5 === 4) text = `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  return text;
}

export function uniqueParagraph(tenantIndex: number, copy: number): string {
  return Array.from({ length: 40 }, (_, i) => inventedWord(100_000 + tenantIndex * 10_000 + copy * 100 + i)).join(' ');
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : '';
}

/** Service-role PostgREST stand-in over PGlite: named arguments, rows back, errors with their SQLSTATE. */
function serviceRpc(db: PGlite, calls: string[] = []): RpcClient {
  return {
    rpc(fn, args) {
      calls.push(fn);
      const keys = Object.keys(args);
      const sql = `SELECT * FROM public.${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const values = keys.map((key) => {
        const value = args[key];
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value;
      });
      const run = db
        .transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          return (await tx.query<Row>(sql, values)).rows;
        })
        .then((rows): RpcResponse => ({ data: rows as unknown[], error: null }))
        .catch((error: unknown): RpcResponse => ({
          data: null,
          error: { code: sqlState(error) || 'P0001', message: error instanceof Error ? error.message : String(error) },
        }));
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

interface Tenant {
  label: string;
  index: number;
  key: string;
  userId: string | null;
  scope: () => TenantScope;
}

interface SeedChunk {
  id: string;
  content: string;
  embeddingText?: string;
  status?: string;
  isCurrent?: boolean;
  chunkingProfileId?: string;
}

let sequence = 0;
function uuid(prefix: string): string {
  sequence += 1;
  return `${prefix}-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

async function insertDocument(
  db: PGlite,
  mode: DeploymentMode,
  tenant: Tenant,
  options: { filename: string; status?: string; isCurrent?: boolean },
): Promise<string> {
  const id = uuid('0d000000');
  const columns = ['id', 'filename', 'content', 'status', 'is_current', 'lineage_id'];
  const values: unknown[] = [id, options.filename, '', options.status ?? 'ready', options.isCurrent ?? true, id];
  if (mode === 'multi-tenant') {
    columns.push('user_id');
    values.push(tenant.userId);
  }
  await db.query(`INSERT INTO documents (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, values);
  return id;
}

async function insertChunks(db: PGlite, documentId: string, chunks: SeedChunk[]): Promise<void> {
  let index = 0;
  for (const chunk of chunks) {
    await db.query(
      `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, content_hash, status, is_current, chunking_profile_id)
       VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9)`,
      [
        chunk.id,
        documentId,
        chunk.content,
        vectorLiteral(embedText(chunk.embeddingText ?? chunk.content)),
        index,
        contentHash(chunk.content),
        chunk.status ?? 'ready',
        chunk.isCurrent ?? true,
        chunk.chunkingProfileId ?? 'legacy',
      ],
    );
    index += 1;
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];

for (const mode of MODES) {
  describe(`duplicate clusters (${mode}): SimHash, candidates, assignment (D-18, D-19, D-49, D-56)`, () => {
    let db: PGlite;
    let cluster: typeof import('@/lib/rag/dedupe/cluster');
    let simhash: typeof import('@/lib/rag/dedupe/simhash');
    let scopeModule: typeof import('@/lib/rag/tenant/scope');
    let rpc: RpcClient;
    let tenants: Tenant[];
    const seeded = new Map<string, { shared: string[]; unique: string[]; documents: string[] }>();

    const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query<Row>(sql, params)).rows;

    before(async () => {
      db = mode === 'multi-tenant' ? (await createTwoTenantDatabase()).db : (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
      cluster = await import('@/lib/rag/dedupe/cluster');
      simhash = await import('@/lib/rag/dedupe/simhash');
      scopeModule = await import('@/lib/rag/tenant/scope');
      rpc = serviceRpc(db);
      tenants =
        mode === 'multi-tenant'
          ? [
              { label: 'A', index: 0, key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA, scope: () => scopeModule.mintScope('personal', TWO_TENANT_IDS.userA, null) },
              { label: 'B', index: 1, key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB, scope: () => scopeModule.mintScope('personal', TWO_TENANT_IDS.userB, null) },
            ]
          : [{ label: 'S', index: 0, key: 's:default', userId: null, scope: () => scopeModule.mintScope('single', null, null) }];

      for (const tenant of tenants) {
        const entry = { shared: [] as string[], unique: [] as string[], documents: [] as string[] };
        for (let copy = 0; copy < COPIES; copy += 1) {
          const documentId = await insertDocument(db, mode, tenant, { filename: `generated-${tenant.label}-${copy}.md` });
          const sharedId = uuid('0c000000');
          const uniqueId = uuid('0c000000');
          await insertChunks(db, documentId, [
            { id: sharedId, content: sharedPassage(copy) },
            { id: uniqueId, content: uniqueParagraph(tenant.index, copy) },
          ]);
          entry.shared.push(sharedId);
          entry.unique.push(uniqueId);
          entry.documents.push(documentId);
        }
        seeded.set(tenant.key, entry);
      }
    });

    after(async () => {
      await db?.close();
    });

    test('the 30 generated copies are near duplicates under the fixture embedder (cosine at or above 0.95)', () => {
      const vectors = Array.from({ length: COPIES }, (_, copy) => embedText(sharedPassage(copy)));
      let min = 1;
      for (let i = 0; i < COPIES; i += 1) for (let j = i + 1; j < COPIES; j += 1) min = Math.min(min, cosine(vectors[i] as number[], vectors[j] as number[]));
      console.log('[Dup Clusters Test] fixture cosine minimum', { min: Number(min.toFixed(4)) });
      assert.ok(min >= THRESHOLD, `minimum pairwise cosine ${min} is below ${THRESHOLD}`);
    });

    test('the SQL band split equals simhashBands for a value above 2^53', async () => {
      const tenant = tenants[0] as Tenant;
      const chunkId = (seeded.get(tenant.key) as { unique: string[] }).unique[0] as string;
      const value = (1n << 63n) + (1n << 54n) + 0xa5n;
      const written = await rpc.rpc('rag_dup_write_hashes', { p_tenant_key: tenant.key, p_rows: [{ id: chunkId, simhash: simhash.toInt64String(value) }] });
      assert.equal(written.error, null, JSON.stringify(written.error));
      const [stored] = await rows('SELECT simhash::text AS h FROM document_chunks WHERE id = $1', [chunkId]);
      assert.equal(simhash.fromInt64(String(stored?.h)), value);
      const bands = await rows('SELECT band, value FROM rag_dup_chunk_bands WHERE chunk_id = $1 ORDER BY band', [chunkId]);
      assert.deepEqual(
        bands.map((row) => Number(row.value)),
        simhash.simhashBands(value),
      );
      await db.query('UPDATE document_chunks SET simhash = NULL WHERE id = $1', [chunkId]);
      await db.query('DELETE FROM rag_dup_chunk_bands WHERE chunk_id = $1', [chunkId]);
    });

    test('one cluster per tenant with 30 members and 30 source documents; unique paragraphs stay unclustered', async () => {
      for (const tenant of tenants) {
        const entry = seeded.get(tenant.key) as { shared: string[]; unique: string[]; documents: string[] };
        const report = await cluster.clusterChunks(tenant.scope(), [...entry.shared, ...entry.unique], { db: rpc });
        assert.equal(report.hashed, COPIES * 2, `tenant ${tenant.label} hashed`);
      }
      for (const tenant of tenants) {
        const entry = seeded.get(tenant.key) as { shared: string[]; unique: string[]; documents: string[] };
        const clusters = await rows('SELECT * FROM rag_dup_clusters WHERE tenant_key = $1', [tenant.key]);
        assert.equal(clusters.length, 1, `tenant ${tenant.label} has ${clusters.length} clusters`);
        const [only] = clusters as [Row];
        assert.equal(Number(only.member_count), COPIES);
        const sources = (only.source_document_ids as string[]).slice().sort();
        assert.equal(new Set(sources).size, COPIES);
        assert.deepEqual(sources, entry.documents.slice().sort());
        assert.ok(entry.shared.includes(String(only.representative_chunk_id)), 'the representative is a member');
        const members = await rows('SELECT id FROM document_chunks WHERE dup_cluster_id = $1', [only.id]);
        assert.deepEqual(members.map((row) => String(row.id)).sort(), entry.shared.slice().sort());
        const unique = await rows('SELECT count(*)::int AS n FROM document_chunks WHERE id = ANY($1::uuid[]) AND dup_cluster_id IS NOT NULL', [entry.unique]);
        assert.equal(unique[0]?.n, 0, 'unique paragraphs have no cluster');
      }
      const mixed = await rows(
        `SELECT k.id FROM rag_dup_clusters k JOIN document_chunks c ON c.dup_cluster_id = k.id
         GROUP BY k.id HAVING count(DISTINCT c.tenant_key) > 1 OR bool_or(c.tenant_key <> k.tenant_key)`,
      );
      assert.equal(mixed.length, 0, 'no cluster holds chunks of two tenants');
    });

    test('a second run over the same chunks changes nothing', async () => {
      const tenant = tenants[0] as Tenant;
      const entry = seeded.get(tenant.key) as { shared: string[] };
      const before = await rows('SELECT id, member_count, source_document_ids FROM rag_dup_clusters ORDER BY id');
      await cluster.clusterChunks(tenant.scope(), entry.shared.slice(0, 5), { db: rpc });
      const after = await rows('SELECT id, member_count, source_document_ids FROM rag_dup_clusters ORDER BY id');
      assert.deepEqual(after, before);
    });

    test('equal content_hash in two documents clusters even when the SimHash differs (exact duplicate path)', async () => {
      const tenant = tenants[0] as Tenant;
      const text = uniqueParagraph(7, 900);
      const first = await insertDocument(db, mode, tenant, { filename: 'exact-one.md' });
      const second = await insertDocument(db, mode, tenant, { filename: 'exact-two.md' });
      const a = uuid('0e000000');
      const b = uuid('0e000000');
      await insertChunks(db, first, [{ id: a, content: text, embeddingText: `heading one ${text}` }]);
      await insertChunks(db, second, [{ id: b, content: text, embeddingText: uniqueParagraph(8, 901) }]);
      const write = await rpc.rpc('rag_dup_write_hashes', {
        p_tenant_key: tenant.key,
        p_rows: [
          { id: a, simhash: simhash.toInt64String(0x0123456789abcdefn) },
          { id: b, simhash: simhash.toInt64String(0xfedcba9876543210n) },
        ],
      });
      assert.equal(write.error, null, JSON.stringify(write.error));
      const candidates = await rpc.rpc('rag_dup_candidates', { p_tenant_key: tenant.key, p_chunk_ids: [a], p_max_hamming: 16, p_threshold: THRESHOLD, p_limit: 50 });
      assert.equal(candidates.error, null, JSON.stringify(candidates.error));
      const found = (candidates.data as Row[]).filter((row) => row.candidate_id === b);
      assert.equal(found.length, 1, 'the exact duplicate is a candidate');
      assert.equal(found[0]?.exact, true);
      await cluster.clusterChunks(tenant.scope(), [a, b], { db: rpc, rehash: false });
      const [ra, rb] = [await rows('SELECT dup_cluster_id FROM document_chunks WHERE id = $1', [a]), await rows('SELECT dup_cluster_id FROM document_chunks WHERE id = $1', [b])];
      assert.ok(ra[0]?.dup_cluster_id, 'clustered');
      assert.equal(ra[0]?.dup_cluster_id, rb[0]?.dup_cluster_id);
    });

    test('a candidate whose embedding cosine is below the threshold is not clustered, whatever its SimHash', async () => {
      const tenant = tenants[0] as Tenant;
      const first = await insertDocument(db, mode, tenant, { filename: 'far-one.md' });
      const second = await insertDocument(db, mode, tenant, { filename: 'far-two.md' });
      const a = uuid('0f000000');
      const b = uuid('0f000000');
      await insertChunks(db, first, [{ id: a, content: uniqueParagraph(9, 910) }]);
      await insertChunks(db, second, [{ id: b, content: uniqueParagraph(9, 911) }]);
      const same = simhash.toInt64String(0x1111222233334444n);
      await rpc.rpc('rag_dup_write_hashes', { p_tenant_key: tenant.key, p_rows: [{ id: a, simhash: same }, { id: b, simhash: same }] });
      const candidates = await rpc.rpc('rag_dup_candidates', { p_tenant_key: tenant.key, p_chunk_ids: [a], p_max_hamming: 16, p_threshold: THRESHOLD, p_limit: 50 });
      assert.equal(candidates.error, null, JSON.stringify(candidates.error));
      assert.equal((candidates.data as Row[]).filter((row) => row.candidate_id === b).length, 0);
      await cluster.clusterChunks(tenant.scope(), [a, b], { db: rpc, rehash: false });
      const clustered = await rows('SELECT count(*)::int AS n FROM document_chunks WHERE id = ANY($1::uuid[]) AND dup_cluster_id IS NOT NULL', [[a, b]]);
      assert.equal(clustered[0]?.n, 0);
    });

    test('superseded, quarantined, non-ready and other-profile copies are never compared; chunks of one document never cluster', async () => {
      const tenant = tenants[0] as Tenant;
      const text = uniqueParagraph(11, 920);
      const live = await insertDocument(db, mode, tenant, { filename: 'live.md' });
      const superseded = await insertDocument(db, mode, tenant, { filename: 'old.md', isCurrent: false, status: 'ready' });
      const quarantined = await insertDocument(db, mode, tenant, { filename: 'q.md', isCurrent: false, status: 'quarantined' });
      const processing = await insertDocument(db, mode, tenant, { filename: 'p.md', status: 'processing' });
      const otherProfile = await insertDocument(db, mode, tenant, { filename: 'profile.md' });
      const ids = { live: uuid('0a000000'), twin: uuid('0a000000'), old: uuid('0a000000'), q: uuid('0a000000'), p: uuid('0a000000'), other: uuid('0a000000') };
      await insertChunks(db, live, [
        { id: ids.live, content: text },
        { id: ids.twin, content: text },
      ]);
      await insertChunks(db, superseded, [{ id: ids.old, content: text, isCurrent: false, status: 'ready' }]);
      await insertChunks(db, quarantined, [{ id: ids.q, content: text, isCurrent: false, status: 'quarantined' }]);
      await insertChunks(db, processing, [{ id: ids.p, content: text, status: 'processing' }]);
      await insertChunks(db, otherProfile, [{ id: ids.other, content: text, chunkingProfileId: 'fixture-profile-b' }]);
      await cluster.clusterChunks(tenant.scope(), Object.values(ids), { db: rpc });
      const clustered = await rows('SELECT count(*)::int AS n FROM document_chunks WHERE id = ANY($1::uuid[]) AND dup_cluster_id IS NOT NULL', [Object.values(ids)]);
      assert.equal(clustered[0]?.n, 0);
      const candidates = await rpc.rpc('rag_dup_candidates', { p_tenant_key: tenant.key, p_chunk_ids: [ids.live], p_max_hamming: 64, p_threshold: 0, p_limit: 200 });
      assert.equal(candidates.error, null, JSON.stringify(candidates.error));
      const named = new Set((candidates.data as Row[]).map((row) => String(row.candidate_id)));
      for (const id of [ids.twin, ids.old, ids.q, ids.p, ids.other]) assert.equal(named.has(id), false, `${id} must not be compared`);
    });

    test('array arguments above the cap are refused with 22023', async () => {
      const tenant = tenants[0] as Tenant;
      const many = Array.from({ length: 1001 }, () => '00000000-0000-4000-8000-000000000000');
      const candidates = await rpc.rpc('rag_dup_candidates', { p_tenant_key: tenant.key, p_chunk_ids: many, p_max_hamming: 16, p_threshold: THRESHOLD, p_limit: 50 });
      assert.equal(candidates.error?.code, '22023');
      const assign = await rpc.rpc('rag_dup_assign', { p_tenant_key: tenant.key, p_chunk_ids: many, p_preferred_cluster_id: null });
      assert.equal(assign.error?.code, '22023');
      const hamming = await rpc.rpc('rag_dup_candidates', { p_tenant_key: tenant.key, p_chunk_ids: [], p_max_hamming: 65, p_threshold: THRESHOLD, p_limit: 50 });
      assert.equal(hamming.error?.code, '22023');
    });

    test('a tenant key of the other deployment mode or a malformed key is rejected by every function', async () => {
      const wrong = mode === 'multi-tenant' ? 's:default' : `u:${TWO_TENANT_IDS.userA}`;
      const calls: Record<(typeof DUP_FUNCTIONS)[number], Record<string, unknown>> = {
        rag_dup_write_hashes: { p_rows: [] },
        rag_dup_candidates: { p_chunk_ids: [], p_max_hamming: 16, p_threshold: THRESHOLD, p_limit: 50 },
        rag_dup_assign: { p_chunk_ids: [], p_preferred_cluster_id: null },
        rag_dup_clusters_recompute: { p_cluster_ids: null },
        rag_dup_backfill_candidates: { p_after: null, p_limit: 10, p_document_id: null, p_chunk_ids: null },
      };
      for (const fn of DUP_FUNCTIONS) {
        for (const key of [wrong, 'x:bad']) {
          const response = await rpc.rpc(fn, { p_tenant_key: key, ...calls[fn] });
          assert.equal(response.error?.code, '22023', `${fn} with ${key}`);
        }
      }
    });

    test('anon and authenticated cannot execute any rag_dup_* function nor read the band table', async () => {
      const signatures = await rows(
        `SELECT p.oid::regprocedure::text AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
        [DUP_FUNCTIONS as unknown as string[]],
      );
      assert.equal(new Set(signatures.map((row) => row.proname)).size, DUP_FUNCTIONS.length);
      for (const role of ['anon', 'authenticated']) {
        for (const row of signatures) {
          const allowed = await rows('SELECT has_function_privilege($1, $2, $3) AS ok', [role, row.sig, 'EXECUTE']);
          assert.equal(allowed[0]?.ok, false, `${role} may execute ${String(row.sig)}`);
          const service = await rows('SELECT has_function_privilege($1, $2, $3) AS ok', ['service_role', row.sig, 'EXECUTE']);
          assert.equal(service[0]?.ok, true, `service_role may execute ${String(row.sig)}`);
        }
        await db.exec(`SET ROLE ${role}`);
        try {
          await assert.rejects(db.query('SELECT * FROM public.rag_dup_chunk_bands LIMIT 1'), (error: unknown) => sqlState(error) === '42501');
          await assert.rejects(
            db.query(`SELECT * FROM public.rag_dup_clusters_recompute(p_tenant_key => $1, p_cluster_ids => NULL)`, [(tenants[0] as Tenant).key]),
            (error: unknown) => sqlState(error) === '42501',
          );
        } finally {
          await db.exec('RESET ROLE');
        }
      }
      const definer = await rows(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) AND (p.prosecdef OR NOT ('search_path=""' = ANY(coalesce(p.proconfig, '{}'))))`,
        [DUP_FUNCTIONS as unknown as string[]],
      );
      assert.deepEqual(definer, [], 'every rag_dup_* function is SECURITY INVOKER with an empty search_path');
      const rls = await rows("SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'public.rag_dup_chunk_bands'::regclass");
      assert.equal(rls[0]?.on, true);
    });

    test('applying 0857 again succeeds and keeps the cluster rows', async () => {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, MIGRATION)), `${MIGRATION} exists`);
      const before = await rows('SELECT id, member_count FROM rag_dup_clusters ORDER BY id');
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
      const after = await rows('SELECT id, member_count FROM rag_dup_clusters ORDER BY id');
      assert.deepEqual(after, before);
    });
  });
}
