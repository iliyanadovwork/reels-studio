import type { ReactNode } from 'react';
import type { VideoEntry } from '@/app/types';
import type { Framing } from '@/app/components/TikTokCanvas/types';
import type { StageInfo } from '@/app/components/PipelineView';
import type { PipelineRunState } from '@/lib/pipelineStatus';
import { resolveMusicId, trackById } from '@/lib/music';
import type { ReelStyle, StageDef } from './types';

// Meme style: a meme / screenshot image narrated line by line over background footage from the shared R2
// library. Pipeline: Meme → Footage → Music → Narrate → Export.
//
// It is the Reddit reel with the entire Reddit half removed. What the two share is the ENGINE, not code:
// the image is OCR'd by lib/memeOcr into `ocrLines`, each line gets a reveal boundary, the narrator reads
// the enabled lines and the image un-crops to each line as it's reached (drawing/drawOverlays — which was
// always written in meme terms; its teleprompter pin predates this style). What it does NOT have is the
// thread import, the card renderer, the scout, the bulk builder, the YouTube copy step, or the tweet
// template: a meme is just a meme, so its canvas is a full-bleed clip with the image on top and nothing else.
//
// Where Reddit supplies pixel-exact synthetic lines from its card renderer, a meme reel has no such
// privilege — it OCRs the pixels the user gave it, which is the path generateNarration already falls back to
// for any un-OCR'd overlay. That is why this style needs no narration code of its own.

const svg = (children: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);

/** The meme image: this style's narratable overlay. Named here (not in the shell) for the same reason
    Reddit's is — the generic paths read it as `style.primaryOverlayName`. */
export const MEME_OVERLAY_NAME = 'Meme';

const STAGES: StageDef[] = [
  { key: 'image',   type: 'Source', title: 'Meme',    sub: 'Add the image to narrate',   icon: svg(<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></>) },
  { key: 'footage', type: 'Source', title: 'Footage', sub: 'Assign background clips',    icon: svg(<><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" /><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5" /></>) },
  { key: 'music',   type: 'Source', title: 'Music',   sub: 'Add a background track',     icon: svg(<><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>) },
  { key: 'narrate', type: 'Action', title: 'Narrate', sub: 'Read the meme, line by line', icon: svg(<><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" /></>) },
  { key: 'export',  type: 'Output', title: 'Export',  sub: 'Render MP4s',                icon: svg(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5M12 15V3" /></>) },
];

/** Meme reels are identified by the explicit styleId tag alone. Unlike Reddit there is no legacy fallback to
    write: no reel predates the tag, so an untagged reel is never a meme reel. */
const isReel = (id: string, framingMap: Record<string, Framing>) => framingMap[id]?.styleId === 'meme';

const hasVideo = (e: VideoEntry) => !!(e.localVideoSrc || e.videoUrl || e.data);

function computeStages(entries: VideoEntry[], framingMap: Record<string, Framing>, run: PipelineRunState): StageInfo[] {
  const reels = entries.filter(e => isReel(e.id, framingMap));
  const total = reels.length;
  const memeOf = (e: VideoEntry) => (framingMap[e.id]?.overlays ?? []).find(o => o.name === MEME_OVERLAY_NAME);
  const withImage = reels.filter(e => !!memeOf(e)).length;
  const withFootage = reels.filter(hasVideo).length;
  const withMusic = reels.filter(e => trackById(resolveMusicId(framingMap[e.id]?.musicId)) !== null).length;
  // "Narrated" = the meme overlay carries voiced audio, the same measure Reddit uses for its card.
  const narrated = reels.filter(e => (memeOf(e)?.audioDuration ?? 0) > 0).length;
  const narrRunning = run.batchOp === 'narration';
  return [
    { key: 'image',   done: withImage,   total, running: false },
    { key: 'footage', done: withFootage, total, running: false },
    { key: 'music',   done: withMusic,   total, running: false },
    { key: 'narrate', done: narrated,    total, running: narrRunning, progress: narrRunning ? run.batchProgress : null },
    // Export completion isn't persisted — show live progress while running, idle (0/N) otherwise.
    { key: 'export',  done: run.isDownloadingAll ? run.downloadProgress.done : 0, total, running: run.isDownloadingAll, progress: run.isDownloadingAll ? run.downloadProgress : null },
  ];
}

export const memeStyle: ReelStyle = {
  id: 'meme',
  name: 'Meme',
  stages: STAGES,
  isReel,
  computeStages,

  primaryOverlayName: MEME_OVERLAY_NAME,
  hasPipeline: true,
  // Background footage from our own R2 library — permanent URLs, interchangeable, ~100MB a clip. Same
  // reasoning as Reddit: storing every one would fill IndexedDB to buy nothing. See lib/reelBytes.
  keepsOwnVideo: false,
  assignsFootage: true,
  // OCR'd off the image, read line by line with a reveal — Reddit's narration model, not commentary's script.
  narration: 'overlay',
  // The image floats over the clip rather than covering it, so the letterbox is visible and worth filling.
  supportsBgBlur: true,
  // No fixed cast: the user paints lines with their own voice palette (a meme has no cast of speakers the
  // way a thread does — there is no "post author" to read as anyone in particular).
  voiceCast: null,
  // Only the meme flyout: no thread import, no YouTube copy, and no link input (the clip is assigned).
  railSections: ['meme'],
  sourceLabel: 'New meme reel',
};
