import { describe, it, expect } from 'vitest';
import { applyThreadEdits, remapCommentEdits, depth0IndexOf, writeCommentEdit, writeFieldEdit, readCommentEdit, assembleScriptItems, splitParagraphs, hasThreadEdits } from './redditThreadEdits';

// Expectations from the design contract: edits are keyed by the SAME indices the pickable lists use;
// empty/garbage overrides never destroy content; a para edit must never change the paragraph COUNT
// on a round-trip (that would shift every later index and silently mis-target selections + edits).

const post = { title: 'Original title', body: 'Para one.\n\nPara two.\n\nPara three.' };
const comments = [{ body: 'first comment' }, { body: 'second comment' }];

describe('applyThreadEdits', () => {
  it('no edits → identical content, same references (cheap identity path)', () => {
    const r = applyThreadEdits(post, comments, undefined);
    expect(r.post).toBe(post);
    expect(r.comments).toBe(comments);
  });

  it('overrides the title (and collapses newlines — titles are single-line)', () => {
    const r = applyThreadEdits(post, comments, { title: 'Punchier\ntitle ' });
    expect(r.post.title).toBe('Punchier title');
    expect(post.title).toBe('Original title');   // input untouched
  });

  it('overrides a paragraph by index and rejoins the body', () => {
    const r = applyThreadEdits(post, comments, { paras: { 1: 'Edited second para.' } });
    expect(splitParagraphs(r.post.body)).toEqual(['Para one.', 'Edited second para.', 'Para three.']);
  });

  it('INDEX-STABILITY: a paragraph edit containing a blank line cannot split into two paragraphs', () => {
    const r = applyThreadEdits(post, comments, { paras: { 0: 'part a\n\npart b' } });
    const paras = splitParagraphs(r.post.body);
    expect(paras).toHaveLength(3);               // still 3 — indices 1 and 2 unshifted
    expect(paras[0]).toBe('part a\npart b');     // blank line collapsed to a single newline
    expect(paras[1]).toBe('Para two.');
  });

  it('overrides a comment body by index, leaving the others alone', () => {
    const r = applyThreadEdits(post, comments, { comments: { 1: 'reworded' } });
    expect(r.comments[0].body).toBe('first comment');
    expect(r.comments[1].body).toBe('reworded');
    expect(comments[1].body).toBe('second comment');   // input untouched
  });

  it('empty / whitespace overrides are ignored (revert semantics, never deletion)', () => {
    const r = applyThreadEdits(post, comments, { title: '   ', paras: { 0: '' }, comments: { 0: '\n ' } });
    expect(r.post.title).toBe('Original title');
    expect(r.post.body).toBe(post.body);
    expect(r.comments[0].body).toBe('first comment');
  });

  it('out-of-range indices are ignored (a re-imported thread can shrink)', () => {
    const r = applyThreadEdits(post, comments, { paras: { 99: 'ghost' }, comments: { 99: 'ghost' } });
    expect(splitParagraphs(r.post.body)).toHaveLength(3);
    expect(r.comments).toHaveLength(2);
  });

  it('a body-less post with paragraph edits stays body-less (no fabricated body)', () => {
    const r = applyThreadEdits({ title: 't' } as { title: string; body?: string }, comments, { paras: { 0: 'ghost' } });
    expect(r.post.body).toBeUndefined();
  });

  it('extra fields on post/comments pass through untouched (generic shapes)', () => {
    const rich = { title: 't', body: 'a', user: { name: 'u/x' }, score: '5' };
    const r = applyThreadEdits(rich, [{ body: 'c', user: { name: 'u/y' }, depth: 0 }], { title: 'T2' });
    expect(r.post.user).toEqual({ name: 'u/x' });
    expect(r.comments[0].depth).toBe(0);
  });

  it('a paragraph edit never mutates the INPUT post.body (direct non-mutation assert)', () => {
    const original = post.body;
    applyThreadEdits(post, comments, { paras: { 0: 'replaced' } });
    expect(post.body).toBe(original);
  });

  it('DRIFT ANCHOR: an override whose recorded original no longer matches is SKIPPED and reported', () => {
    const r = applyThreadEdits(post, comments, {
      comments: { 0: 'reworded' }, commentOrig: { 0: 'a DIFFERENT original than what is here now' },
      paras: { 1: 'edited' }, paraOrig: { 1: 'not what para two says' },
    });
    expect(r.comments[0].body).toBe('first comment');      // NOT rewritten
    expect(splitParagraphs(r.post.body)[1]).toBe('Para two.');
    expect(r.skipped.sort()).toEqual(['comment 1', 'paragraph 2']);
  });

  it('DRIFT ANCHOR: applies normally when the recorded original still matches (whitespace-insensitive)', () => {
    const r = applyThreadEdits(post, comments, {
      comments: { 0: 'reworded' }, commentOrig: { 0: '  first comment ' },
    });
    expect(r.comments[0].body).toBe('reworded');
    expect(r.skipped).toEqual([]);
  });

  it('LEGACY edits without anchors still apply by index (backward compatible)', () => {
    const r = applyThreadEdits(post, comments, { comments: { 1: 'reworded' } });
    expect(r.comments[1].body).toBe('reworded');
    expect(r.skipped).toEqual([]);
  });
});

