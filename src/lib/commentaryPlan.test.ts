import { describe, it, expect } from 'vitest';
import { commentaryPlan, isIntroPhase, absolutePositionAt, clipOffsetAt } from './commentaryPlan';

describe('commentaryPlan', () => {
  it('no commentary → the clip, played once', () => {
    const p = commentaryPlan(0, 12);
    expect(p).toMatchObject({ introDur: 0, clipDur: 12, introPasses: 0, total: 12, passes: 1 });
  });

  it('commentary shorter than the clip → one intro pass, output = intro + clip', () => {
    const p = commentaryPlan(5, 20);
    expect(p.introPasses).toBe(1);      // phase B starts on a fresh pass
    expect(p.total).toBe(25);
    expect(p.passes).toBe(2);
  });

  it('commentary longer than the clip → enough whole passes to cover it', () => {
    const p = commentaryPlan(25, 10);   // needs 3 clip passes to cover 25s
    expect(p.introPasses).toBe(3);
    expect(p.total).toBe(35);
    expect(p.passes).toBe(4);
  });

  it('commentary exactly one clip long → one intro pass, not two', () => {
    const p = commentaryPlan(10, 10);
    expect(p.introPasses).toBe(1);
    expect(p.passes).toBe(2);
  });

  it('guards a zero/negative clip length', () => {
    expect(() => commentaryPlan(5, 0)).not.toThrow();
    expect(commentaryPlan(5, 0).clipDur).toBeGreaterThan(0);
  });
});

describe('isIntroPhase', () => {
  const p = commentaryPlan(5, 20);
  it('is true under the commentary and false the instant it ends', () => {
    expect(isIntroPhase(0, p)).toBe(true);
    expect(isIntroPhase(4.99, p)).toBe(true);
    expect(isIntroPhase(5, p)).toBe(false);     // the restart happens exactly here
    expect(isIntroPhase(24, p)).toBe(false);
  });
  it('is always false with no commentary', () => {
    expect(isIntroPhase(0, commentaryPlan(0, 20))).toBe(false);
  });
});

describe('absolutePositionAt', () => {
  it('advances 1:1 through the commentary', () => {
    const p = commentaryPlan(5, 20);
    expect(absolutePositionAt(0, p)).toBe(0);
    expect(absolutePositionAt(3, p)).toBe(3);
  });

  it('jumps to the next whole pass when the commentary ends (a real restart)', () => {
    const p = commentaryPlan(5, 20);          // introPasses 1 → phase B starts at absolute 20
    expect(absolutePositionAt(5, p)).toBe(20);
    expect(absolutePositionAt(6, p)).toBe(21);
    expect(absolutePositionAt(25, p)).toBe(40);   // end of output = end of pass 2
  });

  it('is monotonically increasing across the phase boundary', () => {
    const p = commentaryPlan(7, 4);
    let prev = -Infinity;
    for (let t = 0; t <= p.total; t += 0.1) {
      const a = absolutePositionAt(t, p);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });

  it('never exceeds the decoded span (passes × clipDur)', () => {
    const p = commentaryPlan(7, 4);           // introPasses 2, passes 3 → span 12
    expect(absolutePositionAt(p.total, p)).toBeLessThanOrEqual(p.passes * p.clipDur + 1e-9);
  });
});

describe('clipOffsetAt', () => {
  it('loops the clip while the commentary outlasts it', () => {
    const p = commentaryPlan(25, 10);
    expect(clipOffsetAt(0, p)).toBeCloseTo(0, 6);
    expect(clipOffsetAt(9, p)).toBeCloseTo(9, 6);
    expect(clipOffsetAt(11, p)).toBeCloseTo(1, 6);    // second time through the clip
    expect(clipOffsetAt(21, p)).toBeCloseTo(1, 6);    // third
  });

  it('restarts at the clip start the moment the commentary ends', () => {
    const p = commentaryPlan(5, 20);
    expect(clipOffsetAt(5, p)).toBeCloseTo(0, 6);
    expect(clipOffsetAt(10, p)).toBeCloseTo(5, 6);
  });

  it('stays inside the clip for every output time', () => {
    const p = commentaryPlan(13, 6);
    for (let t = 0; t <= p.total; t += 0.05) {
      const off = clipOffsetAt(t, p);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThan(p.clipDur + 1e-9);
    }
  });
});
