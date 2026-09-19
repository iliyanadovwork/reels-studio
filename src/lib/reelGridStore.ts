// The saved grid ("reels:grid") is ONE JSON array shared by every reel style. These are the two pure edges
// the persistence hook goes through — parse what's in the file, and produce the file's next contents for a
// single style's save. They live here, off localStorage, so the rule that actually matters — a save never
// drops another workspace's reel — is testable without a DOM.

import { mergeStyleRows, type StyleTagged } from './reelPartition';

/** The localStorage key the whole grid lives under. Shared so anything reasoning about the file (the
    persistence hook, delete-all's media walk) can't drift onto a different key. */
export const GRID_STORAGE_KEY = 'reels:grid';

/**
 * A row exactly as it sits in the file. Rows this workspace doesn't own are carried through AS PARSED and
 * are never re-derived from a normalised copy: normalisation is an allowlist, so round-tripping another
 * style's rows through it would silently drop any field this build doesn't know about.
 */
export type StoredGridRow = StyleTagged;

/** Every row in the saved grid — [] when there's nothing readable (absent, not an array, or corrupt JSON). */
export function parseGrid(raw: string | null | undefined): StoredGridRow[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    // Non-row junk (a string, a null) is kept rather than filtered: styleOf reads it as Reddit's, so the
    // Reddit workspace drops it on its own next save exactly as it always has, while every other workspace
    // passes it through instead of deciding, on its own, to delete something it doesn't understand.
    return Array.isArray(parsed) ? (parsed as StoredGridRow[]) : [];
  } catch {
    return [];   // unparseable — there is nothing to preserve, so the writer starts the file over
  }
}

/**
 * The JSON to write when `styleId`'s workspace saves `rows` — its rows replace that style's rows and nothing
 * else in the file is touched.
 *
 * `currentRaw` MUST be the file as it is RIGHT NOW, re-read at write time. Merging into the snapshot taken
 * when this workspace loaded would let it resurrect rows the other workspace has since deleted, or delete
 * the ones it has since added.
 */
export function mergeGridJson<T extends StyleTagged>(
  currentRaw: string | null | undefined,
  styleId: string,
  rows: readonly T[],
): string {
  return JSON.stringify(mergeStyleRows<StoredGridRow>(parseGrid(currentRaw), styleId, rows));
}
