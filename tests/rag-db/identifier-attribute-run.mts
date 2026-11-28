/**
 * 03.3 verification G3 (SC4, TPL-04 with RET-16): an attribute value flagged for the identifier index is found by the exact identifier
 * filter, end to end, for one deployment mode per process (the app reads the deployment mode once at import). The value is only in the
 * documents' attributes, never in their text. Steps: define a code key with in_identifier_index, import the values with the rag:attributes
 * import, run the rag:identifiers backfill, then ask the eval route under v2 with RAG_IDENTIFIER_INDEX and RAG_IDENTIFIER_FILTER on.
 * identifier-attribute-filter.test.mts runs this file once per mode and asserts on the JSON report it prints. Values are invented.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { prepareInProcessEval } from '../../eval/harness/run-eval.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { FIXTURE_USER_ID, runFixtureRelex } from '../../eval/harness/pglite-supabase.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';

type Mode = 'multi-tenant' | 'single-tenant';
const mode = process.argv[2] as Mode;
if (mode !== 'multi-tenant' && mode !== 'single-tenant') throw new Error('usage: identifier-attribute-run.mts <multi-tenant|single-tenant>');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const USER_B = '00000000-0000-4000-8000-000003330b01';
const LEGACY_EMBED_PROFILE = 'openai-3-small-1536';
const TARGET = 'QX-7731-MK';
const NEAR_MISS = 'QX-7731-MJ';
const OTHERS = ['QX-5520-AB', 'QX-8804-TR', 'QX-2219-PL'];
const QUERY = `What is the probe routine for unit ${TARGET}?`;
const PLAIN_QUERY = 'What is the probe routine for the unit?';
const CONTENT = 'Probe family record. The probe routine for this unit has four plain steps and one closing check.';
const FILTER_OFF = { RAG_IDENTIFIER_INDEX: 'false', RAG_IDENTIFIER_FILTER: 'false' };
const FILTER_ON = { RAG_IDENTIFIER_INDEX: 'true', RAG_IDENTIFIER_FILTER: 'true' };
const NO_PATTERNS = async () => ({ expressions: Object.freeze([]) as readonly RegExp[], patternIds: Object.freeze([]) as readonly string[], loadFailed: false });

const silent = () => undefined;
console.log = silent;
console.info = silent;
console.warn = silent;
console.error = silent;

interface Tenant {
  key: string;
  userId: string | null;
}

let sequence = 0;

async function q(db: PGlite, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await db.query<Record<string, unknown>>(sql, params)).rows;
}

const asParam = (value: unknown): unknown =>
  value !== null && typeof value === 'object' && !(Array.isArray(value) && value.every((item) => typeof item !== 'object' || item === null))
    ? JSON.stringify(value)
    : value;

function serviceRpc(db: PGlite): RpcClient {
  return {
    rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `SELECT * FROM public.${fn}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')})`;
      const run = db
        .transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          return (await tx.query<Record<string, unknown>>(sql, keys.map((key) => asParam(args[key])))).rows;
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

async function document(db: PGlite, tenant: Tenant, sourceKey: string): Promise<string> {
  sequence += 1;
  const begun = (
    await q(
      db,
      `SELECT outcome, document_id FROM rag_begin_document_version($1, $2::uuid, NULL::uuid, 'config_upload', $3, $4, $5, 'general', 'fallback', 'general-1', 1)`,
      [tenant.key, tenant.userId, sourceKey, `${sourceKey}.md`, crypto.createHash('sha256').update(`id-attr-e2e-${sequence}`).digest('hex')],
    )
  )[0];
  const id = String(begun?.document_id);
  const chunks = [{ chunk_index: 0, content: CONTENT, lexical_text: CONTENT, metadata: {} }];
  await q(
    db,
    'SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => 1)',
    [id, tenant.key, JSON.stringify(chunks), JSON.stringify({ [LEGACY_EMBED_PROFILE]: [embedText(CONTENT)] })],
  );
  await q(db, 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [id, tenant.key]);
  return id;
}

interface Trace {
  candidates: Array<{ chunk_id: string; document_id: string }>;
  stage_status: Record<string, string>;
  identifier?: { asked: number; resolved: number; fallback: boolean };
}

async function main(): Promise<void> {
  const prepared = await prepareInProcessEval({
    corpusDir: CORPUS_DIR,
    deploymentMode: mode,
    allowedScopes: mode === 'multi-tenant' ? [`user:${USER_B}`] : [],
    envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_RERANKER: 'none', RAG_DOC_ATTRIBUTES: 'true', ...FILTER_OFF },
  });
  const report: Record<string, unknown> = { mode };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'identifier-attribute-'));
  try {
    const db = prepared.fixtureDb as PGlite;
    const { resetRagConfigForTests } = await import('../../src/lib/rag/config.ts');
    const { resetV2StartupForTests, verifyV2Startup } = await import('../../src/lib/rag/v2/startup.ts');
    const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
    const { runAttributesImport } = await import('../../src/lib/rag/ingest/attributes/import.ts');
    const { resetAttributeSchemaCacheForTests } = await import('../../src/lib/rag/ingest/attributes/schema.ts');
    const { setIngestDepsForTests, resetIngestDepsForTests } = await import('../../src/lib/rag/ingest/deps.ts');
    const { resetIngestConfigForTests } = await import('../../src/lib/rag/ingest/config.ts');
    const { backfillIdentifiers } = await import('../../src/lib/rag/identifiers/backfill.ts');

    const a: Tenant = mode === 'multi-tenant' ? { key: `u:${FIXTURE_USER_ID}`, userId: FIXTURE_USER_ID } : { key: 's:default', userId: null };
    const b: Tenant | null = mode === 'multi-tenant' ? { key: `u:${USER_B}`, userId: USER_B } : null;
    const scopeOf = (tenant: Tenant) => (tenant.userId ? mintScope('personal', tenant.userId, null) : mintScope('single', null, null));
    if (b) await q(db, 'INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [USER_B, 'id-attr-b@example.invalid']);

    const rpc = serviceRpc(db);
    const ingestEnv = { RAG_INGEST_PIPELINE: 'unified', RAG_DOC_ATTRIBUTES: 'true', RAG_IDENTIFIER_INDEX: 'true' };
    const seed = async (tenant: Tenant, codes: string[]): Promise<Map<string, string>> => {
      await q(
        db,
        `INSERT INTO public.rag_attribute_definitions (tenant_key, key, type, filterable, in_identifier_index) VALUES ($1, 'alpha_code', 'code', true, true)
         ON CONFLICT (tenant_key, key) DO UPDATE SET in_identifier_index = true`,
        [tenant.key],
      );
      const ids = new Map<string, string>();
      for (const code of codes) ids.set(code, await document(db, tenant, `unit-${code.toLowerCase()}`));
      const file = path.join(tmp, `${tenant.key.replace(/[^a-z0-9]/gi, '_')}.jsonl`);
      fs.writeFileSync(file, codes.map((code) => JSON.stringify({ source_key: `unit-${code.toLowerCase()}`, attributes: { alpha_code: code } })).join('\n'));
      resetAttributeSchemaCacheForTests();
      resetIngestConfigForTests();
      setIngestDepsForTests({ db: () => rpc, ingestEnv: () => ingestEnv });
      try {
        const imported = await runAttributesImport(
          { scope: scopeOf(tenant), file, apply: true },
          { rpc, signal: new AbortController().signal, io: { out: silent, err: silent } },
        );
        if (imported.exitCode !== 0) throw new Error(`import exit ${imported.exitCode}`);
        const backfill = await backfillIdentifiers({ db: rpc, scope: scopeOf(tenant), loadPatterns: NO_PATTERNS });
        if (backfill.failed !== 0) throw new Error(`identifier backfill failed for ${backfill.failed} document(s)`);
      } finally {
        resetIngestDepsForTests();
        resetIngestConfigForTests();
        resetAttributeSchemaCacheForTests();
      }
      return ids;
    };

    const family = await seed(a, [TARGET, NEAR_MISS, ...OTHERS]);
    const foreign = b ? await seed(b, [TARGET]) : new Map<string, string>();
    await runFixtureRelex(db);
    const targetId = family.get(TARGET)!;
    const familyIds = new Set(family.values());
    const foreignIds = new Set(foreign.values());

    const stored = await q(db, 'SELECT identifiers_norm FROM document_chunks WHERE document_id = $1', [targetId]);
    report.targetChunkHasIdentifier = stored.length > 0 && stored.every((row) => (row.identifiers_norm as string[] | null)?.includes('qx7731mk'));
    report.contentHasValue = CONTENT.includes(TARGET);

    const configure = async (env: Record<string, string>): Promise<void> => {
      Object.assign(process.env, env);
      resetRagConfigForTests();
      resetV2StartupForTests();
      await verifyV2Startup();
    };

    const post = async (query: string): Promise<Trace> => {
      const req = new NextRequest('http://localhost/api/internal/rag/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
        body: JSON.stringify({ schema_version: 1, query, rag_mode: 'balanced', options: a.userId ? { user_id: a.userId } : {} }),
      });
      const res = await prepared.POST(req);
      const json = (await res.json()) as Trace & { error?: string };
      if (res.status !== 200) throw new Error(`eval route answered ${res.status}: ${json.error ?? 'unknown'}`);
      return json;
    };

    const summary = (trace: Trace) => {
      const docs = trace.candidates.map((row) => row.document_id);
      return {
        count: docs.length,
        familyDocs: new Set(docs.filter((id) => familyIds.has(id))).size,
        onlyTarget: docs.length > 0 && docs.every((id) => id === targetId),
        hasTarget: docs.includes(targetId),
        hasNearMiss: docs.includes(family.get(NEAR_MISS)!),
        foreign: docs.filter((id) => foreignIds.has(id)).length,
        identifier: trace.identifier ?? null,
        identifierStage: trace.stage_status.identifier_resolve ?? null,
      };
    };

    await configure(FILTER_OFF);
    report.off = summary(await post(QUERY));
    await configure(FILTER_ON);
    report.on = summary(await post(QUERY));
    report.plainOn = summary(await post(PLAIN_QUERY));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    await prepared.close();
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`[identifier-attribute-run] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
