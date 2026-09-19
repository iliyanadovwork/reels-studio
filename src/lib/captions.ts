// Karaoke captions for a commentary voice-over: ONE WORD at a time, the standard Shorts/TikTok look.
// `charStarts` = ElevenLabs alignment.character_start_times_seconds, one entry per character of the SENT
// (cleaned) text — so a word's start is the play time of its first character. Each word stays on screen until
// the next one begins (so there's never a blank frame mid-sentence); the last runs to audioDuration.
export interface Caption { text: string; start: number; end: number }

/** Minimum time a word holds the screen, so a very fast word can't flash by unreadably (or invert). */
const MIN_HOLD_S = 0.12;

export function buildCaptions(text: string, charStarts: number[], audioDuration: number): Caption[] {
  const startAt = (idx: number) => {
    if (!charStarts.length) return 0;
    return charStarts[Math.min(Math.max(0, idx), charStarts.length - 1)] ?? 0;
  };
  const words: { text: string; idx: number }[] = [];
  const re = /\S+/g; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) words.push({ text: m[0], idx: m.index });

  const caps: Caption[] = words.map((w, i) => {
    const next = words[i + 1];
    return {
      text: w.text,
      start: startAt(w.idx),
      // Hand off exactly at the next word's start — a gap would blink the screen empty between words.
      end: next ? startAt(next.idx) : audioDuration,
    };
  });
  // Never let a word's end precede its start (clock jitter / a degenerate timestamp array), and give each
  // one a readable minimum on screen.
  return caps.map(c => ({ ...c, end: Math.max(c.end, c.start + MIN_HOLD_S) }));
}

/** What a caption SHOWS. The stored text keeps its punctuation — that text is what ElevenLabs was given, and
 *  the marks are what make it phrase and pause correctly — but on screen they're noise, so leading/trailing
 *  marks are dropped. Marks INSIDE a word stay: "don't" and "well-known" would otherwise read as misspellings.
 *  Applied at draw time, so it also cleans up reels voiced before this existed. Returns '' for a token that
 *  was nothing but punctuation (a lone dash), which the renderer then skips. */
export function captionDisplayText(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
}

/** The caption visible at intro-clock time `t` (or null before/after). Linear scan — counts are small. */
export function captionAt(captions: Caption[] | undefined, t: number): Caption | null {
  if (!captions) return null;
  for (const c of captions) if (t >= c.start && t < c.end) return c;
  return null;
}
