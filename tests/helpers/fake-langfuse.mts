import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';

export interface FakeSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, unknown>;
}

export interface FakeRequest {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
}

export type TraceMode = 'ok' | 'hang' | 'error500';

export interface FakeLangfuseOptions {
  observations?: Array<Record<string, unknown>>;
  pageSize?: number;
  scoresStatus?: 202 | 207;
}

export interface FakeLangfuse {
  url: string;
  requests: FakeRequest[];
  spans: FakeSpan[];
  scores: unknown[];
  errors: string[];
  completedTraceRequests(): number;
  setTraceMode(mode: TraceMode): void;
  release(): void;
  reset(): void;
  traceRequestCount(): number;
  abandonedTraceRequests(): number;
  close(): Promise<void>;
}

const TRACES_PATH = '/api/public/otel/v1/traces';
const OBSERVATIONS_PATH = '/api/public/v2/observations';
const SCORES_PATH = '/api/public/scores';

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: Array<{ key: string; value: OtlpAnyValue }> };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string | number;
  endTimeUnixNano: string | number;
  attributes?: Array<{ key: string; value: OtlpAnyValue }>;
}

interface OtlpBody {
  resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: OtlpSpan[] }> }>;
}

function decodeValue(value: OtlpAnyValue): unknown {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(decodeValue);
  if (value.kvlistValue) {
    return Object.fromEntries((value.kvlistValue.values ?? []).map((entry) => [entry.key, decodeValue(entry.value)]));
  }
  return null;
}

function decodeSpans(body: OtlpBody): FakeSpan[] {
  const out: FakeSpan[] = [];
  for (const resource of body.resourceSpans ?? []) {
    for (const scope of resource.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        const attributes: Record<string, unknown> = {};
        for (const attribute of span.attributes ?? []) attributes[attribute.key] = decodeValue(attribute.value);
        out.push({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId ? span.parentSpanId : null,
          name: span.name,
          startTimeUnixNano: String(span.startTimeUnixNano),
          endTimeUnixNano: String(span.endTimeUnixNano),
          attributes,
        });
      }
    }
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export async function startFakeLangfuse(options: FakeLangfuseOptions = {}): Promise<FakeLangfuse> {
  const { observations = [], pageSize = 2, scoresStatus = 202 } = options;
  const requests: FakeRequest[] = [];
  const spans: FakeSpan[] = [];
  const scores: unknown[] = [];
  const errors: string[] = [];
  const held: http.ServerResponse[] = [];
  let mode: TraceMode = 'ok';
  let traceRequests = 0;
  let completedTraces = 0;
  let abandonedTraces = 0;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!res.headersSent) sendJson(res, 500, { error: 'fake langfuse failure' });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    requests.push({
      method,
      path: url.pathname,
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
      contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null,
    });

    if (method === 'POST' && url.pathname === TRACES_PATH) {
      traceRequests += 1;
      const raw = await readBody(req);
      const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
      const body = encoding === 'gzip' ? zlib.gunzipSync(raw) : raw;
      const contentType = String(req.headers['content-type'] ?? '');
      if (!contentType.includes('json')) {
        errors.push(`unsupported OTLP content type: ${contentType || 'none'}`);
        sendJson(res, 415, { error: 'OTLP/JSON only' });
        return;
      }
      spans.push(...decodeSpans(JSON.parse(body.toString('utf8')) as OtlpBody));
      if (mode === 'hang') {
        held.push(res);
        res.once('close', () => {
          if (!res.writableEnded && held.includes(res)) abandonedTraces += 1;
        });
        return;
      }
      if (mode === 'error500') {
        sendJson(res, 500, { error: 'configured failure' });
        return;
      }
      completedTraces += 1;
      sendJson(res, 200, {});
      return;
    }

    if (method === 'GET' && url.pathname === OBSERVATIONS_PATH) {
      const limit = Math.max(1, Number(url.searchParams.get('limit') ?? pageSize));
      const size = Math.min(limit, pageSize);
      const offset = Number(url.searchParams.get('cursor') ?? 0) || 0;
      const data = observations.slice(offset, offset + size);
      const next = offset + size;
      sendJson(res, 200, { data, meta: next < observations.length ? { cursor: String(next) } : {} });
      return;
    }

    if (method === 'POST' && url.pathname === SCORES_PATH) {
      const body = JSON.parse((await readBody(req)).toString('utf8')) as unknown;
      if (!Array.isArray(body)) {
        sendJson(res, 400, { error: 'scores body must be an array' });
        return;
      }
      scores.push(...body);
      if (scoresStatus === 207) {
        sendJson(res, 207, { accepted: [], rejected: body.map((_, index) => ({ index })), errors: [] });
        return;
      }
      sendJson(res, 202, { message: 'Accepted' });
      return;
    }

    sendJson(res, 404, { error: `unexpected ${method} ${url.pathname}` });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  function release(): void {
    for (const res of held.splice(0)) {
      if (res.destroyed || res.writableEnded) continue;
      completedTraces += 1;
      sendJson(res, 200, {});
    }
  }

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    spans,
    scores,
    errors,
    completedTraceRequests: () => completedTraces,
    traceRequestCount: () => traceRequests,
    abandonedTraceRequests: () => abandonedTraces,
    setTraceMode(next) {
      mode = next;
    },
    release,
    reset() {
      requests.length = 0;
      spans.length = 0;
      scores.length = 0;
      errors.length = 0;
      traceRequests = 0;
      completedTraces = 0;
      abandonedTraces = 0;
      mode = 'ok';
      for (const res of held.splice(0)) res.destroy();
    },
    async close() {
      for (const res of held.splice(0)) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
