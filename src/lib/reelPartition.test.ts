import { describe, it, expect } from 'vitest';
import { styleOf, styleTagForSave, rowsForStyle, mergeStyleRows, UNTAGGED_STYLE_ID } from './reelPartition';

// A saved row, reduced to what this module looks at. `k` is just a label so tests can assert identity.
const row = (k: string, styleId?: string) => ({ k, framing: styleId ? { styleId } : {} });
const R = (k: string) => row(k, 'reddit');
const C = (k: string) => row(k, 'commentary');
const keys = (rows: { k: string }[]) => rows.map(r => r.k);

describe('styleOf', () => {
  it('reads the tag', () => {
    expect(styleOf(R('a'))).toBe('reddit');
    expect(styleOf(C('a'))).toBe('commentary');
  });

  it('resolves every flavour of untagged to reddit — legacy grids predate the tag', () => {
    expect(styleOf({ framing: {} })).toBe(UNTAGGED_STYLE_ID);
    expect(styleOf({ framing: { styleId: undefined } })).toBe(UNTAGGED_STYLE_ID);
    expect(styleOf({ framing: null })).toBe(UNTAGGED_STYLE_ID);
    expect(styleOf({})).toBe(UNTAGGED_STYLE_ID);
    expect(styleOf(undefined)).toBe(UNTAGGED_STYLE_ID);
    expect(styleOf({ framing: { styleId: '' } })).toBe(UNTAGGED_STYLE_ID);   // empty string is not a style
  });

  // styleOf runs on rows straight out of JSON.parse, where styleId can be ANY type — but the workspace
  // sees those rows after normalisation, which keeps a styleId only when it's a string. If the two reads
  // disagreed, the row would be invisible to every workspace (normalised → reddit) yet still skipped by
  // reddit's merge (raw → not reddit): each save would strand the stored copy and append a new one, so the
  // reel duplicated on screen and the file grew on every reload. Hence: a tag is a non-empty STRING.
  it('treats a non-string styleId as untagged, so the raw row and the normalised row agree', () => {
    const hostile = [123, true, {}, [], ['commentary'], 0, NaN, () => 'commentary'];
    for (const styleId of hostile) {
      const raw = { framing: { styleId } } as unknown as Parameters<typeof styleOf>[0];
      // What normalizeFraming would leave behind: a non-string styleId is dropped entirely.
      const normalised = { framing: {} };
      expect(styleOf(raw), String(styleId)).toBe(styleOf(normalised));
      expect(styleOf(raw), String(styleId)).toBe(UNTAGGED_STYLE_ID);
    }
  });

  it('always returns a string, so === against a style id is meaningful', () => {
    const weird = [123, true, {}, [], null, undefined, ''];
    for (const styleId of weird) {
      expect(typeof styleOf({ framing: { styleId } } as unknown as Parameters<typeof styleOf>[0])).toBe('string');
    }
  });
});

describe('styleTagForSave', () => {
  it('keeps a real tag', () => {
    expect(styleTagForSave({ styleId: 'commentary' }, 'commentary')).toBe('commentary');
  });

  it('gives an untagged row the ACTIVE style — defaulting to reddit would orphan it', () => {
    // The blank reel a delete-all leaves behind is born without a tag. In the commentary workspace it must
    // be saved as commentary: tagged reddit it would vanish from commentary's next load, and commentary's
    // own save would then drop it as foreign.
    expect(styleTagForSave({}, 'commentary')).toBe('commentary');
    expect(styleTagForSave(undefined, 'commentary')).toBe('commentary');
    expect(styleTagForSave(null, 'commentary')).toBe('commentary');
    expect(styleTagForSave({ styleId: '' }, 'commentary')).toBe('commentary');
    expect(styleTagForSave({ styleId: 123 as unknown as string }, 'commentary')).toBe('commentary');
  });

  it('produces a tag mergeStyleRows will accept, for every input', () => {
    // The point of the helper: whatever it returns, the row survives its own workspace's save.
    for (const framing of [{}, undefined, { styleId: '' }, { styleId: 'commentary' }]) {
      const row = { framing: { styleId: styleTagForSave(framing, 'commentary') } };
      expect(mergeStyleRows([], 'commentary', [row])).toHaveLength(1);
    }
  });
});

