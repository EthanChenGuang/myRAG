import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParseResult } from '@/lib/rag-eval/contracts.generated';
import { ingest } from '@/lib/rag/ingest';
import { captionPromptFor, resetCaptionLanguageWarningForTests, resolveCaptionLanguage } from '@/lib/rag/ingest/caption-language';
import { IMAGE_CAPTION_PROMPT, resetCaptionerForTests } from '@/lib/rag/ingest/captioner';
import { resetPublicImageStoreForTests } from '@/lib/rag/ingest/images/public-store';
import { resetLlamaParseParserForTests, setLlamaParseParserForTests } from '@/lib/rag/ingest/parsers/llamaparse-v2';
import { ParserError, type DocumentParser, type ParseArtifact } from '@/lib/rag/ingest/parsers/shared';
import { resetSidecarParserForTests, setSidecarParserForTests } from '@/lib/rag/ingest/parsers/sidecar-docling';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { resetInjectionRulesForTests } from '@/lib/rag/security/injection-scan';
import { mintScope } from '@/lib/rag/tenant/scope';
import { callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps, type RecordedRpc } from '../helpers/ingest-fakes';
import { fixtureBytes } from '../helpers/fake-sidecar';
import { installFakePublicImageStore } from '../helpers/fake-public-image-store';

const generateText = vi.hoisted(() => vi.fn());
vi.mock('ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('ai')>()), generateText }));

const RECORDED_DIR = join(process.cwd(), 'eval/fixtures/ingest/recorded');
const PARSE_EN = JSON.parse(readFileSync(join(RECORDED_DIR, 'images-en.parse.json'), 'utf8')) as ParseResult;
const PICTURE_1 = new Uint8Array(readFileSync(join(RECORDED_DIR, 'images-en.picture-1.png')));
const PICTURE_2 = new Uint8Array(readFileSync(join(RECORDED_DIR, 'images-en.picture-2.png')));
const ARTIFACTS: ParseArtifact[] = [
  { name: 'picture-1.png', bytes: PICTURE_1, contentType: 'image/png' },
  { name: 'picture-2.png', bytes: PICTURE_2, contentType: 'image/png' },
];

/** The images fixture with its text in Chinese (neutral synthetic sentences); pictures and pages unchanged. */
const ZH_TEXT_1 = '这是一份用于测试文档解析的示例说明，内容完全是虚构的。图一显示示例设备的正面。';
const ZH_TEXT_2 = '背面有两个接口和一个状态指示灯，这一段同样只用于测试。图二显示示例设备的背面。';
const PARSE_ZH: ParseResult = {
  ...PARSE_EN,
  markdown: `## 示例设备说明\n\n${ZH_TEXT_1}\n\n<!-- image -->\n\n### 背面\n\n${ZH_TEXT_2}\n\n<!-- image -->`,
  chunks: PARSE_EN.chunks.map((chunk, index) => ({
    ...chunk,
    headings: index === 0 ? ['示例设备说明'] : ['示例设备说明', '背面'],
    text: index === 0 ? ZH_TEXT_1 : ZH_TEXT_2,
    contextualized_text: index === 0 ? ZH_TEXT_1 : ZH_TEXT_2,
  })),
};

/** A Chinese caption quoting a word with an accented vowel, and an English one. */
const ZH_CAPTION = '图片中是一张白色卡片，卡片中央印着“Novità”这个词，下方有三条蓝色横线。';
const EN_CAPTION = 'A white card with the word Novità printed in the centre and three blue lines underneath it.';

const scope = mintScope('single', null, null);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  generateText.mockReset();
  resetLanguageSettingsForTests();
  resetCaptionLanguageWarningForTests();
});

afterEach(() => {
  resetCaptionerForTests();
  resetInjectionRulesForTests();
  resetSidecarParserForTests();
  resetLlamaParseParserForTests();
  resetPublicImageStoreForTests();
  uninstallIngestDeps();
  vi.unstubAllEnvs();
  resetLanguageSettingsForTests();
  vi.restoreAllMocks();
});

function installParser(result: ParseResult): void {
  const docling: DocumentParser = {
    name: 'docling',
    unavailableReason: () => null,
    async parse() {
      return { kind: 'done', result, artifacts: ARTIFACTS, warnings: [] };
    },
  };
  const llamaparse: DocumentParser = {
    name: 'llamaparse',
    unavailableReason: () => 'missing_key',
    async parse() {
      throw new ParserError('llamaparse', 'missing_key');
    },
  };
  setSidecarParserForTests(docling);
  setLlamaParseParserForTests(llamaparse);
}

function uploadPdf() {
  return ingest({
    scope,
    source: 'config_upload',
    sourceKey: 'root/images.pdf',
    file: fixtureBytes('images-en'),
    filename: 'images.pdf',
    mimeType: 'application/pdf',
    docType: 'product_technical',
    signal: new AbortController().signal,
  } as Parameters<typeof ingest>[0]);
}

/** The text part of every vision call, in order. */
function promptsSent(): string[] {
  return generateText.mock.calls.map((call) => {
    const params = call[0] as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    return params.messages[0]!.content.find((part) => part.type === 'text')!.text as string;
  });
}

