import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { vi } from 'vitest';
import { pgliteClient } from './pglite-rest-client';

/**
 * Two organization tenants (A and B) in a multi-tenant PGlite database with security events, alerts and documents, for the
 * security-events admin routes (05.2-18). Names, e-mails and file names are synthetic placeholders.
 */

type Row = Record<string, unknown>;

export interface SecurityFixture {
  admin: string;
  orgAdminA: string;
  orgAdminB: string;
  expertA: string;
  expertB: string;
  member: string;
  uploaderA1: string;
  uploaderA2: string;
  uploaderB: string;
  tenantA: string;
  tenantB: string;
  docA1: string;
  docA2: string;
  docB1: string;
  chunkA1: string;
  chunkB1: string;
  alertA: string;
  alertB: string;
  eventCountA: number;
  eventCountA2: number;
  names: Map<string, Record<string, unknown>>;
  emailOf(id: string): string;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

const emailOf = (id: string) => `user-${id.slice(-6)}@example.invalid`;

/**
 * The service-role client of the routes: the shared PGlite REST client, with set-returning RPCs answered as arrays (as PostgREST does)
 * and auth.admin.getUserById returning the stored e-mail and the fixture's user metadata.
 */
export function securityAdminClient(db: PGlite, names: Map<string, Record<string, unknown>>, calls: string[] = []) {
  const base = pgliteClient(db, { role: 'service_role', label: 'admin', calls });
  return {
    ...base,
    rpc: async (name: string, args: Row = {}) => {
      if (!IDENT_RE.test(name)) throw new Error(`unsupported rpc ${name}`);
      calls.push(`admin:rpc:${name}`);
      const set = await db.query<{ retset: boolean }>('SELECT bool_or(proretset) AS retset FROM pg_proc WHERE proname = $1', [name]);
      if (!set.rows[0]?.retset) return base.rpc(name, args);
      const values: unknown[] = [];
      const named = Object.entries(args).map(([key, value]) => {
        if (!IDENT_RE.test(key)) throw new Error(`unsupported argument ${key}`);
        values.push(value);
        return `"${key}" => $${values.length}`;
      });
      try {
        const data = await db.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE service_role');
          const result = await tx.query<{ rows: unknown }>(`SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM public."${name}"(${named.join(', ')}) t`, values);
          return result.rows[0]?.rows ?? [];
        });
        return { data, error: null };
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'unknown';
        return { data: null, error: { code, message: (error as Error).message } };
      }
    },
    auth: {
      ...base.auth,
      admin: {
        getUserById: async (id: string) => {
          const found = await db.query<{ id: string; email: string | null }>('SELECT id::text AS id, email FROM auth.users WHERE id::text = $1', [id]);
          const row = found.rows[0];
          if (!row) return { data: { user: null }, error: { message: 'User not found' } };
          return { data: { user: { id: row.id, email: row.email, user_metadata: names.get(row.id) ?? {} } }, error: null };
        },
      },
    },
  };
}

async function user(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, emailOf(id)]);
  return id;
}

async function document(db: PGlite, owner: string, organizationId: string, filename: string): Promise<{ id: string; chunk: string }> {
  const id = crypto.randomUUID();
  const chunk = crypto.randomUUID();
  await db.query('INSERT INTO documents (id, filename, content, user_id, organization_id) VALUES ($1, $2, $3, $4, $5)', [
    id,
    filename,
    'A neutral synthetic body.',
    owner,
    organizationId,
  ]);
  await db.query('INSERT INTO document_chunks (id, document_id, content) VALUES ($1, $2, $3)', [chunk, id, 'A neutral synthetic chunk.']);
  return { id, chunk };
}

async function record(db: PGlite, tenantKey: string, events: Row[]): Promise<{ alert_ids: string[] }> {
  await db.exec('SET ROLE service_role');
  try {
    const result = await db.query<{ result: { alert_ids: string[] } }>('SELECT public.rag_record_security_events($1, $2::jsonb, 2, 24, false) AS result', [
      tenantKey,
      JSON.stringify(events),
    ]);
    return result.rows[0]!.result;
  } finally {
    await db.exec('RESET ROLE');
  }
}

function events(count: number, documentId: string, chunkId: string): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    source: index % 2 === 0 ? 'ingest_injection' : 'output_guard',
    action: index % 2 === 0 ? 'detected' : 'removed',
    detector: 'rules',
    rule_ids: ['rule-1'],
    document_id: documentId,
    chunk_id: index % 2 === 0 ? null : chunkId,
  }));
}

