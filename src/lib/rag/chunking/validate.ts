export type ChunkingFinding = string;

export interface ChunkingValidationContext {
  maxChildTokens?: number;
  topK?: number;
  contextBudget?: number;
}

export interface ChunkingValidationResult {
  errors: ChunkingFinding[];
  warnings: ChunkingFinding[];
}

export async function validateChunkingProfile(_input: unknown, _context?: ChunkingValidationContext): Promise<ChunkingValidationResult> {
  return { errors: [], warnings: [] };
}
