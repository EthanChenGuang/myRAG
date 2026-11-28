import { scrapeUrl, crawlWebsite } from './firecrawl-client';
import { processDocument } from '@/lib/document-processor';
import type { ProcessDocumentMetadata } from '@/lib/document-processor';
import { assertLegacyWriteAllowed, buildSourceKey, ingest, scheduleIngestWake, submitIngest } from '@/lib/rag';
import type { EnqueueResult, IngestResult, TenantScope } from '@/lib/rag';
import { scraperPipeline } from './ingest-switch';
import { normalizeScrapedUrl } from './url-utils';

/**
 * Who the page is stored for. The legacy pipeline takes the session user and optional organization; the unified
 * pipeline takes the scope the route resolved on the server and the request signal.
 */
type ScraperIdentity =
    | { userId: string; organizationId?: string | null; scope?: TenantScope; signal?: AbortSignal; uploaderId?: undefined }
    | { userId?: undefined; organizationId?: undefined; scope: TenantScope; signal: AbortSignal; uploaderId?: string };

type ScrapeOptions = ScraperIdentity & {
    url: string;
    outputFormat?: 'html' | 'pdf';
};

type CrawlOptions = ScraperIdentity & {
    url: string;
    maxPages?: number;
    outputFormat?: 'html' | 'pdf';
};

type LegacyScrapeOptions = Extract<ScrapeOptions, { userId: string }>;
type LegacyCrawlOptions = Extract<CrawlOptions, { userId: string }>;

export interface IngestedPage {
    documentId: string;
    url: string;
    title?: string;
    status: IngestResult['status'] | EnqueueResult['status'];
    version: number | null;
    jobId?: string | null;
}

function scraperAsyncIngestEnabled(): boolean {
    return (
        (process.env.RAG_INGEST_PIPELINE ?? 'legacy').toLowerCase() === 'unified' &&
        (process.env.RAG_INGEST_ASYNC ?? 'off').toLowerCase() === 'on'
    );
}

interface ScrapedPage {
    url: string;
    markdown?: string;
    actions?: Record<string, unknown>;
    metadata?: { title?: string };
}

/** uploaderId: the session user the route verified, for the upload-approval decision (D-37). */
type UnifiedIdentity = { scope: TenantScope; signal: AbortSignal; uploaderId?: string };

// The scrape route allows 60 s and the crawl route 300 s; ingest gets what is left so a slow page ends as
// processing (resumable) instead of the request being cut off.
const SCRAPE_BUDGET_MS = 55000;
const CRAWL_BUDGET_MS = 280000;
const PAGE_DEADLINE_MS = 50000;
const MIN_PAGE_BUDGET_MS = 5000;

function requireUnifiedIdentity(options: ScraperIdentity): UnifiedIdentity {
    if (!options.scope || !options.signal) {
        throw new Error('[Scraper Adapter] the unified pipeline needs a tenant scope and a request signal');
    }
    return { scope: options.scope, signal: options.signal, ...(options.uploaderId ? { uploaderId: options.uploaderId } : {}) };
}

function requireLegacyUser<T extends { userId?: string }>(options: T): T & { userId: string } {
    if (!options.userId) {
        throw new Error('[Scraper Adapter] the legacy pipeline needs a user id');
    }
    return options as T & { userId: string };
}

/**
 * Scrape a single URL and process it through the document pipeline
 */
export async function scrapeAndProcess(options: ScrapeOptions): Promise<{
    documentId: string;
    url: string;
    title?: string;
    status?: IngestedPage['status'];
    version?: number | null;
}> {
    if (scraperPipeline() === 'unified') {
        return scrapeAndIngest(options, requireUnifiedIdentity(options));
    }
    // D-56: the legacy processor cannot hold a document for upload approval.
    assertLegacyWriteAllowed();
    return scrapeAndProcessLegacy(requireLegacyUser(options) as LegacyScrapeOptions);
}

