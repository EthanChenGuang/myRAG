import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { chunkLexicalText } from '@/lib/rag/lexical/chunk-text';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';

export const PROFILE_ID = 'openai-3-small-1536';

export const IDS = {
  userA: '00000000-0000-4000-8000-0000000000a1',
  userB: '00000000-0000-4000-8000-0000000000b1',
  userUpper: 'ABCDEF01-2345-6789-ABCD-EF0123456789',
  orgO: '00000000-0000-4000-8000-0000000000c1',
  docZh: '00000000-0000-4000-8000-0000000000d1',
  docEn: '00000000-0000-4000-8000-0000000000d2',
  docIt: '00000000-0000-4000-8000-0000000000d3',
  docCanaryA: '00000000-0000-4000-8000-0000000000d4',
  docCanaryB: '00000000-0000-4000-8000-0000000000d5',
  docHidden: '00000000-0000-4000-8000-0000000000d6',
  docRare: '00000000-0000-4000-8000-0000000000d7',
  docTie1: '00000000-0000-4000-8000-0000000000d8',
  docTie2: '00000000-0000-4000-8000-0000000000d9',
  chunkZh: '00000000-0000-4000-8000-0000000000e1',
  chunkEn: '00000000-0000-4000-8000-0000000000e2',
  chunkIt: '00000000-0000-4000-8000-0000000000e3',
  chunkCanaryA: '00000000-0000-4000-8000-0000000000e4',
  chunkCanaryB: '00000000-0000-4000-8000-0000000000e5',
  chunkSuperseded: '00000000-0000-4000-8000-0000000000e6',
  chunkQuarantined: '00000000-0000-4000-8000-0000000000e7',
  chunkRare: '00000000-0000-4000-8000-0000000000e8',
  chunkTie1: '00000000-0000-4000-8000-0000000000e9',
  chunkTie2: '00000000-0000-4000-8000-0000000000ea',
} as const;

export const QUERIES = {
  zh: '型号XR-2000保修',
  en: 'model XR-2000 warranty',
  it: 'modello XR-2000 garanzia',
  canary: 'shared conformance canary phrase',
  person: '王小明',
  uscc: '91310000MA1FL0XX0T',
  empty: '',
  stopwords: 'the and or',
  rare: 'raretype marker',
} as const;

export const EXACT_SCAN_CUTOFF = 500;

function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

function lexicalFor(content: string, filename: string): string {
  return chunkLexicalText({ sectionPath: [], content, documentFilename: filename });
}

