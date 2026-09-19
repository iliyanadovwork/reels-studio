import { describe, it, expect } from 'vitest';
import { planStitch, resolveDwells, buildReveals, dropCoveredDwells, IMAGE_DWELL_S, type Take, type Dwell } from './redditDwell';

// 1000 samples = 1 second, so every offset below reads as milliseconds.
const SR = 1000;
const GAP = 250;                                     // the 0.25s breath between voices
const A: Take = { samples: 4000, beats: [0, 1, 2, 3], voiceId: 'mark' };
const B: Take = { samples: 2000, beats: [0, 1], voiceId: 'liam' };

// The stitch/reveal code EXACTLY as it read before dwells existed. A card with no image must still
// produce this, sample for sample — so the "no dwell" tests below compare against it rather than
// against numbers I typed out, which would drift with the fixtures.
function legacyStitch(takes: Take[]) {
  const totalSamples = takes.reduce((n, s) => n + s.samples, 0) + GAP * (takes.length - 1);
  const beatStarts: number[] = [];
  const audioTakes: { voiceId: string; start: number; duration: number }[] = [];
  let cursor = 0;
  for (const seg of takes) {
    for (const b of seg.beats) beatStarts.push(cursor / SR + b);
    audioTakes.push({ voiceId: seg.voiceId, start: cursor / SR, duration: seg.samples / SR });
    cursor += seg.samples + GAP;
  }
  return { totalSamples, beatStarts, audioTakes };
}
function legacyReveals(beatStarts: number[], fracs: number[], audioStart: number, lead: number, rate: number) {
  let lastH = 0;
  const out: { t: number; h: number }[] = [];
  for (let i = 0; i < fracs.length; i++) {
    const h = fracs[i];
    if (h <= lastH && i > 0) continue;
    lastH = Math.max(lastH, h);
    out.push({ t: audioStart + Math.max(0, beatStarts[i] - lead) * rate, h: lastH });
  }
  return out;
}

const plan = (takes: Take[], dwells: Dwell[] = []) => planStitch({ takes, dwells, gapSamples: GAP, sampleRate: SR });
const dwell = (afterLineIdx: number, sec = IMAGE_DWELL_S, bottomFrac = 0.5): Dwell => ({ afterLineIdx, sec, bottomFrac });

/** Every sample of every take is placed exactly once, in order, with no overlap in the output. */
function expectTotalPartition(p: ReturnType<typeof plan>, takes: Take[]) {
  for (let ti = 0; ti < takes.length; ti++) {
    const mine = p.copies.filter(c => c.takeIdx === ti);
    expect(mine[0]?.from).toBe(0);
    expect(mine[mine.length - 1]?.to).toBe(takes[ti].samples);
    for (let i = 1; i < mine.length; i++) expect(mine[i].from).toBe(mine[i - 1].to);
  }
  const spans = p.copies.map(c => ({ a: c.dst, b: c.dst + (c.to - c.from) })).sort((x, y) => x.a - y.a);
  for (let i = 1; i < spans.length; i++) expect(spans[i].a).toBeGreaterThanOrEqual(spans[i - 1].b);
  expect(spans[spans.length - 1].b).toBeLessThanOrEqual(p.totalSamples);
}

describe('planStitch — with no dwells, nothing changes', () => {
  it('reproduces the pre-dwell stitch for one take', () => {
    const p = plan([A]);
    const legacy = legacyStitch([A]);
    expect(p.totalSamples).toBe(legacy.totalSamples);
    expect(p.beatStarts).toEqual(legacy.beatStarts);
    expect(p.audioTakes).toEqual(legacy.audioTakes);
    expect(p.copies).toEqual([{ takeIdx: 0, from: 0, to: 4000, dst: 0 }]);
    expect(p.dwellStarts).toEqual([]);
  });

  it('reproduces the pre-dwell stitch for several voices (gaps, offsets, per-voice blocks)', () => {
    const takes = [A, B, { ...A, voiceId: 'juniper' }];
    const p = plan(takes);
    const legacy = legacyStitch(takes);
    expect(p.totalSamples).toBe(legacy.totalSamples);
    expect(p.beatStarts).toEqual(legacy.beatStarts);
    expect(p.audioTakes).toEqual(legacy.audioTakes);
    expect(p.copies).toHaveLength(3);                 // one whole-take copy each — no splitting
    expectTotalPartition(p, takes);
  });
});

