import { currentIngestConfig, legacyUploadRoute } from '@/lib/rag';

export type ScraperPipeline = 'legacy' | 'unified';

/**
 * Which write path a scrape or crawl takes, read per call. A configuration that cannot be read resolves to
 * the legacy path, which is today's behaviour.
 */
export function scraperPipeline(): ScraperPipeline {
    try {
        const config = currentIngestConfig();
        // D-16: language-aware ingestion sends scrapes to the unified pipeline even under RAG_INGEST_PIPELINE=legacy.
        return config.pipeline === 'unified' || legacyUploadRoute(config) === 'unified' ? 'unified' : 'legacy';
    } catch {
        console.warn('[Scraper] ingest switch unavailable, using the legacy pipeline');
        return 'legacy';
    }
}
