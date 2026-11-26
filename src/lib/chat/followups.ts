export interface FollowupSplit {
  body: string;
  followups: string[];
}

export const MAX_FOLLOWUPS = 5;

const RULE_LINE = /^ {0,3}---\s*$/;
const FOLLOWUP_LINE = /^\s*(?:↳|->|→)\s+(\S.*?)\s*$/;
const FENCE_LINE = /^ {0,3}(```|~~~)/;
const INLINE_ARROW = /\s+(?:↳|→)\s+/;

function insideFence(lines: readonly string[], end: number): boolean {
  let open: string | null = null;
  for (let i = 0; i < end; i++) {
    const m = FENCE_LINE.exec(lines[i]);
    if (!m) continue;
    if (open === null) open = m[1];
    else if (m[1] === open) open = null;
  }
  return open !== null;
}

/**
 * Splits a trailing "related questions" block (a `---` line followed only by
 * 1–5 `↳ `, `-> ` or `→ ` lines) off a completed assistant answer.
 * Text without such a tail is returned unchanged with no follow-ups.
 */
export function splitFollowups(text: string): FollowupSplit {
  const unchanged: FollowupSplit = { body: text, followups: [] };
  if (!text) return unchanged;

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const followups: string[] = [];
  let i = lines.length - 1;

  for (; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const m = FOLLOWUP_LINE.exec(line);
    if (!m) break;
    const questions = m[1].split(INLINE_ARROW).map((q) => q.trim()).filter(Boolean);
    followups.unshift(...questions);
    if (followups.length > MAX_FOLLOWUPS) return unchanged;
  }

  if (i < 0 || followups.length === 0 || !RULE_LINE.test(lines[i])) return unchanged;
  if (insideFence(lines, i)) return unchanged;

  return { body: lines.slice(0, i).join('\n').trimEnd(), followups };
}

/**
 * Puts every follow-up line (`↳ `, `-> `, `→ `) outside code fences in its own markdown paragraph,
 * so lines separated by a single newline are not joined into one paragraph when the tail is
 * rendered as markdown (while streaming, or when it cannot be split off).
 */
export function separateFollowupLines(text: string): string {
  if (!text || !/(?:↳|->|→)/.test(text)) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const f = FENCE_LINE.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1] === fence) fence = null;
    }
    if (fence === null && !f && FOLLOWUP_LINE.test(line)) {
      const prev = out[out.length - 1];
      if (prev !== undefined && prev.trim() !== '') out.push('');
    }
    out.push(line);
  }
  return out.join('\n');
}
