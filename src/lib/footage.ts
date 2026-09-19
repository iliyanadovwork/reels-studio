import { proxyStreamUrl } from './utils';
import type { VideoData } from '@/app/types';

// Shared background-footage library: a public R2 bucket holding pre-cut gameplay segments
// (uploaded via scripts/footage-upload.sh, which also regenerates manifest.json). Everything is
// H.264 by construction — the upload script's source folder is codec-checked — so segments are
// always exportable. Served through /api/proxy (r2.dev sends no CORS headers).
export const FOOTAGE_PUBLIC_BASE = 'https://pub-63dabe78ed9342c5a94e50b584141711.r2.dev';
const MANIFEST_URL = `${FOOTAGE_PUBLIC_BASE}/manifest.json`;

export interface FootageSegment {
  name: string;    // "video1.3.mp4"
  group: string;   // "video1"
  size: number;    // bytes
  url: string;     // public R2 URL
}

export function isFootageUrl(url: string): boolean {
  return url.startsWith(`${FOOTAGE_PUBLIC_BASE}/`);
}

/**
 * May this reel's video be REPLACED by a fresh library clip (the footage shuffle, single or bulk)?
 *
 * The rule is: NEVER overwrite a video we didn't assign. A reel whose video came from anywhere else holds
 * the only pointer to it — a style with `keepsOwnVideo: false` stores no bytes, so replacing a pasted link
 * loses that video permanently, with no undo. Re-rolling is meant to swap interchangeable background
 * footage, and that intent is exactly "the current URL is one of ours".
 *
 * The blank case is the subtle one, and it is why this takes `hasStyleCard`. A blank url is EITHER a reel of
 * this style whose clip assignment failed (the manifest was unreachable at create/build time — ours to fill
 * in), OR an upload whose bytes are still being read back from IndexedDB, during which `localVideoSrc` is
 * transiently undefined. Treating every blank as fillable would let a shuffle land inside that read window
 * and rewrite the row's url, after which the restore's `url === row.url` adopt check fails and the stored
 * blob is dropped for good. The style's own card is what distinguishes the two.
 */
export function canReassignFootage(input: { url?: string; hasLocalVideo: boolean; hasStyleCard: boolean }): boolean {
  if (input.hasLocalVideo) return false;              // an upload — its bytes ARE the reel
  const url = (input.url ?? '').trim();
  if (isFootageUrl(url)) return true;                 // one of ours: interchangeable by construction
  if (!url) return input.hasStyleCard;                // see the blank case above
  return false;                                       // someone else's URL — never ours to overwrite
}

/** VideoData for a footage segment — the shape a fetched link produces, with no resolver call. */
export function footageVideoData(url: string): VideoData {
  // `|| 'footage'` (not `??`): split('/').pop() returns '' (never undefined) for '' / a trailing-slash url,
  // so `??` would leave an empty name — `||` catches the empty string and applies the intended default.
  const name = decodeURIComponent(url.split('/').pop() || 'footage');
  return {
    id: name,
    title: name.replace(/\.mp4$/, ''),
    cover: '',
    author: { uniqueId: 'footage', nickname: 'Footage library', avatarThumb: '' },
    play: url,
    wmplay: '',
    hdplay: url,
    duration: 0,
    size: 0,
  };
}

let manifestCache: FootageSegment[] | null = null;
let manifestPromise: Promise<FootageSegment[]> | null = null;

/** Fetch the footage manifest through the proxy. Cached for the session; concurrent calls coalesce. */
export function fetchFootageManifest(): Promise<FootageSegment[]> {
  if (manifestCache) return Promise.resolve(manifestCache);
  manifestPromise ??= (async () => {
    const res = await fetch(proxyStreamUrl(MANIFEST_URL), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`manifest fetch failed (${res.status})`);
    const json = await res.json() as { segments?: FootageSegment[] };
    manifestCache = (json.segments ?? []).filter(s => !!s?.url && !!s?.name);
    return manifestCache;
  })().catch(e => { manifestPromise = null; throw e; });
  return manifestPromise;
}
