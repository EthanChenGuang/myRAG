import { env } from '@/lib/env';
import {
  ParseJobAcceptedSchema,
  ParseJobRequestSchema,
  ParseJobStateSchema,
  ParseResultSchema,
  SidecarErrorSchema,
  type ParseJobState,
  type ParseResult,
} from '@/lib/rag-eval/contracts.generated';
import {
  MAX_ARTIFACTS,
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

const SECRET_HEADER = 'x-sidecar-secret';
const MAX_TRANSIENT_POLL_FAILURES = 2;
const DELETE_TIMEOUT_MS = 5000;

export interface SidecarConfig {
  baseUrl: string;
  secret: string;
  requestTimeoutMs?: number;
  sleep?: Sleep;
}

export type SidecarInputFormat = 'pdf' | 'docx' | 'html' | 'image';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/tiff']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff']);

/** What the sidecar's `input_format` is for a file (research Open Question 5): pdf, docx, html, or image for png, jpeg and tiff; null when it cannot take the file. */
export function inputFormatFor(filename: string, mimeType: string): SidecarInputFormat | null {
  const extension = extensionOf(filename);
  const media = mediaTypeOf(mimeType);
  if (extension === 'pdf' || media === 'application/pdf') return 'pdf';
  if (extension === 'docx' || media === DOCX_MIME) return 'docx';
  if (extension === 'html' || extension === 'htm' || media === 'text/html') return 'html';
  if (IMAGE_EXTENSIONS.has(extension) || IMAGE_MIME.has(media)) return 'image';
  return null;
}

