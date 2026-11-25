export type GateLang = 'zh' | 'en' | 'it';

export function detectGateLanguage(_text: string): GateLang {
  return 'en';
}
