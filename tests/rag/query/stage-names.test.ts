import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CORE_STAGES, OPTIONAL_STAGES, QUERY_LAYER_STAGES } from '@/lib/rag/config';

type JsonSchema = { $defs?: Record<string, { properties?: Record<string, unknown> }> };

function generatedStageNames(): string[] {
  const schema = JSON.parse(readFileSync(join(process.cwd(), 'rag-sidecar/schemas/RagRunRequest.schema.json'), 'utf8')) as JsonSchema;
  const field = schema.$defs?.RagRunOptions?.properties?.disabled_stages as { anyOf: Array<{ items?: { enum?: string[] } }> };
  const names = field.anyOf.find((branch) => branch.items?.enum)?.items?.enum;
  if (!names) throw new Error('StageName enum not found in RagRunRequest.schema.json');
  return names;
}

/** Stages the v2 graph runs internally; the eval contract does not let a caller disable or time them (Phase 4). */
const V2_INTERNAL_STAGES = [
  'fuse',
  'exact_id_lookup',
  'translate',
  'dedupe',
  'rerank',
  'refusal',
  'expand_parents',
  'compress',
  'table_lookup',
  'diversify',
  'identifier_resolve',
  'identifier_guard',
];

describe('stage names (D-05)', () => {
  test('every generated Pydantic StageName is a registered pipeline stage', () => {
    const registered = new Set<string>([...CORE_STAGES, ...OPTIONAL_STAGES]);
    for (const name of generatedStageNames()) expect(registered.has(name)).toBe(true);
  });

  test('the registered set equals the generated enum plus the v2-internal stages', () => {
    const registered = new Set<string>([...CORE_STAGES, ...OPTIONAL_STAGES]);
    expect(registered).toEqual(new Set([...generatedStageNames(), ...V2_INTERNAL_STAGES]));
  });

  test('every query-layer stage is in both sets', () => {
    const generated = new Set(generatedStageNames());
    expect([...QUERY_LAYER_STAGES]).toEqual(['query_gate', 'condense', 'normalize_dates', 'expand', 'hyde', 'decompose', 'semantic_cache']);
    for (const name of QUERY_LAYER_STAGES) {
      expect(generated.has(name)).toBe(true);
      expect((OPTIONAL_STAGES as readonly string[]).includes(name)).toBe(true);
    }
  });
});
