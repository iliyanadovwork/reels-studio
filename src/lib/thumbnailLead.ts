// A reel with a custom thumbnail gets that still image held for a few frames at the very START of the
// exported MP4, before any footage. YouTube gives you no way to upload a thumbnail for a Short — the only
// custom option is picking a frame out of the video — so baking the artwork into the opening frames makes it
// selectable in the frame picker.
//
// The lead is PREPENDED, not overwritten: no footage is lost and the audio shifts with it. Everything that
// has to agree on "how much did we add" reads it from here — the export loop, the audio mix, and the
// duration badges — so they cannot drift apart.

/**
 * How long the still is held, in output seconds.
 *
 * Expressed as a DURATION, not a frame count, because the thing it has to survive is YouTube's Shorts frame
 * picker — a drag-slider over the whole clip, where what matters is pixels of travel, not frames. On a ~38s
 * Short across a ~350px mobile slider that is ~0.11 s/px, so 0.1s is under a pixel of travel: raise this if the
 * picker turns out not to land on it. The cost of raising it is a visible static card before the reel starts.
 */
export const THUMB_LEAD_S = 0.1;

export interface ExportLead {
  /** Output frames of held thumbnail. 0 when the reel has no thumbnail. */
  frames: number;
  /** Those frames in output seconds — what the audio mix and the duration model shift by. */
  seconds: number;
}

export const NO_LEAD: ExportLead = { frames: 0, seconds: 0 };

/**
 * The lead for one export. A reel without a thumbnail gets NO_LEAD, which makes every call site below a
 * no-op — that is what keeps this feature invisible to the reels that don't use it.
 */
export function exportLead(hasThumbnail: boolean, fps: number): ExportLead {
  if (!hasThumbnail || !Number.isFinite(fps) || fps <= 0) return NO_LEAD;
  // At least one frame, then `seconds` is derived BACK from the rounded frame count — never from
  // THUMB_LEAD_S directly. The audio shift has to land exactly on a frame boundary, or the mix drifts
  // from the video by the rounding error.
  const frames = Math.max(1, Math.round(THUMB_LEAD_S * fps));
  return { frames, seconds: frames / fps };
}

/** Does this output frame belong to the held thumbnail rather than the footage? */
export function isLeadFrame(frameIdx: number, lead: ExportLead): boolean {
  return frameIdx < lead.frames;
}

/**
 * Which SOURCE timestamp a given output frame should sample.
 *
 * The invariant this exists to protect: prepending must not change which source time any footage frame
 * samples. Output frame `lead.frames + n` must resolve to exactly what output frame `n` resolved to before
 * the thumbnail existed. Lead frames themselves clamp to clipStart so they never decode anything.
 */
export function sourceTimeFor(
  frameIdx: number,
  lead: ExportLead,
  frameDuration: number,
  videoRate: number,
  clipStart: number,
): number {
  const contentIdx = Math.max(0, frameIdx - lead.frames);
  return contentIdx * frameDuration * videoRate + clipStart;
}

/** Total output frames for a reel: its own footage frames plus the held lead. */
export function totalOutputFrames(outputDuration: number, fps: number, lead: ExportLead): number {
  if (!Number.isFinite(outputDuration) || outputDuration <= 0) return lead.frames;
  return Math.floor(outputDuration * fps) + lead.frames;
}

/**
 * Shift an output-timeline audio offset by the lead. Every source in the mix goes through this, so the
 * whole mix moves as one block and nothing lands under the thumbnail.
 */
export function shiftForLead(outputSeconds: number, lead: ExportLead): number {
  return Math.max(0, outputSeconds) + lead.seconds;
}