describe('rowsForStyle', () => {
  it('returns only that style, in the original order', () => {
    const all = [R('a'), C('b'), R('c'), C('d'), R('e')];
    expect(keys(rowsForStyle(all, 'reddit'))).toEqual(['a', 'c', 'e']);
    expect(keys(rowsForStyle(all, 'commentary'))).toEqual(['b', 'd']);
  });

  it('shows legacy untagged rows to the Reddit workspace', () => {
    const all = [row('legacy'), C('x'), R('y')];
    expect(keys(rowsForStyle(all, 'reddit'))).toEqual(['legacy', 'y']);
    expect(keys(rowsForStyle(all, 'commentary'))).toEqual(['x']);
  });

  it('never leaks another style into a workspace', () => {
    const all = [R('a'), C('b')];
    expect(rowsForStyle(all, 'commentary').every(r => styleOf(r) === 'commentary')).toBe(true);
  });

  it('handles an empty grid', () => {
    expect(rowsForStyle([], 'reddit')).toEqual([]);
  });
});

describe('mergeStyleRows', () => {
  it('replaces only its own style and leaves the rest untouched', () => {
    const all = [R('a'), C('b'), R('c')];
    const merged = mergeStyleRows(all, 'reddit', [R('a2')]);
    expect(keys(merged).sort()).toEqual(['a2', 'b']);
    expect(keys(merged.filter(r => styleOf(r) === 'commentary'))).toEqual(['b']);
  });

  it('THE INVARIANT: a save round-trip loses nothing', () => {
    // Load my rows, save them straight back — every row in the file must survive, both styles.
    const all = [R('a'), C('b'), R('c'), row('legacy'), C('d')];
    for (const style of ['reddit', 'commentary']) {
      const merged = mergeStyleRows(all, style, rowsForStyle(all, style));
      expect(keys(merged).sort(), style).toEqual(keys(all).sort());
    }
  });

  it('one workspace saving cannot destroy the other style, even when it saves NOTHING', () => {
    // Delete-all in the Reddit workspace must not touch commentary reels.
    const all = [R('a'), C('b'), R('c'), C('d')];
    const merged = mergeStyleRows(all, 'reddit', []);
    expect(keys(merged)).toEqual(['b', 'd']);
  });

  it('preserves the other style’s relative order', () => {
    const all = [C('b1'), R('a'), C('b2'), C('b3')];
    expect(keys(mergeStyleRows(all, 'reddit', [])) ).toEqual(['b1', 'b2', 'b3']);
  });

  it('preserves MY order as given', () => {
    const all = [R('a'), C('x')];
    const merged = mergeStyleRows(all, 'reddit', [R('c'), R('b'), R('a')]);
    expect(keys(merged.filter(r => styleOf(r) === 'reddit'))).toEqual(['c', 'b', 'a']);
  });

  it('refuses to re-home a row tagged as another style, rather than letting it overwrite', () => {
    // A commentary row handed to the Reddit workspace's save is a bug upstream; adopting it would let one
    // workspace silently take ownership of another's reel.
    const all = [C('keep')];
    const merged = mergeStyleRows(all, 'reddit', [R('mine'), C('intruder')]);
    expect(keys(merged)).toEqual(['keep', 'mine']);
  });

  it('writes legacy untagged rows back under reddit, so they are not orphaned', () => {
    const all = [row('legacy'), C('x')];
    const mine = rowsForStyle(all, 'reddit');            // ['legacy']
    const merged = mergeStyleRows(all, 'reddit', mine);
    expect(keys(merged).sort()).toEqual(['legacy', 'x']);
  });

  it('does not strand a row whose stored tag is a non-string, which would duplicate it on every save', () => {
    // The reddit workspace SEES this row (normalisation drops the bad tag), so its save must also own it.
    // While styleOf returned the raw 123, the row sat in `others` forever AND was re-appended each save.
    const all = [{ k: 'x', framing: { styleId: 123 } }] as unknown as { k: string; framing: { styleId?: string } }[];
    const merged = mergeStyleRows(all, 'reddit', [R('x')]);
    expect(keys(merged)).toEqual(['x']);
  });

  it('adding a reel in one workspace does not disturb the other', () => {
    const all = [R('a'), C('b')];
    const merged = mergeStyleRows(all, 'commentary', [C('b'), C('new')]);
    expect(keys(merged)).toEqual(['a', 'b', 'new']);
  });

  it('is stable under repeated saves — no drift, no duplication', () => {
    const all = [R('a'), C('b'), R('c')];
    let cur = [...all];
    for (let i = 0; i < 5; i++) cur = mergeStyleRows(cur, 'reddit', rowsForStyle(cur, 'reddit'));
    expect(keys(cur).sort()).toEqual(keys(all).sort());
  });

  it('handles an empty starting grid (first ever save)', () => {
    expect(keys(mergeStyleRows([], 'reddit', [R('a')]))).toEqual(['a']);
  });
});
