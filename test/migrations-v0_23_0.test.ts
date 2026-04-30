/**
 * v0.23.0 — CJK pre-segmented columns migration (v30).
 *
 * Asserts the v30 migration ships the DDL bilingual FTS depends on:
 *   - 3 *_segmented columns on pages (weights A/B/C)
 *   - 2 *_segmented columns on content_chunks (weights B + A)
 *   - Replaced page-grain trigger with bilingual english+simple shape
 *   - Replaced chunk-grain trigger with bilingual shape
 *   - Widened chunk trigger BEFORE INSERT OR UPDATE OF clause
 *
 * Structural only — runs against the MIGRATIONS registry without executing SQL.
 * Behavioral coverage lives in test/e2e/cjk-search.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { MIGRATIONS } from '../src/core/migrate.ts';

describe('v0.23.0 — CJK pre-segmented columns', () => {
  const v30 = MIGRATIONS.find(m => m.version === 30);

  test('v30 migration exists in registry', () => {
    expect(v30).toBeDefined();
    expect(v30?.name).toBe('cjk_pre_segmented_columns');
  });

  test('adds title_segmented to pages', () => {
    expect(v30!.sql).toMatch(/ADD COLUMN IF NOT EXISTS title_segmented\s+TEXT/);
  });

  test('adds compiled_truth_segmented to pages', () => {
    expect(v30!.sql).toMatch(/ADD COLUMN IF NOT EXISTS compiled_truth_segmented\s+TEXT/);
  });

  test('adds timeline_segmented to pages', () => {
    expect(v30!.sql).toMatch(/ADD COLUMN IF NOT EXISTS timeline_segmented\s+TEXT/);
  });

  test('adds chunk_text_segmented to content_chunks', () => {
    expect(v30!.sql).toMatch(/ADD COLUMN IF NOT EXISTS chunk_text_segmented\s+TEXT/);
  });

  test('adds doc_comment_segmented to content_chunks', () => {
    expect(v30!.sql).toMatch(/ADD COLUMN IF NOT EXISTS doc_comment_segmented\s+TEXT/);
  });

  test('page trigger function has bilingual shape (3 simple-channel adds)', () => {
    expect(v30!.sql).toMatch(/CREATE OR REPLACE FUNCTION update_page_search_vector/);
    // Three to_tsvector('simple', ...) calls — title (A), compiled_truth (B), timeline (C).
    const simpleChannels = v30!.sql.match(/to_tsvector\('simple',/g);
    // 3 in pages trigger + 2 in chunks trigger = 5 total
    expect(simpleChannels?.length).toBe(5);
  });

  test('page trigger preserves english channel (regression guard)', () => {
    expect(v30!.sql).toMatch(/setweight\(to_tsvector\('english', coalesce\(NEW\.title/);
    expect(v30!.sql).toMatch(/setweight\(to_tsvector\('english', coalesce\(NEW\.compiled_truth/);
    expect(v30!.sql).toMatch(/setweight\(to_tsvector\('english', coalesce\(NEW\.timeline/);
  });

  test('chunk trigger function has bilingual shape (2 simple-channel adds)', () => {
    expect(v30!.sql).toMatch(/CREATE OR REPLACE FUNCTION update_chunk_search_vector/);
    expect(v30!.sql).toMatch(/setweight\(to_tsvector\('simple',\s+COALESCE\(NEW\.doc_comment_segmented/);
    expect(v30!.sql).toMatch(/setweight\(to_tsvector\('simple',\s+COALESCE\(NEW\.chunk_text_segmented/);
  });

  test('chunk trigger preserves english + symbol_name_qualified channels', () => {
    expect(v30!.sql).toMatch(/setweight\(to_tsvector\('english', COALESCE\(NEW\.doc_comment/);
    expect(v30!.sql).toMatch(/setweight\(to_tsvector\('english', COALESCE\(NEW\.symbol_name_qualified/);
    expect(v30!.sql).toMatch(/setweight\(to_tsvector\('english', COALESCE\(NEW\.chunk_text/);
  });

  test('chunk trigger BEFORE INSERT OR UPDATE OF widens to include segmented cols', () => {
    expect(v30!.sql).toMatch(/BEFORE INSERT OR UPDATE OF [\s\S]*chunk_text_segmented[\s\S]*doc_comment_segmented/);
  });

  test('migration is identical SQL on both engines (no sqlFor)', () => {
    expect(v30!.sql).toBeTruthy();
    // sqlFor would override sql per-engine; we want symmetric behavior here.
    expect((v30 as { sqlFor?: unknown }).sqlFor).toBeUndefined();
  });
});
