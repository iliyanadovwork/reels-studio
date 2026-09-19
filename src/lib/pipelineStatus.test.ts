import { describe, it, expect } from 'vitest';
import type { VideoEntry } from '@/app/types';
import type { Framing } from '@/app/components/TikTokCanvas/types';
import type { StageKey, StageInfo } from '@/app/components/PipelineView';
import {
  computePipelineStages as computeStagesWith,
  computePipelineMusicId as computeMusicIdWith,
  type PipelineRunState,
  type StyleProbe,
} from '@/lib/pipelineStatus';
import { DEFAULT_MUSIC_ID, resolveMusicId } from '@/lib/music';
import { redditStyle } from '@/lib/reelStyles/reddit';
import { commentaryStyle } from '@/lib/reelStyles/commentary';

// The module is style-blind now: it's told whose reels these are and what the narratable overlay is called.
// These tests drive it through the REAL Reddit style's probe rather than a hand-written double, so the
// suite covers the production wiring (redditStyle.computeStages) and not just the arithmetic.
const REDDIT_PROBE: StyleProbe = { isReel: redditStyle.isReel, primaryOverlayName: redditStyle.primaryOverlayName };
const computePipelineStages = (e: VideoEntry[], fm: Record<string, Framing>, r: PipelineRunState) =>
  computeStagesWith(e, fm, r, REDDIT_PROBE);
const computePipelineMusicId = (e: VideoEntry[], fm: Record<string, Framing>) =>
  computeMusicIdWith(e, fm, redditStyle.isReel);

// ---------------------------------------------------------------------------
// Test doubles. The module only reads a handful of fields, so we build minimal
// shapes and cast — keeping each fixture legible and adversarial-friendly.
// ---------------------------------------------------------------------------

type EntryInput = { id: string; localVideoSrc?: string; videoUrl?: string; data?: unknown };
const E = (i: EntryInput): VideoEntry => ({ ...i } as unknown as VideoEntry);

type OverlayInput = { name: string; audioDuration?: number };
type FramingInput = { overlays?: OverlayInput[]; musicId?: string; ytTitle?: string; description?: string };
const F = (f: FramingInput): Framing => f as unknown as Framing;

/** A Reddit reel carries an overlay named EXACTLY "Reddit thread". */
const redditFraming = (extra: Omit<FramingInput, 'overlays'> = {}, audioDuration?: number): Framing =>
  F({
    overlays: [audioDuration === undefined ? { name: 'Reddit thread' } : { name: 'Reddit thread', audioDuration }],
    ...extra,
  });

const idleRun: PipelineRunState = {
  batchOp: null,
  batchProgress: { done: 0, total: 0 },
  isDownloadingAll: false,
  downloadProgress: { done: 0, total: 0 },
};

const run = (over: Partial<PipelineRunState> = {}): PipelineRunState => ({ ...idleRun, ...over });

const get = (stages: StageInfo[], key: StageKey): StageInfo => {
  const s = stages.find(st => st.key === key);
  if (!s) throw new Error(`no stage ${key}`);
  return s;
};

// ===========================================================================
// Ground-truth premises the music assertions rely on (verified vs music.ts +
// MDN: `??` preserves '', `||`/filter treat '' as falsy). We pin them here so
// a change to the music module can't silently invalidate later expectations.
// ===========================================================================
describe('premises (resolveMusicId / DEFAULT_MUSIC_ID)', () => {
  it('DEFAULT_MUSIC_ID is a non-empty (truthy, non-null) track id', () => {
    // Whole "undefined counts as done / defaults to a track" story depends on this.
    expect(DEFAULT_MUSIC_ID).toBeTruthy();
    expect(DEFAULT_MUSIC_ID).not.toBe('');
    expect(DEFAULT_MUSIC_ID).not.toBeNull();
  });
  it('undefined resolves to the default track (never set → plays default)', () => {
    expect(resolveMusicId(undefined)).toBe(DEFAULT_MUSIC_ID);
    expect(resolveMusicId(undefined)).not.toBeNull();
  });
  it('empty string resolves to null (explicit "No music")', () => {
    expect(resolveMusicId('')).toBeNull();
  });
  it('a concrete id resolves to itself', () => {
    expect(resolveMusicId('some-track')).toBe('some-track');
  });
});

