import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  HIDDEN_SPAN_MIN_CHARS,
  HiddenSpanWriteError,
  assertNoHiddenSpans,
  createHiddenTextClient,
  hiddenTextMimeType,
  removeHiddenSpans,
} from '@/lib/rag/security/hidden-text';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { getIngestDeps } from '@/lib/rag/ingest/deps';
import { embedStage, guardHiddenSpans, toWrites } from '@/lib/rag/ingest/stages/embed-write';
import { emptyIngestState, type StageContext } from '@/lib/rag/ingest/types';
import { createIngestWriter } from '@/lib/rag/ingest/writer';
import { mintScope } from '@/lib/rag/tenant/scope';
import { FAKE_DOCUMENT_ID, FAKE_LINEAGE_ID, callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps } from '../helpers/ingest-fakes';

const VISIBLE = 'The blue module joins the second relay after the amber light turns steady.';
const HIDDEN = 'The grey lever stays down during the night cycle.';
const ZH_HIDDEN = '灰色的杠杆在夜间保持向下';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('removeHiddenSpans', () => {
  test('removes a span matched with whitespace and line breaks ignored, and reports nothing unlocated', () => {
    const text = `# Notes\n\n${VISIBLE}\nThe grey lever stays\ndown  during the night cycle.\n\nEnd of the notes.`;
    const result = removeHiddenSpans(text, [HIDDEN]);
    expect(result.text).not.toContain('grey lever');
    expect(result.text).toContain(VISIBLE);
    expect(result.text).toContain('End of the notes.');
    expect(result.removed).toEqual([HIDDEN]);
    expect(result.unlocated).toEqual([]);
  });

  test('a CJK span broken across lines is removed', () => {
    const text = `第一段。\n灰色的杠杆\n在夜间保持向下。第二段。`;
    const result = removeHiddenSpans(text, [ZH_HIDDEN]);
    expect(result.text.replace(/\s/g, '')).toBe('第一段。。第二段。');
    expect(result.unlocated).toEqual([]);
  });

  test('a span that is not in the text is returned as unlocated and the text is unchanged', () => {
    const result = removeHiddenSpans(VISIBLE, ['A sentence the parser never produced.']);
    expect(result.text).toBe(VISIBLE);
    expect(result.removed).toEqual([]);
    expect(result.unlocated).toEqual(['A sentence the parser never produced.']);
  });

  test('applied twice it is a no-op on its own output', () => {
    const text = `${VISIBLE} ${HIDDEN} ${VISIBLE}`;
    const once = removeHiddenSpans(text, [HIDDEN, 'xq7']);
    const twice = removeHiddenSpans(once.text, [HIDDEN, 'xq7']);
    expect(twice.text).toBe(once.text);
  });

  test('a long span is removed wherever it occurs; a short span only once', () => {
    const text = `${HIDDEN} middle ${HIDDEN} tail xq7 and xq7`;
    const result = removeHiddenSpans(text, [HIDDEN, 'xq7']);
    expect(result.text).not.toContain('grey lever');
    expect(result.text.match(/xq7/g)).toHaveLength(1);
  });

  test('regular-expression characters in a span are matched literally', () => {
    const span = 'Price (net) is $4.50 + tax [see note]?';
    const result = removeHiddenSpans(`Before. ${span} After.`, [span]);
    expect(result.text).toBe('Before.  After.');
  });

  test('zero-width characters inside the text do not hide a span from the remover', () => {
    const text = `The grey​ lever stays down during the night‍ cycle.`;
    expect(removeHiddenSpans(text, [HIDDEN]).text).toBe('');
  });
});

