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

  // Plan 07-20: the master switch, the transforms and the voice and profile fields moved to the generated RAG pipeline
  // section; their rows are asserted in config-rag-pipeline-panel.test.ts and their defaults come from the manifest.
  const MOVED = ['RAG_QUERY_LAYER', 'RAG_QUERY_CONDENSE', 'RAG_QUERY_EXPAND', 'RAG_QUERY_DECOMPOSE', 'RAG_QUERY_TRANSLATE', 'RAG_QUERY_DATE_NORMALIZE', 'RAG_QUERY_HYDE', 'RAG_QUERY_VOICE_TRANSFORMS', 'RAG_QUERY_TRANSLATE_DISABLED_PROFILES'];
  const manifest = new Map(
    (JSON.parse(fs.readFileSync(path.join(__dirname, '../../scripts/rag/env-manifest.json'), 'utf8')) as { vars: Array<{ name: string; type?: string; default?: string; help?: string }> }).vars.map((v) => [v.name, v]),
  );

  it('shows the master switch off and the recommended transform profile on (manifest defaults of the generated rows)', () => {
    const section = card();
    for (const id of MOVED) expect(section, id).not.toMatch(new RegExp(`<(?:input|select)[^>]*\\bid="${id}"`));
    expect(manifest.get('RAG_QUERY_LAYER')).toMatchObject({ type: 'bool', default: 'false' });
    for (const id of ['RAG_QUERY_CONDENSE', 'RAG_QUERY_EXPAND', 'RAG_QUERY_DECOMPOSE', 'RAG_QUERY_TRANSLATE', 'RAG_QUERY_DATE_NORMALIZE']) {
      expect(manifest.get(id), id).toMatchObject({ type: 'bool', default: 'true' });
    }
    expect(manifest.get('RAG_QUERY_HYDE')).toMatchObject({ type: 'bool', default: 'false' });
    expect(tag(section, 'RAG_SEMANTIC_CACHE_EMBED_STORE')).not.toMatch(/\bchecked\b/);
  });

  it('offers the framework and cache backend choices with the off defaults selected', () => {
    const section = card();
    expect(section).toMatch(/<option value="llamaindex" selected>/);
    expect(section).toMatch(/<option value="langchain">/);
    expect(section).toMatch(/<option value="off" selected>off<\/option>\s*<option value="pgvector">pgvector<\/option>\s*<option value="redisvl">redisvl<\/option>/);
    expect(tag(section, 'RAG_QUERY_LLM_MODEL')).toMatch(/type="text"/);
    for (const id of ['RAG_QUERY_VOICE_TRANSFORMS', 'RAG_QUERY_TRANSLATE_DISABLED_PROFILES']) expect(manifest.get(id)?.type, id).toBe('string');
    for (const id of ['RAG_SEMANTIC_CACHE_TTL', 'RAG_SEMANTIC_CACHE_REFUSAL_TTL', 'RAG_SEMANTIC_CACHE_MAX_DISTANCE']) {
      expect(tag(section, id)).toMatch(/type="number"/);
    }
  });

  it('carries the HyDE, voice and embed help text (the first two now as manifest help of the generated rows)', () => {
    const text = card().replace(/<[^>]+>/g, '');
    expect(manifest.get('RAG_QUERY_HYDE')?.help).toContain('HyDE is off by default and is never used in voice');
    expect(manifest.get('RAG_QUERY_VOICE_TRANSFORMS')?.help).toContain('allowed: condense_history, normalize_dates, translate; voice always uses the native condense');
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
