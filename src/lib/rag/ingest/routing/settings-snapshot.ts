import { JobSettingsSnapshotSchema, type UploadApproval } from '@/lib/rag-eval/contracts.generated';
import { JOB_SETTINGS_PHASE32_DEFAULTS, omitDefaultFields, type JobSettingsSnapshotWire } from '../wire-defaults';
import { imageCaptionModelId } from '../captioner';
import { batchApiAllowed } from '../../embeddings/openai-client';
import type { IngestCheckMode } from '../config';
import type { QueueConfig } from '../queue-config';
import type { ProcessingProfile } from '../profiles/load';
import type { ParseRoutingConfig } from './config';
import { effectiveIngestSettings, type EffectiveIngestSettingsInput, type EffectiveLanguageInput } from './effective-settings';
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
  /** The identify stage's approval decision; written only when it requires approval (D-56, research Pitfall 17). */
  approval?: UploadApproval | null;
  /** A job of a batch whose versions publish only at activation (D-12); written only for a backfill job. */
  holdPublish?: boolean;
  /** The ingestion switches; absent, every switch is at its default. */
  ingestConfig?: EffectiveIngestSettingsInput['ingestConfig'];
  /** The language settings (lang/settings.ts) at enqueue; absent, the languages are unset and the profile's ocr_languages apply. */
  languageSettings?: EffectiveLanguageInput;
  /** RAG_HIDDEN_TEXT_CHECK at enqueue (D-33): the worker checks the original at preflight when it is not off; absent, off. */
  hiddenTextCheck?: IngestCheckMode;
}

const DEFAULT_SWITCHES: EffectiveIngestSettingsInput['ingestConfig'] = { languageAwareIngest: 'off', tableHeaderRepeat: 'profile', tableRowSerialization: false };
const UNSET_LANGUAGES: EffectiveLanguageInput = { configured: false, languages: [], primary: null };

export function buildJobSettings(input: BuildJobSettingsInput): JobSettingsSnapshotWire {
  const {
    queueConfig,
    profile,
    bounds,
    routingConfig,
    isBackfill = false,
    embedProfileProvider = 'openai',
    approval = null,
    holdPublish = false,
    ingestConfig = DEFAULT_SWITCHES,
    languageSettings = UNSET_LANGUAGES,
    hiddenTextCheck = 'off',
  } = input;
  const effective = effectiveIngestSettings({ ingestConfig, profile, languageSettings });

  // A held upload is never visible before approval, so a provisional version would only end the job before its routed run (D-30, D-36).
  const progressive = isBackfill || approval?.required === true ? false : queueConfig.parseProgressive;
  // D-35: batch_api only when the switch asks for it, only for backfill jobs and only for OpenAI profiles; everything else embeds in sync.
  // RAG_OPENAI_EMBEDDINGS_VIA=openrouter has no Batch API, so those jobs embed in sync too.
  const embedMode =
    isBackfill && queueConfig.embedBatchMode === 'batch_api' && embedProfileProvider === 'openai' && batchApiAllowed() ? 'batch_api' : 'sync';

  const snapshot = {
    cloud_allowed: queueConfig.parserAllowCloud,
    doc_type: profile.doc_type,
    embed_mode: embedMode,
    escalation: queueConfig.parseEscalation === 'on',
    max_tier: bounds.max_tier,
    min_tier: bounds.min_tier,
    ocr_languages: effective.ocrLanguages,
    premium_max_pages_per_doc: queueConfig.premiumMaxPagesPerDoc,
    premium_page_budget: queueConfig.premiumPageBudget,
    profile_id: profile.id,
    profile_version: profile.version,
    progressive,
    routing: queueConfig.parseRouting,
    routing_config_version: routingConfig.version,
    vlm_detect: queueConfig.vlmDetect,
    vlm_model: queueConfig.vlmModel ?? imageCaptionModelId(),
    ...(approval?.required === true ? { approval } : {}),
    ...(holdPublish && isBackfill ? { hold_publish: true } : {}),
    // Each field below is dropped by omitDefaultFields while it holds its default (D-17, research Pitfall 17).
    ocr_primary_language: effective.ocrPrimaryLanguage,
    language_aware: effective.languageAware,
    languages: effective.languages as JobSettingsSnapshotWire['languages'],
    primary_language: effective.primaryLanguage as JobSettingsSnapshotWire['primary_language'],
    // null leaves the flag to the profile (profile mode); a forced flag is recorded (D-19, D-22, research F-13).
    repeat_table_header_effective: effective.repeatTableHeaderForced ? effective.repeatTableHeader : null,
    carry_table_header: effective.carryTableHeader,
    row_serialization: effective.rowSerialization,
    hidden_text_check: hiddenTextCheck,
  };

  return omitDefaultFields(JobSettingsSnapshotSchema.parse(snapshot), JOB_SETTINGS_PHASE32_DEFAULTS);
}