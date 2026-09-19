import { describe, it, expect } from 'vitest';
import { parseGrid, mergeGridJson } from './reelGridStore';
import { rowsForStyle, styleOf, styleTagForSave } from './reelPartition';

// These tests are the guard on the one thing a workspace split can get catastrophically wrong: a save from
// one workspace deleting the other's reels. Every case below is phrased as "what's still in the FILE after".

const row = (id: string, styleId?: string) => ({ id, framing: styleId ? { styleId } : {} });
const file = (rows: unknown[]) => JSON.stringify(rows);
const ids = (rows: readonly unknown[]) => rows.map(r => (r as { id?: string }).id);
const parse = (json: string) => JSON.parse(json) as unknown[];

describe('parseGrid', () => {
  it('reads a saved grid', () => {
    expect(ids(parseGrid(file([row('a'), row('b', 'commentary')])))).toEqual(['a', 'b']);
  });

  it('treats absent / empty / non-array / corrupt storage as an empty grid', () => {
    expect(parseGrid(null)).toEqual([]);
    expect(parseGrid('')).toEqual([]);
    expect(parseGrid('{"not":"an array"}')).toEqual([]);
    expect(parseGrid(']not json[')).toEqual([]);
  });
});

describe('mergeGridJson', () => {
  it('replaces only the saving style’s rows', () => {
    const current = file([row('r1', 'reddit'), row('c1', 'commentary'), row('r2', 'reddit')]);
    const out = parse(mergeGridJson(current, 'reddit', [row('r9', 'reddit')]));
    expect(ids(out).sort()).toEqual(['c1', 'r9']);
  });

  it('leaves the other style’s rows BYTE-IDENTICAL, including fields this build doesn’t know', () => {
    // A future/other-workspace row carries fields our normaliser would drop. It must round-trip untouched,
    // which is why the merge passes other rows through as parsed instead of re-deriving them.
    const foreign = { id: 'c1', framing: { styleId: 'commentary', somethingNew: [1, 2, 3] }, futureField: 'keep me' };
    const current = file([row('r1', 'reddit'), foreign]);
    const out = parse(mergeGridJson(current, 'reddit', [row('r1', 'reddit'), row('r2', 'reddit')]));
    const survived = out.find(r => (r as { id?: string }).id === 'c1');
    expect(JSON.stringify(survived)).toBe(JSON.stringify(foreign));
  });

  it('DELETE-ALL in one workspace does not delete the other’s reels', () => {
    const current = file([row('r1', 'reddit'), row('c1', 'commentary'), row('c2', 'commentary')]);
    expect(ids(parse(mergeGridJson(current, 'reddit', [])))).toEqual(['c1', 'c2']);
    expect(ids(parse(mergeGridJson(current, 'commentary', [])))).toEqual(['r1']);
  });

  it('THE INVARIANT: load a style, save it straight back, and the file still holds every row', () => {
    const rows = [row('r1', 'reddit'), row('c1', 'commentary'), row('legacy'), row('c2', 'commentary')];
    const current = file(rows);
    for (const style of ['reddit', 'commentary']) {
      const mine = rowsForStyle(parseGrid(current), style);
      expect(ids(parse(mergeGridJson(current, style, mine))).sort(), style).toEqual(ids(rows).sort());
    }
  });

  it('a legacy grid of UNTAGGED rows is the Reddit workspace’s, and survives a commentary save', () => {
    const current = file([row('legacy1'), row('legacy2')]);
    expect(ids(rowsForStyle(parseGrid(current), 'reddit'))).toEqual(['legacy1', 'legacy2']);
    expect(ids(rowsForStyle(parseGrid(current), 'commentary'))).toEqual([]);
    const out = parse(mergeGridJson(current, 'commentary', [row('c1', 'commentary')]));
    expect(ids(out)).toEqual(['legacy1', 'legacy2', 'c1']);
  });

  it('first-ever save writes the rows into an empty / absent file', () => {
    expect(ids(parse(mergeGridJson(null, 'reddit', [row('r1', 'reddit')])))).toEqual(['r1']);
    expect(ids(parse(mergeGridJson('[]', 'commentary', [row('c1', 'commentary')])))).toEqual(['c1']);
  });

  it('merges into the file AS IT IS NOW, not into a stale snapshot', () => {
    // The reason the hook re-reads at write time: while this workspace sat open, the other one added a reel
    // and deleted another. Saving against the snapshot from load would undo both.
    const atLoad = file([row('r1', 'reddit'), row('c1', 'commentary')]);
    const now = file([row('r1', 'reddit'), row('c2', 'commentary')]);   // other workspace: -c1, +c2
    const out = parse(mergeGridJson(now, 'reddit', rowsForStyle(parseGrid(atLoad), 'reddit')));
    expect(ids(out)).toEqual(['c2', 'r1']);
  });

  it('does not adopt a row tagged as another style, and that style’s stored row survives', () => {
    const current = file([row('c1', 'commentary')]);
    const out = parse(mergeGridJson(current, 'reddit', [row('r1', 'reddit'), row('c1', 'commentary')]));
    expect(ids(out)).toEqual(['c1', 'r1']);
    expect(out.filter(r => (r as { id?: string }).id === 'c1')).toHaveLength(1);   // not duplicated into reddit's set
  });

  it('is stable under repeated saves from both workspaces — no drift, no duplication, no loss', () => {
    const rows = [row('r1', 'reddit'), row('c1', 'commentary'), row('legacy')];
    let current = file(rows);
    for (let i = 0; i < 5; i++) {
      for (const style of ['reddit', 'commentary']) {
        current = mergeGridJson(current, style, rowsForStyle(parseGrid(current), style));
      }
    }
    expect(ids(parse(current)).sort()).toEqual(ids(rows).sort());
  });

  it('keeps non-row junk out of the other workspace’s way rather than deleting it', () => {
    // Corrupt entries read as Reddit's (styleOf falls back), so only Reddit's own save clears them —
    // a commentary save must not decide to delete rows it can't interpret.
    const current = file([null, 'junk', row('c1', 'commentary')]);
    expect(parse(mergeGridJson(current, 'commentary', [row('c1', 'commentary')]))).toHaveLength(3);
    expect(ids(parse(mergeGridJson(current, 'reddit', [])))).toEqual(['c1']);
  });

  it('never reorders rows WITHIN a style, however often either workspace saves', () => {
    // Cross-style order is meaningless (no view shows both) and the merge does move the blocks around, but
    // a workspace's own reels must come back in the order the user arranged them, save after save.
    let current = file([row('r1', 'reddit'), row('c1', 'commentary'), row('r2', 'reddit'),
                        row('c2', 'commentary'), row('r3', 'reddit')]);
    for (let i = 0; i < 5; i++) {
      for (const style of ['commentary', 'reddit']) {
        current = mergeGridJson(current, style, rowsForStyle(parseGrid(current), style));
      }
      expect(ids(rowsForStyle(parseGrid(current), 'reddit')), `pass ${i}`).toEqual(['r1', 'r2', 'r3']);
      expect(ids(rowsForStyle(parseGrid(current), 'commentary')), `pass ${i}`).toEqual(['c1', 'c2']);
    }
  });
});

