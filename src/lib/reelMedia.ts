// Which IndexedDB blobs a set of saved reels owns.
//
// A reel's bytes live in two stores (see localVideoStore): the uploaded video, keyed by the REEL id, and
// images/audio, keyed by an overlay id, an overlay's `audioId`, or a `thumbnailId`. Those five are the only
// keys anything writes — every saveLocalVideo/saveOverlayImage call site uses one of them (uploads, Reddit
// card PNGs, narration WAVs, commentary WAVs, image overlays, custom thumbnails).
//
// This exists because "delete all reels" now deletes only ONE workspace's reels: the saved grid still holds
// the other styles' rows, and those rows still own their media. So the delete needs the exact set of blobs
// to spare. Getting that walk wrong permanently destroys footage the user never asked to delete, which is
// why it lives here — pure, off IndexedDB and off the DOM, where every branch is testable.
//
// Rows arrive straight out of JSON.parse (the file may predate any field, or be corrupt), so nothing is
// trusted: an unreadable row contributes no ids rather than throwing. Under-collecting only leaks a blob;
// throwing mid-walk would leave the caller with a half-built keep-set and delete live media.

import { styleOf } from './reelPartition';

export interface ReelMediaIds {
  /** Keys in the `videos` store — the reel ids themselves (a reel with no upload simply has no record). */
  videoIds: string[];
  /** Keys in the `images` store — overlay images, their narration audio, and custom thumbnails. */
  imageIds: string[];
}

/** A non-empty string, or null. IndexedDB accepts '' as a key, but nothing here ever mints one. */
function id(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Every media id reachable from these saved rows, deduped. */
export function mediaIdsForRows(rows: readonly unknown[]): ReelMediaIds {
  const videoIds = new Set<string>();
  const imageIds = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { id: rowId, framing } = row as { id?: unknown; framing?: unknown };
    const reelId = id(rowId);
    if (reelId) videoIds.add(reelId);
    if (!framing || typeof framing !== 'object') continue;
    const { overlays, thumbnailId } = framing as { overlays?: unknown; thumbnailId?: unknown };
    const thumb = id(thumbnailId);
    if (thumb) imageIds.add(thumb);
    if (!Array.isArray(overlays)) continue;
    for (const overlay of overlays as unknown[]) {
      if (!overlay || typeof overlay !== 'object') continue;
      const { id: overlayId, audioId, coverAtlasId } = overlay as { id?: unknown; audioId?: unknown; coverAtlasId?: unknown };
      const oid = id(overlayId);
      if (oid) imageIds.add(oid);
      const aid = id(audioId);
      if (aid) imageIds.add(aid);
      // Erase-mode cover atlas (redditTextErase): its blob is as live as the card's own — missing it
      // here would let deleteAllReels prune a SPARED workspace's atlases out from under it.
      const cid = id(coverAtlasId);
      if (cid) imageIds.add(cid);
    }
  }
  return { videoIds: [...videoIds], imageIds: [...imageIds] };
}

/**
 * The media a delete-all in `styleId` must SPARE: everything owned by every other style's saved rows.
 *
 * Read from the file at delete time, never from the deleting workspace's own state — the other workspace's
 * reels are exactly the ones this grid can't see, so its rows in `reels:grid` are the only record of what
 * they own. Untagged rows resolve to Reddit (styleOf), so a legacy grid is spared by a commentary delete-all
 * and cleared by a Reddit one, which is what the user asked for in each case.
 */
export function mediaIdsOutsideStyle(rows: readonly unknown[], styleId: string): ReelMediaIds {
  return mediaIdsForRows(rows.filter(r => styleOf(r as { framing?: { styleId?: string } | null }) !== styleId));
}
