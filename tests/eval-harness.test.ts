import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { InProcessEval, RunEvalResult } from '../eval/harness/run-eval.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ROUTE_PATH = '/api/internal/rag/run';
const TRACER_ITEM_ID = 'en-general-001';
const TRACER_QUESTION = 'What is the refund window for annual plans?';

interface TraceChunk {
  chunk_id: string;
  document_name?: string | null;
}

interface Trace {
  item_id: string | null;
  candidates: unknown[];
  kept: TraceChunk[];
  used_documents: unknown[];
  context: string;
  refused: boolean;
}

const tmpDirs: string[] = [];

function makeOutDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-harness-test-'));
  tmpDirs.push(dir);
  return dir;
}

function readTraces(result: RunEvalResult): Trace[] {
  return fs
    .readFileSync(result.tracesPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Trace);
}

function stable(trace: Trace) {
  return {
    candidates: trace.candidates,
    kept: trace.kept,
    used_documents: trace.used_documents,
    context: trace.context,
    refused: trace.refused,
  };
}

function tracerRequest(prepared: InProcessEval): NextRequest {
  return new NextRequest(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
    body: JSON.stringify({
      schema_version: 1,
      query: TRACER_QUESTION,
      rag_mode: 'strict',
      web_search: false,
      options: {},
      item_id: TRACER_ITEM_ID,
    }),
  });
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

let inProcessKeptIds: string[] = [];

describe('tracer retrieval through runEval', () => {
  test('keeps refund-policy.en.md and records no edge errors', async () => {
    vi.resetModules();
    const { runEval } = await import('../eval/harness/run-eval.mts');
    const result = await runEval({
      goldenPath: GOLDEN_PATH,
      corpusDir: CORPUS_DIR,
      outDir: makeOutDir(),
      deploymentMode: 'single-tenant',
    });
    expect(result.edgeErrors).toBe(0);
    const traces = readTraces(result);
    expect(traces).toHaveLength(1);
    expect(traces[0].item_id).toBe(TRACER_ITEM_ID);
    expect(traces[0].kept.map((chunk) => chunk.document_name)).toContain('refund-policy.en.md');
    inProcessKeptIds = traces[0].kept.map((chunk) => chunk.chunk_id);
    expect(inProcessKeptIds.length).toBeGreaterThan(0);
  });
});

describe('concurrency and HTTP transport on one prepared eval', () => {
  let prepared: InProcessEval;
  let runEvalFn: typeof import('../eval/harness/run-eval.mts').runEval;
  let server: http.Server | undefined;
  let baseUrl = '';
  let previousSecret: string | undefined;

  beforeAll(async () => {
    vi.resetModules();
    const harness = await import('../eval/harness/run-eval.mts');
    runEvalFn = harness.runEval;
    prepared = await harness.prepareInProcessEval({ corpusDir: CORPUS_DIR, deploymentMode: 'single-tenant' });
    previousSecret = process.env.RAG_EVAL_SECRET;
    process.env.RAG_EVAL_SECRET = prepared.secret;

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers[name] = value;
        }
        const nextReq = new NextRequest(`http://localhost${req.url ?? ROUTE_PATH}`, {
          method: req.method,
          headers,
          body: Buffer.concat(chunks),
        });
        prepared
          .POST(nextReq)
          .then(async (response) => {
            const body = Buffer.from(await response.arrayBuffer());
            res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
            res.end(body);
          })
          .catch((error: unknown) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'forward failed' }));
          });
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
        server!.closeAllConnections();
      });
    }
    if (prepared) await prepared.close();
    if (previousSecret === undefined) delete process.env.RAG_EVAL_SECRET;
    else process.env.RAG_EVAL_SECRET = previousSecret;
  });

  test('five concurrent calls equal one sequential call', async () => {
    const sequentialRes = await prepared.POST(tracerRequest(prepared));
    expect(sequentialRes.status).toBe(200);
    const sequential = (await sequentialRes.json()) as Trace;
    expect(sequential.kept.length).toBeGreaterThan(0);

    const responses = await Promise.all(Array.from({ length: 5 }, () => prepared.POST(tracerRequest(prepared))));
    for (const res of responses) expect(res.status).toBe(200);
    const traces = (await Promise.all(responses.map((res) => res.json()))) as Trace[];
    for (const trace of traces) {
      expect(stable(trace)).toEqual(stable(sequential));
    }
    expect(prepared.edge.errors).toHaveLength(0);
  });

  test('runEval over HTTP yields the same kept chunk ids as the in-process run', async () => {
    const result = await runEvalFn({
      goldenPath: GOLDEN_PATH,
      corpusDir: CORPUS_DIR,
      outDir: makeOutDir(),
      deploymentMode: 'single-tenant',
      tier: 'live',
      baseUrl,
    });
    const traces = readTraces(result);
    expect(traces).toHaveLength(1);
    expect(traces[0].item_id).toBe(TRACER_ITEM_ID);
    const httpKeptIds = traces[0].kept.map((chunk) => chunk.chunk_id);
    expect(inProcessKeptIds.length).toBeGreaterThan(0);
    expect(httpKeptIds).toEqual(inProcessKeptIds);
  });
});
