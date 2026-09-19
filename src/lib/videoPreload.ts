// How much of a reel's clip the <video> element is allowed to pull on its own.
//
// The Reddit canvas DEFERS remote clips: a footage segment is ~100 MB, and the pipeline (build → narrate →
// copy → export) cycles the selection through every reel, so eagerly downloading each one stalled the whole
// flow. That deferral was implemented as preload="none", on the theory that the Reddit card covers the
// black band anyway.
//
// It doesn't. The card is a ~900x700 overlay on a 1080x1920 canvas, and preload="none" means the element
// fetches NOTHING: readyState stays 0, so the draw loop's readyState>=2 guard skips drawImage forever and
// the reel renders as a black video band under a perfectly fine card. Worse, it is self-sealing — the
// duration only ever arrives via `loadedmetadata`, and the timeline (the one thing that downloads the clip
// and would heal it) refuses to render without a duration. A saved footage reel stayed black across every
// reload.
//
// So the floor is "metadata", never "none": a byte-range fetch of the moov box, which is what the canvas's
// own onLoadedMetadata poster seek has always assumed it gets. That keeps the deferral honest — a cycled
// reel still pulls kilobytes, not the whole clip, which is fetched in full only at export.

/** The only values we hand a reel <video>. "none" is deliberately not one of them — see the module note. */
export type ReelPreload = 'auto' | 'metadata';

/**
 * `preload` for a reel's <video>.
 *
 * - Local bytes (blob:/data:) are already in memory and free to read → "auto", which decodes a real first
 *   frame with no seek needed.
 * - `eager` (a reel with no card to look at while it waits) → "auto" as well.
 * - Everything else — a remote footage/CDN clip on a carded reel — → "metadata": enough for the poster seek
 *   and the duration, not the file.
 */
export function reelPreload(videoSrc: string | null | undefined, opts?: { eager?: boolean }): ReelPreload {
  if (opts?.eager) return 'auto';
  return /^(blob:|data:)/i.test(videoSrc ?? '') ? 'auto' : 'metadata';
}
