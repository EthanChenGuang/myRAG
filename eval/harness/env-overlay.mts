export class OverlayError extends Error {
  readonly names: readonly string[] = [];
}

export const FIXTURE_PINNED_NAMES: readonly string[] = [];

export interface EnvOverlay {
  env: Record<string, string>;
  evaluated: string[];
  notEvaluated: Array<{ name: string; reason: string }>;
}

export function parseEnvOverlay(_raw: unknown, _ragAffecting?: ReadonlySet<string>): EnvOverlay {
  return { env: {}, evaluated: [], notEvaluated: [] };
}

export function loadEnvOverlay(_file: string): EnvOverlay {
  return { env: {}, evaluated: [], notEvaluated: [] };
}
