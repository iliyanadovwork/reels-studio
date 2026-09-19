import type { VideoEntry, VideoMode } from '../app/types';

// Hard cap on reels per user's grid. Enforced client-side (block adds) AND server-side by the
// enforce_reel_cap trigger on video_reels (see supabase/migrations). The trigger only blocks GROWING
// past 50 — an existing over-cap grid (one user already has 486) still saves/shrinks fine — so this
// limit never destroys or rejects existing reels; it only stops new ones being added past 50.
export const MAX_REELS = 50;

// A reel id has to be unique across the WHOLE saved grid, not just the workspace that minted it. Rows are
// style-scoped (see reelPartition) but the id is not: it keys the reel's uploaded video in IndexedDB and
// every id-keyed editor map. Two workspaces that both minted the hard-coded "1" — or the same Date.now()
// from two tabs — shared one video record, so uploading in one showed the clip in the other and deleting
// one destroyed the other's media.
// The counter separates ids minted within the same millisecond; the random tail separates tabs (and any
// clock that jumps backwards). LEGACY ids are never rewritten — a stored "1" stays a perfectly valid key,
// and this only decides what NEW reels are called.
let mintedReels = 0;
export function newReelId(): string {
  mintedReels += 1;
  return `r${Date.now().toString(36)}-${mintedReels.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeEmptyEntry(id: string, mode: VideoMode = 'twitter'): VideoEntry {
  return {
    id, url: '', caption: '',
    mode,
    data: null, loading: false, error: '', videoFailed: false,
  };
}
