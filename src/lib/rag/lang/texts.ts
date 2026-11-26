import type { LanguagePack } from './registry';

type Texts = LanguagePack['texts'];
export type TextKey = { [G in keyof Texts]: `${G & string}.${keyof Texts[G] & string}` }[keyof Texts];
export type TextParams = Readonly<Record<string, string | number>>;

export class MissingTextParameterError extends Error {}

export function fixedText(_key: TextKey, _language: string, _params?: TextParams): string {
  return '';
}

export function registryPackVersion(): string {
  return '';
}
