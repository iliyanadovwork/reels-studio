// The persisted image-text reveal-mode preferences ('crop' teleprompter vs 'erase' in place — see
// redditTextErase). One key per style, deliberately: a meme IS its image, so the mode restyles the
// whole reel, and flipping it for Reddit image posts shouldn't silently restyle memes too.
//
// A tiny module because TWO components need each key (the pref UI and the card/reel builders), and a
// string literal in both is exactly how the pair drifts apart.

import type { ImageRevealMode } from './redditImageLines';

export const REDDIT_REVEAL_LS = 'reddit:imageRevealMode';
export const MEME_REVEAL_LS = 'meme:imageRevealMode';

/** The persisted mode under `key` — anything but 'erase' (including storage being unavailable) is
    'crop', the default that matches pre-erase behaviour. */
export function getRevealModePref(key: string): ImageRevealMode {
  try { return localStorage.getItem(key) === 'erase' ? 'erase' : 'crop'; } catch { return 'crop'; }
}

export function setRevealModePref(key: string, mode: ImageRevealMode): void {
  try { localStorage.setItem(key, mode); } catch { /* private mode — the session keeps its state */ }
}
