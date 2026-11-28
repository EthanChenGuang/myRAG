import { describe, expect, it } from 'vitest';
import { assertSupabaseApiUrl, validateSupabaseApiUrl } from '@/lib/rag/ingest/supabase-api-url';

describe('validateSupabaseApiUrl', () => {
  it('accepts a project HTTPS API origin', () => {
    expect(validateSupabaseApiUrl('https://example.supabase.co/')).toMatchObject({ ok: true, url: 'https://example.supabase.co' });
  });

  it('rejects direct Postgres DSN and db host', () => {
    expect(validateSupabaseApiUrl('postgresql://postgres:secret@db.abc123.supabase.co:5432/postgres')).toMatchObject({
      ok: false,
      issue: 'direct_dsn',
    });
    expect(validateSupabaseApiUrl('https://db.abc123.supabase.co')).toMatchObject({ ok: false, issue: 'direct_db_host' });
  });

  it('assert throws on postgres port in URL string', () => {
    expect(() => assertSupabaseApiUrl('https://example.supabase.co:5432')).toThrow(/postgres_port/i);
  });
});