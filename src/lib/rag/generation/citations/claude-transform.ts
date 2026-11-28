import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';
import type { AliasMap } from './blocks';

export interface ClaudeCitation {
  alias: string;
  citedText: string;
  startCharIndex: number | null;
  endCharIndex: number | null;
}

export interface ClaudeCitationSink {
  cite(citation: ClaudeCitation): void;
  invalid(filename: string | null): void;
}

type SourcePart = Extract<TextStreamPart<ToolSet>, { type: 'source' }>;

function anthropicMetadata(part: SourcePart): Record<string, unknown> {
  const meta = part.providerMetadata?.anthropic;
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Turns Anthropic document citations into [S<k>] markers (D-01, research Pattern 4): source parts are
 * swallowed, each cited alias is queued once per text block, and the markers are emitted as one
 * text-delta right before that block's text-end. Sources naming a document that was not sent are dropped.
 */
export function claudeMarkerTransform(
  aliasMap: Pick<AliasMap, 'aliases'>,
  sink: ClaudeCitationSink,
): StreamTextTransform<ToolSet> {
  return () => {
    let pending: string[] = [];
    return new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
      transform(part, controller) {
        if (part.type === 'source' && part.sourceType === 'document') {
          const alias = part.filename ?? null;
          if (alias === null || !aliasMap.aliases.has(alias)) {
            sink.invalid(alias);
            return;
          }
          const meta = anthropicMetadata(part);
          sink.cite({
            alias,
            citedText: typeof meta.citedText === 'string' ? meta.citedText : '',
            startCharIndex: numberOrNull(meta.startCharIndex),
            endCharIndex: numberOrNull(meta.endCharIndex),
          });
          if (!pending.includes(alias)) pending.push(alias);
          return;
        }
        if (part.type === 'text-end' && pending.length > 0) {
          controller.enqueue({ type: 'text-delta', id: part.id, text: pending.map((alias) => `[${alias}]`).join('') });
          pending = [];
        }
        controller.enqueue(part);
      },
    });
  };
}
