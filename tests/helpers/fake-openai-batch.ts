import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeBatchStatus =
  | 'validating'
  | 'in_progress'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelling'
  | 'cancelled';

const TERMINAL: ReadonlySet<FakeBatchStatus> = new Set(['completed', 'failed', 'expired', 'cancelled']);

export interface FakeBatchScript {
  /** One status per retrieve call, the first one is returned by create; the last one repeats. */
  states?: FakeBatchStatus[];
  /** On `expired`, only the first N input lines (input order) have results; the rest land in the error file. */
  completeOnly?: number;
  /** Input lines that fail inside the batch (error file entry, HTTP 400). */
  failLine?: (customId: string) => boolean;
  /** Input lines whose vector comes back with a different component count. */
  wrongDims?: (customId: string) => number | undefined;
}

export interface FakeUpload {
  id: string;
  purpose: string;
  filename: string;
  lines: string[];
}

export interface FakeBatchRecord {
  id: string;
  inputFileId: string;
  endpoint: string;
  completionWindow: string;
}

export interface FakeRequestCounts {
  upload: number;
  create: number;
  retrieve: number;
  content: number;
}

export interface FakeOpenAiBatch {
  /** Base URL for the OpenAI client (ends with /v1). */
  baseUrl: string;
  uploads: FakeUpload[];
  batches: FakeBatchRecord[];
  counts: FakeRequestCounts;
  /** Ordered request log such as `upload`, `create:batch_fake_1`, `retrieve:batch_fake_1`, `content:file-fake-2`. */
  events: string[];
  /** Largest number of batches that were created but had not yet been seen in a terminal state. */
  maxOpen(): number;
  /** The scripts the next created batches follow, in order; later batches use the default script. */
  script(...scripts: FakeBatchScript[]): void;
  /** Every request whose path starts with this prefix answers with this status (one entry per request). */
  failNext(status: number): void;
  stop(): Promise<void>;
}

export interface FakeOpenAiBatchOptions {
  /** Called synchronously for every request, in the same text as `events`. */
  onEvent?: (event: string) => void;
}

export function fakeVector(customId: string, dims: number): number[] {
  const seed = createHash('sha1').update(customId).digest();
  return Array.from({ length: dims }, (_, i) => (seed[i % seed.length] + i) / 512);
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function multipartFile(body: Buffer, contentType: string): { purpose: string; filename: string; content: string } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const marker = boundary?.[1] ?? boundary?.[2] ?? '';
  const parts = body.toString('utf8').split(`--${marker}`);
  let purpose = '';
  let filename = '';
  let content = '';
  for (const part of parts) {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const headers = part.slice(0, split);
    const value = part.slice(split + 4).replace(/\r\n$/, '');
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (name === 'purpose') purpose = value;
    if (name === 'file') {
      filename = /filename="([^"]*)"/.exec(headers)?.[1] ?? '';
      content = value;
    }
  }
  return { purpose, filename, content };
}

interface BatchState {
  record: FakeBatchRecord;
  script: Required<Pick<FakeBatchScript, 'states'>> & FakeBatchScript;
  index: number;
  outputFileId: string | null;
  errorFileId: string | null;
  closed: boolean;
}

const DEFAULT_STATES: FakeBatchStatus[] = ['validating', 'in_progress', 'completed'];