// ===========================================================================
// computePipelineStages — reel detection & total
// ===========================================================================
describe('computePipelineStages — reddit detection & total', () => {
  it('total counts ONLY reels whose overlay is named exactly "Reddit thread"', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' }), E({ id: 'c' }), E({ id: 'd' })];
    const fm: Record<string, Framing> = {
      a: redditFraming(),                                  // reddit
      b: F({ overlays: [{ name: 'Twitter card' }] }),       // other overlay → not reddit
      c: F({ overlays: [] }),                               // no overlays → not reddit
      // d: absent from framingMap entirely → not reddit
    };
    const stages = computePipelineStages(entries, fm, idleRun);
    expect(get(stages, 'import').total).toBe(1);
  });

  it('match is case-sensitive and whitespace-sensitive (no fuzzy matching)', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' }), E({ id: 'c' }), E({ id: 'd' })];
    const fm: Record<string, Framing> = {
      a: F({ overlays: [{ name: 'reddit thread' }] }),   // lowercase
      b: F({ overlays: [{ name: 'Reddit Thread' }] }),   // TitleCase
      c: F({ overlays: [{ name: 'Reddit thread ' }] }),  // trailing space
      d: F({ overlays: [{ name: ' Reddit thread' }] }),  // leading space
    };
    const stages = computePipelineStages(entries, fm, idleRun);
    expect(get(stages, 'import').total).toBe(0);
  });

  it('a reel is reddit if ANY overlay matches, even amongst non-matching ones', () => {
    const entries = [E({ id: 'a' })];
    const fm: Record<string, Framing> = {
      a: F({ overlays: [{ name: 'Logo' }, { name: 'Reddit thread' }, { name: 'Caption' }] }),
    };
    expect(get(computePipelineStages(entries, fm, idleRun), 'import').total).toBe(1);
  });

  it('empty workspace → total 0 and every stage done 0 / not running / no progress', () => {
    const stages = computePipelineStages([], {}, idleRun);
    for (const s of stages) {
      expect(s.total).toBe(0);
      expect(s.done).toBe(0);
      expect(s.running).toBe(false);
      expect(s.progress ?? null).toBeNull();
    }
  });
});

// ===========================================================================
// computePipelineStages — structure / ordering / import & pick
// ===========================================================================
describe('computePipelineStages — structure', () => {
  it('returns the 6 stages in canonical pipeline order (import & pick merged into one node)', () => {
    const stages = computePipelineStages([], {}, idleRun);
    expect(stages.map(s => s.key)).toEqual(['import', 'footage', 'music', 'narrate', 'copy', 'export']);
  });

  it('the import(&pick) node is complete-by-definition (done === total) for every reddit reel', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' }), E({ id: 'c' })];
    const fm: Record<string, Framing> = { a: redditFraming(), b: redditFraming(), c: redditFraming() };
    const stages = computePipelineStages(entries, fm, idleRun);
    expect(get(stages, 'import')).toMatchObject({ done: 3, total: 3, running: false });
    expect(stages.some(s => (s.key as string) === 'pick')).toBe(false);   // no separate pick node anymore
  });

  it('total is identical across all 7 stages', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' })];
    const fm: Record<string, Framing> = { a: redditFraming(), b: redditFraming() };
    const stages = computePipelineStages(entries, fm, run({ isDownloadingAll: true, downloadProgress: { done: 1, total: 2 } }));
    for (const s of stages) expect(s.total).toBe(2);
  });
});

