/**
 * Phase 5.2.1 D-80: the model window is the `contextLength` of the model lists (the five model locations); an unknown model
 * returns null and the planner uses the conservative default window. The override map is for the eval harness's fake ids only.
 */
import { z } from 'zod/v3';
import { env } from '@/lib/env';

const FAMILY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FIXTURE_FAMILY = 'fixture';
const LIST_VARIABLES = ['NEXT_PUBLIC_OPENROUTER_MODELS', 'NEXT_PUBLIC_OPENAI_MODELS', 'NEXT_PUBLIC_GROQ_MODELS'] as const;

const modelListSchema = z.array(z.object({ id: z.string(), contextLength: z.unknown().optional() }).passthrough());

let overrides: ReadonlyMap<string, number> | null = null;

/** Eval harness only: windows for fake model ids. Pass null to clear. */
export function setModelContextLengthOverrides(map: Readonly<Record<string, number>> | null): void {
  overrides = map ? new Map(Object.entries(map)) : null;
}

function validWindow(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function listFor(name: (typeof LIST_VARIABLES)[number], source: Record<string, string | undefined>) {
  const raw = source[name]?.trim() || env[name];
  try {
    const parsed = modelListSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function modelContextLength(modelId: string, source: Record<string, string | undefined> = process.env): number | null {
  const override = overrides?.get(modelId);
  if (override !== undefined) return validWindow(override);
  for (const name of LIST_VARIABLES) {
    const model = listFor(name, source).find((entry) => entry.id === modelId);
    if (model) return validWindow(model.contextLength);
  }
  return null;
}

/** The provider prefix before the first slash, the tokenizer-calibration family; fake ids are the fixture family. */
export function modelFamily(modelId: string): string | null {
  if (overrides?.has(modelId)) return FIXTURE_FAMILY;
  const slash = modelId.indexOf('/');
  if (slash <= 0) return null;
  const prefix = modelId.slice(0, slash);
  return FAMILY.test(prefix) ? prefix : null;
}
