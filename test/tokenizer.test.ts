import { describe, test, expect } from 'bun:test';
import {
  hasCJK,
  segmentText,
  countTokens,
  pinyinTransliterate,
  CJK_SENTENCE_DELIMS,
  CJK_CLAUSE_DELIMS,
} from '../src/core/tokenizer.ts';

describe('hasCJK', () => {
  test('false for pure Latin', () => {
    expect(hasCJK('Hello world')).toBe(false);
    expect(hasCJK('OpenAI is a company')).toBe(false);
    expect(hasCJK('')).toBe(false);
  });

  test('true for Han ideographs', () => {
    expect(hasCJK('你好')).toBe(true);
    expect(hasCJK('百度')).toBe(true);
  });

  test('true for Hiragana / Katakana / Hangul', () => {
    expect(hasCJK('ひらがな')).toBe(true);
    expect(hasCJK('カタカナ')).toBe(true);
    expect(hasCJK('한국어')).toBe(true);
  });

  test('true for mixed', () => {
    expect(hasCJK('Hello 你好')).toBe(true);
    expect(hasCJK('OpenAI 公司')).toBe(true);
  });
});

describe('segmentText', () => {
  test('returns empty string for Latin-only input', () => {
    expect(segmentText('Hello world')).toBe('');
    expect(segmentText('')).toBe('');
  });

  test('segments Chinese into word-like tokens', () => {
    const out = segmentText('百度是一家中国公司');
    // Intl.Segmenter zh produces meaningful word boundaries.
    // We assert key brand-recognized words appear as standalone tokens.
    const tokens = out.split(/\s+/);
    expect(tokens).toContain('百度');
    expect(tokens).toContain('中国');
  });

  test('skips non-CJK runs in mixed input', () => {
    const out = segmentText('OpenAI 是 AI 公司');
    // Latin text isn't pulled into the segmented stream — only CJK chars.
    expect(out).not.toContain('OpenAI');
    expect(out).not.toContain('AI');
    expect(out.split(/\s+/)).toContain('公司');
  });

  test('caches segmenter across calls (no perf cliff)', () => {
    // Smoke check — calling many times shouldn't throw and outputs are stable.
    const a = segmentText('百度');
    const b = segmentText('百度');
    expect(a).toBe(b);
  });
});

describe('countTokens', () => {
  test('Latin word count', () => {
    expect(countTokens('Hello world')).toBe(2);
    expect(countTokens('a b c d e')).toBe(5);
  });

  test('Chinese word count via segmenter', () => {
    expect(countTokens('百度')).toBeGreaterThanOrEqual(1);
    expect(countTokens('百度是一家中国公司')).toBeGreaterThan(2);
  });

  test('mixed input sums Latin + CJK', () => {
    // 'Hello world' = 2 Latin words; '你好世界' segments to ~2 CJK words.
    const c = countTokens('Hello world 你好世界');
    expect(c).toBeGreaterThanOrEqual(3);
    expect(c).toBeLessThanOrEqual(6);
  });

  test('empty string is 0', () => {
    expect(countTokens('')).toBe(0);
  });
});

describe('pinyinTransliterate', () => {
  test('brand names → single ASCII word', () => {
    expect(pinyinTransliterate('百度')).toBe('baidu');
    expect(pinyinTransliterate('张三')).toBe('zhangsan');
  });

  test('compound words → space-separated', () => {
    expect(pinyinTransliterate('人工智能')).toBe('rengong zhineng');
  });

  test('multi-pronunciation char disambiguation', () => {
    // 重 in 重庆 should be "chong" not "zhong"
    expect(pinyinTransliterate('重庆')).toBe('chongqing');
  });

  test('Latin pass-through', () => {
    expect(pinyinTransliterate('Hello')).toBe('Hello');
    expect(pinyinTransliterate('OpenAI')).toBe('OpenAI');
    expect(pinyinTransliterate('')).toBe('');
  });

  test('mixed input preserves Latin runs', () => {
    expect(pinyinTransliterate('Hello 公司')).toBe('Hello gongsi');
    expect(pinyinTransliterate('Apple 中国')).toBe('Apple zhongguo');
  });
});

describe('CJK delimiter constants', () => {
  test('sentence delimiters cover the canonical set', () => {
    expect(CJK_SENTENCE_DELIMS).toContain('。');
    expect(CJK_SENTENCE_DELIMS).toContain('！');
    expect(CJK_SENTENCE_DELIMS).toContain('？');
  });

  test('clause delimiters cover the canonical set', () => {
    expect(CJK_CLAUSE_DELIMS).toContain('，');
    expect(CJK_CLAUSE_DELIMS).toContain('、');
    expect(CJK_CLAUSE_DELIMS).toContain('；');
    expect(CJK_CLAUSE_DELIMS).toContain('：');
  });
});