// ===========================================================================
// computePipelineStages — footage
// ===========================================================================
describe('computePipelineStages — footage', () => {
  it('counts a reel with localVideoSrc OR videoUrl OR data (any one is enough)', () => {
    const entries = [
      E({ id: 'a', localVideoSrc: 'blob:x' }),
      E({ id: 'b', videoUrl: 'https://bucket/b.mp4' }),
      E({ id: 'c', data: { id: 'c', title: 't' } }),
      E({ id: 'd' }), // nothing
    ];
    const fm: Record<string, Framing> = { a: redditFraming(), b: redditFraming(), c: redditFraming(), d: redditFraming() };
    const stages = computePipelineStages(entries, fm, idleRun);
    expect(get(stages, 'footage')).toMatchObject({ done: 3, total: 4 });
  });

  it('treats empty-string sources and null data as NO footage (falsy)', () => {
    const entries = [E({ id: 'a', localVideoSrc: '', videoUrl: '', data: null })];
    const fm: Record<string, Framing> = { a: redditFraming() };
    expect(get(computePipelineStages(entries, fm, idleRun), 'footage').done).toBe(0);
  });

  it('footage from a NON-reddit reel is not counted', () => {
    const entries = [E({ id: 'a', localVideoSrc: 'blob:x' }), E({ id: 'b', localVideoSrc: 'blob:y' })];
    const fm: Record<string, Framing> = { a: redditFraming(), b: F({ overlays: [{ name: 'other' }] }) };
    const stages = computePipelineStages(entries, fm, idleRun);
    expect(get(stages, 'footage')).toMatchObject({ done: 1, total: 1 });
  });
});

// ===========================================================================
// computePipelineStages — music (the '' vs undefined crux)
// ===========================================================================
describe('computePipelineStages — music (effective-track semantics)', () => {
  it('UNSET musicId (undefined) counts as done — it plays the default track', () => {
    const entries = [E({ id: 'a' })];
    const fm: Record<string, Framing> = { a: redditFraming() }; // no musicId
    expect(get(computePipelineStages(entries, fm, idleRun), 'music')).toMatchObject({ done: 1, total: 1 });
  });

  it('explicit "" ("No music") does NOT count as done', () => {
    const entries = [E({ id: 'a' })];
    const fm: Record<string, Framing> = { a: redditFraming({ musicId: '' }) };
    expect(get(computePipelineStages(entries, fm, idleRun), 'music').done).toBe(0);
  });

  it('a concrete VALID track id counts as done', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' })];
    const fm: Record<string, Framing> = {
      a: redditFraming({ musicId: DEFAULT_MUSIC_ID as string }),
      b: redditFraming({ musicId: DEFAULT_MUSIC_ID as string }),
    };
    expect(get(computePipelineStages(entries, fm, idleRun), 'music')).toMatchObject({ done: 2, total: 2 });
  });

  it('a STALE / unknown track id does NOT count as done — nothing would play (trackById is null)', () => {
    const entries = [E({ id: 'a' })];
    const fm: Record<string, Framing> = { a: redditFraming({ musicId: 'removed-track-id' }) };
    expect(get(computePipelineStages(entries, fm, idleRun), 'music').done).toBe(0);
  });

  it('mixed selection: undefined + a valid id count as done; "" and a stale id are excluded', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' }), E({ id: 'c' }), E({ id: 'd' })];
    const fm: Record<string, Framing> = {
      a: redditFraming(),                            // undefined → default → done
      b: redditFraming({ musicId: '' }),             // No music → not done
      c: redditFraming({ musicId: DEFAULT_MUSIC_ID as string }), // valid → done
      d: redditFraming({ musicId: 'stale-id' }),     // stale/unknown → nothing plays → not done
    };
    expect(get(computePipelineStages(entries, fm, idleRun), 'music')).toMatchObject({ done: 2, total: 4 });
  });
});

// ===========================================================================
// computePipelineStages — narrate (audioDuration > 0 on the Reddit thread overlay)
// ===========================================================================
describe('computePipelineStages — narrate', () => {
  it('counts audioDuration > 0; excludes 0, absent, and negative', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' }), E({ id: 'c' }), E({ id: 'd' }), E({ id: 'e' })];
    const fm: Record<string, Framing> = {
      a: redditFraming({}, 3.2),   // narrated
      b: redditFraming({}, 0),     // boundary: not > 0
      c: redditFraming(),          // absent audioDuration → treated as 0
      d: redditFraming({}, 0.001), // just above 0 → narrated
      e: redditFraming({}, -5),    // negative → not > 0
    };
    expect(get(computePipelineStages(entries, fm, idleRun), 'narrate')).toMatchObject({ done: 2, total: 5 });
  });

  it('uses the "Reddit thread" overlay\'s own audioDuration, NOT some other overlay\'s', () => {
    // A different overlay is narrated but the Reddit-thread card itself has no audio → NOT narrated.
    const entries = [E({ id: 'a' })];
    const fm: Record<string, Framing> = {
      a: F({ overlays: [{ name: 'Intro card', audioDuration: 10 }, { name: 'Reddit thread' }] }),
    };
    expect(get(computePipelineStages(entries, fm, idleRun), 'narrate').done).toBe(0);
  });
});

