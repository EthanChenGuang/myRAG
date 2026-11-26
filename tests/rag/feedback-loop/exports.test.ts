import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DictionaryCandidateSchema, TrainingPairSchema } from '@/lib/rag-eval/contracts.generated';
import { exportDictionary, exportGolden, exportTraining, GoldenExportLineSchema, markExported } from '@/lib/rag/feedback-loop/exports';
import { pgliteClient } from '../../helpers/pglite-rest-client';
import {
  CHUNK_A,
  CHUNK_A_QUARANTINED,
  CHUNK_A_ZH,
  CHUNK_B,
  DOC_A,
  DOC_A_MANY,
  DOC_A_QUARANTINED,
  DOC_B,
  MANY_A_CHUNKS,
  OWNER_A,
  TENANT_A,
  TENANT_B,
  TEXT_A,
  TEXT_A_QUARANTINED,
  TEXT_B,
  candidate,
  createReviewFixture,
  insertReviewItem,
} from '../../helpers/review-fixture';

const DOC_X = '00000000-0000-4000-8000-0000000073d1';
const DOC_Y = '00000000-0000-4000-8000-0000000073d2';
const DOC_Z = '00000000-0000-4000-8000-0000000073d3';
const CHUNK_X = '00000000-0000-4000-8000-0000000073e1';
const CHUNK_Y = '00000000-0000-4000-8000-0000000073e2';
const CHUNK_Z = '00000000-0000-4000-8000-0000000073e3';
const TEXT_X = 'Synthetic test-split sentence about the sample widget.';
const TEXT_Y = 'Synthetic dev-split sentence about the sample gadget.';
const TEXT_Z = 'Synthetic unsplit sentence about the sample gizmo.';

let db: PGlite;
const calls: string[] = [];
const admin = () => pgliteClient(db, { role: 'service_role', label: 'admin', calls }) as never;

interface Ids {
  training: string;
  trainingCapped: string;
  trainingTest: string;
  trainingDev: string;
  trainingUnsplit: string;
  trainingOpen: string;
  trainingOtherTenant: string;
  goldenTest: string;
  goldenDev: string;
  goldenUnsplit: string;
  dictOne: string;
  dictTwo: string;
}
let ids: Ids;

function span(chunkId: string, documentId: string, quote: string) {
  return { chunk_id: chunkId, document_id: documentId, document_name: 'synthetic.md', section: 'Part one > Detail', quote };
}

function label(evidence: unknown[], triage: string[], extra: Record<string, unknown> = {}) {
  return {
    answerable: true,
    category: 'general',
    language: 'en',
    expected_answer: 'A synthetic answer.',
    evidence,
    triage,
    pii_checked: triage.includes('golden'),
    ...extra,
  };
}

async function labelled(
  tenant: string,
  candidates: unknown[],
  itemLabel: Record<string, unknown>,
  options: { status?: string; split?: string | null; group?: string | null; occurrences?: number } = {},
): Promise<string> {
  const id = await insertReviewItem(db, tenant, candidates);
  await db.query(
    'UPDATE rag_review_items SET status = $2, triage = $3, label = $4::jsonb, labelled_at = now(), split = $5, split_group = $6, occurrences = $7 WHERE id = $1',
    [
      id,
      options.status ?? 'labelled',
      itemLabel.triage as string[],
      JSON.stringify(itemLabel),
      options.split ?? null,
      options.group ?? null,
      options.occurrences ?? 1,
    ],
  );
  return id;
}

