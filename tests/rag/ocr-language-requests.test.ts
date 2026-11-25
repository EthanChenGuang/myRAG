import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { JobSettingsSnapshotSchema } from '@/lib/rag-eval/contracts.generated';
import { ingest } from '@/lib/rag/ingest';
import { imageCaptionModelId } from '@/lib/rag/ingest/captioner';
import { createLlamaParseParser } from '@/lib/rag/ingest/parsers/llamaparse-v2';
import { createSidecarParser, resetSidecarParserForTests, setSidecarParserForTests } from '@/lib/rag/ingest/parsers/sidecar-docling';
import type { ParseRequest } from '@/lib/rag/ingest/parsers/shared';
import { getProcessingProfile, type ProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { loadQueueConfig } from '@/lib/rag/ingest/queue-config';
import { loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import {
  effectiveIngestSettings,
  effectiveIngestSettingsFromSnapshot,
  type EffectiveIngestSettingsInput,
  type EffectiveLanguageInput,
} from '@/lib/rag/ingest/routing/effective-settings';
import { buildJobSettings, type BuildJobSettingsInput } from '@/lib/rag/ingest/routing/settings-snapshot';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { mintScope } from '@/lib/rag/tenant/scope';
import { fakeIngestDb, installIngestDeps, uninstallIngestDeps } from '../helpers/ingest-fakes';
import { fixtureBytes, startFakeSidecar, type FakeSidecar } from '../helpers/fake-sidecar';

const scope = mintScope('single', null, null);
const DEFAULTS: EffectiveIngestSettingsInput['ingestConfig'] = { languageAwareIngest: 'off', tableHeaderRepeat: 'profile', tableRowSerialization: false };
const UNSET: EffectiveLanguageInput = { configured: false, languages: [], primary: null };
const ZH_IT: EffectiveLanguageInput = { configured: true, languages: ['zh', 'it'], primary: 'it' };

// Recorded before this plan: the bodies a default deployment sends today.
const RECORDED_DOCLING_GENERAL =
  '{"docling":{"force_full_page_ocr":false,"generate_picture_images":true,"heading_hierarchy":true,"ocr":true,"table_mode":"fast"},"input_format":"pdf","max_tokens":512,"ocr_languages":["zh","en","it"],"page_cap":null,"profile_id":"general@1","profile_version":1,"repeat_table_header":false,"tokenizer":"cl100k_base"}';
const RECORDED_DOCLING_FINANCIAL =
  '{"docling":{"force_full_page_ocr":false,"generate_picture_images":true,"heading_hierarchy":true,"ocr":true,"table_mode":"accurate"},"input_format":"pdf","max_tokens":512,"ocr_languages":["zh","en","it"],"page_cap":null,"profile_id":"financial_report@1","profile_version":1,"repeat_table_header":true,"tokenizer":"cl100k_base"}';
const RECORDED_LLAMAPARSE_CONFIGURATION = '{"tier":"cost_effective","version":"latest"}';
const recordedSnapshot = (): string =>
  `{"cloud_allowed":true,"doc_type":"general","embed_mode":"sync","escalation":true,"max_tier":"premium","min_tier":"fast","ocr_languages":["zh","en","it"],"premium_max_pages_per_doc":200,"premium_page_budget":0,"profile_id":"general@1","profile_version":1,"progressive":false,"routing":"fixed","routing_config_version":"1","vlm_detect":false,"vlm_model":${JSON.stringify(imageCaptionModelId())}}`;

let bodies: string[];

beforeEach(() => {
  bodies = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const form = init.body as FormData;
    bodies.push(String(form.get('request') ?? form.get('configuration')));
    throw new Error('captured');
  });
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function request(profile: ProcessingProfile, settings?: ParseRequest['settings']): ParseRequest {
  return {
    scope,
    filename: 'sample.pdf',
    mimeType: 'application/pdf',
    bytes: new TextEncoder().encode('%PDF-1.4 synthetic'),
    profile,
    signal: new AbortController().signal,
    now: () => 0,
    deadline: 10 ** 9,
    pollUntil: 1,
    resume: null,
    onSubmitted: async () => undefined,
    ...(settings ? { settings } : {}),
  };
}

async function doclingBody(profile: ProcessingProfile, settings?: ParseRequest['settings']): Promise<string> {
  await createSidecarParser({ baseUrl: 'http://127.0.0.1:9', secret: 'secret-placeholder' }).parse(request(profile, settings)).catch(() => undefined);
  return bodies.pop() as string;
}

async function llamaparseConfiguration(profile: ProcessingProfile, settings?: ParseRequest['settings']): Promise<string> {
  await createLlamaParseParser({ baseUrl: 'http://127.0.0.1:9', apiKey: 'key-placeholder', tier: 'cost_effective' })
    .parse(request(profile, settings))
    .catch(() => undefined);
  return bodies.pop() as string;
}

function snapshot(overrides: Partial<BuildJobSettingsInput> = {}) {
  return buildJobSettings({
    queueConfig: loadQueueConfig({}),
    profile: getProcessingProfile('general'),
    bounds: { min_tier: 'fast', max_tier: 'premium' },
    routingConfig: loadRoutingConfig(),
    ...overrides,
  });
}

const effective = (profile: ProcessingProfile, languageSettings: EffectiveLanguageInput, ingestConfig = DEFAULTS) =>
  effectiveIngestSettings({ ingestConfig, profile, languageSettings });

describe('languages unset: the three requests equal their recorded bodies', () => {
  test('inline Docling request, with and without the effective settings', async () => {
    const general = getProcessingProfile('general');
    const financial = getProcessingProfile('financial_report');
    expect(await doclingBody(general)).toBe(RECORDED_DOCLING_GENERAL);
    expect(await doclingBody(general, effective(general, UNSET))).toBe(RECORDED_DOCLING_GENERAL);
    expect(await doclingBody(financial, effective(financial, UNSET))).toBe(RECORDED_DOCLING_FINANCIAL);
  });

  test('LlamaParse v2 configuration', async () => {
    const general = getProcessingProfile('general');
    expect(await llamaparseConfiguration(general)).toBe(RECORDED_LLAMAPARSE_CONFIGURATION);
    expect(await llamaparseConfiguration(general, effective(general, UNSET))).toBe(RECORDED_LLAMAPARSE_CONFIGURATION);
  });

  test('job settings snapshot', () => {
    expect(JSON.stringify(snapshot())).toBe(recordedSnapshot());
    expect(JSON.stringify(snapshot({ ingestConfig: DEFAULTS, languageSettings: UNSET }))).toBe(recordedSnapshot());
  });
});

describe('languages zh,it with primary it', () => {
  test('the Docling request carries the registry-order language codes', async () => {
    const general = getProcessingProfile('general');
    const body = JSON.parse(await doclingBody(general, effective(general, ZH_IT)));
    expect(body.ocr_languages).toEqual(['zh', 'it']);
    expect(Object.keys(body).sort()).toEqual(Object.keys(JSON.parse(RECORDED_DOCLING_GENERAL)).sort());
  });

  test('the snapshot carries the same list and the primary it was built with', () => {
    const built = snapshot({ ingestConfig: DEFAULTS, languageSettings: { configured: true, languages: ['it', 'zh'], primary: 'it' } });
    expect(built.ocr_languages).toEqual(['zh', 'it']);
    expect(built.ocr_primary_language).toBe('it');
    expect(JobSettingsSnapshotSchema.safeParse(built).success).toBe(true);
  });

  test('the LlamaParse v2 configuration carries the LlamaParse codes, primary first', async () => {
    const general = getProcessingProfile('general');
    const configuration = JSON.parse(await llamaparseConfiguration(general, effective(general, ZH_IT)));
    expect(configuration).toEqual({ tier: 'cost_effective', version: 'latest', processing_options: { ocr_parameters: { languages: ['it', 'ch_sim'] } } });
  });

  test('a snapshot built before a variable change still yields the old requests', async () => {
    const general = getProcessingProfile('general');
    const frozen = snapshot({ ingestConfig: DEFAULTS, languageSettings: ZH_IT });
    const later = effectiveIngestSettingsFromSnapshot(frozen, general);
    expect(later.ocrLanguages).toEqual(['zh', 'it']);
    expect(later.llamaparseLanguages).toEqual(['it', 'ch_sim']);
    expect(JSON.parse(await doclingBody(general, later)).ocr_languages).toEqual(['zh', 'it']);
    expect(JSON.parse(await llamaparseConfiguration(general, later)).processing_options).toEqual({ ocr_parameters: { languages: ['it', 'ch_sim'] } });
  });

  test('a snapshot built with the languages unset rebuilds no LlamaParse languages', () => {
    const general = getProcessingProfile('general');
    const later = effectiveIngestSettingsFromSnapshot(snapshot(), general);
    expect(later.ocrLanguages).toEqual(['zh', 'en', 'it']);
    expect(later.llamaparseLanguages).toEqual([]);
  });
});

describe('inline ingest() reads the language settings into the Docling request', () => {
  let fake: FakeSidecar;
  const saved = { supported: process.env.RAG_SUPPORTED_LANGUAGES, primary: process.env.RAG_PRIMARY_LANGUAGE };

  beforeEach(async () => {
    vi.unstubAllGlobals();
    fake = await startFakeSidecar();
  });

  afterEach(async () => {
    await fake.close();
    resetSidecarParserForTests();
    uninstallIngestDeps();
    process.env.RAG_SUPPORTED_LANGUAGES = saved.supported;
    process.env.RAG_PRIMARY_LANGUAGE = saved.primary;
    resetLanguageSettingsForTests();
  });

  test('zh,it with primary it reach the inline request in registry order', async () => {
    process.env.RAG_SUPPORTED_LANGUAGES = 'it,zh';
    process.env.RAG_PRIMARY_LANGUAGE = 'it';
    resetLanguageSettingsForTests();
    const db = fakeIngestDb();
    installIngestDeps({ db: db.db, env: { RAG_INGEST_PIPELINE: 'unified', RAG_PARSER: 'docling' } });
    setSidecarParserForTests(createSidecarParser({ baseUrl: fake.url, secret: fake.secret, sleep: async () => undefined }));
    await ingest({
      scope,
      source: 'config_upload',
      sourceKey: 'root/report-zh-table.pdf',
      file: fixtureBytes('report-zh-table'),
      filename: 'report-zh-table.pdf',
      mimeType: 'application/pdf',
      docType: 'financial_report',
      signal: new AbortController().signal,
    });
    expect(fake.uploads[0]?.request.ocr_languages).toEqual(['zh', 'it']);
  });
});
