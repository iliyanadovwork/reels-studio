import { redditStyle } from './reddit';
import { commentaryStyle } from './commentary';
import { memeStyle } from './meme';
import type { ReelStyle } from './types';

export type { ReelStyle, StageDef, CastVoice, VoiceCast, NarrationMode } from './types';

// Registry of reel styles. Adding a style = one entry here + its module — the pipeline shell renders whatever
// stages the active style declares, so styles are inherited rather than hand-built into the pipeline.
export const REEL_STYLES: Record<string, ReelStyle> = {
  [redditStyle.id]: redditStyle,
  [commentaryStyle.id]: commentaryStyle,
  [memeStyle.id]: memeStyle,
};

/** Ordered list for a style picker. */
export const REEL_STYLE_LIST: ReelStyle[] = [redditStyle, commentaryStyle, memeStyle];

export const DEFAULT_STYLE_ID = redditStyle.id;

/** Resolve a style by id, falling back to the default (Reddit) for an unknown/absent id. */
export function getReelStyle(id: string | null | undefined): ReelStyle {
  return (id && REEL_STYLES[id]) || redditStyle;
}