describe('planStitch — a dwell inside a take (the normal case: Reddit reads in one voice)', () => {
  const p = plan([A], [dwell(1)]);

  it('splits the take at the NEXT line\'s first character, so the cut lands between words', () => {
    expect(p.copies).toEqual([
      { takeIdx: 0, from: 0, to: 2000, dst: 0 },      // lines 0-1
      { takeIdx: 0, from: 2000, to: 4000, dst: 3800 },// lines 2-3, pushed back by the 1.8s hold
    ]);
    expectTotalPartition(p, [A]);
  });

  it('puts the silence exactly where the reveal fires — at the end of the anchor line', () => {
    expect(p.dwellStarts).toEqual([2]);
  });

  it('leaves earlier beats untouched and shifts every later beat by the hold', () => {
    expect(p.beatStarts).toEqual([0, 1, 2 + IMAGE_DWELL_S, 3 + IMAGE_DWELL_S]);
    expect(p.beatStarts.slice(0, 2)).toEqual(legacyStitch([A]).beatStarts.slice(0, 2));
  });

  it('grows the track by exactly the hold — audioDuration is totalSamples / SR', () => {
    expect(p.totalSamples).toBe(legacyStitch([A]).totalSamples + IMAGE_DWELL_S * SR);
    expect(p.totalSamples / SR).toBeCloseTo(4 + IMAGE_DWELL_S, 10);
  });

  it('splits the take\'s timeline block in two rather than drawing a voice over the silence', () => {
    expect(p.audioTakes).toEqual([
      { voiceId: 'mark', start: 0, duration: 2 },
      { voiceId: 'mark', start: 2 + IMAGE_DWELL_S, duration: 2 },
    ]);
    // The blocks still describe VOICED audio only: their total is the take's own length.
    expect(p.audioTakes.reduce((n, t) => n + t.duration, 0)).toBeCloseTo(A.samples / SR, 10);
  });

  it('rounds the hold to whole samples (a fractional sample would desync the copy offsets)', () => {
    const q = plan([A], [dwell(1, 0.0007)]);
    expect(Number.isInteger(q.totalSamples)).toBe(true);
    expect(q.totalSamples).toBe(4001);               // 0.7 samples -> 1
    expect(q.copies.every(c => Number.isInteger(c.dst))).toBe(true);
  });
});

describe('planStitch — dwells at the edges', () => {
  it('holds at the very end when the anchor is the last line', () => {
    const p = plan([A], [dwell(3)]);
    expect(p.copies).toEqual([{ takeIdx: 0, from: 0, to: 4000, dst: 0 }]);
    expect(p.beatStarts).toEqual(legacyStitch([A]).beatStarts);     // nothing is spoken after it
    expect(p.dwellStarts).toEqual([4]);
    expect(p.totalSamples).toBe(4000 + IMAGE_DWELL_S * SR);
  });

  it('opens the track with silence when the anchor is -1 (every line above the image switched off)', () => {
    const p = plan([A], [dwell(-1)]);
    expect(p.dwellStarts).toEqual([0]);
    expect(p.beatStarts).toEqual([0, 1, 2, 3].map(b => b + IMAGE_DWELL_S));
    expect(p.copies).toEqual([{ takeIdx: 0, from: 0, to: 4000, dst: IMAGE_DWELL_S * SR }]);
  });

  it('clamps an anchor past the last line instead of losing the dwell', () => {
    expect(plan([A], [dwell(99)]).dwellStarts).toEqual([4]);
    expect(plan([], [dwell(99)]).dwellStarts).toEqual([0]);
  });
});

