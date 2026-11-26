import { getLanguagePack, getLanguageRegistry, packText, TEXT_KEYS, type TextKey } from './registry';
import { getLanguageSettings } from './settings';

export type { TextKey } from './registry';
export type TextParams = Readonly<Record<string, string | number>>;

/** Used only while no primary language is configured; equals today's English fallback of the legacy text tables. */
const UNCONFIGURED_FALLBACK = 'en';
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const KNOWN_KEYS: ReadonlySet<string> = new Set(TEXT_KEYS);

export class MissingTextParameterError extends Error {
  constructor(readonly key: TextKey, readonly parameter: string) {
    super(`[Language Texts] ${key} needs the parameter {${parameter}}`);
    this.name = 'MissingTextParameterError';
  }
}

function lookup(key: TextKey, code: string | null): string | null {
  if (code === null) return null;
  const pack = getLanguagePack(code);
  return pack ? packText(pack, key) : null;
}

/**
 * Phase 5.2 D-08: the only per-language text lookup. A language without a pack, or a pack without the key, falls back to
 * RAG_PRIMARY_LANGUAGE (English while the languages are not configured). Placeholders are named, `{value}`, and every
 * placeholder the text holds must be given in `params`.
 */
export function fixedText(key: TextKey, language: string, params?: TextParams): string {
  if (typeof key !== 'string' || !KNOWN_KEYS.has(key)) throw new Error(`[Language Texts] unknown text key ${String(key)}`);
  const primary = getLanguageSettings().primary ?? UNCONFIGURED_FALLBACK;
  const text = lookup(key, typeof language === 'string' ? language : null) ?? lookup(key, primary) ?? lookup(key, UNCONFIGURED_FALLBACK);
  if (text === null) throw new Error(`[Language Texts] no pack holds ${key}`);
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    if (!params || !Object.prototype.hasOwnProperty.call(params, name)) throw new MissingTextParameterError(key, name);
    return String(params[name]);
  });
}

/** The pack_version of every pack, `code:version` in registry order (input to the Phase 5.2 config hash). */
export function registryPackVersion(): string {
  return getLanguageRegistry()
    .packs.map((pack) => `${pack.code}:${pack.pack_version}`)
    .join(',');
}
