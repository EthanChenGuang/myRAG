import type { Language } from '@/lib/rag';

export type ReplacesTextKey =
  | 'trigger'
  | 'title'
  | 'member'
  | 'admin'
  | 'search'
  | 'empty'
  | 'noMatch'
  | 'close'
  | 'confirm'
  | 'line'
  | 'remove';

const LABELS: { en: Record<ReplacesTextKey, string> } & Partial<Record<Language, Record<ReplacesTextKey, string>>> = {
  en: {
    trigger: 'Replaces…',
    title: 'Which document does {file} replace?',
    member: 'An admin confirms the replacement. Until then both documents are used for answers.',
    admin: 'The chosen document stops being used for answers when this upload is ready.',
    search: 'Search documents',
    empty: 'No documents in this workspace yet.',
    noMatch: 'No document matches "{query}".',
    close: 'Close chooser',
    confirm: 'Choose document',
    line: 'Replaces: {name}',
    remove: 'Clear replacement: {name}',
  },
  zh: {
    trigger: '替换…',
    title: '{file} 要替换哪份文档？',
    member: '替换需由管理员确认。在此之前，两份文档都会用于回答。',
    admin: '此上传就绪后，所选文档会停止用于回答。',
    search: '搜索文档',
    empty: '此工作区还没有文档。',
    noMatch: '没有与“{query}”匹配的文档。',
    close: '关闭选择',
    confirm: '选择文档',
    line: '替换：{name}',
    remove: '清除替换：{name}',
  },
  it: {
    trigger: 'Sostituisce…',
    title: 'Quale documento sostituisce {file}?',
    member: 'Un amministratore conferma la sostituzione. Fino ad allora entrambi i documenti sono usati nelle risposte.',
    admin: 'Il documento scelto smette di essere usato nelle risposte quando questo caricamento è pronto.',
    search: 'Cerca documenti',
    empty: 'Nessun documento in questo spazio di lavoro.',
    noMatch: 'Nessun documento corrisponde a «{query}».',
    close: 'Chiudi selezione',
    confirm: 'Scegli documento',
    line: 'Sostituisce: {name}',
    remove: 'Rimuovi sostituzione: {name}',
  },
};

/** The raw template of a key, for callers that insert a value as its own element. */
export function replacesTemplate(key: ReplacesTextKey, language: string): string {
  const own = Object.prototype.hasOwnProperty.call(LABELS, language) ? LABELS[language as Language] : undefined;
  return (own ?? LABELS.en)[key];
}

/** UI-SPEC 12.10 "Replaces…" strings; unknown UI languages fall back to en. */
export function replacesText(key: ReplacesTextKey, language: string, vars: Record<string, string | number> = {}): string {
  return replacesTemplate(key, language).replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}