// ===========================================================================
// computePipelineStages — copy (ytTitle AND description)
// ===========================================================================
describe('computePipelineStages — copy', () => {
  it('requires BOTH ytTitle and description to be present (truthy)', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' }), E({ id: 'c' }), E({ id: 'd' })];
    const fm: Record<string, Framing> = {
      a: redditFraming({ ytTitle: 'T', description: 'D' }),  // both → copied
      b: redditFraming({ ytTitle: 'T' }),                    // title only → not
      c: redditFraming({ description: 'D' }),                // desc only → not
      d: redditFraming(),                                    // neither → not
    };
    expect(get(computePipelineStages(entries, fm, idleRun), 'copy')).toMatchObject({ done: 1, total: 4 });
  });

  it('empty-string title or description does NOT count (falsy)', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' })];
    const fm: Record<string, Framing> = {
      a: redditFraming({ ytTitle: '', description: 'D' }),
      b: redditFraming({ ytTitle: 'T', description: '' }),
    };
    expect(get(computePipelineStages(entries, fm, idleRun), 'copy').done).toBe(0);
  });
});

// ===========================================================================
// computePipelineStages — running flags & progress plumbing
// ===========================================================================
describe('computePipelineStages — running flags & progress', () => {
  it('idle: narrate/copy/export not running, progress null', () => {
    const entries = [E({ id: 'a' })];
    const fm: Record<string, Framing> = { a: redditFraming() };
    const stages = computePipelineStages(entries, fm, idleRun);
    for (const key of ['narrate', 'copy', 'export'] as StageKey[]) {
      expect(get(stages, key).running).toBe(false);
      expect(get(stages, key).progress ?? null).toBeNull();
    }
  });

  it('batchOp="narration": only narrate runs and carries batchProgress; copy stays idle', () => {
    const entries = [E({ id: 'a' })];
    const fm: Record<string, Framing> = { a: redditFraming() };
    const r = run({ batchOp: 'narration', batchProgress: { done: 1, total: 4 } });
    const stages = computePipelineStages(entries, fm, r);
    expect(get(stages, 'narrate').running).toBe(true);
    expect(get(stages, 'narrate').progress).toEqual({ done: 1, total: 4 });
    expect(get(stages, 'copy').running).toBe(false);
    expect(get(stages, 'copy').progress ?? null).toBeNull();
    expect(get(stages, 'export').running).toBe(false);
  });

  it('batchOp="copy": only copy runs and carries batchProgress; narrate stays idle', () => {
    const entries = [E({ id: 'a' })];
    const fm: Record<string, Framing> = { a: redditFraming() };
    const r = run({ batchOp: 'copy', batchProgress: { done: 2, total: 3 } });
    const stages = computePipelineStages(entries, fm, r);
    expect(get(stages, 'copy').running).toBe(true);
    expect(get(stages, 'copy').progress).toEqual({ done: 2, total: 3 });
    expect(get(stages, 'narrate').running).toBe(false);
    expect(get(stages, 'narrate').progress ?? null).toBeNull();
  });

  it('while narrating, narrate.done shows the PERSISTED narrated count, not batchProgress.done', () => {
    // Distinct values so a done/progress mix-up is caught: 2 reels narrated, but batchProgress.done = 1.
    const entries = [E({ id: 'a' }), E({ id: 'b' })];
    const fm: Record<string, Framing> = { a: redditFraming({}, 5), b: redditFraming({}, 5) };
    const r = run({ batchOp: 'narration', batchProgress: { done: 1, total: 2 } });
    const narrate = get(computePipelineStages(entries, fm, r), 'narrate');
    expect(narrate.done).toBe(2);
    expect(narrate.progress).toEqual({ done: 1, total: 2 });
  });
});

