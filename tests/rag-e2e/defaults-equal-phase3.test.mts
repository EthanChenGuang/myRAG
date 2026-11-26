import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { PHASE_32_VARIABLES } from './phase32-all-off-probe.mts';

// D-47 step 14: with every Phase 3.1 switch at its default, each write path stores what Phase 3 stored and the queue stays empty.
// The reference was recorded once on the Phase 3 tip (84753a33) with the same inputs; see recorded_from in the fixture.
const REFERENCE_PATH = 'tests/fixtures/ingest/phase3-write-paths-reference.json';

// Metadata keys added after Phase 3 by a later phase, not by 3.1: lexical_version comes from Phase 4 (plan 04-03, chunkLexicalText).
const LATER_PHASE_METADATA_KEYS = new Set(['lexical_version']);

const PHASE_31_SWITCHES = [
  'RAG_PARSE_ROUTING',
  'RAG_PARSER_ALLOW_CLOUD',
  'RAG_PARSE_PREMIUM_PAGE_BUDGET',
  'RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC',
  'RAG_PARSE_ESCALATION',
  'RAG_PARSE_VLM_DETECT',
  'RAG_PARSE_VLM_MODEL',
  'RAG_INGEST_ASYNC',
  'RAG_INGEST_WORKER_CONCURRENCY',
  'RAG_PARSE_PROGRESSIVE',
  'RAG_EMBED_BATCH_MODE',
  'NEXT_PUBLIC_RAG_INGEST_REALTIME',
] as const;

// D-37 (plan 03.3-24): the six Phase 3.3 switches; unset, neither the preparation step nor the attribute resolver may run.
const PHASE_33_SWITCHES = [
  'RAG_SECTION_RULES',
  'RAG_PAGE_BOILERPLATE',
  'RAG_DOC_ATTRIBUTES',
  'RAG_ATTRIBUTE_HEADER',
  'RAG_ATTRIBUTE_FILTER',
  'RAG_LEXICAL_QUANTITY',
] as const;

const PHASE_33_TABLES = [
  'rag_section_rule_sets',
  'rag_boilerplate_rules',
  'rag_attribute_definitions',
  'rag_attribute_header_templates',
  'rag_staged_attributes',
] as const;

// Pipeline-owned keys Phase 3.3 adds: the boilerplate report and review codes on documents (plan 03.3-10), the header stamp on chunks.
const PHASE_33_DOCUMENT_METADATA_KEYS = ['boilerplate', 'review_reasons'];
const PHASE_33_CHUNK_METADATA_KEYS = ['attribute_header_stamp'];
const PAGE_TEXTS_ARTIFACT_NAME = 'page-texts.json';

/** Every function a Phase 3.3 migration (1002 to 1009) creates, read from the files. */
function phase33RpcNames(): Set<string> {
  const dir = path.join(process.cwd(), 'supabase/migrations');
  const names = new Set<string>();
  for (const file of fs.readdirSync(dir)) {
    const stem = Number(file.slice(0, 4));
    if (!(stem >= 1002 && stem <= 1009)) continue;
    for (const match of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.([a-z0-9_]+)\s*\(/g)) names.add(match[1]!);
  }
  return names;
}

const QUEUE_TABLES = [
  'ingestion_jobs',
  'ingestion_batches',
  'rag_parse_cache',
  'rag_parse_budget_usage',
  'rag_parse_budget_reservations',
  'rag_embed_batches',
] as const;

interface ReferenceChunk {
  content_hash: string;
  section_path: string[] | null;
  page_start: number | null;
  page_end: number | null;
  chunk_kind: string;
  metadata_keys: string[];
  parser_used: string | null;
}

interface ReferenceRun {
  id: string;
  source: string;
  sourceKey: string;
  filename: string;
  mimeType: string;
  docType?: string;
  text?: string;
  file?: string;
  options?: Record<string, unknown>;
  expected: { status: string; chunkCount: number; doc: Record<string, unknown>; chunks: ReferenceChunk[] };
}

const reference = JSON.parse(fs.readFileSync(path.join(process.cwd(), REFERENCE_PATH), 'utf8')) as { recorded_from: string; runs: ReferenceRun[] };

