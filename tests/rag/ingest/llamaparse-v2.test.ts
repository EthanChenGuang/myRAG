import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ParseResultSchema } from '@/lib/rag-eval/contracts.generated';
import { createLlamaParseParser, isAllowedImageUrl, tierFor, type ImagePolicy } from '@/lib/rag/ingest/parsers/llamaparse-v2';
import { ParserError, type ParseAttempt, type ParseRequest, type PendingJob } from '@/lib/rag/ingest/parsers/shared';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { mintScope } from '@/lib/rag/tenant/scope';
import { THREE_PAGES, startFakeLlamaParse, type FakeLlamaParse } from '../../helpers/fake-llamaparse';

const scope = mintScope('single', null, null);
const PDF = new TextEncoder().encode('%PDF-1.4 llama fixture');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const localImages: ImagePolicy = { hostAllowed: (host) => host === '127.0.0.1', allowInsecure: true };

let fake: FakeLlamaParse;
let clock: { t: number; now: () => number; sleeps: number[]; sleep: (ms: number) => Promise<void> };
let logged: unknown[][];

beforeEach(async () => {
  fake = await startFakeLlamaParse();
  const state = { t: 0, sleeps: [] as number[] };
  clock = {
    get t() {
      return state.t;
    },
    now: () => state.t,
    sleeps: state.sleeps,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      state.t += ms;
    },
  } as typeof clock;
  logged = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args));
});

afterEach(async () => {
  await fake.close();
  vi.restoreAllMocks();
});

function parser(overrides: Partial<Parameters<typeof createLlamaParseParser>[0]> = {}) {
  return createLlamaParseParser({ baseUrl: fake.url, apiKey: fake.apiKey, tier: 'cost_effective', sleep: async (ms) => clock.sleep(ms), imagePolicy: localImages, ...overrides });
}

