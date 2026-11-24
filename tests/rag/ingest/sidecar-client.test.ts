import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ParseJobRequestSchema, ParseResultSchema } from '@/lib/rag-eval/contracts.generated';
import { ingest } from '@/lib/rag/ingest';
import { createSidecarParser, inputFormatFor } from '@/lib/rag/ingest/parsers/sidecar-docling';
import { ParserError, type ParseAttempt, type ParseRequest, type PendingJob } from '@/lib/rag/ingest/parsers/shared';
import { resetSidecarParserForTests, setSidecarParserForTests } from '@/lib/rag/ingest/parsers/sidecar-docling';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { mintScope } from '@/lib/rag/tenant/scope';
import { callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps } from '../../helpers/ingest-fakes';
import { fixtureBytes, fixtureEntry, startFakeSidecar, type FakeSidecar } from '../../helpers/fake-sidecar';

const scope = mintScope('single', null, null);

let fake: FakeSidecar;
let state: { t: number; sleeps: number[] };
let logged: unknown[][];

beforeEach(async () => {
  fake = await startFakeSidecar();
  state = { t: 0, sleeps: [] };
  logged = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args));
});

afterEach(async () => {
  await fake.close();
  resetSidecarParserForTests();
  uninstallIngestDeps();
  vi.restoreAllMocks();
});

const sleep = async (ms: number): Promise<void> => {
  state.sleeps.push(ms);
  state.t += ms;
};

function parser(overrides: Partial<Parameters<typeof createSidecarParser>[0]> = {}) {
  return createSidecarParser({ baseUrl: fake.url, secret: fake.secret, sleep, ...overrides });
}

function request(fixtureId: string | null, overrides: Partial<ParseRequest> = {}, profileType: Parameters<typeof getProcessingProfile>[0] = 'general'): ParseRequest & { submitted: PendingJob[] } {
  const submitted: PendingJob[] = [];
  const entry = fixtureId ? fixtureEntry(fixtureId) : null;
  return {
    scope,
    filename: entry ? entry.path.split('/').pop()! : 'plain.pdf',
    mimeType: 'application/pdf',
    bytes: fixtureId ? fixtureBytes(fixtureId) : new TextEncoder().encode('%PDF-1.4 unknown to the manifest'),
    profile: getProcessingProfile(profileType),
    signal: new AbortController().signal,
    now: () => state.t,
    deadline: 10 ** 9,
    pollUntil: 45_000,
    resume: null,
    onSubmitted: async (job) => void submitted.push(job),
    submitted,
    ...overrides,
  };
}

async function done(promise: Promise<ParseAttempt>) {
  const attempt = await promise;
  expect(attempt.kind).toBe('done');
  if (attempt.kind !== 'done') throw new Error('not done');
  return attempt;
}

