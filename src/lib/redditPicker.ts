import type { RedditThreadEdits } from '@/app/components/TikTokCanvas/types';
import { readCommentEdit, type ScriptItem } from './redditThreadEdits';

// Pure logic behind the ONE Reddit thread picker (components/RedditThreadPicker.tsx), which both hosts
// render: the canvas rail flyout (one thread → the selected reel) and the pipeline's bulk builder (many
// threads → a reel each). Everything decidable lives HERE rather than in the component — comment
// grouping, paging, selection, which item the reading pane shows, the effective (edited) text, the length
// estimate, what "Clean text" would rewrite, undo/redo algebra — so the two hosts cannot drift and the
// rules are unit-tested with no DOM.

/** The imported thread shapes (/api/reddit's response). They live in lib, not in a component, because the
    picker, both hosts and the card/copy paths all speak them — a component-owned type would make the lib
    depend on its consumer. */
export interface ImportedRedditPost {
  user: { name: string; avatar?: string };
  timeAgo?: string; title: string; body?: string; score?: string; commentCount?: string;
  /** The post's image, inlined by /api/reddit as a data URI (see redditPostImage / redditCard: the
      canvas renderer must never touch cross-origin bytes). Rides on the post exactly like an avatar,
      but it is ~100KB rather than ~2KB — which is why the bulk builder strips it before persisting
      (serializeThreads) instead of spending a localStorage quota on it. */
  image?: string;
}
export interface ImportedRedditComment {
  user: { name: string; avatar?: string };
  body: string; timeAgo?: string; score?: string; depth: number; isOP?: boolean;
}

/** One thread as the picker sees it. `comments` is in IMPORT order (each top-level comment immediately
    followed by its replies) and every index in `selectedComments` / edits is an index into THAT array —
    each host owns the translation to/from whatever index space it persists. */
export interface PickableThread {
  post: ImportedRedditPost;
  comments: ImportedRedditComment[];
  paragraphs: string[];
  selectedComments: Set<number>;
  selectedParas: Set<number>;
  edits: RedditThreadEdits;
}

// ── Comment grouping + paging ───────────────────────────────────────────────────────────────────────

/** A top-level comment with its direct replies, as ARRAY INDICES (the picker looks the bodies up itself,
    so grouping stays independent of the comment shape). */
export interface CommentGroup { top: number; replies: number[] }

/** Group the flat import into one entry per top-level comment. A reply (depth > 0) joins the group above
    it; a reply that arrives with no top-level comment before it (a truncated import) becomes its own group
    rather than being dropped — an unreachable comment would be invisible AND unpickable. */
export function groupComments(comments: { depth?: number }[]): CommentGroup[] {
  const groups: CommentGroup[] = [];
  comments.forEach((c, idx) => {
    const last = groups[groups.length - 1];
    if ((c.depth ?? 0) === 0 || !last) groups.push({ top: idx, replies: [] });
    else last.replies.push(idx);
  });
  return groups;
}

/** The "load more" state for a paged group list: how many groups are still hidden, how many the next click
    reveals, and the count to store. Never advances past the total, so the button can't linger. */
export function loadMore(total: number, shown: number, perPage: number): { remaining: number; count: number; nextShown: number } {
  const remaining = Math.max(0, total - shown);
  const count = Math.min(perPage, remaining);
  return { remaining, count, nextShown: shown + count };
}

/** Toggle one index in a selection, returning a NEW set — selections live in React state, so mutating the
    existing set would skip the re-render. */
export function toggleIndex(set: ReadonlySet<number>, idx: number): Set<number> {
  const next = new Set(set);
  if (next.has(idx)) next.delete(idx); else next.add(idx);
  return next;
}

// ── Reading pane target ─────────────────────────────────────────────────────────────────────────────

export interface ReadTarget { kind: 'c' | 'p'; idx: number }

/** Which item the reading pane shows. While a comment/paragraph editor is open the pane is PINNED to that
    item — otherwise hovering a row in the list would swap the pane and silently unmount the open editor
    mid-edit, losing the draft. With nothing open it follows the hovered/clicked row, falling back to the
    first comment (then the first paragraph) so the pane is never blank on arrival. */
export function resolveReadTarget(opts: {
  editing: { kind: 't' | 'c' | 'p'; idx: number } | null;
  reading: ReadTarget | null;
  commentCount: number;
  paraCount: number;
}): ReadTarget | null {
  const { editing, reading, commentCount, paraCount } = opts;
  if (editing && (editing.kind === 'c' || editing.kind === 'p')) return { kind: editing.kind, idx: editing.idx };
  if (reading) return reading;
  if (commentCount > 0) return { kind: 'c', idx: 0 };
  if (paraCount > 0) return { kind: 'p', idx: 0 };
  return null;
}