describe('defaults equal Phase 3: every write path with all Phase 3.1 switches at their defaults', () => {
  let db: PGlite;
  let edge: FakeEdge;
  let uninstall: (() => Promise<void>) | undefined;
  let objectStore: { keys(): string[] } | undefined;
  let rag: typeof import('@/lib/rag');
  let queueConfig: typeof import('@/lib/rag/ingest/queue-config');
  let scope: import('@/lib/rag/tenant/scope').TenantScope;
  const saved = new Map<string, string | undefined>();

  before(async () => {
    for (const name of [...PHASE_31_SWITCHES, ...PHASE_32_VARIABLES, ...PHASE_33_SWITCHES, 'RAG_INGEST_PIPELINE', 'RAG_INGEST_WORKER']) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    const empty = await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' });
    db = empty.db;
    edge = await startFakeEdge({ db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    // The unified pipeline is the Phase 3 write path under test; everything Phase 3.1 added stays unset.
    process.env.RAG_INGEST_PIPELINE = 'unified';
    // D-19 (03.2-67): the default of RAG_TABLE_HEADER_REPEAT is always; Phase 3 chunking is the explicit profile value.
    process.env.RAG_TABLE_HEADER_REPEAT = 'profile';
    const { INGEST_MODE_ENV, fixtureAdminClient, installIngestFakes } = await import('../../eval/harness/ingest-fakes.mts');
    const fakes = await installIngestFakes({ db: fixtureAdminClient(edge.url), env: { ...INGEST_MODE_ENV, RAG_TABLE_HEADER_REPEAT: 'profile' } });
    uninstall = fakes.uninstall;
    objectStore = fakes.objectStore;
    rag = await import('@/lib/rag');
    queueConfig = await import('@/lib/rag/ingest/queue-config');
    queueConfig.resetQueueConfigForTests();
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    scope = mintScope('single', null, null);
  });

  after(async () => {
    await uninstall?.();
    await edge?.close();
    await db?.close();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const queueRowCounts = async (tables: readonly string[] = QUEUE_TABLES): Promise<Record<string, number>> => {
    const counts: Record<string, number> = {};
    for (const table of tables) {
      counts[table] = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ?? -1;
    }
    return counts;
  };

  const zeroCounts = Object.fromEntries(QUEUE_TABLES.map((table) => [table, 0]));

  test('the queue switches resolve to Phase 3 behaviour when unset', () => {
    const config = queueConfig.queueConfigFromProcessEnv();
    assert.equal(config.ingestAsync, false);
    assert.equal(config.parseRouting, 'fixed');
    assert.equal(config.parserAllowCloud, true);
    assert.equal(config.premiumPageBudget, 0);
    assert.equal(config.premiumMaxPagesPerDoc, 200);
    assert.equal(config.parseEscalation, 'on');
    assert.equal(config.vlmDetect, false);
    assert.equal(config.parseProgressive, false);
    assert.equal(config.embedBatchMode, 'sync');
    assert.equal(config.ingestRealtime, false);
    assert.deepEqual(config.warnings, []);
  });

  test('the Phase 3.2 switches resolve to their off values when unset (D-47)', () => {
    const ingest = rag.loadIngestConfig({ RAG_INGEST_PIPELINE: 'unified' });
    assert.equal(ingest.languageAwareIngest, 'off');
    // Unset, header repetition is always (eval/decisions/03.2-table-header-default.json); profile restores Phase 3 chunking.
    assert.equal(ingest.tableHeaderRepeat, 'always');
    assert.equal(rag.loadIngestConfig({ RAG_INGEST_PIPELINE: 'unified', RAG_TABLE_HEADER_REPEAT: 'profile' }).tableHeaderRepeat, 'profile');
    assert.equal(ingest.tableRowSerialization, false);
    assert.equal(ingest.captionLanguage, 'en');
    assert.equal(ingest.docTranslation, 'off');
    assert.equal(ingest.docTranslationModel, '');
    assert.equal(ingest.hiddenTextCheck, 'off');
    assert.equal(ingest.ingestLinkCheck, 'off');
    assert.equal(ingest.outputLinkAllowlist, '');
    assert.equal(ingest.uploadApproval, 'off');
    assert.equal(ingest.scopeTags, false);
    assert.equal(ingest.scopeTagSuggest, false);
    assert.equal(ingest.supersessionDetect, 'off');
    assert.equal(ingest.effectiveDateLlmExtract, false);
    assert.deepEqual(ingest.warnings, []);
    const query = rag.loadRagConfig({});
    assert.equal(query.pipeline, 'legacy');
    assert.equal(query.effectiveDates, false);
    assert.equal(query.scopeTags, false);
    assert.equal(query.docTranslation, 'off');
    assert.equal(query.bgeM3Serving, 'hosted');
    assert.equal(query.outputLinkAllowlist, '');
  });

  test('the legacy pipeline never reaches the queue, even with RAG_INGEST_ASYNC=on or tiered routing asked for', () => {
    const config = queueConfig.loadQueueConfig({ RAG_INGEST_PIPELINE: 'legacy', RAG_INGEST_ASYNC: 'on', RAG_PARSE_ROUTING: 'tiered' });
    assert.equal(config.ingestAsync, false);
    assert.equal(config.parseRouting, 'fixed');
    assert.equal(queueConfig.loadQueueConfig({}).ingestAsync, false);
  });

  for (const run of reference.runs) {
    test(`${run.id}: submitIngest with the defaults stores the Phase 3 chunks inline and writes no queue, cache or budget row`, async () => {
      const input: Record<string, unknown> = {
        scope,
        source: run.source,
        sourceKey: run.sourceKey,
        filename: run.filename,
        mimeType: run.mimeType,
        signal: new AbortController().signal,
        ...(run.docType ? { docType: run.docType } : {}),
        ...(run.options ? { options: run.options } : {}),
      };
      if (run.text !== undefined) input.text = run.text;
      else input.file = new Uint8Array(fs.readFileSync(path.join(process.cwd(), String(run.file))));

      const result = await rag.submitIngest(input as unknown as Parameters<typeof rag.submitIngest>[0]);
      // Only a queued result makes a write path schedule the sidecar wake; an inline result never does.
      assert.ok(!('jobId' in result), `${run.id} was enqueued`);
      assert.equal(result.status, run.expected.status);
      assert.equal((result as { chunkCount?: number }).chunkCount, run.expected.chunkCount);
      const documentId = String((result as { documentId?: string }).documentId);

      const [doc] = (
        await db.query<Record<string, unknown>>(
          'SELECT parser_used, doc_type, doc_type_origin, status, is_current, source FROM documents WHERE id = $1',
          [documentId],
        )
      ).rows;
      assert.deepEqual(doc, run.expected.doc);

      const chunks = (
        await db.query<{ content_hash: string; section_path: string[] | null; page_start: number | null; page_end: number | null; chunk_kind: string; metadata: Record<string, unknown> | null }>(
          'SELECT content_hash, section_path, page_start, page_end, chunk_kind, metadata FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
          [documentId],
        )
      ).rows;
      const actual: ReferenceChunk[] = chunks.map((chunk) => ({
        content_hash: chunk.content_hash,
        section_path: chunk.section_path,
        page_start: chunk.page_start,
        page_end: chunk.page_end,
        chunk_kind: chunk.chunk_kind,
        metadata_keys: Object.keys(chunk.metadata ?? {})
          .filter((key) => !LATER_PHASE_METADATA_KEYS.has(key))
          .sort(),
        parser_used: (chunk.metadata?.parser_used as string | undefined) ?? null,
      }));
      assert.ok(actual.length > 0);
      assert.deepEqual(actual, run.expected.chunks);

      assert.deepEqual(await queueRowCounts(), zeroCounts);
    });
  }

  test('after every write path ran, no ledger, cache or budget row exists and no document is flagged by a Phase 3.1 column', async () => {
    assert.deepEqual(await queueRowCounts(), zeroCounts);
    const flagged = (
      await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM documents WHERE needs_review OR provisional OR parse_cache_id IS NOT NULL',
      )
    ).rows[0]?.n;
    assert.equal(flagged, 0);
    const documents = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM documents')).rows[0]?.n;
    assert.equal(documents, reference.runs.length);
  });
  test('after every write path ran, no Phase 3.3 row, column value, metadata key, fingerprint part or page-text artifact exists (D-37)', async () => {
    assert.deepEqual(await queueRowCounts(PHASE_33_TABLES), Object.fromEntries(PHASE_33_TABLES.map((table) => [table, 0])));
    const documents = (
      await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM documents WHERE attributes IS NOT NULL OR attribute_header IS NOT NULL OR attribute_header_stamp IS NOT NULL',
      )
    ).rows[0]?.n;
    assert.equal(documents, 0);
    const chunks = (
      await db.query<{ n: number }>('SELECT count(*)::int AS n FROM document_chunks WHERE attributes IS NOT NULL OR attribute_header_stamp IS NOT NULL')
    ).rows[0]?.n;
    assert.equal(chunks, 0);
    const docKeys = (
      await db.query<{ n: number }>('SELECT count(*)::int AS n FROM documents WHERE COALESCE(metadata, \'{}\'::jsonb) ?| $1::text[]', [PHASE_33_DOCUMENT_METADATA_KEYS])
    ).rows[0]?.n;
    assert.equal(docKeys, 0);
    const chunkKeys = (
      await db.query<{ n: number }>('SELECT count(*)::int AS n FROM document_chunks WHERE COALESCE(metadata, \'{}\'::jsonb) ?| $1::text[]', [PHASE_33_CHUNK_METADATA_KEYS])
    ).rows[0]?.n;
    assert.equal(chunkKeys, 0);
    const chunkPrep = (
      await db.query<{ n: number }>("SELECT count(*)::int AS n FROM documents WHERE metadata -> 'ingest_fingerprint_parts' ? 'chunk_prep'")
    ).rows[0]?.n;
    assert.equal(chunkPrep, 0);
    const keys = objectStore?.keys() ?? [];
    assert.ok(keys.length > 0, 'the write paths stored no object');
    assert.deepEqual(keys.filter((key) => key.endsWith(PAGE_TEXTS_ARTIFACT_NAME)), []);
  });

  test('with every pipeline and language variable unset, the default upload and retrieval never call the language settings (D-02)', async () => {
    const settings = await import('@/lib/rag/lang/settings');
    const ingestDeps = await import('@/lib/rag/ingest/deps');
    const ragConfig = await import('@/lib/rag/config');
    const ingestConfig = await import('@/lib/rag/ingest/config');
    const names = ['RAG_PIPELINE', 'RAG_INGEST_PIPELINE', 'RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'];
    const before = new Map(names.map((name) => [name, process.env[name]]));
    const previousEnv = ingestDeps.getIngestDeps().ingestEnv;
    for (const name of names) delete process.env[name];
    let trapped = 0;
    settings.resetLanguageSettingsForTests();
    settings.setLanguageSettingsTrapForTests(() => {
      trapped += 1;
      throw new Error('[Defaults Test] the language settings were read on the legacy path');
    });
    ingestDeps.setIngestDepsForTests({ ingestEnv: () => ({ ...previousEnv(), RAG_INGEST_PIPELINE: undefined }) });
    ragConfig.resetRagConfigForTests();
    ingestConfig.resetIngestConfigForTests();
    try {
      assert.equal(rag.currentIngestConfig().pipeline, 'legacy');
      assert.equal(rag.loadRagConfig({}).pipeline, 'legacy');
      const run = reference.runs.find((candidate) => candidate.text !== undefined) ?? reference.runs[0];
      const input: Record<string, unknown> = {
        scope,
        source: run.source,
        sourceKey: `${run.sourceKey}-defaults-unset`,
        filename: run.filename,
        mimeType: run.mimeType,
        signal: new AbortController().signal,
        ...(run.docType ? { docType: run.docType } : {}),
        ...(run.options ? { options: run.options } : {}),
      };
      if (run.text !== undefined) input.text = run.text;
      else input.file = new Uint8Array(fs.readFileSync(path.join(process.cwd(), String(run.file))));
      const result = await rag.submitIngest(input as unknown as Parameters<typeof rag.submitIngest>[0]);
      assert.notEqual(result.status, 'failed');

      const retrieved = await rag.runRetrieval({
        scope,
        query: 'placeholder question for the defaults check',
        profile: 'eval',
        options: { maxResults: 5, fallbackToLowerThreshold: true },
        signal: new AbortController().signal,
      });
      assert.notEqual(retrieved.reason, 'languages_not_configured');
      assert.equal(trapped, 0);
    } finally {
      settings.setLanguageSettingsTrapForTests(null);
      ingestDeps.setIngestDepsForTests({ ingestEnv: previousEnv });
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      settings.resetLanguageSettingsForTests();
      ragConfig.resetRagConfigForTests();
      ingestConfig.resetIngestConfigForTests();
    }
  });

  test('with every Phase 3.3 switch unset, no Phase 3.3 function was called by the write paths, legacy retrieval or a v2 retrieval (D-37)', async () => {
    const ragConfig = await import('@/lib/rag/config');
    const names = ['RAG_PIPELINE', 'RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'];
    const before = new Map(names.map((name) => [name, process.env[name]]));
    process.env.RAG_PIPELINE = 'v2';
    process.env.RAG_SUPPORTED_LANGUAGES = 'en';
    process.env.RAG_PRIMARY_LANGUAGE = 'en';
    ragConfig.resetRagConfigForTests();
    try {
      for (const name of PHASE_33_SWITCHES) assert.equal(process.env[name], undefined, name);
      const retrieved = await rag.runRetrieval({
        scope,
        query: 'placeholder question for the Phase 3.3 defaults check',
        profile: 'eval',
        options: { maxResults: 5, fallbackToLowerThreshold: true },
        signal: new AbortController().signal,
      });
      assert.notEqual(retrieved.reason, 'languages_not_configured');
      assert.ok(!(retrieved.stages ?? []).some((stage) => stage.name === 'attribute_resolve' && stage.status !== 'disabled'), 'attribute_resolve ran');
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      ragConfig.resetRagConfigForTests();
    }
    const phase33 = phase33RpcNames();
    assert.ok(phase33.size >= 30, `parsed ${phase33.size} Phase 3.3 functions`);
    assert.ok(edge.calls.length > 0, 'the fake edge recorded no call');
    const called = edge.calls
      .map((call) => /^\/rest\/v1\/rpc\/([a-z0-9_]+)/.exec(call.path)?.[1])
      .filter((name): name is string => name !== undefined && phase33.has(name));
    assert.deepEqual([...new Set(called)], []);
  });
});