describe('sidecar Docling client', () => {
  test('submits a multipart file and a ParseJobRequest from the profile with the secret header, and serves the recorded table PDF', async () => {
    const attempt = await done(parser().parse(request('report-zh-table', {}, 'financial_report')));
    const post = fake.calls.find((call) => call.method === 'POST');
    expect(post).toMatchObject({ path: '/v1/parse/jobs', secretOk: true });
    expect(fake.calls.every((call) => call.secretOk)).toBe(true);
    expect(fake.uploads[0]?.fileSha256).toBe(fixtureEntry('report-zh-table').file_sha256);
    const sent = fake.uploads[0]?.request;
    expect(ParseJobRequestSchema.safeParse(sent).success).toBe(true);
    expect(sent).toMatchObject({
      profile_id: 'financial_report@1',
      profile_version: 1,
      input_format: 'pdf',
      tokenizer: 'cl100k_base',
      max_tokens: 512,
      repeat_table_header: true,
      ocr_languages: ['zh', 'en', 'it'],
      docling: { table_mode: 'accurate', ocr: true, force_full_page_ocr: false },
    });
    expect(ParseResultSchema.safeParse(attempt.result).success).toBe(true);
    const tables = attempt.result.chunks.filter((chunk) => chunk.is_table && chunk.table_header !== null);
    expect(tables.length).toBeGreaterThan(1);
    for (const chunk of tables) expect(chunk.text.startsWith(chunk.table_header as string)).toBe(true);
  });

  test('the recorded scan is submitted with full-page OCR from the scanned_image profile', async () => {
    const attempt = await done(parser().parse(request('scan-zh', {}, 'scanned_image')));
    expect(fake.uploads[0]?.request).toMatchObject({ profile_id: 'scanned_image@1', docling: { force_full_page_ocr: true } });
    expect(attempt.result.text_layer_page_share).toBe(0);
  });

  test('the input format comes from the MIME type or extension: pdf, docx, html and image for png, jpeg and tiff', () => {
    expect(inputFormatFor('a.pdf', 'application/pdf')).toBe('pdf');
    expect(inputFormatFor('a.bin', 'application/pdf')).toBe('pdf');
    expect(inputFormatFor('a.docx', '')).toBe('docx');
    expect(inputFormatFor('a', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx');
    expect(inputFormatFor('a.html', '')).toBe('html');
    expect(inputFormatFor('a', 'text/html; charset=utf-8')).toBe('html');
    for (const [name, mime] of [['a.png', 'image/png'], ['a.jpg', 'image/jpeg'], ['a.jpeg', ''], ['a.tif', 'image/tiff'], ['a.tiff', ''], ['a', 'image/png']] as const) {
      expect(inputFormatFor(name, mime), name).toBe('image');
    }
    expect(inputFormatFor('a.md', 'text/markdown')).toBeNull();
    expect(parser().unavailableReason({ filename: 'a.md', mimeType: 'text/markdown' })).toBe('unsupported_format');
  });

  test('an image file is submitted with input_format image', async () => {
    await done(parser().parse(request(null, { filename: 'scan.png', mimeType: 'image/png' })));
    expect(fake.uploads[0]?.request.input_format).toBe('image');
  });

  test('polling follows the 500 ms doubling schedule capped at 5 s, and a job still running at the budget yields pending with its id', async () => {
    fake.enqueue({ statuses: ['queued', 'running'] });
    const req = request(null, { pollUntil: 20_000 });
    const attempt = await parser().parse(req);
    expect(attempt).toEqual({ kind: 'pending', job: { parser: 'docling', jobId: 'job1', submittedAt: new Date(0).toISOString(), attempt: 1 } });
    expect(state.sleeps.slice(0, 6)).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
    expect(state.t).toBeLessThanOrEqual(20_000);
    expect(req.submitted).toHaveLength(1);
    const post = fake.calls.findIndex((call) => call.method === 'POST');
    const firstGet = fake.calls.findIndex((call) => call.method === 'GET');
    expect(post).toBeLessThan(firstGet);
  });

  test('a job finishing within the budget returns the validated result and the job is deleted afterwards', async () => {
    fake.enqueue({ statuses: ['queued', 'running', 'running', 'succeeded'] });
    const attempt = await done(parser().parse(request('invoice-en', {}, 'invoice_receipt')));
    expect(attempt.result.parser).toBe('docling');
    expect(state.sleeps).toEqual([500, 1000, 2000]);
    expect(fake.deleted).toEqual(['job1']);
  });

  test('a resume with a saved job id polls without resubmitting; a 404 or an expired job resubmits exactly once', async () => {
    fake.enqueue({ statuses: ['running'] });
    const first = await parser().parse(request(null, { pollUntil: 0 }));
    expect(first.kind).toBe('pending');
    if (first.kind !== 'pending') return;

    fake.enqueue({ statuses: ['succeeded'] });
    const resumed = await done(parser().parse(request(null, { resume: first.job })));
    expect(resumed.result.parser).toBe('docling');
    expect(fake.uploads).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === 'POST')).toHaveLength(1);

    // 404: the sidecar no longer knows the job (TTL or restart).
    const gone = request(null, { resume: { parser: 'docling', jobId: 'unknownjob', submittedAt: new Date(0).toISOString(), attempt: 1 } });
    await done(parser().parse(gone));
    expect(fake.uploads).toHaveLength(2);
    expect(gone.submitted).toEqual([expect.objectContaining({ attempt: 2 })]);

    // expired status resubmits too, but only once: attempt 2 gives up.
    fake.expire('job1');
    const expired = request(null, { resume: first.job });
    await done(parser().parse(expired));
    expect(fake.uploads).toHaveLength(3);
    await expect(parser().parse(request(null, { resume: { parser: 'docling', jobId: 'unknownjob', submittedAt: new Date(0).toISOString(), attempt: 2 } }))).rejects.toMatchObject({ reason: 'job_lost' });
    expect(fake.uploads).toHaveLength(3);
  });

  test('401, 503 and 429 from the sidecar become unavailable errors the chain falls back on, and an empty URL or secret means unavailable', async () => {
    fake.enqueue({ submitStatus: 503, submitError: 'docling_unavailable' }, { submitStatus: 503, submitError: 'sidecar secret not configured' }, { submitStatus: 429, submitError: 'parse_queue_full' }, { submitStatus: 500 });
    await expect(parser().parse(request(null))).rejects.toMatchObject({ parser: 'docling', reason: 'docling_unavailable' });
    await expect(parser().parse(request(null))).rejects.toMatchObject({ reason: 'http_503' });
    await expect(parser().parse(request(null))).rejects.toMatchObject({ reason: 'http_429' });
    await expect(parser().parse(request(null))).rejects.toMatchObject({ reason: 'http_500' });
    await expect(createSidecarParser({ baseUrl: fake.url, secret: 'wrong-secret-0000000000000000000000', sleep }).parse(request(null))).rejects.toMatchObject({ reason: 'http_401' });

    const file = { filename: 'a.pdf', mimeType: 'application/pdf' };
    expect(createSidecarParser({ baseUrl: '', secret: fake.secret }).unavailableReason(file)).toBe('not_configured');
    expect(createSidecarParser({ baseUrl: 'ftp://host', secret: fake.secret }).unavailableReason(file)).toBe('not_configured');
    expect(createSidecarParser({ baseUrl: fake.url, secret: '' }).unavailableReason(file)).toBe('secret_missing');
    expect(parser().unavailableReason(file)).toBeNull();
  });

  test('a result that fails ParseResultSchema is rejected and not passed on', async () => {
    fake.enqueue({ result: { markdown: 'x', chunks: 'not a list', parser: 'docling' } }, { result: { ...ParseResultSchema.parse({ markdown: 'ok', chunks: [], pictures: [], page_count: 1, parser: 'docling', parser_version: 'v' }), unexpected_key: true } });
    await expect(parser().parse(request(null))).rejects.toMatchObject({ reason: 'invalid_response' });
    await expect(parser().parse(request(null))).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  test('a failed job gives job_failed with its error class, and a missing artifact is a warning, not a failure', async () => {
    fake.enqueue({ statuses: ['failed'], errorClass: 'page_cap' });
    await expect(parser().parse(request(null))).rejects.toMatchObject({ reason: 'job_failed:page_cap' });

    fake.enqueue({ missingArtifacts: ['picture-2.png'] });
    const attempt = await done(parser().parse(request('images-en', {}, 'product_technical')));
    expect(attempt.artifacts.map((artifact) => artifact.name).sort()).toEqual(['docling.json', 'picture-1.png']);
    expect(attempt.warnings).toEqual(['artifact_unavailable']);
  });

  test('artifacts listed in the result are downloaded with their bytes and media type', async () => {
    const attempt = await done(parser().parse(request('images-en', {}, 'product_technical')));
    const png = attempt.artifacts.find((artifact) => artifact.name === 'picture-1.png');
    expect(png?.contentType).toBe('image/png');
    expect(png?.bytes.byteLength).toBeGreaterThan(8);
    expect(attempt.artifacts.find((artifact) => artifact.name === 'docling.json')?.contentType).toBe('application/json');
    expect(attempt.result.artifacts).toEqual(['docling.json', 'picture-1.png', 'picture-2.png']);
  });

  test('the secret never appears in an error or a log line, and a redirect is not followed', async () => {
    fake.enqueue({ submitStatus: 500 }, { submitRedirect: 'http://127.0.0.1:1/elsewhere' });
    const failed = await parser().parse(request(null)).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ParserError);
    const redirected = await parser().parse(request(null)).catch((error: unknown) => error);
    expect(redirected).toMatchObject({ reason: 'redirect' });
    const wrong = await createSidecarParser({ baseUrl: fake.url, secret: 'another-secret-value-0000000000000', sleep }).parse(request(null)).catch((error: unknown) => error);
    for (const secret of [fake.secret, 'another-secret-value-0000000000000']) {
      expect(JSON.stringify([(failed as Error).message, (redirected as Error).message, (wrong as Error).message, logged])).not.toContain(secret);
    }
  });

  test('an aborted signal stops the client before any request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(parser().parse(request(null, { signal: controller.signal }))).rejects.toBeDefined();
    expect(fake.calls).toHaveLength(0);
  });
});

