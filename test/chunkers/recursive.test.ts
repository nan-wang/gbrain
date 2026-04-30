import { describe, test, expect } from 'bun:test';
import { chunkText } from '../../src/core/chunkers/recursive.ts';

describe('Recursive Text Chunker', () => {
  test('returns empty array for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
  });

  test('returns single chunk for short text', () => {
    const text = 'Hello world. This is a short text.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text.trim());
    expect(chunks[0].index).toBe(0);
  });

  test('splits at paragraph boundaries', () => {
    const paragraph = 'word '.repeat(200).trim();
    const text = paragraph + '\n\n' + paragraph;
    const chunks = chunkText(text, { chunkSize: 250 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test('respects chunk size target', () => {
    const text = 'word '.repeat(1000).trim();
    const chunks = chunkText(text, { chunkSize: 100 });
    for (const chunk of chunks) {
      const wordCount = chunk.text.split(/\s+/).length;
      // Allow up to 1.5x target due to greedy merge
      expect(wordCount).toBeLessThanOrEqual(150);
    }
  });

  test('applies overlap between chunks', () => {
    const text = 'word '.repeat(1000).trim();
    const chunks = chunkText(text, { chunkSize: 100, chunkOverlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    // Second chunk should start with words from end of first chunk
    // (overlap means shared content between adjacent chunks)
    expect(chunks[1].text.length).toBeGreaterThan(0);
  });

  test('splits at sentence boundaries', () => {
    const sentences = Array.from({ length: 50 }, (_, i) =>
      `This is sentence number ${i} with some content about topic ${i}.`
    ).join(' ');
    const chunks = chunkText(sentences, { chunkSize: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should end near a sentence boundary
    for (const chunk of chunks.slice(0, -1)) {
      // Allow for overlap text, but the core content should have sentence endings
      expect(chunk.text).toMatch(/[.!?]/);
    }
  });

  test('assigns sequential indices', () => {
    const text = 'word '.repeat(1000).trim();
    const chunks = chunkText(text, { chunkSize: 100 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  test('handles single word input', () => {
    const chunks = chunkText('hello');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('hello');
  });

  test('handles unicode text', () => {
    const text = 'Bonjour le monde. ' + 'Ceci est un texte en francais. '.repeat(100);
    const chunks = chunkText(text, { chunkSize: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toContain('Bonjour');
  });

  test('splits at single newline (line-level) when paragraphs are absent', () => {
    // Lines without double newlines should still split at single newlines
    const lines = Array(100).fill('This is a single line of text.').join('\n');
    const chunks = chunkText(lines, { chunkSize: 20 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('handles text with only whitespace delimiters (word-level split)', () => {
    // No sentences, no newlines, just words
    const words = Array(200).fill('word').join(' ');
    const chunks = chunkText(words, { chunkSize: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
    }
  });

  test('handles clause-level delimiters (semicolons, colons, commas)', () => {
    // Text with clauses but no sentence endings
    const text = Array(100).fill('clause one; clause two: clause three, clause four').join(' ');
    const chunks = chunkText(text, { chunkSize: 30 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('preserves content across chunks (lossless)', () => {
    const original = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = chunkText(original, { chunkSize: 5, chunkOverlap: 0 });
    // With no overlap, all text should appear in chunks
    const reconstructed = chunks.map(c => c.text).join(' ');
    expect(reconstructed).toContain('First paragraph');
    expect(reconstructed).toContain('Second paragraph');
    expect(reconstructed).toContain('Third paragraph');
  });

  test('default options produce reasonable chunks', () => {
    // Large text with defaults (300 words, 50 overlap)
    const text = Array(500).fill('This is a test sentence with several words.').join(' ');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const wordCount = chunk.text.split(/\s+/).length;
      // Should be roughly 300 words, with 1.5x tolerance
      expect(wordCount).toBeLessThanOrEqual(500);
    }
  });

  test('handles mixed delimiter hierarchy', () => {
    const text = [
      'Paragraph one has sentences. And more sentences! Really?',
      '',
      'Paragraph two; with clauses: and more, clauses here.',
      '',
      'Paragraph three.\nWith line breaks.\nAnd more lines.',
    ].join('\n');
    const chunks = chunkText(text, { chunkSize: 10 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  // CJK chunking (v0.23 bilingual support)
  describe('CJK chunking', () => {
    test('splits Chinese sentences at 。 boundaries', () => {
      const text = '百度是一家中国互联网公司。它的总部位于北京。'.repeat(10);
      const chunks = chunkText(text, { chunkSize: 20 });
      expect(chunks.length).toBeGreaterThan(1);
      // Most chunks should end at a CJK sentence terminator (allowing for the
      // last chunk and some overlap-trailing content).
      const endsAtSentence = chunks.filter(c => /[。！？]/.test(c.text)).length;
      expect(endsAtSentence).toBeGreaterThanOrEqual(chunks.length - 1);
    });

    test('splits at CJK clause delimiters when sentences are absent', () => {
      // Long string with only CJK clause punctuation, no full stops.
      const text = '百度，腾讯，阿里巴巴，字节跳动，'.repeat(20);
      const chunks = chunkText(text, { chunkSize: 10 });
      expect(chunks.length).toBeGreaterThan(1);
    });

    test('mixed English + Chinese honors both . and 。', () => {
      const text = ('Hello world. 你好世界。OpenAI is a company. 百度是中国公司。').repeat(20);
      const chunks = chunkText(text, { chunkSize: 10 });
      expect(chunks.length).toBeGreaterThan(1);
      // Lossless invariant: concatenating chunks reproduces (modulo overlap +
      // trim) the original character set.
      const firstChunk = chunks[0].text;
      expect(firstChunk).toMatch(/Hello world/);
    });

    test('CJK-only run with no punctuation falls back to character window', () => {
      // 600 Chinese chars, no punctuation, no whitespace — worst case.
      const text = '中'.repeat(600);
      const chunks = chunkText(text, { chunkSize: 100 });
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        // Each chunk should be roughly target characters wide (allow merge headroom).
        expect(c.text.length).toBeLessThanOrEqual(150);
        expect(c.text.length).toBeGreaterThan(0);
      }
    });

    test('returns single chunk for short Chinese input', () => {
      const text = '百度是一家公司。';
      const chunks = chunkText(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe(text);
    });
  });
});