function baseUrlOf(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function createSidecarParser(config: SidecarConfig): DocumentParser {
  const sleep = config.sleep ?? realSleep;
  const base = baseUrlOf(config.baseUrl);
  const secret = config.secret.trim();
  const timeoutFor = (request: ParseRequest): number => requestTimeoutMs(request, config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
  // The secret is only ever the value of this header: it is never put in a URL, a message, a reason or a log line.
  const headers = (): Record<string, string> => ({ [SECRET_HEADER]: secret, accept: 'application/json' });

  /** The reason for a refusal: 503 docling_unavailable keeps its name, everything else is its status. */
  async function refusal(response: Response, signal: AbortSignal): Promise<ParserError> {
    let error = '';
    try {
      const parsed = SidecarErrorSchema.safeParse(await readJson('docling', response, 4096, signal));
      error = parsed.success ? parsed.data.error : '';
    } catch (caught) {
      if (signal.aborted) throw caught;
    }
    return new ParserError('docling', response.status === 503 && error === 'docling_unavailable' ? 'docling_unavailable' : `http_${response.status}`);
  }

  async function submit(request: ParseRequest, format: SidecarInputFormat, attempt: number): Promise<PendingJob> {
    const parsedRequest = ParseJobRequestSchema.safeParse({
      profile_id: request.profile.id,
      profile_version: request.profile.version,
      input_format: format,
      docling: request.profile.parser.docling,
      ocr_languages: request.profile.parser.ocr_languages,
      tokenizer: 'cl100k_base',
      max_tokens: request.profile.chunker.max_tokens,
      repeat_table_header: request.profile.chunker.repeat_table_header,
      page_cap: null,
    });
    if (!parsedRequest.success) throw new ParserError('docling', 'invalid_request');
    const form = new FormData();
    // The upload is always named input.bin: a filename never reaches the sidecar.
    form.set('file', new Blob([request.bytes as unknown as BlobPart]), 'input.bin');
    form.set('request', JSON.stringify(parsedRequest.data));
    const response = await fetchParser('docling', `${base}/v1/parse/jobs`, { method: 'POST', headers: headers(), body: form }, request.signal, timeoutFor(request));
    if (response.status !== 202 && response.status !== 200) throw await refusal(response, request.signal);
    const accepted = ParseJobAcceptedSchema.safeParse(await readJson('docling', response, 4096, request.signal));
    if (!accepted.success) throw new ParserError('docling', 'invalid_response');
    const job: PendingJob = { parser: 'docling', jobId: accepted.data.job_id, submittedAt: new Date(request.now()).toISOString(), attempt };
    // Saved before the first poll, so a request that ends mid-wait can resume this job.
    await request.onSubmitted(job);
    return job;
  }

  /** The job state, or null when the sidecar no longer knows the job (404). */
  async function fetchState(request: ParseRequest, job: PendingJob): Promise<ParseJobState | null> {
    const response = await fetchParser('docling', `${base}/v1/parse/jobs/${encodeURIComponent(job.jobId)}`, { method: 'GET', headers: headers() }, request.signal, timeoutFor(request));
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) throw await refusal(response, request.signal);
    const parsed = ParseJobStateSchema.safeParse(await readJson('docling', response, MAX_RESULT_BYTES, request.signal));
    if (!parsed.success) throw new ParserError('docling', 'invalid_response');
    return parsed.data;
  }

  const transient = (error: unknown): boolean =>
    error instanceof ParserError && (error.reason === 'network' || error.reason === 'timeout' || /^http_5\d\d$/.test(error.reason));

  async function download(request: ParseRequest, job: PendingJob, result: ParseResult): Promise<{ artifacts: ParseArtifact[]; warnings: string[] }> {
    const artifacts: ParseArtifact[] = [];
    const warnings: string[] = [];
    for (const name of (result.artifacts ?? []).slice(0, MAX_ARTIFACTS)) {
      try {
        const url = `${base}/v1/parse/jobs/${encodeURIComponent(job.jobId)}/artifacts/${encodeURIComponent(name)}`;
        const response = await fetchParser('docling', url, { method: 'GET', headers: headers() }, request.signal, timeoutFor(request));
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new ParserError('docling', `http_${response.status}`);
        }
        const contentType = mediaTypeOf(response.headers.get('content-type') ?? '') || 'application/octet-stream';
        artifacts.push({ name, bytes: await readBody('docling', response, MAX_ARTIFACT_BYTES, request.signal), contentType });
      } catch (error) {
        if (request.signal.aborted) throw error;
        if (!warnings.includes('artifact_unavailable')) warnings.push('artifact_unavailable');
      }
    }
    return { artifacts, warnings };
  }

  /** The sidecar keeps finished jobs for an hour; the app removes its own once it holds the result. A failure here changes nothing. */
  async function remove(request: ParseRequest, job: PendingJob): Promise<void> {
    try {
      const response = await fetchParser('docling', `${base}/v1/parse/jobs/${encodeURIComponent(job.jobId)}`, { method: 'DELETE', headers: headers() }, request.signal, DELETE_TIMEOUT_MS);
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (request.signal.aborted) throw error;
    }
  }

  return {
    name: 'docling',
    unavailableReason(file) {
      if (base === null) return 'not_configured';
      if (secret === '') return 'secret_missing';
      return inputFormatFor(file.filename, file.mimeType) === null ? 'unsupported_format' : null;
    },
    async parse(request): Promise<ParseAttempt> {
      if (base === null) throw new ParserError('docling', 'not_configured');
      if (secret === '') throw new ParserError('docling', 'secret_missing');
      const format = inputFormatFor(request.filename, request.mimeType);
      if (format === null) throw new ParserError('docling', 'unsupported_format');
      request.signal.throwIfAborted();

      let job = request.resume ?? (await submit(request, format, 1));
      let poll = 0;
      let failures = 0;
      for (;;) {
        let state: ParseJobState | null;
        try {
          state = await fetchState(request, job);
        } catch (error) {
          if (!transient(error) || ++failures > MAX_TRANSIENT_POLL_FAILURES) throw error;
          await sleep(Math.max(0, Math.min(backoffDelayMs(poll++), request.pollUntil - request.now())), request.signal);
          continue;
        }
        failures = 0;
        if (state === null || state.status === 'expired') {
          // The sidecar lost the job (TTL or restart): submit again once, then give up.
          if (job.attempt >= 2) throw new ParserError('docling', 'job_lost');
          job = await submit(request, format, job.attempt + 1);
          continue;
        }
        if (state.status === 'succeeded') {
          const result = ParseResultSchema.safeParse(state.result);
          if (!result.success) throw new ParserError('docling', 'invalid_response');
          const { artifacts, warnings } = await download(request, job, result.data);
          await remove(request, job);
          return { kind: 'done', result: result.data, artifacts, warnings };
        }
        if (state.status === 'failed') throw new ParserError('docling', `job_failed:${(state.error_class ?? 'unknown').slice(0, 40)}`);
        if (request.now() - Date.parse(job.submittedAt) > MAX_JOB_AGE_MS) throw new ParserError('docling', 'timeout');
        const remaining = request.pollUntil - request.now();
        if (remaining <= 0) return { kind: 'pending', job };
        await sleep(Math.min(backoffDelayMs(poll++), remaining), request.signal);
      }
    },
  };
}

const unavailable: DocumentParser = {
  name: 'docling',
  unavailableReason: () => 'not_configured',
  async parse() {
    throw new ParserError('docling', 'not_configured');
  },
};

let override: DocumentParser | null = null;

/** The parser for this process, from RAG_SIDECAR_URL and RAG_SIDECAR_SECRET; an empty URL is reported as not_configured. */
export function getSidecarParser(): DocumentParser {
  if (override) return override;
  if ((env.RAG_SIDECAR_URL ?? '').trim() === '') return unavailable;
  return createSidecarParser({ baseUrl: env.RAG_SIDECAR_URL, secret: env.RAG_SIDECAR_SECRET ?? '' });
}

export function setSidecarParserForTests(parser: DocumentParser): void {
  override = parser;
}

export function resetSidecarParserForTests(): void {
  override = null;
}