describe('fixture PDFs through ingest() with the sidecar and no LlamaParse key', () => {
  function install() {
    const fakeDb = fakeIngestDb();
    installIngestDeps({ db: fakeDb.db, env: { RAG_INGEST_PIPELINE: 'unified', RAG_PARSER: 'llamaparse' } });
    setSidecarParserForTests(createSidecarParser({ baseUrl: fake.url, secret: fake.secret, sleep: async () => undefined }));
    return fakeDb;
  }

  const upload = (fixtureId: string, docType: 'financial_report' | 'scanned_image') =>
    ingest({
      scope,
      source: 'config_upload',
      sourceKey: `root/${fixtureId}.pdf`,
      file: fixtureBytes(fixtureId),
      filename: `${fixtureId}.pdf`,
      mimeType: 'application/pdf',
      docType,
      signal: new AbortController().signal,
    });

  test('the table PDF is parsed by the sidecar job, its table chunks keep their header, and parser_used says docling', async () => {
    const { calls } = install();
    const result = await upload('report-zh-table', 'financial_report');
    expect(result.status).toBe('ready');
    expect(result.parserUsed).toBe('docling');
    expect(result.warnings).toContain('parser_fallback:llamaparse:missing_key');
    const fields = callsOf(calls, 'rag_set_document_fields').map((call) => call.args.p_fields as Record<string, unknown>);
    expect(fields.some((field) => field.parser_used === 'docling')).toBe(true);
    const chunks = callsOf(calls, 'rag_write_chunks').flatMap((call) => call.args.p_chunks as Array<{ content: string; chunk_kind?: string }>);
    const tables = chunks.filter((chunk) => chunk.content.startsWith('|'));
    expect(tables.length).toBeGreaterThan(1);
    const header = tables[0]?.content.split('\n').slice(0, 2).join('\n');
    for (const chunk of tables) expect(chunk.content.startsWith(header as string)).toBe(true);
  });

  test('the scanned PDF is parsed by the sidecar job with full-page OCR', async () => {
    install();
    const result = await upload('scan-en', 'scanned_image');
    expect(result.status).toBe('ready');
    expect(result.parserUsed).toBe('docling');
    expect(fake.uploads[0]?.request).toMatchObject({ docling: { force_full_page_ocr: true } });
  });
});
