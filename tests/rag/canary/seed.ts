import { mintScope, type TenantScope } from '@/lib/rag/tenant/scope';
import { CANARY_SENTENCE, type CanaryEnv, type CanaryLabel, type CanaryTenant } from './factory';

export interface CanaryIngestInput {
  scope: TenantScope;
  filename: string;
  text: string;
  /** Defaults to a key derived from the filename; reuse a key to write a new version of the same document. */
  sourceKey?: string;
  uploaderId?: string | null;
}

export interface CanaryIngestResult {
  status: string;
  documentId: string;
  chunkIds: string[];
}

/** The canary document text: the shared sentence plus the tenant's own marker word. */
export function canaryText(marker: string, extra = ''): string {
  return `# Canary note\n\n${CANARY_SENTENCE} ${marker}.${extra ? ` ${extra}` : ''}\n`;
}

export function markerFor(env: CanaryEnv, label: string): string {
  return `${label}mark${env.nonce}`;
}

/**
 * Seeding goes through the Phase 3 write path only: ingest() runs every stage and the real writer functions on PGlite, and the
 * database's outbox triggers queue the change for the drain. Nothing here writes to an external store.
 */
export async function ingestCanaryDocument(env: CanaryEnv, input: CanaryIngestInput): Promise<CanaryIngestResult> {
  const [{ ingest, buildSourceKey }] = await Promise.all([import('@/lib/rag/ingest')]);
  const sourceKey = input.sourceKey ?? buildSourceKey('chat_upload', { filename: input.filename });
  const result = await ingest({
    scope: input.scope,
    source: 'chat_upload',
    sourceKey,
    text: input.text,
    filename: input.filename,
    mimeType: 'text/markdown',
    docType: 'general',
    uploaderId: input.uploaderId ?? null,
    signal: new AbortController().signal,
  });
  if (!result.documentId) throw new Error(`[Canary] ingest wrote no document (${result.status}: ${result.reason ?? 'no reason'})`);
  const chunks = await env.sql<{ id: string }>('SELECT id FROM public.document_chunks WHERE document_id = $1 ORDER BY id', [result.documentId]);
  return { status: result.status, documentId: result.documentId, chunkIds: chunks.map((row) => String(row.id)) };
}

/** Users, the organization and its member, and the admin who may release a quarantined version. Identity rows only. */
export async function seedCanaryIdentities(env: CanaryEnv): Promise<void> {
  const { userA, userB, userM, orgO } = env.ids;
  await env.sql('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)', [
    userA,
    `canary-a-${env.nonce}@example.invalid`,
    userB,
    `canary-b-${env.nonce}@example.invalid`,
    userM,
    `canary-m-${env.nonce}@example.invalid`,
  ]);
  if (env.mode === 'multi-tenant') {
    await env.sql('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [
      orgO,
      'Canary Org',
      `canary-org-${env.nonce}`,
      userM,
    ]);
    await env.sql("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [orgO, userM]);
  }
  await env.sql('INSERT INTO admin_users (id) VALUES ($1)', [userA]);
}

interface TenantSpec {
  label: CanaryLabel;
  scope: TenantScope;
  userId: string | null;
  organizationId: string | null;
  writes: boolean;
}

function specs(env: CanaryEnv): TenantSpec[] {
  const { userA, userB, userM, orgO } = env.ids;
  if (env.mode === 'single-tenant') return [{ label: 's', scope: mintScope('single', null, null), userId: null, organizationId: null, writes: true }];
  return [
    { label: 'a', scope: mintScope('personal', userA, null), userId: userA, organizationId: null, writes: true },
    { label: 'b', scope: mintScope('personal', userB, null), userId: userB, organizationId: null, writes: true },
    { label: 'o', scope: mintScope('org', userM, orgO), userId: userM, organizationId: orgO, writes: true },
    { label: 'm', scope: mintScope('personal', userM, null), userId: userM, organizationId: null, writes: false },
  ];
}

/** One canary document per writing tenant, each with the identical sentence and the tenant's own marker. */
export async function seedCanaryTenants(env: CanaryEnv): Promise<void> {
  const { canonicalTenantKey } = await import('@/lib/rag/backend/tenant-key');
  for (const spec of specs(env)) {
    const tenantKey = canonicalTenantKey(spec.scope);
    env.tenantKeys.add(tenantKey);
    const marker = markerFor(env, spec.label);
    const tenant: CanaryTenant = {
      label: spec.label,
      scope: spec.scope,
      tenantKey,
      userId: spec.userId,
      organizationId: spec.organizationId,
      marker,
      documentId: '',
      chunkIds: [],
    };
    if (spec.writes) {
      const written = await ingestCanaryDocument(env, {
        scope: spec.scope,
        filename: `canary-${spec.label}-${env.nonce}.md`,
        text: canaryText(marker),
        uploaderId: spec.userId,
      });
      if (written.status !== 'ready') throw new Error(`[Canary] tenant ${spec.label} document is ${written.status}`);
      tenant.documentId = written.documentId;
      tenant.chunkIds = written.chunkIds;
    }
    env.tenants[spec.label] = tenant;
  }
}
