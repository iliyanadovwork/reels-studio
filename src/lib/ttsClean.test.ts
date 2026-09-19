import { describe, it, expect } from 'vitest';
import { ttsClean } from './ttsClean';

// ttsClean normalises text for the ElevenLabs NARRATOR only (the card keeps the original). Rules are fixed
// patterns — these tests pin each one, plus the real-world offenders from the MK-Ultra reel, and assert the
// things it must NOT touch (numbers, currency, apostrophes, mixed case, known acronyms).

describe('ttsClean — URLs, emails, handles', () => {
  it('strips http(s) URLs (with query strings)', () => {
    expect(ttsClean('see http://example.com/path?q=1&x=2 now')).toBe('see now');
    expect(ttsClean('read https://reddit.com/r/x/comments/1 later')).toBe('read later');
  });
  it('strips bare www. links and emails', () => {
    expect(ttsClean('visit www.reddit.com today')).toBe('visit today');
    expect(ttsClean('mail bob.smith@test.co please')).toBe('mail please');
  });
  it('reads Reddit handles as the name, not "r slash"', () => {
    expect(ttsClean('from r/AskReddit and u/gunfriends')).toBe('from AskReddit and gunfriends');
  });
  it('does NOT mangle a slash mid-word (author/editor is not a handle)', () => {
    expect(ttsClean('the author/editor role')).toBe('the author editor role');
  });
});

describe('ttsClean — emoji & symbols', () => {
  it('drops emoji and pictographs', () => {
    expect(ttsClean('great \u{1F525} stuff \u{1F389}\u{1F44D}')).toBe('great stuff');
  });
  it('& -> and, % -> percent', () => {
    expect(ttsClean('cats & dogs')).toBe('cats and dogs');
    expect(ttsClean('50% sure')).toBe('50 percent sure');
  });
  it('slash between words -> space (and/or, CIA/FBI)', () => {
    expect(ttsClean('and/or maybe')).toBe('and or maybe');
    expect(ttsClean('the CIA/FBI files')).toBe('the CIA FBI files');
  });
  it('strips markdown/formatting noise but keeps the words', () => {
    expect(ttsClean('a *bold* ~word~ ^up |pipe <ang> #tag @home')).toBe('a bold word up pipe ang tag home');
  });
  it('removes zero-width + control characters', () => {
    expect(ttsClean('a\u200Bb\u0007c')).toBe('a b c');   // ZWSP + BEL -> spaces -> collapsed
  });
});

describe('ttsClean — de-shout ALL-CAPS', () => {
  it('Title-cases shouted WORDS >=5 letters with a vowel', () => {
    expect(ttsClean('MK ULTRA was real')).toBe('MK Ultra was real');
    expect(ttsClean('COINTELPRO existed')).toBe('Cointelpro existed');
    expect(ttsClean('this is AMAZING')).toBe('this is Amazing');
  });
  it('LEAVES short or vowelless acronyms alone', () => {
    expect(ttsClean('the FBI, CIA, MK and USA')).toBe('the FBI, CIA, MK and USA');
    expect(ttsClean('NASA and NATO')).toBe('NASA and NATO');   // 4 letters -> untouched
  });
  it('keeps punctuation attached to a de-shouted word', () => {
    expect(ttsClean('ULTRA, then ULTRA.')).toBe('Ultra, then Ultra.');
  });
  it('does not touch mixed-case brand names', () => {
    expect(ttsClean('iPhone and eBay and ChatGPT')).toBe('iPhone and eBay and ChatGPT');
  });
});

describe('ttsClean — leaves numbers/currency/punctuation to the voice', () => {
  it('never rewrites digits, years, currency or dates (ElevenLabs handles those)', () => {
    expect(ttsClean('$1,000,000 raised in 1964 on August 4th')).toBe('$1,000,000 raised in 1964 on August 4th');
  });
  it('preserves apostrophes, quotes, hyphens and parentheses', () => {
    expect(ttsClean('don\'t (really) - "yes"')).toBe('don\'t (really) - "yes"');
  });
  it('collapses shouty repeated punctuation and whitespace', () => {
    expect(ttsClean('wait!!!   really???')).toBe('wait! really?');
    expect(ttsClean('hmm.... yeah')).toBe('hmm… yeah');
    expect(ttsClean('  padded   text  ')).toBe('padded text');
  });
});

describe('ttsClean — edge cases', () => {
  it('empty in -> empty out; junk-only -> empty', () => {
    expect(ttsClean('')).toBe('');
    expect(ttsClean('https://x.com/y')).toBe('');
    expect(ttsClean('\u{1F525}\u{1F525}')).toBe('');
  });
  it('a realistic messy line cleans to natural speech', () => {
    expect(ttsClean('OMG check https://x.co \u{1F525} the CIA/FBI & MK ULTRA files!!!'))
      .toBe('OMG check the CIA FBI and MK Ultra files!');
    // "OMG" (3) stays; URL + emoji gone; slash -> space; & -> and; ULTRA -> Ultra; !!! -> !
  });
});

describe('ttsClean - review fixes', () => {
  it('drops emoji skin-tone modifiers + keycaps (no orphan codepoint reaches the voice)', () => {
    expect(ttsClean('thumbs \u{1F44D}\u{1F3FD} nice')).toBe('thumbs nice');
    expect(ttsClean('\u{1F44D}\u{1F3FD}')).toBe('');
    expect(ttsClean('#\uFE0F\u20E3 test')).toBe('test');   // # + VS16 + combining enclosing keycap
  });
  it('keeps digit/digit slashes (fractions + dates) for ElevenLabs, splits the rest', () => {
    expect(ttsClean('1/2 of them agree')).toBe('1/2 of them agree');
    expect(ttsClean('the party is on 12/25 this year')).toBe('the party is on 12/25 this year');
    expect(ttsClean('open 24/7 always')).toBe('open 24/7 always');
    expect(ttsClean('and/or maybe')).toBe('and or maybe');
    expect(ttsClean('the CIA/FBI files')).toBe('the CIA FBI files');
    expect(ttsClean('a path/ here')).toBe('a path here');
  });
  it('leaves Roman numerals for the voice to read as numbers', () => {
    expect(ttsClean('Super Bowl LVIII was great')).toBe('Super Bowl LVIII was great');
    expect(ttsClean('released MMXIV edition')).toBe('released MMXIV edition');
    expect(ttsClean('MK ULTRA')).toBe('MK Ultra');
  });
  it('strips C1 control characters (NEL U+0085)', () => {
    expect(ttsClean('a\u0085b')).toBe('a b');
  });
});
