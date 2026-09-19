import { describe, it, expect } from 'vitest';
import { normalizeFraming } from './useReelPersistence';

// The sanitizer guards the draw loop against junk persisted blobs. These pin the erase-mode rules
// the review found unguarded: patches and lifts are a POSITIONAL pair, and runtime object URLs must
// never survive persistence (a stale coverSrc blocks atlas rehydration — covers silently vanish).

const patch = (n: number) => ({
  lineIdx: n, src: { x: 0, y: 0, w: 10, h: 10 }, atlas: { x: 0, y: 0 }, dest: { x: 0, y: 0, w: 0.1, h: 0.1 },
});
const framing = (overlay: Record<string, unknown>) => ({ overlays: [{ id: 'o1', name: 'x', x: 0, y: 0, w: 1, h: 1, start: 0, end: 1, ...overlay }] });
const ov = (f: unknown) => (normalizeFraming(f).overlays ?? [])[0] as Record<string, unknown>;

describe('normalizeFraming — erase-mode covers', () => {
  it('drops an invalid patch AND its lift entry together — later covers keep their own beats', () => {
    const bad = { ...patch(1), dest: { x: 0, y: 0, w: 'nope', h: 0.1 } };
    const o = ov(framing({ coverPatches: [patch(0), bad, patch(2)], coverLifts: [1, 2, 3] }));
    expect((o.coverPatches as unknown[]).length).toBe(2);
    expect(o.coverLifts).toEqual([1, 3]);   // NOT [1, 2] — the dropped patch took its lift with it
  });

  it('keeps null lifts as null and coerces junk lift entries to null, never shifting positions', () => {
    const o = ov(framing({ coverPatches: [patch(0), patch(1)], coverLifts: [null, 'soon'] }));
    expect(o.coverLifts).toEqual([null, null]);
  });

  it('drops lifts entirely when patches are absent, and vice-versa-safe', () => {
    const o = ov(framing({ coverLifts: [1, 2] }));
    expect(o.coverPatches).toBeUndefined();
    expect(o.coverLifts).toBeUndefined();
  });

  it('strips persisted runtime object URLs — a stale coverSrc would block rehydration', () => {
    const o = ov(framing({ src: 'blob:x', audioSrc: 'blob:y', coverSrc: 'blob:z', coverAtlasId: 'cov-1' }));
    expect(o.src).toBeUndefined();
    expect(o.audioSrc).toBeUndefined();
    expect(o.coverSrc).toBeUndefined();
    expect(o.coverAtlasId).toBe('cov-1');   // the PERSISTED id survives — it's how rehydration finds the blob
  });
});
