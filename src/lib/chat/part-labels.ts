export type PartLabelKey = 'from_documents' | 'from_web' | 'general_knowledge';

export function partLabelOf(_text: string | null | undefined): { key: PartLabelKey; language: string } | null {
  return null;
}
