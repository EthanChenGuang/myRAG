import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RefusalThresholds } from '@/lib/rag-eval/contracts.generated';
import { loadRagConfig, resetRagConfigForTests, type RagEnvInput } from '@/lib/rag/config';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { RERANK_TEXT_VERSION } from '@/lib/rag/rerank/types';
import { main as pendingCli } from '@/lib/rag/refusal/pending-cli';
import { PENDING_KEY_CATEGORIES, pendingCells, proposedPendingCells } from '@/lib/rag/refusal/pending';

type Cell = NonNullable<RefusalThresholds['cells']>[number];
type Language = 'zh' | 'en' | 'it';

const HASH = 'b'.repeat(64);
const RUNNING_EMBEDDING = 'embed-model-a';

function cell(provider: string, model: string, language: Language, over: Partial<Cell> = {}): Cell {
  const pairing = over.pairing ?? 'same';
  return {
    config_hash: HASH,
    dev: { answerable_count: 27, correct_refusal_rate: 0.4, false_refusal_rate: 0, false_refusal_rate_upper_bound: 0.1, no_answer_count: 7 },
    holdout: { answerable_count: 7, correct_refusal_rate: 0.5, false_refusal_rate: 0.1, false_refusal_rate_upper_bound: 0.5, no_answer_count: 2 },
    holdout_evaluations: 1,
    key: `${provider}|${model}|${language}|${pairing}`,
    model,
    pairing,
    provider,
    query_language: language,
    recorded_at: '2026-11-20',
    rerank_text_version: RERANK_TEXT_VERSION,
    source: 'live',
    status: 'calibrated',
    threshold: 0.3,
    tokenizer_version: LEXICAL_VERSION,
    ...over,
  };
}

const thresholds = (cells: Cell[]): RefusalThresholds => ({ cells, config_hash: HASH, schema_version: 1 });
const config = (env: RagEnvInput) => loadRagConfig({ RAG_PIPELINE: 'v2', ...env });
const running = (env: RagEnvInput, embeddingModel = RUNNING_EMBEDDING) => ({ config: config(env), embeddingModel });

const COHERE = { RAG_RERANKER: 'cohere' };
const VOYAGE = { RAG_RERANKER: 'voyage' };

beforeEach(() => resetRagConfigForTests());
afterEach(() => resetRagConfigForTests());

describe('PENDING_KEY_CATEGORIES', () => {
  it('names the reranker, embedding-model and tokenizer settings', () => {
    expect(PENDING_KEY_CATEGORIES.reranker_model).toContain('RAG_RERANKER');
    expect(PENDING_KEY_CATEGORIES.embedding_model).toContain('OPENAI_EMBEDDING_MODEL');
    expect(PENDING_KEY_CATEGORIES.tokenizer).toEqual(['RAG_LEXICAL_DICTIONARY', 'RAG_LEXICAL_STEM_IT', 'RAG_LEXICAL_QUANTITY']);
  });
});

