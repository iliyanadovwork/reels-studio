// Deterministic text normaliser for the AI NARRATOR (ElevenLabs). It strips the mechanical junk the voice
// reads wrong - URLs, emails, emojis, stray symbols, Reddit r//u/ prefixes, and shouted ALL-CAPS words -
// while LEAVING numbers, dates, fractions and currency to ElevenLabs' own normalisation (which handles them).
//
// Applied ONLY to the text sent to the voice, per narration LINE (see generateNarration): the on-screen card
// keeps the authored Reddit text, and because the reveal timing maps by line INDEX (not by matching the exact
// characters), cleaning within a line can never desync the reveal. Pure + unit-tested.
//
// KNOWN LIMITS (accepted - rare + no clean deterministic rule): a letter-spelled acronym that is >=5 letters
// with a vowel (NAACP, ASPCA) de-shouts to a fake word; math/code tokens (C++, <3, x^2, a=b) lose their
// symbols. Both are uncommon in narrated Reddit prose. No AI: every rule is a fixed pattern - free, instant,
// deterministic and testable (an LLM here would add latency/cost and could silently reword the script).

const VOWEL = /[AEIOU]/;
const ROMAN = /^[IVXLCDM]+$/;   // Roman numerals (LVIII, MMXIV) - leave for ElevenLabs to read as numbers.

/** Title-case a shouted word: first letter upper, the rest lower ("ULTRA" -> "Ultra"). */
const deshout = (w: string): string => w.charAt(0) + w.slice(1).toLowerCase();

export function ttsClean(text: string): string {
  if (!text) return '';
  let s = text;

  // 1. Zero-width + C0/C1 control characters - never spoken, and can corrupt the character alignment.
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, ' ');

  // 2. URLs + emails - read out letter-by-letter otherwise.
  s = s.replace(/https?:\/\/\S+/gi, ' ');
  s = s.replace(/\bwww\.\S+/gi, ' ');
  s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, ' ');

  // 3. Reddit handles - read the name, not "r slash". r/AskReddit -> AskReddit, u/name -> name.
  s = s.replace(/\b(?:r|u)\/([A-Za-z0-9_]+)/g, '$1');

  // 4. Emoji / pictographs / variation selectors / skin-tone modifiers / keycap / regional indicators.
  s = s.replace(/[\uFE0F\u200D\u20E3\u{1F1E6}-\u{1F1FF}\p{Emoji_Modifier}]/gu, '');
  s = s.replace(/\p{Extended_Pictographic}/gu, '');

  // 5. Spoken-symbol swaps (& was already decoded from &amp; at import).
  s = s.replace(/&/g, ' and ');
  s = s.replace(/%/g, ' percent ');
  // Slash: keep a digit/digit slash (dates + fractions - ElevenLabs reads "one half", "December 25th"); any
  // other slash becomes a space so it isn't read as the word "slash" (and/or -> and or, CIA/FBI -> CIA FBI).
  s = s.replace(/(?<!\d)\/|\/(?!\d)/g, ' ');

  // 6. Strip remaining non-speech symbols (they read as noise), keeping letters, digits, $, / and sentence
  //    punctuation ( . , ! ? ; : ' " - ( ) ).
  s = s.replace(/[*_~^|<>=+`[\]{}\\#@]/g, ' ');

  // 7. De-shout: an ALL-CAPS word of >=5 letters WITH a vowel is a shouted WORD (ULTRA, COINTELPRO), not an
  //    acronym - Title-case it so the voice reads it instead of spelling/shouting. Short or vowelless caps
  //    (FBI, CIA, MK, NASA, USA) and Roman numerals (LVIII, MMXIV) are left as-is.
  s = s.replace(/\b[A-Z]{5,}\b/g, m => (VOWEL.test(m) && !ROMAN.test(m) ? deshout(m) : m));

  // 8. Collapse runs: shouty repeated punctuation and any whitespace the steps above introduced.
  s = s.replace(/([!?])\1+/g, '$1');       // !!! -> !, ??? -> ?
  s = s.replace(/\.{2,}/g, '\u2026');      // ... -> ellipsis (one pause)
  s = s.replace(/\s+/g, ' ');

  return s.trim();
}
