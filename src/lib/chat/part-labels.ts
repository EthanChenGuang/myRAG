import { FIXED_TEXTS } from '@/lib/rag/lang/texts.generated';

export type PartLabelKey = 'from_documents' | 'from_web' | 'general_knowledge';

export const PART_LABEL_KEYS: readonly PartLabelKey[] = ['from_documents', 'from_web', 'general_knowledge'];

let labelIndex: Map<string, { key: PartLabelKey; language: string }> | null = null;

function index(): Map<string, { key: PartLabelKey; language: string }> {
  if (labelIndex) return labelIndex;
  const map = new Map<string, { key: PartLabelKey; language: string }>();
  for (const language of Object.keys(FIXED_TEXTS)) {
    const labels = FIXED_TEXTS[language]!.labels;
    for (const key of PART_LABEL_KEYS) {
      const text = Object.prototype.hasOwnProperty.call(labels, key) ? labels[key] : null;
      if (typeof text === 'string' && text.length > 0 && !map.has(text)) map.set(text, { key, language });
    }
  }
  labelIndex = map;
  return map;
}

/** GEN-08 (UI-SPEC 6.6): the part-label key when `text` is exactly a registry label in a shipped language, else null. */
export function partLabelOf(text: string | null | undefined): { key: PartLabelKey; language: string } | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  return index().get(text) ?? null;
}

/** The single string a renderer's children hold, or null when they are anything else. */
export function soleText(children: unknown): string | null {
  if (typeof children === 'string') return children;
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === 'string') return children[0];
  return null;
}
