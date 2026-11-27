import type { RpcError, RpcResponse } from '../backend/supabase-rpc';

export interface LexstatsQuery extends PromiseLike<{ data: unknown; error: RpcError | null }> {
  select(columns: string): LexstatsQuery;
  eq(column: string, value: unknown): LexstatsQuery;
  in(column: string, values: unknown[]): LexstatsQuery;
  gt(column: string, value: unknown): LexstatsQuery;
  order(column: string, options?: { ascending?: boolean }): LexstatsQuery;
  limit(count: number): LexstatsQuery;
}

export interface LexstatsDb {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResponse>;
  from(table: string): LexstatsQuery;
}