export async function startFakeOpenAiBatch(options: FakeOpenAiBatchOptions = {}): Promise<FakeOpenAiBatch> {
  const uploads: FakeUpload[] = [];
  const batches: FakeBatchRecord[] = [];
  const states = new Map<string, BatchState>();
  const files = new Map<string, string>();
  const counts: FakeRequestCounts = { upload: 0, create: 0, retrieve: 0, content: 0 };
  const events: string[] = [];
  const scripts: FakeBatchScript[] = [];
  const failures: number[] = [];
  let fileSeq = 0;
  let batchSeq = 0;
  let open = 0;
  let maxOpen = 0;

  const log = (event: string) => {
    events.push(event);
    options.onEvent?.(event);
  };

  function newFile(content: string): string {
    fileSeq += 1;
    const id = `file-fake-${fileSeq}`;
    files.set(id, content);
    return id;
  }

  function line(obj: unknown): string {
    return JSON.stringify(obj);
  }

  function materialize(state: BatchState, status: FakeBatchStatus): void {
    if (state.outputFileId || state.errorFileId) return;
    if (status === 'failed' || status === 'cancelled') return;
    const input = files.get(state.record.inputFileId) ?? '';
    const requests = input
      .split('\n')
      .filter(Boolean)
      .map((raw) => JSON.parse(raw) as { custom_id: string; body: { dimensions?: number; model?: string } });
    const doneLimit = status === 'expired' ? (state.script.completeOnly ?? 0) : requests.length;
    const outputs: string[] = [];
    const errors: string[] = [];
    requests.forEach((request, position) => {
      const customId = request.custom_id;
      if (position >= doneLimit) {
        errors.push(
          line({
            id: `batch_req_${customId}`,
            custom_id: customId,
            response: null,
            error: { code: 'batch_expired', message: 'This request could not be executed before the batch expired.' },
          }),
        );
        return;
      }
      if (state.script.failLine?.(customId)) {
        errors.push(
          line({
            id: `batch_req_${customId}`,
            custom_id: customId,
            response: { status_code: 400, request_id: `req_${position}`, body: { error: { message: 'invalid input' } } },
            error: null,
          }),
        );
        return;
      }
      const dims = state.script.wrongDims?.(customId) ?? request.body.dimensions ?? 1536;
      outputs.push(
        line({
          id: `batch_req_${customId}`,
          custom_id: customId,
          response: {
            status_code: 200,
            request_id: `req_${position}`,
            body: {
              object: 'list',
              data: [{ object: 'embedding', index: 0, embedding: fakeVector(customId, dims) }],
              model: request.body.model ?? 'text-embedding-3-small',
              usage: { prompt_tokens: 3, total_tokens: 3 },
            },
          },
          error: null,
        }),
      );
    });
    if (outputs.length > 0) state.outputFileId = newFile(seededShuffle(outputs, 7).join('\n') + '\n');
    if (errors.length > 0) state.errorFileId = newFile(seededShuffle(errors, 11).join('\n') + '\n');
  }

  function view(state: BatchState): Record<string, unknown> {
    const status = state.script.states[state.index] as FakeBatchStatus;
    const input = (files.get(state.record.inputFileId) ?? '').split('\n').filter(Boolean).length;
    const failed = state.errorFileId ? (files.get(state.errorFileId) ?? '').split('\n').filter(Boolean).length : 0;
    return {
      id: state.record.id,
      object: 'batch',
      endpoint: state.record.endpoint,
      errors: null,
      input_file_id: state.record.inputFileId,
      completion_window: state.record.completionWindow,
      status,
      output_file_id: state.outputFileId,
      error_file_id: state.errorFileId,
      created_at: 1_700_000_000,
      request_counts: { total: input, completed: input - failed, failed },
      metadata: null,
    };
  }

  async function readBody(request: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  const server = http.createServer(async (request, response) => {
    const send = (status: number, body: unknown, contentType = 'application/json') => {
      response.writeHead(status, { 'content-type': contentType });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const url = request.url ?? '';
    const body = await readBody(request);

    const injected = failures.shift();
    if (injected !== undefined) {
      send(injected, { error: { message: 'injected failure' } });
      return;
    }

    if (request.method === 'POST' && url === '/v1/files') {
      counts.upload += 1;
      log('upload');
      const parsed = multipartFile(body, String(request.headers['content-type'] ?? ''));
      const id = newFile(parsed.content);
      uploads.push({
        id,
        purpose: parsed.purpose,
        filename: parsed.filename,
        lines: parsed.content.split('\n').filter(Boolean),
      });
      send(200, {
        id,
        object: 'file',
        bytes: Buffer.byteLength(parsed.content),
        created_at: 1_700_000_000,
        filename: parsed.filename,
        purpose: parsed.purpose,
      });
      return;
    }

    if (request.method === 'POST' && url === '/v1/batches') {
      counts.create += 1;
      const input = JSON.parse(body.toString('utf8')) as {
        input_file_id?: string;
        endpoint?: string;
        completion_window?: string;
      };
      if (!input.input_file_id || !files.has(input.input_file_id)) {
        send(400, { error: { message: 'unknown input file' } });
        return;
      }
      if (input.endpoint !== '/v1/embeddings' || input.completion_window !== '24h') {
        send(400, { error: { message: 'unsupported endpoint or completion window' } });
        return;
      }
      batchSeq += 1;
      const id = `batch_fake_${batchSeq}`;
      log(`create:${id}`);
      const record: FakeBatchRecord = {
        id,
        inputFileId: input.input_file_id,
        endpoint: input.endpoint,
        completionWindow: input.completion_window,
      };
      batches.push(record);
      const script = scripts.shift() ?? {};
      const state: BatchState = {
        record,
        script: { ...script, states: script.states ?? DEFAULT_STATES },
        index: 0,
        outputFileId: null,
        errorFileId: null,
        closed: false,
      };
      states.set(id, state);
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      send(200, view(state));
      return;
    }

    const batchMatch = /^\/v1\/batches\/([^/?]+)$/.exec(url);
    if (request.method === 'GET' && batchMatch) {
      counts.retrieve += 1;
      const id = batchMatch[1] as string;
      log(`retrieve:${id}`);
      const state = states.get(id);
      if (!state) {
        send(404, { error: { message: 'no such batch' } });
        return;
      }
      state.index = Math.min(state.index + 1, state.script.states.length - 1);
      const status = state.script.states[state.index] as FakeBatchStatus;
      if (TERMINAL.has(status)) {
        materialize(state, status);
        if (!state.closed) {
          state.closed = true;
          open -= 1;
        }
      }
      send(200, view(state));
      return;
    }

    const fileMatch = /^\/v1\/files\/([^/?]+)\/content$/.exec(url);
    if (request.method === 'GET' && fileMatch) {
      counts.content += 1;
      const id = fileMatch[1] as string;
      log(`content:${id}`);
      const content = files.get(id);
      if (content === undefined) {
        send(404, { error: { message: 'no such file' } });
        return;
      }
      send(200, content, 'application/octet-stream');
      return;
    }

    send(404, { error: { message: 'not found' } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    uploads,
    batches,
    counts,
    events,
    maxOpen: () => maxOpen,
    script: (...next) => {
      scripts.push(...next);
    },
    failNext: (status) => {
      failures.push(status);
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
