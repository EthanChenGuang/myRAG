import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { PGlite } from '@electric-sql/pglite';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { createFixtureDatabase, type DeploymentMode } from './pglite-supabase.mts';
import { applyFixtureProcessEnv } from './process-env.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_CORPUS = 'eval/fixtures/corpus';
/** rag_dup_candidates bounds (0857): the widest candidate set the function returns. */
const MIN_THRESHOLD = -1;
const MAX_HAMMING = 64;
const CANDIDATE_LIMIT = 200;
const ID_BATCH = 1000;
const TEMPLATE_KEY = 'fixture_dup_template';
/** Nothing listens here: the harness passes its own database client, so no request leaves the process. */
const UNUSED_EDGE_URL = 'http://127.0.0.1:9';

/** One candidate pair: ids and numbers only, never chunk text. */
export interface DupPair {
  tenant: string;
  embedding_profile_id: string;
  chunk_a: string;
  chunk_b: string;
  hamming: number | null;
  cosine: number | null;
  same_template: boolean;
}

export interface RunDupPairsOptions {
  corpusDir: string;
  deploymentMode: DeploymentMode;
}

type Row = Record<string, unknown>;

/** Service-role PostgREST stand-in over PGlite: named arguments, rows back, errors with their SQLSTATE. */
function serviceRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
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
        .catch((error: unknown): RpcResponse => {
          const code = (error as { code?: unknown } | null)?.code;
          return { data: null, error: { code: typeof code === 'string' ? code : 'P0001', message: error instanceof Error ? error.message : String(error) } };
        });
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => run.then(onFulfilled, onRejected) };
      return request;
    },
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * D-19, D-49: builds the fixture database, hashes every current ready chunk through the cluster service (evalRun), and lists every
 * candidate pair rag_dup_candidates returns at its widest bounds. A pair is same_template when both documents carry the same
 * `fixture_dup_template` metadata value.
 */
export async function runDupPairs(options: RunDupPairsOptions): Promise<DupPair[]> {
  applyFixtureProcessEnv({ edgeUrl: UNUSED_EDGE_URL, deploymentMode: options.deploymentMode, extra: { RAG_DUP_CLUSTERS: 'true' } });
  const fixture = await createFixtureDatabase({ deploymentMode: options.deploymentMode, corpusDir: options.corpusDir });
  try {
    const db = fixture.db;
    const rpc = serviceRpc(db);
    const cluster = await import('@/lib/rag/dedupe/cluster');
    const profileRow = await db.query<{ id: string }>("SELECT id FROM public.embedding_profiles WHERE status = 'active'");
    const profileId = profileRow.rows[0]?.id;
    if (!profileId) throw new Error('[Dup Pairs] the fixture database has no active embedding profile');
    const templateRows = await db.query<{ id: string; template: string | null }>(
      `SELECT c.id, d.metadata->>'${TEMPLATE_KEY}' AS template FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id`,
    );
    const templateOf = new Map(templateRows.rows.map((row) => [row.id, row.template]));
    const tenants = await db.query<{ tenant_key: string }>('SELECT DISTINCT tenant_key FROM public.document_chunks WHERE tenant_key IS NOT NULL ORDER BY tenant_key');
    const signal = new AbortController().signal;
    const pairs = new Map<string, DupPair>();
    for (const { tenant_key: tenant } of tenants.rows) {
      const ids: string[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await cluster.listChunkText(rpc, tenant, { after }, signal);
        if (page.length === 0) break;
        await cluster.clusterChunksForTenantKey(tenant, page, { db: rpc, signal, evalRun: true, embeddingProfileId: profileId });
        ids.push(...page.map((chunk) => chunk.id));
        after = page[page.length - 1]!.id;
      }
      for (let i = 0; i < ids.length; i += ID_BATCH) {
        const response = await rpc.rpc('rag_dup_candidates', {
          p_tenant_key: tenant,
          p_chunk_ids: ids.slice(i, i + ID_BATCH),
          p_max_hamming: MAX_HAMMING,
          p_threshold: MIN_THRESHOLD,
          p_limit: CANDIDATE_LIMIT,
        });
        if (response.error) throw new Error(`[Dup Pairs] rag_dup_candidates failed (${response.error.code ?? 'unknown'})`);
        for (const row of (response.data ?? []) as Row[]) {
          const left = String(row.chunk_id);
          const right = String(row.candidate_id);
          const [a, b] = left < right ? [left, right] : [right, left];
          const key = `${tenant}:${a}:${b}`;
          if (pairs.has(key)) continue;
          const templateA = templateOf.get(a) ?? null;
          const templateB = templateOf.get(b) ?? null;
          pairs.set(key, {
            tenant,
            embedding_profile_id: profileId,
            chunk_a: a,
            chunk_b: b,
            hamming: numberOrNull(row.hamming),
            cosine: numberOrNull(row.similarity),
            same_template: templateA !== null && templateA === templateB,
          });
        }
      }
    }
    return [...pairs.values()].sort((x, y) => (x.tenant + x.chunk_a + x.chunk_b < y.tenant + y.chunk_a + y.chunk_b ? -1 : 1));
  } finally {
    await fixture.db.close().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      corpus: { type: 'string', default: DEFAULT_CORPUS },
      'deployment-mode': { type: 'string', default: 'single-tenant' },
      out: { type: 'string' },
    },
    strict: true,
  });
  const deploymentMode = values['deployment-mode'];
  if (deploymentMode !== 'single-tenant' && deploymentMode !== 'multi-tenant') {
    console.error(`[Dup Pairs] --deployment-mode must be single-tenant or multi-tenant, got ${String(deploymentMode)}`);
    return 2;
  }
  if (!values.out) {
    console.error('[Dup Pairs] --out <file> is required');
    return 2;
  }
  const corpusDir = path.resolve(REPO_ROOT, values.corpus ?? DEFAULT_CORPUS);
  const pairs = await runDupPairs({ corpusDir, deploymentMode });
  const out = path.resolve(process.cwd(), values.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, pairs.map((pair) => JSON.stringify(pair)).join('\n') + (pairs.length > 0 ? '\n' : ''));
  console.log(`[Dup Pairs] wrote ${pairs.length} candidate pairs`, { out: path.relative(REPO_ROOT, out), same_template: pairs.filter((p) => p.same_template).length });
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error('[Dup Pairs] failed', { error: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : String(error) });
      process.exit(3);
    },
  );
}
