// Which reels own a private copy of their video bytes, and which just keep a pointer to someone else's.
//
// A style answers this with `keepsOwnVideo`. The two original styles are the opposite poles, and the reasons
// below are what a new style should decide between — the question is never "which style is this?" but "where
// does its video come from, and will that source still be there tomorrow?":
//
//  • A COMMENTARY reel's video IS the reel. It comes from an upload or from a pasted link, and a resolved
//    link is a SIGNED, EXPIRING CDN URL (Instagram's `oe` query param is a hex Unix expiry; past it the CDN
//    answers 403 "URL signature expired"). A commentary reel that only stored its link therefore doesn't
//    reload slowly — it eventually cannot be played or exported at all. So it stores its bytes, whatever
//    the source, and plays them back from IndexedDB first.
//
//  • A REDDIT reel's video is interchangeable background footage out of our own R2 library. The URL never
//    expires, the reel is re-rollable by design (shuffle footage), and the clips are ~100 MB each — storing
//    every one of them would fill IndexedDB to buy nothing. It keeps re-fetching, exactly as it does today.
//
// The link is kept either way: it is the reel's provenance, and for Reddit it is still how the video is
// fetched. What changes for commentary is only that playback and export stop DEPENDING on it.

import { styleTagForSave } from './reelPartition';
import { MAX_UPLOAD_BYTES } from './videoIngest';
import { getReelStyle } from './reelStyles';

/** Does a reel of this style keep its own copy of the video, rather than re-fetching it? Answered by the
 *  style's own `keepsOwnVideo` declaration, not by naming a style here: the question is about where the
 *  video COMES FROM (an expiring signed link vs. our own permanent library), and only the style knows that.
 *  An unknown id resolves to the default style, whose answer is the safe one for a reel we can't identify. */
export function styleKeepsOwnVideo(styleId: string): boolean {
  return getReelStyle(styleId).keepsOwnVideo;
}

export interface PersistBytesInput {
  /** The reel's EFFECTIVE style (an untagged reel belongs to the workspace it lives in — styleTagForSave). */
  styleId: string;
  /** True when these bytes came from a file the user uploaded (as opposed to a fetched link). */
  isUpload: boolean;
  /** Size of the blob about to be written. Omit/null when it isn't known yet. */
  bytes?: number | null;
}

/**
 * Should these bytes be written to IndexedDB?
 *
 * Uploads always: they exist nowhere else, so not storing one loses the video on reload — that is the
 * pre-existing contract and it is unchanged. Links only for a self-contained style, which is the new part.
 *
 * The size test is the same ceiling as the upload guard so the two can't disagree about what fits: a blob
 * bigger than the byte cache will hold is one we'd store and then be unable to use.
 */
export function shouldPersistBytes({ styleId, isUpload, bytes }: PersistBytesInput): boolean {
  if (bytes != null && !(Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_UPLOAD_BYTES)) return false;
  return isUpload || styleKeepsOwnVideo(styleId);
}

/** The minimum shape of a saved row this module reads. */
export interface SavedRowBytes {
  url?: string;
  framing?: { styleId?: string } | null;
}

/**
 * On restore, should this row's bytes be looked for in IndexedDB before the network is touched?
 *
 * A row with no link has always been an upload, and reading it back is exactly today's behaviour — so a
 * legacy grid loads identically. The addition is that a self-contained style reads its store first even
 * when the row HAS a link: the stored copy outlives the link, and there is no reason to re-download a
 * video we already hold. A miss just falls through to the link, which is why this can never lose a reel.
 *
 * `activeStyleId` resolves an untagged row the way the next save will tag it, so a reel created in this
 * workspace and not yet saved is treated as one of its own.
 */
export function shouldRestoreBytes(row: SavedRowBytes | null | undefined, activeStyleId: string): boolean {
  if (!row) return false;
  if (!row.url?.trim()) return true;
  return styleKeepsOwnVideo(styleTagForSave(row.framing, activeStyleId));
}
