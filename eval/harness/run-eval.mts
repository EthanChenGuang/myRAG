import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { NextRequest } from 'next/server';
import { GoldenItemSchema, RagTraceSchema, type GoldenItem, type RagRunRequest } from '../../src/lib/rag-eval/contracts.generated.ts';
import { createFixtureDatabase, type DeploymentMode } from './pglite-supabase.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from './fake-edge.mts';

export type EvalTier = 'smoke' | 'nightly' | 'live';

export interface EvalRequestOptions {
  max_results?: number | null;
  organization_id?: string | null;
  user_id?: string | null;
}

export interface InProcessEval {
  POST: (req: NextRequest) => Promise<Response>;
  secret: string;
  edge: FakeEdge;
  fixtureUserId: string;
  close: () => Promise<void>;
}

export interface RunEvalOptions {
  goldenPath: string;
  corpusDir: string;
  outDir: string;
  deploymentMode: DeploymentMode;
  requestOptions?: EvalRequestOptions;
  tier?: EvalTier;
  baseUrl?: string;
}

export interface RunEvalResult {
  tracesPath: string;
  logPath: string;
  itemCount: number;
  tier: EvalTier;
  deploymentMode: DeploymentMode;
  edgeErrors: number;
}

const ROUTE_PATH = '/api/internal/rag/run';

type MutableEnv = Record<string, string | undefined>;

export async function prepareInProcessEval(options: { corpusDir: string; deploymentMode: DeploymentMode }): Promise<InProcessEval> {
  const { corpusDir, deploymentMode } = options;
  const fixture = await createFixtureDatabase({ deploymentMode, corpusDir });
  let edge: FakeEdge | undefined;
  try {
    edge = await startFakeEdge({ db: fixture.db });
  } catch (error) {
    await fixture.db.close().catch(() => undefined);
    throw error;
  }
  const startedEdge = edge;

  const env = process.env as MutableEnv;
  for (const name of Object.keys(env)) {
    if (name.startsWith('RAG_') || name.startsWith('NEXT_PUBLIC_RAG_')) delete env[name];
  }
  Object.assign(env, fixtureProcessEnv(startedEdge.url));
  const secret = crypto.randomBytes(24).toString('hex');
  env.NODE_ENV = 'test';
  env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = deploymentMode;
  env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
  env.RAG_EVAL_SECRET = secret;

  const route = await import('../../src/app/api/internal/rag/run/route.ts');

  return {
    POST: route.POST as unknown as InProcessEval['POST'],
    secret,
    edge: startedEdge,
    fixtureUserId: fixture.fixtureUserId,
    close: async () => {
      await startedEdge.close();
      await fixture.db.close().catch(() => undefined);
    },
  };
}

function readGolden(goldenPath: string): GoldenItem[] {
  const lines = fs
    .readFileSync(goldenPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  return lines.map((line, index) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`[Eval Harness] golden line ${index + 1} is not valid JSON`);
    }
    const parsed = GoldenItemSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`[Eval Harness] golden line ${index + 1} violates GoldenItemSchema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    return parsed.data;
  });
}

function redirectConsole(logPath: string): () => void {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const original = new Map<string, (...args: unknown[]) => void>();
  for (const method of methods) {
    original.set(method, console[method].bind(console));
    console[method] = (...args: unknown[]) => {
      fs.appendFileSync(logPath, `${util.format(...args)}\n`);
    };
  }
  return () => {
    for (const method of methods) console[method] = original.get(method)!;
  };
}

export async function runEval(options: RunEvalOptions): Promise<RunEvalResult> {
  const { goldenPath, corpusDir, outDir, deploymentMode, requestOptions = {}, tier = 'smoke', baseUrl } = options;

  const items = readGolden(goldenPath);
  fs.mkdirSync(outDir, { recursive: true });
  const tracesPath = path.join(outDir, 'traces.jsonl');
  const logPath = path.join(outDir, 'harness.log');
  fs.writeFileSync(tracesPath, '');
  fs.writeFileSync(logPath, '');

  let httpSecret = '';
  if (baseUrl) {
    httpSecret = process.env.RAG_EVAL_SECRET ?? '';
    if (!httpSecret) throw new Error('[Eval Harness] RAG_EVAL_SECRET must be set for --base-url runs');
  }

  const restoreConsole = redirectConsole(logPath);
  let inProcess: InProcessEval | undefined;
  let edgeErrors = 0;
  try {
    let send: (payload: RagRunRequest) => Promise<{ status: number; body: unknown }>;
    if (baseUrl) {
      const url = `${baseUrl.replace(/\/+$/, '')}${ROUTE_PATH}`;
      send = async (payload) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rag-eval-secret': httpSecret },
          body: JSON.stringify(payload),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      };
    } else {
      const prepared = await prepareInProcessEval({ corpusDir, deploymentMode });
      inProcess = prepared;
      send = async (payload) => {
        const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
          body: JSON.stringify(payload),
        });
        const res = await prepared.POST(req);
        return { status: res.status, body: await res.json().catch(() => null) };
      };
    }

    for (const item of items) {
      const options: EvalRequestOptions = { ...requestOptions };
      if (inProcess && deploymentMode === 'multi-tenant' && !options.user_id) {
        options.user_id = inProcess.fixtureUserId;
      }
      const payload = {
        schema_version: 1 as const,
        query: item.question,
        conversation: item.conversation,
        rag_mode: 'strict' as const,
        web_search: false as const,
        options,
        item_id: item.id,
      } as RagRunRequest;

      const { status, body } = await send(payload);
      if (status !== 200) {
        const detail = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : 'no error body';
        throw new Error(`[Eval Harness] item ${item.id}: route returned ${status} (${detail})`);
      }
      const trace = RagTraceSchema.parse(body);
      trace.item_id = item.id;
      fs.appendFileSync(tracesPath, `${JSON.stringify(trace)}\n`);
    }

    if (inProcess) {
      edgeErrors = inProcess.edge.errors.length;
      if (edgeErrors > 0) {
        const sample = inProcess.edge.errors
          .slice(0, 3)
          .map((e) => `${e.method} ${e.url} -> ${e.status}`)
          .join('; ');
        throw new Error(`[Eval Harness] fake edge recorded ${edgeErrors} unsupported or failed request(s): ${sample}`);
      }
    }
  } finally {
    restoreConsole();
    if (inProcess) await inProcess.close();
  }

  return { tracesPath, logPath, itemCount: items.length, tier, deploymentMode, edgeErrors };
}
