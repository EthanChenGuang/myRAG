export interface SqlConnection {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  queryWithNotices<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; notices: string[] }>;
  close(): Promise<void>;
}

export interface BenchDeps {
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  connectPostgres?: (url: string) => Promise<SqlConnection>;
}

export async function main(_argv: string[], _deps: BenchDeps): Promise<number> {
  return 0;
}
