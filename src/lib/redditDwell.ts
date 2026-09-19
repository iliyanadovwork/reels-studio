// A DWELL is a beat of silence the reel holds while something WORDLESS is on screen — today, a Reddit
// post's image.
//
// Narration is otherwise driven entirely by TEXT: each narrated line becomes characters in a TTS take,
// its first character's timestamp is its beat, and the card un-crops to that line's boundary just
// before the beat lands. An image has no line, so it has no beat and no reveal — it would be scrolled
// past unseen, in silence that never happens. A dwell fixes both halves at once: it inserts real zero
// samples into the stitched track (so the voice actually stops) and reports where they start (so a
// reveal can fire there and the image is uncropped for exactly as long as the silence lasts).
//
// Everything here is pure sample/second arithmetic — the caller owns the Float32Arrays and the
// AudioContext. With no dwells every function reproduces the plain stitch it replaced, byte for byte;
// that equivalence is the first thing the tests assert, because a card with no image must behave
// EXACTLY as it did before this existed.

/** How long the reel holds on a post image. Long enough to actually look at it, short enough that a
    ~40s short doesn't feel stalled. ONE constant — the card stamps it into its dwell, and the stitch
    just honours whatever seconds it's handed. */
export const IMAGE_DWELL_S = 1.8;

export interface Dwell {
  /** Index of the line this silence FOLLOWS. -1 = before the first line (a pre-roll). Which index
      space depends on the stage: the card emits card-line indices; resolveDwells translates them onto
      the narrated (enabled-only) lines that planStitch and buildReveals speak. */
  afterLineIdx: number;
  /** Seconds of silence. */
  sec: number;
  /** Visible fraction of the card once the dwell reveals — the crop boundary BELOW the image. */
  bottomFrac: number;
}

/** One TTS take as the stitcher sees it: how many samples it decoded to, each of its lines' first
    character times (take-local seconds), and the voice that read it. */
export interface Take {
  samples: number;
  beats: number[];
  voiceId: string;
}

/** Copy `[from, to)` of take `takeIdx` to offset `dst` of the stitched buffer. A take with no dwell
    inside it yields exactly one of these — the whole take, as before. */
export interface StitchCopy { takeIdx: number; from: number; to: number; dst: number }

export interface StitchPlan {
  /** Length of the stitched track — audioDuration is this over the sample rate. */
  totalSamples: number;
  copies: StitchCopy[];
  /** Absolute audio time (s) of each narrated line's first character, in narrated-line order. */
  beatStarts: number[];
  /** Absolute audio time (s) where each dwell's silence begins, aligned with the `dwells` input. */
  dwellStarts: number[];
  /** Contiguous runs of voiced audio, for the timeline's per-voice blocks. A dwell inside a take
      splits its block in two so the hold is visible as the silence it is. */
  audioTakes: { voiceId: string; start: number; duration: number }[];
}

/**
 * Drop every dwell that an enabled line has made REDUNDANT — and only those.
 *
 * A dwell exists to give wordless content screen time: it holds the voice and uncovers the card down
 * to `bottomFrac`. When the image's OCR'd lines are narrated, the LAST of them carries that exact
 * boundary, so the dwell would double the image's screen time. But which lines are narrated is the
 * user's per-click decision on the canvas, made long after the card rendered — so the card always
 * ships its dwell, and THIS is where it's dropped, against the enablement in force right now:
 *
 *   covered ⇔ some ENABLED line at or before the dwell's anchor reaches its boundary.
 *
 * The "at or before the anchor" half is load-bearing: lines BELOW the image (comments) reach past the
 * dwell's boundary by construction, and counting them would drop every dwell on every card. And when
 * the user mutes all the image's lines (junk OCR — the advertised remedy), nothing before the anchor
 * reaches the boundary anymore, the dwell survives, and the image keeps its hold and its reveal —
 * which is exactly the pre-OCR behaviour they asked back for.
 */
export function dropCoveredDwells(
  dwells: readonly Dwell[] | undefined,
  lines: readonly { bottomFrac: number; enabled: boolean }[],
): Dwell[] {
  if (!dwells?.length) return [];
  const EPS = 1e-6;
  return dwells.filter(d => {
    for (let i = 0; i < lines.length && i <= d.afterLineIdx; i++) {
      if (lines[i].enabled && lines[i].bottomFrac >= d.bottomFrac - EPS) return false;
    }
    return true;
  });
}

/**
 * Translate card-line anchors onto the NARRATED line sequence: the user can switch lines off, and only
 * enabled lines become beats. A dwell follows the last narrated line at or before its anchor, so
 * switching off the line it was anchored to slides it up to the previous one rather than losing it.
 * Everything before the first narrated line resolves to -1 (a pre-roll).
 */
export function resolveDwells(dwells: readonly Dwell[] | undefined, enabled: readonly boolean[]): Dwell[] {
  if (!dwells?.length) return [];
  return dwells
    // A zero/negative/NaN hold is not a dwell, and a non-finite boundary would poison the reveal list.
    .filter(d => Number.isFinite(d.sec) && d.sec > 0 && Number.isFinite(d.bottomFrac))
    .map(d => {
      let narrated = 0;
      for (let i = 0; i < enabled.length && i <= d.afterLineIdx; i++) if (enabled[i]) narrated++;
      return { ...d, afterLineIdx: narrated - 1 };
    })
    .sort((a, b) => a.afterLineIdx - b.afterLineIdx);
}