describe('remapCommentEdits (content-anchored: match by original body onto any array)', () => {
  const raw = [
    { body: 'top A', depth: 0 },
    { body: 'reply to A', depth: 1 },     // interleaved reply — shifts raw indices
    { body: 'top B', depth: 0 },
  ];

  it('lands an override on the comment whose body matches its anchor, in a differently-interleaved array', () => {
    // edit authored elsewhere (slot key 0), anchored to "top B" — must land on raw index 2, not 0.
    const remapped = remapCommentEdits(raw, { comments: { 0: 'edited B' }, commentOrig: { 0: 'top B' } })!;
    expect(remapped.comments).toEqual({ 2: 'edited B' });
    expect(remapped.commentOrig).toEqual({ 2: 'top B' });
    const r = applyThreadEdits({ title: 't' }, raw, remapped);
    expect(r.comments[2].body).toBe('edited B');           // top B edited
    expect(r.comments[1].body).toBe('reply to A');         // the reply untouched
  });

  it('anchors a REPLY edit onto the reply by its body (replies are editable now)', () => {
    const remapped = remapCommentEdits(raw, { comments: { 3: 'edited reply' }, commentOrig: { 3: 'reply to A' } })!;
    expect(remapped.comments).toEqual({ 1: 'edited reply' });   // "reply to A" is at raw index 1
    expect(applyThreadEdits({ title: 't' }, raw, remapped).comments[1].body).toBe('edited reply');
  });

  it('the slot KEY is irrelevant — only the anchor body decides the target (kills a key-as-index mutant)', () => {
    const remapped = remapCommentEdits(raw, { comments: { 99: 'x' }, commentOrig: { 99: 'top A' } })!;
    expect(remapped.comments).toEqual({ 0: 'x' });   // key 99 → index 0 because "top A" is at index 0
  });

  it('drops an override whose anchor is absent from this array (removed / drifted); passes other fields through', () => {
    const remapped = remapCommentEdits(raw, { title: 'T', comments: { 0: 'ghost' }, commentOrig: { 0: 'no such body' } })!;
    expect(remapped.title).toBe('T');
    expect(remapped.comments).toEqual({});
  });

  it('two identical-body edits claim DISTINCT targets (never both collapse onto the first)', () => {
    const dup = [{ body: 'same', depth: 0 }, { body: 'same', depth: 0 }];
    const remapped = remapCommentEdits(dup, { comments: { 0: 'x', 1: 'y' }, commentOrig: { 0: 'same', 1: 'same' } })!;
    expect(remapped.comments).toEqual({ 0: 'x', 1: 'y' });   // both targets used, not {0} twice
  });

  it('undefined / comment-less edits pass through unchanged', () => {
    expect(remapCommentEdits(raw, undefined)).toBeUndefined();
    const e = { title: 'T' };
    expect(remapCommentEdits(raw, e)).toBe(e);
  });
});

describe('depth0IndexOf (full-tree index → depth-0 rank, for the reel’s SELECTION storage)', () => {
  // No longer part of the edit-keying path (edits are content-anchored) — still used to store the picked
  // comment selection on the reel in depth-0 space for the flyout to restore.
  const raw = [
    { body: 'top A', depth: 0 },     // full 0 → depth-0 rank 0
    { body: 'reply', depth: 1 },     // full 1 → null (not top-level)
    { body: 'top B', depth: 0 },     // full 2 → depth-0 rank 1
    { body: 'top C', depth: 0 },     // full 3 → depth-0 rank 2
  ];
  it('maps each top-level comment to its depth-0 rank', () => {
    expect(depth0IndexOf(raw, 0)).toBe(0);
    expect(depth0IndexOf(raw, 2)).toBe(1);
    expect(depth0IndexOf(raw, 3)).toBe(2);
  });
  it('returns null for a reply (replies have no depth-0 rank)', () => {
    expect(depth0IndexOf(raw, 1)).toBeNull();
  });
  it('is identity on a reply-free tree (the common case)', () => {
    const flat = [{ depth: 0 }, { depth: 0 }, { depth: 0 }];
    expect([0, 1, 2].map(i => depth0IndexOf(flat, i))).toEqual([0, 1, 2]);
  });
});