// ===========================================================================
// computePipelineStages — export (never a false "Done")
// ===========================================================================
describe('computePipelineStages — export', () => {
  it('idle: done is 0 even with reels present and a stale downloadProgress — never a false "Done"', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' }), E({ id: 'c' })];
    const fm: Record<string, Framing> = { a: redditFraming(), b: redditFraming(), c: redditFraming() };
    // isDownloadingAll false but downloadProgress carries an old value → must be ignored.
    const r = run({ isDownloadingAll: false, downloadProgress: { done: 2, total: 3 } });
    const exp = get(computePipelineStages(entries, fm, r), 'export');
    expect(exp.done).toBe(0);
    expect(exp.total).toBe(3);
    expect(exp.done < exp.total).toBe(true); // not complete while idle
    expect(exp.running).toBe(false);
    expect(exp.progress ?? null).toBeNull();
  });

  it('running: done tracks downloadProgress.done and progress is downloadProgress', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' }), E({ id: 'c' })];
    const fm: Record<string, Framing> = { a: redditFraming(), b: redditFraming(), c: redditFraming() };
    const r = run({ isDownloadingAll: true, downloadProgress: { done: 2, total: 3 } });
    const exp = get(computePipelineStages(entries, fm, r), 'export');
    expect(exp.done).toBe(2);
    expect(exp.running).toBe(true);
    expect(exp.progress).toEqual({ done: 2, total: 3 });
  });

  it('export reads downloadProgress, NOT batchProgress (distinct values catch a source mix-up)', () => {
    const entries = [E({ id: 'a' })];
    const fm: Record<string, Framing> = { a: redditFraming() };
    const r = run({
      batchOp: null,
      batchProgress: { done: 2, total: 5 },      // decoy
      isDownloadingAll: true,
      downloadProgress: { done: 7, total: 9 },   // the real source
    });
    const exp = get(computePipelineStages(entries, fm, r), 'export');
    expect(exp.done).toBe(7);
    expect(exp.progress).toEqual({ done: 7, total: 9 });
  });
});

// ===========================================================================
// computePipelineMusicId — common track, '' preserved, mixed → null
// ===========================================================================
describe('computePipelineMusicId', () => {
  it('no reddit reels → null', () => {
    expect(computePipelineMusicId([], {})).toBeNull();
  });

  it('reels exist but none are reddit → null', () => {
    const entries = [E({ id: 'a' })];
    const fm: Record<string, Framing> = { a: F({ overlays: [{ name: 'not-reddit' }] }) };
    expect(computePipelineMusicId(entries, fm)).toBeNull();
  });

  it('single reel with UNSET musicId → DEFAULT_MUSIC_ID (fresh reel highlights the default)', () => {
    const entries = [E({ id: 'a' })];
    const fm: Record<string, Framing> = { a: redditFraming() };
    expect(computePipelineMusicId(entries, fm)).toBe(DEFAULT_MUSIC_ID);
  });

  it('all reels UNSET → DEFAULT_MUSIC_ID', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' })];
    const fm: Record<string, Framing> = { a: redditFraming(), b: redditFraming() };
    expect(computePipelineMusicId(entries, fm)).toBe(DEFAULT_MUSIC_ID);
  });

  it('all reels explicitly "" → "" (No music is preserved, NOT defaulted or nulled)', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' })];
    const fm: Record<string, Framing> = { a: redditFraming({ musicId: '' }), b: redditFraming({ musicId: '' }) };
    expect(computePipelineMusicId(entries, fm)).toBe('');
  });

  it('single reel explicitly "" → "" (preserved even for one reel)', () => {
    const entries = [E({ id: 'a' })];
    const fm: Record<string, Framing> = { a: redditFraming({ musicId: '' }) };
    expect(computePipelineMusicId(entries, fm)).toBe('');
  });

  it('all reels share a concrete id → that id', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' })];
    const fm: Record<string, Framing> = { a: redditFraming({ musicId: 'foo' }), b: redditFraming({ musicId: 'foo' }) };
    expect(computePipelineMusicId(entries, fm)).toBe('foo');
  });

  it('mixed UNSET vs "" → null (undefined defaults to a track, "" does not → they differ)', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' })];
    const fm: Record<string, Framing> = { a: redditFraming(), b: redditFraming({ musicId: '' }) };
    expect(computePipelineMusicId(entries, fm)).toBeNull();
  });

  it('mixed concrete ids → null', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' })];
    const fm: Record<string, Framing> = { a: redditFraming({ musicId: 'foo' }), b: redditFraming({ musicId: 'bar' }) };
    expect(computePipelineMusicId(entries, fm)).toBeNull();
  });

  it('mixed "" vs concrete id → null', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' })];
    const fm: Record<string, Framing> = { a: redditFraming({ musicId: '' }), b: redditFraming({ musicId: 'foo' }) };
    expect(computePipelineMusicId(entries, fm)).toBeNull();
  });

  it('UNSET and an EXPLICIT default-track id collapse to the same selection → DEFAULT_MUSIC_ID', () => {
    // undefined ?? DEFAULT === DEFAULT, and the explicit value already === DEFAULT.
    const entries = [E({ id: 'a' }), E({ id: 'b' })];
    const fm: Record<string, Framing> = { a: redditFraming(), b: redditFraming({ musicId: DEFAULT_MUSIC_ID as string }) };
    expect(computePipelineMusicId(entries, fm)).toBe(DEFAULT_MUSIC_ID);
  });

  it('only reddit reels drive the result — a non-reddit reel\'s music is ignored', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' }), E({ id: 'x' })];
    const fm: Record<string, Framing> = {
      a: redditFraming({ musicId: 'foo' }),
      b: redditFraming({ musicId: 'foo' }),
      x: F({ overlays: [{ name: 'other' }], musicId: 'bar' }), // not reddit → ignored
    };
    expect(computePipelineMusicId(entries, fm)).toBe('foo');
  });
});

