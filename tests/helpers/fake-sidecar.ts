import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

const FIXTURES = join(process.cwd(), 'eval/fixtures/ingest');
/** What the Phase 3 chain returns for the parse fixtures (eval/fixtures/parse/record_chain_results.py), paths relative to eval/fixtures/parse. */
const PARSE_FIXTURES = join(process.cwd(), 'eval/fixtures/parse');
const PARSE_CHAIN_MANIFEST = join(PARSE_FIXTURES, 'chain/manifest.json');
/** The hidden-text PDF corpus of plan 03.2-35 and the report each file is expected to get. */
const SECURITY_PDF_FIXTURES = join(process.cwd(), 'eval/fixtures/security/pdf');
/** checker_version the fake answers with: hidden-text/1/<rules_version> as the sidecar builds it. */
export const FAKE_HIDDEN_TEXT_CHECKER_VERSION = 'hidden-text/1/2026-11-25.1';

interface SecurityManifestEntry {
  expected: 'clean' | 'hidden_found';
  hidden_text: string | null;
  reason: string | null;
  sha256: string;
}

export function securityPdfBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(SECURITY_PDF_FIXTURES, name)));
}

export function securityPdfEntry(name: string): SecurityManifestEntry {
  const manifest = JSON.parse(readFileSync(join(SECURITY_PDF_FIXTURES, 'manifest.json'), 'utf8')) as { fixtures: Record<string, SecurityManifestEntry> };
  const entry = manifest.fixtures[name];
  if (!entry) throw new Error(`no security fixture ${name}`);
  return entry;
}

/** The report the real checker gives a fixture of the corpus, built from its manifest entry; any other PDF is clean, any other format not_checked. */
function recordedHiddenTextReport(sha256: string, mimeType: string): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(SECURITY_PDF_FIXTURES, 'manifest.json'), 'utf8')) as { fixtures: Record<string, SecurityManifestEntry> };
  const entry = Object.values(manifest.fixtures).find((fixture) => fixture.sha256 === sha256);
  const base = { link_targets: [], checker_version: FAKE_HIDDEN_TEXT_CHECKER_VERSION, dropped: 0 };
  if (mimeType !== 'application/pdf') return { ...base, status: 'not_checked', spans: [] };
  if (!entry || entry.expected === 'clean' || entry.hidden_text === null) return { ...base, status: 'clean', spans: [] };
  return { ...base, status: 'hidden_found', spans: [{ page: 1, text: entry.hidden_text, reason: entry.reason, bbox: null }] };
}

/** One answer of the fake /v1/hidden-text route: an error status, a replacement report, or a delay longer than the caller waits. */
export interface FakeHiddenTextSpec {
  status?: number;
  error?: string;
  report?: unknown;
  delayMs?: number;
}

interface ManifestEntry {
  id: string;
  mime: string;
  path: string;
  file_sha256: string;
  profile_id: string;
  recorded: { parse_result: string; artifacts: Record<string, string> };
}

export interface FakeSidecarManifest {
  fixtures: ManifestEntry[];
  /** Loaded only into the isolated table_split tenants of the ingest fixture mode (03.2-30). */
  long_table_fixtures?: ManifestEntry[];
}

export interface FakeSidecarJobSpec {
  /** States answered by successive polls; the last repeats. Default: running, then succeeded. */
  statuses?: Array<'queued' | 'running' | 'succeeded' | 'failed' | 'expired'>;
  errorClass?: string;
  /** Replaces the recorded or default result of a succeeded job. */
  result?: unknown;
  /** Answer the submit with this status and body error code instead of a job. */
  submitStatus?: number;
  submitError?: string;
  /** Answer polls with this status (for example 404 for a job the sidecar restarted without). */
  pollStatus?: number;
  /** Answer the submit with a redirect to this location. */
  submitRedirect?: string;
  /** Artifact names the result lists but the sidecar does not serve. */
  missingArtifacts?: string[];
}

export interface FakeSidecarCall {
  method: string;
  path: string;
  /** Whether the right secret arrived. The value is never recorded. */
  secretOk: boolean;
  hasSecret: boolean;
}

export interface FakeSidecarUpload {
  fileSha256: string;
  fileBytes: number;
  request: Record<string, unknown>;
}