describe('writeCommentEdit / readCommentEdit (content-anchored round-trip)', () => {
  // reply-heavy tree: full idx 0 = C0(d0), 1 = R1(d1 reply), 2 = C2(d0).
  const comments = [{ body: 'C0', depth: 0 }, { body: 'R1', depth: 1 }, { body: 'C2', depth: 0 }];

  it('THE mutant-killer: the edit is tagged with the comment BODY (anchor), not a positional key', () => {
    const e = writeCommentEdit(comments, 2, 'C2 edited', {});
    // key is just a free slot; what matters is the anchor body 'C2'. A mutant keying by depth/position would
    // record a different anchor (or drop replies) — this asserts the anchor is the comment's own body.
    expect(Object.values(e.commentOrig!)).toEqual(['C2']);
    expect(Object.values(e.comments!)).toEqual(['C2 edited']);
    expect(readCommentEdit(comments, 2, e)).toEqual({ text: 'C2 edited', edited: true });
  });

  it('read reflects the edit on full idx 2 and NOT on the untouched reply / comment', () => {
    const e = writeCommentEdit(comments, 2, 'C2 edited', {});
    expect(readCommentEdit(comments, 2, e)).toEqual({ text: 'C2 edited', edited: true });
    expect(readCommentEdit(comments, 1, e)).toEqual({ text: 'R1', edited: false });   // untouched reply
    expect(readCommentEdit(comments, 0, e)).toEqual({ text: 'C0', edited: false });
  });

  it('round-trips through remapCommentEdits → applyThreadEdits onto the RIGHT full comment', () => {
    const e = writeCommentEdit(comments, 2, 'C2 edited', {});
    const applied = applyThreadEdits({ title: 't' }, comments, remapCommentEdits(comments, e));
    expect(applied.comments[2].body).toBe('C2 edited');   // C2 rewritten
    expect(applied.comments[1].body).toBe('R1');           // reply untouched
    expect(applied.comments[0].body).toBe('C0');
  });

  it('a REPLY (depth>0) IS now editable — it gets a content-anchored slot and feeds through', () => {
    const e = writeCommentEdit(comments, 1, 'edited reply', {});   // full idx 1 = R1, a reply
    expect(Object.values(e.commentOrig!)).toEqual(['R1']);
    expect(readCommentEdit(comments, 1, e)).toEqual({ text: 'edited reply', edited: true });
    const applied = applyThreadEdits({ title: 't' }, comments, remapCommentEdits(comments, e));
    expect(applied.comments.map(c => c.body)).toEqual(['C0', 'edited reply', 'C2']);
  });

  it('a reply edit and a top-level edit coexist and land on the right comments', () => {
    let e = writeCommentEdit(comments, 2, 'C2 edited', {});   // top-level
    e = writeCommentEdit(comments, 1, 'R1 edited', e);        // reply
    const applied = applyThreadEdits({ title: 't' }, comments, remapCommentEdits(comments, e));
    expect(applied.comments.map(c => c.body)).toEqual(['C0', 'R1 edited', 'C2 edited']);
  });

  it('an edit survives onto a DIFFERENTLY-interleaved re-import (matched by content, not index)', () => {
    const e = writeCommentEdit(comments, 2, 'C2 edited', {});   // authored against the full tree
    // the copy path re-imports and gets a raw array where C2 sits at a different index
    const reimport = [{ body: 'C0' }, { body: 'C2' }, { body: 'R1' }, { body: 'other reply' }];
    const applied = applyThreadEdits({ title: 't' }, reimport, remapCommentEdits(reimport, e));
    expect(applied.comments[1].body).toBe('C2 edited');   // matched by body wherever C2 landed
    expect(applied.comments[0].body).toBe('C0');
  });

  it('blank or original-matching value clears the override + its anchor', () => {
    const e = writeCommentEdit(comments, 2, 'C2 edited', {});
    expect(writeCommentEdit(comments, 2, '   ', e)).toEqual({});    // blank clears
    expect(writeCommentEdit(comments, 2, 'C2', e)).toEqual({});     // back to original clears
  });

  it('re-editing the same comment reuses its slot (no duplicate slot piles up)', () => {
    let e = writeCommentEdit(comments, 2, 'first', {});
    e = writeCommentEdit(comments, 2, 'second', e);
    expect(Object.keys(e.comments!)).toHaveLength(1);
    expect(Object.values(e.comments!)).toEqual(['second']);
    expect(readCommentEdit(comments, 2, e).text).toBe('second');
  });

  it('preserves unrelated edits (title, paras, other comments) untouched', () => {
    const prev = { title: 'T', paras: { 0: 'p' }, comments: { 0: 'c0 edit' }, commentOrig: { 0: 'C0' } };
    const e = writeCommentEdit(comments, 2, 'C2 edited', prev);
    expect(e.title).toBe('T');
    expect(e.paras).toEqual({ 0: 'p' });
    expect(e.comments).toEqual({ 0: 'c0 edit', 2: 'C2 edited' });   // slot keyed by the comment's own index (2)
  });

  // ── Identical-body comments must stay DISTINCT — driven END-TO-END through writeCommentEdit (the earlier
  //    remap-only tests couldn't catch a write that collapses two same-body comments into one slot). ──
  describe('byte-identical duplicate bodies (e.g. two "lol" comments)', () => {
    const dup = [{ body: 'lol', depth: 0 }, { body: 'lol', depth: 0 }];

    it('editing each duplicate independently keeps BOTH edits, on the RIGHT comment', () => {
      let e = writeCommentEdit(dup, 0, 'first', {});
      e = writeCommentEdit(dup, 1, 'second', e);
      expect(readCommentEdit(dup, 0, e)).toEqual({ text: 'first', edited: true });
      expect(readCommentEdit(dup, 1, e)).toEqual({ text: 'second', edited: true });
      const applied = applyThreadEdits({ title: 't' }, dup, remapCommentEdits(dup, e));
      expect(applied.comments.map(c => c.body)).toEqual(['first', 'second']);   // NOT ['second','lol'] or ['first','first']
    });

    it('editing only ONE duplicate leaves the OTHER un-edited (no false badge, no wrong-comment feed)', () => {
      const e = writeCommentEdit(dup, 1, 'only the second', {});
      expect(readCommentEdit(dup, 0, e)).toEqual({ text: 'lol', edited: false });   // untouched twin stays original
      expect(readCommentEdit(dup, 1, e)).toEqual({ text: 'only the second', edited: true });
      const applied = applyThreadEdits({ title: 't' }, dup, remapCommentEdits(dup, e));
      expect(applied.comments.map(c => c.body)).toEqual(['lol', 'only the second']);   // idx0 untouched, idx1 edited
    });

    it('a duplicate top-level comment and a duplicate reply are edited independently', () => {
      // full tree: idx0 C(d0 "same"), idx1 R(d1 reply "same"), idx2 C(d0 "other")
      const tree = [{ body: 'same', depth: 0 }, { body: 'same', depth: 1 }, { body: 'other', depth: 0 }];
      let e = writeCommentEdit(tree, 0, 'top edited', {});
      e = writeCommentEdit(tree, 1, 'reply edited', e);
      const applied = applyThreadEdits({ title: 't' }, tree, remapCommentEdits(tree, e));
      expect(applied.comments.map(c => c.body)).toEqual(['top edited', 'reply edited', 'other']);
    });

    it('a STALE slot at the edited index + duplicates: the edit lands on the comment we edited, not a twin', () => {
      // Regression: an edit authored on an earlier import (slot 0 anchored to now-absent 'P') then a re-import
      // whose index 0/1 are identical 'lol'. Editing idx0 must NOT get rebound to idx1 by the exact-position pass.
      let e = writeCommentEdit([{ body: 'P' }], 0, 'Ped', {});   // stale slot {comments:{0:'Ped'},commentOrig:{0:'P'}}
      const reimport = [{ body: 'lol' }, { body: 'lol' }];
      e = writeCommentEdit(reimport, 0, 'first', e);             // guard fires; fallback slot must be >= 2
      expect(readCommentEdit(reimport, 0, e)).toEqual({ text: 'first', edited: true });   // the one we edited
      expect(readCommentEdit(reimport, 1, e)).toEqual({ text: 'lol', edited: false });    // the twin untouched
      const applied = applyThreadEdits({ title: 't' }, reimport, remapCommentEdits(reimport, e));
      expect(applied.comments.map(c => c.body)).toEqual(['first', 'lol']);
      // and a second edit of the twin still lands correctly
      e = writeCommentEdit(reimport, 1, 'second', e);
      const applied2 = applyThreadEdits({ title: 't' }, reimport, remapCommentEdits(reimport, e));
      expect(applied2.comments.map(c => c.body)).toEqual(['first', 'second']);
    });
  });
});

