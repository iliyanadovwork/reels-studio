// Timing math for a COMMENTARY intro (a voice-over + captions played over the START of the uploaded video).
// Extracted into ONE place so the live preview and the exporter compute it identically — the earlier bug class
// was these formulas living in two files and silently disagreeing when the video was trimmed (clipStart > 0).
//
// Clocks:
//  - SOURCE time  = seconds into the original uploaded video (what <video>.currentTime / the decoder report).
//  - OUTPUT time  = seconds into the exported reel. The clip starts at `clipStart` (= trimStart) source-seconds,
//                   so OUTPUT 0 corresponds to SOURCE clipStart. A commentary intro is NOT sped up (videoRate 1).
//  - CONTENT time = the voice/caption clock, which starts at 0 at the OUTPUT start. Since audioStart is 0 and
//                   videoRate is 1 for an intro, CONTENT time == OUTPUT time.
//
// The defining invariant: an intro is anchored to the OUTPUT start, so it always plays from its FIRST word —
// trimming the video's head shifts the video, never the voice. Hence the voice start is clamped to 0 (it never
// skips its own head), unlike a Reddit narration whose voice is tied to the footage.

/** Output-time (seconds) at which a commentary intro voice begins. Always ≥ 0: even a trimmed clip plays the
 *  voice from its first word (starting at the output origin), rather than skipping into it. */
export function introVoiceStartOutput(audioStart: number, clipStart: number, videoRate: number): number {
  return Math.max(0, (audioStart - clipStart) / (videoRate || 1));
}

/** Output-time (seconds) at which the intro voice ends — the point the ducked source audio is released back to
 *  full. The voice length is independent of the trim, so this is the start + the full audio duration. */
export function introVoiceEndOutput(audioStart: number, audioDuration: number, clipStart: number, videoRate: number): number {
  return introVoiceStartOutput(audioStart, clipStart, videoRate) + audioDuration;
}

/** Map a SOURCE-time (seconds) to the intro CONTENT clock (voice/captions), whose origin is the output start
 *  (clipStart). Negative results mean "before the clip start" — the caller treats those as no caption yet. */
export function introContentTime(sourceTime: number, clipStart: number): number {
  return sourceTime - clipStart;
}
