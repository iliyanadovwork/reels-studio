import { describe, it, expect } from 'vitest';
import { mediaIdsForRows, mediaIdsOutsideStyle } from './reelMedia';
import { parseGrid } from './reelGridStore';

// This module decides what a delete-all DESTROYS. Every test below is phrased as "which blobs survive",
// because the failure that matters isn't a leaked blob — it's the other workspace's uploads, cards and
// narration being wiped by a delete the user ran somewhere else.

const reel = (id: string, styleId: string | undefined, framing: Record<string, unknown> = {}) =>
  ({ id, framing: { ...(styleId ? { styleId } : {}), ...framing } });

/** A fully-loaded reel: an upload (keyed by the reel id), a card + its narration, and a thumbnail. */
const loaded = (id: string, styleId?: string) => reel(id, styleId, {
  thumbnailId: `th-${id}`,
  overlays: [
    { id: `ov-${id}-card`, name: 'Reddit thread', audioId: `aud-${id}` },
    { id: `ov-${id}-img`, name: 'meme.png' },
  ],
});

describe('mediaIdsForRows', () => {
  it('collects the reel id, every overlay id, every narration audio id and the thumbnail', () => {
    const out = mediaIdsForRows([loaded('r1', 'reddit')]);
    expect(out.videoIds).toEqual(['r1']);
    expect(out.imageIds.sort()).toEqual(['aud-r1', 'ov-r1-card', 'ov-r1-img', 'th-r1']);
  });

  it('keeps the two stores apart — a reel id is never an image key, and vice versa', () => {
    const out = mediaIdsForRows([loaded('r1', 'reddit'), loaded('c1', 'commentary')]);
    expect(out.videoIds.sort()).toEqual(['c1', 'r1']);
    expect(out.imageIds).not.toContain('r1');
    expect(out.videoIds).not.toContain('th-r1');
  });

  it('dedupes an id shared by two rows (a duplicated reel points at the same card blob)', () => {
    const dup = { ...loaded('r1', 'reddit'), id: 'r2' };
    const out = mediaIdsForRows([loaded('r1', 'reddit'), dup]);
    expect(out.videoIds).toEqual(['r1', 'r2']);
    expect(out.imageIds.filter(i => i === 'ov-r1-card')).toHaveLength(1);
  });

  it('walks a bare reel (no framing at all) down to just its video key', () => {
    expect(mediaIdsForRows([{ id: 'r1' }])).toEqual({ videoIds: ['r1'], imageIds: [] });
    expect(mediaIdsForRows([reel('r1', 'reddit')])).toEqual({ videoIds: ['r1'], imageIds: [] });
  });

  it('yields nothing rather than throwing on junk — corrupt rows must not abort the walk', () => {
    // A throw here would hand the caller a half-built keep-set, and every blob missing from it dies.
    const rows: unknown[] = [
      null, 'junk', 42, [],
      { id: 7 },                                             // non-string id
      { id: 'r1', framing: 'nope' },                          // framing isn't an object
      { id: 'r2', framing: { overlays: 'nope', thumbnailId: 9 } },   // overlays isn't an array
      { id: 'r3', framing: { overlays: [null, 'x', { id: 5 }, { audioId: '' }] } },
      loaded('r4', 'reddit'),
    ];
    const out = mediaIdsForRows(rows);
    expect(out.videoIds).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(out.imageIds.sort()).toEqual(['aud-r4', 'ov-r4-card', 'ov-r4-img', 'th-r4']);
  });

  it('reads rows exactly as parseGrid hands them over', () => {
    const raw = JSON.stringify([loaded('r1', 'reddit'), null, 'junk']);
    expect(mediaIdsForRows(parseGrid(raw)).videoIds).toEqual(['r1']);
  });
});

describe('mediaIdsOutsideStyle', () => {
  it('spares every blob of the OTHER style and none of the deleted one’s', () => {
    const rows = [loaded('r1', 'reddit'), loaded('c1', 'commentary'), loaded('r2', 'reddit')];
    const keep = mediaIdsOutsideStyle(rows, 'reddit');
    expect(keep.videoIds).toEqual(['c1']);
    expect(keep.imageIds.sort()).toEqual(['aud-c1', 'ov-c1-card', 'ov-c1-img', 'th-c1']);
    // ...and nothing belonging to the reels actually being deleted is accidentally protected.
    for (const id of ['r1', 'r2']) expect(keep.videoIds).not.toContain(id);
    for (const id of ['th-r1', 'aud-r1', 'ov-r1-card']) expect(keep.imageIds).not.toContain(id);
  });

  it('THE INVARIANT: whatever style is deleted, every other style’s media survives', () => {
    const rows = [loaded('r1', 'reddit'), loaded('c1', 'commentary'), loaded('legacy'), loaded('c2', 'commentary')];
    for (const style of ['reddit', 'commentary']) {
      const keep = mediaIdsOutsideStyle(rows, style);
      const survivors = rows.filter(r => (r.framing.styleId ?? 'reddit') !== style);
      const owed = mediaIdsForRows(survivors);
      expect(keep.videoIds.sort(), style).toEqual(owed.videoIds.sort());
      expect(keep.imageIds.sort(), style).toEqual(owed.imageIds.sort());
    }
  });

  it('treats a legacy untagged grid as Reddit’s: a commentary delete-all spares it whole', () => {
    const rows = [loaded('legacy1'), loaded('legacy2'), loaded('c1', 'commentary')];
    const keep = mediaIdsOutsideStyle(rows, 'commentary');
    expect(keep.videoIds).toEqual(['legacy1', 'legacy2']);
    expect(keep.imageIds).toContain('aud-legacy1');
    // Reddit's own delete-all is the one that clears them — that IS the delete the user ran.
    expect(mediaIdsOutsideStyle(rows, 'reddit').videoIds).toEqual(['c1']);
  });

  it('spares junk rows from a non-Reddit delete-all instead of destroying what it can’t read', () => {
    // Unreadable rows resolve to Reddit (styleOf), so only a Reddit delete-all clears them — matching how
    // the merge treats them. They contribute no ids, so they can't protect anything either.
    const rows: unknown[] = [null, 'junk', loaded('c1', 'commentary')];
    expect(mediaIdsOutsideStyle(rows, 'commentary')).toEqual({ videoIds: [], imageIds: [] });
  });

  it('keeps nothing when the file holds only the style being deleted — including an empty file', () => {
    expect(mediaIdsOutsideStyle([], 'reddit')).toEqual({ videoIds: [], imageIds: [] });
    expect(mediaIdsOutsideStyle([loaded('r1', 'reddit')], 'reddit')).toEqual({ videoIds: [], imageIds: [] });
  });

  it('protects a colliding id if ANY surviving reel claims it', () => {
    // Legacy ids aren't rewritten, so a pre-split grid can still hold the same id in both styles. The keep
    // set is a union: an id one workspace still references is never deleted by the other's delete-all.
    const rows = [reel('1', 'reddit'), reel('1', 'commentary')];
    expect(mediaIdsOutsideStyle(rows, 'reddit').videoIds).toEqual(['1']);
    expect(mediaIdsOutsideStyle(rows, 'commentary').videoIds).toEqual(['1']);
  });
});
