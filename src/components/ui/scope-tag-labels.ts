import type { Language } from '@/lib/rag';

export type ScopeTagTextKey = 'trigger' | 'count' | 'aria' | 'clear' | 'unknownTag';

type DimensionKey = 'region' | 'legal_entity' | 'department';

type Table = Record<ScopeTagTextKey, string> & { dimension: Record<DimensionKey, string> };

const LABELS: { en: Table } & Partial<Record<Language, Table>> = {
  en: {
    trigger: 'Tags',
    count: 'Tags: {n}',
    aria: 'Choose tags for {file}',
    clear: 'Clear tags',
    unknownTag: 'A chosen tag no longer exists. The tag list was reloaded; choose again.',
    dimension: { region: 'Region', legal_entity: 'Legal entity', department: 'Department' },
  },
  zh: {
    trigger: '标签',
    count: '标签：{n}',
    aria: '为 {file} 选择标签',
    clear: '清除标签',
    unknownTag: '所选标签已不存在。标签列表已重新加载，请重新选择。',
    dimension: { region: '地区', legal_entity: '法人实体', department: '部门' },
  },
  it: {
    trigger: 'Tag',
    count: 'Tag: {n}',
    aria: 'Scegli i tag per {file}',
    clear: 'Rimuovi i tag',
    unknownTag: "Un tag scelto non esiste più. L'elenco è stato ricaricato: scegli di nuovo.",
    dimension: { region: 'Regione', legal_entity: 'Entità legale', department: 'Reparto' },
  },
};

function localeLabels(language: string): Table {
  const own = Object.prototype.hasOwnProperty.call(LABELS, language) ? LABELS[language as Language] : undefined;
  return own ?? LABELS.en;
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/** UI-SPEC 12.10 tag picker strings; unknown UI languages fall back to en. */
export function scopeTagText(key: ScopeTagTextKey, language: string, vars: Record<string, string | number> = {}): string {
  return fill(localeLabels(language)[key], vars);
}

/** The dimension name in words; an unknown dimension keeps its identifier. */
export function scopeDimensionLabel(dimension: string, language: string): string {
  const names = localeLabels(language).dimension;
  return Object.prototype.hasOwnProperty.call(names, dimension) ? names[dimension as DimensionKey] : dimension;
}