async function scrapeAndProcessLegacy({
    url,
    userId,
    organizationId
}: LegacyScrapeOptions): Promise<{
    documentId: string;
    url: string;
    title?: string;
}> {
    const normalizedUrl = normalizeScrapedUrl(url);

    // Scrape the URL
    console.log(`[Scraper Adapter] Scraping ${normalizedUrl} as html...`);
    const result = await scrapeUrl(normalizedUrl);

    // Convert to buffer
    let buffer: Buffer;
    let filename: string;

    if (result.html) {
        buffer = Buffer.from(result.html, 'utf-8');
        // Use the website title if available, fallback to sanitized URL
        const pageTitle = result.metadata?.title?.trim();
        filename = pageTitle ? `${sanitizeFilename(pageTitle)}.html` : `${sanitizeUrl(url)}.html`;
    } else {
        throw new Error('No HTML content returned from Firecrawl');
    }

    console.log(`[Scraper Adapter] Processing buffer: ${filename} (${buffer.length} bytes)`);

    // Create metadata for document tracking
    const metadata: ProcessDocumentMetadata = {
        user_id: userId,
        organization_id: organizationId || null,
        source: 'scrape',
        source_provider: 'firecrawl',
        source_file_id: normalizedUrl,
        source_connection_id: `firecrawl-${userId}`, // Virtual connection ID
        external_url: normalizedUrl,
        scraped_url: normalizedUrl,
        title: result.metadata?.title,
    };

    // Process through existing pipeline (LlamaCloud → Embeddings → Supabase)
    const documentId = await processDocument(filename, buffer, metadata);

    console.log(`[Scraper Adapter] Successfully processed ${url} → ${documentId}`);

    return {
        documentId,
        url: normalizedUrl,
        title: result.metadata?.title,
    };
}

/**
 * Crawl multiple pages from a website and process them
 */
export async function crawlAndProcess(options: CrawlOptions): Promise<{
    totalPages: number;
    successfulPages: number;
    failedPages: number;
    documents: Array<{
        documentId: string;
        url: string;
        title?: string;
        status?: IngestedPage['status'];
        version?: number | null;
        jobId?: string | null;
    }>;
    jobIds?: Array<string | null>;
    errors: Array<{ url: string; error: string }>;
}> {
    if (scraperPipeline() === 'unified') {
        return crawlAndIngest(options, requireUnifiedIdentity(options));
    }
    assertLegacyWriteAllowed();
    return crawlAndProcessLegacy(requireLegacyUser(options) as LegacyCrawlOptions);
}

