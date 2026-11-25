import { JobSettingsSnapshotSchema } from '@/lib/rag-eval/contracts.generated';
import { JOB_SETTINGS_PHASE32_DEFAULTS, omitDefaultFields, type JobSettingsSnapshotWire } from '../wire-defaults';
import { imageCaptionModelId } from '../captioner';
import type { QueueConfig } from '../queue-config';
import type { ProcessingProfile } from '../profiles/load';
import type { ParseRoutingConfig } from './config';
import type { EffectiveTierBounds } from './tier-bounds';

export interface BuildJobSettingsInput {
  queueConfig: QueueConfig;
  profile: ProcessingProfile;
  bounds: EffectiveTierBounds;
  routingConfig: ParseRoutingConfig;
  kind?: 'ingest' | 'dry_run' | 'delete';
  isBackfill?: boolean;
  /** Active embedding profile provider; defaults to openai (legacy). */
  embedProfileProvider?: string;
}

export function buildJobSettings(input: BuildJobSettingsInput): JobSettingsSnapshotWire {
  const {
    queueConfig,
    profile,
    bounds,
    routingConfig,
    isBackfill = false,
    embedProfileProvider = 'openai',
  } = input;

  const progressive = isBackfill ? false : queueConfig.parseProgressive;
  // D-35: batch_api only when the switch asks for it, only for backfill jobs and only for OpenAI profiles; everything else embeds in sync.
  const embedMode = isBackfill && queueConfig.embedBatchMode === 'batch_api' && embedProfileProvider === 'openai' ? 'batch_api' : 'sync';

  const snapshot = {
    cloud_allowed: queueConfig.parserAllowCloud,
    doc_type: profile.doc_type,
    embed_mode: embedMode,
    escalation: queueConfig.parseEscalation === 'on',
    max_tier: bounds.max_tier,
    min_tier: bounds.min_tier,
    ocr_languages: profile.parser.ocr_languages,
    premium_max_pages_per_doc: queueConfig.premiumMaxPagesPerDoc,
    premium_page_budget: queueConfig.premiumPageBudget,
    profile_id: profile.id,
    profile_version: profile.version,
    progressive,
    routing: queueConfig.parseRouting,
    routing_config_version: routingConfig.version,
    vlm_detect: queueConfig.vlmDetect,
    vlm_model: queueConfig.vlmModel ?? imageCaptionModelId(),
  };

  return omitDefaultFields(JobSettingsSnapshotSchema.parse(snapshot), JOB_SETTINGS_PHASE32_DEFAULTS);
}