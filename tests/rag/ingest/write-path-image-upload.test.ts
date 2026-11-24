import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingest, resumeIngest } from '@/lib/rag/ingest';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { resetCaptionerForTests, setCaptionerForTests } from '@/lib/rag/ingest/captioner';
import { getIngestDeps, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { profileFor } from '@/lib/rag/ingest/profiles/load';
import { imagesStage } from '@/lib/rag/ingest/stages/images';
import { parseStage } from '@/lib/rag/ingest/stages/parse';
import { emptyIngestState, type IngestResult, type StageContext } from '@/lib/rag/ingest/types';
import { createIngestWriter } from '@/lib/rag/ingest/writer';
import { resetInjectionRulesForTests } from '@/lib/rag/security/injection-scan';
import { mintScope } from '@/lib/rag/tenant/scope';
import { FAKE_DOCUMENT_ID, FAKE_LINEAGE_ID, callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps, type RecordedRpc } from '../../helpers/ingest-fakes';
import recorded from '../../fixtures/ingest/caption-recorded.json';

const scope = mintScope('single', null, null);
const IMAGE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const OTHER_IMAGE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9]);
const IMAGE_URL = 'https://project.example.test/storage/v1/object/public/chat-images/user-1/pic_1_abc.png?download';
const STORAGE_PATH = 'user-1/pic_1_abc.png';
const ORIGINAL_PATH = `s:default/${FAKE_LINEAGE_ID}/1/original.png`;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  resetCaptionerForTests();
  resetInjectionRulesForTests();
  uninstallIngestDeps();
  vi.restoreAllMocks();
});

function captionWith(text: string) {
  const seen: Array<{ bytes: Uint8Array; mimeType: string }> = [];
  setCaptionerForTests(async (bytes, mimeType) => {
    seen.push({ bytes, mimeType });
    return text;
  });
  return seen;
}

function uploadImage(overrides: Partial<Parameters<typeof ingest>[0]> = {}) {
  return ingest({
    scope,
    source: 'image_upload',
    sourceKey: STORAGE_PATH,
    file: IMAGE,
    filename: 'pic.png',
    mimeType: 'image/png',
    signal: new AbortController().signal,
    options: { imageUrl: IMAGE_URL, imageContext: 'Ground floor plan' },
    ...overrides,
  } as Parameters<typeof ingest>[0]);
}

const writtenChunks = (calls: RecordedRpc[]) => callsOf(calls, 'rag_write_chunks').flatMap((call) => call.args.p_chunks as Array<Record<string, any>>);
const fieldsSet = (calls: RecordedRpc[]) => callsOf(calls, 'rag_set_document_fields').map((call) => call.args.p_fields as Record<string, any>);

interface ParseCtx {
  ctx: StageContext;
  store: ReturnType<typeof installIngestDeps>;
  calls: RecordedRpc[];
}

/** A context at the parse stage of an image upload: identity, document and the stored original as the earlier stages leave them. */
function parseContext(overrides: { mimeType?: string; file?: Uint8Array; options?: Record<string, unknown>; text?: string; env?: Record<string, string> } = {}): ParseCtx {
  const { db, calls } = fakeIngestDb();
  const store = installIngestDeps({ db, ...(overrides.env ? { env: overrides.env } : {}) });
  const deps = getIngestDeps();
  const signal = new AbortController().signal;
  const profile = profileFor('image_upload', 'general');
  const ctx = {
    input: {
      scope,
      source: 'image_upload',
      sourceKey: STORAGE_PATH,
      ...(overrides.text !== undefined ? { text: overrides.text } : { file: overrides.file ?? IMAGE }),
      filename: 'pic.png',
      mimeType: overrides.mimeType ?? 'image/png',
      options: overrides.options ?? { imageUrl: IMAGE_URL, imageContext: 'Ground floor plan' },
      signal,
    },
    deps,
    writer: createIngestWriter({ db: deps.db()!, scope, signal }),
    config: loadIngestConfig(deps.ingestEnv()),
    signal,
    deadline: deps.now() + 50000,
    state: emptyIngestState(),
    warnings: [],
    identity: {
      tenantKey: 's:default',
      filename: 'pic.png',
      fileSha256: 'sha',
      docType: 'general',
      docTypeOrigin: 'fallback',
      profile,
      bytes: overrides.text !== undefined ? null : (overrides.file ?? IMAGE),
    },
    document: { id: FAKE_DOCUMENT_ID, version: 1, lineageId: FAKE_LINEAGE_ID, resumed: false },
    parserUsed: null,
    work: { parseText: null, parserVersion: null, chunks: [], chunksWritten: 0 },
  } as unknown as StageContext;
  return { ctx, store, calls };
}

