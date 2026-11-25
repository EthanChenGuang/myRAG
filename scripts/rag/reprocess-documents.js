#!/usr/bin/env node

/**
 * Script to reprocess existing documents with proper chunking and embeddings
 * This will:
 * 1. Delete all existing chunks
 * 2. Re-chunk all documents using the configured strategy
 * 3. Generate new embeddings for all chunks
 *
 * `--reembed ...` runs the safe re-embed job instead (src/lib/rag/ingest/reembed): it reads stored chunk text only, deletes nothing and is
 * resumable. See `npm run rag:reembed`. The mode above refuses to run once documents have versions or another embedding profile is in use,
 * because it deletes chunk ids that citations point at.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REFUSED_EXIT_CODE = 3;

if (process.argv.slice(2).includes('--reembed')) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const forwarded = process.argv.slice(2).filter((arg) => arg !== '--reembed');
  const job = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join('src', 'lib', 'rag', 'ingest', 'reembed', 'cli.ts'), ...forwarded],
    { cwd: repoRoot, stdio: 'inherit', env: process.env }
  );
  if (job.error) {
    console.error('[Re-embed] could not start the TypeScript job:', job.error.message);
    process.exit(1);
  }
  if (job.status === null) {
    console.error(`[Re-embed] the TypeScript job ended on signal ${job.signal}`);
    process.exit(1);
  }
  process.exit(job.status);
}

require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');

// Initialize clients
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Configuration
const CHUNK_SIZE = parseInt(process.env.LLAMACLOUD_CHUNK_SIZE || '1500');
const CHUNK_OVERLAP = parseInt(process.env.LLAMACLOUD_CHUNK_OVERLAP || '100');
const CHUNK_STRATEGY = process.env.LLAMACLOUD_CHUNK_STRATEGY || 'sentence';
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const BATCH_SIZE = 5;

console.log('Reprocessing configuration:');
console.log(`- Chunk size: ${CHUNK_SIZE} characters`);
console.log(`- Chunk overlap: ${CHUNK_OVERLAP} characters`);
console.log(`- Chunk strategy: ${CHUNK_STRATEGY}`);
console.log(`- Embedding model: ${EMBEDDING_MODEL}`);
console.log('---');

// Utility functions
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function createTokenBasedChunks(text, maxTokens = 600, overlapTokens = 100) {
  const paragraphs = text.split('\n\n').filter(p => p.trim().length > 0);
  const chunks = [];
  let currentChunk = [];
  let currentTokens = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    const paragraphTokens = estimateTokens(paragraph);

    if (currentTokens + paragraphTokens > maxTokens && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n\n'));
      
      let overlapChunk = [];
      let overlapTokenCount = 0;
      for (let j = currentChunk.length - 1; j >= 0; j--) {
        const overlapParagraph = currentChunk[j];
        const overlapParagraphTokens = estimateTokens(overlapParagraph);
        if (overlapTokenCount + overlapParagraphTokens <= overlapTokens) {
          overlapChunk.unshift(overlapParagraph);
          overlapTokenCount += overlapParagraphTokens;
        } else {
          break;
        }
      }
      currentChunk = overlapChunk;
      currentTokens = overlapTokenCount;
    }

    currentChunk.push(paragraph);
    currentTokens += paragraphTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n\n'));
  }

  return chunks;
}

function createCharacterBasedChunks(text, chunkSize = 1500, chunkOverlap = 100) {
  const chunks = [];
  let start = 0;
  
  while (start < text.length) {
    let end = start + chunkSize;
    
    if (end < text.length) {
      const searchStart = Math.max(start + Math.floor(chunkSize * 0.8), start);
      let sentenceEnd = -1;
      
      for (let i = end; i >= searchStart; i--) {
        if (text[i] === '.' || text[i] === '!' || text[i] === '?') {
          if (i + 1 < text.length && (text[i + 1] === ' ' || text[i + 1] === '\n')) {
            sentenceEnd = i + 1;
            break;
          }
        }
      }
      
      if (sentenceEnd > 0) {
        end = sentenceEnd;
      }
    }
    
    chunks.push(text.slice(start, end).trim());
    start = end - chunkOverlap;
    
    if (start <= chunks.length * chunkOverlap) {
      start = end;
    }
  }
  
  return chunks.filter(chunk => chunk.length > 10);
}

async function generateEmbedding(text) {
  try {
    const response = await openai.embeddings.create({
      input: text,
      model: EMBEDDING_MODEL,
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw error;
  }
}

// URL extraction utilities (simplified version for reprocessing)
function extractURLs(text) {
  const urls = [];
  const urlsMap = new Map();

  // Pattern for markdown links [text](url)
  const markdownPattern = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/gi;
  const markdownMatches = text.matchAll(markdownPattern);
  for (const match of markdownMatches) {
    const [, linkText, url] = match;
    urlsMap.set(url, { url, description: linkText, category: categorizeURL(url) });
  }

  // Pattern for standard URLs
  const standardPattern = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)/gi;
  const standardMatches = text.matchAll(standardPattern);
  for (const match of standardMatches) {
    const url = match[0];
    if (!urlsMap.has(url)) {
      urlsMap.set(url, { url, description: `Link to ${url}`, category: categorizeURL(url) });
    }
  }

  return {
    urls: Array.from(urlsMap.values()),
    hasLinks: urlsMap.size > 0,
    linkCount: urlsMap.size
  };
}

function categorizeURL(url) {
  const lowerURL = url.toLowerCase();
  if (lowerURL.includes('polar.sh') || lowerURL.includes('stripe.com') ||
      lowerURL.includes('checkout') || lowerURL.includes('payment') || lowerURL.includes('buy')) {
    return 'payment';
  }
  if (lowerURL.includes('product') || lowerURL.includes('pricing') || lowerURL.includes('shop')) {
    return 'product';
  }
  if (lowerURL.includes('docs') || lowerURL.includes('documentation') ||
      lowerURL.includes('guide') || lowerURL.includes('wiki')) {
    return 'documentation';
  }
  if (lowerURL.includes('twitter.com') || lowerURL.includes('x.com') ||
      lowerURL.includes('linkedin.com') || lowerURL.includes('github.com')) {
    return 'social';
  }
  return 'other';
}

async function processDocumentChunks(document) {
  console.log(`\nProcessing document: ${document.filename} (ID: ${document.id})`);
  
  const text = document.content || document.text || '';
  if (!text) {
    console.log('No text content found, skipping...');
    return { success: false, error: 'No text content' };
  }

  // Delete existing chunks
  console.log('Deleting existing chunks...');
  const { error: deleteError } = await supabase
    .from('document_chunks')
    .delete()
    .eq('document_id', document.id);
  
  if (deleteError) {
    console.error('Error deleting chunks:', deleteError);
    return { success: false, error: deleteError.message };
  }

  // Create new chunks
  let chunks;
  if (CHUNK_STRATEGY === 'token' || CHUNK_STRATEGY === 'sentence') {
    const maxTokens = Math.floor(CHUNK_SIZE / 4);
    const overlapTokens = Math.floor(CHUNK_OVERLAP / 4);
    chunks = createTokenBasedChunks(text, maxTokens, overlapTokens);
    console.log(`Created ${chunks.length} token-based chunks`);
  } else {
    chunks = createCharacterBasedChunks(text, CHUNK_SIZE, CHUNK_OVERLAP);
    console.log(`Created ${chunks.length} character-based chunks`);
  }

  if (chunks.length === 0) {
    console.log('No chunks created, skipping...');
    return { success: false, error: 'No chunks created' };
  }

  // Process chunks in batches
  let successfulChunks = 0;
  const totalChunks = chunks.length;
  
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);
    
    console.log(`Processing batch ${batchNum}/${totalBatches}...`);
    
    try {
      // Generate embeddings for batch
      const embeddings = await Promise.all(
        batch.map(chunk => generateEmbedding(chunk))
      );
      
      // Prepare chunk records with metadata and URL extraction
      const chunkRecords = batch.map((chunk, index) => {
        const globalChunkIndex = i + index;
        const chunkPosition = globalChunkIndex + 1;

        // Extract URLs from chunk content
        const urlMetadata = extractURLs(chunk);

        return {
          document_id: document.id,
          content: chunk,
          embedding: embeddings[index],
          metadata: {
            document_title: document.filename,
            chunk_index: globalChunkIndex,
            chunk_position: chunkPosition,
            total_chunks: totalChunks,

            // URL metadata for link inclusion in AI responses
            urls: urlMetadata.urls,
            has_urls: urlMetadata.hasLinks,
            url_count: urlMetadata.linkCount,
            url_categories: [...new Set(urlMetadata.urls.map(u => u.category))],
          }
        };
      });
      
      // Insert chunks
      const { error: insertError } = await supabase
        .from('document_chunks')
        .insert(chunkRecords);
      
      if (insertError) {
        console.error('Error inserting chunks:', insertError);
      } else {
        successfulChunks += batch.length;
      }
    } catch (error) {
      console.error(`Error processing batch ${batchNum}:`, error);
    }
  }
  
  console.log(`Successfully processed ${successfulChunks}/${totalChunks} chunks`);
  return { success: true, successfulChunks, totalChunks };
}

function refuse(reason) {
  console.error(`Refusing to run the destructive legacy reprocess: ${reason}`);
  console.error('It deletes every chunk of every document, including chunk ids that stored citations point at.');
  console.error('Use `npm run rag:reembed -- --profile <id>` (or this script with --reembed) instead: it reads stored text only and deletes nothing.');
  process.exit(REFUSED_EXIT_CODE);
}

const MISSING_FUNCTION_CODES = new Set(['PGRST202', '42883']);
const LEGACY_PROFILE_ID = 'openai-3-small-1536';

// Without the 0315 function the same two questions are asked with what an older schema has. Only a schema that cannot hold versions or
// profiles at all counts as safe; any other failure refuses, because a destroyed citation cannot be restored.
async function fallbackGuard() {
  const versions = await supabase.from('documents').select('id').gt('version', 1).limit(1);
  if (versions.error) {
    if (versions.error.code !== '42703') refuse('the database could not be asked whether documents have versions');
  } else if ((versions.data || []).length > 0) {
    refuse('at least one document has version above 1');
  }
  const profiles = await supabase.rpc('rag_list_embedding_profiles');
  if (profiles.error) {
    if (!MISSING_FUNCTION_CODES.has(profiles.error.code)) refuse('the database could not be asked which embedding profiles are in use');
    return;
  }
  const inUse = (profiles.data || [])
    .filter((profile) => profile.id !== LEGACY_PROFILE_ID && (profile.status === 'backfilling' || profile.status === 'active'))
    .map((profile) => profile.id);
  if (inUse.length > 0) refuse(`embedding profile(s) in use: ${inUse.join(', ')}`);
}

async function assertLegacyModeIsSafe() {
  let response;
  try {
    response = await supabase.rpc('rag_reembed_legacy_guard');
  } catch (error) {
    refuse('the database could not be asked whether documents have versions or other embedding profiles are in use');
  }
  if (response.error) {
    if (MISSING_FUNCTION_CODES.has(response.error.code)) return fallbackGuard();
    refuse('the database could not be asked whether documents have versions or other embedding profiles are in use');
  }
  const guard = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!guard) refuse('the database gave no answer to the safety check');
  if (Number(guard.versioned_documents) > 0) {
    refuse(`${guard.versioned_documents} document(s) have version above 1`);
  }
  const inUse = Array.isArray(guard.profiles_in_use) ? guard.profiles_in_use : [];
  if (inUse.length > 0) {
    refuse(`embedding profile(s) in use or holding vectors: ${inUse.join(', ')}`);
  }
}

async function main() {
  await assertLegacyModeIsSafe();
  console.log('Starting document reprocessing...\n');
  
  // Fetch all documents
  const { data: documents, error } = await supabase
    .from('documents')
    .select('*')
    .order('created_at', { ascending: true });
  
  if (error) {
    console.error('Error fetching documents:', error);
    process.exit(1);
  }
  
  console.log(`Found ${documents.length} documents to process`);
  
  // Process each document
  const results = {
    successful: 0,
    failed: 0,
    totalChunks: 0
  };
  
  for (const document of documents) {
    const result = await processDocumentChunks(document);
    
    if (result.success) {
      results.successful++;
      results.totalChunks += result.successfulChunks;
    } else {
      results.failed++;
    }
  }
  
  // Summary
  console.log('\n=== Reprocessing Complete ===');
  console.log(`Documents processed: ${results.successful + results.failed}`);
  console.log(`Successful: ${results.successful}`);
  console.log(`Failed: ${results.failed}`);
  console.log(`Total chunks created: ${results.totalChunks}`);
  
  // Verify chunks in database
  const { count } = await supabase
    .from('document_chunks')
    .select('*', { count: 'exact', head: true });
  
  console.log(`\nTotal chunks in database: ${count}`);
}

// Run the script
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});