/**
 * Lay the takes out end to end (a breath of `gapSamples` between them, as before) with each dwell's
 * silence spliced in after its anchor line.
 *
 * Splicing mid-take is the normal case, not the exception: Reddit reads in ONE voice, so the whole
 * card is a single take and the image sits inside it. The cut is made at the NEXT line's first
 * character — the gap between two spoken lines — so it lands in silence rather than inside a word.
 */
export function planStitch({ takes, dwells, gapSamples, sampleRate }: {
  takes: readonly Take[];
  /** afterLineIdx in NARRATED-line space (see resolveDwells). Out-of-range anchors are clamped. */
  dwells: readonly Dwell[];
  gapSamples: number;
  sampleRate: number;
}): StitchPlan {
  const copies: StitchCopy[] = [];
  const beatStarts: number[] = [];
  const dwellStarts: number[] = [];
  const audioTakes: StitchPlan['audioTakes'] = [];

  const lineCount = takes.reduce((n, t) => n + t.beats.length, 0);
  const byAnchor = new Map<number, number[]>();
  dwells.forEach((d, i) => {
    const anchor = Math.min(Math.max(Math.trunc(d.afterLineIdx), -1), lineCount - 1);
    const at = byAnchor.get(anchor);
    if (at) at.push(i); else byAnchor.set(anchor, [i]);
  });
  const silence = (sec: number) => Math.max(0, Math.round(sec * sampleRate));

  let cursor = 0;      // absolute sample offset the next chunk is written at
  let line = 0;        // narrated-line index across takes

  // A dwell anchored before the first narrated line (every line above the image switched off) opens
  // the track: the image is up, in silence, before anyone speaks.
  for (const di of byAnchor.get(-1) ?? []) {
    dwellStarts[di] = cursor / sampleRate;
    cursor += silence(dwells[di].sec);
  }

  takes.forEach((take, takeIdx) => {
    if (takeIdx > 0) cursor += gapSamples;
    let from = 0;               // samples of this take already placed
    let blockStart = cursor;    // absolute start of the current contiguous run of this take's audio
    const place = (to: number) => {
      if (to > from) { copies.push({ takeIdx, from, to, dst: cursor }); cursor += to - from; from = to; }
    };
    const closeBlock = () => {
      if (cursor > blockStart) audioTakes.push({ voiceId: take.voiceId, start: blockStart / sampleRate, duration: (cursor - blockStart) / sampleRate });
    };
    for (let l = 0; l < take.beats.length; l++, line++) {
      // The take's clock is offset by everything already written — its own start plus any dwell that
      // has since split it — so a line's absolute beat is that offset plus its in-take timestamp.
      beatStarts[line] = (cursor - from) / sampleRate + take.beats[l];
      for (const di of byAnchor.get(line) ?? []) {
        const nextBeat = l + 1 < take.beats.length ? Math.round(take.beats[l + 1] * sampleRate) : take.samples;
        place(Math.min(take.samples, Math.max(from, nextBeat)));
        closeBlock();
        dwellStarts[di] = cursor / sampleRate;
        cursor += silence(dwells[di].sec);
        blockStart = cursor;
      }
    }
    place(take.samples);
    closeBlock();
  });

  return { totalSamples: cursor, copies, beatStarts, dwellStarts, audioTakes };
}

/**
 * The progressive-reveal steps for a stitched track: one per narrated line (a breath BEFORE its first
 * word, so the text is on screen as it's read) plus one per dwell (exactly ON the silence, so the
 * image arrives as the voice stops). Monotonic — a step that wouldn't uncover anything new is dropped
 * so the card can never crop back up.
 *
 * Times are in SOURCE time: the background video runs `rate`× faster than the voice, so audio-time
 * beats are scaled onto the video's clock.
 */
export function buildReveals({ lineBeats, lineFracs, dwells, dwellStarts, audioStart, leadS, rate }: {
  lineBeats: readonly number[];
  lineFracs: readonly number[];
  dwells: readonly Dwell[];
  dwellStarts: readonly number[];
  audioStart: number;
  leadS: number;
  rate: number;
}): { t: number; h: number }[] {
  const reveals: { t: number; h: number }[] = [];
  let lastH = 0;
  const emit = (t: number, h: number) => {
    if (reveals.length && h <= lastH) return;
    lastH = Math.max(lastH, h);
    reveals.push({ t, h: lastH });
  };
  const byAnchor = new Map<number, number[]>();
  dwells.forEach((d, i) => {
    const at = byAnchor.get(d.afterLineIdx);
    if (at) at.push(i); else byAnchor.set(d.afterLineIdx, [i]);
  });
  // No REVEAL_LEAD_S on a dwell: the lead exists so a line is readable before it's spoken, but a dwell
  // has nothing to speak — its whole job is to land with the silence.
  const emitDwells = (idx: number) => {
    for (const di of byAnchor.get(idx) ?? []) emit(audioStart + (dwellStarts[di] ?? 0) * rate, dwells[di].bottomFrac);
  };

  emitDwells(-1);
  for (let i = 0; i < lineBeats.length; i++) {
    emit(audioStart + Math.max(0, lineBeats[i] - leadS) * rate, lineFracs[i]);
    emitDwells(i);
  }
  return reveals;
}
