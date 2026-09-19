// Reels for every style live in ONE saved grid, but a workspace only ever sees its own. This module is the
// only thing that knows the file holds more than one style: the persistence hook reads through `rowsForStyle`
// and writes back through `mergeStyleRows`, so a workspace never holds a reference to another style's reels.
//
// Everything here is about NOT LOSING A REEL. A bug in a filter makes a reel invisible, which is recoverable;
// a bug in the merge deletes someone's published Short, which is not. `mergeStyleRows` is therefore written
// to be total — every row it wasn't given authority over is passed through untouched.

/** Rows saved before reels carried a style tag are Reddit reels — that was the only style that existed. */
export const UNTAGGED_STYLE_ID = 'reddit';

/** The minimum shape this module needs. Deliberately structural so it works on SavedReel and on Framing maps. */
export interface StyleTagged {
  framing?: { styleId?: string } | null;
}

/**
 * Which style a saved row belongs to. Untagged rows resolve to Reddit — the one place that rule lives.
 *
 * Only a NON-EMPTY STRING counts as a tag, and the return is always a string. That isn't defensive noise:
 * this runs on rows straight out of JSON.parse, where `styleId` can be any type, while the workspace sees
 * those same rows AFTER normalisation (which drops a non-string styleId). If the two disagreed, a row could
 * be invisible to every workspace yet still excluded from the merge's pass-through set — so each save would
 * strand the stored copy and append a fresh one, duplicating the reel on screen and growing the file without
 * bound. Reading the tag identically on both sides of normalisation is what rules that out.
 */
export function styleOf(row: StyleTagged | null | undefined): string {
  const tag = row?.framing?.styleId;
  return typeof tag === 'string' && tag ? tag : UNTAGGED_STYLE_ID;
}

/**
 * The tag a row must be SAVED with, given its current framing and the workspace doing the saving.
 *
 * Distinct from `styleOf`, which answers "whose row is this already?" and so falls back to Reddit. Here an
 * untagged row is one this workspace is about to take ownership of, so it inherits the ACTIVE style —
 * defaulting to Reddit would orphan every reel born in any other workspace. The result is always a real tag,
 * which is what stops `mergeStyleRows` from dropping the row as foreign when it writes it back.
 */
export function styleTagForSave(framing: { styleId?: string } | null | undefined, activeStyleId: string): string {
  const tag = framing?.styleId;
  return typeof tag === 'string' && tag ? tag : activeStyleId;
}

/** Only the rows belonging to `styleId`, in their original order. */
export function rowsForStyle<T extends StyleTagged>(rows: readonly T[], styleId: string): T[] {
  return rows.filter(r => styleOf(r) === styleId);
}

/**
 * Put `next` back as the complete set of rows for `styleId`, leaving every other style's rows exactly as they
 * were. Rows of other styles keep their relative order and are never inspected beyond their tag — cross-style
 * ordering is meaningless because no view ever shows both.
 *
 * Note `next` is trusted as authoritative for its style: a row in `next` tagged as ANOTHER style would
 * otherwise let one workspace overwrite another's reel, so those are dropped rather than silently re-homed.
 */
export function mergeStyleRows<T extends StyleTagged>(
  all: readonly T[],
  styleId: string,
  next: readonly T[],
): T[] {
  const others = all.filter(r => styleOf(r) !== styleId);
  const mine = next.filter(r => styleOf(r) === styleId);
  return [...others, ...mine];
}