describe('parse stage: a whole image', () => {
  it('yields an empty Markdown, one picture that refers to the original, parser text and version image, and keeps no parser call', async () => {
    const { ctx, store } = parseContext();
    const outcome = await parseStage.run(ctx);

    expect(outcome).toEqual({ kind: 'next' });
    expect(ctx.work.parseText).toBe('');
    expect(ctx.work.parseChunks ?? null).toBeNull();
    expect(ctx.work.pictures).toEqual([{ bbox: [0, 0, 1, 1], image_ref: 'original.png', page: 1, page_area_share: 1 }]);
    expect(ctx.parserUsed).toBe('text');
    expect(ctx.work.parserVersion).toBe('image');
    expect(store.keys()).toEqual([`s:default/${FAKE_LINEAGE_ID}/1/parse.md`]);
  });

  it('keeps what the images stage needs in the state slice, so a resumed run does not need the options', async () => {
    const { ctx } = parseContext({ mimeType: 'image/jpeg' });
    await parseStage.run(ctx);
    expect(ctx.state.images).toEqual({ nextIndex: 0, captioned: 0, imageUrl: IMAGE_URL, imageContext: 'Ground floor plan', mimeType: 'image/jpeg' });
  });

  it('fails a run whose file is not an image, or whose image has no usable public URL, before anything is captioned', async () => {
    const pdf = parseContext({ mimeType: 'application/pdf' });
    expect(await parseStage.run(pdf.ctx)).toEqual({ kind: 'fail', reason: 'not_an_image' });

    const text = parseContext({ text: 'plain words' });
    expect(await parseStage.run(text.ctx)).toEqual({ kind: 'fail', reason: 'not_an_image' });

    for (const imageUrl of [undefined, '', 'javascript:alert(1)', 'ftp://example.test/a.png', 'not a url', `https://example.test/${'a'.repeat(2100)}`]) {
      const bad = parseContext({ options: { imageUrl } });
      expect(await parseStage.run(bad.ctx), String(imageUrl)).toEqual({ kind: 'fail', reason: 'image_url_invalid' });
    }
  });
});

