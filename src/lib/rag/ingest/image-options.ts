const MAX_URL_LENGTH = 2048;
const MAX_CONTEXT_LENGTH = 2000;

function hasControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The public URL of a stored picture, as it will be shown to the chat: http or https, no spaces or control characters, at most 2048 characters. Null otherwise. */
export function validImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > MAX_URL_LENGTH || hasControlOrSpace(value)) return null;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

/** The free text an uploader gave a picture: a non-empty string, trimmed and capped. Null otherwise. */
export function imageContextOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, MAX_CONTEXT_LENGTH);
  return text === '' ? null : text;
}