describe('computePipelineStages — styleId tag (reel-style detection)', () => {
  const run: PipelineRunState = { batchOp: null, batchProgress: { done: 0, total: 0 }, isDownloadingAll: false, downloadProgress: { done: 0, total: 0 } };
  const total = (entries: VideoEntry[], fm: Record<string, Framing>) => computePipelineStages(entries, fm, run).find(s => s.key === 'import')!.total;

  it('a reel tagged styleId="commentary" is NOT a Reddit reel (even if it also has the overlay)', () => {
    const entries = [E({ id: 'a', localVideoSrc: 'v' })];
    const fm = { a: { overlays: [{ name: 'Reddit thread' }], styleId: 'commentary' } as unknown as Framing };
    expect(total(entries, fm)).toBe(0);
  });
  it('a reel tagged styleId="reddit" counts even without the overlay', () => {
    const entries = [E({ id: 'a', localVideoSrc: 'v' })];
    const fm = { a: { styleId: 'reddit' } as unknown as Framing };
    expect(total(entries, fm)).toBe(1);
  });
  it('an UNTAGGED reel falls back to overlay detection', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' })];
    const fm = { a: F({ overlays: [{ name: 'Reddit thread' }] }), b: F({ overlays: [{ name: 'other' }] }) };
    expect(total(entries, fm)).toBe(1);
  });
});

