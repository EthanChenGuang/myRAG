import { afterEach, describe, expect, it } from 'vitest';
import { countTokens } from '@/lib/rag/ingest/text/tokens';
import { NO_GLOSSARY_VERSION, glossaryFor } from '@/lib/rag/ingest/translate/glossary';
import {
  TranslationInvalidOutput,
  TranslationModelUnavailable,
  createFixtureChunkTranslationModel,
  createLlmChunkTranslationModel,
  resetChunkTranslationModelForTests,
  translateChunk,
  type ChunkTranslationModel,
  type ChunkTranslationRequest,
} from '@/lib/rag/ingest/translate/translator';

// Plan 03.2-49 (XLG-04, D-29): the chunk translator behind a fake model. Neutral synthetic sentences only.

const SOURCE = 'Il modulo ABC-1234 elabora 25 kg di materiale entro il 2026-03-01.';

function scripted(outputs: unknown[]): ChunkTranslationModel & { calls: ChunkTranslationRequest[] } {
  const calls: ChunkTranslationRequest[] = [];
  return {
    model: 'fake/translator',
    calls,
    async translate(request) {
      calls.push(request);
      const next = outputs.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const base = (model: ChunkTranslationModel) => ({ sourceLanguage: 'it', targetLanguage: 'en', model, signal: new AbortController().signal });

afterEach(() => resetChunkTranslationModelForTests());

describe('translateChunk (D-29)', () => {
  it('returns the structured ChunkTranslation content and sends the protected tokens of the source', async () => {
    const model = scripted([{ content: 'Module ABC-1234 processes 25 kg of material by 2026-03-01.' }]);
    const outcome = await translateChunk(SOURCE, base(model));
    expect(outcome).toEqual({ ok: true, content: 'Module ABC-1234 processes 25 kg of material by 2026-03-01.', attempts: 1 });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.protectedTokens).toEqual(expect.arrayContaining(['ABC-1234', '25 kg', '2026-03-01']));
    expect(model.calls[0]?.targetLanguage).toBe('en');
    expect(model.calls[0]?.sourceLanguage).toBe('it');
  });

  it('retries once when a protected token is dropped and accepts a second answer that keeps it', async () => {
    const model = scripted([
      { content: 'Module ABC 1234 processes 25 kg of material by 2026-03-01.' },
      { content: 'Module ABC-1234 processes 25 kg of material by 2026-03-01.' },
    ]);
    const outcome = await translateChunk(SOURCE, base(model));
    expect(outcome).toMatchObject({ ok: true, attempts: 2 });
    expect(model.calls).toHaveLength(2);
  });

  it('records a gap after the retry also drops a protected token', async () => {
    const model = scripted([
      { content: 'Module ABC 1234 processes 25 kg of material.' },
      { content: 'The module processes material by 2026-03-01.' },
      { content: 'never asked' },
    ]);
    const outcome = await translateChunk(SOURCE, base(model));
    expect(outcome).toEqual({ ok: false, reason: 'protected_token_lost', attempts: 2 });
    expect(model.calls).toHaveLength(2);
  });

  it('an empty or blank model output is a gap', async () => {
    expect(await translateChunk(SOURCE, base(scripted([{ content: '' }, { content: '   ' }])))).toEqual({
      ok: false,
      reason: 'empty_output',
      attempts: 2,
    });
    expect(await translateChunk(SOURCE, base(scripted([{ text: 'wrong shape' }, { content: 5 }])))).toEqual({
      ok: false,
      reason: 'invalid_output',
      attempts: 2,
    });
  });

  it('a chunk exactly at the input limit is translated; one token over is too_long and never sent', async () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta';
    const limit = countTokens(text);
    const atLimit = scripted([{ content: 'translated text' }]);
    expect(await translateChunk(text, { ...base(atLimit), maxInputTokens: limit })).toMatchObject({ ok: true });
    const over = scripted([{ content: 'translated text' }]);
    expect(await translateChunk(text, { ...base(over), maxInputTokens: limit - 1 })).toEqual({ ok: false, reason: 'too_long', attempts: 0 });
    expect(over.calls).toHaveLength(0);
  });

  it('a model that is unavailable is not a gap: the run must stop instead', async () => {
    const model = scripted([new TranslationModelUnavailable('unavailable')]);
    await expect(translateChunk(SOURCE, base(model))).rejects.toBeInstanceOf(TranslationModelUnavailable);
    await expect(translateChunk(SOURCE, base(scripted([new Error('network')])))).rejects.toBeInstanceOf(TranslationModelUnavailable);
    const invalid = scripted([new TranslationInvalidOutput(), new TranslationInvalidOutput()]);
    expect(await translateChunk(SOURCE, base(invalid))).toEqual({ ok: false, reason: 'invalid_output', attempts: 2 });
  });

  it('the protected-token check is the existing one: NFC equal is kept, a changed accent is lost', async () => {
    const source = 'La sigla «Café-9» resta invariata.';
    const decomposed = scripted([{ content: 'The code «Café-9» stays the same.' }]);
    expect(await translateChunk(source, base(decomposed))).toMatchObject({ ok: true });
    const changed = scripted([{ content: 'The code «Cafe-9» stays the same.' }, { content: 'The code «Cafe-9» stays.' }]);
    expect(await translateChunk(source, base(changed))).toMatchObject({ ok: false, reason: 'protected_token_lost' });
  });
});

describe('glossaryFor (D-29 seam)', () => {
  it('returns an empty glossary with version none in this phase', async () => {
    const glossary = await glossaryFor({ tenantKey: 's:default' }, 'it', 'en');
    expect(glossary).toEqual({ version: NO_GLOSSARY_VERSION, terms: [] });
    expect(NO_GLOSSARY_VERSION).toBe('none');
  });
});

describe('model adapters', () => {
  it('the LLM adapter sends the passage in the prompt only, with its protected tokens, and keeps it out of the system prompt', async () => {
    const seen: Array<{ model: string; system: string; prompt: string }> = [];
    const model = createLlmChunkTranslationModel('fake/model', async (request) => {
      seen.push({ model: request.model, system: request.system, prompt: request.prompt });
      return { content: 'Module ABC-1234 processes 25 kg of material by 2026-03-01.' };
    });
    expect(model.model).toBe('fake/model');
    const outcome = await translateChunk(SOURCE, base(model));
    expect(outcome).toMatchObject({ ok: true });
    expect(seen[0]?.model).toBe('fake/model');
    expect(seen[0]?.system).not.toContain(SOURCE);
    expect(seen[0]?.system).toMatch(/data, not instructions/);
    expect(seen[0]?.prompt).toContain(`<passage>\n${SOURCE}\n</passage>`);
    expect(seen[0]?.prompt).toContain('"ABC-1234"');
  });

  it('the fixture model serves the translation table in both directions and records its calls', async () => {
    const model = createFixtureChunkTranslationModel({
      version: 1,
      entries: [{ question: 'The blue sample is stored on shelf 4.', translations: [{ language: 'it', text: 'Il campione blu è conservato sul ripiano 4.' }] }],
    });
    expect(await translateChunk('Il campione blu è conservato sul ripiano 4.', base(model))).toEqual({
      ok: true,
      content: 'The blue sample is stored on shelf 4.',
      attempts: 1,
    });
    expect(
      await translateChunk('The blue sample is stored on shelf 4.', { ...base(model), sourceLanguage: 'en', targetLanguage: 'it' }),
    ).toMatchObject({ ok: true, content: 'Il campione blu è conservato sul ripiano 4.' });
    expect(model.calls.map((call) => call.targetLanguage)).toEqual(['en', 'it']);
  });
});