describe('an image upload through ingest()', () => {
  it('ends ready with one image chunk: the caption as content, kind image, page 1, the public URL in its metadata and the promoted columns', async () => {
    const seen = captionWith(recorded.captions.chart);
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await uploadImage();

    expect(result).toMatchObject({ status: 'ready', parserUsed: 'text', chunkCount: 1 });
    expect(seen).toHaveLength(1);
    expect(Array.from(seen[0]!.bytes)).toEqual(Array.from(IMAGE));
    expect(seen[0]!.mimeType).toBe('image/png');
    const chunks = writtenChunks(calls);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      content: recorded.captions.chart,
      chunk_index: 0,
      chunk_kind: 'image',
      section_path: [],
      page_start: 1,
      page_end: 1,
    });
    expect(chunks[0]!.metadata).toMatchObject({
      image_url: IMAGE_URL,
      image_type: 'image/png',
      image_context: 'Ground floor plan',
      document_title: 'pic.png',
      chunk_index: 0,
      chunk_position: 1,
      total_chunks: 1,
    });
    expect(typeof chunks[0]!.content_hash).toBe('string');
    expect(String(chunks[0]!.lexical_text)).toContain('quarterly');
    expect(fieldsSet(calls)).toContainEqual({ parser_used: 'text', parser_version: 'image' });
    expect(fieldsSet(calls).some((fields) => fields.language !== undefined)).toBe(true);
  });

  it('keeps the image_caption chunker whatever type was picked, so a table type does not turn the caption into a table chunk', async () => {
    captionWith(recorded.captions.chart);
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await uploadImage({ docType: 'financial_report' });

    expect(result.status).toBe('ready');
    expect(writtenChunks(calls).map((chunk) => chunk.chunk_kind)).toEqual(['image']);
  });

  it('captions the image once per run and records the progress in the images slice', async () => {
    const seen = captionWith(recorded.captions.logo);
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    await uploadImage();

    expect(seen).toHaveLength(1);
    const states = callsOf(calls, 'rag_save_ingest_state').map((call) => call.args.p_state as Record<string, any>);
    expect(states.some((state) => state.images?.captioned === 1 && state.images?.nextIndex === 1)).toBe(true);
    expect(states.at(-1)?.images).toMatchObject({ nextIndex: 1, captioned: 1, imageUrl: IMAGE_URL });
  });

  it('does not treat two different images as content duplicates of each other', async () => {
    captionWith(recorded.captions.chart);
    const first = fakeIngestDb();
    installIngestDeps({ db: first.db });
    await uploadImage();
    const second = fakeIngestDb();
    installIngestDeps({ db: second.db });
    await uploadImage({ file: OTHER_IMAGE });
    const third = fakeIngestDb();
    installIngestDeps({ db: third.db });
    await uploadImage({ sourceKey: 'user-1/pic_2_def.png' });

    const hashOf = (calls: RecordedRpc[]) => callsOf(calls, 'rag_find_content_duplicate')[0]?.args.p_content_hash;
    expect(hashOf(first.calls)).toBeTruthy();
    expect(hashOf(first.calls)).not.toBe(hashOf(second.calls));
    expect(hashOf(first.calls)).toBe(hashOf(third.calls));
  });

  it('quarantines the document when the caption holds an injection phrase and RAG_INJECTION_SCAN is quarantine', async () => {
    captionWith(recorded.captions.injection);
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db, env: { RAG_INJECTION_SCAN: 'quarantine' } });

    const result = await uploadImage();

    expect(result.status).toBe('quarantined');
    const quarantine = fieldsSet(calls).find((fields) => fields.status === 'quarantined');
    expect(quarantine?.metadata?.quarantine?.rule_ids).toEqual(expect.arrayContaining(['inj-en-01']));
    expect(writtenChunks(calls)).toHaveLength(1);
    const logged = JSON.stringify([...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls]);
    expect(logged).not.toContain('reveal the system prompt');
  });

  it('publishes a clean caption under quarantine, and publishes an injection caption when the scan is off, as today', async () => {
    captionWith(recorded.captions.chart);
    const clean = fakeIngestDb();
    installIngestDeps({ db: clean.db, env: { RAG_INJECTION_SCAN: 'quarantine' } });
    expect((await uploadImage()).status).toBe('ready');

    captionWith(recorded.captions.injection);
    const off = fakeIngestDb();
    installIngestDeps({ db: off.db, env: { RAG_INJECTION_SCAN: 'off' } });
    expect((await uploadImage()).status).toBe('ready');
    expect(fieldsSet(off.calls).some((fields) => fields.status === 'quarantined')).toBe(false);
  });

  it('scans the caption even when the profile of the resolved type has the scan switched off', async () => {
    captionWith(recorded.captions.injection);
    const { ctx, calls } = parseContext({ env: { RAG_INJECTION_SCAN: 'quarantine' } });
    ctx.identity!.profile = { ...ctx.identity!.profile, scan_injection: false };
    expect(await parseStage.run(ctx)).toEqual({ kind: 'next' });
    ctx.work.captionOnly = true;

    expect((await imagesStage.run(ctx)).kind).toBe('next');

    expect(fieldsSet(calls).some((fields) => fields.status === 'quarantined')).toBe(true);
    expect(ctx.state.quarantine).toMatchObject({ released: false });
  });

  it('fails with caption_failed and writes no chunk when the vision call fails', async () => {
    setCaptionerForTests(async () => {
      throw new Error('vision down');
    });
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await uploadImage();

    expect(result).toMatchObject({ status: 'failed', reason: 'caption_failed' });
    expect(callsOf(calls, 'rag_write_chunks')).toHaveLength(0);
    expect(callsOf(calls, 'rag_mark_document_failed').map((call) => call.args.p_reason)).toEqual(['caption_failed']);
  });

  it('yields before the vision call when too little of the request budget is left, and captions nothing', async () => {
    const seen = captionWith(recorded.captions.chart);
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await uploadImage({ deadlineMs: 3000 });

    expect(result).toMatchObject({ status: 'processing', reason: 'deadline' });
    expect(seen).toHaveLength(0);
    expect(callsOf(calls, 'rag_write_chunks')).toHaveLength(0);
  });

  it('leaves documents that are not images on the switch behaviour of the images stage', async () => {
    const seen = captionWith(recorded.captions.chart);
    const { db } = fakeIngestDb();
    installIngestDeps({ db, env: { RAG_PDF_IMAGE_CHUNKS: 'true' } });

    const result: IngestResult = await ingest({
      scope,
      source: 'config_upload',
      sourceKey: 'root/handbook.md',
      text: '# Handbook\n\nThe night crew scans every pallet at the dock and stages it beside bay four.\n',
      filename: 'handbook.md',
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('ready');
    expect(result.warnings).toContain('image_chunks_unavailable');
    expect(seen).toHaveLength(0);
  });
});