export interface FakeSidecar {
  url: string;
  secret: string;
  calls: FakeSidecarCall[];
  uploads: FakeSidecarUpload[];
  deleted: string[];
  /** Each /v1/hidden-text request: the sha256 and size of the uploaded file and the request part. */
  hiddenTextRequests: FakeSidecarUpload[];
  /** Specs for /v1/hidden-text, used one per request in order; once used up, the recorded report answers. */
  enqueueHiddenText(...specs: FakeHiddenTextSpec[]): void;
  /** Specs are used one per submit, in order; the last one repeats. */
  enqueue(...specs: FakeSidecarJobSpec[]): void;
  expire(jobId: string): void;
  close(): Promise<void>;
}

export function loadManifest(): FakeSidecarManifest {
  return JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')) as FakeSidecarManifest;
}

interface RecordedSource {
  base: string;
  entry: Pick<ManifestEntry, 'file_sha256' | 'recorded'>;
}

function recordedSources(): RecordedSource[] {
  const chain = JSON.parse(readFileSync(PARSE_CHAIN_MANIFEST, 'utf8')) as FakeSidecarManifest;
  return [
    ...loadManifest().fixtures.map((entry) => ({ base: FIXTURES, entry })),
    ...(loadManifest().long_table_fixtures ?? []).map((entry) => ({ base: FIXTURES, entry })),
    ...chain.fixtures.map((entry) => ({ base: PARSE_FIXTURES, entry })),
  ];
}

export function fixtureBytes(id: string): Uint8Array {
  const entry = loadManifest().fixtures.find((fixture) => fixture.id === id);
  if (!entry) throw new Error(`no fixture ${id}`);
  return new Uint8Array(readFileSync(join(FIXTURES, entry.path)));
}

export function fixtureEntry(id: string): ManifestEntry {
  const entry = loadManifest().fixtures.find((fixture) => fixture.id === id);
  if (!entry) throw new Error(`no fixture ${id}`);
  return entry;
}

const DEFAULT_RESULT = {
  markdown: '# Default\n\nA default recorded result for a file the manifest does not know.',
  chunks: [],
  pictures: [],
  page_count: 1,
  language: 'en',
  parser: 'docling',
  parser_version: 'docling-fake',
  partial: false,
  warnings: [],
};

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

/**
 * A local stand-in for the sidecar's /v1/parse/jobs routes. A file whose sha256 is in eval/fixtures/ingest/manifest.json or
 * eval/fixtures/parse/chain/manifest.json is answered with its recorded ParseResult and artifacts; any other file gets a small default result.
 */