describe('splitParagraphs (the canonical splitter both pick-lists and edits key off)', () => {
  it('splits on blank lines, trims, drops empties', () => {
    expect(splitParagraphs('a\n\n  b  \n\n\n\nc')).toEqual(['a', 'b', 'c']);
    expect(splitParagraphs('')).toEqual([]);
    expect(splitParagraphs(undefined)).toEqual([]);
  });
  it('keeps single newlines inside one paragraph', () => {
    expect(splitParagraphs('line1\nline2\n\nnext')).toEqual(['line1\nline2', 'next']);
  });
});

describe('assembleScriptItems (the Preview = what-gets-fed)', () => {
  // reply-heavy thread: comment full idx 0 = C0(d0), 1 = R1(d1 reply of C0), 2 = C2(d0).
  const base = {
    post: { title: 'The title', body: 'para A\n\npara B\n\npara C' },
    comments: [
      { body: 'C0', depth: 0, user: { name: 'u/alice' }, isOP: true },
      { body: 'R1', depth: 1, user: { name: 'u/bob' } },
      { body: 'C2', depth: 0, user: { name: 'u/carol' } },
    ],
  };

  it('FEED ORDER: title, then SELECTED paragraphs (ascending), then SELECTED comments (ascending)', () => {
    const items = assembleScriptItems({ ...base, selectedParas: [2, 0], selectedComments: [2, 0], edits: {} });
    expect(items.map(i => [i.kind, i.idx])).toEqual([['t', 0], ['p', 0], ['p', 2], ['c', 0], ['c', 2]]);
    expect(items.map(i => i.text)).toEqual(['The title', 'para A', 'para C', 'C0', 'C2']);
    expect(items.map(i => i.edited)).toEqual([false, false, false, false, false]);   // nothing edited → all false (kills a constant-true mutant)
  });

  it('includes ONLY selected paras/comments; title is always present', () => {
    const items = assembleScriptItems({ ...base, selectedParas: [], selectedComments: [], edits: {} });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 't', text: 'The title', edited: false });
  });

  it('applies edits (title / paragraph / comment) to the emitted text + edited flag', () => {
    const items = assembleScriptItems({
      ...base, selectedParas: [1], selectedComments: [2],
      edits: { title: 'New title', paras: { 1: 'edited B' }, comments: { 1: 'edited C2' }, commentOrig: { 1: 'C2' } },
    });
    // comment edit is keyed in DEPTH-0 space: rank 1 == full idx 2 (C2).
    expect(items.find(i => i.kind === 't')).toMatchObject({ text: 'New title', edited: true });
    expect(items.find(i => i.kind === 'p')).toMatchObject({ text: 'edited B', edited: true });
    expect(items.find(i => i.kind === 'c')).toMatchObject({ text: 'edited C2', edited: true });
  });

  it('a whitespace-only title edit is NOT treated as an edit (matches what applyThreadEdits feeds)', () => {
    const items = assembleScriptItems({ ...base, selectedParas: [], selectedComments: [], edits: { title: '   ' } });
    expect(items[0]).toMatchObject({ kind: 't', text: 'The title', edited: false });
  });

  it('FAITHFULNESS: preview text == what applyThreadEdits actually feeds, incl. a drift-SKIPPED comment edit', () => {
    // A stale anchor (commentOrig no longer matches the current comment) must be SKIPPED — the card feeds
    // the original, and the preview must show the same (not the stale override).
    const edits = { comments: { 1: 'stale rewrite' }, commentOrig: { 1: 'a DIFFERENT original' } };
    const items = assembleScriptItems({ ...base, selectedParas: [], selectedComments: [2], edits });
    const fed = applyThreadEdits(base.post, base.comments, remapCommentEdits(base.comments, edits));
    expect(items.find(i => i.kind === 'c')!.text).toBe(fed.comments[2].body);   // both = original 'C2'
    expect(items.find(i => i.kind === 'c')).toMatchObject({ text: 'C2', edited: false });
  });

  it('a selected REPLY is now EDITABLE too (content-anchored, not depth-gated)', () => {
    const items = assembleScriptItems({ ...base, selectedParas: [], selectedComments: [0, 1, 2], edits: {} });
    const cs = items.filter(i => i.kind === 'c');
    expect(cs.map(i => [i.idx, i.editable, i.text])).toEqual([[0, true, 'C0'], [1, true, 'R1'], [2, true, 'C2']]);
    expect(cs.map(i => i.label)).toEqual(['u/alice · OP', 'u/bob · reply', 'u/carol']);
  });

  it('a REPLY edit shows in the preview (edited text + flag), matched by content anchor', () => {
    const edits = writeCommentEdit(base.comments, 1, 'R1 edited', {});   // edit the reply (full idx 1)
    const items = assembleScriptItems({ ...base, selectedParas: [], selectedComments: [1], edits });
    expect(items.find(i => i.kind === 'c')).toMatchObject({ idx: 1, text: 'R1 edited', edited: true, editable: true });
  });

  it('paragraph labels number only when more than one is selected', () => {
    const one = assembleScriptItems({ ...base, selectedParas: [1], selectedComments: [], edits: {} });
    expect(one.find(i => i.kind === 'p')!.label).toBe('Post');
    const many = assembleScriptItems({ ...base, selectedParas: [0, 2], selectedComments: [], edits: {} });
    expect(many.filter(i => i.kind === 'p').map(i => i.label)).toEqual(['Post · ¶1', 'Post · ¶2']);
  });

  it('ignores an out-of-range selected paragraph OR comment index (a re-imported thread can shrink)', () => {
    const items = assembleScriptItems({ ...base, selectedParas: [0, 99], selectedComments: [1, 42], edits: {} });
    expect(items.filter(i => i.kind === 'p').map(i => i.idx)).toEqual([0]);
    expect(items.filter(i => i.kind === 'c').map(i => i.idx)).toEqual([1]);   // 42 has no comment → dropped
  });
});

