import { z } from 'zod/v3';
import { env } from '@/lib/env';
import { ParseResultSchema, type ParseResult } from '@/lib/rag-eval/contracts.generated';
import { isTenantScope } from '../../tenant/scope';
import { CloudRefused, assertCloudAllowed, reservePremium } from '../guard/cloud-budget';
import {
  MAX_ARTIFACT_BYTES,
  MAX_JOB_AGE_MS,
  MAX_RESULT_BYTES,
  REQUEST_TIMEOUT_MS,
  ParserError,
  backoffDelayMs,
  extensionOf,
  fetchParser,
  mediaTypeOf,
  readBody,
  readJson,
  realSleep,
  requestTimeoutMs,
  type DocumentParser,
  type ParseArtifact,
  type ParseAttempt,
  type ParseRequest,
  type PendingJob,
  type Sleep,
} from './shared';

const API_BASE = 'https://api.cloud.llamaindex.ai';
const UPLOAD_PATH = '/api/v2/parse/upload';
const JOB_PATH = '/api/v2/parse';
const EXPAND = 'markdown,items,images_content_metadata';
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Pictures kept per document; the images stage applies its own limit on top. */
export const MAX_IMAGES = 30;
const MAX_PAGE_WARNINGS = 20;
const MAX_TRANSIENT_POLL_FAILURES = 2;

export type LlamaParseTier = 'fast' | 'cost_effective' | 'agentic';

export interface ImagePolicy {
  hostAllowed: (host: string) => boolean;
  /** Tests only: allows http and a port, so a local fake can stand in for the image host. Never set from configuration. */
  allowInsecure?: boolean;
}

export interface LlamaParseConfig {
  baseUrl: string;
  apiKey: string;
  tier: LlamaParseTier;
  requestTimeoutMs?: number;
  sleep?: Sleep;
  imagePolicy?: ImagePolicy;
}

/** LLAMACLOUD_PARSING_MODE: fast to fast, balanced to cost_effective, premium to agentic; anything else is balanced. */
export function tierFor(mode: string | undefined): LlamaParseTier {
  const value = (mode ?? '').trim().toLowerCase();
  if (value === 'fast') return 'fast';
  if (value === 'premium') return 'agentic';
  return 'cost_effective';
}

// Presigned image URLs of LlamaCloud point at its own hosts and at S3 buckets. Anything else is not fetched.
const S3_HOST = /^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;

function isLlamaCloudHost(host: string): boolean {
  return host === 'llamaindex.ai' || host.endsWith('.llamaindex.ai') || S3_HOST.test(host);
}

const defaultImagePolicy: ImagePolicy = { hostAllowed: isLlamaCloudHost };

/** https only, no credentials, no port, and a host on the LlamaCloud allow-list: a presigned URL cannot be used to reach anything else. */
export function isAllowedImageUrl(value: string, policy: ImagePolicy = defaultImagePolicy): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  if (!policy.allowInsecure && (url.protocol !== 'https:' || url.port !== '')) return false;
  if (policy.allowInsecure && url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  if (host === '' || (!policy.allowInsecure && (/^[0-9.]+$/.test(host) || host.includes(':')))) return false;
  return policy.hostAllowed(host);
}

const PageSchema = z
  .object({ page_number: z.number().int().min(1), success: z.boolean(), markdown: z.string().nullish(), error: z.string().nullish() })
  .passthrough();
const ItemPageSchema = z
  .object({ page_number: z.number().int().min(1), page_width: z.number().positive().nullish(), page_height: z.number().positive().nullish(), items: z.array(z.record(z.unknown())).default([]) })
  .passthrough();
const JobSchema = z
  .object({
    job: z.object({ id: z.string().nullish(), status: z.string() }).passthrough(),
    markdown: z.object({ pages: z.array(PageSchema) }).nullish(),
    items: z.object({ pages: z.array(ItemPageSchema) }).nullish(),
  })
  .passthrough();
const UploadSchema = z.object({ id: z.string().regex(JOB_ID).nullish(), job_id: z.string().regex(JOB_ID).nullish() }).passthrough();