describe('assertNoHiddenSpans', () => {
  test('refuses a chunk whose content holds a span, whitespace ignored, with a typed error that carries no text', () => {
    let caught: unknown;
    try {
      assertNoHiddenSpans([{ content: VISIBLE }, { content: `x The grey lever\nstays down during the night cycle. y` }], [HIDDEN]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HiddenSpanWriteError);
    expect((caught as HiddenSpanWriteError).chunks).toBe(1);
    expect(String((caught as Error).message)).not.toMatch(/grey|lever/);
  });

  test('refuses a chunk whose lexical text holds a span', () => {
    expect(() => assertNoHiddenSpans([{ content: VISIBLE, lexical_text: HIDDEN }], [HIDDEN])).toThrow(HiddenSpanWriteError);
  });

  test('spans shorter than the threshold are not asserted', () => {
    const short = 'x'.repeat(HIDDEN_SPAN_MIN_CHARS - 1);
    expect(() => assertNoHiddenSpans([{ content: `a ${short} b` }], [short])).not.toThrow();
    expect(() => assertNoHiddenSpans([{ content: VISIBLE }], [HIDDEN])).not.toThrow();
  });
});

describe('hiddenTextMimeType', () => {
  test('PDF and Word are checked; text, HTML, presentations and spreadsheets are not', () => {
    expect(hiddenTextMimeType('application/pdf', 'a.pdf')).toBe('application/pdf');
    expect(hiddenTextMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx')).toMatch(/wordprocessingml/);
    expect(hiddenTextMimeType('', 'stored.pdf')).toBe('application/pdf');
    expect(hiddenTextMimeType('application/octet-stream', 'stored.PDF')).toBe('application/pdf');
    for (const [type, name] of [
      ['text/markdown', 'a.md'],
      ['text/plain', 'a.pdf'],
      ['text/html', 'a.html'],
      ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'a.pptx'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a.xlsx'],
      ['image/png', 'a.png'],
    ]) {
      expect(hiddenTextMimeType(type, name as string)).toBeNull();
    }
  });
});

describe('createHiddenTextClient', () => {
  const original = { bytes: new TextEncoder().encode('%PDF-1.4 fake'), mimeType: 'application/pdf', filename: 'Quarterly Plan.pdf' };
  const meta = () => ({ signal: new AbortController().signal, timeoutMs: 5000 });
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('posts the original as multipart with the request part, never the filename, and returns the validated report', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return reply(200, { status: 'hidden_found', spans: [{ page: 1, text: HIDDEN, reason: 'color_near_background', bbox: null }], link_targets: [], checker_version: 'hidden-text/1/x', dropped: 0 });
    }) as unknown as typeof fetch;
    const client = createHiddenTextClient({ baseUrl: 'http://sidecar.test/', secret: 'placeholder-secret', fetch: fetchImpl });
    const outcome = await client(original, meta());
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.report.spans?.[0]?.text).toBe(HIDDEN);
    const call = seen as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe('http://sidecar.test/v1/hidden-text');
    expect((call.init.headers as Record<string, string>)['x-sidecar-secret']).toBe('placeholder-secret');
    const form = call.init.body as FormData;
    const request = JSON.parse(String(form.get('request'))) as Record<string, unknown>;
    expect(request).toMatchObject({ filename: 'original.pdf', mime_type: 'application/pdf', size_bytes: original.bytes.byteLength });
    expect(request.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(request)).not.toContain('Quarterly');
  });

  test('a 5xx, a 4xx, an invalid report and an inconsistent report are failures, never a report', async () => {
    const cases: Array<[Response, string]> = [
      [reply(503, { error: 'checker_unavailable' }), 'http_503'],
      [reply(422, { error: 'encrypted_document' }), 'http_422'],
      [reply(200, { status: 'maybe' }), 'malformed'],
      [reply(200, { status: 'hidden_found', spans: [], checker_version: 'v', dropped: 0 }), 'malformed'],
      [new Response('not json', { status: 200 }), 'malformed'],
    ];
    for (const [response, reason] of cases) {
      const client = createHiddenTextClient({ baseUrl: 'http://sidecar.test', secret: 's', fetch: (async () => response) as unknown as typeof fetch });
      const outcome = await client(original, meta());
      expect(outcome).toMatchObject({ ok: false, reason });
    }
  });

  test('a timeout, a network error and a missing configuration are failures', async () => {
    const hanging = (async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    expect(await createHiddenTextClient({ baseUrl: 'http://sidecar.test', secret: 's', fetch: hanging })(original, { ...meta(), timeoutMs: 20 })).toMatchObject({ ok: false, reason: 'timeout' });
    const broken = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await createHiddenTextClient({ baseUrl: 'http://sidecar.test', secret: 's', fetch: broken })(original, meta())).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(await createHiddenTextClient({ baseUrl: '', secret: 's' })(original, meta())).toMatchObject({ ok: false, reason: 'not_configured' });
  });
});

describe('the embed stage refuses a chunk that still holds a removed span (F-17)', () => {
  afterEach(() => {
    uninstallIngestDeps();
  });

  function embedContext(chunks: string[], removedSpans: string[]) {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db, env: { RAG_HIDDEN_TEXT_CHECK: 'quarantine' } });
    const deps = getIngestDeps();
    const signal = new AbortController().signal;
    const scope = mintScope('single', null, null);
    const state = emptyIngestState();
    state.hiddenText = { fileSha256: 'a'.repeat(64), report: null, removedSpans, unlocated: 0, sanitized: true };
    const ctx: StageContext = {
      input: { scope, source: 'config_upload', sourceKey: 'root/notes.pdf', file: new Uint8Array(1), filename: 'notes.pdf', mimeType: 'application/pdf', signal },
      deps,
      writer: createIngestWriter({ db, scope, signal }),
      config: loadIngestConfig(deps.ingestEnv()),
      signal,
      deadline: deps.now() + 50_000,
      state,
      warnings: [],
      identity: { profile: { scan_injection: true }, docType: 'general', tenantKey: 's:single' } as unknown as StageContext['identity'],
      document: { id: FAKE_DOCUMENT_ID, lineageId: FAKE_LINEAGE_ID, version: 1, resumed: false },
      parserUsed: 'docling',
      work: {
        parseText: chunks.join('\n\n'),
        parserVersion: 'test',
        chunks: chunks.map((content) => ({ content, section_path: ['Notes'], chunk_kind: 'text' as const, page_start: 1, page_end: 1, metadata: {} })),
        chunksWritten: 0,
      },
    };
    return { ctx, calls };
  }

  test('a deliberate chunk with the span fails the stage with a typed reason and nothing is embedded or written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const embedded: string[][] = [];
    const { ctx, calls } = embedContext([VISIBLE, `Intro. ${HIDDEN} Outro.`], [HIDDEN]);
    (ctx as { deps: StageContext['deps'] }).deps = { ...ctx.deps, embedDocuments: async (texts) => (embedded.push(texts), texts.map(() => [])) };
    await expect(embedStage.run(ctx)).rejects.toMatchObject({ name: 'IngestStageError', reason: 'hidden_span_in_chunk' });
    expect(embedded).toEqual([]);
    expect(callsOf(calls, 'rag_write_chunks')).toHaveLength(0);
  });

  test('without removed spans the guard lets the same chunks through', () => {
    const { ctx } = embedContext([VISIBLE, HIDDEN], []);
    expect(() => guardHiddenSpans(ctx, toWrites(ctx))).not.toThrow();
  });
});