const writtenChunks = (calls: RecordedRpc[]) => callsOf(calls, 'rag_write_chunks').flatMap((call) => call.args.p_chunks as Array<Record<string, any>>);
const imageLanguageItems = (calls: RecordedRpc[]) =>
  callsOf(calls, 'rag_set_image_chunk_languages').flatMap((call) => call.args.p_items as Array<{ image_url: string; language: string }>);

async function runPdf(parse: ParseResult, env: Record<string, string>, caption: string) {
  installParser(parse);
  generateText.mockResolvedValue({ text: caption });
  const { db, calls } = fakeIngestDb();
  installIngestDeps({ db, env: { RAG_PDF_IMAGE_CHUNKS: 'true', RAG_INJECTION_SCAN: 'quarantine', ...env } });
  installFakePublicImageStore();
  const result = await uploadPdf();
  return { result, calls };
}

describe('captionPromptFor', () => {
  it('appends exactly one sentence naming the registry native name and the quoting rule', () => {
    const prompt = captionPromptFor('zh');
    expect(prompt.startsWith(`${IMAGE_CAPTION_PROMPT} `)).toBe(true);
    const sentence = prompt.slice(IMAGE_CAPTION_PROMPT.length + 1);
    expect(sentence).toContain('中文');
    expect(sentence).toMatch(/quote any text visible in the image/);
    expect(sentence).toMatch(/original language/);
    expect(sentence.match(/[.!?]/g)).toEqual(['.']);
    expect(sentence.endsWith('.')).toBe(true);
    expect(captionPromptFor('it')).toContain('Italiano');
  });

  it('gives the pinned prompt for no target and for a code outside the registry', () => {
    expect(captionPromptFor(null)).toBe(IMAGE_CAPTION_PROMPT);
    expect(captionPromptFor(undefined)).toBe(IMAGE_CAPTION_PROMPT);
    expect(captionPromptFor('xx')).toBe(IMAGE_CAPTION_PROMPT);
  });
});

describe('captions of a Chinese document through the images stage', () => {
  it('with RAG_CAPTION_LANGUAGE=en sends the pinned prompt byte for byte and marks no caption language', async () => {
    const { result, calls } = await runPdf(PARSE_ZH, { RAG_CAPTION_LANGUAGE: 'en' }, ZH_CAPTION);
    expect(result.status).toBe('ready');
    expect(promptsSent()).toEqual([IMAGE_CAPTION_PROMPT, IMAGE_CAPTION_PROMPT]);
    const images = writtenChunks(calls).filter((chunk) => chunk.chunk_kind === 'image');
    expect(images).toHaveLength(2);
    expect(images.every((chunk) => !('caption_language' in chunk.metadata))).toBe(true);
    expect(callsOf(calls, 'rag_set_image_chunk_languages')).toEqual([]);
    expect(callsOf(calls, 'rag_tenant_language_shares')).toEqual([]);
  });

  it('with document asks for 中文 and stores the Chinese caption as zh with the quoted word unchanged', async () => {
    const { result, calls } = await runPdf(PARSE_ZH, { RAG_CAPTION_LANGUAGE: 'document' }, ZH_CAPTION);
    expect(result.status).toBe('ready');
    expect(promptsSent()).toEqual([captionPromptFor('zh'), captionPromptFor('zh')]);
    expect(promptsSent()[0]).toContain('中文');
    const images = writtenChunks(calls).filter((chunk) => chunk.chunk_kind === 'image');
    expect(images.map((chunk) => chunk.content)).toEqual([ZH_CAPTION, ZH_CAPTION]);
    expect(images.every((chunk) => String(chunk.content).includes('Novità'))).toBe(true);
    expect(images.map((chunk) => chunk.metadata.caption_language)).toEqual(['zh', 'zh']);
    expect(imageLanguageItems(calls)).toEqual(images.map((chunk) => ({ image_url: chunk.metadata.image_url, language: 'zh' })));
    // The document language is the document's, not resolved through the tenant shares.
    expect(callsOf(calls, 'rag_tenant_language_shares')).toEqual([]);
  });

  it('stores an English answer to a zh request as en', async () => {
    const { calls } = await runPdf(PARSE_ZH, { RAG_CAPTION_LANGUAGE: 'document' }, EN_CAPTION);
    expect(promptsSent()).toEqual([captionPromptFor('zh'), captionPromptFor('zh')]);
    const images = writtenChunks(calls).filter((chunk) => chunk.chunk_kind === 'image');
    expect(images.map((chunk) => chunk.metadata.caption_language)).toEqual(['en', 'en']);
    expect(imageLanguageItems(calls).map((item) => item.language)).toEqual(['en', 'en']);
    expect(images.every((chunk) => String(chunk.content).includes('Novità'))).toBe(true);
  });

  it('an English document under document asks for English', async () => {
    await runPdf(PARSE_EN, { RAG_CAPTION_LANGUAGE: 'document' }, EN_CAPTION);
    expect(promptsSent()).toEqual([captionPromptFor('en'), captionPromptFor('en')]);
  });
});

describe('resolveCaptionLanguage', () => {
  it('takes the document language when it is one of the configured languages', async () => {
    const lookupShares = vi.fn(async () => [{ language: 'it', share: 1 }]);
    expect(await resolveCaptionLanguage({ documentLanguage: 'zh', tenantKey: 's:default', lookupShares })).toBe('zh');
    expect(lookupShares).not.toHaveBeenCalled();
  });
});
