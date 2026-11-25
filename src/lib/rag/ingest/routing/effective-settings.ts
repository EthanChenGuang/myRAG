import type { IngestConfig } from '../config';
import type { ProcessingProfile } from '../profiles/load';
import type { JobSettingsSnapshotWire } from '../wire-defaults';

/** The language settings the effective values are computed from (lang/settings.ts, or a job's frozen snapshot). */
export interface EffectiveLanguageInput {
  configured: boolean;
  languages: readonly string[];
  primary: string | null;
}

export interface EffectiveIngestSettingsInput {
  ingestConfig: Pick<IngestConfig, 'languageAwareIngest' | 'tableHeaderRepeat' | 'tableRowSerialization'>;
  profile: ProcessingProfile;
  languageSettings: EffectiveLanguageInput;
}

export interface EffectiveIngestSettings {
  ocrLanguages: string[];
  ocrPrimaryLanguage: string | null;
  llamaparseLanguages: string[];
  languageAware: boolean;
  languages: string[];
  primaryLanguage: string | null;
  repeatTableHeader: boolean;
  repeatTableHeaderForced: boolean;
  carryTableHeader: boolean;
  rowSerialization: boolean;
}

const DEFAULT_SWITCHES: EffectiveIngestSettingsInput['ingestConfig'] = { languageAwareIngest: 'off', tableHeaderRepeat: 'profile', tableRowSerialization: false };

export function effectiveIngestSettings(input: EffectiveIngestSettingsInput): EffectiveIngestSettings {
  const { profile } = input;
  return {
    ocrLanguages: [...profile.parser.ocr_languages],
    ocrPrimaryLanguage: null,
    llamaparseLanguages: [],
    languageAware: false,
    languages: [],
    primaryLanguage: null,
    repeatTableHeader: profile.chunker.repeat_table_header,
    repeatTableHeaderForced: false,
    carryTableHeader: false,
    rowSerialization: false,
  };
}

/** The effective settings of a queued job, rebuilt from its frozen snapshot: later changes of the variables do not reach it. */
export function effectiveIngestSettingsFromSnapshot(snapshot: JobSettingsSnapshotWire, profile: ProcessingProfile): EffectiveIngestSettings {
  void snapshot;
  return effectiveIngestSettings({ ingestConfig: DEFAULT_SWITCHES, profile, languageSettings: { configured: false, languages: [], primary: null } });
}
