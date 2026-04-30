/**
 * Recursive Delimiter-Aware Text Chunker
 * Ported from production Ruby implementation (text_chunker.rb, 205 LOC)
 *
 * 5-level delimiter hierarchy:
 *   1. Paragraphs (\n\n)
 *   2. Lines (\n)
 *   3. Sentences (. ! ? followed by space or newline; also CJK 。！？)
 *   4. Clauses (; : , ; also CJK ；：，、)
 *   5. Words (whitespace; CJK fallback splits at segmenter word boundaries)
 *
 * Config: 300-token chunks with 50-token sentence-aware overlap. Tokens are
 * Latin words OR CJK words (via Intl.Segmenter), summed for mixed content
 * via `countTokens` so 300-token chunks are meaningful for both languages.
 *
 * Lossless invariant: non-overlapping portions reassemble to original.
 */
import { hasCJK, countTokens } from '../tokenizer.ts';

const DELIMITERS: string[][] = [
  ['\n\n'],                                                                                                      // L0: paragraphs
  ['\n'],                                                                                                        // L1: lines
  ['. ', '! ', '? ', '.\n', '!\n', '?\n', '。', '！', '？', '。\n', '！\n', '？\n'],                            // L2: sentences (Latin + CJK)
  ['; ', ': ', ', ', '；', '：', '，', '、'],                                                                    // L3: clauses (Latin + CJK)
  [],                                                                                                            // L4: words (whitespace + CJK segmenter fallback)
];

export interface ChunkOptions {
  chunkSize?: number;    // target tokens per chunk (default 300)
  chunkOverlap?: number; // overlap tokens (default 50)
}

export interface TextChunk {
  text: string;
  index: number;
}

export function chunkText(text: string, opts?: ChunkOptions): TextChunk[] {
  const chunkSize = opts?.chunkSize || 300;
  const chunkOverlap = opts?.chunkOverlap || 50;

  if (!text || text.trim().length === 0) return [];

  const wordCount = countTokens(text);
  if (wordCount <= chunkSize) {
    return [{ text: text.trim(), index: 0 }];
  }

  // Recursively split, then greedily merge to target size
  const pieces = recursiveSplit(text, 0, chunkSize);
  const merged = greedyMerge(pieces, chunkSize);
  const withOverlap = applyOverlap(merged, chunkOverlap);

  return withOverlap.map((t, i) => ({ text: t.trim(), index: i }));
}

function recursiveSplit(text: string, level: number, target: number): string[] {
  if (level >= DELIMITERS.length) {
    return splitFallback(text, target);
  }

  const delimiters = DELIMITERS[level];
  if (delimiters.length === 0) {
    return splitFallback(text, target);
  }

  const pieces = splitAtDelimiters(text, delimiters);

  // If splitting didn't help (only 1 piece), try next level
  if (pieces.length <= 1) {
    return recursiveSplit(text, level + 1, target);
  }

  // Check if any piece is still too large, recurse deeper
  const result: string[] = [];
  for (const piece of pieces) {
    if (countTokens(piece) > target) {
      result.push(...recursiveSplit(piece, level + 1, target));
    } else {
      result.push(piece);
    }
  }

  return result;
}

/**
 * Split text at delimiter boundaries, preserving delimiters at the end
 * of the piece that precedes them (lossless).
 */
function splitAtDelimiters(text: string, delimiters: string[]): string[] {
  const pieces: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let earliest = -1;
    let earliestDelim = '';

    for (const delim of delimiters) {
      const idx = remaining.indexOf(delim);
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
        earliestDelim = delim;
      }
    }

    if (earliest === -1) {
      pieces.push(remaining);
      break;
    }

    // Include the delimiter with the preceding text
    const piece = remaining.slice(0, earliest + earliestDelim.length);
    if (piece.trim().length > 0) {
      pieces.push(piece);
    }
    remaining = remaining.slice(earliest + earliestDelim.length);
  }

  // Handle trailing content
  if (remaining.trim().length > 0 && !pieces.includes(remaining)) {
    // Already added above
  }

  return pieces.filter(p => p.trim().length > 0);
}

