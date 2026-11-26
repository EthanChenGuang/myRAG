import { createHash } from 'node:crypto';
import { env } from '@/lib/env';
import { HiddenTextReportSchema, HiddenTextRequestSchema, type HiddenTextReport } from '@/lib/rag-eval/contracts.generated';

export type { HiddenTextReport };
export type HiddenTextSpan = NonNullable<HiddenTextReport['spans']>[number];

const SECRET_HEADER = 'x-sidecar-secret';
const HIDDEN_TEXT_PATH = '/v1/hidden-text';
const MAX_RESPONSE_BYTES = 2_000_000;
/** A normalized span at least this long must never reach a written chunk, and is removed wherever it occurs (F-17). */
export const HIDDEN_SPAN_MIN_CHARS = 12;
/** Safety bound for the removal loop: removing one occurrence can join text into another. */
const MAX_REMOVAL_PASSES = 8;

/** The formats the sidecar has a checker for (D-33): PDF, and Word once the Word checker ships (it answers not_checked until then). */
const CHECKED_MIME_TYPES: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};
const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * The media type to send for a file the sidecar can check, or null for a format without a checker (text, HTML, presentations,
 * spreadsheets, images). A missing or generic media type falls back to the filename extension.
 */
export function hiddenTextMimeType(mimeType: string | null | undefined, filename: string): string | null {
  const type = (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (CHECKED_MIME_TYPES[type]) return type;
  if (type !== '' && type !== 'application/octet-stream' && type !== 'binary/octet-stream') return null;
  const dot = filename.lastIndexOf('.');
  const extension = dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
  return EXTENSION_MIME_TYPES[extension] ?? null;
}

export type HiddenTextFailure = 'not_configured' | 'timeout' | 'aborted' | 'unreachable' | 'malformed' | 'invalid_request' | `http_${number}`;

export type HiddenTextOutcome = { ok: true; report: HiddenTextReport } | { ok: false; reason: HiddenTextFailure; error: string | null };

export interface HiddenTextOriginal {
  bytes: Uint8Array;
  mimeType: string;
  /** Only its extension is sent: the upload is named original.<ext>, never with the user's filename. */
  filename: string;
}

export interface HiddenTextMeta {
  signal: AbortSignal;
  timeoutMs: number;
}

export type HiddenTextClient = (original: HiddenTextOriginal, meta: HiddenTextMeta) => Promise<HiddenTextOutcome>;

export interface HiddenTextClientConfig {
  baseUrl: string;
  secret: string;
  fetch?: typeof fetch;
}

class Failure extends Error {
  constructor(
    readonly reason: HiddenTextFailure,
    readonly code: string | null = null,
  ) {
    super(reason);
  }
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error.slice(0, 64) : null;
  } catch {
    return null;
  }
}

/** The report, checked against the generated schema and for consistency: hidden_found carries spans, clean carries none. */
export function validHiddenTextReport(raw: unknown): HiddenTextReport | null {
  const parsed = HiddenTextReportSchema.safeParse(raw);
  if (!parsed.success) return null;
  const spans = parsed.data.spans ?? [];
  if (parsed.data.status === 'hidden_found' && spans.length === 0) return null;
  if (parsed.data.status === 'clean' && spans.length > 0) return null;
  return { ...parsed.data, spans };
}

/**
 * POSTs the stored original to the sidecar's hidden-text route (D-33) as multipart (`file` plus the HiddenTextRequest as `request`) and
 * validates the answer. Never throws: every failure comes back as `{ ok: false, reason }`. Logs nothing; the caller logs counts.
 */
export function createHiddenTextClient(config: HiddenTextClientConfig): HiddenTextClient {
  const base = (config.baseUrl ?? '').trim().replace(/\/+$/, '');
  const secret = (config.secret ?? '').trim();
  const fetchImpl = config.fetch ?? fetch;
  return async (original, meta) => {
    if (base === '' || secret === '') return { ok: false, reason: 'not_configured', error: null };
    if (meta.signal.aborted) return { ok: false, reason: 'aborted', error: null };
    const mimeType = hiddenTextMimeType(original.mimeType, original.filename) ?? original.mimeType;
    const extension = CHECKED_MIME_TYPES[mimeType] ?? 'bin';
    const request = HiddenTextRequestSchema.safeParse({
      filename: `original.${extension}`,
      mime_type: mimeType || 'application/octet-stream',
      sha256: createHash('sha256').update(original.bytes).digest('hex'),
      size_bytes: original.bytes.byteLength,
    });
    if (!request.success) return { ok: false, reason: 'invalid_request', error: null };

    const timeoutMs = Number.isFinite(meta.timeoutMs) && meta.timeoutMs > 0 ? meta.timeoutMs : 1;
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([meta.signal, deadline]);
    try {
      const form = new FormData();
      form.set('file', new Blob([original.bytes as unknown as BlobPart]), `original.${extension}`);
      form.set('request', JSON.stringify(request.data));
      const response = await fetchImpl(`${base}${HIDDEN_TEXT_PATH}`, { method: 'POST', headers: { [SECRET_HEADER]: secret }, body: form, signal, redirect: 'error' });
      if (!response.ok) throw new Failure(`http_${response.status}`, await errorCode(response));
      const body = await response.text();
      if (body.length > MAX_RESPONSE_BYTES) throw new Failure('malformed');
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        throw new Failure('malformed');
      }
      const report = validHiddenTextReport(raw);
      if (!report) throw new Failure('malformed');
      return { ok: true, report };
    } catch (error) {
      if (meta.signal.aborted) return { ok: false, reason: 'aborted', error: null };
      if (deadline.aborted) return { ok: false, reason: 'timeout', error: null };
      if (error instanceof Failure) return { ok: false, reason: error.reason, error: error.code };
      return { ok: false, reason: 'unreachable', error: null };
    }
  };
}