export async function startFakeSidecar(options: { secret?: string } = {}): Promise<FakeSidecar> {
  const secret = options.secret ?? 'sidecar-secret-for-tests-000000000000';
  const sources = recordedSources();
  const calls: FakeSidecarCall[] = [];
  const uploads: FakeSidecarUpload[] = [];
  const deleted: string[] = [];
  const specs: FakeSidecarJobSpec[] = [];
  const hiddenTextRequests: FakeSidecarUpload[] = [];
  const hiddenTextSpecs: FakeHiddenTextSpec[] = [];
  const jobs = new Map<string, { spec: FakeSidecarJobSpec; polls: number; expired: boolean; result: Record<string, unknown>; artifacts: Record<string, Buffer> }>();
  let submits = 0;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fake');
      const provided = request.headers['x-sidecar-secret'];
      const secretOk = provided === secret;
      calls.push({ method: request.method ?? 'GET', path: url.pathname, secretOk, hasSecret: provided !== undefined });
      if (!secretOk) return sendJson(response, 401, { error: 'unauthorized' });

      if (request.method === 'POST' && url.pathname === '/v1/hidden-text') {
        const body = await readBody(request);
        const form = await new Response(new Uint8Array(body), { headers: { 'content-type': String(request.headers['content-type'] ?? '') } }).formData();
        const file = form.get('file');
        const requestField = form.get('request');
        const bytes = file instanceof Blob ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
        const sha = createHash('sha256').update(bytes).digest('hex');
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(typeof requestField === 'string' ? requestField : '') as Record<string, unknown>;
        } catch {
          return sendJson(response, 422, { error: 'invalid_hidden_text_request' });
        }
        hiddenTextRequests.push({ fileSha256: sha, fileBytes: bytes.byteLength, request: parsed });
        if (parsed.sha256 !== sha || parsed.size_bytes !== bytes.byteLength) return sendJson(response, 422, { error: 'hidden_text_mismatch' });
        const spec = hiddenTextSpecs.shift() ?? {};
        if (spec.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
        if (spec.status !== undefined) return sendJson(response, spec.status, { error: spec.error ?? 'checker_unavailable' });
        return sendJson(response, 200, spec.report ?? recordedHiddenTextReport(sha, String(parsed.mime_type ?? '')));
      }

      if (request.method === 'POST' && url.pathname === '/v1/parse/jobs') {
        const body = await readBody(request);
        const spec = specs[Math.min(submits, specs.length - 1)] ?? {};
        submits += 1;
        if (spec.submitRedirect) {
          response.writeHead(302, { location: spec.submitRedirect });
          response.end();
          return;
        }
        if (spec.submitStatus !== undefined) return sendJson(response, spec.submitStatus, { error: spec.submitError ?? 'refused' });
        const form = await new Response(new Uint8Array(body), { headers: { 'content-type': String(request.headers['content-type'] ?? '') } }).formData();
        const file = form.get('file');
        const requestField = form.get('request');
        const bytes = file instanceof Blob ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
        const sha = createHash('sha256').update(bytes).digest('hex');
        uploads.push({ fileSha256: sha, fileBytes: bytes.byteLength, request: JSON.parse(typeof requestField === 'string' ? requestField : '{}') as Record<string, unknown> });
        const known = sources.find((source) => source.entry.file_sha256 === sha);
        let result: Record<string, unknown> = { ...DEFAULT_RESULT };
        const artifacts: Record<string, Buffer> = {};
        if (known) {
          const { base, entry } = known;
          result = JSON.parse(readFileSync(join(base, entry.recorded.parse_result), 'utf8')) as Record<string, unknown>;
          for (const [name, path] of Object.entries(entry.recorded.artifacts)) artifacts[name] = readFileSync(join(base, path));
        }
        if (spec.result !== undefined) result = spec.result as Record<string, unknown>;
        const id = `job${submits}`;
        jobs.set(id, { spec, polls: 0, expired: false, result, artifacts });
        return sendJson(response, 202, { job_id: id });
      }

      const state = /^\/v1\/parse\/jobs\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (state && request.method === 'GET') {
        const job = jobs.get(state[1] as string);
        if (!job) return sendJson(response, 404, { error: 'job_not_found' });
        if (job.spec.pollStatus !== undefined) return sendJson(response, job.spec.pollStatus, { error: 'job_not_found' });
        const statuses = job.spec.statuses ?? ['running', 'succeeded'];
        const status = job.expired ? 'expired' : (statuses[Math.min(job.polls, statuses.length - 1)] as string);
        job.polls += 1;
        const body: Record<string, unknown> = { job_id: state[1], status, result: status === 'succeeded' ? job.result : null, error_class: status === 'failed' ? (job.spec.errorClass ?? 'conversion_failed') : null };
        return sendJson(response, 200, body);
      }
      if (state && request.method === 'DELETE') {
        deleted.push(state[1] as string);
        response.writeHead(204);
        response.end();
        return;
      }

      const artifact = /^\/v1\/parse\/jobs\/([A-Za-z0-9_-]+)\/artifacts\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
      if (artifact && request.method === 'GET') {
        const job = jobs.get(artifact[1] as string);
        const name = artifact[2] as string;
        const bytes = job?.artifacts[name];
        if (!job || !bytes || job.spec.missingArtifacts?.includes(name)) return sendJson(response, 404, { error: 'artifact_not_found' });
        const type = name.endsWith('.json') ? 'application/json' : name.endsWith('.png') ? 'image/png' : 'application/octet-stream';
        response.writeHead(200, { 'content-type': type, 'content-length': bytes.byteLength });
        response.end(bytes);
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'fake_failure' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    secret,
    calls,
    uploads,
    deleted,
    hiddenTextRequests,
    enqueueHiddenText: (...next) => void hiddenTextSpecs.push(...next),
    enqueue: (...next) => void specs.push(...next),
    expire(jobId) {
      const job = jobs.get(jobId);
      if (job) job.expired = true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
