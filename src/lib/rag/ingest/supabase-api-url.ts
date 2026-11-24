/** Ensures ledger callers use the Supabase HTTP API (PostgREST), not a direct Postgres DSN. */

const DIRECT_DSN = /^postgres(ql)?:\/\//i;
const DIRECT_DB_HOST = /^db\.[a-z0-9-]+\.supabase\.co$/i;
const PROJECT_API_HOST = /^[a-z0-9-]+\.supabase\.co$/i;

export type SupabaseApiUrlIssue =
  | 'empty'
  | 'not_https'
  | 'direct_dsn'
  | 'direct_db_host'
  | 'postgres_port'
  | 'unexpected_host';

export function validateSupabaseApiUrl(raw: string | undefined | null): { ok: true; url: string } | { ok: false; issue: SupabaseApiUrlIssue } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, issue: 'empty' };
  if (DIRECT_DSN.test(trimmed)) return { ok: false, issue: 'direct_dsn' };
  if (/:5432\b/.test(trimmed)) return { ok: false, issue: 'postgres_port' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, issue: 'unexpected_host' };
  }

  if (parsed.protocol !== 'https:') return { ok: false, issue: 'not_https' };
  if (DIRECT_DB_HOST.test(parsed.hostname)) return { ok: false, issue: 'direct_db_host' };
  if (!PROJECT_API_HOST.test(parsed.hostname) && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return { ok: false, issue: 'unexpected_host' };
  }

  return { ok: true, url: parsed.origin };
}

export function assertSupabaseApiUrl(raw: string | undefined | null, label = 'NEXT_PUBLIC_SUPABASE_URL'): string {
  const result = validateSupabaseApiUrl(raw);
  if (result.ok) return result.url;
  throw new Error(`[Ingest] ${label} must be the Supabase project HTTPS URL (PostgREST), not a direct database connection (${result.issue})`);
}