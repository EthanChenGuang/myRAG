import { z } from 'zod/v3';
import { env } from '@/lib/env';

const ANTHROPIC_ID = /^claude-[a-z0-9-]+$/;

const modelListSchema = z.array(
  z
    .object({
      id: z.string(),
      anthropicId: z.string().optional(),
    })
    .passthrough(),
);

/** D-08: the Anthropic id of a configured OpenRouter model, or null; a model without anthropicId never takes the direct path. */
export function anthropicIdFor(modelId: string, source: Record<string, string | undefined> = process.env): string | null {
  const raw = source.NEXT_PUBLIC_OPENROUTER_MODELS?.trim() || env.NEXT_PUBLIC_OPENROUTER_MODELS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = modelListSchema.safeParse(parsed);
  if (!list.success) return null;
  const model = list.data.find((entry) => entry.id === modelId);
  const anthropicId = model?.anthropicId?.trim();
  if (!model || !anthropicId || !model.id.startsWith('anthropic/') || !ANTHROPIC_ID.test(anthropicId)) return null;
  return anthropicId;
}
