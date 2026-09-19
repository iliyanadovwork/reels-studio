import { describe, it, expect } from 'vitest';
import {
  exportLead, isLeadFrame, sourceTimeFor, totalOutputFrames, shiftForLead,
  THUMB_LEAD_S, NO_LEAD,
} from './thumbnailLead';

const FPS = 30;
const FRAME = 1 / FPS;

describe('exportLead', () => {
  it('is 3 frames / 0.1s at 30fps', () => {
    expect(exportLead(true, 30)).toEqual({ frames: 3, seconds: 0.1 });
  });

  it('holds for THUMB_LEAD_S regardless of fps — the FRAME COUNT scales, not the duration', () => {
    // The picker is a slider over wall-clock time, so the hold must stay the same length at any fps —
    // to within the half-frame that rounding to whole frames costs (24fps: 4.8 frames -> 5 -> 0.208s).
    for (const fps of [24, 30, 60, 25, 50]) {
      const off = Math.abs(exportLead(true, fps).seconds - THUMB_LEAD_S);
      expect(off, `${fps}fps off by ${off}`).toBeLessThanOrEqual(0.5 / fps);
    }
    expect(exportLead(true, 60).frames).toBe(6);
    expect(exportLead(true, 24).frames).toBe(2);   // 2.4 rounds to 2
  });

  it('derives seconds from the ROUNDED frame count, so the hold is a whole number of frames', () => {
    // 24fps: 0.1s is 2.4 frames. If `seconds` stayed 0.1 while the video emitted 2 frames, the audio
    // shift would sit off the video by the rounding error and the mix would drift.
    for (const fps of [24, 30, 60, 25]) {
      const lead = exportLead(true, fps);
      expect(lead.seconds, `${fps}fps`).toBeCloseTo(lead.frames / fps, 10);
    }
  });

  it('never rounds down to a zero-frame lead at an absurdly low fps', () => {
    expect(exportLead(true, 1).frames).toBeGreaterThanOrEqual(1);
    expect(exportLead(true, 2).frames).toBeGreaterThanOrEqual(1);
  });

  it('is a no-op without a thumbnail — the whole feature stays inert for other reels', () => {
    expect(exportLead(false, 30)).toEqual(NO_LEAD);
    expect(exportLead(false, 30).seconds).toBe(0);
  });

  it('refuses a nonsense fps instead of producing Infinity or NaN seconds', () => {
    for (const fps of [0, -30, NaN, Infinity]) {
      expect(exportLead(true, fps), String(fps)).toEqual(NO_LEAD);
    }
  });
});

describe('isLeadFrame', () => {
  it('covers exactly the lead frames and stops', () => {
    const lead = exportLead(true, FPS);   // 3 @ 30fps
    for (let i = 0; i < lead.frames; i++) expect(isLeadFrame(i, lead), `i=${i}`).toBe(true);
    expect(isLeadFrame(lead.frames, lead)).toBe(false);
    expect(isLeadFrame(lead.frames + 1, lead)).toBe(false);
  });

  it('is never true without a thumbnail', () => {
    for (const i of [0, 1, 2, 3]) expect(isLeadFrame(i, NO_LEAD), String(i)).toBe(false);
  });
});

describe('sourceTimeFor', () => {
  it('THE INVARIANT: prepending does not change which source time any footage frame samples', () => {
    // Output frame lead.frames + n must resolve to exactly what frame n resolved to with no thumbnail.
    const lead = exportLead(true, FPS);
    for (const videoRate of [1, 1.15, 2]) {
      for (const clipStart of [0, 3.5]) {
        for (let n = 0; n < 50; n++) {
          const withLead = sourceTimeFor(n + lead.frames, lead, FRAME, videoRate, clipStart);
          const without = sourceTimeFor(n, NO_LEAD, FRAME, videoRate, clipStart);
          expect(withLead, `n=${n} rate=${videoRate} start=${clipStart}`).toBeCloseTo(without, 10);
        }
      }
    }
  });

  it('freezes every lead frame on clipStart, so the held frames decode nothing new', () => {
    const lead = exportLead(true, FPS);
    for (const clipStart of [0, 7.25]) {
      for (let i = 0; i < lead.frames; i++) {
        expect(sourceTimeFor(i, lead, FRAME, 1, clipStart), `i=${i}`).toBe(clipStart);
      }
    }
  });

  it('resumes at exactly clipStart on the first footage frame', () => {
    const lead = exportLead(true, FPS);
    expect(sourceTimeFor(lead.frames, lead, FRAME, 1, 4.5)).toBe(4.5);
  });

  it('still advances by one frame-step per frame after the lead', () => {
    const lead = exportLead(true, FPS);
    const a = sourceTimeFor(lead.frames + 10, lead, FRAME, 1, 0);
    const b = sourceTimeFor(lead.frames + 11, lead, FRAME, 1, 0);
    expect(b - a).toBeCloseTo(FRAME, 10);
  });

  it('honours the speed-up: a 2x reel steps twice as far through the source per frame', () => {
    const lead = exportLead(true, FPS);
    const a = sourceTimeFor(lead.frames + 10, lead, FRAME, 2, 0);
    const b = sourceTimeFor(lead.frames + 11, lead, FRAME, 2, 0);
    expect(b - a).toBeCloseTo(FRAME * 2, 10);
  });
});

describe('totalOutputFrames', () => {
  it('adds the lead to the footage frame count', () => {
    const lead = exportLead(true, FPS);
    expect(totalOutputFrames(10, FPS, lead)).toBe(300 + 3);
    expect(totalOutputFrames(10, FPS, NO_LEAD)).toBe(300);
  });

  it('matches the un-leaded count exactly when there is no thumbnail', () => {
    for (const d of [1, 9.7, 40, 180]) {
      expect(totalOutputFrames(d, FPS, NO_LEAD), String(d)).toBe(Math.floor(d * FPS));
    }
  });

  it('never returns fewer frames than the lead itself for a degenerate duration', () => {
    const lead = exportLead(true, FPS);
    for (const d of [0, -5, NaN]) {
      expect(totalOutputFrames(d, FPS, lead), String(d)).toBe(lead.frames);
    }
  });
});

describe('shiftForLead', () => {
  it('moves an audio cue later by exactly the lead', () => {
    const lead = exportLead(true, FPS);
    expect(shiftForLead(0, lead)).toBeCloseTo(0.1, 10);
    expect(shiftForLead(2.5, lead)).toBeCloseTo(2.6, 10);
  });

  it('leaves cues untouched with no thumbnail', () => {
    expect(shiftForLead(2.5, NO_LEAD)).toBe(2.5);
    expect(shiftForLead(0, NO_LEAD)).toBe(0);
  });

  it('clamps a negative cue to the lead rather than scheduling before t=0', () => {
    // A negative "when" means the clip starts mid-narration; it must not become a negative start time.
    const lead = exportLead(true, FPS);
    expect(shiftForLead(-3, lead)).toBeCloseTo(0.1, 10);
    expect(shiftForLead(-3, NO_LEAD)).toBe(0);
  });

  it('keeps the audio/video relationship consistent: both shift by the same amount', () => {
    const lead = exportLead(true, FPS);
    // Video: the first footage frame lands at output time lead.seconds.
    const firstFootageOutputTime = lead.frames * (1 / FPS);
    expect(firstFootageOutputTime).toBeCloseTo(lead.seconds, 10);
    // Audio: a cue that was at output 0 also lands at lead.seconds.
    expect(shiftForLead(0, lead)).toBeCloseTo(firstFootageOutputTime, 10);
  });
});
