import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const html = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/config-ui/index.html'), 'utf8');

function functionSource(name: string): string {
  const start = html.indexOf(`async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < html.length; index++) {
    const char = html[index];
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error('unbalanced function');
}

function element(overrides: Record<string, unknown> = {}) {
  return { value: '', files: [], disabled: false, innerHTML: '', className: '', textContent: '', classList: { remove() {}, add() {} }, ...overrides };
}

describe('Config UI image upload (W5)', () => {
  it('tells /api/upload the request comes from the Config UI', async () => {
    const posted: Array<{ url: string; body: FormData }> = [];
    const elements: Record<string, ReturnType<typeof element>> = {
      'kb-image-context': element({ value: 'a caption' }),
      'kb-upload-status': element(),
      'kb-upload-btn': element(),
      'kb-image-upload': element({ files: [new Blob(['x'], { type: 'image/png' })] }),
    };
    const context = vm.createContext({
      document: { getElementById: (id: string) => elements[id] },
      FormData,
      fetch: vi.fn(async (url: string, init: { body: FormData }) => {
        posted.push({ url, body: init.body });
        return { ok: true, json: async () => ({ uploaded: 1 }) };
      }),
      showNotification: () => {},
      clearSelectedImages: () => {},
      setTimeout: () => 0,
      window: { loadUploadedImages: () => {} },
      console,
    });
    vm.runInContext(`${functionSource('uploadKBImage')}\nglobalThis.uploadKBImage = uploadKBImage;`, context);

    await (context as unknown as { uploadKBImage: () => Promise<void> }).uploadKBImage();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe('/api/upload');
    expect(posted[0]?.body.get('upload_source')).toBe('config_upload');
    expect(posted[0]?.body.get('process_rag')).toBe('true');
    expect(posted[0]?.body.get('image_context')).toBe('a caption');
  });
});
