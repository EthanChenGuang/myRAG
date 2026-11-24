import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ingest } from '@/lib/rag/ingest';
import { EXTRACTORS, pickDocDate, runChunkExtractors } from '@/lib/rag/ingest/extractors';
import { mintScope } from '@/lib/rag/tenant/scope';
import { extractEnhancedMetadata } from '@/lib/temporal-metadata-extractor';
import { callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps, type RecordedRpc } from '../../helpers/ingest-fakes';

const scope = mintScope('single', null, null);
const CORPUS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../eval/fixtures/corpus');

const TEMPORAL_KEYS = ['temporal_entities', 'temporal_density', 'has_temporal_data'];
const FINANCIAL_KEYS = ['financial_entities', 'numerical_density', 'has_financial_data', 'is_high_value_chunk'];
const GENERIC_KEYS = ['section_type', 'key_terms', 'chunk_semantic_type'];

/** The keys storeDocument builds from extractEnhancedMetadata, restated here to pin parity. */
function legacyKeys(text: string): Record<string, unknown> {
  const enhancedMetadata = extractEnhancedMetadata(text);
  return {
    temporal_entities: enhancedMetadata.temporal_entities,
    financial_entities: enhancedMetadata.financial_entities,
    section_type: enhancedMetadata.section_type,
    key_terms: enhancedMetadata.key_terms,
    numerical_density: enhancedMetadata.numerical_density,
    temporal_density: enhancedMetadata.temporal_density,
    chunk_semantic_type: enhancedMetadata.chunk_semantic_type,
    has_temporal_data: enhancedMetadata.temporal_entities.length > 0,
    has_financial_data: enhancedMetadata.financial_entities.length > 0,
    is_high_value_chunk:
      enhancedMetadata.chunk_semantic_type === 'financial_data' || enhancedMetadata.chunk_semantic_type === 'mixed',
  };
}

function corpusChunkTexts(): string[] {
  const texts: string[] = [];
  for (const language of fs.readdirSync(CORPUS_DIR)) {
    const dir = path.join(CORPUS_DIR, language);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const body = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const part of body.split(/\n{2,}/)) {
        const text = part.trim();
        if (text.length >= 20) texts.push(text);
      }
    }
  }
  return texts;
}

function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]));
}

