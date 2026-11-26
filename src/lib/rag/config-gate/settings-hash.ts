import generated from './rag-affecting.generated.json';
import {
  HASHED_TEXT_NAMES,
  ragAffectingDiff,
  ragSettingsCanonical,
  ragSettingsHash,
  type SettingValues,
} from './settings-hash.cjs';

export { isSecretName } from './secret-name.cjs';
export { HASHED_TEXT_NAMES, ragAffectingDiff, ragSettingsCanonical, ragSettingsHash, type SettingValues };

export const RAG_AFFECTING_NAMES: readonly string[] = Object.freeze([...generated.names]);
