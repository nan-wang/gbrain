/**
 * Wiki-link + entity-resolution behavior for Chinese entities (v0.23 bilingual).
 *
 * Asserts that:
 *   1. ENTITY_REF_RE captures `[百度](companies/baidu)` markdown links cleanly
 *      (display name accepts CJK; ASCII pinyin slug routes to existing slug).
 *   2. WIKILINK_RE captures `[[companies/baidu|百度]]` Obsidian wikilinks.
 *   3. makeResolver().resolve('百度', 'companies') returns 'companies/baidu'
 *      via the pinyin-aware norm() helper (Step 2: dir-hint exact getPage),
 *      no pg_trgm fallback needed.
 *   4. English regression — 'Baidu' continues to resolve via slugify Step 2.
 */

import { describe, test, expect } from 'bun:test';
import {
  extractEntityRefs,
  makeResolver,
  type SlugResolver,
} from '../src/core/link-extraction.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';

describe('extractEntityRefs (CJK display names)', () => {
  test('matches [百度](companies/baidu) markdown link', () => {
    const refs = extractEntityRefs('Looking at [百度](companies/baidu) for context');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('百度');
    expect(refs[0].slug).toBe('companies/baidu');
  });

  test('matches [[companies/baidu|百度]] Obsidian wikilink', () => {
    const refs = extractEntityRefs('See [[companies/baidu|百度]] for details');
    expect(refs).toHaveLength(1);
    expect(refs[0].slug).toBe('companies/baidu');
    expect(refs[0].name).toBe('百度');
  });

  test('matches [百度](companies/baidu.md) (filesystem-style with .md)', () => {
    const refs = extractEntityRefs('See [百度](../companies/baidu.md)');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('百度');
    expect(refs[0].slug).toBe('companies/baidu');
  });

  test('handles multiple CJK refs in one passage', () => {
    const text = 'Both [百度](companies/baidu) and [腾讯](companies/teng-xun) are Chinese.';
    const refs = extractEntityRefs(text);
    expect(refs).toHaveLength(2);
    const slugs = refs.map(r => r.slug).sort();
    expect(slugs).toEqual(['companies/baidu', 'companies/teng-xun']);
  });
});

// Minimal in-memory engine fixture covering only the resolver paths under test.
function fakeEngine(pages: Page[]): BrainEngine {
  const bySlug = new Map(pages.map(p => [p.slug, p]));
  const byTitle = new Map(pages.map(p => [p.title.toLowerCase(), p]));
  const stub = {
    async getPage(slug: string) { return bySlug.get(slug) ?? null; },
    async findByTitleFuzzy(title: string, dirHint?: string | string[], _threshold?: number) {
      // Naive case-insensitive title match scoped to dirHint, sufficient for
      // the pg_trgm-fallback path of makeResolver.
      const hints = Array.isArray(dirHint) ? dirHint : (dirHint ? [dirHint] : []);
      const p = byTitle.get(title.toLowerCase());
      if (!p) return null;
      if (hints.length === 0) return { slug: p.slug, similarity: 1 };
      if (hints.some(h => p.slug.startsWith(`${h}/`))) {
        return { slug: p.slug, similarity: 1 };
      }
      return null;
    },
    async searchKeyword() { return []; },
  };
  return stub as unknown as BrainEngine;
}

describe('makeResolver (CJK names → pinyin slugs)', () => {
  let engine: BrainEngine;
  let resolver: SlugResolver;

  // Fixture: a Chinese-titled company page with the pinyin-derived slug.
  const baseFixture: Page[] = [{
    id: 1, slug: 'companies/baidu', title: '百度',
    type: 'company', compiled_truth: '', timeline: '', frontmatter: {},
    content_hash: 'h', created_at: new Date(), updated_at: new Date(),
  } as unknown as Page];

  test("resolves '百度' → 'companies/baidu' via pinyin-aware norm() (Step 2)", async () => {
    engine = fakeEngine(baseFixture);
    resolver = makeResolver(engine, { mode: 'live' });
    const slug = await resolver.resolve('百度', 'companies');
    expect(slug).toBe('companies/baidu');
  });

  test("resolves 'Baidu' → 'companies/baidu' (English regression)", async () => {
    // The same fixture, but the title field is now Latin so Step 2's
    // norm('Baidu') = 'baidu' → exact getPage hit.
    const enFixture = [{
      ...(baseFixture[0] as unknown as Record<string, unknown>),
      title: 'Baidu',
    } as unknown as Page];
    engine = fakeEngine(enFixture);
    resolver = makeResolver(engine, { mode: 'live' });
    const slug = await resolver.resolve('Baidu', 'companies');
    expect(slug).toBe('companies/baidu');
  });

  test('returns null for unknown CJK names', async () => {
    engine = fakeEngine(baseFixture);
    resolver = makeResolver(engine, { mode: 'batch' });
    const slug = await resolver.resolve('字节跳动', 'companies');
    expect(slug).toBeNull();
  });
});