// ===========================================================================
// Style-blindness: the module must derive identity from the probe it's given,
// never from a name it knows itself. Each case below FAILS against the old
// hard-coded implementation, which is the point — these guard the regression
// the refactor was for, not the refactor's own shape.
// ===========================================================================
describe('computePipelineStages — style-blind identity', () => {
  /** A hypothetical third style: same shape as Reddit, different overlay name + tag. */
  const MEME_PROBE: StyleProbe = {
    isReel: (id, fm) => fm[id]?.styleId === 'meme',
    primaryOverlayName: 'Meme',
  };

  it('counts a foreign style\'s reels by ITS probe, not by Reddit\'s overlay name', () => {
    const entries = [E({ id: 'a', localVideoSrc: 'v' }), E({ id: 'b', localVideoSrc: 'v' })];
    const fm = {
      a: { styleId: 'meme', overlays: [{ name: 'Meme' }] } as unknown as Framing,
      b: { styleId: 'reddit', overlays: [{ name: 'Reddit thread' }] } as unknown as Framing,
    };
    // The meme reel is the only one this probe claims — the Reddit reel must not leak into its totals.
    expect(get(computeStagesWith(entries, fm, idleRun, MEME_PROBE), 'import').total).toBe(1);
    expect(get(computeStagesWith(entries, fm, idleRun, REDDIT_PROBE), 'import').total).toBe(1);
  });

  it('reads narrate status off the PROBE\'s overlay name (the old code read 0/N here)', () => {
    const entries = [E({ id: 'a' })];
    const fm = { a: { styleId: 'meme', overlays: [{ name: 'Meme', audioDuration: 12 }] } as unknown as Framing };
    expect(get(computeStagesWith(entries, fm, idleRun, MEME_PROBE), 'narrate')).toMatchObject({ done: 1, total: 1 });
  });

  it('does NOT count an overlay of the wrong name as narrated', () => {
    const entries = [E({ id: 'a' })];
    // Carries Reddit's overlay, narrated — but this probe's overlay is 'Meme', so it is not narrated FOR IT.
    const fm = { a: { styleId: 'meme', overlays: [{ name: 'Reddit thread', audioDuration: 12 }] } as unknown as Framing };
    expect(get(computeStagesWith(entries, fm, idleRun, MEME_PROBE), 'narrate').done).toBe(0);
  });

  it('a null primaryOverlayName never reads as narrated, whatever audio the reel carries', () => {
    const probe: StyleProbe = { isReel: (id, fm) => fm[id]?.styleId === 'commentary', primaryOverlayName: null };
    const entries = [E({ id: 'a' })];
    // An intro carrier with audio must NOT satisfy a narrate count keyed to a card that doesn't exist —
    // matching a nameless overlay would make any audio layer read as a narrated card.
    const fm = { a: { styleId: 'commentary', overlays: [{ name: 'Commentary', audioDuration: 30 }] } as unknown as Framing };
    expect(get(computeStagesWith(entries, fm, idleRun, probe), 'narrate')).toMatchObject({ done: 0, total: 1 });
  });

  it('computePipelineMusicId scopes to the probe\'s reels only', () => {
    const entries = [E({ id: 'a' }), E({ id: 'b' })];
    const fm = {
      a: { styleId: 'meme', musicId: 'foo' } as unknown as Framing,
      b: { styleId: 'reddit', musicId: 'bar' } as unknown as Framing,
    };
    // Mixed across styles, uniform within each: each probe must see only its own and report a common id.
    expect(computeMusicIdWith(entries, fm, MEME_PROBE.isReel)).toBe('foo');
    expect(computeMusicIdWith(entries, fm, redditStyle.isReel)).toBe('bar');
  });
});

// ===========================================================================
// The registry's own declarations. These pin the capability values the shell
// branches on — a silent flip (e.g. commentary gaining a primaryOverlayName)
// would re-route narration and duration for a whole style.
// ===========================================================================
describe('reel style capability declarations', () => {
  it('reddit: card-narrated, pipelined, footage-assigned, re-fetches its video', () => {
    expect(redditStyle.primaryOverlayName).toBe('Reddit thread');
    expect(redditStyle.narration).toBe('overlay');
    expect(redditStyle.hasPipeline).toBe(true);
    expect(redditStyle.assignsFootage).toBe(true);
    expect(redditStyle.keepsOwnVideo).toBe(false);
    expect(redditStyle.supportsBgBlur).toBe(false);
  });

  it('commentary: script-narrated, no card, owns its bytes, brings its own video', () => {
    expect(commentaryStyle.primaryOverlayName).toBeNull();
    expect(commentaryStyle.narration).toBe('script');
    expect(commentaryStyle.hasPipeline).toBe(false);
    expect(commentaryStyle.assignsFootage).toBe(false);
    expect(commentaryStyle.keepsOwnVideo).toBe(true);
    expect(commentaryStyle.supportsBgBlur).toBe(true);
  });

  it('a fixed voice cast has a lead and a NON-EMPTY pool (castBlockVoices divides by pool length)', () => {
    // A declared-but-empty pool would make the cast silently no-op, un-voicing every commenter.
    for (const s of [redditStyle, commentaryStyle]) {
      if (s.voiceCast) expect(s.voiceCast.pool.length).toBeGreaterThan(0);
    }
    expect(redditStyle.voiceCast?.lead.id).toBeTruthy();
    expect(commentaryStyle.voiceCast).toBeNull();
  });

  it('the two styles claim DISJOINT rail sections (a shared id would show a foreign flyout)', () => {
    const shared = redditStyle.railSections.filter(s => commentaryStyle.railSections.includes(s));
    expect(shared).toEqual([]);
  });
});
