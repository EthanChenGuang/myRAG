import rawThresholds from '../../../../eval/config/refusal-thresholds.json';
import { RefusalThresholdsSchema, type RefusalThresholds } from '@/lib/rag-eval/contracts.generated';
import type { ThresholdCell, ThresholdCells } from './gate';

export type { ThresholdCells };

const loggedProblems = new Set<string>();

function problem(key: string, message: string, data: Record<string, unknown>): void {
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`[RAG Config] ${message}`, data);
}

function cellsFromFile(parsed: RefusalThresholds): ThresholdCells {
  const cells: ThresholdCells = new Map();
  for (const cell of parsed.cells ?? []) {
    cells.set(cell.key, {
      key: cell.key,
      provider: cell.provider,
      model: cell.model,
      query_language: cell.query_language,
      pairing: cell.pairing,
      threshold: cell.threshold ?? null,
      status: cell.status,
      source: cell.source,
      tokenizer_version: cell.tokenizer_version,
      rerank_text_version: cell.rerank_text_version,
    });
  }
  return cells;
}

export function loadThresholdsFromData(data: unknown): { cells: ThresholdCells; configHash: string | null } {
  const parsed = RefusalThresholdsSchema.safeParse(data);
  if (!parsed.success) {
    problem('refusal-thresholds-invalid', 'Invalid refusal-thresholds.json, refusal thresholds disabled', {});
    return { cells: new Map(), configHash: null };
  }
  return {
    cells: cellsFromFile(parsed.data),
    configHash: parsed.data.config_hash ?? null,
  };
}

let cached: ReturnType<typeof loadThresholdsFromData> | null = null;

export function loadThresholds(): { cells: ThresholdCells; configHash: string | null } {
  cached ??= loadThresholdsFromData(rawThresholds);
  return cached;
}