/**
 * Fallback splitter for L4 (no delimiters left). Routes to whitespace-based
 * splitting for Latin and a CJK-aware character-window splitter for runs of
 * unsegmentable Chinese (no whitespace, no CJK punctuation).
 *
 * The character-window approach is intentionally simple — for the worst case
 * (a 5000-character Chinese paragraph with no punctuation), it slices every
 * `target` characters. Higher levels handle the typical case (sentence and
 * clause delimiters do most of the work).
 */
function splitFallback(text: string, target: number): string[] {
  if (hasCJK(text) && !/\s/.test(text)) {
    return splitCJKChars(text, target);
  }
  return splitOnWhitespace(text, target);
}

function splitOnWhitespace(text: string, target: number): string[] {
  const words = text.match(/\S+\s*/g) || [];
  if (words.length === 0) return [];

  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += target) {
    const slice = words.slice(i, i + target).join('');
    if (slice.trim().length > 0) {
      pieces.push(slice);
    }
  }
  return pieces;
}

/**
 * Slice a CJK run into pieces of approximately `target` characters. Lossless
 * (every character preserved). Used only when sentence/clause delimiters
 * fail to break a long CJK run, which is rare — most CJK content uses
 * `。！？` punctuation that L2 catches.
 */
function splitCJKChars(text: string, target: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += target) {
    const slice = text.slice(i, i + target);
    if (slice.trim().length > 0) pieces.push(slice);
  }
  return pieces;
}

/**
 * Greedily merge adjacent pieces until each chunk is near the target size.
 * Avoids creating chunks larger than target * 1.5.
 */
function greedyMerge(pieces: string[], target: number): string[] {
  if (pieces.length === 0) return [];

  const result: string[] = [];
  let current = pieces[0];

  for (let i = 1; i < pieces.length; i++) {
    const combined = current + pieces[i];
    if (countTokens(combined) <= Math.ceil(target * 1.5)) {
      current = combined;
    } else {
      result.push(current);
      current = pieces[i];
    }
  }

  if (current.trim().length > 0) {
    result.push(current);
  }

  return result;
}

/**
 * Apply sentence-aware trailing overlap.
 * The last N tokens of chunk[i] are prepended to chunk[i+1].
 */
function applyOverlap(chunks: string[], overlapWords: number): string[] {
  if (chunks.length <= 1 || overlapWords <= 0) return chunks;

  const result: string[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prevTrailing = extractTrailingContext(chunks[i - 1], overlapWords);
    result.push(prevTrailing + chunks[i]);
  }

  return result;
}

/**
 * Extract the last N tokens from text, trying to align to sentence boundaries.
 * If a sentence boundary exists within the last N tokens, start there.
 *
 * For CJK-only chunks (no whitespace), tokens are characters approximately,
 * so we slice the last N characters and try to align at a `。！？` boundary.
 */
function extractTrailingContext(text: string, targetWords: number): string {
  if (hasCJK(text) && !/\s/.test(text)) {
    if (text.length <= targetWords) return '';
    const trailing = text.slice(-targetWords);
    // Try to align to a CJK sentence boundary inside `trailing`.
    const sentenceStart = trailing.search(/[。！？]/);
    if (sentenceStart !== -1 && sentenceStart < trailing.length / 2) {
      const afterSentence = trailing.slice(sentenceStart).replace(/^[。！？]\s*/, '');
      if (afterSentence.trim().length > 0) return afterSentence;
    }
    return trailing;
  }

  const words = text.match(/\S+\s*/g) || [];
  if (words.length <= targetWords) return '';

  const trailing = words.slice(-targetWords).join('');

  // Try to find a sentence boundary (Latin or CJK) to start from
  const sentenceStart = trailing.search(/[.!?。！？]\s*/);
  if (sentenceStart !== -1 && sentenceStart < trailing.length / 2) {
    const afterSentence = trailing.slice(sentenceStart).replace(/^[.!?。！？]\s*/, '');
    if (afterSentence.trim().length > 0) {
      return afterSentence;
    }
  }

  return trailing;
}
