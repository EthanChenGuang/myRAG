/**
 * URL Extraction and Management for RAG System
 * Extracts, categorizes, and formats URLs from document text for AI responses
 */

export interface ExtractedURL {
  url: string;
  context: string; // The text surrounding the URL
  category?: 'product' | 'documentation' | 'social' | 'payment' | 'external' | 'other';
  description?: string; // A human-readable description of what the link is for
}

export interface URLMetadata {
  urls: ExtractedURL[];
  hasLinks: boolean;
  linkCount: number;
}

/**
 * Comprehensive URL pattern matching
 * Matches various URL formats including markdown links
 */
const URL_PATTERNS = {
  // Standard URLs (http, https, ftp, etc.)
  standard: /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)/gi,

  // Markdown links [text](url)
  markdown: /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/gi,

  // Naked domains (www.example.com)
  nakedDomain: /(?:^|[\s])(?:www\.)([-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*))/gi,
};

/**
 * Categorize a URL based on its domain and path
 */
function categorizeURL(url: string): ExtractedURL['category'] {
  const lowerURL = url.toLowerCase();

  // Payment/checkout links
  if (lowerURL.includes('polar.sh') ||
      lowerURL.includes('stripe.com') ||
      lowerURL.includes('gumroad.com') ||
      lowerURL.includes('checkout') ||
      lowerURL.includes('payment') ||
      lowerURL.includes('buy')) {
    return 'payment';
  }

  // Product pages
  if (lowerURL.includes('product') ||
      lowerURL.includes('pricing') ||
      lowerURL.includes('shop')) {
    return 'product';
  }

  // Documentation
  if (lowerURL.includes('docs') ||
      lowerURL.includes('documentation') ||
      lowerURL.includes('guide') ||
      lowerURL.includes('wiki') ||
      lowerURL.includes('readme')) {
    return 'documentation';
  }

  // Social media
  if (lowerURL.includes('twitter.com') ||
      lowerURL.includes('x.com') ||
      lowerURL.includes('linkedin.com') ||
      lowerURL.includes('facebook.com') ||
      lowerURL.includes('instagram.com') ||
      lowerURL.includes('github.com')) {
    return 'social';
  }

  return 'other';
}

/**
 * Extract context around a URL (text before and after)
 */
function extractURLContext(text: string, urlMatch: string, contextLength: number = 100): string {
  const urlIndex = text.indexOf(urlMatch);
  if (urlIndex === -1) return '';

  const start = Math.max(0, urlIndex - contextLength);
  const end = Math.min(text.length, urlIndex + urlMatch.length + contextLength);

  let context = text.substring(start, end).trim();

  // Clean up the context
  if (start > 0) context = '...' + context;
  if (end < text.length) context = context + '...';

  return context;
}

/**
 * Generate a human-readable description for a URL based on context
 */
function generateURLDescription(url: string, context: string, markdownText?: string): string {
  // If we have markdown text, use that as it's usually descriptive
  if (markdownText && markdownText.trim()) {
    return markdownText.trim();
  }

  // Otherwise, try to extract from context
  const category = categorizeURL(url);

  // Try to find a descriptive sentence in the context
  const sentences = context.split(/[.!?]+/).filter(s => s.trim().length > 10);
  for (const sentence of sentences) {
    const cleanSentence = sentence.trim();
    // If the sentence mentions the URL or is near it, use it
    if (cleanSentence.length < 200) {
      return cleanSentence;
    }
  }

  // Fallback: Use the URL domain as description
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace('www.', '');

    switch (category) {
      case 'payment':
        return `Purchase or checkout page at ${domain}`;
      case 'product':
        return `Product information at ${domain}`;
      case 'documentation':
        return `Documentation at ${domain}`;
      case 'social':
        return `Social media profile at ${domain}`;
      default:
        return `Link to ${domain}`;
    }
  } catch (e) {
    return 'External link';
  }
}

/**
 * Extract all URLs from text with their context and metadata
 */