export async function seedSecurityTenants(db: PGlite): Promise<SecurityFixture> {
  const [admin, orgAdminA, orgAdminB, expertA, expertB, member, uploaderA1, uploaderA2, uploaderB] = [
    await user(db),
    await user(db),
    await user(db),
    await user(db),
    await user(db),
    await user(db),
    await user(db),
    await user(db),
    await user(db),
  ];
  await db.query('INSERT INTO admin_users (id) VALUES ($1)', [admin]);
  const orgA = crypto.randomUUID();
  const orgB = crypto.randomUUID();
  await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [orgA, 'Workspace A', `ws-a-${orgA.slice(0, 8)}`, orgAdminA]);
  await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [orgB, 'Workspace B', `ws-b-${orgB.slice(0, 8)}`, orgAdminB]);
  for (const [organization, userId, role] of [
    [orgA, orgAdminA, 'admin'],
    [orgB, orgAdminB, 'admin'],
    [orgA, member, 'member'],
    [orgA, uploaderA1, 'member'],
    [orgA, uploaderA2, 'member'],
    [orgB, uploaderB, 'member'],
  ]) {
    await db.query(
      'INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role',
      [organization, userId, role],
    );
  }
  const tenantA = `o:${orgA}`;
  const tenantB = `o:${orgB}`;
  await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2), ($3, $4)', [tenantA, expertA, tenantB, expertB]);

  const docA1 = await document(db, uploaderA1, orgA, 'document-a1.pdf');
  const docA2 = await document(db, uploaderA2, orgA, 'document-a2.pdf');
  const docB1 = await document(db, uploaderB, orgB, 'document-b1.pdf');

  const a1 = await record(db, tenantA, events(40, docA1.id, docA1.chunk));
  await record(db, tenantA, events(5, docA2.id, docA2.chunk));
  const b1 = await record(db, tenantB, events(15, docB1.id, docB1.chunk));

  const names = new Map<string, Record<string, unknown>>([
    [uploaderA1, { full_name: 'Uploader One' }],
    [uploaderA2, { name: 'Uploader Two' }],
    [uploaderB, { full_name: 'Uploader Bravo' }],
  ]);
  return {
    admin,
    orgAdminA,
    orgAdminB,
    expertA,
    expertB,
    member,
    uploaderA1,
    uploaderA2,
    uploaderB,
    tenantA,
    tenantB,
    docA1: docA1.id,
    docA2: docA2.id,
    docB1: docB1.id,
    chunkA1: docA1.chunk,
    chunkB1: docB1.chunk,
    alertA: a1.alert_ids[0]!,
    alertB: b1.alert_ids[0]!,
    eventCountA: 45,
    eventCountA2: 5,
    names,
    emailOf,
  };
}

type Handler = (...args: any[]) => Promise<Response>;
type RouteKey = 'events' | 'alerts' | 'acknowledge' | 'uploaders' | 'hold' | 'release' | 'linkPreviews' | 'reviewItem' | 'reviewList';
export type SecurityRoutes = Record<RouteKey, { GET: Handler; POST: Handler }>;

/** Fresh route modules over the fixture database, with the session user read at request time. */
export async function securityRoutes(
  db: PGlite,
  session: { userId: string | null },
  preview: { hosts: string[] | null },
  names: Map<string, Record<string, unknown>> = new Map(),
  calls: string[] = [],
): Promise<SecurityRoutes> {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => pgliteClient(db, { role: 'authenticated', userId: session.userId, label: 'ssr', calls }),
  }));
  vi.doMock('@/lib/supabase', () => ({
    getSupabaseAdmin: () => securityAdminClient(db, names, calls),
    getSupabase: () => ({}),
  }));
  vi.doMock('@/lib/whatsapp/client-factory', () => ({
    getWhatsAppClient: () => ({ getLinkPreviewHosts: async () => (preview.hosts === null ? null : [...preview.hosts]) }),
  }));
  return {
    events: (await import('@/app/api/rag/admin/security-events/route')) as unknown as SecurityRoutes['events'],
    alerts: (await import('@/app/api/rag/admin/security-events/alerts/route')) as unknown as SecurityRoutes['alerts'],
    acknowledge: (await import('@/app/api/rag/admin/security-events/alerts/[id]/acknowledge/route')) as unknown as SecurityRoutes['acknowledge'],
    uploaders: (await import('@/app/api/rag/admin/security-events/uploaders/route')) as unknown as SecurityRoutes['uploaders'],
    hold: (await import('@/app/api/rag/admin/security-events/uploaders/[id]/hold/route')) as unknown as SecurityRoutes['hold'],
    release: (await import('@/app/api/rag/admin/security-events/uploaders/[id]/release/route')) as unknown as SecurityRoutes['release'],
    linkPreviews: (await import('@/app/api/rag/admin/security-events/link-previews/route')) as unknown as SecurityRoutes['linkPreviews'],
    reviewItem: (await import('@/app/api/rag/review/items/[id]/route')) as unknown as SecurityRoutes['reviewItem'],
    reviewList: (await import('@/app/api/rag/review/items/route')) as unknown as SecurityRoutes['reviewList'],
  };
}
