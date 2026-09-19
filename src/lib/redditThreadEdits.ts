import type { RedditThreadEdits } from '@/app/components/TikTokCanvas/types';

// Pure application of a user's Reddit-thread text edits (Pick-stage tweaks) — used by the card render
// path AND the YouTube-copy paths, so one edit propagates to the card, the narration (via the card's
// ocrLines) and the description. Unit-tested.

/** THE canonical paragraph splitter — the same function derives the pickable paragraph list and the
    edit indices, so they can never drift. (Blank-line separated, trimmed, empties dropped.) */
export const splitParagraphs = (body?: string): string[] =>
  (typeof body === 'string' ? body : '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

const usable = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;

// ── Content-anchored comment editing ────────────────────────────────────────────────────────────────
// A comment edit is stored in a per-thread slot: edits.comments[key] = the edited text, edits.commentOrig[key]
// = the ORIGINAL body captured at edit time. The key is just a unique slot id — edits are matched to comments
// by their ORIGINAL BODY (commentOrig), never by position. That makes one edit land on the right comment in
// ANY array (the full tree, a depth-0-filtered flyout list, or a re-imported raw listing — which interleave
// replies differently), and it makes REPLIES editable: a reply has no depth-0 rank but it does have a body.
// (Existing depth-0-rank-keyed edits keep working — the numeric key is ignored; only commentOrig is read.)
const anchorEq = (a: string | undefined, b: string | undefined): boolean => (a ?? '').trim() === (b ?? '').trim();

/** The slot key whose recorded original body matches `body`, or null. */
function commentSlotForBody(edits: RedditThreadEdits | undefined, body: string): number | null {
  const orig = edits?.commentOrig;
  if (!orig) return null;
  for (const k of Object.keys(orig)) if (anchorEq(orig[Number(k)], body)) return Number(k);
  return null;
}

/** Smallest integer >= `min` not already used as a comment slot key. Callers that need a purely
    content-anchored slot pass min = comments.length so the key can't coincide with any comment INDEX — else
    remap's exact-position pass could rebind it to a same-body comment at that index (a duplicate twin). */
function freeCommentSlot(edits: RedditThreadEdits, min = 0): number {
  const used = new Set([...Object.keys(edits.comments ?? {}), ...Object.keys(edits.commentOrig ?? {})].map(Number));
  let k = Math.max(0, min);
  while (used.has(k)) k++;
  return k;
}

/** Re-key comment edits onto positions in an arbitrary `comments` array so applyThreadEdits (which applies
    by index) lands each override on the comment it was authored from — in any array (bulk full tree, flyout
    depth-0 list, re-imported raw listing). TWO passes so identical-body comments never collapse:
      1. EXACT position — an edit slot keyed by a comment's own index maps back to that index when the body
         still matches (the same-array fast path: byte-identical duplicates stay distinct because each has its
         own slot key = its own index).
      2. CONTENT match — anything left (a different / re-imported array where indices shifted) claims the first
         unclaimed comment whose body matches the anchor; identical-body edits are consumed in slot order.
    An edit whose original body is absent from this array (removed / drifted) is dropped. */
export function remapCommentEdits<C extends { body?: string }>(
  comments: C[],
  edits: RedditThreadEdits | undefined,
): RedditThreadEdits | undefined {
  if (!edits?.comments && !edits?.commentOrig) return edits;
  const outComments: Record<number, string> = {};
  const outOrig: Record<number, string> = {};
  const origMap = edits.commentOrig ?? {};
  const slots = Object.keys(origMap).map(Number).sort((a, b) => a - b);
  const claimed = new Set<number>();
  const put = (slot: number, target: number) => {
    claimed.add(target);
    outOrig[target] = origMap[slot];
    const t = edits.comments?.[slot];
    if (t !== undefined) outComments[target] = t;
  };
  const pending: number[] = [];
  for (const slot of slots) {
    if (typeof origMap[slot] !== 'string') continue;
    if (!claimed.has(slot) && anchorEq(comments[slot]?.body, origMap[slot])) put(slot, slot);   // pass 1: exact
    else pending.push(slot);
  }
  for (const slot of pending) {                                                                   // pass 2: content
    const body = origMap[slot];
    let j = -1;
    for (let i = 0; i < comments.length; i++) if (!claimed.has(i) && anchorEq(comments[i]?.body, body)) { j = i; break; }
    if (j >= 0) put(slot, j);
  }
  return { ...edits, comments: outComments, commentOrig: outOrig };
}

/** The DEPTH-0 rank (0-based) of the comment at full-array index `fullIdx`, or null if that comment is
    not top-level. The inverse of remapCommentEdits' depth-0→full mapping: the bulk builder picks in
    full-tree index space but must KEY edits in the shared depth-0 space, so it maps each editable
    (top-level) comment's full index to its depth-0 rank. Identity when the tree has no replies. */
export function depth0IndexOf(comments: { depth?: number }[], fullIdx: number): number | null {
  if ((comments[fullIdx]?.depth ?? 0) !== 0) return null;
  let k = 0;
  for (let i = 0; i < fullIdx; i++) if ((comments[i]?.depth ?? 0) === 0) k++;
  return k;
}

/** One line of the assembled narration script (Preview). Order mirrors what the card/narration feed:
    the title, then each SELECTED paragraph (ascending), then each SELECTED comment (ascending full-tree
    index). `text` is the edited-or-original value. Every field is `editable` — comments (top-level AND
    replies) key by content anchor, not depth. */
export interface ScriptItem {
  kind: 't' | 'p' | 'c';
  idx: number;            // 0 for title · paragraph index · full-tree comment index
  label: string;
  text: string;
  edited: boolean;
  editable: boolean;
}

export function assembleScriptItems(thread: {
  post: { title: string; body?: string };
  comments: { body: string; depth?: number; user?: { name?: string }; isOP?: boolean }[];
  selectedParas: Iterable<number>;
  selectedComments: Iterable<number>;
  edits: RedditThreadEdits;
}): ScriptItem[] {
  const { post, comments, edits } = thread;
  const selP = new Set(thread.selectedParas);
  const selC = new Set(thread.selectedComments);
  // Resolve edits through the SAME path the card/narration actually feed — applyThreadEdits over the
  // depth-0→full-remapped edits — so the Preview can never diverge from what's fed: title newline
  // collapse, paragraph blank-line collapse, and drift-SKIPPED edits (stale anchor → original text) all
  // match the built reel. `edited` = the fed text differs from the original (a skipped edit reads false).
  const eff = applyThreadEdits(post, comments, remapCommentEdits(comments, edits));
  const origParas = splitParagraphs(post.body);
  const effParas = splitParagraphs(eff.post.body);
  const items: ScriptItem[] = [];

  items.push({ kind: 't', idx: 0, label: 'Title', text: eff.post.title, edited: eff.post.title !== post.title, editable: true });

  const selParaIdx = origParas.map((_, i) => i).filter(i => selP.has(i));   // existing + selected, in order
  selParaIdx.forEach((i, n) => {
    const text = effParas[i] ?? origParas[i];
    items.push({ kind: 'p', idx: i, label: selParaIdx.length > 1 ? `Post · ¶${n + 1}` : 'Post', text, edited: text !== origParas[i], editable: true });
  });

  comments.forEach((c, i) => {
    if (!selC.has(i)) return;
    const isReply = (c.depth ?? 0) > 0;
    const text = eff.comments[i]?.body ?? c.body;
    const name = c.user?.name ?? '';
    items.push({ kind: 'c', idx: i, label: `${name}${c.isOP ? ' · OP' : ''}${isReply ? ' · reply' : ''}`, text, edited: text !== c.body, editable: true });
  });

  return items;
}

/** WRITE a title or paragraph edit (index-keyed) — the non-comment counterpart of writeCommentEdit.
    Normalises (title: collapse newlines to spaces; paragraph: collapse blank lines so a re-split can't
    change the paragraph count), clears the override when the normalised value equals the original, and
    records the paraOrig drift anchor. Storing the NORMALISED value keeps the override canonical, so
    every surface (Preview, reading box, card) shows the same text. Pure. */
export function writeFieldEdit(
  kind: 't' | 'p',
  orig: string,
  value: string,
  idx: number,
  prev: RedditThreadEdits,
): RedditThreadEdits {
  const val = value.trim();
  if (kind === 't') {
    const norm = val.replace(/\s*\n+\s*/g, ' ');
    const next = { ...prev };
    if (!norm || norm === orig) delete next.title; else next.title = norm;
    return next;
  }
  const norm = val.replace(/\n\s*\n/g, '\n');
  const next: RedditThreadEdits = { ...prev, paras: { ...prev.paras }, paraOrig: { ...prev.paraOrig } };
  if (!norm || norm === orig) { delete next.paras![idx]; delete next.paraOrig![idx]; }
  else { next.paras![idx] = norm; next.paraOrig![idx] = orig; }
  if (!Object.keys(next.paras!).length) delete next.paras;
  if (!Object.keys(next.paraOrig!).length) delete next.paraOrig;
  return next;
}

/** WRITE a comment text edit for the comment at `fullIdx`. The override slot is keyed by the comment's OWN
    index (so byte-identical duplicate bodies never collapse into one slot) and tagged with its original body
    (commentOrig) as the drift/cross-array anchor. Works for replies too (any fullIdx). Re-editing the same
    comment reuses its slot; a blank or back-to-original value clears it. Guard: if slot `fullIdx` is already
    owned by a DIFFERENT comment (edits authored on another array/surface of the same reel share this keyspace),
    fall back to this comment's existing body-slot or a fresh one, so an unrelated edit is never clobbered. */
export function writeCommentEdit(
  comments: { body: string }[],
  fullIdx: number,
  value: string,
  prev: RedditThreadEdits,
): RedditThreadEdits {
  const orig = comments[fullIdx]?.body ?? '';
  if (!orig) return prev;   // nothing to anchor the edit against
  const val = value.trim();
  let key = fullIdx;
  if (prev.commentOrig?.[key] != null && !anchorEq(prev.commentOrig[key], orig)) {
    // Slot `fullIdx` belongs to a different comment (a stale slot from another array/surface). Reuse this
    // comment's existing body-slot if any, else a content-only slot ABOVE every comment index, so remap's
    // exact-position pass can't rebind it to a same-body twin sitting at that index.
    key = commentSlotForBody(prev, orig) ?? freeCommentSlot(prev, comments.length);
  }
  const next: RedditThreadEdits = { ...prev, comments: { ...prev.comments }, commentOrig: { ...prev.commentOrig } };
  if (!val || val === orig.trim()) { delete next.comments![key]; delete next.commentOrig![key]; }
  else { next.comments![key] = val; next.commentOrig![key] = orig; }
  if (!Object.keys(next.comments!).length) delete next.comments;
  if (!Object.keys(next.commentOrig!).length) delete next.commentOrig;
  return next;
}

/** READ the effective (edited-or-original) comment body + edited flag for the comment at `fullIdx`. Resolves
    through the SAME two-pass remap the feed uses, so read == what actually gets applied — identical-body
    comments stay distinct, and an edit whose anchor no longer matches this comment reads as un-edited. */
export function readCommentEdit(
  comments: { body: string }[],
  fullIdx: number,
  edits: RedditThreadEdits | undefined,
): { text: string; edited: boolean } {
  const remapped = remapCommentEdits(comments, edits);
  const e = remapped?.comments?.[fullIdx];
  const edited = !!e?.trim();
  return { text: edited ? e! : (comments[fullIdx]?.body ?? ''), edited };
}

/** Apply edits to an imported thread, returning edited COPIES (inputs untouched) + the labels of any
    SKIPPED overrides (drift guard — surface these, never hide them).
    - Empty/whitespace overrides are ignored (deselection deletes; an empty edit means "revert").
    - Out-of-range indices are ignored (a re-imported thread can shrink).
    - CONTENT ANCHOR: when an edit carries its original text (paraOrig/commentOrig) and the item at that
      index no longer matches, the override is SKIPPED (Reddit content drifted — rewriting whatever now
      sits at the index would corrupt the wrong item). Legacy edits without an anchor apply by index.
    - A title edit collapses newlines (titles are single-line).
    - A paragraph edit collapses internal blank lines — a blank line would SPLIT it into two paragraphs
      on the next import round-trip and shift every later index. */
export function applyThreadEdits<P extends { title: string; body?: string }, C extends { body: string }>(
  post: P,
  comments: C[],
  edits: RedditThreadEdits | undefined,
): { post: P; comments: C[]; skipped: string[] } {
  if (!edits) return { post, comments, skipped: [] };
  const skipped: string[] = [];
  const anchored = (orig: string | undefined, current: string): boolean =>
    orig === undefined || orig.trim() === current.trim();

  let p = post;
  if (usable(edits.title)) p = { ...p, title: edits.title.replace(/\s*\n+\s*/g, ' ').trim() };

  const paraEdits = edits.paras ?? {};
  if (Object.keys(paraEdits).length && p.body) {
    const paras = splitParagraphs(p.body);
    let changed = false;
    const next = paras.map((orig, i) => {
      const e = paraEdits[i];
      if (!usable(e)) return orig;
      if (!anchored(edits.paraOrig?.[i], orig)) { skipped.push(`paragraph ${i + 1}`); return orig; }
      changed = true;
      return e.replace(/\n\s*\n/g, '\n').trim();   // keep single newlines, forbid paragraph splits
    });
    if (changed) p = { ...p, body: next.join('\n\n') };
  }

  const commentEdits = edits.comments ?? {};
  const cs = Object.keys(commentEdits).length
    ? comments.map((c, i) => {
        if (!usable(commentEdits[i])) return c;
        if (!anchored(edits.commentOrig?.[i], c.body)) { skipped.push(`comment ${i + 1}`); return c; }
        return { ...c, body: commentEdits[i].trim() };
      })
    : comments;

  return { post: p, comments: cs, skipped };
}

/** True when `edits` contains at least one usable override — drives the "edited" indicators. */
export function hasThreadEdits(edits: RedditThreadEdits | undefined): boolean {
  if (!edits) return false;
  if (usable(edits.title)) return true;
  return Object.values(edits.paras ?? {}).some(usable) || Object.values(edits.comments ?? {}).some(usable);
}
