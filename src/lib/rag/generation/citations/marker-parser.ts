import {
  MAX_MARKER_HOLD_CHARS,
  findCitationMarkers,
  isMarkerOpener,
  isOpenMarkerPrefix,
} from '@/lib/citations/marker-grammar';

export interface MarkerParseResult {
  valid: string[];
  invalidCitations: number;
  invalidAliases: string[];
  /** D-33: markers cut in half when a text part or the stream ended; never guessed. Absent when none was cut. */
  truncatedMarkers?: number;
}

export interface MarkerParser {
  feed(textId: string, delta: string): void;
  end(textId: string): void;
  finish(): MarkerParseResult;
}

/**
 * Observes streamed text deltas and collects citation markers, whatever the split points.
 * Each text id keeps only the tail starting at an opener that can still become a marker,
 * which is never longer than the opener plus MAX_MARKER_HOLD_CHARS characters.
 */
export function createMarkerParser(options: { aliases: ReadonlySet<string> }): MarkerParser {
  const { aliases } = options;
  const tails = new Map<string, string>();
  const valid: string[] = [];
  const seenValid = new Set<string>();
  const invalidAliases: string[] = [];
  const seenInvalid = new Set<string>();
  let invalidCitations = 0;
  let truncatedMarkers = 0;
  let result: MarkerParseResult | null = null;

  const record = (alias: string) => {
    if (aliases.has(alias)) {
      if (!seenValid.has(alias)) {
        seenValid.add(alias);
        valid.push(alias);
      }
      return;
    }
    invalidCitations++;
    if (!seenInvalid.has(alias)) {
      seenInvalid.add(alias);
      invalidAliases.push(alias);
    }
  };

  return {
    feed(textId, delta) {
      if (result || delta.length === 0) return;
      const text = (tails.get(textId) ?? '') + delta;
      let lastEnd = 0;
      for (const marker of findCitationMarkers(text)) {
        for (const alias of marker.aliases) record(alias);
        lastEnd = marker.end;
      }
      let tail = '';
      for (let p = Math.max(lastEnd, text.length - MAX_MARKER_HOLD_CHARS); p < text.length; p++) {
        if (isMarkerOpener(text[p]) && isOpenMarkerPrefix(text.slice(p))) {
          tail = text.slice(p);
          break;
        }
      }
      if (tail) tails.set(textId, tail);
      else tails.delete(textId);
    },
    end(textId) {
      if (result) return;
      if (tails.delete(textId)) truncatedMarkers++;
    },
    finish() {
      if (!result) {
        truncatedMarkers += tails.size;
        tails.clear();
        result = { valid: [...valid], invalidCitations, invalidAliases: [...invalidAliases] };
        if (truncatedMarkers > 0) result.truncatedMarkers = truncatedMarkers;
      }
      return { ...result, valid: [...result.valid], invalidAliases: [...result.invalidAliases] };
    },
  };
}

export function parseAnswerMarkers(text: string, aliases: ReadonlySet<string>): MarkerParseResult {
  const parser = createMarkerParser({ aliases });
  parser.feed('answer', text);
  parser.end('answer');
  return parser.finish();
}
