import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

const TEXT = '# Metadata parity sample\n\nWarehouse aisle seven stores the zqxmeta token for parity checks.\n';
const TEXT_META_KEYS = [
  'section_path',
  'doc_type',
  'language',
  'content_hash',
  'chunk_kind',
  'parser_used',
  'embedding_model',
  'embedding_dims',
  'urls',
  'has_urls',
  'url_count',
  'url_categories',
] as const;
const PROMOTED = [
  'tenant_key',
  'document_id',
  'version',
  'is_current',
  'source',
  'doc_type',
  'language',
  'content_hash',
  'parser_used',
] as const;

type Row = Record<string, unknown>;

describe('write-path metadata parity under unified ingest', () => {
  let db: Awaited<ReturnType<typeof createEmptyFixtureDatabase>>['db'];
  let edge: Awaited<ReturnType<typeof startFakeEdge>>;
  let uninstall: (() => Promise<void>) | undefined;
  let scope: import('@/lib/rag/tenant/scope').TenantScope;
  const bySource = new Map<string, string>();

  before(async () => {
    const empty = await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' });
    db = empty.db;
    edge = await startFakeEdge({ db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    const { INGEST_MODE_FEATURE_ENV, fixtureAdminClient, installIngestFakes } = await import('../../eval/harness/ingest-fakes.mts');
    const fakes = await installIngestFakes({ db: fixtureAdminClient(edge.url), env: INGEST_MODE_FEATURE_ENV });
    uninstall = fakes.uninstall;
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const { buildSourceKey } = await import('@/lib/rag/ingest/identity');
    const { ingest } = await import('@/lib/rag/ingest');
    scope = mintScope('single', null, null);
    const signal = new AbortController().signal;
    const runs: Array<{
      source: import('@/lib/rag/ingest/types').IngestSource;
      key: string;
      filename: string;
      text: string;
      extra?: Record<string, unknown>;
    }> = [
      {
        source: 'chat_upload',
        key: buildSourceKey('chat_upload', { filename: 'metadata-parity-chat.md' }),
        filename: 'metadata-parity-chat.md',
        text: `${TEXT}\nchat upload path.\n`,
      },
      {
        source: 'config_upload',
        key: buildSourceKey('config_upload', { filename: 'metadata-parity-config.md' }),
        filename: 'metadata-parity-config.md',
        text: `${TEXT}\nconfig upload path.\n`,
      },
      {
        source: 'nango',
        key: buildSourceKey('nango', { providerFileId: 'drive-file-parity' }),
        filename: 'metadata-parity-nango.md',
        text: `${TEXT}\nnango path.\n`,
        extra: {
          origin: { sourceProvider: 'google-drive', sourceFileId: 'drive-file-parity', sourceConnectionId: 'conn-parity' },
          nangoConnectionId: 'conn-parity',
          nangoFolderId: 'folder-parity',
        },
      },
      {
        source: 'scraper',
        key: buildSourceKey('scraper', { url: 'https://example.invalid/metadata-parity' }),
        filename: 'metadata-parity-scraper.md',
        text: `${TEXT}\nscraper path.\n`,
        extra: {
          origin: {
            sourceProvider: 'firecrawl',
            sourceFileId: 'https://example.invalid/metadata-parity',
            sourceConnectionId: 'firecrawl-single',
            externalUrl: 'https://example.invalid/metadata-parity',
          },
        },
      },
    ];
    for (const run of runs) {
      const result = await ingest({
        scope,
        source: run.source,
        sourceKey: run.key,
        text: run.text,
        filename: run.filename,
        mimeType: 'text/markdown',
        docType: 'general',
        options: run.extra,
        signal,
      });
      assert.equal(result.status, 'ready', `${run.source} ingest`);
      assert.ok(result.documentId);
      bySource.set(run.source, result.documentId);
    }
    const { installFakePublicImageStore } = await import('../helpers/fake-public-image-store.ts');
    installFakePublicImageStore();
    const { setCaptionerForTests } = await import('@/lib/rag/ingest/captioner');
    const captions = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/ingest/caption-recorded.json'), 'utf8')) as {
      captions: { chart: string };
    };
    setCaptionerForTests(async () => captions.captions.chart);
    const imageStoragePath = 'user-parity/pic_1_parity.png';
    const imageUrl = `https://project.example.test/storage/v1/object/public/chat-images/${imageStoragePath}?download`;
    const png = fs.readFileSync(path.join('eval/fixtures/ingest/recorded/images-en.picture-1.png'));
    const image = await ingest({
      scope,
      source: 'image_upload',
      sourceKey: buildSourceKey('image_upload', { storagePath: imageStoragePath }),
      file: new Uint8Array(png),
      filename: 'parity-diagram.png',
      mimeType: 'image/png',
      docType: 'general',
      options: { imageUrl, imageContext: 'Parity diagram for aisle seven.' },
      signal,
    });
    assert.equal(image.status, 'ready');
    bySource.set('image_upload', image.documentId!);
  });

  after(async () => {
    await uninstall?.();
    await edge?.close();
    await db?.close();
  });

  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query<Row>(sql, params)).rows;

  const chunkRow = async (documentId: string): Promise<Row> => {
    const [row] = await rows(
      `SELECT tenant_key, document_id, version, is_current, source, doc_type, language, content_hash, parser_used,
              page_start, section_path, metadata
       FROM document_chunks WHERE document_id = $1 AND status = 'ready' ORDER BY chunk_index LIMIT 1`,
      [documentId],
    );
    assert.ok(row, documentId);
    return row;
  };

  for (const source of ['chat_upload', 'config_upload', 'nango', 'scraper'] as const) {
    test(`${source} stores promoted columns and metadata keys on its chunk`, async () => {
      const row = await chunkRow(bySource.get(source)!);
      for (const column of PROMOTED) assert.ok(row[column] != null && row[column] !== '', column);
      assert.ok(row.page_start != null || (row.section_path as string[] | null)?.length, 'page_start or section_path');
      const metadata = row.metadata as Record<string, unknown>;
      for (const key of TEXT_META_KEYS) assert.ok(key in metadata, key);
    });
  }

  test('image_upload adds image_url and matches the text-path metadata key set otherwise', async () => {
    const row = await chunkRow(bySource.get('image_upload')!);
    for (const column of PROMOTED) assert.ok(row[column] != null && row[column] !== '', column);
    const metadata = row.metadata as Record<string, unknown>;
    assert.ok(metadata.image_url);
    for (const key of TEXT_META_KEYS) assert.ok(key in metadata, key);
  });

  test('text write paths share the same metadata key set', async () => {
    const sets = await Promise.all(
      (['chat_upload', 'config_upload', 'nango', 'scraper'] as const).map(async (source) => {
        const row = await chunkRow(bySource.get(source)!);
        return Object.keys(row.metadata as Record<string, unknown>).sort();
      }),
    );
    for (const keys of sets.slice(1)) assert.deepEqual(keys, sets[0]);
  });
});