describe('planStitch — a dwell must not disturb the other voices', () => {
  const takes = [A, B];
  const p = plan(takes, [dwell(1)]);

  it('keeps take grouping and voice order (a dwell is not a voice change)', () => {
    expect(p.audioTakes.map(t => t.voiceId)).toEqual(['mark', 'mark', 'liam']);
    expectTotalPartition(p, takes);
  });

  it('shifts the following take by the hold and keeps the breath between voices', () => {
    const legacy = legacyStitch(takes);
    const liam = p.audioTakes[2];
    expect(liam.start).toBeCloseTo(legacy.audioTakes[1].start + IMAGE_DWELL_S, 10);
    expect(liam.duration).toBe(legacy.audioTakes[1].duration);
    // The 0.25s gap still sits between the last voiced sample of take A and the first of take B.
    expect(liam.start - (p.audioTakes[1].start + p.audioTakes[1].duration)).toBeCloseTo(GAP / SR, 10);
  });

  it('shifts the following take\'s beats by the hold, not by anything else', () => {
    const legacy = legacyStitch(takes);
    expect(p.beatStarts.slice(4)).toEqual(legacy.beatStarts.slice(4).map(b => b + IMAGE_DWELL_S));
  });
});

describe('resolveDwells — card lines to narrated lines', () => {
  it('is identity when every line is narrated', () => {
    expect(resolveDwells([dwell(3)], [true, true, true, true, true])).toEqual([dwell(3)]);
  });

  it('counts only enabled lines — a disabled line above the image slides the anchor up', () => {
    // card lines 0..4, lines 1 and 2 switched off: the dwell anchored after card line 3 follows the
    // second NARRATED line (indices 0 and 3).
    expect(resolveDwells([dwell(3)], [true, false, false, true, true])[0].afterLineIdx).toBe(1);
  });

  it('slides up to the previous narrated line when the anchor line itself is switched off', () => {
    expect(resolveDwells([dwell(2)], [true, true, false, true])[0].afterLineIdx).toBe(1);
  });

  it('resolves to -1 (a pre-roll) when nothing above the image is narrated', () => {
    expect(resolveDwells([dwell(2)], [false, false, false, true])[0].afterLineIdx).toBe(-1);
  });

  it('keeps sec and bottomFrac intact', () => {
    expect(resolveDwells([{ afterLineIdx: 1, sec: 2.5, bottomFrac: 0.42 }], [true, true]))
      .toEqual([{ afterLineIdx: 1, sec: 2.5, bottomFrac: 0.42 }]);
  });

  it('drops holds that would be no-ops or poison the reveal list', () => {
    expect(resolveDwells([dwell(1, 0), dwell(1, -1), dwell(1, NaN), { afterLineIdx: 1, sec: 1, bottomFrac: NaN }], [true, true])).toEqual([]);
  });

  it('returns nothing for a card with no dwells at all', () => {
    expect(resolveDwells(undefined, [true, true])).toEqual([]);
    expect(resolveDwells([], [true, true])).toEqual([]);
  });
});