export function extractURLs(text: string): URLMetadata {
  const urlsMap = new Map<string, ExtractedURL>();

  // Extract markdown links first (they have descriptive text)
  const markdownMatches = Array.from(text.matchAll(URL_PATTERNS.markdown));
  for (const match of markdownMatches) {
    const [fullMatch, linkText, url] = match;
    const context = extractURLContext(text, fullMatch);
    const category = categorizeURL(url);

    urlsMap.set(url, {
      url,
      context,
      category,
      description: linkText || generateURLDescription(url, context)
    });
  }

  // Extract standard URLs
  const standardMatches = Array.from(text.matchAll(URL_PATTERNS.standard));
  for (const match of standardMatches) {
    const url = match[0];

    // Skip if already extracted from markdown
    if (urlsMap.has(url)) continue;

    const context = extractURLContext(text, url);
    const category = categorizeURL(url);

    urlsMap.set(url, {
      url,
      context,
      category,
      description: generateURLDescription(url, context)
    });
  }

  // Extract naked domains (www.example.com)
  const nakedMatches = Array.from(text.matchAll(URL_PATTERNS.nakedDomain));
  for (const match of nakedMatches) {
    const domain = match[1];
    const url = 'https://' + domain;

    // Skip if already extracted
    if (urlsMap.has(url)) continue;

    const context = extractURLContext(text, domain);
    const category = categorizeURL(url);

    urlsMap.set(url, {
      url,
      context,
      category,
      description: generateURLDescription(url, context)
    });
  }

  const urls = Array.from(urlsMap.values());

  return {
    urls,
    hasLinks: urls.length > 0,
    linkCount: urls.length
  };
}

/**
 * Format URLs for inclusion in AI context
 * Creates a structured format that the AI can easily reference
 */
export function formatURLsForContext(urls: ExtractedURL[]): string {
  if (urls.length === 0) return '';

  const urlsByCategory = new Map<string, ExtractedURL[]>();

  // Group URLs by category
  for (const url of urls) {
    const category = url.category || 'other';
    if (!urlsByCategory.has(category)) {
      urlsByCategory.set(category, []);
    }
    urlsByCategory.get(category)!.push(url);
  }

  // Format the URLs
  const sections: string[] = [];

  // Priority order for categories
  const categoryOrder: Array<ExtractedURL['category']> = ['payment', 'product', 'documentation', 'social', 'other'];

  for (const category of categoryOrder) {
    const categoryURLs = urlsByCategory.get(category!);
    if (!categoryURLs || categoryURLs.length === 0) continue;

    const categoryName = category!.charAt(0).toUpperCase() + category!.slice(1);
    sections.push(`${categoryName} Links:`);

    for (const urlData of categoryURLs) {
      const description = urlData.description || 'Link';
      sections.push(`  - ${description}: ${urlData.url}`);
    }
    sections.push(''); // Empty line between categories
  }

  if (sections.length > 0) {
    return `\n=== RELEVANT LINKS ===\n${sections.join('\n')}\n=== END LINKS ===\n`;
  }

  return '';
}

/**
 * Create instructions for the AI on how to use links in responses
 */
export function createLinkUsageInstructions(): string {
  return `
IMPORTANT - Link Usage Instructions:
When responding to queries, if relevant links are provided in the "RELEVANT LINKS" section:
1. Include clickable links naturally in your response when mentioning related products, services, or resources
2. Format links as markdown: [descriptive text](URL)
3. Use the provided link descriptions to understand what each link is for
4. Only include links that are directly relevant to answering the user's question
5. Don't just list all links - integrate them naturally into your answer where they add value

Examples of good link usage:
- "You can purchase the Pro plan [here](https://example.com/pricing/pro)"
- "For more details, check out the [documentation](https://docs.myrag.laoxiang.app)"
- "Visit our [pricing page](https://myrag.laoxiang.app/pricing) to compare plans"
`;
}

/**
 * Extract URLs from a chunk and update its metadata
 */
export function enrichChunkWithURLs(chunkContent: string, existingMetadata: any = {}): any {
  const urlMetadata = extractURLs(chunkContent);

  return {
    ...existingMetadata,
    urls: urlMetadata.urls,
    has_urls: urlMetadata.hasLinks,
    url_count: urlMetadata.linkCount,
    url_categories: [...new Set(urlMetadata.urls.map(u => u.category))],
  };
}

