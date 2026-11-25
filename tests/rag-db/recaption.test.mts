import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const VOYAGE = 'voyage-4-large-2048';

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string;
}

const A: Tenant = { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA };
const B: Tenant = { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB };

/** Neutral synthetic text: a Chinese document body, English captions written before the switch, and a Chinese caption quoting an accented word. */
const ZH_BODY = '这是一份用于测试的示例说明，内容完全是虚构的，只用来检查图片说明的语言。';
const EN_CAPTION_1 = 'A white card with three blue lines and a small grey circle in the lower corner.';
const EN_CAPTION_2 = 'A square diagram with two arrows pointing to a round box in the middle of the page.';
const ZH_CAPTION_OLD = '图片中是一个蓝色的正方形，旁边有两个白色的圆点。';
const ZH_CAPTION_NEW = '图片中是一张白色卡片，卡片中央印着“Novità”这个词，下方有三条蓝色横线。';

function vector(dims: number, hot: number): number[] {
  return Array.from({ length: dims }, (_, index) => (index === hot % dims ? 1 : 0));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let sequence = 0;

describe('recaption (rag:reembed --recaption, migration 0813)', () => {
  let fixture: TwoTenantDatabase;
  let edge: import('../../eval/harness/fake-edge.mts').FakeEdge;
  let recaption: typeof import('@/lib/rag/ingest/reembed/recaption');
  let cliModule: typeof import('@/lib/rag/ingest/reembed/cli');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let configModule: typeof import('@/lib/rag/ingest/config');
  let settingsModule: typeof import('@/lib/rag/lang/settings');
  let lexical: typeof import('@/lib/rag/lexical/tokenize');
  let sidecarModule: typeof import('@/lib/rag/ingest/parsers/sidecar-docling');
  let llamaModule: typeof import('@/lib/rag/ingest/parsers/llamaparse-v2');
  let voyageModel = '';
  let parserCalls = 0;

  before(async () => {
    const { fixtureProcessEnv, startFakeEdge } = await import('../../eval/harness/fake-edge.mts');
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    recaption = await import('@/lib/rag/ingest/reembed/recaption');
    cliModule = await import('@/lib/rag/ingest/reembed/cli');
    depsModule = await import('@/lib/rag/ingest/deps');
    configModule = await import('@/lib/rag/ingest/config');
    settingsModule = await import('@/lib/rag/lang/settings');
    lexical = await import('@/lib/rag/lexical/tokenize');
    sidecarModule = await import('@/lib/rag/ingest/parsers/sidecar-docling');
    llamaModule = await import('@/lib/rag/ingest/parsers/llamaparse-v2');
    voyageModel = String((await rows('SELECT model FROM embedding_profiles WHERE id = $1', [VOYAGE]))[0]?.model);
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;
  const errorOf = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    try {
      await fixture.db.query(sql, params);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  };
  const db = () => depsModule.getIngestDeps().db() as import('@/lib/rag/backend/supabase-rpc').RpcClient;

  const useCaptionMode = (mode: 'en' | 'document') => {
    configModule.resetIngestConfigForTests();
    depsModule.setIngestDepsForTests({
      ingestEnv: () => ({ RAG_CAPTION_LANGUAGE: mode }),
      embedDocuments: async (texts) => texts.map((text) => vector(1536, text.length + 7)),
    });
  };

  beforeEach(async () => {
    await fixture.db.query('DELETE FROM rag_recaption_runs');
    await fixture.db.query('DELETE FROM chunk_embeddings');
    await fixture.db.query("UPDATE document_chunks SET is_current = false WHERE chunk_kind = 'image'");
    useCaptionMode('document');
    settingsModule.resetLanguageSettingsForTests();
    parserCalls = 0;
    const counting = (name: 'docling' | 'llamaparse') => ({
      name,
      unavailableReason: () => null,
      async parse(): Promise<never> {
        parserCalls += 1;
        throw new Error('no parser call is expected');
      },
    });
    sidecarModule.setSidecarParserForTests(counting('docling') as never);
    llamaModule.setLlamaParseParserForTests(counting('llamaparse') as never);
  });

  afterEach(() => {
    sidecarModule.resetSidecarParserForTests();
    llamaModule.resetLlamaParseParserForTests();
    depsModule.resetIngestDepsForTests();
    configModule.resetIngestConfigForTests();
  });

  interface SeededImage {
    chunkId: string;
    url: string;
  }

  /** A published document in the tenant: Chinese text chunks and image chunks with stored URLs, all with legacy vectors. */
  async function seedDocument(tenant: Tenant, captions: string[], options: { language?: string; textChunks?: number } = {}): Promise<{ documentId: string; images: SeededImage[]; textIds: string[] }> {
    const sourceKey = `recaption-${++sequence}.pdf`;
    const begun = await rows(
      `SELECT * FROM rag_begin_document_version(
         p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => NULL, p_source => 'config_upload', p_source_key => $3, p_filename => $3,
         p_file_sha256 => $4, p_doc_type => 'general', p_doc_type_origin => 'fallback', p_profile_id => 'general-1', p_profile_version => 1)`,
      [tenant.key, tenant.userId, sourceKey, crypto.createHash('sha256').update(`${sourceKey}:${sequence}`).digest('hex')],
    );
    const documentId = String(begun[0]?.document_id);
    await rows('SELECT * FROM rag_set_document_fields(p_document_id => $1, p_tenant_key => $2, p_fields => $3::jsonb)', [
      documentId,
      tenant.key,
      JSON.stringify({ language: options.language ?? 'zh' }),
    ]);
    const textCount = options.textChunks ?? 1;
    const urls = captions.map((_, index) => `https://project.example.test/storage/v1/object/public/chat-images/rag/${tenant.key}/${documentId}/p${index + 1}-1.png`);
    const chunks = [
      ...Array.from({ length: textCount }, (_, index) => ({
        content: ZH_BODY,
        chunk_index: index,
        section_path: ['示例'],
        chunk_kind: 'text',
        embedding_text_version: 1,
        lexical_text: 'old text',
        metadata: {},
      })),
      ...captions.map((caption, index) => ({
        content: caption,
        chunk_index: textCount + index,
        section_path: ['示例'],
        chunk_kind: 'image',
        embedding_text_version: 1,
        lexical_text: lexical.lexicalText(['示例'], caption),
        content_hash: `hash-${index}`,
        metadata: { image_url: urls[index], image_type: 'image/png' },
      })),
    ];
    await rows('SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => $5)', [
      documentId,
      tenant.key,
      JSON.stringify(chunks),
      JSON.stringify({ [LEGACY]: chunks.map((_, index) => vector(1536, index + 100)) }),
      chunks.length,
    ]);
    await rows('SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [documentId, tenant.key]);
    const ids = await rows('SELECT id, chunk_kind, metadata FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId]);
    return {
      documentId,
      images: ids.filter((row) => row.chunk_kind === 'image').map((row) => ({ chunkId: String(row.id), url: String((row.metadata as Row).image_url) })),
      textIds: ids.filter((row) => row.chunk_kind !== 'image').map((row) => String(row.id)),
    };
  }

  async function addVoyageVector(chunkId: string, tenantKey: string): Promise<void> {
    await rows(
      `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
       VALUES ($1, $2, $3, $4::halfvec, $5, 2048, 'seed')`,
      [chunkId, VOYAGE, tenantKey, JSON.stringify(vector(2048, 3)), voyageModel],
    );
  }

  const chunkState = async (id: string): Promise<Row> =>
    (
      await rows(
        `SELECT c.content, c.content_hash, c.lexical_text, c.language, c.metadata, c.embedding::text AS legacy,
                (SELECT e.embedding::text FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = $2) AS voyage,
                (SELECT e.embedding_host FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = $2) AS voyage_host
           FROM document_chunks c WHERE c.id = $1`,
        [id, VOYAGE],
      )
    )[0] as Row;

  const tableSnapshot = async (): Promise<string> =>
    JSON.stringify(
      await rows(
        `SELECT c.id, c.content, c.lexical_text, c.language, c.metadata, c.embedding::text AS legacy FROM document_chunks c ORDER BY c.id`,
      ),
    ) + JSON.stringify(await rows('SELECT chunk_id, profile_id, embedding::text, embedding_host FROM chunk_embeddings ORDER BY chunk_id, profile_id'));

  interface FakeDeps {
    captions: Array<{ url: string; target: string | null | undefined }>;
    fetched: string[];
    embedded: Array<{ profile: string; dims: number }>;
    deps: import('@/lib/rag/ingest/reembed/recaption').RecaptionDeps;
  }

  /** A fixture vision model and embedder: every caption is the Chinese one, every profile gets a vector of its size. */
  function fakeDeps(caption = ZH_CAPTION_NEW): FakeDeps {
    const state: FakeDeps = {
      captions: [],
      fetched: [],
      embedded: [],
      deps: {
        fetchImage: async (url) => {
          state.fetched.push(url);
          return { bytes: new TextEncoder().encode(url), mimeType: 'image/png' };
        },
        caption: async (bytes, _mime, options) => {
          state.captions.push({ url: new TextDecoder().decode(bytes), target: options.targetLanguage });
          return caption;
        },
        embed: async (profile, texts) => {
          state.embedded.push({ profile: profile.id, dims: profile.dims });
          return texts.map(() => vector(profile.dims, 11));
        },
      },
    };
    return state;
  }

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }, out, err };
  }

  test('the image chunk language setter changes only image chunks of the named URLs, in the caller tenant, for service_role only', async () => {
    const doc = await seedDocument(A, [EN_CAPTION_1, EN_CAPTION_2]);
    const items = JSON.stringify([{ image_url: doc.images[0]!.url, language: 'en' }]);
    const result = await rows('SELECT * FROM rag_set_image_chunk_languages($1, $2, $3::jsonb)', [doc.documentId, A.key, items]);
    assert.equal(Number(result[0]?.chunks_updated), 1);
    assert.equal((await chunkState(doc.images[0]!.chunkId)).language, 'en');
    assert.equal(((await chunkState(doc.images[0]!.chunkId)).metadata as Row).language, 'en');
    assert.equal((await chunkState(doc.images[1]!.chunkId)).language, 'zh');
    assert.equal((await chunkState(doc.textIds[0]!)).language, 'zh');

    assert.match(String(await errorOf('SELECT * FROM rag_set_image_chunk_languages($1, $2, $3::jsonb)', [doc.documentId, B.key, items])), /tenant_mismatch/);
    const bad = JSON.stringify([{ image_url: doc.images[0]!.url, language: 'EN; drop' }]);
    assert.match(String(await errorOf('SELECT * FROM rag_set_image_chunk_languages($1, $2, $3::jsonb)', [doc.documentId, A.key, bad])), /invalid_items/);
    for (const role of ['anon', 'authenticated']) {
      await fixture.db.exec(`SET ROLE ${role}`);
      try {
        assert.match(String(await errorOf('SELECT * FROM rag_set_image_chunk_languages($1, $2, $3::jsonb)', [doc.documentId, A.key, items])), /permission denied/);
        assert.match(String(await errorOf('SELECT * FROM rag_recaption_candidates(NULL, NULL, 10)')), /permission denied/);
        assert.match(String(await errorOf("SELECT * FROM rag_recaption_rollback_run(gen_random_uuid(), 'x')")), /permission denied/);
        assert.match(String(await errorOf('SELECT * FROM rag_recaption_items')), /permission denied/);
      } finally {
        await fixture.db.exec('RESET ROLE');
      }
    }
  });

  test('--recaption --dry-run lists only image chunks whose caption language differs from the target, with a cost, and writes nothing', async () => {
    await seedDocument(A, [EN_CAPTION_1, ZH_CAPTION_OLD]);
    await seedDocument(B, [EN_CAPTION_2]);
    const before = await tableSnapshot();
    const { io, out, err } = capture();
    assert.equal(await cliModule.main(['--recaption', '--dry-run'], io), 0, err.join('\n'));
    assert.equal(await tableSnapshot(), before);
    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM rag_recaption_runs'))[0]?.n), 0);
    assert.ok(out.includes('[Recaption] dry run, nothing written'));
    assert.ok(out.includes(`[Recaption] ${A.key}: image chunks 2, to recaption 1`), out.join('\n'));
    assert.ok(out.includes(`[Recaption] ${B.key}: image chunks 1, to recaption 1`), out.join('\n'));
    const total = out.find((line) => line.startsWith('[Recaption] total:')) ?? '';
    assert.match(total, /to recaption 2, estimated cost 0\.01\d* USD/);
    assert.ok(!out.join('\n').includes(EN_CAPTION_1), 'no caption text is printed');
    assert.equal(parserCalls, 0);

    const report = await recaption.dryRunRecaption({ db: db(), tenantKey: A.key });
    assert.deepEqual(report.tenants, [{ tenantKey: A.key, imageChunks: 2, toRecaption: 1 }]);
    assert.ok(report.embeddingUsd > 0 && report.visionUsd === recaption.VISION_USD_PER_IMAGE_ESTIMATE);
  });

  test('a run rewrites content, lexical text, language and every vector of the chunks in another language, keeps the previous caption, and touches tenant B not at all', async () => {
    const a = await seedDocument(A, [EN_CAPTION_1, ZH_CAPTION_OLD]);
    const b = await seedDocument(B, [EN_CAPTION_2]);
    await addVoyageVector(a.images[0]!.chunkId, A.key);
    const untouchedA = await chunkState(a.images[1]!.chunkId);
    const textBefore = await chunkState(a.textIds[0]!);
    const tenantBBefore = await chunkState(b.images[0]!.chunkId);
    const firstBefore = await chunkState(a.images[0]!.chunkId);

    const fake = fakeDeps();
    const report = await recaption.runRecaption({ db: db(), tenantKey: A.key, deps: fake.deps });
    assert.equal(report.status, 'completed');
    assert.equal(report.parserCalls, 0);
    assert.equal(parserCalls, 0);
    assert.deepEqual({ examined: report.examined, eligible: report.eligible, recaptioned: report.recaptioned }, { examined: 2, eligible: 1, recaptioned: 1 });
    assert.deepEqual(fake.captions, [{ url: a.images[0]!.url, target: 'zh' }]);
    assert.deepEqual(fake.embedded.map((entry) => entry.profile).sort(), [LEGACY, VOYAGE]);

    const first = await chunkState(a.images[0]!.chunkId);
    assert.equal(first.content, ZH_CAPTION_NEW);
    assert.ok(String(first.content).includes('Novità'));
    assert.equal(first.lexical_text, lexical.lexicalText(['示例'], ZH_CAPTION_NEW));
    assert.equal(first.language, 'zh');
    const metadata = first.metadata as Row;
    assert.equal(metadata.previous_caption, EN_CAPTION_1);
    assert.equal(metadata.caption_language, 'zh');
    assert.equal(metadata.recaption_run_id, report.runId);
    assert.equal(metadata.image_url, a.images[0]!.url);
    assert.notEqual(first.legacy, firstBefore.legacy);
    assert.notEqual(first.voyage, firstBefore.voyage);
    assert.equal(first.voyage_host, 'recaption');

    assert.deepEqual(await chunkState(a.images[1]!.chunkId), untouchedA);
    assert.deepEqual(await chunkState(a.textIds[0]!), textBefore);
    assert.deepEqual(await chunkState(b.images[0]!.chunkId), tenantBBefore);
    const run = (await rows('SELECT * FROM rag_recaption_runs WHERE id = $1', [report.runId]))[0] as Row;
    assert.equal(run.status, 'completed');
    assert.equal(run.tenant_key, A.key);
    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM rag_recaption_items WHERE run_id = $1', [report.runId]))[0]?.n), 1);
  });

  test('the database refuses a write that leaves out a profile holding a vector, or names a chunk outside the run tenant', async () => {
    const a = await seedDocument(A, [EN_CAPTION_1]);
    const b = await seedDocument(B, [EN_CAPTION_2]);
    await addVoyageVector(a.images[0]!.chunkId, A.key);
    const run = (await rows("SELECT * FROM rag_recaption_start_run($1, 'test')", [A.key]))[0] as Row;
    const write = (chunkId: string, vectors: Record<string, number[]>) =>
      errorOf("SELECT * FROM rag_recaption_write_chunk($1, $2, 'caption', 'h', 'caption', 'en', $3::jsonb)", [run.run_id, chunkId, JSON.stringify(vectors)]);
    assert.match(String(await write(a.images[0]!.chunkId, { [LEGACY]: vector(1536, 1) })), /vectors_mismatch/);
    assert.match(String(await write(b.images[0]!.chunkId, { [LEGACY]: vector(1536, 1) })), /chunk_not_eligible/);
    assert.match(String(await write(a.images[0]!.chunkId, { [LEGACY]: vector(1536, 1), [VOYAGE]: vector(12, 1) })), /dims/);
    assert.equal((await chunkState(a.images[0]!.chunkId)).content, EN_CAPTION_1);
  });

  test('an interrupted run resumes from the cursor and captions no chunk twice; rollback is refused while it was just running', async () => {
    const a = await seedDocument(A, [EN_CAPTION_1, EN_CAPTION_2]);
    const second = await seedDocument(A, [EN_CAPTION_2]);
    const eligible = [...a.images, ...second.images].map((image) => image.chunkId).sort();
    const fake = fakeDeps();
    const controller = new AbortController();
    let runId = '';
    await assert.rejects(
      recaption.runRecaption({
        db: db(),
        tenantKey: A.key,
        batchSize: 2,
        deps: fake.deps,
        signal: controller.signal,
        hooks: {
          afterWrite: (info) => {
            runId = info.runId;
            if (info.written === 1) controller.abort(new Error('interrupted'));
          },
        },
      }),
    );
    const stopped = (await rows('SELECT status, cursor_chunk_id FROM rag_recaption_runs WHERE id = $1', [runId]))[0] as Row;
    assert.equal(stopped.status, 'running');
    assert.equal(stopped.cursor_chunk_id, eligible[0]);
    const { io, err } = capture();
    assert.equal(await cliModule.main(['--recaption', '--rollback', runId], io), 1);
    assert.match(err.join('\n'), /run_in_progress/);

    const report = await recaption.runRecaption({ db: db(), resumeRunId: runId, deps: fake.deps });
    assert.equal(report.status, 'completed');
    assert.equal(report.resumed, true);
    assert.equal(report.recaptioned, 2);
    assert.equal(fake.captions.length, 3);
    assert.equal(new Set(fake.captions.map((entry) => entry.url)).size, 3);
    for (const id of eligible) assert.equal((await chunkState(id)).content, ZH_CAPTION_NEW);
  });

  test('--rollback restores caption, lexical text, language, metadata and both vectors of the run chunks', async () => {
    const a = await seedDocument(A, [EN_CAPTION_1, ZH_CAPTION_OLD]);
    await addVoyageVector(a.images[0]!.chunkId, A.key);
    const before = await chunkState(a.images[0]!.chunkId);
    const report = await recaption.runRecaption({ db: db(), tenantKey: A.key, deps: fakeDeps().deps });
    assert.equal(report.recaptioned, 1);
    assert.notEqual((await chunkState(a.images[0]!.chunkId)).content, before.content);

    const { io, out, err } = capture();
    assert.equal(await cliModule.main(['--recaption', '--rollback', report.runId], io), 0, err.join('\n'));
    assert.match(out.join('\n'), /restored 1 chunks/);
    const restored = await chunkState(a.images[0]!.chunkId);
    assert.deepEqual({ ...restored, voyage_host: null }, { ...before, voyage_host: null });
    assert.equal(restored.voyage_host, 'seed');
    assert.ok(!('previous_caption' in (restored.metadata as Row)));
    assert.equal((await rows('SELECT status FROM rag_recaption_runs WHERE id = $1', [report.runId]))[0]?.status, 'rolled_back');
    assert.equal(await cliModule.main(['--recaption', '--rollback', report.runId], capture().io), 1);
  });

  test('the mode needs RAG_CAPTION_LANGUAGE=document and configured languages, and says so', async () => {
    await seedDocument(A, [EN_CAPTION_1]);
    useCaptionMode('en');
    await assert.rejects(recaption.runRecaption({ db: db(), deps: fakeDeps().deps }), (error: unknown) => (error as { code?: string }).code === 'caption_language_not_document');
    const { io, err } = capture();
    assert.equal(await cliModule.main(['--recaption', '--dry-run'], io), 2);
    assert.match(err.join('\n'), /RAG_CAPTION_LANGUAGE=document/);

    useCaptionMode('document');
    const saved = process.env.RAG_SUPPORTED_LANGUAGES;
    process.env.RAG_SUPPORTED_LANGUAGES = '';
    settingsModule.resetLanguageSettingsForTests();
    try {
      await assert.rejects(recaption.runRecaption({ db: db(), deps: fakeDeps().deps }), (error: unknown) => (error as { code?: string }).code === 'languages_not_configured');
    } finally {
      process.env.RAG_SUPPORTED_LANGUAGES = saved;
      settingsModule.resetLanguageSettingsForTests();
    }
    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM rag_recaption_runs'))[0]?.n), 0);
  });

  test('the purge hook removes the stored previous captions of the purged documents in the tenant only', async () => {
    const a = await seedDocument(A, [EN_CAPTION_1]);
    const b = await seedDocument(B, [EN_CAPTION_2]);
    await recaption.runRecaption({ db: db(), deps: fakeDeps().deps });
    assert.equal(Number((await rows('SELECT count(*)::int AS n FROM rag_recaption_items'))[0]?.n), 2);
    const removed = await rows('SELECT public.rag_purge_hook_recaption($1, NULL, $2::uuid[]) AS n', [A.key, [a.documentId, b.documentId]]);
    assert.equal(Number(removed[0]?.n), 1);
    assert.deepEqual(
      (await rows('SELECT document_id FROM rag_recaption_items')).map((row) => row.document_id),
      [b.documentId],
    );
  });

  test('argument parsing keeps the re-embed modes and adds the recaption ones', () => {
    assert.deepEqual(cliModule.parseReembedArgs(['--recaption', '--dry-run', '--tenant', A.key]), { ok: true, mode: 'recaption', tenantKey: A.key, batchSize: 32, dryRun: true });
    const id = crypto.randomUUID();
    assert.deepEqual(cliModule.parseReembedArgs(['--recaption', '--rollback', id]), { ok: true, mode: 'recaption-rollback', runId: id });
    assert.deepEqual(cliModule.parseReembedArgs(['--recaption', '--resume', id]), { ok: true, mode: 'recaption-resume', runId: id, tenantKey: null, batchSize: 32 });
    assert.equal(cliModule.parseReembedArgs(['--recaption', '--profile', VOYAGE]).ok, false);
    assert.equal(cliModule.parseReembedArgs(['--recaption', '--rollback', id, '--tenant', A.key]).ok, false);
    assert.deepEqual(cliModule.parseReembedArgs(['--rollback', id]), { ok: true, mode: 'rollback', runId: id });
  });
});
