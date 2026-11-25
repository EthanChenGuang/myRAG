import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParseResult } from '@/lib/rag-eval/contracts.generated';
import { ingest } from '@/lib/rag/ingest';
import { resetCaptionerForTests, setCaptionerForTests } from '@/lib/rag/ingest/captioner';
import { resetLlamaParseParserForTests, setLlamaParseParserForTests } from '@/lib/rag/ingest/parsers/llamaparse-v2';
import { ParserError, type DocumentParser } from '@/lib/rag/ingest/parsers/shared';
import { resetSidecarParserForTests, setSidecarParserForTests } from '@/lib/rag/ingest/parsers/sidecar-docling';
import { resetPublicImageStoreForTests } from '@/lib/rag/ingest/images/public-store';
import { mintScope } from '@/lib/rag/tenant/scope';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from '../../helpers/chat-route-fakes';
import { fixtureBytes } from '../../helpers/fake-sidecar';
import { installFakePublicImageStore } from '../../helpers/fake-public-image-store';
import { FAKE_DOCUMENT_ID, callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps } from '../../helpers/ingest-fakes';
import recorded from '../../fixtures/ingest/caption-recorded.json';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/document-processor', () => ({ getQueryEmbedding: vi.fn(async () => []) }));
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
  searchSimilarChunks: vi.fn(async () => []),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const RECORDED_DIR = join(process.cwd(), 'eval/fixtures/ingest/recorded');
const PARSE = JSON.parse(readFileSync(join(RECORDED_DIR, 'images-en.parse.json'), 'utf8')) as ParseResult;
const PICTURE_1 = new Uint8Array(readFileSync(join(RECORDED_DIR, 'images-en.picture-1.png')));
const PICTURE_2 = new Uint8Array(readFileSync(join(RECORDED_DIR, 'images-en.picture-2.png')));
const scope = mintScope('single', null, null);
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

interface IngestedChunk {
  content: string;
  chunk_kind: string;
  page_start: number | null;
  metadata: Record<string, unknown>;
}

/** The images fixture through the real ingest(): the chunks it writes are the rows the chat reads. */
async function ingestFixture(env: Record<string, string>): Promise<IngestedChunk[]> {
  const docling: DocumentParser = {
    name: 'docling',
    unavailableReason: () => null,
    async parse() {
      return {
        kind: 'done',
        result: PARSE,
        artifacts: [
          { name: 'picture-1.png', bytes: PICTURE_1, contentType: 'image/png' },
          { name: 'picture-2.png', bytes: PICTURE_2, contentType: 'image/png' },
        ],
        warnings: [],
      };
    },
  };
  setSidecarParserForTests(docling);
  setLlamaParseParserForTests({
    name: 'llamaparse',
    unavailableReason: () => 'missing_key',
    async parse() {
      throw new ParserError('llamaparse', 'missing_key');
    },
  });
  setCaptionerForTests(async (bytes) => (sameBytes(bytes, PICTURE_1) ? recorded.captions.chart : recorded.captions.logo));
  const { db, calls } = fakeIngestDb();
  installIngestDeps({ db, env });
  installFakePublicImageStore();
  const result = await ingest({
    scope,
    source: 'config_upload',
    sourceKey: 'root/images-en.pdf',
    file: fixtureBytes('images-en'),
    filename: 'images-en.pdf',
    mimeType: 'application/pdf',
    docType: 'product_technical',
    signal: new AbortController().signal,
  });
  expect(['ready', 'quarantined']).toContain(result.status);
  return callsOf(calls, 'rag_write_chunks').flatMap((call) => call.args.p_chunks as IngestedChunk[]);
}

async function loadRoute() {
  vi.resetModules();
  await installChatPipeline(h);
  return import('@/app/api/chat/route');
}

function seed(chunks: IngestedChunk[], order: Array<(chunk: IngestedChunk) => boolean>) {
  h.supabase.store.documents = [
    { id: FAKE_DOCUMENT_ID, filename: 'images-en.pdf', created_at: '2026-01-01T00:00:00.000Z', content: 'Example Sensor Hub Product Sheet', metadata: {} },
  ];
  const rows = chunks.map((chunk, index) => ({ id: `chunk-${index}`, document_id: FAKE_DOCUMENT_ID, content: chunk.content, metadata: chunk.metadata }));
  h.supabase.store.document_chunks = rows;
  const picked = order.flatMap((matches) => {
    const index = chunks.findIndex(matches);
    return index < 0 ? [] : [index];
  });
  h.retrieval.mockResolvedValue(
    retrievalWith(
      picked.map((index, rank) => ({
        chunk_id: `chunk-${index}`,
        document_id: FAKE_DOCUMENT_ID,
        content: chunks[index]!.content,
        similarity: 0.7 - rank * 0.1,
        metadata: chunks[index]!.metadata,
        temporal_score: 0,
        financial_score: 0,
        final_score: 0.7 - rank * 0.1,
        match_reason: 'similarity',
      })),
    ),
  );
}

