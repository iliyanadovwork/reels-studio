import type { ReactNode } from 'react';
import type { VideoEntry } from '@/app/types';
import type { Framing } from '@/app/components/TikTokCanvas/types';
import type { StageInfo } from '@/app/components/PipelineView';
import type { PipelineRunState } from '@/lib/pipelineStatus';
import { resolveMusicId, trackById } from '@/lib/music';
import type { ReelStyle, StageDef } from './types';

// Commentary style: an uploaded video with a written AI voice-over at the start, synced captions, and a music
// bed (the video's own audio ducked under the intro). Pipeline: Upload → Commentary → Narrate → Music → Export.
// Reuses the shared engine (canvas render, export, narration TTS + mix, music); only the source (upload +
// script), the caption render, and the ducking mix are commentary-specific (added in later phases).

const svg = (children: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
);

const STAGES: StageDef[] = [
  { key: 'upload',     type: 'Source', title: 'Upload',     sub: 'Add a video to comment on',   icon: svg(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5M12 3v12" /></>) },
  { key: 'commentary', type: 'Build',  title: 'Commentary', sub: 'Write the voice-over script',  icon: svg(<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M8 9h8M8 13h5" /></>) },
  { key: 'narrate',    type: 'Action', title: 'Narrate',    sub: 'ElevenLabs voice-over',        icon: svg(<><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" /></>) },
  { key: 'music',      type: 'Source', title: 'Music',      sub: 'Add a background track',       icon: svg(<><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>) },
  { key: 'export',     type: 'Output', title: 'Export',     sub: 'Render MP4',                    icon: svg(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5M12 15V3" /></>) },
];

/** Commentary reels are identified by the explicit styleId tag (they have no distinguishing overlay). */
const isReel = (id: string, framingMap: Record<string, Framing>) => framingMap[id]?.styleId === 'commentary';

const hasVideo = (e: VideoEntry) => !!(e.localVideoSrc || e.videoUrl || e.data);

function computeStages(entries: VideoEntry[], framingMap: Record<string, Framing>, run: PipelineRunState): StageInfo[] {
  const reels = entries.filter(e => isReel(e.id, framingMap));
  const total = reels.length;
  const uploaded = reels.filter(hasVideo).length;
  const scripted = reels.filter(e => framingMap[e.id]?.commentaryScript?.trim()).length;
  // Narration attaches to an overlay carrying audio (built in a later phase); "done" = a reel has voiced audio.
  const narrated = reels.filter(e => (framingMap[e.id]?.overlays ?? []).some(o => (o.audioDuration ?? 0) > 0)).length;
  const withMusic = reels.filter(e => trackById(resolveMusicId(framingMap[e.id]?.musicId)) !== null).length;
  const narrRunning = run.batchOp === 'narration';
  return [
    { key: 'upload',     done: uploaded,  total, running: false },
    { key: 'commentary', done: scripted,  total, running: false },
    { key: 'narrate',    done: narrated,  total, running: narrRunning, progress: narrRunning ? run.batchProgress : null },
    { key: 'music',      done: withMusic, total, running: false },
    // Export completion isn't persisted — show live progress while running, idle (0/N) otherwise.
    { key: 'export',     done: run.isDownloadingAll ? run.downloadProgress.done : 0, total, running: run.isDownloadingAll, progress: run.isDownloadingAll ? run.downloadProgress : null },
  ];
}

export const commentaryStyle: ReelStyle = {
  id: 'commentary',
  name: 'Commentary',
  stages: STAGES,
  isReel,
  computeStages,

  // No narratable card: the voice is a SCRIPT, written into a single intro carrier overlay. Null rather than
  // the intro overlay's name on purpose — the duration/narrate-status models keyed to primaryOverlayName are
  // Reddit's line-by-line reveal model, which doesn't describe a commentary reel (whose length is the CLIP,
  // not the voice-over). See commentaryPlan.ts for the length that does.
  primaryOverlayName: null,
  // Made one reel at a time on the canvas; a pipeline over it would be empty ceremony.
  hasPipeline: false,
  // A resolved link is a SIGNED, EXPIRING CDN URL — a commentary reel that stored only its link eventually
  // cannot be played or exported at all. See lib/reelBytes.
  keepsOwnVideo: true,
  // Brings its own video (upload or link), so a new reel is blank and waiting for it.
  assignsFootage: false,
  narration: 'script',
  // Full-bleed video inside a 9:16 frame: a portrait-cropped landscape clip leaves real letterbox.
  supportsBgBlur: true,
  voiceCast: null,
  sourceLabel: 'New commentary reel',
  railSections: ['link', 'commentary'],
};