describe('pendingCells', () => {
  const cohere = cell('cohere', 'rerank-v5.0-pro', 'en', { embedding_model: RUNNING_EMBEDDING });

  it('marks calibrated cells of another reranker when a reranker change is dated the same day as the cell', () => {
    const marks = pendingCells({
      thresholds: thresholds([cohere]),
      changes: [{ created_at: '2026-11-20T08:00:00Z', changed_keys: ['RAG_RERANKER', 'RAG_CITATIONS'] }],
      alerts: [],
      running: running(VOYAGE),
    });
    expect(marks.get(cohere.key)).toEqual({ reason: 'reranker_model', since: '2026-11-20', changed_keys: ['RAG_RERANKER'] });
  });

  it('marks nothing for a reranker change dated the day before the cell', () => {
    const marks = pendingCells({
      thresholds: thresholds([cohere]),
      changes: [{ created_at: '2026-11-19T23:00:00Z', changed_keys: ['RAG_RERANKER'] }],
      alerts: [],
      running: running(VOYAGE),
    });
    expect(marks.size).toBe(0);
  });

  it('does not mark a cell that matches the running reranker', () => {
    const marks = pendingCells({
      thresholds: thresholds([cohere]),
      changes: [{ created_at: '2026-11-21T00:00:00Z', changed_keys: ['RAG_RERANKER'] }],
      alerts: [],
      running: running(COHERE),
    });
    expect(marks.size).toBe(0);
  });

  it('never marks a cell that is not calibrated', () => {
    const uncalibrated = cell('cohere', 'rerank-v5.0-pro', 'zh', { status: 'uncalibrated', threshold: null });
    const marks = pendingCells({
      thresholds: thresholds([uncalibrated]),
      changes: [{ created_at: '2026-11-21', changed_keys: ['RAG_RERANKER'] }],
      alerts: [{ id: 'alert-1', language: 'zh', day: '2026-11-22' }],
      running: running(VOYAGE),
    });
    expect(marks.size).toBe(0);
  });

  it('marks cells of another embedding model and cells without the field after an embedding-model change', () => {
    const other = cell('cohere', 'rerank-v5.0-pro', 'zh', { embedding_model: 'embed-model-b' });
    const unset = cell('cohere', 'rerank-v5.0-pro', 'it');
    const marks = pendingCells({
      thresholds: thresholds([cohere, other, unset]),
      changes: [{ created_at: '2026-11-24T10:00:00Z', changed_keys: ['OPENAI_EMBEDDING_MODEL'] }],
      alerts: [],
      running: running(COHERE),
    });
    expect(marks.has(cohere.key)).toBe(false);
    expect(marks.get(other.key)).toEqual({ reason: 'embedding_model', since: '2026-11-24', changed_keys: ['OPENAI_EMBEDDING_MODEL'] });
    expect(marks.get(unset.key)?.reason).toBe('embedding_model');
  });

  it('marks cells of another tokenizer version after a tokenizer change', () => {
    const marks = pendingCells({
      thresholds: thresholds([cohere]),
      changes: [{ created_at: '2026-11-22', changed_keys: ['RAG_LEXICAL_STEM_IT'] }],
      alerts: [],
      running: running({ ...COHERE, RAG_LEXICAL_STEM_IT: 'true' }),
    });
    expect(marks.get(cohere.key)).toEqual({ reason: 'tokenizer', since: '2026-11-22', changed_keys: ['RAG_LEXICAL_STEM_IT'] });
  });

  it('ignores change records of unrelated settings', () => {
    const marks = pendingCells({
      thresholds: thresholds([cohere]),
      changes: [{ created_at: '2026-11-22', changed_keys: ['RAG_CITATIONS'] }],
      alerts: [],
      running: running(VOYAGE),
    });
    expect(marks.size).toBe(0);
  });

  it('marks the cells of an open top_score_psi alert language with score_shift and the alert id', () => {
    const zh = cell('cohere', 'rerank-v5.0-pro', 'zh', { embedding_model: RUNNING_EMBEDDING });
    const marks = pendingCells({
      thresholds: thresholds([cohere, zh]),
      changes: [],
      alerts: [{ id: 'alert-zh', language: 'zh', day: '2026-11-23' }],
      running: running(COHERE),
    });
    expect(marks.get(zh.key)).toEqual({ reason: 'score_shift', since: '2026-11-23', alert_id: 'alert-zh' });
    expect(marks.has(cohere.key)).toBe(false);
  });

  it('marks every language for a tenant-wide alert, and a change reason wins over a score shift', () => {
    const zh = cell('cohere', 'rerank-v5.0-pro', 'zh', { embedding_model: RUNNING_EMBEDDING });
    const marks = pendingCells({
      thresholds: thresholds([cohere, zh]),
      changes: [{ created_at: '2026-11-21', changed_keys: ['RAG_RERANKER'] }],
      alerts: [{ id: 'alert-all', language: 'all', day: '2026-11-23' }],
      running: running(VOYAGE),
    });
    expect(marks.get(cohere.key)?.reason).toBe('reranker_model');
    expect(marks.get(zh.key)?.reason).toBe('reranker_model');
  });
});

