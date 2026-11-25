import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

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
  let rag: typeof import('@/lib/rag');
  let queueConfig: typeof import('@/lib/rag/ingest/queue-config');
  let scope: import('@/lib/rag/tenant/scope').TenantScope;
  const saved = new Map<string, string | undefined>();

  before(async () => {
    for (const name of [...PHASE_31_SWITCHES, 'RAG_INGEST_PIPELINE', 'RAG_INGEST_WORKER']) {
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
    const { INGEST_MODE_ENV, fixtureAdminClient, installIngestFakes } = await import('../../eval/harness/ingest-fakes.mts');
    const fakes = await installIngestFakes({ db: fixtureAdminClient(edge.url), env: INGEST_MODE_ENV });
    uninstall = fakes.uninstall;
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

  const queueRowCounts = async (): Promise<Record<string, number>> => {
    const counts: Record<string, number> = {};
    for (const table of QUEUE_TABLES) {
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
});
