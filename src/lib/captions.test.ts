import { describe, it, expect } from 'vitest';
import { buildCaptions, captionAt, captionDisplayText } from './captions';

// charStarts must have one entry per character of `text` (that's the ElevenLabs contract). Build a simple
// linear clock: character i starts at i * step seconds — so a word starting at char index k begins at k*step.
const linearStarts = (text: string, step = 0.05) => Array.from({ length: text.length }, (_, i) => i * step);

describe('buildCaptions — one word at a time', () => {
  it('emits exactly one caption per word', () => {
    const text = 'Hello there. How are you?';
    const caps = buildCaptions(text, linearStarts(text), 10);
    expect(caps.map(c => c.text)).toEqual(['Hello', 'there.', 'How', 'are', 'you?']);
  });

  it("times each word to its first character's start", () => {
    const text = 'Hello there friend';
    const step = 0.05;
    const caps = buildCaptions(text, linearStarts(text, step), 10);
    expect(caps[0].start).toBeCloseTo(0, 5);              // "Hello" at char 0
    expect(caps[1].start).toBeCloseTo(6 * step, 5);       // "there" at char 6
    expect(caps[2].start).toBeCloseTo(12 * step, 5);      // "friend" at char 12
  });

  it('each word holds until the next begins — no blank frames mid-sentence', () => {
    const text = 'One two three';
    const caps = buildCaptions(text, linearStarts(text, 0.1), 9);
    expect(caps[0].end).toBeCloseTo(caps[1].start, 5);
    expect(caps[1].end).toBeCloseTo(caps[2].start, 5);
  });

  it('the last word runs to audioDuration', () => {
    const text = 'One two';
    const caps = buildCaptions(text, linearStarts(text, 0.1), 7.5);
    expect(caps[caps.length - 1].end).toBeCloseTo(7.5, 5);
  });

  it('keeps punctuation attached to its word', () => {
    const text = 'Wait... really?!';
    const caps = buildCaptions(text, linearStarts(text), 5);
    expect(caps.map(c => c.text)).toEqual(['Wait...', 'really?!']);
  });

  it('gives every word a readable minimum on screen', () => {
    // Degenerate clock: every character reports the same time, so raw ends would equal their starts.
    const text = 'fast fast fast';
    const caps = buildCaptions(text, new Array(text.length).fill(2), 5);
    for (const c of caps) expect(c.end).toBeGreaterThan(c.start);
  });

  it('never emits an end before its start (clock jitter is clamped)', () => {
    const text = 'A B C';
    const caps = buildCaptions(text, [5, 4, 3, 2, 1], 6);   // times running backwards
    for (const c of caps) expect(c.end).toBeGreaterThanOrEqual(c.start);
  });

  it('tolerates missing/short charStarts without throwing (falls back to 0 / last)', () => {
    const text = 'Hello there friend.';
    expect(() => buildCaptions(text, [], 3)).not.toThrow();
    const caps = buildCaptions(text, [], 3);
    expect(caps.every(c => c.start === 0)).toBe(true);
    expect(caps[caps.length - 1].end).toBeCloseTo(3, 5);
  });

  it('handles empty / whitespace text as no captions', () => {
    expect(buildCaptions('', [], 5)).toEqual([]);
    expect(buildCaptions('   \n  ', linearStarts('   \n  '), 5)).toEqual([]);
  });
});

describe('captionAt', () => {
  const caps = [
    { text: 'a', start: 0, end: 1 },
    { text: 'b', start: 1, end: 2 },
  ];
  it('returns the caption whose [start,end) contains t', () => {
    expect(captionAt(caps, 0)?.text).toBe('a');
    expect(captionAt(caps, 0.99)?.text).toBe('a');
    expect(captionAt(caps, 1)?.text).toBe('b');    // end is exclusive, start inclusive
  });
  it('returns null before the first / after the last chunk and for undefined', () => {
    expect(captionAt(caps, 2)).toBeNull();
    expect(captionAt(caps, -1)).toBeNull();
    expect(captionAt(undefined, 0.5)).toBeNull();
  });
});

describe('captionDisplayText', () => {
  it('drops trailing sentence punctuation', () => {
    expect(captionDisplayText('there.')).toBe('there');
    expect(captionDisplayText('really?!')).toBe('really');
    expect(captionDisplayText('Wait...')).toBe('Wait');
    expect(captionDisplayText('one,')).toBe('one');
  });

  it('drops surrounding quotes and brackets', () => {
    expect(captionDisplayText('"quoted"')).toBe('quoted');
    expect(captionDisplayText("(aside)")).toBe('aside');
    expect(captionDisplayText('\u201Csmart\u201D')).toBe('smart');
  });

  it('KEEPS punctuation inside a word — it would otherwise misspell it', () => {
    expect(captionDisplayText("don't")).toBe("don't");
    expect(captionDisplayText('well-known')).toBe('well-known');
    expect(captionDisplayText("don't.")).toBe("don't");
    expect(captionDisplayText('3.5')).toBe('3.5');
  });

  it('returns empty for a token that is only punctuation (renderer skips it)', () => {
    expect(captionDisplayText('\u2014')).toBe('');
    expect(captionDisplayText('...')).toBe('');
  });

  it('leaves a clean word untouched', () => {
    expect(captionDisplayText('Hello')).toBe('Hello');
  });
});
