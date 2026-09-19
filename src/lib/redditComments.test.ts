import { describe, it, expect } from 'vitest';
import { selectComments, type RawCommentNode } from './redditComments';

// A comment node with an author + body, plus optional replies. Bodies double as the identity in asserts.
const c = (author: string, body: string, replies: RawCommentNode[] = []): RawCommentNode => ({
  kind: 't1', data: { author, body, replies: replies.length ? { data: { children: replies } } : '' },
});
const usable = (d: { author?: string; body?: string }) => !!d.author && d.author !== '[deleted]' && !!d.body && d.body !== '[removed]';
const OPTS = { maxComments: 50, repliesPerComment: 10 };
const ids = (out: { data: { body?: string }; depth: number }[]) => out.map(o => [o.data.body, o.depth]);

describe('selectComments — direct replies', () => {
  it('keeps ALL direct replies of a comment, in order, right after their parent', () => {
    const tree = [
      c('a', 'A', [c('a1', 'A-r1'), c('a2', 'A-r2'), c('a3', 'A-r3')]),
      c('b', 'B'),
    ];
    expect(ids(selectComments(tree, usable, OPTS))).toEqual([
      ['A', 0], ['A-r1', 1], ['A-r2', 1], ['A-r3', 1], ['B', 0],
    ]);
  });

  it('does NOT recurse into replies-of-replies (v1 = direct/depth-1 only)', () => {
    const tree = [c('a', 'A', [c('a1', 'A-r1', [c('a1a', 'deep')])])];
    expect(ids(selectComments(tree, usable, OPTS))).toEqual([['A', 0], ['A-r1', 1]]);   // 'deep' dropped
  });

  it('caps replies per comment (a popular comment can’t eat the budget)', () => {
    const replies = Array.from({ length: 15 }, (_, i) => c(`r${i}`, `r${i}`));
    const out = selectComments([c('a', 'A', replies)], usable, { maxComments: 50, repliesPerComment: 3 });
    expect(ids(out)).toEqual([['A', 0], ['r0', 1], ['r1', 1], ['r2', 1]]);   // only first 3 replies
  });

  it('respects the overall cap, counting replies toward it (and never a partial reply past it)', () => {
    const tree = [c('a', 'A', [c('a1', 'A-r1'), c('a2', 'A-r2')]), c('b', 'B'), c('d', 'D')];
    expect(ids(selectComments(tree, usable, { maxComments: 3, repliesPerComment: 10 })))
      .toEqual([['A', 0], ['A-r1', 1], ['A-r2', 1]]);   // stops at 3; B/D never reached
  });

  it('skips unusable (deleted/removed/bot) comments AND replies without miscounting the cap', () => {
    const tree = [
      c('a', 'A', [c('[deleted]', 'gone'), c('a2', 'A-r2')]),   // deleted reply skipped, A-r2 kept
      { kind: 'more', data: {} } as RawCommentNode,             // non-t1 skipped
      c('b', '[removed]'),                                      // removed top-level skipped
      c('e', 'E'),
    ];
    expect(ids(selectComments(tree, usable, OPTS))).toEqual([['A', 0], ['A-r2', 1], ['E', 0]]);
  });

  it('handles a comment with empty-string / missing replies field', () => {
    expect(ids(selectComments([c('a', 'A')], usable, OPTS))).toEqual([['A', 0]]);
    const noField: RawCommentNode = { kind: 't1', data: { author: 'x', body: 'X' } };
    expect(ids(selectComments([noField], usable, OPTS))).toEqual([['X', 0]]);
  });

  it('non-array / empty input → []', () => {
    expect(selectComments(undefined, usable, OPTS)).toEqual([]);
    expect(selectComments([], usable, OPTS)).toEqual([]);
  });

  // ── mutant-killers the review flagged (each exercises a branch the 7 above never reach) ──

  it('overall cap hit MID-replies of one parent stops before its later replies (inner cap break)', () => {
    const tree = [c('a', 'A', [c('r0', 'r0'), c('r1', 'r1'), c('r2', 'r2'), c('r3', 'r3')])];
    // A(1) + r0(2) + r1(3) hits maxComments=3 INSIDE the reply loop; r2/r3 dropped by the inner guard.
    expect(ids(selectComments(tree, usable, { maxComments: 3, repliesPerComment: 10 })))
      .toEqual([['A', 0], ['r0', 1], ['r1', 1]]);
  });

  it('skipped top-level comments do NOT consume the total cap', () => {
    const tree = [c('[deleted]', 'gone'), c('a', 'A'), c('b', 'B'), c('e', 'E')];
    expect(ids(selectComments(tree, usable, { maxComments: 2, repliesPerComment: 10 })))
      .toEqual([['A', 0], ['B', 0]]);   // the deleted node must not eat a budget slot
  });

  it('drops ALL replies of an UNUSABLE top-level parent (skipped before its reply loop; no promotion)', () => {
    // A deleted/removed parent with a good reply — common on Reddit. v1 intentionally drops the subtree
    // with its dead parent (promoting would render an orphaned depth-0 row). Freeze that decision.
    const tree = [c('[deleted]', '[removed]', [c('x', 'good-reply')]), c('e', 'E')];
    expect(ids(selectComments(tree, usable, OPTS))).toEqual([['E', 0]]);
  });

  it('skips a kind:"more" reply stub without counting it toward the per-comment cap', () => {
    const tree = [c('a', 'A', [{ kind: 'more', data: {} } as RawCommentNode, c('r1', 'r1')])];
    expect(ids(selectComments(tree, usable, OPTS))).toEqual([['A', 0], ['r1', 1]]);
  });
});