// ── A whole workspace session, end to end ────────────────────────────────────────────────────────────
// The cases above pin the merge; these drive the composition the app actually runs — load through
// rowsForStyle, stamp through styleTagForSave, write through mergeGridJson RE-READING the file — against a
// stand-in for localStorage. Everything a workspace does to the saved grid goes through `save` below, so if
// these hold, no sequence of workspace actions can lose a reel.

interface Row { id: string; framing: Record<string, unknown>; [k: string]: unknown }

function makeStore(initial?: unknown[]) {
  let mem: string | null = initial ? JSON.stringify(initial) : null;
  return {
    raw: () => mem,
    rows: () => parseGrid(mem) as Row[],
    idsOf: (styleId: string) => ids(rowsForStyle(parseGrid(mem) as Row[], styleId)),
    /** Rows NOT owned by `styleId`, as raw JSON — the thing that must never change when that style saves. */
    foreign: (styleId: string) => JSON.stringify((parseGrid(mem) as Row[]).filter(r => styleOf(r) !== styleId)),
    /** useReelPersistence's load: a workspace is only ever handed its own rows. */
    open: (styleId: string) => rowsForStyle(parseGrid(mem) as Row[], styleId).map(r => ({ ...r })),
    /** useReelPersistence's write, with CanvasGrid's row builder in front of it. */
    save: (styleId: string, grid: Row[]) => {
      const stamped = grid.map(r => ({ ...r, framing: { ...r.framing, styleId: styleTagForSave(r.framing, styleId) } }));
      mem = mergeGridJson(mem, styleId, stamped);
    },
  };
}

const reel = (id: string, styleId?: string): Row => ({ id, framing: styleId ? { styleId } : {} });

