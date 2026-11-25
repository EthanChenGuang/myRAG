export interface CitationMarker {
  start: number;
  end: number;
  aliases: string[];
}

export const MAX_MARKER_HOLD_CHARS = 0;

export function findCitationMarkers(_text: string): CitationMarker[] {
  return [];
}

export function stripCitationMarkers(text: string): string {
  return text;
}

export function neutralizeCitationMarkers(text: string): string {
  return text;
}
