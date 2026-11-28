import { Worker } from 'node:worker_threads';

/**
 * Time-boxed execution of admin identifier patterns (D-52, F-14). JavaScript has no regex timeout, so every match of an admin pattern
 * runs here, in a worker thread that is terminated at the outer deadline. The worker source is inline (`eval: true`), so the bundler
 * never has to resolve a worker file; the measured match time inside the worker is what the 50 ms probe rule compares.
 */

export interface WorkerPattern {
  /** Echoed back on each span; a saved pattern id or a fixed label. */
  id: string;
  source: string;
  /** Compile flags (`gu` or `giu`). */
  flags: string;
}

export interface WorkerSpan {
  patternId: string;
  inputIndex: number;
  /** UTF-16 offsets into the input. */
  start: number;
  end: number;
}

export interface RunPatternRequest {
  patterns: readonly WorkerPattern[];
  inputs: readonly string[];
  /** Spans kept per pattern and input (default 5000); counting continues past it. */
  maxSpans?: number;
}

export type RunPatternResult =
  | {
      kind: 'ok';
      /** Wall time of the matching loop, measured inside the worker. */
      elapsedMs: number;
      spans: WorkerSpan[];
      /** Matches per pattern id, counted past maxSpans. */
      counts: Record<string, number>;
      /** Per pattern id: true when at least one match contains a letter or a digit. */
      alphanumeric: Record<string, boolean>;
    }
  | { kind: 'timeout' }
  | { kind: 'error'; error: 'invalid_regex' | 'worker_failed' | 'aborted' };

export interface RunPatternOptions {
  /** Outer kill switch in milliseconds; covers worker start-up (default 1000). */
  deadlineMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_DEADLINE_MS = 1000;
const MAX_CONCURRENT_WORKERS = 4;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const alnum = /[\\p{L}\\p{N}]/u;
let compiled;
try {
  compiled = workerData.patterns.map((p) => ({ id: p.id, re: new RegExp(p.source, p.flags) }));
} catch (error) {
  parentPort.postMessage({ kind: 'error', error: 'invalid_regex' });
  compiled = null;
}
if (compiled) {
  const spans = [];
  const counts = {};
  const alphanumeric = {};
  const started = performance.now();
  for (const p of compiled) {
    counts[p.id] = 0;
    alphanumeric[p.id] = false;
    for (let i = 0; i < workerData.inputs.length; i += 1) {
      const input = workerData.inputs[i];
      let kept = 0;
      for (const m of input.matchAll(p.re)) {
        if (m[0].length === 0) continue;
        counts[p.id] += 1;
        if (!alphanumeric[p.id] && alnum.test(m[0])) alphanumeric[p.id] = true;
        if (kept < workerData.maxSpans) {
          spans.push({ patternId: p.id, inputIndex: i, start: m.index, end: m.index + m[0].length });
          kept += 1;
        }
      }
    }
  }
  const elapsedMs = performance.now() - started;
  parentPort.postMessage({ kind: 'ok', elapsedMs, spans, counts, alphanumeric });
}
`;

let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_WORKERS) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  waiting.shift()?.();
}

/** Runs the patterns over the inputs in a fresh worker; the worker is terminated on completion, at the deadline or on abort. */
export async function runPatternInWorker(request: RunPatternRequest, options: RunPatternOptions = {}): Promise<RunPatternResult> {
  if (options.signal?.aborted) return { kind: 'error', error: 'aborted' };
  await acquire();
  try {
    return await new Promise<RunPatternResult>((resolve) => {
      let settled = false;
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          patterns: request.patterns.map((p) => ({ id: p.id, source: p.source, flags: p.flags })),
          inputs: [...request.inputs],
          maxSpans: request.maxSpans ?? 5000,
        },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        stdout: true,
        stderr: true,
      });
      const finish = (result: RunPatternResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        void worker.terminate().then(
          () => resolve(result),
          () => resolve(result),
        );
      };
      const onAbort = () => finish({ kind: 'error', error: 'aborted' });
      const timer = setTimeout(() => finish({ kind: 'timeout' }), options.deadlineMs ?? DEFAULT_DEADLINE_MS);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      worker.once('message', (message: RunPatternResult) => finish(message));
      worker.once('error', () => finish({ kind: 'error', error: 'worker_failed' }));
      worker.once('exit', () => finish({ kind: 'error', error: 'worker_failed' }));
    });
  } finally {
    release();
  }
}
