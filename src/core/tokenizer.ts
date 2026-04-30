/**
 * CJK tokenization + transliteration helpers.
 *
 * Single source of truth for everything that needs to handle Chinese, Japanese,
 * or Korean text:
 *   - keyword search FTS pre-segmentation (`segmentText`),
 *   - chunker token counting + boundary delimiters (`countTokens`,
 *     CJK_SENTENCE_DELIMS, CJK_CLAUSE_DELIMS),
 *   - slug pinyin transliteration (`pinyinTransliterate`).
 *
 * Why JS-side: `Intl.Segmenter` is built into V8/JSC via ICU. Pure JS, no
 * native binding, bundles cleanly into `bun build --compile`. PGLite (WASM
 * Postgres) cannot run JS in a trigger, so the segmented text has to be
 * computed in app code and stored in mirror columns the trigger reads.
 */
import { pinyin } from 'pinyin-pro';

// CJK character ranges: Hiragana, Katakana, CJK Unified Ideographs, Hangul.
// Same set used by `src/core/search/expansion.ts:75-77`.
const CJK_PATTERN = /[぀-ゟ゠-ヿ一-鿿가-힯]/;
const CJK_RUN_PATTERN = /[぀-ゟ゠-ヿ一-鿿가-힯]+/g;
// Han ideographs only — pinyin only applies to these (not kana/Hangul).
const HAN_PATTERN = /[一-鿿]/;

/** CJK sentence terminators — chunker level-2 delimiters. */
export const CJK_SENTENCE_DELIMS = ['。', '！', '？', '。\n', '！\n', '？\n'];

/** CJK clause/comma punctuation — chunker level-3 delimiters. */
export const CJK_CLAUSE_DELIMS = ['；', '：', '，', '、'];

/** True iff text contains any CJK character. */
export function hasCJK(text: string): boolean {
  return CJK_PATTERN.test(text);
}

// Lazy module-level segmenter cache. `Intl.Segmenter` construction is ~ms,
// reused across thousands of pages.
let _zhSegmenter: Intl.Segmenter | null = null;
function zhSegmenter(): Intl.Segmenter {
  if (_zhSegmenter === null) {
    _zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  }
  return _zhSegmenter;
}

/**
 * Segment text into a space-separated stream of word-like tokens, suitable
 * for `to_tsvector('simple', ...)` indexing alongside the existing English
 * channel.
 *
 * Returns the empty string when no CJK characters are present, so callers can
 * concat the result into a tsquery and have the right side become a no-op
 * empty tsquery for Latin-only inputs.
 */
export function segmentText(text: string): string {
  if (!text || !hasCJK(text)) return '';
  const seg = zhSegmenter();
  const out: string[] = [];
  // Walk runs: CJK chars get segmented; non-CJK runs are ignored (they're
  // already covered by the english tsvector channel).
  let lastIdx = 0;
  CJK_RUN_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CJK_RUN_PATTERN.exec(text)) !== null) {
    const run = m[0];
    for (const s of seg.segment(run)) {
      if (s.isWordLike && s.segment.trim().length > 0) {
        out.push(s.segment);
      }
    }
    lastIdx = m.index + run.length;
  }
  void lastIdx;
  return out.join(' ');
}

/**
 * Token count for chunker sizing. Latin runs counted by whitespace tokens;
 * CJK runs counted by segmenter word output. Mixed input sums both.
 *
 * Used by chunkers as the unit of "chunk size" so 300-token chunks remain
 * meaningful for both English and Chinese.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  if (!hasCJK(text)) {
    return (text.match(/\S+/g) || []).length;
  }
  let count = 0;
  let cursor = 0;
  CJK_RUN_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  const seg = zhSegmenter();
  while ((m = CJK_RUN_PATTERN.exec(text)) !== null) {
    const before = text.slice(cursor, m.index);
    if (before.trim().length > 0) count += (before.match(/\S+/g) || []).length;
    for (const s of seg.segment(m[0])) {
      if (s.isWordLike) count += 1;
    }
    cursor = m.index + m[0].length;
  }
  const tail = text.slice(cursor);
  if (tail.trim().length > 0) count += (tail.match(/\S+/g) || []).length;
  return count;
}

/**
 * Transliterate Han ideographs to toneless pinyin, preserving Latin and
 * other-script characters in place. Word-aware: uses `Intl.Segmenter` to find
 * CJK word boundaries, runs each word through pinyin-pro separately, and
 * joins syllables within a word with no separator. Different words separate
 * with a single space.
 *
 * Examples:
 *   pinyinTransliterate('百度')          → 'baidu'
 *   pinyinTransliterate('人工智能')      → 'rengong zhineng'
 *   pinyinTransliterate('重庆')          → 'chongqing'
 *   pinyinTransliterate('Hello 公司')    → 'Hello gongsi'
 *   pinyinTransliterate('Hello')         → 'Hello'
 *
 * Slug pipelines downstream turn whitespace runs into hyphens, so brand-name
 * input like 百度 round-trips to a clean ASCII slug `baidu`.
 *
 * Only Han ideographs (一-鿿) are transliterated. Hiragana, katakana,
 * and Hangul fall through to the existing ASCII strip in slugify (v1 scope).
 */
export function pinyinTransliterate(text: string): string {
  if (!text || !HAN_PATTERN.test(text)) return text;
  const seg = zhSegmenter();
  // Walk text, replacing each Han run with its pinyin transliteration.
  let result = '';
  let cursor = 0;
  const HAN_RUN = /[一-鿿]+/g;
  HAN_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HAN_RUN.exec(text)) !== null) {
    result += text.slice(cursor, m.index);
    const words: string[] = [];
    for (const s of seg.segment(m[0])) {
      if (!s.isWordLike) continue;
      // pinyin-pro returns space-separated syllables by default; join within
      // a single word with no separator so 百度 → "baidu" not "bai du".
      const syllables = pinyin(s.segment, { toneType: 'none', type: 'array' });
      words.push(syllables.join(''));
    }
    result += words.join(' ');
    cursor = m.index + m[0].length;
  }
  result += text.slice(cursor);
  return result;
}
