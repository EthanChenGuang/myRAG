import { FIXED_TEXTS, type FixedClientTexts } from '@/lib/rag/lang/texts.generated';

export type ClientTextKey = `notices.${string}` | `labels.${string}`;

const FALLBACK_LANGUAGE = 'en';

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function lookup(texts: FixedClientTexts | undefined, group: 'notices' | 'labels', name: string): string | undefined {
  if (!texts) return undefined;
  const value = own(texts[group], name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The registry language a language tag resolves to: the tag itself, its primary subtag, then en. */
export function clientTextLanguage(language: string | null | undefined): string {
  const tag = typeof language === 'string' ? language.trim() : '';
  if (tag && own(FIXED_TEXTS, tag)) return tag;
  const base = tag.split('-')[0]?.toLowerCase() ?? '';
  if (base && own(FIXED_TEXTS, base)) return base;
  return FALLBACK_LANGUAGE;
}

/** D-12, LANG-09: a notices or labels registry text in `language` (primary subtag, then en); '' for an unknown key. */
export function clientText(key: ClientTextKey | string, language: string | null | undefined): string {
  const dot = key.indexOf('.');
  const group = key.slice(0, dot);
  const name = key.slice(dot + 1);
  if (dot < 0 || (group !== 'notices' && group !== 'labels')) return '';
  const resolved = clientTextLanguage(language);
  return (
    lookup(own(FIXED_TEXTS, resolved), group, name) ??
    lookup(own(FIXED_TEXTS, FALLBACK_LANGUAGE), group, name) ??
    ''
  );
}
