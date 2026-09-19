import { describe, it, expect } from 'vitest';
import {
  groupComments, loadMore, toggleIndex, resolveReadTarget,
  effectiveTitle, effectivePara, effectiveComment, commentIsEdited, threadEstimateText,
  cleanChanges, recordHistory, undoHistory, redoHistory, emptyHistory,
  type PickableThread, type ImportedRedditComment,
} from './redditPicker';
import type { ScriptItem } from './redditThreadEdits';

// The picker is shared by two hosts (canvas rail flyout + pipeline bulk builder), so these rules are the
// contract that keeps them identical. Each test states the user-visible consequence of getting it wrong.

const c = (body: string, depth = 0): ImportedRedditComment => ({ user: { name: `u${body}` }, body, depth });

const thread = (over: Partial<PickableThread> = {}): PickableThread => ({
  post: { user: { name: 'op' }, title: 'Title' },
  comments: [c('first'), c('second')],
  paragraphs: ['Para one.', 'Para two.'],
  selectedComments: new Set(),
  selectedParas: new Set(),
  edits: {},
  ...over,
});

describe('groupComments', () => {
  it('gives every top-level comment its own group, in import order', () => {
    expect(groupComments([c('a'), c('b'), c('d')])).toEqual([
      { top: 0, replies: [] }, { top: 1, replies: [] }, { top: 2, replies: [] },
    ]);
  });

  it('attaches replies to the top-level comment above them, keeping FULL-array indices', () => {
    // Indices are what the picker ticks + what edits key off — a group-local index would select the
    // wrong comment the moment a thread has replies.
    expect(groupComments([c('a'), c('a1', 1), c('a2', 1), c('b'), c('b1', 1)])).toEqual([
      { top: 0, replies: [1, 2] },
      { top: 3, replies: [4] },
    ]);
  });

  it('promotes a leading orphan reply to its own group — a truncated import must stay pickable', () => {
    expect(groupComments([c('orphan', 1), c('top')])).toEqual([
      { top: 0, replies: [] }, { top: 1, replies: [] },
    ]);
  });

  it('treats a missing depth as top level (the importer omits depth 0 on some paths)', () => {
    expect(groupComments([{}, {}])).toEqual([{ top: 0, replies: [] }, { top: 1, replies: [] }]);
  });

  it('deeper replies still land in the group above (never dropped)', () => {
    expect(groupComments([c('a'), c('a1', 1), c('a1a', 2)])).toEqual([{ top: 0, replies: [1, 2] }]);
  });

  it('no comments → no groups', () => {
    expect(groupComments([])).toEqual([]);
  });
});

describe('loadMore', () => {
  it('reports what is left and how many the next click reveals', () => {
    expect(loadMore(20, 8, 8)).toEqual({ remaining: 12, count: 8, nextShown: 16 });
  });

  it('the last page reveals only what remains — the button must not promise 8 when 3 are left', () => {
    expect(loadMore(11, 8, 8)).toEqual({ remaining: 3, count: 3, nextShown: 11 });
  });

  it('nothing hidden → no button, and nextShown cannot run past the total', () => {
    expect(loadMore(8, 8, 8)).toEqual({ remaining: 0, count: 0, nextShown: 8 });
    expect(loadMore(5, 8, 8)).toEqual({ remaining: 0, count: 0, nextShown: 8 });
  });
});

describe('toggleIndex', () => {
  it('adds a missing index and removes a present one', () => {
    expect([...toggleIndex(new Set([1]), 2)].sort()).toEqual([1, 2]);
    expect([...toggleIndex(new Set([1, 2]), 2)]).toEqual([1]);
  });

  it('returns a NEW set — mutating in place would skip React’s re-render', () => {
    const prev = new Set([1]);
    const next = toggleIndex(prev, 2);
    expect(next).not.toBe(prev);
    expect([...prev]).toEqual([1]);
  });
});

describe('resolveReadTarget', () => {
  const base = { editing: null, reading: null, commentCount: 3, paraCount: 2 };

  it('PINS the pane to the open editor — a hover must not unmount an edit in progress', () => {
    expect(resolveReadTarget({ ...base, editing: { kind: 'c', idx: 2 }, reading: { kind: 'c', idx: 0 } }))
      .toEqual({ kind: 'c', idx: 2 });
    expect(resolveReadTarget({ ...base, editing: { kind: 'p', idx: 1 }, reading: { kind: 'c', idx: 0 } }))
      .toEqual({ kind: 'p', idx: 1 });
  });

  it('a TITLE editor does not pin the pane (the title is edited in the left column, not the pane)', () => {
    expect(resolveReadTarget({ ...base, editing: { kind: 't', idx: 0 }, reading: { kind: 'c', idx: 1 } }))
      .toEqual({ kind: 'c', idx: 1 });
  });

  it('follows the hovered/clicked row when nothing is being edited', () => {
    expect(resolveReadTarget({ ...base, reading: { kind: 'p', idx: 1 } })).toEqual({ kind: 'p', idx: 1 });
  });

  it('opens on the first comment, else the first paragraph, so the pane is never blank', () => {
    expect(resolveReadTarget(base)).toEqual({ kind: 'c', idx: 0 });
    expect(resolveReadTarget({ ...base, commentCount: 0 })).toEqual({ kind: 'p', idx: 0 });
  });

  it('an empty thread has no target', () => {
    expect(resolveReadTarget({ ...base, commentCount: 0, paraCount: 0 })).toBeNull();
  });
});