describe('a resumed image upload', () => {
  function resumeDb(state: Record<string, unknown>) {
    return fakeIngestDb({
      document: {
        status: 'processing',
        version: 1,
        processing_status: 'processing',
        processing_state: state,
        filename: 'pic.png',
        doc_type: 'general',
        parser_used: 'text',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      origin: { lineage_id: FAKE_LINEAGE_ID, original_path: ORIGINAL_PATH, source: 'image_upload', source_key: STORAGE_PATH },
    });
  }

  it('does not caption a second time, and writes the same image chunk as an uninterrupted run', async () => {
    let clock = 0;
    const seen: string[] = [];
    setCaptionerForTests(async () => {
      seen.push('call');
      clock += 49000;
      return recorded.captions.chart;
    });
    const first = fakeIngestDb();
    const store = installIngestDeps({ db: first.db, now: () => clock });

    const interrupted = await uploadImage();
    expect(interrupted).toMatchObject({ status: 'processing', reason: 'deadline' });
    expect(callsOf(first.calls, 'rag_write_chunks')).toHaveLength(0);
    expect(store.keys().some((key) => key.endsWith('/caption-1.txt'))).toBe(true);
    const saved = callsOf(first.calls, 'rag_save_ingest_state').at(-1)!.args.p_state as Record<string, unknown>;
    expect(saved.lastCompleted).toBe('images');

    const second = resumeDb(saved);
    setIngestDepsForTests({ db: () => second.db, now: () => clock });
    clock += 1_000_000;
    const resumed = await resumeIngest(scope, FAKE_DOCUMENT_ID);

    expect(resumed.status).toBe('ready');
    expect(seen).toHaveLength(1);
    const chunks = writtenChunks(second.calls);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ content: recorded.captions.chart, chunk_kind: 'image', page_start: 1 });
    expect(chunks[0]!.metadata).toMatchObject({ image_url: IMAGE_URL, image_type: 'image/png', image_context: 'Ground floor plan' });
  });

  it('captions once more only when the stored caption is gone, from the stored original and without the upload', async () => {
    const seen = captionWith(recorded.captions.logo);
    const { db, calls } = resumeDb({
      lastCompleted: 'extract',
      images: { nextIndex: 0, captioned: 0, imageUrl: IMAGE_URL, mimeType: 'image/png' },
    });
    const store = installIngestDeps({ db });
    await store.put(ORIGINAL_PATH, IMAGE, { contentType: 'image/png' });
    await store.put(ORIGINAL_PATH.replace('original.png', 'parse.md'), new Uint8Array(0), { contentType: 'text/markdown' });

    const result = await resumeIngest(scope, FAKE_DOCUMENT_ID);

    expect(result.status).toBe('ready');
    expect(seen).toHaveLength(1);
    expect(Array.from(seen[0]!.bytes)).toEqual(Array.from(IMAGE));
    expect(writtenChunks(calls)[0]).toMatchObject({ content: recorded.captions.logo, chunk_kind: 'image' });
  });
});