/**
 * The report a queued job's worker made at preflight (D-33), checked like a sidecar answer. An invalid report comes back as null: the
 * scan stage treats it as a checker that could not answer (fail closed under quarantine, T-03.2-381).
 */
export function workerHiddenTextReport(raw: unknown, fileSha256: string): { fileSha256: string; report: HiddenTextReport | null } {
  return { fileSha256, report: validHiddenTextReport(raw) };
}

let override: HiddenTextClient | null = null;

/** The report of the sidecar for one stored original; the client comes from RAG_SIDECAR_URL and RAG_SIDECAR_SECRET unless a test installed one. */
export function requestHiddenTextReport(original: HiddenTextOriginal, meta: HiddenTextMeta): Promise<HiddenTextOutcome> {
  const client = override ?? createHiddenTextClient({ baseUrl: env.RAG_SIDECAR_URL ?? '', secret: env.RAG_SIDECAR_SECRET ?? '' });
  return client(original, meta);
}

export function setHiddenTextClientForTests(client: HiddenTextClient | null): void {
  override = client;
}

export function resetHiddenTextClientForTests(): void {
  override = null;
}

const IGNORED = /[\s​‌‍⁠﻿]/gu;
const SYNTAX = /[\\^$.*+?()[\]{}|/]/gu;

/** A span or chunk text compared without whitespace and zero-width characters: the parser's line breaks and spacing differ from the PDF's. */
export function normalizeSpanText(text: string): string {
  return text.replace(IGNORED, '');
}

function spanPattern(span: string): RegExp | null {
  const characters = [...normalizeSpanText(span)];
  if (characters.length === 0) return null;
  return new RegExp(characters.map((character) => character.replace(SYNTAX, '\\$&')).join('[\\s\\u200b\\u200c\\u200d\\u2060\\ufeff]*'), 'gu');
}

export interface SpanRemoval {
  text: string;
  /** Spans found and removed, in the order given. */
  removed: string[];
  /** Spans the remover could not locate in the text, in the order given; shown to the admin as `unlocated`. */
  unlocated: string[];
}

/**
 * Removes each hidden span from a text, matching it with whitespace and zero-width characters ignored. A span of HIDDEN_SPAN_MIN_CHARS or
 * more is removed wherever it occurs (the write-time assertion refuses any copy of it); a shorter span only at its first occurrence, so a
 * short hidden fragment does not erase the same letters from visible text. Applying it to its own output changes nothing.
 */
export function removeHiddenSpans(text: string, spans: readonly string[]): SpanRemoval {
  let current = text;
  const removed: string[] = [];
  const unlocated: string[] = [];
  for (const span of spans) {
    const pattern = spanPattern(span);
    if (!pattern) {
      unlocated.push(span);
      continue;
    }
    if (normalizeSpanText(span).length >= HIDDEN_SPAN_MIN_CHARS) {
      let found = false;
      for (let pass = 0; pass < MAX_REMOVAL_PASSES; pass += 1) {
        pattern.lastIndex = 0;
        if (!pattern.test(current)) break;
        found = true;
        current = current.replace(pattern, '');
      }
      (found ? removed : unlocated).push(span);
      continue;
    }
    pattern.lastIndex = 0;
    const match = pattern.exec(current);
    if (!match) {
      unlocated.push(span);
      continue;
    }
    current = `${current.slice(0, match.index)}${current.slice(match.index + match[0].length)}`;
    removed.push(span);
  }
  return { text: current, removed, unlocated };
}

/** Thrown before a write when a chunk still holds a removed hidden span; carries counts only. */
export class HiddenSpanWriteError extends Error {
  constructor(readonly chunks: number) {
    super(`[RAG Security] ${chunks} chunk(s) still contain a removed hidden span`);
    this.name = 'HiddenSpanWriteError';
  }
}

export interface SpanCheckedChunk {
  content: string;
  lexical_text?: string | null;
}

/**
 * The write-time assertion of F-17: no chunk's normalized content or lexical text may contain a normalized hidden span of
 * HIDDEN_SPAN_MIN_CHARS or more. Throws HiddenSpanWriteError naming how many chunks failed; never returns or logs the text.
 */
export function assertNoHiddenSpans(chunks: readonly SpanCheckedChunk[], spans: readonly string[]): void {
  const needles = [...new Set(spans.map(normalizeSpanText).filter((span) => span.length >= HIDDEN_SPAN_MIN_CHARS))];
  if (needles.length === 0) return;
  let offending = 0;
  for (const chunk of chunks) {
    const haystacks = [normalizeSpanText(chunk.content ?? ''), normalizeSpanText(chunk.lexical_text ?? '')];
    if (needles.some((needle) => haystacks.some((haystack) => haystack.includes(needle)))) offending += 1;
  }
  if (offending > 0) throw new HiddenSpanWriteError(offending);
}
