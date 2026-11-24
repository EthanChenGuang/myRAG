import type { ParseResult } from '@/lib/rag-eval/contracts.generated';
import type { TenantScope } from '../../tenant/scope';
import type { ProcessingProfile } from '../profiles/load';

/** The two parsers that call a service. */
export type NetworkParserName = 'llamaparse' | 'docling';
/** Every parser the chain can end on; equal to ParseResult['parser']. */
export type ParserName = NetworkParserName | 'text';

export const BACKOFF_START_MS = 500;
export const BACKOFF_CAP_MS = 5000;
/** One HTTP request to a parser service, upload and download included. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** A job that has been submitted for longer than this and still runs counts as a timeout, so a stuck job cannot hold a document for ever. */
export const MAX_JOB_AGE_MS = 15 * 60_000;
/** Largest result body read from a parser service. */
export const MAX_RESULT_BYTES = 32 * 1024 * 1024;
/** Largest single artifact or image downloaded from a parser service. */
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const MAX_ARTIFACTS = 64;

/** A parse job a parser submitted: what processing_state records before the first poll so a resume can poll the same job. */
export interface PendingJob {
  parser: NetworkParserName;
  jobId: string;
  submittedAt: string;
  attempt: number;
}

export interface ParseArtifact {
  name: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface ParseRequest {
  /** The minted scope of the run; LlamaParse refuses to run without one. */
  scope: TenantScope;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  profile: ProcessingProfile;
  signal: AbortSignal;
  now: () => number;
  /** Absolute time, in now() units, by which the whole request must have returned. */
  deadline: number;
  /** Absolute time, in now() units, until which a parser may poll before it reports the job as pending. */
  pollUntil: number;
  /** A job an earlier call submitted and saved: poll it instead of submitting. */
  resume: PendingJob | null;
  /** Called with a freshly submitted job before the first poll, so the caller can save it. */
  onSubmitted: (job: PendingJob) => Promise<void>;
}

export type ParseAttempt =
  | { kind: 'done'; result: ParseResult; artifacts: ParseArtifact[]; warnings: string[] }
  | { kind: 'pending'; job: PendingJob };

export interface DocumentParser {
  readonly name: NetworkParserName;
  /** Null when the parser can take this file; otherwise the code the chain logs when it skips the parser. */
  unavailableReason(file: { filename: string; mimeType: string }): string | null;
  parse(request: ParseRequest): Promise<ParseAttempt>;
}

/** A parser that cannot or did not parse. The reason is a short code: no URL, key, secret, header or document text ever enters it. */
export class ParserError extends Error {
  readonly parser: ParserName;
  readonly reason: string;

  constructor(parser: ParserName, reason: string) {
    const code = reason.replace(/[^A-Za-z0-9_.:@-]/g, '_').slice(0, 64) || 'error';
    super(`[Ingest] parser ${parser} failed (${code})`);
    this.name = 'ParserError';
    this.parser = parser;
    this.reason = code;
  }
}

/** 500 ms doubling to a 5 s cap: poll 0 waits 500 ms, poll 1 waits 1 s, and so on. */
export function backoffDelayMs(poll: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.max(0, Math.min(poll, 16)));
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** The time one request may take: the request timeout, shortened to what is left of the deadline, never under one second. */
export function requestTimeoutMs(request: Pick<ParseRequest, 'now' | 'deadline'>, ceiling = REQUEST_TIMEOUT_MS): number {
  return Math.max(1000, Math.min(ceiling, request.deadline - request.now() - 1000));
}

/**
 * One fetch with a timeout and no redirect. A redirect is never followed, so a header that carries a secret cannot reach another
 * host. The caller's abort is rethrown as it is; a timeout, a network failure and a redirect become ParserError codes.
 */
export async function fetchParser(
  parser: ParserName,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    const name = error instanceof Error ? error.name : '';
    throw new ParserError(parser, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new ParserError(parser, 'redirect');
  }
  return response;
}

/** The whole body, refused as too_large past the limit (a declared length over it is refused before reading). */
export async function readBody(parser: ParserName, response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ParserError(parser, 'too_large');
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ParserError(parser, 'too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ParserError) throw error;
    if (signal.aborted) throw signal.reason ?? error;
    throw new ParserError(parser, 'network');
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJson(parser: ParserName, response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const body = await readBody(parser, response, maxBytes, signal);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new ParserError(parser, 'invalid_response');
  }
}

/** The extension of a filename when it is 1 to 8 ASCII letters or digits, lower-cased; empty otherwise. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const extension = dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : '';
}

export function mediaTypeOf(mimeType: string): string {
  return (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}