describe('buildReveals', () => {
  const fracs = [0.2, 0.4, 0.6, 0.8];
  const LEAD = 0.15, RATE = 1.25, START = 3;

  // A picture post with NO comments ticked is the primary shape of this whole feature: the image hangs off
  // the LAST narrated line, so its hold is the final thing that happens. Every other dwell case has a line
  // after it to prove the ordering, which is exactly why this one could rot unnoticed.
  it('emits a dwell anchored to the LAST narrated line — a picture post with no comments picked', () => {
    const d = [dwell(A.beats.length - 1, IMAGE_DWELL_S, 0.95)];
    const p = plan([A], d);
    const got = buildReveals({ lineBeats: p.beatStarts, lineFracs: fracs, dwells: d, dwellStarts: p.dwellStarts, audioStart: START, leadS: LEAD, rate: RATE });

    // The image's reveal must EXIST, be the last step, and un-crop further than any line before it.
    const last = got[got.length - 1];
    expect(last.h).toBe(0.95);
    expect(got.filter(r => r.h === 0.95)).toHaveLength(1);
    expect(last.t).toBeGreaterThan(got[got.length - 2].t);

    // …and it must land exactly ON the silence — with NO reveal lead. The lead exists so a line is
    // readable a breath before it is spoken; a dwell has nothing to speak, so leading it would un-crop
    // the image while the previous line is still being read.
    expect(last.t).toBeCloseTo(START + p.dwellStarts[0] * RATE, 10);
    expect(last.t).not.toBeCloseTo(START + Math.max(0, p.dwellStarts[0] - LEAD) * RATE, 10);
    expect(got.map(r => r.h)).toEqual([...fracs, 0.95]);
  });

  it('with no dwells, reproduces the pre-dwell reveal list exactly', () => {
    const p = plan([A]);
    const got = buildReveals({ lineBeats: p.beatStarts, lineFracs: fracs, dwells: [], dwellStarts: [], audioStart: START, leadS: LEAD, rate: RATE });
    expect(got).toEqual(legacyReveals(p.beatStarts, fracs, START, LEAD, RATE));
  });

  it('still emits the first line even when its boundary is 0, and still drops non-advancing steps', () => {
    const p = plan([A]);
    const flat = [0, 0.5, 0.5, 0.3];
    const got = buildReveals({ lineBeats: p.beatStarts, lineFracs: flat, dwells: [], dwellStarts: [], audioStart: START, leadS: LEAD, rate: RATE });
    expect(got).toEqual(legacyReveals(p.beatStarts, flat, START, LEAD, RATE));
    expect(got.map(r => r.h)).toEqual([0, 0.5]);
  });

  it('fires the image reveal ON the silence — no lead, since a dwell has nothing to read ahead', () => {
    const d = [dwell(1, IMAGE_DWELL_S, 0.5)];
    const p = plan([A], d);
    const got = buildReveals({ lineBeats: p.beatStarts, lineFracs: fracs, dwells: d, dwellStarts: p.dwellStarts, audioStart: START, leadS: LEAD, rate: RATE });
    expect(got[2]).toEqual({ t: START + 2 * RATE, h: 0.5 });     // dwellStart 2s, not 2 - 0.15
    expect(got[1].h).toBe(0.4);                                   // the line before it
    expect(got[3].h).toBe(0.6);                                   // the line after it
  });

  it('keeps reveals monotonic in h and ordered in t once a dwell is spliced in', () => {
    const d = [dwell(1, IMAGE_DWELL_S, 0.5)];
    const p = plan([A], d);
    const got = buildReveals({ lineBeats: p.beatStarts, lineFracs: fracs, dwells: d, dwellStarts: p.dwellStarts, audioStart: START, leadS: LEAD, rate: RATE });
    for (let i = 1; i < got.length; i++) {
      expect(got[i].h, `h at ${i}`).toBeGreaterThan(got[i - 1].h);
      expect(got[i].t, `t at ${i}`).toBeGreaterThanOrEqual(got[i - 1].t);
    }
    expect(got).toHaveLength(fracs.length + 1);
  });

  it('drops a dwell that would crop BACK UP (a boundary already passed by the text above it)', () => {
    const d = [dwell(2, IMAGE_DWELL_S, 0.3)];        // below line 2's own 0.6 boundary
    const p = plan([A], d);
    const got = buildReveals({ lineBeats: p.beatStarts, lineFracs: fracs, dwells: d, dwellStarts: p.dwellStarts, audioStart: START, leadS: LEAD, rate: RATE });
    expect(got.map(r => r.h)).toEqual(fracs);
    expect(got.every((r, i) => i === 0 || r.h > got[i - 1].h)).toBe(true);
  });

  it('emits a pre-roll dwell first, at the very start of the track', () => {
    const d = [dwell(-1, IMAGE_DWELL_S, 0.5)];
    const p = plan([A], d);
    const got = buildReveals({ lineBeats: p.beatStarts, lineFracs: [0.6, 0.7, 0.8, 0.9], dwells: d, dwellStarts: p.dwellStarts, audioStart: START, leadS: LEAD, rate: RATE });
    expect(got[0]).toEqual({ t: START, h: 0.5 });
    expect(got[1].h).toBe(0.6);
  });
});

