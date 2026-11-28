import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.join(__dirname, '../../scripts/config-ui/index.html'), 'utf8');

function card(): string {
  const start = html.indexOf('<!-- Query layer -->');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('<!-- Ingestion and embedding profiles -->', start);
  return html.slice(start, end);
}

function tag(section: string, id: string): string {
  const match = new RegExp(`<(?:input|select)[^>]*\\bid="${id}"[^>]*>`).exec(section);
  expect(match, id).not.toBeNull();
  return match![0];
}

describe('Config UI Query layer card', () => {
  it('sits right after the Retrieval pipeline card', () => {
    const retrieval = html.indexOf('<!-- Retrieval pipeline -->');
    const query = html.indexOf('<!-- Query layer -->');
    const ingestion = html.indexOf('<!-- Ingestion and embedding profiles -->');
    expect(retrieval).toBeGreaterThan(-1);
    expect(query).toBeGreaterThan(retrieval);
    expect(ingestion).toBeGreaterThan(query);
    expect(html.slice(retrieval, query)).not.toContain('<!-- Ingestion');
  });

  it('shows the master switch off and the recommended transform profile on', () => {
    const section = card();
    expect(tag(section, 'RAG_QUERY_LAYER')).toMatch(/type="checkbox"/);
    expect(tag(section, 'RAG_QUERY_LAYER')).not.toMatch(/\bchecked\b/);
    for (const id of ['RAG_QUERY_CONDENSE', 'RAG_QUERY_EXPAND', 'RAG_QUERY_DECOMPOSE', 'RAG_QUERY_TRANSLATE', 'RAG_QUERY_DATE_NORMALIZE']) {
      expect(tag(section, id)).toMatch(/type="checkbox"[^>]*\bchecked\b/);
    }
    expect(tag(section, 'RAG_QUERY_HYDE')).not.toMatch(/\bchecked\b/);
    expect(tag(section, 'RAG_SEMANTIC_CACHE_EMBED_STORE')).not.toMatch(/\bchecked\b/);
  });

  it('offers the framework and cache backend choices with the off defaults selected', () => {
    const section = card();
    expect(section).toMatch(/<option value="llamaindex" selected>/);
    expect(section).toMatch(/<option value="langchain">/);
    expect(section).toMatch(/<option value="off" selected>off<\/option>\s*<option value="pgvector">pgvector<\/option>\s*<option value="redisvl">redisvl<\/option>/);
    for (const id of ['RAG_QUERY_LLM_MODEL', 'RAG_QUERY_VOICE_TRANSFORMS', 'RAG_QUERY_TRANSLATE_DISABLED_PROFILES']) {
      expect(tag(section, id)).toMatch(/type="text"/);
    }
    for (const id of ['RAG_SEMANTIC_CACHE_TTL', 'RAG_SEMANTIC_CACHE_REFUSAL_TTL', 'RAG_SEMANTIC_CACHE_MAX_DISTANCE']) {
      expect(tag(section, id)).toMatch(/type="number"/);
    }
  });

  it('carries the HyDE, voice and embed help text', () => {
    const text = card().replace(/<[^>]+>/g, '');
    expect(text).toContain('HyDE is off by default and is never used in voice');
    expect(text).toContain('allowed: condense_history, normalize_dates, translate; voice always uses the native condense');
    expect(text).toContain('embed widget answers are only read from the cache unless this is on');
  });

  it('keeps REDIS_URL a password field next to the cache backend', () => {
    const section = card();
    expect(tag(section, 'REDIS_URL')).toMatch(/type="password"/);
    expect(tag(section, 'REDIS_URL')).toMatch(/autocomplete="off"/);
    expect(section.indexOf('id="REDIS_URL"')).toBeGreaterThan(section.indexOf('id="RAG_SEMANTIC_CACHE"'));
    expect(section).toMatch(/Used by the sidecar for the <span translate="no">redisvl<\/span> backend/);
  });
});