describe('chunk extractors', () => {
  test('the registry holds dates and financial only; the invoice extractor belongs to a later plan', () => {
    expect(Object.keys(EXTRACTORS).sort()).toEqual(['dates', 'financial']);
  });

  test('dates and financial write exactly the keys storeDocument computes for every fixture corpus chunk text', () => {
    const texts = corpusChunkTexts();
    expect(texts.length).toBeGreaterThanOrEqual(20);
    for (const text of texts) {
      expect(runChunkExtractors(['dates', 'financial'], { content: text }).metadata).toEqual(legacyKeys(text));
    }
  });

  test('dates alone writes the temporal and generic keys and none of the financial ones', () => {
    const text = 'Revenue grew 12% to $5.2M in Q3 2024, reported 2024-10-30.';
    const { metadata } = runChunkExtractors(['dates'], { content: text });
    const legacy = legacyKeys(text);
    expect(Object.keys(metadata).sort()).toEqual([...TEMPORAL_KEYS, ...GENERIC_KEYS].sort());
    expect(metadata).toEqual(pick(legacy, [...TEMPORAL_KEYS, ...GENERIC_KEYS]));
    expect(metadata.has_temporal_data).toBe(true);
  });

  test('financial alone writes the financial and generic keys and none of the temporal ones', () => {
    const text = 'Revenue grew 12% to $5.2M in Q3 2024, reported 2024-10-30.';
    const { metadata, dateCandidates } = runChunkExtractors(['financial'], { content: text });
    const legacy = legacyKeys(text);
    expect(Object.keys(metadata).sort()).toEqual([...FINANCIAL_KEYS, ...GENERIC_KEYS].sort());
    expect(metadata).toEqual(pick(legacy, [...FINANCIAL_KEYS, ...GENERIC_KEYS]));
    expect(metadata.has_financial_data).toBe(true);
    expect(dateCandidates).toEqual([]);
  });

  test('a profile that lists neither dates nor financial still gets the generic keys on every chunk', () => {
    const { metadata } = runChunkExtractors(['urls'], { content: 'Install the unit on a flat wall.' });
    expect(Object.keys(metadata).sort()).toEqual([...GENERIC_KEYS].sort());
  });

  test('dates on a Chinese reporting period yields temporal entities and the start date as the doc_date candidate', () => {
    const { metadata, dateCandidates } = runChunkExtractors(['dates'], { content: '报告期为2025年3月15日至2025年6月30日' });
    expect(metadata.has_temporal_data).toBe(true);
    expect((metadata.temporal_entities as unknown[]).length).toBeGreaterThan(0);
    expect(dateCandidates.map((candidate) => candidate.iso)).toEqual(['2025-03-15', '2025-06-30']);
  });

  test('dates on text without any date yields has_temporal_data false and no candidate', () => {
    const { metadata, dateCandidates } = runChunkExtractors(['dates'], { content: 'The night crew scans every pallet at the dock.' });
    expect(metadata.has_temporal_data).toBe(false);
    expect(metadata.temporal_entities).toEqual([]);
    expect(dateCandidates).toEqual([]);
  });

  test('runChunkExtractors(["dates","urls"]) runs dates only and never throws on empty text', () => {
    const { metadata } = runChunkExtractors(['dates', 'urls'], { content: 'Signed 2024-01-09. See https://docs.example.com/a' });
    expect(Object.keys(metadata)).toEqual(expect.arrayContaining(TEMPORAL_KEYS));
    expect(Object.keys(metadata)).not.toContain('urls');
    expect(Object.keys(metadata)).not.toContain('has_urls');
    for (const names of [['dates', 'urls'], ['dates', 'financial'], []]) {
      expect(() => runChunkExtractors(names, { content: '' })).not.toThrow();
    }
    expect(runChunkExtractors(['dates'], { content: '' }).dateCandidates).toEqual([]);
  });

  test('full dates are read from ISO, CJK, English and Italian forms and unambiguous slash dates; ambiguous or impossible ones are dropped', () => {
    const isos = (content: string) => runChunkExtractors(['dates'], { content }).dateCandidates.map((candidate) => candidate.iso);
    expect(isos('Effective 2024-02-29.')).toEqual(['2024-02-29']);
    expect(isos('Effective 2024/7/4.')).toEqual(['2024-07-04']);
    expect(isos('签订于2023年12月1日。')).toEqual(['2023-12-01']);
    expect(isos('Issued on March 15, 2025 in Boston.')).toEqual(['2025-03-15']);
    expect(isos('Issued on 15 March 2025.')).toEqual(['2025-03-15']);
    expect(isos('Emessa il 1° marzo 2025.')).toEqual(['2025-03-01']);
    expect(isos('Data 31/01/2025.')).toEqual(['2025-01-31']);
    expect(isos('Date 01/31/2025.')).toEqual(['2025-01-31']);
    expect(isos('Date 03/04/2025.')).toEqual([]);
    expect(isos('Date 2025-02-30 and 2025-13-01.')).toEqual([]);
    expect(isos('Only the year 2025 and Q3 2024.')).toEqual([]);
  });

  test('pickDocDate takes the highest confidence and breaks ties by chunk order then position', () => {
    expect(pickDocDate([])).toBeNull();
    expect(
      pickDocDate([
        { iso: '2024-05-01', confidence: 0.85, position: 0, chunkIndex: 0 },
        { iso: '2025-03-15', confidence: 0.95, position: 40, chunkIndex: 3 },
      ]),
    ).toBe('2025-03-15');
    expect(
      pickDocDate([
        { iso: '2026-01-01', confidence: 0.95, position: 5, chunkIndex: 2 },
        { iso: '2025-03-15', confidence: 0.95, position: 90, chunkIndex: 1 },
        { iso: '2025-03-16', confidence: 0.95, position: 10, chunkIndex: 1 },
      ]),
    ).toBe('2025-03-16');
  });
});