// ── Effective (edited-or-original) text ─────────────────────────────────────────────────────────────
// A blank/whitespace override means "revert" everywhere (matching applyThreadEdits), so these read
// through the same rule the card and narration are fed.

export function effectiveTitle(t: Pick<PickableThread, 'post' | 'edits'>): string {
  return t.edits.title?.trim() ? t.edits.title : t.post.title;
}
export function effectivePara(t: Pick<PickableThread, 'paragraphs' | 'edits'>, idx: number): string {
  const e = t.edits.paras?.[idx];
  return (e?.trim() ? e : t.paragraphs[idx]) ?? '';
}
/** Comment overrides are content-anchored (they survive re-imports and differently-interleaved arrays), so
    they resolve through readCommentEdit rather than a plain index lookup. */
export function effectiveComment(t: Pick<PickableThread, 'comments' | 'edits'>, idx: number): string {
  return readCommentEdit(t.comments, idx, t.edits).text;
}
export function commentIsEdited(t: Pick<PickableThread, 'comments' | 'edits'>, idx: number): boolean {
  return readCommentEdit(t.comments, idx, t.edits).edited;
}

/** Everything this thread would narrate, as one string for estimateNarrationSeconds: the title plus each
    TICKED paragraph and comment, in their EDITED form — the warning has to match the reel that builds, not
    the raw import. Picks that no longer resolve (a re-imported thread shrank) are skipped. */
export function threadEstimateText(t: PickableThread): string {
  const parts = [effectiveTitle(t)];
  for (const pi of t.selectedParas) if (t.paragraphs[pi]) parts.push(effectivePara(t, pi));
  for (const ci of t.selectedComments) if (t.comments[ci]) parts.push(effectiveComment(t, ci));
  return parts.join(' ');
}

// ── "Clean text" ────────────────────────────────────────────────────────────────────────────────────

export interface FieldEdit { kind: 't' | 'p' | 'c'; idx: number; text: string }

/** The edits a "Clean text" pass would write: every EDITABLE script field whose cleaned form differs from
    what's there now. A field that cleans to nothing (a comment that is only a link) is left alone rather
    than emptied, and an unchanged field is skipped so a re-clean is a no-op — no edit, no undo step. */
export function cleanChanges(items: ScriptItem[], clean: (s: string) => string): FieldEdit[] {
  const out: FieldEdit[] = [];
  for (const it of items) {
    if (!it.editable) continue;
    const cleaned = clean(it.text);
    if (cleaned && cleaned !== it.text) out.push({ kind: it.kind, idx: it.idx, text: cleaned });
  }
  return out;
}

// ── Undo / redo ─────────────────────────────────────────────────────────────────────────────────────
// The picker snapshots whole RedditThreadEdits objects (the writers are pure and return new objects, so a
// reference IS a snapshot). The stack algebra is pure so the component only holds the two arrays.

export interface EditHistory<T> { past: T[]; future: T[] }
export const emptyHistory = <T,>(): EditHistory<T> => ({ past: [], future: [] });

/** Snapshot `current` before a mutation — one call per user action, so one "Clean text" is one undo step.
    A new edit invalidates the redo branch, and the stack is capped (oldest dropped) so a long session
    can't grow without bound. */
export function recordHistory<T>(h: EditHistory<T>, current: T, limit = 100): EditHistory<T> {
  const past = [...h.past, current];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [] };
}

/** Step back: the popped snapshot becomes the value to restore, the CURRENT value goes on the redo stack.
    With nothing to undo the history is returned untouched and `restored` is absent (never `undefined` as a
    value — an edits object is never undefined). */
export function undoHistory<T>(h: EditHistory<T>, current: T): { history: EditHistory<T>; restored?: T } {
  if (!h.past.length) return { history: h };
  return { history: { past: h.past.slice(0, -1), future: [...h.future, current] }, restored: h.past[h.past.length - 1] };
}

export function redoHistory<T>(h: EditHistory<T>, current: T): { history: EditHistory<T>; restored?: T } {
  if (!h.future.length) return { history: h };
  return { history: { past: [...h.past, current], future: h.future.slice(0, -1) }, restored: h.future[h.future.length - 1] };
}
