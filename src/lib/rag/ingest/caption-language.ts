import { detectLanguage } from '../lang/detect';
import { getLanguagePack, registryOrder } from '../lang/registry';
import { getLanguageSettings } from '../lang/settings';
import { IMAGE_CAPTION_PROMPT } from './captioner';

/**
 * D-23: the one sentence appended to the English caption instruction under RAG_CAPTION_LANGUAGE=document. It is fixed text around the
 * registry's native name of the target language; nothing from a document or an image ever reaches it.
 */
function languageSentence(nativeName: string): string {
  return `Write the whole description in ${nativeName}, and quote any text visible in the image exactly as written in its original language, without translating or transliterating it.`;
}

/** One language and its share of the tenant's current documents, as rag_tenant_language_shares answers. */
export interface LanguageShare {
  language: string;
  share: number;
}

export type ShareLookup = (tenantKey: string) => Promise<LanguageShare[]>;

export interface ResolveCaptionLanguageInput {
  /** The document's own language (detected on its text); null for a picture upload with no text. */
  documentLanguage: string | null;
  tenantKey: string;
  /** Reads the tenant's language shares; a failure falls through to the primary language. */
  lookupShares?: ShareLookup;
}

let warnedUnset = false;

/** The prompt for a target language: the pinned English instruction plus one sentence naming the language. Unknown code: the pinned prompt. */
export function captionPromptFor(targetCode: string | null | undefined): string {
  if (!targetCode) return IMAGE_CAPTION_PROMPT;
  const pack = getLanguagePack(targetCode);
  if (!pack) return IMAGE_CAPTION_PROMPT;
  return `${IMAGE_CAPTION_PROMPT} ${languageSentence(pack.native_name)}`;
}

/**
 * The language a caption is asked for (D-23): the document's language, else the language with the largest share of the tenant's
 * documents (ties in registry order), else RAG_PRIMARY_LANGUAGE. Only languages of the configured set count. Without configured
 * languages there is no target: the caption keeps the English instruction, and one warning names the switch.
 */
export async function resolveCaptionLanguage(input: ResolveCaptionLanguageInput): Promise<string | null> {
  const settings = getLanguageSettings();
  if (!settings.configured || settings.primary === null) {
    if (!warnedUnset) {
      warnedUnset = true;
      console.warn('[Ingest] RAG_CAPTION_LANGUAGE=document needs RAG_SUPPORTED_LANGUAGES and RAG_PRIMARY_LANGUAGE; captions are asked for in English');
    }
    return null;
  }
  const enabled = new Set(settings.languages);
  if (input.documentLanguage !== null && enabled.has(input.documentLanguage)) return input.documentLanguage;

  if (input.lookupShares) {
    try {
      const shares = (await input.lookupShares(input.tenantKey)).filter(
        (entry) => enabled.has(entry.language) && Number.isFinite(entry.share) && entry.share > 0,
      );
      if (shares.length > 0) {
        const top = Math.max(...shares.map((entry) => entry.share));
        const leaders = registryOrder(shares.filter((entry) => entry.share === top).map((entry) => entry.language));
        if (leaders[0]) return leaders[0];
      }
    } catch (error) {
      console.warn('[Ingest] tenant language shares unavailable; captions use the primary language', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return settings.primary;
}

/** The language of a caption as written, among the configured languages; null when it cannot be told. */
export function captionLanguageOf(caption: string): string | null {
  const settings = getLanguageSettings();
  return detectLanguage(caption, settings.configured ? settings.languages : undefined);
}

export function resetCaptionLanguageWarningForTests(): void {
  warnedUnset = false;
}
