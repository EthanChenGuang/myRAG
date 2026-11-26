/**
 * TPL-06 (03.3-19): the attribute filter end to end through the eval route, for one deployment mode per process (the app reads the
 * deployment mode once at import). attribute-filter.test.mts runs this file once per mode and asserts on the JSON report it prints.
 * Fixture keys and values are invented; the family of 12 near-identical documents differs only in alpha_code.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { prepareInProcessEval } from '../../eval/harness/run-eval.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { FIXTURE_USER_ID, runFixtureRelex } from '../../eval/harness/pglite-supabase.mts';

type Mode = 'multi-tenant' | 'single-tenant';
const mode = process.argv[2] as Mode;
if (mode !== 'multi-tenant' && mode !== 'single-tenant') throw new Error('usage: attribute-pipeline-run.mts <multi-tenant|single-tenant>');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const USER_B = '00000000-0000-4000-8000-000000190b01';
const LEGACY_EMBED_PROFILE = 'openai-3-small-1536';
const FAMILY = Array.from({ length: 12 }, (_, index) => `zeta-${String(index + 1).padStart(2, '0')}`);
const NAMED = 'zeta-07';
const QUERY = `What is the maintenance routine for unit ${NAMED}?`;
const PLAIN_QUERY = 'What is the maintenance routine for the probe unit?';

const silent = () => undefined;
console.log = silent;
console.info = silent;
console.warn = silent;
console.error = silent;

interface Tenant {
  key: string;
  userId: string | null;
  orgId: string | null;
}

let sequence = 0;

async function q(db: PGlite, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await db.query<Record<string, unknown>>(sql, params)).rows;
}

async function defineKeys(db: PGlite, tenantKey: string): Promise<void> {
  await q(
    db,
    `INSERT INTO public.rag_attribute_definitions (tenant_key, key, type, filterable, soft) VALUES
       ($1, 'alpha_code', 'code', true, false), ($1, 'delta_text', 'text', true, true)
     ON CONFLICT (tenant_key, key) DO NOTHING`,
    [tenantKey],
  );
}

async function document(db: PGlite, tenant: Tenant, sourceKey: string, content: string, attributes: Record<string, unknown>): Promise<string> {
  sequence += 1;
  const begun = (
    await q(
      db,
      `SELECT outcome, document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, 'config_upload', $4, $5, $6, 'general', 'fallback', 'general-1', 1)`,
      [tenant.key, tenant.userId, tenant.orgId, sourceKey, `${sourceKey}.md`, crypto.createHash('sha256').update(`attr-e2e-${sequence}`).digest('hex')],
    )
  )[0];
  const id = String(begun?.document_id);
  await q(db, 'SELECT * FROM rag_apply_document_attributes(p_tenant_key => $1, p_document_id => $2, p_explicit => $3::jsonb)', [
    tenant.key,
    id,
    JSON.stringify(attributes),
  ]);
  const chunks = [{ chunk_index: 0, content, lexical_text: content, metadata: {} }];
  await q(
    db,
    'SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => 1)',
    [id, tenant.key, JSON.stringify(chunks), JSON.stringify({ [LEGACY_EMBED_PROFILE]: [embedText(content)] })],
  );
  await q(db, 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [id, tenant.key]);
  return id;
}

function familyContent(code: string): string {
  return `Probe family record. The maintenance routine for this probe unit has four plain steps and one closing check. Unit ${code}.`;
}

interface Candidate {
  chunk_id: string;
  document_id: string;
  similarity: number;
  legs?: Record<string, number>;
}

interface Trace {
  candidates: Candidate[];
  refused?: boolean;
  stage_status: Record<string, string>;
  stage_counts?: Record<string, Record<string, number>>;
  attribute_filter?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const prepared = await prepareInProcessEval({
    corpusDir: CORPUS_DIR,
    deploymentMode: mode,
    allowedScopes: mode === 'multi-tenant' ? [`user:${USER_B}`] : [],
    envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_DOC_ATTRIBUTES: 'true', RAG_ATTRIBUTE_FILTER: 'off' },
  });
  const report: Record<string, unknown> = { mode };
  try {
    const db = prepared.fixtureDb;
    const { resetRagConfigForTests } = await import('../../src/lib/rag/config.ts');
    const { resetAttributeLexiconForTests } = await import('../../src/lib/rag/retrieval/attributes.ts');
    const { setAttributeFilterConfigForTests } = await import('../../src/lib/rag/retrieval/attribute-filter-config.ts');
    const { resetV2StartupForTests, verifyV2Startup } = await import('../../src/lib/rag/v2/startup.ts');

    const a: Tenant = mode === 'multi-tenant' ? { key: `u:${FIXTURE_USER_ID}`, userId: FIXTURE_USER_ID, orgId: null } : { key: 's:default', userId: null, orgId: null };
    const b: Tenant | null = mode === 'multi-tenant' ? { key: `u:${USER_B}`, userId: USER_B, orgId: null } : null;
    if (b) await q(db, 'INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [USER_B, 'attr-e2e-b@example.invalid']);
    await defineKeys(db, a.key);
    if (b) await defineKeys(db, b.key);

    const family = new Map<string, string>();
    for (const code of FAMILY) family.set(code, await document(db, a, `family-${code}`, familyContent(code), { alpha_code: code }));
    const foreign = new Set<string>();
    if (b) {
      for (const code of ['omega-01', 'omega-02', 'omega-03']) foreign.add(await document(db, b, `foreign-${code}`, familyContent(code), { alpha_code: code }));
    }
    await runFixtureRelex(db);
    const familyIds = new Set(family.values());
    const namedId = family.get(NAMED)!;

    const configure = async (env: Record<string, string>): Promise<void> => {
      Object.assign(process.env, env);
      resetRagConfigForTests();
      resetV2StartupForTests();
      await verifyV2Startup();
    };

    const post = async (query: string, options: { tenant?: 'a' | 'b'; attributes?: Record<string, string[]> } = {}): Promise<Trace> => {
      const userId = options.tenant === 'b' ? USER_B : mode === 'multi-tenant' ? FIXTURE_USER_ID : undefined;
      const req = new NextRequest('http://localhost/api/internal/rag/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
        body: JSON.stringify({
          schema_version: 1,
          query,
          rag_mode: 'strict',
          options: {
            ...(userId ? { user_id: userId } : {}),
            ...(options.attributes ? { retrieval_filters: { attributes: options.attributes } } : {}),
          },
        }),
      });
      const res = await prepared.POST(req);
      const json = (await res.json()) as Trace & { error?: string };
      if (res.status !== 200) throw new Error(`eval route answered ${res.status}: ${json.error ?? 'unknown'}`);
      return json;
    };

    const summary = (trace: Trace) => ({
      ids: trace.candidates.map((row) => row.chunk_id),
      docs: trace.candidates.map((row) => row.document_id),
      similarity: Object.fromEntries(trace.candidates.map((row) => [row.chunk_id, row.similarity])),
      legs: Object.fromEntries(trace.candidates.map((row) => [row.document_id, Object.keys(row.legs ?? {})])),
      refused: trace.refused === true,
      statuses: trace.stage_status,
      search: trace.stage_counts?.search ?? {},
      attribute: trace.attribute_filter ?? null,
      familyDocs: new Set(trace.candidates.map((row) => row.document_id).filter((id) => familyIds.has(id))).size,
      foreign: trace.candidates.filter((row) => foreign.has(row.document_id)).map((row) => row.chunk_id),
      namedRank: trace.candidates.findIndex((row) => row.document_id === namedId),
    });

    // Off.
    await configure({ RAG_ATTRIBUTE_FILTER: 'off', RAG_EXACT_SCAN_CUTOFF: '0' });
    const off = summary(await post(QUERY));
    const offPlain = summary(await post(PLAIN_QUERY));
    report.off = off;

    // Hard on both cutoff settings.
    await configure({ RAG_ATTRIBUTE_FILTER: 'hard', RAG_EXACT_SCAN_CUTOFF: '0' });
    const hard = summary(await post(QUERY));
    const hardPlain = summary(await post(PLAIN_QUERY));
    await configure({ RAG_ATTRIBUTE_FILTER: 'hard', RAG_EXACT_SCAN_CUTOFF: '5000' });
    const hardExact = summary(await post(QUERY));
    report.hard = { ...hard, onlyNamed: hard.docs.every((id) => id === namedId) };
    report.hardExact = { ...hardExact, onlyNamed: hardExact.docs.every((id) => id === namedId) };
    report.plain = { offIds: offPlain.ids, hardIds: hardPlain.ids, attribute: hardPlain.attribute };

    // Soft.
    await configure({ RAG_ATTRIBUTE_FILTER: 'soft', RAG_EXACT_SCAN_CUTOFF: '0' });
    const soft = summary(await post(QUERY));
    const sharedSimilarityDiffers = Object.entries(soft.similarity).filter(
      ([chunkId, value]) => off.similarity[chunkId] !== undefined && off.similarity[chunkId] !== value,
    ).length;
    report.soft = { ...soft, sharedSimilarityDiffers };

    // Explicit filter with the switch on; tiny id cap for too_broad.
    await configure({ RAG_ATTRIBUTE_FILTER: 'hard', RAG_EXACT_SCAN_CUTOFF: '0' });
    const explicit = summary(await post(PLAIN_QUERY, { attributes: { alpha_code: ['zeta-03'] } }));
    report.explicit = { ...explicit, onlyNamed: explicit.docs.every((id) => id === family.get('zeta-03')) };
    setAttributeFilterConfigForTests({ schema_version: 1, rules_version: 1, soft_weight: 0.5, id_cap: 2 });
    resetAttributeLexiconForTests();
    const tooBroad = summary(await post(PLAIN_QUERY, { attributes: { alpha_code: FAMILY } }));
    report.tooBroad = { ...tooBroad, allowedOnly: tooBroad.docs.every((id) => familyIds.has(id)) };
    setAttributeFilterConfigForTests(null);
    resetAttributeLexiconForTests();

    // Tenant B naming tenant A's value.
    if (b) {
      const crossed = summary(await post(QUERY, { tenant: 'b' }));
      report.crossTenant = { ...crossed, aChunks: crossed.docs.filter((id) => familyIds.has(id)) };
    }

    // An unrelated question that names the value: strict mode refuses or answers, never a knowledge-base error.
    const unrelated = summary(await post(`${NAMED} orbital mechanics of distant moons`));
    report.unrelated = { refused: unrelated.refused, errorStages: Object.entries(unrelated.statuses).filter(([, status]) => status === 'error').map(([name]) => name) };

    // The named value is carried by no current document any more (lexicon still cached): one fallback, off-equal answer.
    await configure({ RAG_ATTRIBUTE_FILTER: 'hard', RAG_EXACT_SCAN_CUTOFF: '0' });
    await post(QUERY);
    await document(db, a, `family-${NAMED}`, familyContent(NAMED), { alpha_code: 'zeta-99' });
    await runFixtureRelex(db);
    const fallback = summary(await post(QUERY));
    await configure({ RAG_ATTRIBUTE_FILTER: 'off', RAG_EXACT_SCAN_CUTOFF: '0' });
    const offAfter = summary(await post(QUERY));
    report.fallback = { attribute: fallback.attribute, ids: fallback.ids, refused: fallback.refused, offIds: offAfter.ids, offRefused: offAfter.refused };
  } finally {
    await prepared.close();
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`[attribute-pipeline-run] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
