import { describe, it, expect } from 'vitest';
import { confidentWordsText, classifyOcrLine, type WordFilterOpts } from './memeOcr';

// Word-level gates exist because a line can clear tesseract's LINE confidence bar while dragging
// garbage words along — the observed case: ABORT-O-MATIC machine labels OCR'd as low-confidence
// fragments ("ABORT I REORT") on the same line as a real sentence. These run only when a caller
// passes opts (the Reddit card); the meme style passes none and never enters this code.

const REDDIT: WordFilterOpts = { dropWordsBelow: 45, minKeptWords: 2 };
const w = (text: string, confidence: number) => ({ text, confidence });

describe('confidentWordsText', () => {
  it('strips low-confidence garbage words and keeps the sentence', () => {
    // The observed failure: sentence words score high, machine-label bleed scores low.
    const words = [w('pull', 92), w('a', 90), w('lever', 91), w('ABORT', 30), w('I', 22), w('REORT', 18)];
    expect(confidentWordsText(words, REDDIT)).toBe('pull a lever');
  });

  it('rejects a line whose confident words are too few to be real text', () => {
    // "I SHIT" from a drawing region: even if one word squeaks over the floor, one word is not a line.
    expect(confidentWordsText([w('I', 50), w('SHIT', 40)], REDDIT)).toBeNull();
    expect(confidentWordsText([w('I', 30), w('SHIT', 28)], REDDIT)).toBeNull();
  });

  it('keeps a clean line untouched', () => {
    const words = [w('Oh-no', 88), w('an', 95), w('out', 96), w('of', 97), w('control', 93)];
    expect(confidentWordsText(words, REDDIT)).toBe('Oh-no an out of control');
  });

  it('treats the floor as inclusive', () => {
    expect(confidentWordsText([w('at', 45), w('floor', 45)], REDDIT)).toBe('at floor');
    expect(confidentWordsText([w('just', 44.9), w('under', 44.9)], REDDIT)).toBeNull();
  });

  it('ignores empty/whitespace word fragments regardless of confidence', () => {
    expect(confidentWordsText([w('  ', 99), w('real', 80), w('words', 80)], REDDIT)).toBe('real words');
  });

  it('returns null with no opts floor or no words — the caller then uses the raw line text', () => {
    expect(confidentWordsText([w('a', 99), w('b', 99)], {})).toBeNull();
    expect(confidentWordsText(undefined, REDDIT)).toBeNull();
    expect(confidentWordsText([], REDDIT)).toBeNull();
  });

  it('defaults minKeptWords to 1 when only a floor is given', () => {
    expect(confidentWordsText([w('solo', 80)], { dropWordsBelow: 45 })).toBe('solo');
  });
});

describe('classifyOcrLine — why lines get dropped (drives the flyout report)', () => {
  it('keeps a clean confident line', () => {
    expect(classifyOcrLine('Do nothing please', 80)).toBeNull();
  });
  it('names low confidence with the score — the boxed-button case', () => {
    expect(classifyOcrLine('0o nothing', 54)).toBe('low confidence (54)');
  });
  it('names the too-short rule', () => {
    expect(classifyOcrLine('OK', 90)).toBe('too short (under 3 letters)');
  });
  it('names the chrome heuristic', () => {
    expect(classifyOcrLine('2m Like Reply', 90)).toBe('looks like social-UI chrome');
  });
  it('checks confidence FIRST — a low-confidence chrome line reports the actionable reason', () => {
    expect(classifyOcrLine('Like', 20)).toBe('low confidence (20)');
  });
});
