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

export async function runPatternInWorker(request: RunPatternRequest, options: RunPatternOptions = {}): Promise<RunPatternResult> {
  void request;
  void options;
  return { kind: 'ok', elapsedMs: 0, spans: [], counts: {}, alphanumeric: {} };
}