describe('proposedPendingCells', () => {
  const live = cell('cohere', 'rerank-v5.0-pro', 'en');
  const fixture = cell('cohere', 'rerank-v5.0-pro', 'zh', { source: 'fixture' });
  const file = thresholds([live, fixture]);

  it('lists cells that apply under the current values and not under a switched reranker', () => {
    expect(proposedPendingCells(file, COHERE, VOYAGE)).toEqual([live.key]);
  });

  it('lists cells after an embedding-model change when the cell names the current model', () => {
    const named = cell('cohere', 'rerank-v5.0-pro', 'it', { embedding_model: 'embed-model-a' });
    const result = proposedPendingCells(
      thresholds([named]),
      { ...COHERE, OPENAI_EMBEDDING_MODEL: 'embed-model-a' },
      { ...COHERE, OPENAI_EMBEDDING_MODEL: 'embed-model-b' },
    );
    expect(result).toEqual([named.key]);
  });

  it('lists cells after a tokenizer change', () => {
    expect(proposedPendingCells(file, COHERE, { ...COHERE, RAG_LEXICAL_DICTIONARY: 'true' })).toEqual([live.key]);
  });

  it('returns an empty list when nothing relevant changed', () => {
    expect(proposedPendingCells(file, COHERE, { ...COHERE, RAG_CITATIONS: 'true' })).toEqual([]);
  });
});

describe('pending-cli', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'refusal-pending-'));
  const write = (name: string, data: unknown) => {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify(data));
    return file;
  };
  const SECRET = 'placeholder-secret-value-123';
  const currentFile = write('current.json', { RAG_RERANKER: 'cohere', COHERE_API_KEY: SECRET, OPENAI_EMBEDDING_MODEL: 'embed-model-a' });
  const proposedFile = write('proposed.json', { RAG_RERANKER: 'voyage', COHERE_API_KEY: SECRET, OPENAI_EMBEDDING_MODEL: 'embed-model-a' });
  const thresholdsFile = write('thresholds.json', thresholds([cell('cohere', 'rerank-v5.0-pro', 'en')]));

  function run(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = pendingCli(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out, err };
  }

  it('prints the uncalibrated cell keys and exits 0', () => {
    const result = run(['--current', currentFile, '--proposed', proposedFile, '--thresholds', thresholdsFile]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join('\n'))).toEqual({ uncalibrated_cells: ['cohere|rerank-v5.0-pro|en|same'] });
  });

  it('prints no value from either file', () => {
    const invalid = write('invalid.json', { RAG_RERANKER: 'not-a-reranker-value', COHERE_API_KEY: SECRET });
    const result = run(['--current', currentFile, '--proposed', invalid, '--thresholds', thresholdsFile]);
    const printed = [...result.out, ...result.err].join('\n');
    expect(result.code).toBe(0);
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain('not-a-reranker-value');
    expect(printed).not.toContain('embed-model-a');
  });

  it('uses the committed thresholds file by default', () => {
    const result = run(['--current', currentFile, '--proposed', proposedFile]);
    expect(result.code).toBe(0);
    expect(Object.keys(JSON.parse(result.out.join('\n')))).toEqual(['uncalibrated_cells']);
  });

  it('exits 2 when an argument is missing or a file is not an env object', () => {
    expect(run(['--current', currentFile]).code).toBe(2);
    expect(run(['--proposed', proposedFile]).code).toBe(2);
    expect(run(['--current', currentFile, '--proposed', write('array.json', ['x'])]).code).toBe(2);
    const bad = run(['--current', currentFile, '--proposed', write('number.json', { COHERE_API_KEY: 7 })]);
    expect(bad.code).toBe(2);
    expect(bad.err.join('\n')).not.toContain(SECRET);
  });
});
