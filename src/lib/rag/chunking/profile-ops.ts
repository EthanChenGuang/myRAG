export class ChunkingActivationRefused extends Error {
  readonly reason: string;
  readonly detail: string;

  constructor(reason: string, detail: string) {
    super(`chunking_activation_refused:${reason}`);
    this.reason = reason;
    this.detail = detail;
  }
}

export class ChunkingInputError extends Error {}

export interface ChunkingOpOptions {
  signal?: AbortSignal;
}

export async function listChunkingProfiles(_options: ChunkingOpOptions = {}): Promise<Array<{ id: string; previousActiveId: string | null; childTokens: number }>> {
  return [];
}

export async function getChunkingCoverage(_options: ChunkingOpOptions = {}): Promise<Array<Record<string, unknown>>> {
  return [];
}

export async function createChunkingProfile(_input: unknown, _options: ChunkingOpOptions = {}): Promise<unknown> {
  return null;
}

export async function recordChunkingDecision(_decision: unknown, _options: ChunkingOpOptions = {}): Promise<unknown> {
  return null;
}

export async function activateChunkingProfile(_profileId: string, _options: ChunkingOpOptions & { docType?: string; actor?: string } = {}): Promise<unknown> {
  return null;
}

export async function rollbackChunkingProfile(_docType: string, _options: ChunkingOpOptions & { actor?: string } = {}): Promise<unknown> {
  return null;
}