/** Detection rules of the ingestion link check (config/rag/link-rules.json), passed in as data. */
export interface LinkExtractionRules {
  url_schemes: readonly string[];
  www_prefix: boolean;
  bare_host_lowercase_last_label: boolean;
  bare_host_last_labels: readonly string[];
  never_domain_extensions: readonly string[];
}

export interface LinkCandidate {
  kind: 'url' | 'domain' | 'email';
  /** The matched text: a URL with its scheme, a host, or an e-mail address. */
  value: string;
}

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const IDEOGRAPH = /[㐀-鿿豈-﫿]/;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Drops trailing sentence punctuation and unbalanced closing brackets; a path is cut at the first ideograph (CJK text after a link). */
function trimUrl(raw: string): string {
  let url = raw;
  const schemeEnd = url.indexOf('://') + 3;
  const pathStart = url.slice(schemeEnd).search(/[/?#]/);
  if (pathStart >= 0) {
    const rest = url.slice(schemeEnd + pathStart);
    const cut = rest.search(IDEOGRAPH);
    if (cut >= 0) url = url.slice(0, schemeEnd + pathStart + cut);
  }
  for (;;) {
    const last = url.at(-1) ?? '';
    if ('.,;:!?\'"*_'.includes(last) && url.length > schemeEnd) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener !== undefined && url.split(opener).length <= url.split(last).length - 1) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/**
 * Every URL, bare domain and e-mail address in a text, in order of appearance, for the ingestion link check (D-35). Unlike extractURLs it
 * also finds bare hosts and addresses; a bare host counts only when its last label is listed in the rules and is not a file extension, so
 * file names, version and section numbers and abbreviations are not domains. Nothing is fetched or resolved.
 */
export function extractLinkCandidates(text: string, rules: LinkExtractionRules): LinkCandidate[] {
  const found: Array<LinkCandidate & { at: number }> = [];
  let masked = text;
  const mask = (start: number, length: number) => {
    masked = masked.slice(0, start) + ' '.repeat(length) + masked.slice(start + length);
  };

  if (rules.url_schemes.length > 0) {
    const schemes = rules.url_schemes.map(escapeRegExp).join('|');
    const urlPattern = new RegExp(`(?<![A-Za-z0-9+.-])(?:${schemes}):\\/\\/[^\\s<>"'\`\\u3000-\\u303f\\uff00-\\uffef]+`, 'gi');
    for (const match of text.matchAll(urlPattern)) {
      const value = trimUrl(match[0]);
      if (!/:\/\/[^/?#\s]/.test(value)) continue;
      found.push({ kind: 'url', value, at: match.index });
      mask(match.index, match[0].length);
    }
  }

  const emailPattern = new RegExp(`(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@((?:${LABEL}\\.)+[A-Za-z]{2,63})(?![A-Za-z0-9-])`, 'g');
  for (const match of masked.matchAll(emailPattern)) {
    found.push({ kind: 'email', value: match[0], at: match.index });
    mask(match.index, match[0].length);
  }

  if (rules.www_prefix) {
    const wwwPattern = new RegExp(`(?<![A-Za-z0-9.@/\\\\-])www\\.(?:${LABEL}\\.)+[A-Za-z]{2,63}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, 'gi');
    for (const match of masked.matchAll(wwwPattern)) {
      found.push({ kind: 'domain', value: match[0], at: match.index });
      mask(match.index, match[0].length);
    }
  }

  const lastLabels = new Set(rules.bare_host_last_labels.map((label) => label.toLowerCase()));
  const extensions = new Set(rules.never_domain_extensions.map((extension) => extension.toLowerCase()));
  const barePattern = new RegExp(`(?<![A-Za-z0-9@._/\\\\-])(?:${LABEL}\\.)+([A-Za-z]{2,63})(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, 'g');
  for (const match of masked.matchAll(barePattern)) {
    const last = match[1] ?? '';
    if (rules.bare_host_lowercase_last_label && last !== last.toLowerCase()) continue;
    const lower = last.toLowerCase();
    if (!lastLabels.has(lower) || extensions.has(lower)) continue;
    found.push({ kind: 'domain', value: match[0], at: match.index });
  }

  return found.sort((a, b) => a.at - b.at).map(({ kind, value }) => ({ kind, value }));
}
