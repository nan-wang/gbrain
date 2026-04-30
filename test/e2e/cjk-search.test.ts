/**
 * CJK search E2E (v0.23 bilingual support).
 *
 * End-to-end check that bilingual FTS works through the entire pipeline:
 *   - putPage() populates *_segmented columns via segmentText()
 *   - chunk insert populates chunk_text_segmented
 *   - update_page_search_vector / update_chunk_search_vector triggers build
 *     a tsvector with both english + simple channels
 *   - searchKeyword + searchKeywordChunks return CJK pages for CJK queries
 *   - English regression — Latin queries still work
 *
 * Runs against PGLite in-memory (no Docker, no API keys, no DATABASE_URL
 * needed) so it executes in CI on every push. The same fixture also exercises
 * the chunk-grain Cathedral II FTS path through migrations v27 + v30.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { ChunkInput, PageInput } from '../../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); // in-memory
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  const tables = ['content_chunks', 'links', 'tags', 'raw_data',
    'timeline_entries', 'page_versions', 'ingest_log', 'pages'];
  for (const t of tables) {
    await (engine as unknown as { db: { exec: (s: string) => Promise<void> } }).db.exec(`DELETE FROM ${t}`);
  }
}

interface Fixture {
  slug: string;
  page: PageInput;
  chunkText: string;
}

const FIXTURES: Fixture[] = [
  {
    slug: 'companies/openai',
    page: {
      type: 'company',
      title: 'OpenAI',
      compiled_truth: 'OpenAI is an American AI research company headquartered in San Francisco.',
      timeline: '2015-12: Founded',
    },
    chunkText: 'OpenAI is an American AI research company headquartered in San Francisco.',
  },
  {
    slug: 'companies/baidu',
    page: {
      type: 'company',
      title: '百度',
      compiled_truth: '百度是一家中国互联网公司,总部位于北京。它运营着全球最大的中文搜索引擎。',
      timeline: '',
    },
    chunkText: '百度是一家中国互联网公司,总部位于北京。它运营着全球最大的中文搜索引擎。',
  },
  {
    slug: 'companies/sensetime',
    page: {
      type: 'company',
      title: 'SenseTime / 商汤',
      compiled_truth: 'SenseTime (商汤) is a Chinese AI company specializing in computer vision. SenseTime是一家专注于计算机视觉的中国人工智能公司。',
      timeline: '',
    },
    chunkText: 'SenseTime (商汤) is a Chinese AI company specializing in computer vision.',
  },
];

async function seed() {
  for (const fx of FIXTURES) {
    await engine.putPage(fx.slug, fx.page);
    const chunks: ChunkInput[] = [{
      chunk_index: 0,
      chunk_text: fx.chunkText,
      chunk_source: 'compiled_truth',
    }];
    await engine.upsertChunks(fx.slug, chunks);
  }
}

describe('CJK search via PGLite (bilingual FTS)', () => {
  beforeEach(async () => {
    await truncateAll();
    await seed();
  });

  test('English query returns english page (regression guard)', async () => {
    const results = await engine.searchKeyword('OpenAI');
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('companies/openai');
  });

  test('Chinese single-word query returns Chinese page', async () => {
    const results = await engine.searchKeyword('百度');
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('companies/baidu');
  });

  test('Chinese multi-word query returns Chinese page', async () => {
    // 中国 + 互联网 + 公司 — three segmented words, all should match.
    const results = await engine.searchKeyword('中国互联网');
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('companies/baidu');
  });

  test('Bilingual page found by both English and Chinese terms', async () => {
    const enResults = await engine.searchKeyword('SenseTime');
    expect(enResults.map(r => r.slug)).toContain('companies/sensetime');

    const zhResults = await engine.searchKeyword('商汤');
    expect(zhResults.map(r => r.slug)).toContain('companies/sensetime');
  });

  test('searchKeywordChunks returns chunk rows for CJK query', async () => {
    const results = await engine.searchKeywordChunks('百度');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.slug === 'companies/baidu')).toBe(true);
  });

  test('Empty/Latin-only query has no regression', async () => {
    // No CJK in input; segmentText returns ''; OR-concat is no-op.
    const results = await engine.searchKeyword('San Francisco');
    expect(results.map(r => r.slug)).toContain('companies/openai');
  });

  test('Page-grain search_vector covers CJK content', async () => {
    // Direct query of pages.search_vector via the bilingual tsquery shape —
    // confirms the page trigger built a non-empty CJK channel.
    const conn = (engine as unknown as { db: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> } }).db;
    const { rows } = await conn.query(
      `SELECT slug FROM pages
        WHERE search_vector @@ (websearch_to_tsquery('english', $1) || plainto_tsquery('simple', $2))`,
      ['百度', '百度'],
    );
    const slugs = (rows as { slug: string }[]).map(r => r.slug);
    expect(slugs).toContain('companies/baidu');
  });
});
