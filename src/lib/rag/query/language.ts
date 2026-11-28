import { detectLanguage } from '@/lib/rag/lang/detect';

export function queryLanguage(text: string): 'zh' | 'en' | 'it' | null {
  const language = detectLanguage(text);
  return language === 'zh' || language === 'en' || language === 'it' ? language : null;
}