function request(overrides: Partial<ParseRequest> = {}): ParseRequest & { submitted: PendingJob[] } {
  const submitted: PendingJob[] = [];
  return {
    scope,
    filename: 'plan.pdf',
    mimeType: 'application/pdf',
    bytes: PDF,
    profile: getProcessingProfile('general'),
    signal: new AbortController().signal,
    now: clock.now,
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

describe('LlamaParse v2 adapter', () => {
  test('uploads the file and a configuration with the mapped tier and version latest under the bearer key, and polls with expand', async () => {
    await done(parser().parse(request()));
    const upload = fake.calls.find((call) => call.method === 'POST');
    expect(upload?.path).toBe('/api/v2/parse/upload');
    expect(upload?.authorized).toBe(true);
    expect(upload?.contentType).toMatch(/^multipart\/form-data/);
    expect(fake.uploads[0]).toMatchObject({ fileBytes: PDF.byteLength, configuration: { tier: 'cost_effective', version: 'latest' } });
    const poll = fake.calls.find((call) => call.method === 'GET');
    expect(poll?.path).toBe('/api/v2/parse/job-1');
    expect(poll?.query).toBe('?expand=markdown%2Citems%2Cimages_content_metadata');
    expect(tierFor('fast')).toBe('fast');
    expect(tierFor('balanced')).toBe('cost_effective');
    expect(tierFor('premium')).toBe('agentic');
  });

  test('a COMPLETED job with three pages gives page-ordered Markdown, page_count 3, heading levels from items and no chunks', async () => {
    fake.enqueue({
      pages: [THREE_PAGES[2]!, THREE_PAGES[0]!, THREE_PAGES[1]!],
      itemPages: [
        { page_number: 1, items: [{ type: 'heading', level: 1, value: 'Handbook', md: '# Handbook' }] },
        {
          page_number: 2,
          items: [
            { type: 'heading', level: 2, value: 'Receiving', md: '## Receiving' },
            { type: 'table', md: '| a | b |\n| --- | --- |\n| 1 | 2 |', html: '<table><tr><td>1</td></tr></table>' },
          ],
        },
      ],
    });
    const attempt = await done(parser().parse(request()));
    const { result } = attempt;
    expect(result.parser).toBe('llamaparse');
    expect(result.parser_version).toBe('llamaparse-v2/cost_effective@latest');
    expect(result.page_count).toBe(3);
    expect(result.chunks).toEqual([]);
    expect(result.partial).toBe(false);
    expect(result.markdown.indexOf('First page')).toBeLessThan(result.markdown.indexOf('Second page'));
    expect(result.markdown.indexOf('Second page')).toBeLessThan(result.markdown.indexOf('Third page'));
    expect(result.markdown).toContain('# Handbook\n');
    expect(result.markdown).toContain('## Receiving\n');
    expect(ParseResultSchema.safeParse(result).success).toBe(true);
  });

  test('a page with success false sets partial and a warning, and the other pages are kept', async () => {
    fake.enqueue({ pages: [THREE_PAGES[0]!, { page_number: 2, success: false, error: 'ocr failed' }, THREE_PAGES[2]!] });
    const { result } = await done(parser().parse(request()));
    expect(result.partial).toBe(true);
    expect(result.warnings).toContain('llamaparse_page_failed:2');
    expect(result.markdown).toContain('First page');
    expect(result.markdown).toContain('Third page');
    expect(result.markdown).not.toContain('ocr failed');
  });

  test('image items become pictures with their page and area share, fetched without the API key', async () => {
    fake.setImage('a.png', PNG, 'image/png');
    fake.enqueue({
      itemPages: [{ page_number: 2, items: [{ type: 'image', url: fake.imageUrl('a.png'), caption: 'A pallet', bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.4 } }] }],
    });
    const attempt = await done(parser().parse(request()));
    expect(attempt.result.pictures).toEqual([{ page: 2, bbox: [0.1, 0.1, 0.6, 0.5], image_ref: 'picture-1.png', page_area_share: expect.closeTo(0.2, 5) }]);
    expect(attempt.result.artifacts).toEqual(['picture-1.png']);
    expect(attempt.artifacts).toEqual([{ name: 'picture-1.png', bytes: PNG, contentType: 'image/png' }]);
    const fetched = fake.calls.find((call) => call.path === '/images/a.png');
    expect(fetched?.hasAuthorization).toBe(false);
  });

  test('presigned image URLs are fetched only over https from allow-listed hosts; others are skipped with a warning and never requested', async () => {
    expect(isAllowedImageUrl('https://llama-files.s3.amazonaws.com/x.png')).toBe(true);
    expect(isAllowedImageUrl('https://files.cloud.llamaindex.ai/x.png')).toBe(true);
    expect(isAllowedImageUrl('http://files.cloud.llamaindex.ai/x.png')).toBe(false);
    expect(isAllowedImageUrl('https://evil.example.com/x.png')).toBe(false);
    expect(isAllowedImageUrl('https://llamaindex.ai.evil.example.com/x.png')).toBe(false);
    expect(isAllowedImageUrl('https://169.254.169.254/latest')).toBe(false);
    expect(isAllowedImageUrl('https://user:pw@files.cloud.llamaindex.ai/x.png')).toBe(false);
    expect(isAllowedImageUrl('https://files.cloud.llamaindex.ai:8443/x.png')).toBe(false);
    expect(isAllowedImageUrl('not a url')).toBe(false);

    fake.setImage('b.png', PNG, 'image/png');
    fake.enqueue({
      itemPages: [
        { page_number: 1, items: [{ type: 'image', url: 'http://127.0.0.1/never.png' }, { type: 'image', url: fake.imageUrl('b.png') }] },
      ],
    });
    const attempt = await done(createLlamaParseParser({ baseUrl: fake.url, apiKey: fake.apiKey, tier: 'fast', sleep: async (ms) => clock.sleep(ms) }).parse(request()));
    expect(attempt.result.pictures).toEqual([]);
    expect(attempt.result.warnings).toContain('llamaparse_image_skipped');
    expect(fake.calls.some((call) => call.path.startsWith('/images/'))).toBe(false);
  });

  test('an image URL that redirects is skipped, so the fetch never leaves the allowed host', async () => {
    fake.redirectImage('r.png', 'http://127.0.0.1:1/elsewhere.png');
    fake.enqueue({ itemPages: [{ page_number: 1, items: [{ type: 'image', url: fake.imageUrl('r.png') }] }] });
    const attempt = await done(parser().parse(request()));
    expect(attempt.result.pictures).toEqual([]);
    expect(attempt.result.warnings).toContain('llamaparse_image_skipped');
  });

  test('the job id reaches the caller before the first poll', async () => {
    const req = request();
    await done(parser().parse(req));
    expect(req.submitted).toEqual([{ parser: 'llamaparse', jobId: 'job-1', submittedAt: new Date(0).toISOString(), attempt: 1 }]);
    const upload = fake.calls.findIndex((call) => call.method === 'POST');
    const firstPoll = fake.calls.findIndex((call) => call.method === 'GET');
    expect(upload).toBeLessThan(firstPoll);
  });

  test('polling backs off 500 ms doubling to 5 s and reports pending when the budget runs out', async () => {
    fake.enqueue({ statuses: ['RUNNING'] });
    const req = request({ pollUntil: 20_000 });
    const attempt = await parser().parse(req);
    expect(attempt).toEqual({ kind: 'pending', job: { parser: 'llamaparse', jobId: 'job-1', submittedAt: new Date(0).toISOString(), attempt: 1 } });
    expect(clock.sleeps.slice(0, 6)).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
    expect(clock.t).toBeLessThanOrEqual(20_000);
  });

  test('a resume polls the saved job without a new upload; a 404 resubmits exactly once and a second 404 gives up', async () => {
    fake.enqueue({ statuses: ['RUNNING', 'RUNNING', 'COMPLETED'] });
    const first = await parser().parse(request({ pollUntil: 0 }));
    expect(first.kind).toBe('pending');
    if (first.kind !== 'pending') return;
    const resumed = await done(parser().parse(request({ resume: first.job })));
    expect(resumed.result.page_count).toBe(3);
    expect(fake.uploads).toHaveLength(1);

    fake.expire('job-1');
    fake.enqueue({ statuses: ['COMPLETED'] });
    const resubmitted = request({ resume: first.job });
    await done(parser().parse(resubmitted));
    expect(fake.uploads).toHaveLength(2);
    expect(resubmitted.submitted).toEqual([expect.objectContaining({ jobId: 'job-2', attempt: 2 })]);

    fake.expire('job-2');
    await expect(parser().parse(request({ resume: { parser: 'llamaparse', jobId: 'job-2', submittedAt: new Date(0).toISOString(), attempt: 2 } }))).rejects.toMatchObject({ reason: 'job_lost' });
    expect(fake.uploads).toHaveLength(2);
  });

  test('an HTTP error, a FAILED job and a hung service end as http_500, job_failed and timeout', async () => {
    fake.enqueue({ uploadStatus: 500 });
    await expect(parser().parse(request())).rejects.toMatchObject({ reason: 'http_500' });
    fake.enqueue({ statuses: ['RUNNING', 'FAILED'] });
    await expect(parser().parse(request())).rejects.toMatchObject({ reason: 'job_failed' });
    fake.enqueue({ hangOnPoll: true });
    await expect(parser({ requestTimeoutMs: 100 }).parse(request())).rejects.toMatchObject({ reason: 'timeout' });
  });

  test('a job older than the age limit that still runs is a timeout', async () => {
    fake.enqueue({ statuses: ['RUNNING'] });
    const job: PendingJob = { parser: 'llamaparse', jobId: 'job-1', submittedAt: new Date(0).toISOString(), attempt: 1 };
    await parser().parse(request({ pollUntil: 0 }));
    clock.sleeps.length = 0;
    const later = { t: 20 * 60_000 };
    await expect(parser().parse(request({ resume: job, now: () => later.t, pollUntil: later.t + 10_000 }))).rejects.toMatchObject({ reason: 'timeout' });
  });

  test('the key never appears in a thrown error or a log line', async () => {
    for (const spec of [{ uploadStatus: 500 }, { statuses: ['FAILED'] }, { pollStatus: 502 }]) {
      fake.enqueue(spec);
      const error = await parser().parse(request()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ParserError);
      expect(JSON.stringify([String((error as Error).message), (error as Error).stack ?? '', logged])).not.toContain(fake.apiKey);
    }
    const wrong = await createLlamaParseParser({ baseUrl: fake.url, apiKey: 'llx-wrong-key-9999', tier: 'fast', sleep: async (ms) => clock.sleep(ms) }).parse(request()).catch((caught: unknown) => caught);
    expect(wrong).toMatchObject({ reason: 'http_401' });
    expect(JSON.stringify([(wrong as Error).message, logged])).not.toContain('llx-wrong-key-9999');
  });

  test('an aborted signal cancels the upload and the polling', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(parser().parse(request({ signal: controller.signal }))).rejects.toBeDefined();
    expect(fake.calls).toHaveLength(0);

    const later = new AbortController();
    fake.enqueue({ statuses: ['RUNNING'] });
    const sleeping = createLlamaParseParser({ baseUrl: fake.url, apiKey: fake.apiKey, tier: 'fast', sleep: async () => later.abort() });
    await expect(sleeping.parse(request({ signal: later.signal }))).rejects.toBeDefined();
    expect(fake.calls.filter((call) => call.method === 'GET').length).toBeLessThanOrEqual(1);
  });

  test('without a key it is unavailable as missing_key, and without a minted scope it refuses to run', async () => {
    expect(createLlamaParseParser({ baseUrl: fake.url, apiKey: '  ', tier: 'fast' }).unavailableReason({ filename: 'a.pdf', mimeType: 'application/pdf' })).toBe('missing_key');
    expect(parser().unavailableReason({ filename: 'a.pdf', mimeType: 'application/pdf' })).toBeNull();
    await expect(parser().parse(request({ scope: { kind: 'single' } as unknown as ParseRequest['scope'] }))).rejects.toMatchObject({ reason: 'scope_unverified' });
    expect(fake.calls).toHaveLength(0);
  });
});
