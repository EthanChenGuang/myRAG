import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModel } from 'ai';

/** Phase 6.2 D-20 (plan 06.2-29): the per-model delay table the fixture generators wait before answering. */
export const GENERATOR_DELAYS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/generator-delays.json');

export interface GeneratorDelayTable {
  default_ms: number;
  models: Readonly<Record<string, number>>;
}

type Factory = ((_modelId: string) => LanguageModel) & {
  canUseTools?: (_modelId: string) => boolean | undefined;
  maxOutputTokens?: (_modelId: string) => number | undefined;
};

function validMs(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 60_000) {
    throw new Error(`[Eval Harness] generator-delays.json ${field} must be an integer between 0 and 60000`);
  }
  return value;
}

export function parseGeneratorDelays(raw: unknown): GeneratorDelayTable {
  if (!raw || typeof raw !== 'object') throw new Error('[Eval Harness] generator-delays.json must be an object');
  const record = raw as Record<string, unknown>;
  if (record.schema_version !== 1) throw new Error('[Eval Harness] generator-delays.json schema_version must be 1');
  const modelsRaw = record.models;
  if (!modelsRaw || typeof modelsRaw !== 'object' || Array.isArray(modelsRaw)) {
    throw new Error('[Eval Harness] generator-delays.json models must be an object');
  }
  const models: Record<string, number> = {};
  for (const [id, ms] of Object.entries(modelsRaw as Record<string, unknown>)) models[id] = validMs(ms, `models.${id}`);
  return { default_ms: validMs(record.default_ms ?? 0, 'default_ms'), models };
}

let cached: GeneratorDelayTable | null = null;

export function loadGeneratorDelays(file: string = GENERATOR_DELAYS_PATH): GeneratorDelayTable {
  if (file === GENERATOR_DELAYS_PATH && cached) return cached;
  const table = parseGeneratorDelays(JSON.parse(readFileSync(file, 'utf8')));
  if (file === GENERATOR_DELAYS_PATH) cached = table;
  return table;
}

export function generatorDelayMs(modelId: string, table: GeneratorDelayTable = loadGeneratorDelays()): number {
  return Object.prototype.hasOwnProperty.call(table.models, modelId) ? table.models[modelId] : table.default_ms;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps a fixture generator factory so each call waits the routed model's delay first; a model without a delay (every model of
 * today's fixture runs) is returned unwrapped, so those runs behave as before. The factory's harness seams are kept.
 */
export function withGeneratorDelays<F extends Factory>(
  factory: F,
  table: GeneratorDelayTable = loadGeneratorDelays(),
  sleep: (ms: number) => Promise<void> = defaultSleep,
): F {
  const wrapped = ((modelId: string) => {
    const model = factory(modelId);
    const ms = generatorDelayMs(modelId, table);
    if (ms <= 0 || typeof model === 'string') return model;
    return wrapLanguageModel({
      model: model as LanguageModelV3,
      middleware: {
        specificationVersion: 'v3',
        wrapGenerate: async ({ doGenerate }) => {
          await sleep(ms);
          return doGenerate();
        },
        wrapStream: async ({ doStream }) => {
          await sleep(ms);
          return doStream();
        },
      },
    });
  }) as F;
  if (factory.canUseTools) wrapped.canUseTools = factory.canUseTools;
  if (factory.maxOutputTokens) wrapped.maxOutputTokens = factory.maxOutputTokens;
  return wrapped;
}
