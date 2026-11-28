import type { LanguageModel } from 'ai';

export interface GeneratorDelayTable {
  default_ms: number;
  models: Readonly<Record<string, number>>;
}

export function loadGeneratorDelays(): GeneratorDelayTable {
  return { default_ms: 0, models: {} };
}

export function generatorDelayMs(_modelId: string, _table?: GeneratorDelayTable): number {
  return 0;
}

export function withGeneratorDelays<F extends (_modelId: string) => LanguageModel>(
  factory: F,
  _table?: GeneratorDelayTable,
  _sleep?: (ms: number) => Promise<void>,
): F {
  return factory;
}
