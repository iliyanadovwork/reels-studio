import type { Framing } from '@/app/components/TikTokCanvas/types';
import { exportLead } from './thumbnailLead';
import { dropCoveredDwells } from './redditDwell';

/** Export frame rate (EXPORT_FPS in useRedditRecording) — only needed to price the thumbnail lead in seconds. */
const EXPORT_FPS = 30;

// ── Short-length model (also drives the reel duration badge + the bulk-builder live estimate) ──
// YouTube Shorts hard ceiling: a video longer than 3:00 can't be published as a Short (raised from 60s in
// Oct 2024). We only WARN at this line — never auto-trim. The reel's final length ≈ its narration audio + a
// ~1s tail of footage (POST_NARRATION_PAD_S in useRedditRecording), so fold that pad into every duration we surface.
export const SHORTS_MAX_SECONDS = 180;
export const NARRATION_TAIL_PAD_S = 1;
// Approx spoken characters/second for the ElevenLabs narrator at speed 1.0 — used ONLY to estimate a reel's
// length from its text BEFORE narration exists (the exact audioDuration replaces the estimate once generated).
// ElevenLabs `speed` is 0.7–1.2 where >1 speeds up = SHORTER audio, so it divides. Slightly conservative so a
// borderline reel flags rather than slips past. Rough by nature; calibratable.
export const EST_CHARS_PER_SEC = 15;

/** Estimated final-video seconds for `text` narrated at `speed` (ElevenLabs' `speed` scales audio length). */
export function estimateNarrationSeconds(text: string, speed: number): number {
  const chars = text.trim().length;
  return chars ? chars / (EST_CHARS_PER_SEC * Math.max(0.5, speed)) + NARRATION_TAIL_PAD_S : 0;
}

/** Final-video duration for a reel: EXACT once narrated (audioDuration + tail pad), else an ESTIMATE from the
    card's enabled text lines.
    `overlayName` is the calling style's `primaryOverlayName` — the overlay that owns the reel's narration and
    so its length. Returns null when that overlay is absent (nothing to measure), and null for a style that
    declares none (`overlayName === null`): this length model is the line-by-line reveal one, where the voice
    IS the video, and applying it to a style whose length is its clip would badly misreport. */
export function reelDurationInfo(framing: Framing | undefined, speed: number, overlayName: string | null): { seconds: number; estimated: boolean } | null {
  if (overlayName === null) return null;
  const overlay = framing?.overlays?.find(o => o.name === overlayName);
  if (!overlay) return null;
  // A custom thumbnail is PREPENDED as held frames, so it lengthens the export — fold it in here too, or the
  // badge would disagree with the file the user actually gets.
  const lead = exportLead(!!framing?.thumbnailId, EXPORT_FPS).seconds;
  if ((overlay.audioDuration ?? 0) > 0) return { seconds: overlay.audioDuration! + NARRATION_TAIL_PAD_S + lead, estimated: false };
  const text = (overlay.ocrLines ?? []).filter(l => l.enabled).map(l => l.text).join(' ');
  // A dwell (the hold on a post image — see lib/redditDwell) is real silence spliced into the narration
  // track, so it lengthens the export exactly like words do. The exact branch above already counts it
  // via audioDuration; the estimate has to add it by hand or the badge under-reports every image post.
  // Same coverage rule as narration itself: a dwell an enabled OCR'd image line makes redundant will be
  // DROPPED at generate time, so pricing it here would overstate every narrated image post by its hold.
  const activeDwells = overlay.ocrLines?.length ? dropCoveredDwells(overlay.dwells, overlay.ocrLines) : overlay.dwells ?? [];
  const held = activeDwells.reduce((n, d) => n + (Number.isFinite(d.sec) ? Math.max(0, d.sec) : 0), 0);
  return text.trim() ? { seconds: estimateNarrationSeconds(text, speed) + lead + held, estimated: true } : null;
}
