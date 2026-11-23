import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureDatabase, type FixtureDatabase } from './pglite-supabase.mts';
import { embedText } from './fixture-embedder.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');

export const TWO_TENANT_IDS = {
  userA: '00000000-0000-4000-8000-0000000000a1',
  userB: '00000000-0000-4000-8000-0000000000b1',
  orgO: '00000000-0000-4000-8000-0000000000c1',
  docA: '00000000-0000-4000-8000-0000000000d1',
  docB: '00000000-0000-4000-8000-0000000000d2',
  docO: '00000000-0000-4000-8000-0000000000d3',
  chunkA: '00000000-0000-4000-8000-0000000000e1',
  chunkB: '00000000-0000-4000-8000-0000000000e2',
  chunkO: '00000000-0000-4000-8000-0000000000e3',
} as const;

export type TwoTenantDatabase = FixtureDatabase;

interface TenantDocument {
  docId: string;
  chunkId: string;
  userId: string;
  organizationId: string | null;
  filename: string;
  marker: string;
  metadata: Record<string, unknown>;
}

const CREATED_AT = '2025-01-15T00:00:00.000Z';

const TENANT_DOCUMENTS: TenantDocument[] = [
  {
    docId: TWO_TENANT_IDS.docA,
    chunkId: TWO_TENANT_IDS.chunkA,
    userId: TWO_TENANT_IDS.userA,
    organizationId: null,
    filename: 'tenant-a-personal.md',
    marker: 'alpha personal notes',
    metadata: { name: 'Alpha notes' },
  },
  {
    docId: TWO_TENANT_IDS.docB,
    chunkId: TWO_TENANT_IDS.chunkB,
    userId: TWO_TENANT_IDS.userB,
    organizationId: null,
    filename: 'tenant-b-personal.md',
    marker: 'bravo personal notes',
    metadata: { name: 'Bravo notes' },
  },
  {
    docId: TWO_TENANT_IDS.docO,
    chunkId: TWO_TENANT_IDS.chunkO,
    userId: TWO_TENANT_IDS.userA,
    organizationId: TWO_TENANT_IDS.orgO,
    filename: 'tenant-o-organization.md',
    marker: 'organization shared handbook',
    metadata: { name: 'Company logo', image_context: 'brand logo mark', image_url: 'https://example.invalid/logo.png' },
  },
];

function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

export async function createTwoTenantDatabase(options: { corpusDir?: string } = {}): Promise<TwoTenantDatabase> {
  const fixture = await createFixtureDatabase({
    deploymentMode: 'multi-tenant',
    corpusDir: options.corpusDir ?? DEFAULT_CORPUS_DIR,
  });
  const { db } = fixture;
  const ids = TWO_TENANT_IDS;
  try {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [
      ids.userA,
      'tenant-a@example.invalid',
      ids.userB,
      'tenant-b@example.invalid',
    ]);
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [
      ids.orgO,
      'Tenant O',
      'tenant-o',
      ids.userA,
    ]);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [ids.orgO, ids.userA]);

    for (const doc of TENANT_DOCUMENTS) {
      const text = `Two tenant isolation canary phrase: ${doc.marker}`;
      const stored = `Document: ${doc.filename}. Chunk 1 of 1. Content: ${text}`;
      await db.query(
        'INSERT INTO documents (id, filename, content, metadata, user_id, organization_id, created_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)',
        [doc.docId, doc.filename, text, JSON.stringify({ relpath: `two-tenant/${doc.filename}` }), doc.userId, doc.organizationId, CREATED_AT],
      );
      await db.query(
        'INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, organization_id, created_at) VALUES ($1, $2, $3, $4::vector, 0, $5::jsonb, $6, $7)',
        [doc.chunkId, doc.docId, stored, vectorLiteral(embedText(text)), JSON.stringify(doc.metadata), doc.organizationId, CREATED_AT],
      );
    }
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  return fixture;
}