describe('effective text', () => {
  it('an edit wins over the original', () => {
    const t = thread({ edits: { title: 'Punchier', paras: { 0: 'Edited one.' } } });
    expect(effectiveTitle(t)).toBe('Punchier');
    expect(effectivePara(t, 0)).toBe('Edited one.');
    expect(effectivePara(t, 1)).toBe('Para two.');
  });

  it('a whitespace-only override reads as the ORIGINAL — blank means revert, never delete', () => {
    const t = thread({ edits: { title: '   ', paras: { 1: '\n ' } } });
    expect(effectiveTitle(t)).toBe('Title');
    expect(effectivePara(t, 1)).toBe('Para two.');
  });

  it('comment overrides resolve by content anchor, so an edit lands on the comment it was authored from', () => {
    const t = thread({
      comments: [c('first'), c('second')],
      edits: { comments: { 5: 'reworded' }, commentOrig: { 5: 'second' } },   // slot key ≠ index
    });
    expect(effectiveComment(t, 1)).toBe('reworded');
    expect(commentIsEdited(t, 1)).toBe(true);
    expect(effectiveComment(t, 0)).toBe('first');
    expect(commentIsEdited(t, 0)).toBe(false);
  });

  it('a DRIFTED comment edit (its anchor no longer matches) reads as un-edited, not as the wrong text', () => {
    const t = thread({ edits: { comments: { 0: 'reworded' }, commentOrig: { 0: 'a body that is gone' } } });
    expect(effectiveComment(t, 0)).toBe('first');
    expect(commentIsEdited(t, 0)).toBe(false);
  });
});

describe('threadEstimateText', () => {
  it('is the title plus the TICKED paragraphs and comments only', () => {
    const t = thread({ selectedParas: new Set([1]), selectedComments: new Set([0]) });
    expect(threadEstimateText(t)).toBe('Title Para two. first');
  });

  it('estimates the EDITED text — the over-3:00 warning must match the reel that builds', () => {
    const t = thread({
      selectedParas: new Set([0]), selectedComments: new Set([1]),
      edits: { title: 'New title', paras: { 0: 'Way longer paragraph.' }, comments: { 1: 'reworded' }, commentOrig: { 1: 'second' } },
    });
    expect(threadEstimateText(t)).toBe('New title Way longer paragraph. reworded');
  });

  it('a pick that no longer resolves (the thread shrank on re-import) is skipped, not counted as blank', () => {
    const t = thread({ selectedParas: new Set([9]), selectedComments: new Set([9]) });
    expect(threadEstimateText(t)).toBe('Title');
  });

  it('nothing ticked → just the title', () => {
    expect(threadEstimateText(thread())).toBe('Title');
  });
});

describe('cleanChanges', () => {
  const item = (over: Partial<ScriptItem>): ScriptItem =>
    ({ kind: 'c', idx: 0, label: 'l', text: 'x', edited: false, editable: true, ...over });
  const upper = (s: string) => s.toUpperCase();

  it('rewrites every editable field whose cleaned form differs, keeping its kind + index', () => {
    const out = cleanChanges([item({ kind: 't', idx: 0, text: 'a' }), item({ kind: 'c', idx: 3, text: 'b' })], upper);
    expect(out).toEqual([{ kind: 't', idx: 0, text: 'A' }, { kind: 'c', idx: 3, text: 'B' }]);
  });

  it('skips fields that are already clean — a re-clean must not create an empty undo step', () => {
    expect(cleanChanges([item({ text: 'ALREADY' })], upper)).toEqual([]);
  });

  it('never empties a field that cleans to nothing (a comment that is only a link)', () => {
    expect(cleanChanges([item({ text: 'https://x.com' })], () => '')).toEqual([]);
  });

  it('leaves non-editable fields alone', () => {
    expect(cleanChanges([item({ text: 'a', editable: false })], upper)).toEqual([]);
  });
});

describe('edit history', () => {
  it('undo restores the previous value and makes the current one redoable', () => {
    let h = emptyHistory<string>();
    h = recordHistory(h, 'v1');
    const u = undoHistory(h, 'v2');
    expect(u.restored).toBe('v1');
    const r = redoHistory(u.history, 'v1');
    expect(r.restored).toBe('v2');
    expect(r.history.future).toEqual([]);
  });

  it('round-trips several steps in LIFO order', () => {
    let h = emptyHistory<string>();
    h = recordHistory(h, 'v1');
    h = recordHistory(h, 'v2');
    const first = undoHistory(h, 'v3');
    expect(first.restored).toBe('v2');
    const second = undoHistory(first.history, 'v2');
    expect(second.restored).toBe('v1');
    expect(undoHistory(second.history, 'v1').restored).toBeUndefined();
  });

  it('a new edit clears the redo branch — you cannot redo onto a diverged timeline', () => {
    let h = emptyHistory<string>();
    h = recordHistory(h, 'v1');
    const u = undoHistory(h, 'v2');
    expect(u.history.future).toEqual(['v2']);
    const afterEdit = recordHistory(u.history, 'v1');
    expect(afterEdit.future).toEqual([]);
    expect(redoHistory(afterEdit, 'v9').restored).toBeUndefined();
  });

  it('undo/redo with nothing to do is a no-op (same history, nothing restored)', () => {
    const h = emptyHistory<string>();
    expect(undoHistory(h, 'v1')).toEqual({ history: h });
    expect(redoHistory(h, 'v1')).toEqual({ history: h });
  });

  it('caps the stack by dropping the OLDEST snapshot, so a long session cannot grow without bound', () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < 5; i++) h = recordHistory(h, i, 3);
    expect(h.past).toEqual([2, 3, 4]);
  });

  it('never mutates the history it is handed (React state holds these)', () => {
    const h: { past: string[]; future: string[] } = { past: ['v1'], future: ['v2'] };
    recordHistory(h, 'v3');
    undoHistory(h, 'v3');
    redoHistory(h, 'v3');
    expect(h).toEqual({ past: ['v1'], future: ['v2'] });
  });
});
