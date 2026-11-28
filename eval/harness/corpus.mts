import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CORPUS_LANGUAGES = ['zh', 'en', 'it'] as const;
export type CorpusLanguage = (typeof CORPUS_LANGUAGES)[number];

const DEFAULT_CREATED_AT = '2025-01-15T00:00:00.000Z';
const META_RE = /^<!--\s*fixture-meta\s+(\{.*\})\s*-->\s*$/;
const CHUNK_MARKER = '<!-- chunk -->';

export const CORPUS_DOC_TYPES = [
  'financial_report',
  'contract_legal',
  'invoice_receipt',
  'product_technical',
  'scanned_image',
  'general',
] as const;
export type CorpusDocType = (typeof CORPUS_DOC_TYPES)[number];
const DEFAULT_DOC_TYPE: CorpusDocType = 'general';

function resolveDocType(meta: Record<string, unknown>, relpath: string): CorpusDocType {
  const raw = meta.doc_type;
  if (raw === undefined) return DEFAULT_DOC_TYPE;
  if (typeof raw !== 'string' || !(CORPUS_DOC_TYPES as readonly string[]).includes(raw)) {
    throw new Error(`[Fixture Corpus] invalid doc_type in ${relpath}`);
  }
  return raw as CorpusDocType;
}

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
  docType: CorpusDocType;
  id: string;
  content: string;
  chunks: CorpusChunk[];
  /** Set on documents generated from a template's generate block (D-20, D-50); stored as document metadata `fixture_dup_template`. */
  fixtureDupTemplate?: string;
  /** fixture-meta `lineage` and `version`: versions of one lineage are seeded as published versions (D-40). */
  lineage?: { id: string; version: number };
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

/** The documents.lineage_id the fixture database gives every version of one fixture-meta `lineage`. */
export function fixtureLineageUuid(lineage: string): string {
  return uuidFromDigest(`lineage:${lineage}`);
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

const GENERATE_KEYS = ['count', 'name', 'substitutions', 'template_id'] as const;
export const GENERATE_MAX_COUNT = 100;

interface GenerateBlock {
  count: number;
  name: string;
  substitutions: Array<[string, string]>;
  templateId: string;
}

function parseGenerate(raw: unknown, meta: Record<string, unknown>, relpath: string): GenerateBlock {
  const error = new Error(`[Fixture Corpus] invalid generate block in ${relpath}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw error;
  const block = raw as Record<string, unknown>;
  const keys = Object.keys(block);
  if (keys.length !== GENERATE_KEYS.length || !GENERATE_KEYS.every((key) => keys.includes(key))) throw error;
  const { count, name, substitutions, template_id: templateId } = block;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > GENERATE_MAX_COUNT) throw error;
  if (typeof name !== 'string' || !name.includes('{n}') || name.includes('/') || name.includes('\\')) throw error;
  if (typeof templateId !== 'string' || templateId.length === 0) throw error;
  if (!Array.isArray(substitutions)) throw error;
  for (const pair of substitutions) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((part) => typeof part === 'string') || pair[0] === '') throw error;
  }
  if ('filename' in meta || 'lineage' in meta || 'version' in meta) throw error;
  return { count, name, substitutions: substitutions as Array<[string, string]>, templateId };
}

function parseLineage(meta: Record<string, unknown>, relpath: string): { id: string; version: number } | undefined {
  if (!('lineage' in meta) && !('version' in meta)) return undefined;
  const { lineage, version } = meta;
  if (typeof lineage !== 'string' || lineage.length === 0 || typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error(`[Fixture Corpus] invalid lineage in ${relpath}`);
  }
  return { id: lineage, version };
}

function buildDocument(
  relpath: string,
  filename: string,
  lines: string[],
  meta: Record<string, unknown>,
  extra: { fixtureDupTemplate?: string; lineage?: { id: string; version: number } } = {},
): CorpusDocument {
  const language = relpath.split('/')[0] as CorpusLanguage;
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

  return {
    relpath,
    language,
    filename,
    imageUrl: typeof meta.image_url === 'string' ? meta.image_url : null,
    createdAt: typeof meta.created_at === 'string' ? meta.created_at : DEFAULT_CREATED_AT,
    docType: resolveDocType(meta, relpath),
    id: uuidFromDigest(`doc:${relpath}`),
    content: texts.join('\n\n'),
    chunks: texts.map((text, index) => ({
      index,
      id: uuidFromDigest(`chunk:${relpath}:${index}`),
      section: firstHeading(text),
      text,
      stored: `Document: ${filename}. Chunk ${index + 1} of ${texts.length}. Content: ${text}`,
    })),
    ...(extra.fixtureDupTemplate !== undefined ? { fixtureDupTemplate: extra.fixtureDupTemplate } : {}),
    ...(extra.lineage ? { lineage: extra.lineage } : {}),
  };
}

/** D-20/D-50: one committed template becomes `count` documents; copy i applies substitution i mod length and ends with its own chunk. */
function expandTemplate(relpath: string, lines: string[], meta: Record<string, unknown>, generate: GenerateBlock): CorpusDocument[] {
  const language = relpath.split('/')[0];
  const width = Math.max(2, String(generate.count).length);
  const body = lines.join('\n');
  const copies: CorpusDocument[] = [];
  for (let i = 0; i < generate.count; i += 1) {
    const number = String(i + 1).padStart(width, '0');
    let text = body;
    if (generate.substitutions.length > 0) {
      const [source, target] = generate.substitutions[i % generate.substitutions.length];
      text = text.split(source).join(target);
    }
    const filename = generate.name.split('{n}').join(number);
    const copyLines = [...text.split('\n'), CHUNK_MARKER, `${generate.templateId}-${number}`];
    copies.push(buildDocument(`${language}/${filename}`, filename, copyLines, meta, { fixtureDupTemplate: generate.templateId }));
  }
  return copies;
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

  // corpusSha256 covers the committed files only: a template is hashed once and the documents it generates add nothing (D-50).
  const hash = crypto.createHash('sha256');
  const documents: CorpusDocument[] = [];

  for (const relpath of relpaths) {
    const bytes = fs.readFileSync(path.join(corpusDir, relpath));
    hash.update(relpath);
    hash.update(Buffer.from([0]));
    hash.update(bytes);

    const lines = bytes.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    const meta = META_RE.test(lines[0]?.trim() ?? '') ? parseMeta(lines.shift() as string, relpath) : {};
    if ('generate' in meta) {
      documents.push(...expandTemplate(relpath, lines, meta, parseGenerate(meta.generate, meta, relpath)));
      continue;
    }
    const lineage = parseLineage(meta, relpath);
    const filename = typeof meta.filename === 'string' ? meta.filename : path.posix.basename(relpath);
    documents.push(buildDocument(relpath, filename, lines, meta, lineage ? { lineage } : {}));
  }

  const seen = new Set<string>();
  const versions = new Set<string>();
  for (const doc of documents) {
    if (seen.has(doc.relpath)) throw new Error(`[Fixture Corpus] duplicate corpus document ${doc.relpath}`);
    seen.add(doc.relpath);
    if (doc.lineage) {
      const key = JSON.stringify([doc.lineage.id, doc.lineage.version]);
      if (versions.has(key)) throw new Error(`[Fixture Corpus] duplicate lineage version ${doc.lineage.id} ${doc.lineage.version}`);
      versions.add(key);
    }
  }
  documents.sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));

  return { documents, corpusSha256: hash.digest('hex') };
}