describe('a workspace session', () => {
  it('(a) opens a legacy all-untagged grid in Reddit with every reel present and unchanged', () => {
    const legacy = [
      { id: 'a', name: 'first', url: 'https://x/1', framing: { videoScale: 1.5, overlays: [{ id: 'o1' }] } },
      { id: 'b', name: '', url: '', framing: {} },
      { id: 'c', name: 'third', url: 'https://x/3', framing: { trimStart: 2, musicId: 'm1' } },
    ];
    const store = makeStore(legacy);
    expect(store.open('reddit')).toEqual(legacy);          // same rows, same order, same contents
    expect(store.open('commentary')).toEqual([]);          // and none of them leak into the other workspace
  });

  it('(b) shows each workspace only its own reels in a mixed grid', () => {
    const store = makeStore([reel('r1', 'reddit'), reel('c1', 'commentary'), reel('legacy'), reel('c2', 'commentary')]);
    expect(ids(store.open('reddit'))).toEqual(['r1', 'legacy']);   // untagged counts as Reddit's
    expect(ids(store.open('commentary'))).toEqual(['c1', 'c2']);
  });

  it('(c) leaves the other style byte-identical when a workspace saves — edits, adds and removals alike', () => {
    const store = makeStore([reel('r1', 'reddit'), reel('c1', 'commentary'), reel('legacy'), reel('c2', 'commentary')]);
    const before = store.foreign('reddit');
    const grid = store.open('reddit');
    grid[0].framing.trimStart = 4;         // edit
    grid.push(reel('r2', 'reddit'));       // add
    grid.splice(1, 1);                     // remove the legacy row
    store.save('reddit', grid);
    expect(store.foreign('reddit')).toBe(before);
    expect(store.idsOf('commentary')).toEqual(['c1', 'c2']);
  });

  it('(d) survives a delete-all in the other workspace', () => {
    const store = makeStore([reel('r1', 'reddit'), reel('c1', 'commentary'), reel('r2', 'reddit')]);
    const before = store.foreign('commentary');
    store.save('commentary', [reel('1')]);   // delete-all leaves ONE blank, untagged reel behind
    expect(store.idsOf('reddit')).toEqual(['r1', 'r2']);
    expect(store.foreign('commentary')).toBe(before);
    // ...and the blank reel is commentary's, not silently donated to Reddit.
    expect(store.idsOf('commentary')).toEqual(['1']);
  });

  it('(d2) delete-all in Reddit leaves commentary untouched', () => {
    const store = makeStore([reel('r1', 'reddit'), reel('c1', 'commentary'), reel('legacy')]);
    store.save('reddit', [reel('1')]);
    expect(store.idsOf('commentary')).toEqual(['c1']);
    expect(store.idsOf('reddit')).toEqual(['1']);   // both r1 and the legacy row are gone, as asked
  });

  it('(e) makes a first-ever save on an empty grid, from either workspace', () => {
    for (const style of ['reddit', 'commentary']) {
      const store = makeStore();                     // nothing in storage at all
      expect(store.raw()).toBeNull();
      store.save(style, [reel('1')]);
      expect(store.idsOf(style), style).toEqual(['1']);
      expect(store.idsOf(style === 'reddit' ? 'commentary' : 'reddit'), style).toEqual([]);
    }
  });

  it('(f) does not drift, duplicate or reorder under a long interleaving of both workspaces', () => {
    const store = makeStore([reel('r1', 'reddit'), reel('c1', 'commentary'), reel('legacy')]);
    for (let i = 0; i < 10; i++) {
      // Each pass: open, save straight back — the shape of an autosave firing on an untouched grid.
      store.save('reddit', store.open('reddit'));
      store.save('commentary', store.open('commentary'));
    }
    expect(store.idsOf('reddit')).toEqual(['r1', 'legacy']);
    expect(store.idsOf('commentary')).toEqual(['c1']);
    expect(store.rows()).toHaveLength(3);            // no growth
  });

  it('(g) tags a newly added reel and brings it back after a reload, in either workspace', () => {
    const store = makeStore([reel('r1', 'reddit'), reel('c1', 'commentary')]);
    // Commentary adds one (tagged at creation) and one born untagged (the blank-reel path).
    const grid = store.open('commentary');
    grid.push(reel('c-new', 'commentary'), reel('c-untagged'));
    store.save('commentary', grid);
    // Reload: both come back to commentary, neither leaked into Reddit.
    expect(store.idsOf('commentary')).toEqual(['c1', 'c-new', 'c-untagged']);
    expect(store.idsOf('reddit')).toEqual(['r1']);
    // ...and they survive Reddit saving over its own set afterwards.
    store.save('reddit', store.open('reddit'));
    expect(store.idsOf('commentary')).toEqual(['c1', 'c-new', 'c-untagged']);
  });

  it('(g2) keeps a reel added in one workspace across a switch to the other and back', () => {
    const store = makeStore();
    store.save('reddit', [reel('r1', 'reddit')]);            // Reddit: create + autosave
    store.save('commentary', [reel('c1', 'commentary')]);    // switch → commentary: create + autosave
    store.save('reddit', store.open('reddit'));              // switch back → Reddit restores + autosaves
    expect(store.idsOf('reddit')).toEqual(['r1']);
    expect(store.idsOf('commentary')).toEqual(['c1']);
    expect(store.rows()).toHaveLength(2);
  });

  it('a save armed in one workspace and landing after a switch still writes to ITS style', () => {
    // useReelPersistence tags the debounced save with the style that armed it, so a flush that lands late
    // (unmount / pagehide / the switch itself) writes the old workspace's rows into the OLD slot.
    const store = makeStore([reel('r1', 'reddit'), reel('c1', 'commentary')]);
    const armedInReddit = store.open('reddit');
    armedInReddit.push(reel('r2', 'reddit'));
    store.save('commentary', store.open('commentary'));   // the switch happened first
    store.save('reddit', armedInReddit);                  // ...then the pending reddit save flushed
    expect(store.idsOf('reddit')).toEqual(['r1', 'r2']);
    expect(store.idsOf('commentary')).toEqual(['c1']);
  });
});