type Job = z.infer<typeof JobSchema>;
type Item = Record<string, unknown>;

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function applyHeadings(markdown: string, items: Item[]): string {
  const headings = items.filter((item) => item.type === 'heading' && asString(item.value).trim() !== '');
  if (headings.length === 0) return markdown;
  const lines = markdown.split('\n');
  const used = new Set<number>();
  for (const heading of headings) {
    const value = asString(heading.value).trim();
    const level = Math.min(6, Math.max(1, Math.trunc(asNumber(heading.level) ?? 1)));
    const index = lines.findIndex((line, position) => !used.has(position) && line.trim().replace(/^#{1,6}\s*/, '') === value);
    if (index < 0) continue;
    used.add(index);
    lines[index] = `${'#'.repeat(level)} ${value}`;
  }
  return lines.join('\n');
}

function applyTables(markdown: string, items: Item[]): string {
  let text = markdown;
  for (const item of items) {
    const html = asString(item.html);
    const md = asString(item.md);
    if (item.type === 'table' && html !== '' && md !== '' && text.includes(html)) text = text.replace(html, () => md);
  }
  return text;
}

/** The box as [x0, y0, x1, y1] from an object {x, y, w, h}, a list of such objects or a list of four numbers; null when it has no usable shape. */
function boxOf(raw: unknown): [number, number, number, number] | null {
  const value = Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object' ? (raw[0] as unknown) : raw;
  if (Array.isArray(value) && value.length === 4 && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
    return value as [number, number, number, number];
  }
  if (typeof value === 'object' && value !== null) {
    const box = value as Record<string, unknown>;
    const x = asNumber(box.x);
    const y = asNumber(box.y);
    const width = asNumber(box.w) ?? asNumber(box.width);
    const height = asNumber(box.h) ?? asNumber(box.height);
    if (x !== null && y !== null && width !== null && height !== null) return [x, y, x + width, y + height];
  }
  return null;
}

/** Share of the page the box covers; a box with no page size counts as a share only when it is in 0..1 units, otherwise as the whole page (never dropped on a guess). */
function areaShare(box: [number, number, number, number] | null, page: { page_width?: number | null; page_height?: number | null }): number {
  if (!box) return 1;
  const area = Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
  const pageArea = (page.page_width ?? 0) * (page.page_height ?? 0);
  const share = pageArea > 0 ? area / pageArea : box.every((entry) => entry >= 0 && entry <= 1) ? area : 1;
  return Math.min(1, Math.max(0, share));
}

const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export function createLlamaParseParser(config: LlamaParseConfig): DocumentParser {
  const sleep = config.sleep ?? realSleep;
  const policy = config.imagePolicy ?? defaultImagePolicy;
  const base = config.baseUrl.replace(/\/+$/, '');
  const apiKey = config.apiKey.trim();
  const version = `llamaparse-v2/${config.tier}@latest`;

  const headers = (): Record<string, string> => ({ authorization: `Bearer ${apiKey}`, accept: 'application/json' });
  const timeoutFor = (request: ParseRequest): number => requestTimeoutMs(request, config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
  const statusError = (status: number): ParserError => new ParserError('llamaparse', `http_${status}`);

  /** The guard decides before any byte is read into a request; a refusal is thrown as CloudRefused (D-17, D-18). */
  function requireCloud(): void {
    const gate = assertCloudAllowed('parse');
    if (!gate.ok) throw new CloudRefused(gate.reason);
  }

  async function reserveForUpload(request: ParseRequest): Promise<void> {
    const guard = request.guard;
    if (!guard) return;
    const reserved = await reservePremium(guard.context, { signal: request.signal });
    if (!reserved.ok) throw new CloudRefused(reserved.reason);
    if (reserved.handle) await guard.onReserved?.(reserved.handle);
  }

  async function submit(request: ParseRequest, attempt: number): Promise<PendingJob> {
    requireCloud();
    const form = new FormData();
    const extension = extensionOf(request.filename);
    form.set('file', new Blob([request.bytes as unknown as BlobPart]), `document.${extension === '' ? 'bin' : extension}`);
    form.set('configuration', JSON.stringify({ tier: config.tier, version: 'latest' }));
    const response = await fetchParser('llamaparse', `${base}${UPLOAD_PATH}`, { method: 'POST', headers: headers(), body: form }, request.signal, timeoutFor(request));
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw statusError(response.status);
    }
    const parsed = UploadSchema.safeParse(await readJson('llamaparse', response, MAX_RESULT_BYTES, request.signal));
    const jobId = parsed.success ? (parsed.data.id ?? parsed.data.job_id ?? null) : null;
    if (!jobId) throw new ParserError('llamaparse', 'invalid_response');
    const job: PendingJob = { parser: 'llamaparse', jobId, submittedAt: new Date(request.now()).toISOString(), attempt };
    // Saved before the first poll, so a request that ends mid-wait can resume this job.
    await request.onSubmitted(job);
    return job;
  }

  /** The job as the service reports it, or null when the service no longer knows it. */
  async function fetchJob(request: ParseRequest, job: PendingJob): Promise<Job | null> {
    const url = `${base}${JOB_PATH}/${encodeURIComponent(job.jobId)}?expand=${encodeURIComponent(EXPAND)}`;
    const response = await fetchParser('llamaparse', url, { method: 'GET', headers: headers() }, request.signal, timeoutFor(request));
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw statusError(response.status);
    }
    const parsed = JobSchema.safeParse(await readJson('llamaparse', response, MAX_RESULT_BYTES, request.signal));
    if (!parsed.success) throw new ParserError('llamaparse', 'invalid_response');
    return parsed.data;
  }

  const transient = (error: unknown): boolean =>
    error instanceof ParserError && (error.reason === 'network' || error.reason === 'timeout' || /^http_5\d\d$/.test(error.reason));

  async function fetchImage(request: ParseRequest, url: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    try {
      // No Authorization header: the key goes to LlamaCloud only, never to the host a presigned URL names.
      const response = await fetchParser('llamaparse', url, { method: 'GET', headers: { accept: 'image/*' } }, request.signal, timeoutFor(request));
      const contentType = mediaTypeOf(response.headers.get('content-type') ?? '');
      if (!response.ok || !(contentType in IMAGE_EXTENSIONS)) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      return { bytes: await readBody('llamaparse', response, MAX_ARTIFACT_BYTES, request.signal), contentType };
    } catch (error) {
      if (request.signal.aborted) throw error;
      return null;
    }
  }

  async function mapResult(request: ParseRequest, job: Job): Promise<ParseAttempt> {
    const warnings: string[] = [];
    const pages = [...(job.markdown?.pages ?? [])].sort((a, b) => a.page_number - b.page_number);
    const itemPages = new Map((job.items?.pages ?? []).map((page) => [page.page_number, page]));
    const parts: string[] = [];
    let partial = false;
    for (const page of pages) {
      if (!page.success) {
        partial = true;
        if (warnings.length < MAX_PAGE_WARNINGS) warnings.push(`llamaparse_page_failed:${page.page_number}`);
        continue;
      }
      const items = (itemPages.get(page.page_number)?.items ?? []) as Item[];
      const text = applyTables(applyHeadings(page.markdown ?? '', items), items);
      if (text.trim() !== '') parts.push(text.trim());
    }
    if (pages.length === 0 || parts.length === 0) throw new ParserError('llamaparse', 'empty_result');

    const pictures: ParseResult['pictures'] = [];
    const artifacts: ParseArtifact[] = [];
    let skipped = false;
    for (const page of [...itemPages.values()].sort((a, b) => a.page_number - b.page_number)) {
      for (const item of page.items as Item[]) {
        if (item.type !== 'image' || pictures.length >= MAX_IMAGES) continue;
        const url = asString(item.url);
        const image = url !== '' && isAllowedImageUrl(url, policy) ? await fetchImage(request, url) : null;
        if (!image) {
          skipped = true;
          continue;
        }
        const name = `picture-${pictures.length + 1}.${IMAGE_EXTENSIONS[image.contentType] as string}`;
        const box = boxOf(item.bbox);
        pictures.push({ page: page.page_number, bbox: box ?? [0, 0, 0, 0], image_ref: name, page_area_share: areaShare(box, page) });
        artifacts.push({ name, bytes: image.bytes, contentType: image.contentType });
      }
    }
    if (skipped) warnings.push('llamaparse_image_skipped');

    const candidate: ParseResult = {
      markdown: parts.join('\n\n'),
      chunks: [],
      pictures,
      page_count: Math.max(...pages.map((page) => page.page_number)),
      language: null,
      parser: 'llamaparse',
      parser_version: version,
      partial,
      text_layer_page_share: null,
      warnings,
      ...(artifacts.length > 0 ? { artifacts: artifacts.map((artifact) => artifact.name) } : {}),
    };
    const checked = ParseResultSchema.safeParse(candidate);
    if (!checked.success) throw new ParserError('llamaparse', 'invalid_response');
    return { kind: 'done', result: checked.data, artifacts, warnings: [] };
  }

  return {
    name: 'llamaparse',
    unavailableReason: () => (apiKey === '' ? 'missing_key' : null),
    async parse(request) {
      requireCloud();
      // The minted scope proves a verified caller; there is no way to spend LlamaParse credit without one.
      if (!isTenantScope(request.scope)) throw new ParserError('llamaparse', 'scope_unverified');
      if (apiKey === '') throw new ParserError('llamaparse', 'missing_key');
      request.signal.throwIfAborted();

      if (!request.resume) await reserveForUpload(request);
      let job = request.resume ?? (await submit(request, 1));
      let poll = 0;
      let failures = 0;
      for (;;) {
        let state: Job | null;
        try {
          state = await fetchJob(request, job);
        } catch (error) {
          if (!transient(error) || ++failures > MAX_TRANSIENT_POLL_FAILURES) throw error;
          await sleep(Math.max(0, Math.min(backoffDelayMs(poll++), request.pollUntil - request.now())), request.signal);
          continue;
        }
        failures = 0;
        if (state === null) {
          // The service no longer knows the job: submit again once, then give up.
          // A metered request holds one reservation for one upload; a second upload would be unreserved.
          if (job.attempt >= 2 || request.guard) throw new ParserError('llamaparse', 'job_lost');
          job = await submit(request, job.attempt + 1);
          continue;
        }
        const status = state.job.status.toUpperCase();
        if (status === 'COMPLETED') return mapResult(request, state);
        if (status === 'FAILED' || status === 'CANCELLED') throw new ParserError('llamaparse', 'job_failed');
        if (status !== 'PENDING' && status !== 'RUNNING') throw new ParserError('llamaparse', 'invalid_response');
        if (request.now() - Date.parse(job.submittedAt) > MAX_JOB_AGE_MS) throw new ParserError('llamaparse', 'timeout');
        const remaining = request.pollUntil - request.now();
        if (remaining <= 0) return { kind: 'pending', job };
        await sleep(Math.min(backoffDelayMs(poll++), remaining), request.signal);
      }
    },
  };
}

const unconfigured: DocumentParser = {
  name: 'llamaparse',
  unavailableReason: () => 'missing_key',
  async parse() {
    throw new ParserError('llamaparse', 'missing_key');
  },
};

let override: DocumentParser | null = null;

/** The parser for this process: the key and tier come from LLAMA_CLOUD_API_KEY and LLAMACLOUD_PARSING_MODE; an empty key is reported as missing_key. */
export function getLlamaParseParser(): DocumentParser {
  if (override) return override;
  const apiKey = (env.LLAMA_CLOUD_API_KEY ?? '').trim();
  if (apiKey === '') return unconfigured;
  return createLlamaParseParser({ baseUrl: API_BASE, apiKey, tier: tierFor(env.LLAMACLOUD_PARSING_MODE) });
}

export function setLlamaParseParserForTests(parser: DocumentParser): void {
  override = parser;
}

export function resetLlamaParseParserForTests(): void {
  override = null;
}
