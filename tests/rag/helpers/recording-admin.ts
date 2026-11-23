import type { SupabaseClient } from '@supabase/supabase-js';

export interface RecordedCall {
  table: string;
  ops: Array<{ op: string; args: unknown[] }>;
  signal: AbortSignal | null;
}

export interface RecordedResponse {
  data: unknown;
  error: { message: string; code?: string } | null;
}

export type Responder = (call: RecordedCall) => RecordedResponse;

const CHAIN_METHODS = ['select', 'insert', 'update', 'delete', 'eq', 'in', 'is', 'not', 'or', 'ilike', 'limit', 'order', 'single', 'maybeSingle'];

/** A chainable Supabase stand-in that records every builder call and answers through `respond`. */
export function recordingAdmin(respond: Responder): { admin: SupabaseClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const admin = {
    from(table: string) {
      const call: RecordedCall = { table, ops: [], signal: null };
      const builder: Record<string, unknown> = {};
      for (const method of CHAIN_METHODS) {
        builder[method] = (...args: unknown[]) => {
          call.ops.push({ op: method, args });
          return builder;
        };
      }
      builder.abortSignal = (signal: AbortSignal) => {
        call.signal = signal;
        return builder;
      };
      builder.then = (onFulfilled: (value: RecordedResponse) => unknown, onRejected?: (reason: unknown) => unknown) => {
        calls.push(call);
        return Promise.resolve(respond(call)).then(onFulfilled, onRejected);
      };
      return builder;
    },
  };

  return { admin: admin as unknown as SupabaseClient, calls };
}

export function opsOf(call: RecordedCall, op: string): unknown[][] {
  return call.ops.filter((entry) => entry.op === op).map((entry) => entry.args);
}