async function ask() {
  const { POST } = await loadRoute();
  return POST(
    chatRequest({
      messages: [{ role: 'user', content: 'What does the front view of the example device show?' }],
      data: { ragMode: 'strict', settings: { webSearch: false } },
    }),
  );
}

const isImage = (chunk: IngestedChunk): boolean => chunk.chunk_kind === 'image' && chunk.page_start === 1;
const isText = (chunk: IngestedChunk): boolean => chunk.chunk_kind !== 'image';

describe('PDF image chunks in the chat', () => {
  let chunks: IngestedChunk[];

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.capture.reset();
    h.retrieval.mockReset();
    chunks = await ingestFixture({ RAG_PDF_IMAGE_CHUNKS: 'true', RAG_INJECTION_SCAN: 'quarantine' });
  });

  afterEach(() => {
    resetCaptionerForTests();
    resetSidecarParserForTests();
    resetLlamaParseParserForTests();
    resetPublicImageStoreForTests();
    uninstallIngestDeps();
    vi.restoreAllMocks();
  });

  it('ingests the fixture into text chunks and two image chunks whose metadata carries the stored image URL', () => {
    const images = chunks.filter((chunk) => chunk.chunk_kind === 'image');
    expect(images).toHaveLength(2);
    expect(images.every((chunk) => String(chunk.metadata.image_url).includes('/chat-images/rag/'))).toBe(true);
  });

  it('streams the image chunk of the PDF as source_images before the first text delta', async () => {
    seed(chunks, [isImage, isText]);
    const imageUrl = String(chunks.find(isImage)!.metadata.image_url);

    const body = await readSse(await ask());

    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(body).toContain('source_images');
    expect(body).toContain(imageUrl);
    expect(body.indexOf('source_images')).toBeLessThan(body.indexOf('"delta":"ok"'));
  });

  it('streams it when a text chunk of the same PDF ranks before the image chunk', async () => {
    seed(chunks, [isText, isImage]);
    const imageUrl = String(chunks.find(isImage)!.metadata.image_url);

    const body = await readSse(await ask());

    expect(body).toContain('source_images');
    expect(body).toContain(imageUrl);
  });

  it('persists one source_images part with the image URL, and lists the PDF once among the document sources, not the image as a source of its own', async () => {
    seed(chunks, [isImage, isText]);
    const imageUrl = String(chunks.find(isImage)!.metadata.image_url);
    await readSse(await ask());

    const params = h.capture.calls[0];
    const toolResults: Array<Record<string, any>> = [];
    await params.onStepFinish({ text: '', toolCalls: [], toolResults });

    const persisted = toolResults.filter((part) => part.type === 'source_images');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].source_images.map((image: { url: string }) => image.url)).toEqual([imageUrl]);
    const sources = toolResults.find((part) => part.toolName === 'query_documents');
    expect(sources?.output.documents.map((doc: { filename: string }) => doc.filename)).toEqual(['images-en.pdf']);
    expect(sources?.output.images.map((image: { url: string }) => image.url)).toEqual([imageUrl]);
  });
});

describe('a quarantined PDF', () => {
  afterEach(() => {
    resetCaptionerForTests();
    resetSidecarParserForTests();
    resetLlamaParseParserForTests();
    resetPublicImageStoreForTests();
    uninstallIngestDeps();
    vi.restoreAllMocks();
  });

  it('has no image chunk, so no image URL can reach source_images', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const chunks = await ingestFixtureWithInjectedCaption();
    expect(chunks.some((chunk) => chunk.chunk_kind === 'image')).toBe(false);
    expect(chunks.some((chunk) => chunk.metadata.image_url !== undefined)).toBe(false);
  });
});

async function ingestFixtureWithInjectedCaption(): Promise<IngestedChunk[]> {
  setSidecarParserForTests({
    name: 'docling',
    unavailableReason: () => null,
    async parse() {
      return {
        kind: 'done',
        result: PARSE,
        artifacts: [
          { name: 'picture-1.png', bytes: PICTURE_1, contentType: 'image/png' },
          { name: 'picture-2.png', bytes: PICTURE_2, contentType: 'image/png' },
        ],
        warnings: [],
      };
    },
  });
  setLlamaParseParserForTests({
    name: 'llamaparse',
    unavailableReason: () => 'missing_key',
    async parse() {
      throw new ParserError('llamaparse', 'missing_key');
    },
  });
  setCaptionerForTests(async () => recorded.captions.injection);
  const { db, calls } = fakeIngestDb();
  installIngestDeps({ db, env: { RAG_PDF_IMAGE_CHUNKS: 'true', RAG_INJECTION_SCAN: 'quarantine' } });
  installFakePublicImageStore();
  const result = await ingest({
    scope,
    source: 'config_upload',
    sourceKey: 'root/images-en.pdf',
    file: fixtureBytes('images-en'),
    filename: 'images-en.pdf',
    mimeType: 'application/pdf',
    docType: 'product_technical',
    signal: new AbortController().signal,
  });
  expect(result.status).toBe('quarantined');
  return callsOf(calls, 'rag_write_chunks').flatMap((call) => call.args.p_chunks as IngestedChunk[]);
}
