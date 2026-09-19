import type { ReactNode } from 'react';
import type { Framing } from '@/app/components/TikTokCanvas/types';
import { computePipelineStages } from '@/lib/pipelineStatus';
import type { ReelStyle, StageDef, VoiceCast } from './types';

// The original style: a Reddit thread narrated over random gameplay footage. Scout → Import & pick → Footage →
// Music → Narrate → Copy → Export. (Moved verbatim out of PipelineView so the pipeline renderer is generic.)

/** The rendered thread card: this style's narratable overlay. Exported because the Reddit-specific parts of
    the shell (the card builder, the bulk builder) name the overlay they create; everything GENERIC reads it
    as `style.primaryOverlayName` instead, which is what keeps the shared code style-blind. */
export const REDDIT_OVERLAY_NAME = 'Reddit thread';

// Fixed voice cast for Reddit thread cards (ElevenLabs voice IDs). The post always reads as Mark; each
// distinct commenter draws a random voice from the pool (stable per author on a card, no repeats until the
// pool is exhausted; an OP reply reuses Mark). Edit here to recast. Lives with the style, not in the shell,
// so the narration flyout can show A cast without knowing WHOSE.
const MARK = { id: 'UgBBYS2sOqTuMpoF3BR0', name: 'Mark' };        // Natural Conversations (US)

// SINGLE-VOICE FOR NOW: Mark reads the post AND every commenter. castBlockVoices draws non-lead speakers
// from `pool`, so a one-entry pool collapses the whole cast onto him — and because a retired voice is
// revoiced to `pool[0]` at narration time, cards cast before this change re-voice to Mark too rather than
// keeping a stale multi-voice mix.
//
// To bring the multi-voice cast back: restore the three below into `pool` and drop them from
// DISABLED_VOICES in CanvasGrid. Nothing else needs to change — the casting logic is untouched.
//   { id: 'NNl6r8mD7vthiJatiJt1', name: 'Bradford' }   Expressive and Articulate (British)
//   { id: 'EkK5I93UQWFDigLMpZcX', name: 'James' }      Husky, Engaging and Bold (US)
//   { id: 'aMSt68OGf4xUZAnLpTU8', name: 'Juniper' }    Grounded and Professional (US)
const REDDIT_VOICE_CAST: VoiceCast = {
  lead: MARK,
  pool: [MARK],
};

const svg = (children: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);

const STAGES: StageDef[] = [
  { key: 'scout',   type: 'Source', title: 'Scout',         sub: 'Discover Reddit posts',       icon: svg(<><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></>) },
  // Import + Pick are one surface (the bulk builder does fetch AND pick/edit/preview) — a single node.
  { key: 'import',  type: 'Build',  title: 'Import & pick', sub: 'Fetch, pick & edit threads',  icon: svg(<><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>) },
  { key: 'footage', type: 'Source', title: 'Footage',       sub: 'Assign background clips',      icon: svg(<><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" /><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5" /></>) },
  { key: 'music',   type: 'Source', title: 'Music',         sub: 'Add a background track',       icon: svg(<><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>) },
  { key: 'narrate', type: 'Action', title: 'Narrate',       sub: 'ElevenLabs voice-over',        icon: svg(<><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" /></>) },
  { key: 'copy',    type: 'Action', title: 'Copy',          sub: 'YouTube title & description',  icon: svg(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" /></>) },
  { key: 'export',  type: 'Output', title: 'Export',        sub: 'Render MP4s',                  icon: svg(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5M12 15V3" /></>) },
];

/** A reel is a Reddit reel iff it's tagged 'reddit' OR (legacy, untagged) it carries the "Reddit thread"
    card overlay. computePipelineStages is handed the same predicate, so tagged + legacy reels agree. */
const isReel = (id: string, framingMap: Record<string, Framing>) => {
  const f = framingMap[id];
  if (f?.styleId) return f.styleId === 'reddit';
  return (f?.overlays ?? []).some(o => o.name === REDDIT_OVERLAY_NAME);
};

export const redditStyle: ReelStyle = {
  id: 'reddit',
  name: 'Reddit thread',
  stages: STAGES,
  isReel,
  // import → export (the shell prepends the Scout source node). The counter module is style-blind: it's told
  // which reels are ours and what the narratable overlay is called, rather than knowing either itself.
  computeStages: (entries, framingMap, run) =>
    computePipelineStages(entries, framingMap, run, { isReel, primaryOverlayName: REDDIT_OVERLAY_NAME }),

  primaryOverlayName: REDDIT_OVERLAY_NAME,
  hasPipeline: true,
  // Background footage is interchangeable, re-rollable and ~100MB a clip: storing every one would fill
  // IndexedDB to buy nothing, and the R2 URL never expires. See lib/reelBytes.
  keepsOwnVideo: false,
  assignsFootage: true,
  narration: 'overlay',
  // The card covers the video, so there is no letterbox to fill — the blur was never visible here.
  supportsBgBlur: false,
  voiceCast: REDDIT_VOICE_CAST,
  // Reels are built in BULK from imported threads, not one at a time from a button.
  sourceLabel: null,
  railSections: ['reddit', 'yt-copy'],
};
