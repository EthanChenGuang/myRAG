import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';

export interface RecordedRpc {
  fn: string;
  args: Record<string, unknown>;
  signal: AbortSignal | null;
}

export function fakeRpc(respond: (fn: string, args: Record<string, unknown>) => RpcResponse | Promise<RpcResponse>): {
  client: RpcClient;
  calls: RecordedRpc[];
} {
  const calls: RecordedRpc[] = [];
  const client: RpcClient = {
    rpc(fn, args) {
      const call: RecordedRpc = { fn, args, signal: null };
      calls.push(call);
      const pending = Promise.resolve().then(() => respond(fn, args));
      const request: RpcRequest = {
        abortSignal(signal) {
          call.signal = signal;
          return request;
        },
        then: (onFulfilled, onRejected) => pending.then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { client, calls };
}
