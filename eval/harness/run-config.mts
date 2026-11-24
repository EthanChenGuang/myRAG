import type { RetrievalOverrides } from '../../src/lib/rag-eval/contracts.generated.ts';

export class RunConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunConfigError';
  }
}

export interface RunConfig {
  name: string;
  env: Record<string, string>;
  overrides: RetrievalOverrides | null;
}

export const RUN_CONFIG_ENV_ALLOWLIST: readonly string[] = [];

export function parseRunConfig(_raw: unknown, _source: string): RunConfig {
  return { name: '', env: {}, overrides: null };
}

export function loadRunConfig(_file: string): RunConfig {
  return { name: '', env: {}, overrides: null };
}
