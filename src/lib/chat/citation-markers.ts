export type CitationRenderPhase = 'streaming' | 'final';

export interface CitationMarkerTarget {
  n: number;
  alias: string;
}

export function isCitationAware(_metadata: unknown): boolean {
  return false;
}

export function renderCitationMarkers(
  text: string,
  _options: { citations?: readonly CitationMarkerTarget[]; phase: CitationRenderPhase },
): string {
  return text;
}
