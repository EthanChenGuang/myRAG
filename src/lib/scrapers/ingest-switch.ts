import { currentIngestConfig } from '@/lib/rag';

export type ScraperPipeline = 'legacy' | 'unified';

/**
 * Which write path a scrape or crawl takes, read per call. A configuration that cannot be read resolves to
 * the legacy path, which is today's behaviour.
 */
export function scraperPipeline(): ScraperPipeline {
    try {
        return currentIngestConfig().pipeline === 'unified' ? 'unified' : 'legacy';
    } catch {
        console.warn('[Scraper] ingest switch unavailable, using the legacy pipeline');
        return 'legacy';
    }
}
