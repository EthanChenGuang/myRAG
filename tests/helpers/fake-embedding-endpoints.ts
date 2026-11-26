import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { embedText } from '../../eval/harness/fixture-embedder.mts';

export type FakeEmbeddingHost = 'voyage' | 'deepinfra' | 'openrouter' | 'ft';

export interface FakeEmbeddingCall {
  host: FakeEmbeddingHost;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface FakeEmbeddingEndpoints {
  /** Base URLs to hand to the providers, one per vendor. */
  urls: Record<FakeEmbeddingHost, string>;
  calls: FakeEmbeddingCall[];
  callsFor(host: FakeEmbeddingHost): FakeEmbeddingCall[];
  /** The next requests to this host answer with these HTTP statuses (one per request, in order). */
  failNext(host: FakeEmbeddingHost, ...statuses: number[]): void;
  clearFailures(): void;
  /** Every request to this host waits this long before answering. */
  setDelay(host: FakeEmbeddingHost, ms: number): void;
  /** Component count the Qwen endpoints return (default 4096, the model's native size). */
  setQwenRawDims(dims: number): void;
  /** Component count Voyage returns regardless of output_dimension (default: honour it). */
  setVoyageReturnDims(dims: number | null): void;
  /** Component count the fine-tune slot endpoint returns (default 1024). */
  setFtDims(dims: number): void;
  /** Mixed into every slot vector; a new salt stands for other weights behind the same URL and model name. */
  setFtSalt(salt: string): void;
  stop(): Promise<void>;
}

const VOYAGE_PREFIX = '/voyage/v1';
const DEEPINFRA_PREFIX = '/deepinfra/v1/openai';
const OPENROUTER_PREFIX = '/openrouter/api/v1';
const FT_PREFIX = '/ft/v1';

function expand(text: string, size: number): number[] {
  const base = embedText(text);
  return Array.from({ length: size }, (_, index) => base[index % base.length] + 0.001 * (Math.floor(index / base.length) + 1));
}

/** The raw (not normalized) vector the fake slot endpoint returns for one input string, as sent (prompt included). */
export function fakeSlotVector(input: string, salt = '', dims = 1024): number[] {
  return expand(`${salt}${input}`, dims);
}

function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return vector.map((x) => x / norm);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

export async function startFakeEmbeddingEndpoints(): Promise<FakeEmbeddingEndpoints> {
  const calls: FakeEmbeddingCall[] = [];
  const failures: Record<FakeEmbeddingHost, number[]> = { voyage: [], deepinfra: [], openrouter: [], ft: [] };
  const delays: Record<FakeEmbeddingHost, number> = { voyage: 0, deepinfra: 0, openrouter: 0, ft: 0 };
  const timers = new Set<NodeJS.Timeout>();
  let qwenRawDims = 4096;
  let voyageReturnDims: number | null = null;
  let ftDims = 1024;
  let ftSalt = '';

  function hostFor(url: string): FakeEmbeddingHost | null {
    if (url === `${VOYAGE_PREFIX}/embeddings`) return 'voyage';
    if (url === `${DEEPINFRA_PREFIX}/embeddings`) return 'deepinfra';
    if (url === `${OPENROUTER_PREFIX}/embeddings`) return 'openrouter';
    if (url === `${FT_PREFIX}/embeddings`) return 'ft';
    return null;
  }

  const server = http.createServer(async (request, response) => {
    const host = hostFor(request.url ?? '');
    if (!host || request.method !== 'POST') {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    const body = await readJson(request);
    calls.push({ host, path: request.url ?? '', headers: request.headers, body });

    const respond = () => {
      const failure = failures[host].shift();
      if (failure !== undefined) {
        const echoed = String(request.headers.authorization ?? '');
        response
          .writeHead(failure, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: `upstream failure for ${echoed}`, detail: `upstream failure for ${echoed}` } }));
        return;
      }
      const inputs = (Array.isArray(body.input) ? body.input : [body.input]) as string[];
      let vectors: number[][];
      let model: string;
      if (host === 'voyage') {
        const size = voyageReturnDims ?? Number(body.output_dimension ?? 1024);
        vectors = inputs.map((text) => unit(expand(text, size)));
        model = 'voyage-4-large';
      } else if (host === 'ft') {
        vectors = inputs.map((text) => fakeSlotVector(text, ftSalt, ftDims));
        model = 'served-by-fake-endpoint';
      } else {
        vectors = inputs.map((text) => expand(text, qwenRawDims));
        model = String(body.model);
      }
      const tokens = inputs.reduce((sum, text) => sum + wordCount(text), 0);
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          object: 'list',
          data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
          model,
          usage: { prompt_tokens: tokens, total_tokens: tokens },
        }),
      );
    };

    if (delays[host] > 0) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!response.destroyed) respond();
      }, delays[host]);
      timers.add(timer);
      return;
    }
    respond();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    urls: {
      voyage: `${origin}${VOYAGE_PREFIX}`,
      deepinfra: `${origin}${DEEPINFRA_PREFIX}`,
      openrouter: `${origin}${OPENROUTER_PREFIX}`,
      ft: `${origin}${FT_PREFIX}`,
    },
    calls,
    callsFor: (host) => calls.filter((call) => call.host === host),
    failNext: (host, ...statuses) => {
      failures[host].push(...statuses);
    },
    clearFailures: () => {
      for (const queue of Object.values(failures)) queue.length = 0;
    },
    setDelay: (host, ms) => {
      delays[host] = ms;
    },
    setQwenRawDims: (dims) => {
      qwenRawDims = dims;
    },
    setVoyageReturnDims: (dims) => {
      voyageReturnDims = dims;
    },
    setFtDims: (dims) => {
      ftDims = dims;
    },
    setFtSalt: (salt) => {
      ftSalt = salt;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
