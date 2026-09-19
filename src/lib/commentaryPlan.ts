// Playback plan for a commentary reel.
//
// A commentary reel plays its video TWICE:
//   Phase A ("under the commentary") — the clip runs from its start with its own audio heavily muted while
//     the voice-over plays on top. If the commentary outlasts the clip, the clip loops to cover it.
//   Phase B ("the reel proper")      — the moment the voice-over ends, the clip RESTARTS from its beginning
//     and plays through once at full volume, with no captions.
//
// So the output is `introDur + clipDur` long, and the source is decoded across several passes. To keep the
// exporter's forward-only decoder happy, everything is expressed on one monotonically increasing clock: the
// ABSOLUTE position, measured in source-seconds from the clip start, accumulated across passes. Phase B
// begins at the next whole pass boundary, which is exactly what makes "restart from the beginning" line up
// with a fresh decode pass.
//
// Shared by the preview and the exporter so the two cannot drift.

/** Gain applied to the clip's OWN audio while the commentary plays over it — heavily muted, but not silent,
 *  so the scene still reads. Used by the preview and the export mix alike. */
export const COMMENTARY_DUCK_GAIN = 0.06;

export interface CommentaryPlan {
  /** Voice-over length in seconds (0 = no commentary: the reel is just the clip, played once). */
  introDur: number;
  /** Trimmed clip length in seconds. */
  clipDur: number;
  /** Whole clip passes consumed by phase A (≥1 whenever there's a commentary). */
  introPasses: number;
  /** Total output length in seconds. */
  total: number;
  /** Total clip passes the exporter must decode. */
  passes: number;
}

export function commentaryPlan(introDur: number, clipDur: number): CommentaryPlan {
  const clip = Math.max(0.001, clipDur);
  const intro = Math.max(0, introDur);
  if (intro <= 0) {
    // No commentary yet — the reel is simply the clip, played once.
    return { introDur: 0, clipDur: clip, introPasses: 0, total: clip, passes: 1 };
  }
  // Phase A occupies whole passes so phase B can start on a fresh decode pass (a real restart).
  const introPasses = Math.ceil(intro / clip);
  return { introDur: intro, clipDur: clip, introPasses, total: intro + clip, passes: introPasses + 1 };
}

/** Is output time `t` inside the commentary (phase A)? */
export function isIntroPhase(t: number, plan: CommentaryPlan): boolean {
  return plan.introDur > 0 && t < plan.introDur;
}

/** Absolute source position (source-seconds from the clip start, accumulated across passes) shown at output
 *  time `t`. Monotonically increasing in `t`, which is what lets the exporter decode straight through. */
export function absolutePositionAt(t: number, plan: CommentaryPlan): number {
  const clamped = Math.max(0, t);
  if (!isIntroPhase(clamped, plan)) {
    // Phase B restarts the clip at the next whole pass boundary.
    return plan.introPasses * plan.clipDur + (clamped - plan.introDur);
  }
  return clamped;   // phase A runs the clip continuously (looping if the commentary outlasts it)
}

/** Offset INTO the clip (0 … clipDur) at output time `t` — i.e. where the playhead sits within the video. */
export function clipOffsetAt(t: number, plan: CommentaryPlan): number {
  const abs = absolutePositionAt(t, plan);
  const off = abs % plan.clipDur;
  // A position landing exactly on a pass boundary is the START of the next pass, except at the very end of
  // the output where it means "the final frame of the last pass".
  return off < 0 ? 0 : off;
}
