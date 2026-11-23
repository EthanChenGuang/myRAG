import { describe, expect, test } from 'vitest';
import { deriveStatus } from '@/lib/rag/pipeline';
import type { StageRecord, StageRunStatus } from '@/lib/rag/types';

function record(name: string, status: StageRunStatus): StageRecord {
  return {
    name,
    status,
    startedAt: 0,
    endedAt: 1,
    latency_ms: 1,
    candidates_in: null,
    candidates_out: null,
    rules: [],
  };
}

const CLEAN = [record('analyze', 'ok'), record('embed', 'ok'), record('search', 'ok'), record('legacy_rank', 'ok')];

describe('deriveStatus (D-05 as adjusted)', () => {
  test('clean run with candidates is ok', () => {
    expect(deriveStatus(CLEAN, 3)).toBe('ok');
  });

  test('clean run with zero candidates is empty', () => {
    expect(deriveStatus(CLEAN, 0)).toBe('empty');
  });

  test.each(['error', 'timeout', 'aborted'] as const)('a core stage that is %s gives error even with survivors', (status) => {
    const records = [record('analyze', 'ok'), record('embed', status)];
    expect(deriveStatus(records, 0)).toBe('error');
    expect(deriveStatus(records, 4)).toBe('error');
  });

  test('a skipped optional stage with zero candidates is degraded, not empty', () => {
    const records = [...CLEAN.slice(0, 3), record('legacy_rank', 'skipped')];
    expect(deriveStatus(records, 0)).toBe('degraded');
  });

  test('a skipped optional stage with candidates is degraded', () => {
    const records = [record('analyze', 'skipped'), record('embed', 'ok'), record('search', 'ok')];
    expect(deriveStatus(records, 5)).toBe('degraded');
  });

  test('a stage disabled by configuration never makes the result degraded', () => {
    const records = [...CLEAN.slice(0, 3), record('legacy_rank', 'disabled')];
    expect(deriveStatus(records, 2)).toBe('ok');
    expect(deriveStatus(records, 0)).toBe('empty');
  });

  test('error outranks degraded', () => {
    const records = [record('analyze', 'skipped'), record('embed', 'ok'), record('search', 'error')];
    expect(deriveStatus(records, 0)).toBe('error');
  });

  test('no records and no survivors is empty', () => {
    expect(deriveStatus([], 0)).toBe('empty');
  });
});