describe('writeFieldEdit (title / paragraph write — normalise, clear-on-match, anchor)', () => {
  it('title: stores the normalised (newline-collapsed) value', () => {
    expect(writeFieldEdit('t', 'Original', 'New\ntitle', 0, {}).title).toBe('New title');
  });
  it('title: typed back to the original (even with textarea newlines) clears the override', () => {
    expect(writeFieldEdit('t', 'Original title', 'Original\ntitle', 0, { title: 'x' })).toEqual({});
  });
  it('title: blank/whitespace clears', () => {
    expect(writeFieldEdit('t', 'Original', '   ', 0, { title: 'x' })).toEqual({});
  });
  it('paragraph: collapses an internal blank line (can’t split into two paragraphs) + records the anchor', () => {
    const r = writeFieldEdit('p', 'orig para', 'part a\n\npart b', 1, {});
    expect(r.paras).toEqual({ 1: 'part a\npart b' });
    expect(r.paraOrig).toEqual({ 1: 'orig para' });
  });
  it('paragraph: typed back to original (with a blank line) clears via the collapse compare', () => {
    const r = writeFieldEdit('p', 'line1\nline2', 'line1\n\nline2', 0, { paras: { 0: 'x' }, paraOrig: { 0: 'y' } });
    expect(r.paras).toBeUndefined();
    expect(r.paraOrig).toBeUndefined();
  });
  it('removing the last paragraph override prunes the paras + paraOrig containers', () => {
    const r = writeFieldEdit('p', 'orig', '', 2, { paras: { 2: 'x' }, paraOrig: { 2: 'orig' }, title: 'keep' });
    expect(r.paras).toBeUndefined();
    expect(r.paraOrig).toBeUndefined();
    expect(r.title).toBe('keep');   // unrelated overrides preserved
  });
});

describe('hasThreadEdits', () => {
  it('false for absent/empty/whitespace-only edit sets', () => {
    expect(hasThreadEdits(undefined)).toBe(false);
    expect(hasThreadEdits({})).toBe(false);
    expect(hasThreadEdits({ title: ' ', paras: { 0: '' } })).toBe(false);
  });
  it('true when any usable override exists — each kind independently', () => {
    expect(hasThreadEdits({ comments: { 3: 'x' } })).toBe(true);
    expect(hasThreadEdits({ title: 'T' })).toBe(true);
    expect(hasThreadEdits({ paras: { 0: 'p' } })).toBe(true);
  });
});