async function crawlAndProcessLegacy({
    url,
    userId,
    organizationId,
    maxPages = 10
}: LegacyCrawlOptions): Promise<{
    totalPages: number;
    successfulPages: number;
    failedPages: number;
    documents: Array<{ documentId: string; url: string; title?: string }>;
    errors: Array<{ url: string; error: string }>;
}> {
    const normalizedUrl = normalizeScrapedUrl(url);

    console.log(`[Scraper Adapter] Crawling ${normalizedUrl}, max ${maxPages} pages...`);

    // Crawl the website
    const pages = await crawlWebsite(normalizedUrl, { maxPages });

    const documents: Array<{ documentId: string; url: string; title?: string }> = [];
    const errors: Array<{ url: string; error: string }> = [];

    // Process each page
    for (const page of pages) {
        try {
            let buffer: Buffer;
            let filename: string;

            if (page.html) {
                buffer = Buffer.from(page.html, 'utf-8');
                // Use the page title if available, fallback to sanitized URL
                const pageTitle = page.metadata?.title?.trim();
                filename = pageTitle ? `${sanitizeFilename(pageTitle)}.html` : `${sanitizeUrl(page.url)}.html`;
            } else {
                throw new Error('No HTML content in crawled page');
            }

            const metadata: ProcessDocumentMetadata = {
                user_id: userId,
                organization_id: organizationId || null,
                source: 'scrape',
                source_provider: 'firecrawl',
                source_file_id: normalizeScrapedUrl(page.url),
                source_connection_id: `firecrawl-${userId}`,
                external_url: normalizeScrapedUrl(page.url),
                scraped_url: normalizeScrapedUrl(page.url),
                title: page.metadata?.title,
            };

            const documentId = await processDocument(filename, buffer, metadata);

            documents.push({
                documentId,
                url: page.url,
                title: page.metadata?.title,
            });

            console.log(`[Scraper Adapter] ✓ Processed ${page.url}`);
        } catch (error) {
            console.error(`[Scraper Adapter] ✗ Failed to process ${page.url}:`, error);
            errors.push({
                url: page.url,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }

    console.log(`[Scraper Adapter] Crawl complete: ${documents.length}/${pages.length} pages processed successfully`);

    return {
        totalPages: pages.length,
        successfulPages: documents.length,
        failedPages: errors.length,
        documents,
        errors,
    };
}

/**
 * Unified pipeline: Firecrawl Markdown (or the page as an inline PDF) goes to ingest(), whose identity is the
 * canonical URL, so an unchanged page is skipped and a changed one becomes a new version of the same document.
 */
async function scrapeAndIngest(
    { url, outputFormat }: ScrapeOptions,
    { scope, signal, uploaderId }: UnifiedIdentity
): Promise<IngestedPage> {
    const startedAt = Date.now();
    const normalizedUrl = normalizeScrapedUrl(url);
    const output = outputFormat === 'pdf' ? 'pdf' : 'markdown';

    console.log(`[Scraper Adapter] Scraping ${normalizedUrl} as ${output}...`);
    const result = await scrapeUrl(normalizedUrl, { output });

    const deadlineMs = Math.max(MIN_PAGE_BUDGET_MS, SCRAPE_BUDGET_MS - (Date.now() - startedAt));
    const ingested = await ingestPage({ ...result, url: normalizedUrl }, output, scope, signal, deadlineMs, uploaderId);
    if (ingested.status === 'queued') {
        scheduleIngestWake();
    }
    return ingested;
}

async function crawlAndIngest(
    { url, maxPages = 10, outputFormat }: CrawlOptions,
    { scope, signal, uploaderId }: UnifiedIdentity
): Promise<{
    totalPages: number;
    successfulPages: number;
    failedPages: number;
    documents: IngestedPage[];
    jobIds: Array<string | null>;
    errors: Array<{ url: string; error: string }>;
}> {
    const startedAt = Date.now();
    const normalizedUrl = normalizeScrapedUrl(url);
    const output = outputFormat === 'pdf' ? 'pdf' : 'markdown';

    console.log(`[Scraper Adapter] Crawling ${normalizedUrl}, max ${maxPages} pages as ${output}...`);
    const pages = await crawlWebsite(normalizedUrl, { maxPages, output });

    const documents: IngestedPage[] = [];
    const errors: Array<{ url: string; error: string }> = [];
    let queuedPages = 0;

    for (const page of pages) {
        signal.throwIfAborted();
        const remaining = CRAWL_BUDGET_MS - (Date.now() - startedAt);
        if (remaining < MIN_PAGE_BUDGET_MS) {
            errors.push({ url: page.url, error: 'Crawl time budget spent before this page was ingested' });
            continue;
        }
        try {
            const ingested = await ingestPage(page, output, scope, signal, Math.min(PAGE_DEADLINE_MS, remaining), uploaderId);
            documents.push(ingested);
            if (ingested.status === 'queued') queuedPages += 1;
        } catch (error) {
            console.error(`[Scraper Adapter] Failed to ingest ${page.url}:`, error);
            errors.push({
                url: page.url,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
        }
    }

    if (queuedPages > 0) {
        scheduleIngestWake();
    }

    const jobIds = documents.map((page) => page.jobId ?? null);

    console.log(`[Scraper Adapter] Crawl complete: ${documents.length}/${pages.length} pages ingested`);

    return {
        totalPages: pages.length,
        successfulPages: documents.length,
        failedPages: errors.length,
        documents,
        jobIds,
        errors,
    };
}

async function ingestPage(
    page: ScrapedPage,
    output: 'markdown' | 'pdf',
    scope: TenantScope,
    signal: AbortSignal,
    deadlineMs: number,
    uploaderId?: string
): Promise<IngestedPage> {
    const canonicalUrl = normalizeScrapedUrl(page.url);
    const title = page.metadata?.title;
    const pageTitle = title?.trim();
    const baseName = pageTitle ? sanitizeFilename(pageTitle) : sanitizeUrl(page.url);

    const content =
        output === 'pdf'
            ? { file: inlinePdfBytes(page), filename: `${baseName}.pdf`, mimeType: 'application/pdf' }
            : { text: markdownOf(page), filename: `${baseName}.md`, mimeType: 'text/markdown' };

    const metadata: Record<string, string> = { external_url: canonicalUrl, scraped_url: canonicalUrl };
    if (title) metadata.title = title;

    const ingestInput = {
        scope,
        source: 'scraper' as const,
        sourceKey: buildSourceKey('scraper', { url: canonicalUrl }),
        ...(uploaderId ? { uploaderId } : {}),
        ...content,
        options: {
            origin: { sourceProvider: 'firecrawl', sourceFileId: canonicalUrl, metadata },
        },
        signal,
        deadlineMs,
    };
    const result: IngestResult | EnqueueResult = scraperAsyncIngestEnabled()
        ? await submitIngest(ingestInput)
        : await ingest(ingestInput);

    if (result.status === 'failed') {
        throw new Error(`Ingest failed (${result.reason ?? 'unknown'})`);
    }

    if ('jobId' in result) {
        const documentId = result.documentId;
        if (documentId === null) {
            throw new Error(`Ingest returned no document (${result.status})`);
        }
        console.log(`[Scraper Adapter] Enqueued ${page.url} as ${result.status}`);
        return {
            documentId,
            url: page.url,
            title,
            status: result.status,
            version: null,
            jobId: result.jobId,
        };
    }

    const documentId = result.documentId ?? result.duplicateOf ?? null;
    if (documentId === null) {
        throw new Error(`Ingest returned no document (${result.status})`);
    }

    console.log(`[Scraper Adapter] Ingested ${page.url} as ${result.status}`);

    return { documentId, url: page.url, title, status: result.status, version: result.version };
}

function markdownOf(page: ScrapedPage): string {
    if (typeof page.markdown !== 'string' || page.markdown.trim() === '') {
        throw new Error('No Markdown content returned from Firecrawl');
    }
    return page.markdown;
}

/**
 * The PDF Firecrawl rendered, as bytes. Only inline content is accepted: the app never fetches a link a third
 * party hands back, and anything that is not a PDF is refused.
 */
function inlinePdfBytes(page: ScrapedPage): Uint8Array {
    const pdfs = page.actions?.pdfs;
    const first = Array.isArray(pdfs) ? pdfs[0] : undefined;
    if (typeof first === 'string') {
        const bytes = Buffer.from(first.replace(/^data:application\/pdf;base64,/, '').trim(), 'base64');
        if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
            return new Uint8Array(bytes);
        }
    }
    throw new Error('Firecrawl did not return an inline PDF for this page');
}

/**
 * Convert a title string to a safe filename
 */
function sanitizeFilename(title: string): string {
    return title
        .replace(/[^a-zA-Z0-9\s\-_]/g, '')  // Remove special characters
        .replace(/\s+/g, '-')                // Replace spaces with hyphens
        .replace(/-+/g, '-')                 // Remove consecutive hyphens
        .replace(/^-|-$/g, '')               // Remove leading/trailing hyphens
        .substring(0, 100) || 'scraped-page';
}

/**
 * Convert URL to a safe filename
 */
function sanitizeUrl(url: string): string {
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname.replace(/^\//, '').replace(/\/$/, '') || 'index';
        const sanitized = `${urlObj.hostname}_${path}`
            .replace(/[^a-zA-Z0-9-_]/g, '-')
            .replace(/-+/g, '-')
            .substring(0, 100);
        return sanitized || 'scraped-page';
    } catch {
        return url
            .replace(/^https?:\/\//, '')
            .replace(/[^a-zA-Z0-9-]/g, '-')
            .substring(0, 100) || 'scraped-page';
    }
}
