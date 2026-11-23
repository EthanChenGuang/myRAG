import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { RagDeps } from '@/lib/rag/deps';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { resetRagConfigForTests } from '@/lib/rag/config';
import type { RagEnvInput } from '@/lib/rag/config';

export const SEMANTIC_QUERY = 'tell me about the onboarding process';

export interface FakeRow {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown> | null;
}

export function rows(count: number): FakeRow[] {
  return Array.from({ length: count }, (_, index) => ({
    chunk_id: `chunk-${index + 1}`,
    document_id: `doc-${index + 1}`,
    content: `fixture chunk body ${index + 1}`,
    similarity: 0.9 - index * 0.05,
    metadata: null,
  }));
}

export interface FakeRpcOptions {
  rows?: FakeRow[];
  delayMs?: number;
  error?: { message: string; code?: string };
  throwOnCall?: Error;
}

export interface FakeRpcCall {
  fn: string;
  signal: AbortSignal | undefined;
}

export function fakeRpcClient(options: FakeRpcOptions = {}): { client: RpcClient; calls: FakeRpcCall[] } {
  const calls: FakeRpcCall[] = [];
  const client: RpcClient = {
    rpc(fn: string): RpcRequest {
      if (options.throwOnCall) throw options.throwOnCall;
      let signal: AbortSignal | undefined;
      const respond = (): RpcResponse =>
        options.error ? { data: null, error: options.error } : { data: options.rows ?? [], error: null };
      const request: RpcRequest = {
        abortSignal(next: AbortSignal) {
          signal = next;
          return request;
        },
        then(onFulfilled, onRejected) {
          calls.push({ fn, signal });
          const settled = new Promise<RpcResponse>((resolve) => {
            if (signal?.aborted) {
              resolve({ data: null, error: { message: 'aborted' } });
              return;
            }
            const timer = setTimeout(() => resolve(respond()), options.delayMs ?? 0);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve({ data: null, error: { message: 'aborted' } });
              },
              { once: true },
            );
          });
          return settled.then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

export interface FakeEmbedderOptions {
  delayMs?: number;
  fail?: Error;
}

export function fakeEmbedder(options: FakeEmbedderOptions = {}): {
  embedder: RagDeps['embedder'];
  signals: AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  const embedder: RagDeps['embedder'] = (_text, { signal }) => {
    signals.push(signal);
    if (options.fail) return Promise.reject(options.fail);
    return new Promise<number[]>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => resolve([0.1, 0.2, 0.3]), options.delayMs ?? 0);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  };
  return { embedder, signals };
}

export function fakeAssemblyAdmin(): RagDeps['adminClient'] {
  const client = {
    from(table: string) {
      let ids: string[] = [];
      const builder = {
        select() {
          return builder;
        },
        in(_column: string, values: string[]) {
          ids = values;
          return builder;
        },
        abortSignal() {
          return builder;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          const data =
            table === 'documents'
              ? ids.map((id) => ({ id, filename: `${id}.md`, created_at: null, content: null, metadata: null }))
              : ids.map((id) => ({ id, metadata: null }));
          return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
  return () => client as never;
}

export function adminWithRpc(searchRpc: RpcClient, base: RagDeps['adminClient'] = fakeAssemblyAdmin()): RagDeps['adminClient'] {
  return () => {
    const admin = base();
    if (!admin) return admin;
    return new Proxy(admin as object, {
      get: (target, key) => (key === 'rpc' ? searchRpc.rpc.bind(searchRpc) : Reflect.get(target, key)),
    }) as never;
  };
}

export function installDeps(partial: Partial<RagDeps> & { ragEnv?: () => RagEnvInput; searchRpc?: RpcClient }): void {
  resetRagConfigForTests();
  const { searchRpc, ...deps } = partial;
  const base = deps.adminClient ?? fakeAssemblyAdmin();
  setRagDepsForTests({ ...deps, adminClient: searchRpc ? adminWithRpc(searchRpc, base) : base });
}

export function uninstallDeps(): void {
  resetRagDepsForTests();
  resetRagConfigForTests();
}
