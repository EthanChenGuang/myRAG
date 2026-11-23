import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CORPUS_LANGUAGES = ['zh', 'en', 'it'] as const;
export type CorpusLanguage = (typeof CORPUS_LANGUAGES)[number];

const DEFAULT_CREATED_AT = '2025-01-15T00:00:00.000Z';
const META_RE = /^<!--\s*fixture-meta\s+(\{.*\})\s*-->\s*$/;
const CHUNK_MARKER = '<!-- chunk -->';

export interface CorpusChunk {
  index: number;
  id: string;
  section: string;
  text: string;
  stored: string;
}

export interface CorpusDocument {
  relpath: string;
  language: CorpusLanguage;
  filename: string;
  imageUrl: string | null;
  createdAt: string;
  id: string;
  content: string;
  chunks: CorpusChunk[];
}

export interface LoadedCorpus {
  documents: CorpusDocument[];
  corpusSha256: string;
}

function uuidFromDigest(label: string): string {
  const hex = crypto.createHash('sha256').update(label).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function firstHeading(text: string): string {
  for (const line of text.split('\n')) {
    const match = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (match) return match[1];
  }
  return '';
}

function parseMeta(line: string, relpath: string): Record<string, unknown> {
  const match = META_RE.exec(line.trim());
  if (!match) return {};
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through to the explicit error below
  }
  throw new Error(`[Fixture Corpus] invalid fixture-meta JSON in ${relpath}`);
}

export function loadCorpus(corpusDir: string): LoadedCorpus {
  const relpaths: string[] = [];
  for (const language of CORPUS_LANGUAGES) {
    const langDir = path.join(corpusDir, language);
    if (!fs.existsSync(langDir)) continue;
    for (const name of fs.readdirSync(langDir)) {
      if (!name.endsWith('.md')) continue;
      if (!fs.statSync(path.join(langDir, name)).isFile()) continue;
      relpaths.push(`${language}/${name}`);
    }
  }
  relpaths.sort();

  const hash = crypto.createHash('sha256');
  const documents: CorpusDocument[] = [];

  for (const relpath of relpaths) {
    const bytes = fs.readFileSync(path.join(corpusDir, relpath));
    hash.update(relpath);
    hash.update(Buffer.from([0]));
    hash.update(bytes);

    const lines = bytes.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    const meta = META_RE.test(lines[0]?.trim() ?? '') ? parseMeta(lines.shift() as string, relpath) : {};
    const language = relpath.split('/')[0] as CorpusLanguage;
    const filename = typeof meta.filename === 'string' ? meta.filename : path.posix.basename(relpath);

    const parts: string[] = [];
    let current: string[] = [];
    for (const line of lines) {
      if (line === CHUNK_MARKER) {
        parts.push(current.join('\n'));
        current = [];
      } else {
        current.push(line);
      }
    }
    parts.push(current.join('\n'));
    const texts = parts.map((part) => part.trim()).filter((part) => part.length > 0);

    documents.push({
      relpath,
      language,
      filename,
      imageUrl: typeof meta.image_url === 'string' ? meta.image_url : null,
      createdAt: typeof meta.created_at === 'string' ? meta.created_at : DEFAULT_CREATED_AT,
      id: uuidFromDigest(`doc:${relpath}`),
      content: texts.join('\n\n'),
      chunks: texts.map((text, index) => ({
        index,
        id: uuidFromDigest(`chunk:${relpath}:${index}`),
        section: firstHeading(text),
        text,
        stored: `Document: ${filename}. Chunk ${index + 1} of ${texts.length}. Content: ${text}`,
      })),
    });
  }

  return { documents, corpusSha256: hash.digest('hex') };
}
