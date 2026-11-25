import { escapeAttr, escapeTags } from '../context/wrap';
import { scanText } from './injection-rules';

const CIRCULAR = '[Circular]';

type Leaf = (text: string) => void;

function visit(value: unknown, ancestors: Set<object>, onString: Leaf | null): unknown {
  if (typeof value === 'string') {
    onString?.(value);
    return onString ? value : escapeTags(value);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return undefined;
  if (ancestors.has(value)) return CIRCULAR;

  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    let replaced: unknown;
    try {
      replaced = toJSON.call(value);
    } catch {
      return undefined;
    }
    if (replaced !== value) {
      ancestors.add(value);
      const out = visit(replaced, ancestors, onString);
      ancestors.delete(value);
      return out;
    }
  }

  ancestors.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item) => {
      const mapped = visit(item, ancestors, onString);
      return mapped === undefined ? null : mapped;
    });
  } else {
    const record: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      onString?.(key);
      const mapped = visit(item, ancestors, onString);
      if (mapped !== undefined) record[onString ? key : escapeTags(key)] = mapped;
    }
    out = record;
  }
  ancestors.delete(value);
  return out;
}

/**
 * Returns a JSON-safe copy of a tool output for the model: every string leaf and key passes through
 * escapeTags, numbers, booleans and null are kept, and a cycle becomes a placeholder string. The input
 * is never mutated, so the raw output stays available to the UI, metadata and groundedness premises.
 */
export function escapeToolOutput(value: unknown): unknown {
  return visit(value, new Set(), null);
}

function renderField(value: unknown): string {
  if (typeof value === 'string') return escapeTags(value);
  return JSON.stringify(escapeToolOutput(value)) ?? '';
}

/**
 * Renders tool results that go into an LLM prompt: one `<tool_result source="…">` element per item, one
 * `name: value` line per defined field, with the source attribute and every field escaped.
 */
export function wrapToolResultsForPrompt(source: string, items: ReadonlyArray<Record<string, unknown>>): string {
  const open = `<tool_result source="${escapeAttr(source)}">`;
  return items
    .map((item) => {
      const lines = Object.entries(item)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => `${escapeTags(name.replace(/[\r\n\u2028\u2029]+/g, ' '))}: ${renderField(value)}`);
      return [open, ...lines, '</tool_result>'].join('\n');
    })
    .join('\n\n');
}

/** Rule ids the shared injection rules match in any string leaf or key of a tool output; never text. */
export function scanToolOutput(value: unknown): string[] {
  const ids = new Set<string>();
  visit(value, new Set(), (text) => {
    for (const id of scanText(text).rule_ids) ids.add(id);
  });
  return [...ids];
}