async function insertReadyChunk(
  db: PGlite,
  args: {
    chunkId: string;
    docId: string;
    userId: string;
    orgId: string | null;
    filename: string;
    body: string;
    language: string;
    docType: string;
    source: string;
    docDate?: string;
    isCurrent?: boolean;
    status?: string;
    embedding?: number[];
  },
): Promise<void> {
  const stored = `Document: ${args.filename}. Chunk 1 of 1. Content: ${args.body}`;
  const embedding = args.embedding ?? embedText(args.body);
  const lexical = lexicalFor(stored, args.filename);
  await db.query(
    `INSERT INTO documents (id, filename, content, user_id, organization_id, language, doc_type, source, is_current, status, doc_date, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, 'ready', $9, '2025-06-01T00:00:00Z')`,
    [args.docId, args.filename, args.body, args.userId, args.orgId, args.language, args.docType, args.source, args.docDate ?? '2025-06-01'],
  );
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, chunk_index, metadata, organization_id, language, doc_type, source, is_current, status, doc_date, created_at)
     VALUES ($1, $2, $3, $4::vector, $5, 0, '{}'::jsonb, $6, $7, $8, $9, $10, $11, $12, '2025-06-01T00:00:00Z')`,
    [
      args.chunkId,
      args.docId,
      stored,
      vectorLiteral(embedding),
      lexical,
      args.orgId,
      args.language,
      args.docType,
      args.source,
      args.isCurrent ?? true,
      args.status ?? 'ready',
      args.docDate ?? '2025-06-01',
    ],
  );
}

export async function loadConformanceDataset(db: PGlite): Promise<void> {
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)', [
    IDS.userA,
    'tenant-a@example.invalid',
    IDS.userB,
    'tenant-b@example.invalid',
    IDS.userUpper.toLowerCase(),
    'upper@example.invalid',
  ]);
  await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [
    IDS.orgO,
    'Conformance Org',
    'conf-org',
    IDS.userA,
  ]);
  await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [IDS.orgO, IDS.userA]);

  await insertReadyChunk(db, {
    chunkId: IDS.chunkZh,
    docId: IDS.docZh,
    userId: IDS.userA,
    orgId: null,
    filename: 'zh-model.md',
    body: '型号 XR-2000/A_v2.1 设备保修适用范围 统一社会信用代码91310000MA1FL0XX0T 联系人王小明',
    language: 'zh',
    docType: 'product_technical',
    source: 'manual',
  });
  await insertReadyChunk(db, {
    chunkId: IDS.chunkEn,
    docId: IDS.docEn,
    userId: IDS.userA,
    orgId: null,
    filename: 'en-model.md',
    body: 'Model XR-2000/A_v2.1 warranty coverage for the device',
    language: 'en',
    docType: 'product_technical',
    source: 'manual',
  });
  await insertReadyChunk(db, {
    chunkId: IDS.chunkIt,
    docId: IDS.docIt,
    userId: IDS.userA,
    orgId: null,
    filename: 'it-modello.md',
    body: "Modello XR-2000/A_v2.1 garanzia dell'anno perché società",
    language: 'it',
    docType: 'product_technical',
    source: 'manual',
  });

  const canaryBody = `shared conformance canary phrase ${QUERIES.canary}`;
  await insertReadyChunk(db, {
    chunkId: IDS.chunkCanaryA,
    docId: IDS.docCanaryA,
    userId: IDS.userA,
    orgId: null,
    filename: 'canary-a.md',
    body: canaryBody,
    language: 'en',
    docType: 'general',
    source: 'conformance-a',
  });
  await insertReadyChunk(db, {
    chunkId: IDS.chunkCanaryB,
    docId: IDS.docCanaryB,
    userId: IDS.userB,
    orgId: null,
    filename: 'canary-b.md',
    body: canaryBody,
    language: 'en',
    docType: 'general',
    source: 'conformance-b',
  });

  await insertReadyChunk(db, {
    chunkId: IDS.chunkSuperseded,
    docId: IDS.docHidden,
    userId: IDS.userA,
    orgId: null,
    filename: 'hidden.md',
    body: 'superseded conformance chunk',
    language: 'en',
    docType: 'general',
    source: 'manual',
    isCurrent: false,
    status: 'ready',
  });
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, embedding, lexical_text, chunk_index, metadata, language, doc_type, is_current, status)
     VALUES ($1, $2, $3, $4::vector, $3, 1, '{}'::jsonb, 'en', 'general', true, 'quarantined')`,
    [IDS.chunkQuarantined, IDS.docHidden, 'quarantined conformance chunk', vectorLiteral(embedText('quarantined conformance chunk'))],
  );

  await insertReadyChunk(db, {
    chunkId: IDS.chunkRare,
    docId: IDS.docRare,
    userId: IDS.userA,
    orgId: null,
    filename: 'rare.md',
    body: 'raretype marker financial conformance slice',
    language: 'en',
    docType: 'financial_report',
    source: 'manual',
  });

  const tieVector = embedText('tie vector duplicate');
  await insertReadyChunk(db, {
    chunkId: IDS.chunkTie1,
    docId: IDS.docTie1,
    userId: IDS.userA,
    orgId: null,
    filename: 'tie-one.md',
    body: 'tie duplicate alpha',
    language: 'en',
    docType: 'general',
    source: 'manual',
    embedding: tieVector,
  });
  await insertReadyChunk(db, {
    chunkId: IDS.chunkTie2,
    docId: IDS.docTie2,
    userId: IDS.userA,
    orgId: null,
    filename: 'tie-two.md',
    body: 'tie duplicate beta',
    language: 'en',
    docType: 'general',
    source: 'manual',
    embedding: tieVector,
  });

  await insertReadyChunk(db, {
    chunkId: '00000000-0000-4000-8000-0000000000eb',
    docId: '00000000-0000-4000-8000-0000000000dc',
    userId: IDS.userUpper.toLowerCase(),
    orgId: null,
    filename: 'upper-user.md',
    body: 'Model XR-2000/A_v2.1 warranty for upper-case scope user',
    language: 'en',
    docType: 'product_technical',
    source: 'manual',
  });

  for (let index = 0; index < 20; index += 1) {
    const docId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    const filler = `filler general chunk ${index} conformance padding`;
    await insertReadyChunk(db, {
      chunkId,
      docId,
      userId: IDS.userA,
      orgId: null,
      filename: `filler-${index}.md`,
      body: filler,
      language: 'en',
      docType: 'general',
      source: 'manual',
    });
  }
}