beforeAll(async () => {
  ({ db } = await createReviewFixture());
  for (const [id, name] of [
    [DOC_X, 'x.md'],
    [DOC_Y, 'y.md'],
    [DOC_Z, 'z.md'],
  ]) {
    await db.query('INSERT INTO documents (id, filename, content, user_id) VALUES ($1, $2, $3, $4)', [id, name, 'body', OWNER_A]);
  }
  for (const [id, doc, text] of [
    [CHUNK_X, DOC_X, TEXT_X],
    [CHUNK_Y, DOC_Y, TEXT_Y],
    [CHUNK_Z, DOC_Z, TEXT_Z],
  ]) {
    await db.query("INSERT INTO document_chunks (id, document_id, content, section_path) VALUES ($1, $2, $3, ARRAY['Part one'])", [id, doc, text]);
  }

  const training = await labelled(
    TENANT_A,
    [
      candidate(MANY_A_CHUNKS[0], DOC_A_MANY, 1),
      candidate(CHUNK_A_ZH, DOC_A, 2),
      candidate(MANY_A_CHUNKS[1], DOC_A_MANY, 3),
      candidate(CHUNK_A, DOC_A, 4),
      candidate(MANY_A_CHUNKS[2], DOC_A_MANY, 5),
      candidate(MANY_A_CHUNKS[3], DOC_A_MANY, 6),
    ],
    label([span(CHUNK_A, DOC_A, 'the sample component restarts')], ['training'], { not_relevant_chunk_ids: [MANY_A_CHUNKS[2]] }),
  );
  const trainingCapped = await labelled(
    TENANT_A,
    [...MANY_A_CHUNKS.slice(4, 19).map((chunkId, index) => candidate(chunkId, DOC_A_MANY, index + 1)), candidate(CHUNK_A, DOC_A, 16)],
    label([span(CHUNK_A, DOC_A, 'restarts every night')], ['training'], { not_relevant_chunk_ids: [MANY_A_CHUNKS[18]] }),
  );
  const goldenTest = await labelled(TENANT_A, [candidate(CHUNK_X, DOC_X, 1)], label([span(CHUNK_X, DOC_X, 'test-split sentence')], ['golden']), {
    status: 'exported',
    split: 'test',
    group: 'group-x',
  });
  const goldenDev = await labelled(TENANT_A, [candidate(CHUNK_Y, DOC_Y, 1)], label([span(CHUNK_Y, DOC_Y, 'dev-split sentence')], ['golden']), {
    status: 'exported',
    split: 'dev',
    group: 'group-y',
  });
  const goldenUnsplit = await labelled(
    TENANT_A,
    [candidate(CHUNK_Z, DOC_Z, 1)],
    label(
      [
        span(CHUNK_Z, DOC_Z, 'unsplit sentence'),
        span(MANY_A_CHUNKS[30], DOC_A_MANY, 'this quote is not in the chunk'),
        span(CHUNK_A_QUARANTINED, DOC_A_QUARANTINED, 'quarantined sentence'),
        span(CHUNK_B, DOC_B, 'private sentence'),
      ],
      ['golden', 'training'],
      { paraphrased_question: 'A paraphrased synthetic question?' },
    ),
  );
  const trainingTest = await labelled(TENANT_A, [candidate(CHUNK_X, DOC_X, 1)], label([span(CHUNK_X, DOC_X, 'sample widget')], ['training']));
  const trainingDev = await labelled(TENANT_A, [candidate(CHUNK_Y, DOC_Y, 1)], label([span(CHUNK_Y, DOC_Y, 'sample gadget')], ['training']));
  const trainingUnsplit = await labelled(TENANT_A, [candidate(CHUNK_Z, DOC_Z, 1)], label([span(CHUNK_Z, DOC_Z, 'sample gizmo')], ['training']));
  const trainingOpen = await labelled(TENANT_A, [candidate(CHUNK_A, DOC_A, 1)], label([span(CHUNK_A, DOC_A, 'restarts every night')], ['training']), {
    status: 'open',
  });
  const trainingOtherTenant = await labelled(TENANT_B, [candidate(CHUNK_B, DOC_B, 1)], label([span(CHUNK_B, DOC_B, 'private sentence')], ['training', 'golden', 'dictionary'], {
    dictionary_terms: [{ observed_term: 'cfg', canonical_term: 'configuration', relation: 'abbreviation' }],
  }));
  const dictTerms = [
    { observed_term: 'cfg', canonical_term: 'configuration', relation: 'abbreviation' },
    { observed_term: 'riavvio', canonical_term: 'restart', relation: 'translation', canonical_language: 'en' },
  ];
  const dictOne = await labelled(TENANT_A, [], { ...label([], ['dictionary'], { dictionary_terms: dictTerms }), answerable: false, category: 'no_answer', expected_answer: null }, {
    occurrences: 3,
  });
  const dictTwo = await labelled(TENANT_A, [], { ...label([], ['dictionary', 'kb_gap'], { dictionary_terms: [dictTerms[0]] }), answerable: false, category: 'no_answer', expected_answer: null }, {
    occurrences: 2,
  });
  ids = {
    training,
    trainingCapped,
    trainingTest,
    trainingDev,
    trainingUnsplit,
    trainingOpen,
    trainingOtherTenant,
    goldenTest,
    goldenDev,
    goldenUnsplit,
    dictOne,
    dictTwo,
  };
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function assertMinimal(lines: unknown[]) {
  const text = JSON.stringify(lines);
  for (const secret of [TEXT_B, 'user_id', 'chat_id', 'trace_id', 'retrieval_log_id']) expect(text).not.toContain(secret);
}

describe('exportTraining (D-17)', () => {
  it('emits one valid pair per labelled training item of the tenant only', async () => {
    const pairs = await exportTraining(admin(), TENANT_A);
    for (const pair of pairs) expect(TrainingPairSchema.safeParse(pair).success).toBe(true);
    const itemIds = pairs.map((pair) => pair.review_item_id).sort();
    expect(itemIds).toEqual([ids.training, ids.trainingCapped, ids.trainingTest, ids.trainingDev, ids.trainingUnsplit, ids.goldenUnsplit].sort());
    expect(itemIds).not.toContain(ids.trainingOpen);
    expect(itemIds).not.toContain(ids.trainingOtherTenant);
    expect(pairs.every((pair) => pair.tenant_key === TENANT_A && pair.source === 'production_feedback')).toBe(true);
    assertMinimal(pairs);
    const text = JSON.stringify(pairs);
    expect(text).not.toContain(TEXT_A);
    expect(text).not.toContain('"text"');
    expect(text).not.toContain('content');
  });

  it('puts confirmed negatives first, then uncited candidates above the lowest positive, other documents first', async () => {
    const pair = (await exportTraining(admin(), TENANT_A)).find((entry) => entry.review_item_id === ids.training)!;
    expect(pair.positive).toEqual({ chunk_id: CHUNK_A, document_id: DOC_A, quote: 'the sample component restarts' });
    expect(pair.hard_negatives!.map((negative) => [negative.chunk_id, negative.confirmed])).toEqual([
      [MANY_A_CHUNKS[2], true],
      [MANY_A_CHUNKS[0], false],
      [MANY_A_CHUNKS[1], false],
      [CHUNK_A_ZH, false],
    ]);
    expect(pair.hard_negatives![0]).toMatchObject({ document_id: DOC_A_MANY, rank: 5, score: 0.5 });
    expect(pair.query_masked).toBe('A synthetic question');
    expect(pair.language).toBe('en');
  });

  it('caps hard negatives at 10 and every confirmed negative comes from not_relevant_chunk_ids', async () => {
    const pairs = await exportTraining(admin(), TENANT_A);
    const capped = pairs.find((entry) => entry.review_item_id === ids.trainingCapped)!;
    expect(capped.hard_negatives).toHaveLength(10);
    expect(capped.hard_negatives![0]).toMatchObject({ chunk_id: MANY_A_CHUNKS[18], confirmed: true });
    expect(capped.hard_negatives!.slice(1).map((negative) => negative.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const { rows } = await db.query<{ id: string; label: { not_relevant_chunk_ids?: string[] } }>('SELECT id::text, label FROM rag_review_items');
    const notRelevant = new Map(rows.map((row) => [row.id, new Set(row.label?.not_relevant_chunk_ids ?? [])]));
    for (const entry of pairs) {
      for (const negative of entry.hard_negatives ?? []) {
        if (negative.confirmed) expect(notRelevant.get(entry.review_item_id)!.has(negative.chunk_id)).toBe(true);
      }
      expect((entry.hard_negatives ?? []).some((negative) => negative.chunk_id === entry.positive.chunk_id)).toBe(false);
    }
  });

  it('marks held_out when the positive document is evidence of a test-split or unsplit golden item, train for dev', async () => {
    const pairs = await exportTraining(admin(), TENANT_A);
    const split = (id: string) => pairs.find((entry) => entry.review_item_id === id)!;
    expect(split(ids.trainingTest).split).toBe('held_out');
    expect(split(ids.trainingTest).document_group).toBe('group-x');
    expect(split(ids.trainingDev).split).toBe('train');
    expect(split(ids.trainingUnsplit).split).toBe('held_out');
    expect(split(ids.goldenUnsplit).split).toBe('held_out');
    expect(split(ids.training).split).toBe('train');
    expect(split(ids.training).document_group).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leakage guard: no document used by a test-split golden item is the positive of a train pair', async () => {
    const pairs = await exportTraining(admin(), TENANT_A);
    const testDocs = new Set<string>();
    const { rows } = await db.query<{ label: { evidence?: Array<{ document_id: string }> } }>(
      "SELECT label FROM rag_review_items WHERE tenant_key = $1 AND 'golden' = ANY(triage) AND (split = 'test' OR split IS NULL)",
      [TENANT_A],
    );
    for (const row of rows) for (const evidence of row.label.evidence ?? []) testDocs.add(evidence.document_id);
    expect(testDocs.has(DOC_X)).toBe(true);
    for (const pair of pairs.filter((entry) => entry.split === 'train')) expect(testDocs.has(pair.positive.document_id)).toBe(false);
  });
});

describe('exportDictionary (D-17)', () => {
  it('aggregates terms by language, observed term, canonical term and relation for the tenant only', async () => {
    const candidates = await exportDictionary(admin(), TENANT_A);
    for (const entry of candidates) expect(DictionaryCandidateSchema.safeParse(entry).success).toBe(true);
    const abbreviation = candidates.find((entry) => entry.relation === 'abbreviation')!;
    expect(abbreviation).toMatchObject({ tenant_key: TENANT_A, language: 'en', observed_term: 'cfg', canonical_term: 'configuration', occurrences: 5 });
    expect([...abbreviation.example_review_item_ids].sort()).toEqual([ids.dictOne, ids.dictTwo].sort());
    const translation = candidates.find((entry) => entry.relation === 'translation')!;
    expect(translation).toMatchObject({ observed_term: 'riavvio', canonical_term: 'restart', canonical_language: 'en', occurrences: 3 });
    expect(translation.example_review_item_ids).toEqual([ids.dictOne]);
    expect(candidates).toHaveLength(2);
    assertMinimal(candidates);
    expect(JSON.stringify(candidates)).not.toContain(ids.trainingOtherTenant);
  });
});

describe('exportGolden (D-20)', () => {
  it('returns labelled golden items of the tenant with current chunk text re-read under that tenant', async () => {
    const lines = await exportGolden(admin(), TENANT_A);
    for (const line of lines) expect(GoldenExportLineSchema.safeParse(line).success).toBe(true);
    expect(lines.map((line) => line.id)).toEqual([ids.goldenUnsplit]);
    const [line] = lines;
    expect(line.query_masked).toBe('A synthetic question');
    expect(line.label.paraphrased_question).toBe('A paraphrased synthetic question?');
    expect(line.evidence.map((entry) => [entry.chunk_id, entry.quote_verified, entry.chunk_text])).toEqual([
      [CHUNK_Z, true, TEXT_Z],
      [MANY_A_CHUNKS[30], false, 'Tenant alpha filler sentence number 30.'],
      [CHUNK_A_QUARANTINED, false, null],
      [CHUNK_B, false, null],
    ]);
    const text = JSON.stringify(lines);
    expect(text).not.toContain(TEXT_A_QUARANTINED);
    assertMinimal(lines);
    expect(Object.keys(line)).not.toContain('labelled_by');
  });

  it('never returns another tenant golden item', async () => {
    const lines = await exportGolden(admin(), TENANT_B);
    expect(lines.map((line) => line.id)).toEqual([ids.trainingOtherTenant]);
    expect(lines[0].evidence[0]).toMatchObject({ chunk_id: CHUNK_B, quote_verified: true, chunk_text: TEXT_B });
  });
});

describe('markExported (D-20, D-21)', () => {
  it('freezes split on the tenant items, reports a changed split as a conflict and ignores foreign or unlabelled items', async () => {
    const first = await markExported(admin(), TENANT_A, [
      { id: ids.goldenUnsplit, split: 'test', split_group: 'group-z' },
      { id: ids.trainingOtherTenant, split: 'dev', split_group: 'group-b' },
      { id: ids.trainingOpen },
    ]);
    expect(first.marked).toEqual([{ id: ids.goldenUnsplit, split: 'test', split_group: 'group-z' }]);
    expect(first.conflicts).toEqual([]);
    expect(first.ignored).toEqual([
      { id: ids.trainingOtherTenant, reason: 'not_found' },
      { id: ids.trainingOpen, reason: 'not_labelled' },
    ]);
    const other = await db.query<{ status: string; split: string | null }>('SELECT status, split FROM rag_review_items WHERE id = $1', [ids.trainingOtherTenant]);
    expect(other.rows[0]).toEqual({ status: 'labelled', split: null });

    const again = await markExported(admin(), TENANT_A, [{ id: ids.goldenUnsplit, split: 'test', split_group: 'group-z' }]);
    expect(again.marked).toHaveLength(1);
    const changed = await markExported(admin(), TENANT_A, [
      { id: ids.goldenUnsplit, split: 'dev', split_group: 'group-z' },
      { id: ids.dictOne },
    ]);
    expect(changed.conflicts).toEqual([{ id: ids.goldenUnsplit, reason: 'split_immutable' }]);
    expect(changed.marked).toEqual([{ id: ids.dictOne, split: null, split_group: null }]);
    const stored = await db.query<{ status: string; split: string; split_group: string }>(
      'SELECT status, split, split_group FROM rag_review_items WHERE id = $1',
      [ids.goldenUnsplit],
    );
    expect(stored.rows[0]).toEqual({ status: 'exported', split: 'test', split_group: 'group-z' });
  });
});
