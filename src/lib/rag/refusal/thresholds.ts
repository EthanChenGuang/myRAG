import rawThresholds from '../../../../eval/config/refusal-thresholds.json';
import { RefusalThresholdsSchema, type RefusalThresholds } from '@/lib/rag-eval/contracts.generated';
import { cellKey, type ThresholdCell, type ThresholdCells } from './gate';

export type { ThresholdCells };

/** The embedding model the app embeds queries with, as the OpenAI embedding readers resolve it (D-18). */
export function runningEmbeddingModel(source: Readonly<Record<string, string | undefined>> = process.env): string {
  return (source.OPENAI_EMBEDDING_MODEL ?? '').trim() || 'text-embedding-3-small';
}

const loggedProblems = new Set<string>();

function problem(key: string, message: string, data: Record<string, unknown>): void {
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`[RAG Config] ${message}`, data);
}

/** D-18: a cell recorded with another embedding model is skipped, so the gate takes its no-cell path; a cell without the field loads. */
function cellsFromFile(parsed: RefusalThresholds, embeddingModel: string): ThresholdCells {
  const cells: ThresholdCells = new Map();
  for (const cell of parsed.cells ?? []) {
    if (cell.embedding_model !== undefined && cell.embedding_model !== embeddingModel) continue;
    cells.set(cell.key, {
      key: cell.key,
      ...(cell.mode ? { mode: cell.mode } : {}),
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

/** The Pydantic rules JSON Schema cannot express: unique keys, key = dims (+ |mode), schema_version 2 exactly when a mode cell exists. */
function consistent(parsed: RefusalThresholds): boolean {
  const cells = parsed.cells ?? [];
  const keys = new Set(cells.map((cell) => cell.key));
  if (keys.size !== cells.length) return false;
  if (cells.some((cell) => cell.mode !== undefined) !== (parsed.schema_version === 2)) return false;
  return cells.every((cell) => cell.key === cellKey(cell.provider, cell.model, cell.query_language, cell.pairing, cell.mode));
}

/** A thresholds file that passes the generated schema and the cross-field rules, or null. */
export function parseThresholds(data: unknown): RefusalThresholds | null {
  const parsed = RefusalThresholdsSchema.safeParse(data);
  return parsed.success && consistent(parsed.data) ? parsed.data : null;
}

export function loadThresholdsFromData(
  data: unknown,
  embeddingModel: string = runningEmbeddingModel(),
): { cells: ThresholdCells; configHash: string | null } {
  const parsed = parseThresholds(data);
  if (!parsed) {
    problem('refusal-thresholds-invalid', 'Invalid refusal-thresholds.json, refusal thresholds disabled', {});
    return { cells: new Map(), configHash: null };
  }
  return {
    cells: cellsFromFile(parsed, embeddingModel),
    configHash: parsed.config_hash ?? null,
  };
}

let cached: ReturnType<typeof loadThresholdsFromData> | null = null;

export function loadThresholds(): { cells: ThresholdCells; configHash: string | null } {
  cached ??= loadThresholdsFromData(rawThresholds);
  return cached;
}