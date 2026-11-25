import { beforeEach, describe, expect, test } from 'vitest';
import { resetRoutingConfigForTests, loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import { buildJobSettings } from '@/lib/rag/ingest/routing/settings-snapshot';
import { effectiveTierBounds, resetTierBoundsDepsForTests } from '@/lib/rag/ingest/routing/tier-bounds';
import { loadQueueConfig, resetQueueConfigForTests } from '@/lib/rag/ingest/queue-config';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { JobSettingsSnapshotSchema } from '@/lib/rag-eval/contracts.generated';
import { imageCaptionModelId } from '@/lib/rag/ingest/captioner';

beforeEach(() => {
  resetQueueConfigForTests();
  resetRoutingConfigForTests();
  resetTierBoundsDepsForTests();
});

describe('effectiveTierBounds', () => {
  test('invoice_receipt uses structured through premium without an override', async () => {
    const bounds = await effectiveTierBounds('invoice_receipt', { admin: () => null });
    expect(bounds).toEqual({ min_tier: 'structured', max_tier: 'premium' });
  });

  test('admin override replaces profile bounds', async () => {
    const bounds = await effectiveTierBounds('invoice_receipt', {
      admin: () =>
        ({
          from: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { min_tier: 'fast', max_tier: 'structured' },
                  error: null,
                }),
              }),
            }),
          }),
        }) as never,
    });
    expect(bounds).toEqual({ min_tier: 'fast', max_tier: 'structured' });
  });
});

describe('buildJobSettings', () => {
  const routingConfig = loadRoutingConfig();
  const profile = getProcessingProfile('general');

  test('defaults env gives routing fixed, sync embed, and caption model when vlm model is empty', () => {
    const queueConfig = loadQueueConfig({});
    const snapshot = buildJobSettings({
      queueConfig,
      profile,
      bounds: { min_tier: 'fast', max_tier: 'premium' },
      routingConfig,
    });
    expect(snapshot.routing).toBe('fixed');
    expect(snapshot.cloud_allowed).toBe(true);
    expect(snapshot.premium_page_budget).toBe(0);
    expect(snapshot.premium_max_pages_per_doc).toBe(200);
    expect(snapshot.escalation).toBe(true);
    expect(snapshot.progressive).toBe(false);
    expect(snapshot.vlm_detect).toBe(false);
    expect(snapshot.vlm_model).toBe(imageCaptionModelId());
    expect(snapshot.embed_mode).toBe('sync');
    expect(JobSettingsSnapshotSchema.parse(snapshot)).toMatchObject(snapshot);
  });

  test('the snapshot carries no Phase 3.2 field at its default, so a sidecar deployed before them still reads it', () => {
    const snapshot = buildJobSettings({
      queueConfig: loadQueueConfig({}),
      profile,
      bounds: { min_tier: 'fast', max_tier: 'premium' },
      routingConfig,
    });
    expect(Object.keys(snapshot).sort()).toEqual([
      'cloud_allowed',
      'doc_type',
      'embed_mode',
      'escalation',
      'max_tier',
      'min_tier',
      'ocr_languages',
      'premium_max_pages_per_doc',
      'premium_page_budget',
      'profile_id',
      'profile_version',
      'progressive',
      'routing',
      'routing_config_version',
      'vlm_detect',
      'vlm_model',
    ]);
    expect(JobSettingsSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  test('backfill with OpenAI embedding profile forces batch_api and progressive off', () => {
    const queueConfig = loadQueueConfig({
      RAG_EMBED_BATCH_MODE: 'batch_api',
      RAG_PARSE_PROGRESSIVE: 'true',
    });
    const snapshot = buildJobSettings({
      queueConfig,
      profile,
      bounds: { min_tier: 'fast', max_tier: 'premium' },
      routingConfig,
      isBackfill: true,
      embedProfileProvider: 'openai',
    });
    expect(snapshot.progressive).toBe(false);
    expect(snapshot.embed_mode).toBe('batch_api');
  });

  test('backfill with a non-OpenAI provider stays on sync', () => {
    const queueConfig = loadQueueConfig({ RAG_EMBED_BATCH_MODE: 'batch_api' });
    const snapshot = buildJobSettings({
      queueConfig,
      profile,
      bounds: { min_tier: 'fast', max_tier: 'premium' },
      routingConfig,
      isBackfill: true,
      embedProfileProvider: 'voyage',
    });
    expect(snapshot.embed_mode).toBe('sync');
  });

  test('backfill with RAG_EMBED_BATCH_MODE=sync stays on sync even for an OpenAI profile (D-35 default)', () => {
    const queueConfig = loadQueueConfig({ RAG_EMBED_BATCH_MODE: 'sync' });
    const snapshot = buildJobSettings({
      queueConfig,
      profile,
      bounds: { min_tier: 'fast', max_tier: 'premium' },
      routingConfig,
      isBackfill: true,
      embedProfileProvider: 'openai',
    });
    expect(snapshot.embed_mode).toBe('sync');
  });

  test('an incremental job embeds synchronously even when RAG_EMBED_BATCH_MODE=batch_api (D-35)', () => {
    const queueConfig = loadQueueConfig({ RAG_EMBED_BATCH_MODE: 'batch_api', RAG_PARSE_PROGRESSIVE: 'true' });
    const snapshot = buildJobSettings({
      queueConfig,
      profile,
      bounds: { min_tier: 'fast', max_tier: 'premium' },
      routingConfig,
      embedProfileProvider: 'openai',
    });
    expect(snapshot.embed_mode).toBe('sync');
    expect(snapshot.progressive).toBe(true);
  });

  test('same inputs produce stable JSON', () => {
    const queueConfig = loadQueueConfig({});
    const input = {
      queueConfig,
      profile,
      bounds: { min_tier: 'fast' as const, max_tier: 'premium' as const },
      routingConfig,
    };
    const a = buildJobSettings(input);
    const b = buildJobSettings(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});