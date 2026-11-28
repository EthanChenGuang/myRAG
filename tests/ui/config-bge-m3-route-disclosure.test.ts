import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const panel = fs.readFileSync('scripts/config-ui/rag-panels/embedding-profiles.js', 'utf8');
const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');

/** The string of one label key in one locale block of EMBEDDING_PROFILES_LABELS. */
function label(locale: 'en' | 'zh' | 'it', key: string): string {
  const start = panel.indexOf(`  ${locale}: {`);
  expect(start, `locale ${locale}`).toBeGreaterThan(-1);
  const end = panel.indexOf('\n  },', start);
  const block = panel.slice(start, end);
  const match = new RegExp(`'${key.replace('.', '\\.')}':\\s*\\n?\\s*(['"])((?:(?!\\1).)*)\\1`).exec(block);
  expect(match, `${locale} ${key}`).not.toBeNull();
  return match![2]!;
}

function htmlHelp(id: string): string {
  const match = new RegExp(`id="${id}"><span data-rag-i18n="[^"]+">([^<]*)</span>`).exec(html);
  expect(match, id).not.toBeNull();
  return match![1]!;
}

describe('BGE-M3 route help names OpenRouter as a recipient of text (OR-2)', () => {
  it('via.help says document and query text is sent to OpenRouter, in en, zh and it', () => {
    expect(label('en', 'via.help')).toMatch(/document and query text is sent to OpenRouter/);
    expect(label('zh', 'via.help')).toMatch(/文档和查询文本会发送到 OpenRouter/);
    expect(label('it', 'via.help')).toMatch(/testo di documenti e query viene inviato a OpenRouter/);
  });

  it('serving.help names OpenRouter for the hosted mode, in en, zh and it', () => {
    expect(label('en', 'serving.help')).toContain('OpenRouter');
    expect(label('zh', 'serving.help')).toContain('OpenRouter');
    expect(label('it', 'serving.help')).toContain('OpenRouter');
  });

  it('the static HTML fallback for via.help carries the English text', () => {
    expect(htmlHelp('rag-bge-m3-via-help')).toBe(label('en', 'via.help'));
  });
});
