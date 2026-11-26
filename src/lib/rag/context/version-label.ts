/** D-13, D-44: the version line written before an entry when a request reads more than the current versions. */
export interface VersionLabelInfo {
  version: number;
  isCurrent: boolean;
  /** The document's own effective dates (YYYY-MM-DD); never the upload-date fallback of the period filter. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

interface LabelTexts {
  version: (n: number) => string;
  current: string;
  superseded: string;
  between: (from: string, to: string) => string;
  from: (from: string) => string;
  until: (to: string) => string;
  join: string;
}

const TEXTS: Record<string, LabelTexts> = {
  en: {
    version: (n) => `Version ${n}`,
    current: 'current',
    superseded: 'superseded',
    between: (from, to) => `in effect from ${from} to ${to}`,
    from: (from) => `in effect from ${from}`,
    until: (to) => `in effect until ${to}`,
    join: ', ',
  },
  zh: {
    version: (n) => `版本 ${n}`,
    current: '现行',
    superseded: '已被取代',
    between: (from, to) => `生效期 ${from} 至 ${to}`,
    from: (from) => `自 ${from} 起生效`,
    until: (to) => `生效至 ${to}`,
    join: '，',
  },
  it: {
    version: (n) => `Versione ${n}`,
    current: 'corrente',
    superseded: 'sostituita',
    between: (from, to) => `in vigore dal ${from} al ${to}`,
    from: (from) => `in vigore dal ${from}`,
    until: (to) => `in vigore fino al ${to}`,
    join: ', ',
  },
};

function textsFor(language: string | null | undefined): LabelTexts {
  return language && Object.prototype.hasOwnProperty.call(TEXTS, language) ? TEXTS[language]! : TEXTS.en!;
}

/** One line, e.g. "[Version 1, superseded, in effect from 2026-01-01 to 2026-03-31]"; missing dates leave out their part. */
export function versionLabelLine(info: VersionLabelInfo, language: string | null | undefined): string {
  const t = textsFor(language);
  const parts = [t.version(info.version), info.isCurrent ? t.current : t.superseded];
  const { effectiveFrom: from, effectiveTo: to } = info;
  if (from && to) parts.push(t.between(from, to));
  else if (from) parts.push(t.from(from));
  else if (to) parts.push(t.until(to));
  return `[${parts.join(t.join)}]`;
}
