import { detectLanguage } from '@/lib/rag/lang/detect';

export function queryLanguage(text: string): 'zh' | 'en' | 'it' | null {
  return detectLanguage(text);
}