// ── dropCoveredDwells: the always-ship-the-dwell contract's other half ─────────────────────────────
// The card can no longer decide at render time whether the image narrates (the user mutes junk OCR
// lines later, on the canvas), so it always ships the dwell and THIS decides, per generate, whether
// an enabled line has made it redundant.

describe('dropCoveredDwells', () => {
  const dwell = (over: Partial<Dwell> = {}): Dwell => ({ afterLineIdx: 3, sec: 1.8, bottomFrac: 0.53, ...over });
  const L = (bottomFrac: number, enabled: boolean) => ({ bottomFrac, enabled });

  it('drops a dwell whose boundary an enabled line at/before the anchor reaches', () => {
    // Lines 2..3 are the image's OCR lines; line 3 carries the dwell's own boundary.
    const lines = [L(0.15, true), L(0.24, true), L(0.33, true), L(0.53, true), L(0.7, true)];
    expect(dropCoveredDwells([dwell()], lines)).toEqual([]);
  });

  it('KEEPS the dwell when every image line is muted — the junk-OCR cleanup path', () => {
    // This is the exact scenario the review proved broken: muting all image lines used to leave the
    // image with no reveal mechanism at all. The dwell must survive and take back over.
    const lines = [L(0.15, true), L(0.24, true), L(0.33, false), L(0.53, false), L(0.7, true)];
    expect(dropCoveredDwells([dwell()], lines)).toEqual([dwell()]);
  });

  it('keeps the dwell when only INTERIOR image lines remain — none of them reaches the boundary', () => {
    // Muting just the last image line: the kept interior lines reveal into the band but never past
    // it, so without the dwell the bottom half of the image and the pills would never uncover.
    const lines = [L(0.15, true), L(0.24, true), L(0.33, true), L(0.53, false), L(0.7, true)];
    expect(dropCoveredDwells([dwell()], lines)).toEqual([dwell()]);
  });

  it('never lets a line BELOW the anchor cover the dwell — comments always reach past it', () => {
    // Every comment line's boundary is below the band by construction. If they counted, every card
    // with comments would lose its dwell and a wordless image would get zero screen time.
    const lines = [L(0.15, true), L(0.24, true), L(0.6, true), L(1, true)];
    expect(dropCoveredDwells([dwell({ afterLineIdx: 1, bottomFrac: 0.5 })], lines)).toHaveLength(1);
  });

  it('treats a boundary equal to the dwell’s as covering (the last image line carries that exact value)', () => {
    const lines = [L(0.53, true)];
    expect(dropCoveredDwells([dwell({ afterLineIdx: 0 })], lines)).toEqual([]);
  });

  it('keeps a pre-roll dwell (-1 anchor) unconditionally — no line sits before it to cover it', () => {
    const lines = [L(0.9, true), L(1, true)];
    expect(dropCoveredDwells([dwell({ afterLineIdx: -1 })], lines)).toHaveLength(1);
  });

  it('handles undefined and empty inputs', () => {
    expect(dropCoveredDwells(undefined, [L(1, true)])).toEqual([]);
    expect(dropCoveredDwells([], [L(1, true)])).toEqual([]);
    expect(dropCoveredDwells([dwell()], [])).toEqual([dwell()]);
  });

  it('judges each dwell independently', () => {
    const lines = [L(0.3, true), L(0.53, false), L(0.8, true), L(1, true)];
    const kept = dropCoveredDwells(
      [dwell({ afterLineIdx: 1, bottomFrac: 0.53 }), dwell({ afterLineIdx: 3, bottomFrac: 0.9 })],
      lines,
    );
    // First: its boundary line is muted → kept. Second: line 3 (enabled, 1 ≥ 0.9) covers it → dropped.
    expect(kept).toHaveLength(1);
    expect(kept[0].bottomFrac).toBe(0.53);
  });
});
