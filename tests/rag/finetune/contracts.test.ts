import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AnswerabilityVerdictSchema,
  ChunkVectorRowSchema,
  DatasetManifestSchema,
  ExportedChunkSchema,
  FilterReportSchema,
  FinetuneConfigSchema,
  FinetunePairSchema,
  IrMetricsSchema,
  MiningReportSchema,
  ModelVersionCardSchema,
  OfflineEvalReportSchema,
  ProbeSetSchema,
  QueryVectorRowSchema,
  SyntheticQueryBatchSchema,
  SyntheticQuerySchema,
  TrainingRunConfigSchema,
  TrainingRunReportSchema,
  VectorFileHeaderSchema,
} from '@/lib/rag-eval/contracts.generated';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const fixture = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'contracts', 'samples.json'), 'utf8'),
) as { samples: Record<string, Record<string, unknown>> };

type Parser = { safeParse: (value: unknown) => { success: boolean; data?: unknown } };

const SCHEMAS: Record<string, Parser> = {
  FinetuneConfig: FinetuneConfigSchema,
  ExportedChunk: ExportedChunkSchema,
  DatasetManifest: DatasetManifestSchema,
  SyntheticQuery: SyntheticQuerySchema,
  SyntheticQueryBatch: SyntheticQueryBatchSchema,
  AnswerabilityVerdict: AnswerabilityVerdictSchema,
  FilterReport: FilterReportSchema,
  FinetunePair: FinetunePairSchema,
  MiningReport: MiningReportSchema,
  TrainingRunConfig: TrainingRunConfigSchema,
  TrainingRunReport: TrainingRunReportSchema,
  IrMetrics: IrMetricsSchema,
  OfflineEvalReport: OfflineEvalReportSchema,
  ProbeSet: ProbeSetSchema,
  ModelVersionCard: ModelVersionCardSchema,
  QueryVectorRow: QueryVectorRowSchema,
  ChunkVectorRow: ChunkVectorRowSchema,
  VectorFileHeader: VectorFileHeaderSchema,
};

const TENANT_A = 'o:00000000-0000-4000-8000-00000000000a';
const TENANT_B = 'o:00000000-0000-4000-8000-00000000000b';

function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...fixture.samples.ModelVersionCard, ...overrides };
}

describe('Phase 6.1 samples parse with the generated Zod schemas', () => {
  it.each(Object.keys(SCHEMAS))('%s sample parses and round-trips unchanged', (model) => {
    const sample = fixture.samples[model];
    expect(sample).toBeDefined();
    const result = SCHEMAS[model].safeParse(sample);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(sample);
  });
});

describe('ModelVersionCard rejects what the Pydantic contract rejects', () => {
  it('accepts the sample card', () => {
    expect(ModelVersionCardSchema.safeParse(card()).success).toBe(true);
  });

  it('rejects dims other than 1024', () => {
    expect(ModelVersionCardSchema.safeParse(card({ dims: 768 })).success).toBe(false);
  });

  it.each([
    'https://user:pw@host/x',
    'https://token@host.example/model',
    'https://host.example/model?sig=abc',
    'https://host.example/model#frag',
    'no-scheme/path',
  ])('rejects artifact_uri %s', (uri) => {
    expect(ModelVersionCardSchema.safeParse(card({ artifact_uri: uri })).success).toBe(false);
  });

  it.each(['s3://bucket/path/model', 'https://host.example/models/ft-1', 'file:///srv/models/ft-1'])(
    'accepts artifact_uri %s',
    (uri) => {
      expect(ModelVersionCardSchema.safeParse(card({ artifact_uri: uri })).success).toBe(true);
    },
  );

  it('rejects a tenant-scope card with two tenant keys', () => {
    const result = ModelVersionCardSchema.safeParse(card({ scope: 'tenant', tenant_keys: [TENANT_A, TENANT_B] }));
    expect(result.success).toBe(false);
  });

  it('accepts a deployment-scope card with two tenant keys and a tenant-scope card with one', () => {
    expect(
      ModelVersionCardSchema.safeParse(card({ scope: 'deployment', tenant_keys: [TENANT_A, TENANT_B] })).success,
    ).toBe(true);
    expect(ModelVersionCardSchema.safeParse(card({ scope: 'tenant', tenant_keys: [TENANT_A] })).success).toBe(true);
  });

  it('rejects an empty tenant key list and a malformed tenant key', () => {
    expect(ModelVersionCardSchema.safeParse(card({ tenant_keys: [] })).success).toBe(false);
    expect(ModelVersionCardSchema.safeParse(card({ tenant_keys: ['tenant-a'] })).success).toBe(false);
  });
});

describe('FinetunePair and SyntheticQueryBatch shapes', () => {
  it('rejects a FinetunePair with an unknown language', () => {
    expect(FinetunePairSchema.safeParse({ ...fixture.samples.FinetunePair, language: 'xx' }).success).toBe(false);
  });

  it('rejects a SyntheticQuery with an unknown style', () => {
    const batch = fixture.samples.SyntheticQueryBatch as { items: Record<string, unknown>[] };
    const bad = { items: [{ ...batch.items[0], style: 'essay' }] };
    expect(SyntheticQueryBatchSchema.safeParse(bad).success).toBe(false);
  });
});