describe('extract stage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallIngestDeps();
    vi.restoreAllMocks();
  });

  const REPORT = [
    '# Quarterly report',
    '',
    'Report date: 2024-10-30. Revenue grew 12% to $5.2M in Q3 2024 and net profit reached $1.1M.',
    '',
    '## Outlook',
    '',
    'Management expects the next period to close on 15 December 2024 with similar margins and costs.',
    '',
  ].join('\n');

  function upload(text: string, overrides: Record<string, unknown> = {}) {
    return ingest({
      scope,
      source: 'config_upload',
      sourceKey: 'root/doc.md',
      text,
      filename: 'doc.md',
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
      ...overrides,
    } as Parameters<typeof ingest>[0]);
  }

  function writtenChunks(calls: RecordedRpc[]): Array<Record<string, unknown>> {
    return callsOf(calls, 'rag_write_chunks').flatMap((call) => call.args.p_chunks as Array<Record<string, unknown>>);
  }

  function metadataOf(chunk: Record<string, unknown>): Record<string, unknown> {
    return chunk.metadata as Record<string, unknown>;
  }

  function docDateWrites(calls: RecordedRpc[]): unknown[] {
    return callsOf(calls, 'rag_set_document_fields')
      .map((call) => call.args.p_fields as Record<string, unknown>)
      .filter((fields) => 'doc_date' in fields)
      .map((fields) => fields.doc_date);
  }

  test('a general-profile document gets temporal metadata and a doc_date, and no financial keys', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await upload(REPORT);

    expect(result.status).toBe('ready');
    const chunks = writtenChunks(calls);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      const metadata = metadataOf(chunk);
      for (const key of [...TEMPORAL_KEYS, ...GENERIC_KEYS]) expect(metadata).toHaveProperty(key);
      for (const key of FINANCIAL_KEYS) expect(metadata).not.toHaveProperty(key);
      expect(metadata).toMatchObject({ has_urls: expect.any(Boolean) });
    }
    expect(docDateWrites(calls)).toEqual(['2024-10-30']);
  });

  test('a financial_report document also gets the financial keys with the values storeDocument computes', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await upload(REPORT, { docType: 'financial_report' });

    expect(result.status).toBe('ready');
    const chunks = writtenChunks(calls);
    for (const chunk of chunks) {
      const metadata = metadataOf(chunk);
      expect(pick(metadata, Object.keys(legacyKeys('')))).toEqual(legacyKeys(chunk.content as string));
    }
    expect(chunks.some((chunk) => metadataOf(chunk).has_financial_data === true)).toBe(true);
    expect(docDateWrites(calls)).toEqual(['2024-10-30']);
  });

  test('a product_technical document gets neither temporal nor financial keys, no doc_date, but the generic keys', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await upload(REPORT, { docType: 'product_technical' });

    expect(result.status).toBe('ready');
    for (const chunk of writtenChunks(calls)) {
      const metadata = metadataOf(chunk);
      for (const key of [...TEMPORAL_KEYS, ...FINANCIAL_KEYS]) expect(metadata).not.toHaveProperty(key);
      for (const key of GENERIC_KEYS) expect(metadata).toHaveProperty(key);
    }
    expect(docDateWrites(calls)).toEqual([]);
  });

  test('doc_date is written once through setFields and the stage writes none when the text holds no full date', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });
    await upload(REPORT);
    expect(docDateWrites(calls)).toHaveLength(1);

    const second = fakeIngestDb();
    installIngestDeps({ db: second.db });
    await upload('# Handbook\n\nThe night crew scans every pallet at the dock in 2024 and stages it for the morning team.\n');
    expect(docDateWrites(second.calls)).toEqual([]);
  });

  test('no extractor_unavailable warning remains for dates or financial; the invoice extractor stays pending', async () => {
    const { db } = fakeIngestDb();
    installIngestDeps({ db });

    const general = await upload(REPORT);
    const financial = await upload(REPORT, { docType: 'financial_report', sourceKey: 'root/report.md' });
    const invoice = await upload(REPORT, { docType: 'invoice_receipt', sourceKey: 'root/invoice.md' });

    expect(general.warnings).not.toContain('extractor_unavailable:dates');
    expect(financial.warnings).not.toContain('extractor_unavailable:dates');
    expect(financial.warnings).not.toContain('extractor_unavailable:financial');
    // Until 03-29 registers the invoice chunker, invoice_receipt stops at chunk (03-19 decision 4),
    // so extract never runs; 03-29 restores the extractor_unavailable:invoice assertion here.
    expect(invoice).toMatchObject({ status: 'failed', reason: 'chunker_unavailable' });
  });
});
