'use client';

import { useState, useRef, useEffect } from 'react';
import type { TikTokCanvasRef } from '../components/TikTokCanvas/types';
import type { VideoEntry, VideoData, VideoMode } from '../types';
import { makeEmptyEntry, newReelId, MAX_REELS } from '@/lib/entry';
import { getCachedVideo, setCachedVideo, enqueueVideoFetch } from '@/lib/reelVideoCache';
import { isFootageUrl, footageVideoData } from '@/lib/footage';
import { proxyStreamUrl } from '@/lib/utils';
import { deleteLocalVideo, pruneLocalVideos, pruneOverlayImages } from '@/lib/localVideoStore';
import { parseGrid, GRID_STORAGE_KEY } from '@/lib/reelGridStore';
import { mediaIdsOutsideStyle, type ReelMediaIds } from '@/lib/reelMedia';

// The exporter demuxes H.264 only, but TikWM's HD stream is sometimes H.265 (hvc1). Sniff the first
// bytes of a stream for an AVC sample entry so a non-exportable HD variant can be dropped in favour of
// the H.264 SD stream. Best-effort: a failed sniff keeps the stream (don't degrade on a network blip).
async function looksH264(streamUrl: string): Promise<boolean> {
  try {
    const res = await fetch(proxyStreamUrl(streamUrl), { headers: { Range: 'bytes=0-300000' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return true;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const has = (fourcc: string) => {
      const t = [...fourcc].map(c => c.charCodeAt(0));
      outer: for (let i = 0; i + t.length <= bytes.length; i++) {
        for (let j = 0; j < t.length; j++) if (bytes[i + j] !== t[j]) continue outer;
        return true;
      }
      return false;
    };
    if (has('avc1') || has('avc3')) return true;
    if (has('hvc1') || has('hev1') || has('av01') || has('vp09')) return false;
    return true;   // no codec marker in the probed range — keep the stream
  } catch {
    return true;
  }
}

export function useVideoEntries() {
  // Pre-restore placeholder: CanvasGrid replaces it with the active style's saved reels as soon as they
  // load. Its id is minted like any other (never the old hard-coded '1') so that even in the window before
  // the restore it can't share an IndexedDB record with a stored reel of either workspace.
  const [entries, setEntries] = useState<VideoEntry[]>(() => [makeEmptyEntry(newReelId())]);
  const canvasRefsMap = useRef<Map<string, TikTokCanvasRef>>(new Map());

  // Always-current snapshot used inside async callbacks to avoid stale closures
  const entriesRef = useRef(entries);
  useEffect(() => { entriesRef.current = entries; }, [entries]);

  // Add a blank reel, capped at MAX_REELS. Guarded inside the updater too so no path can ever push the
  // grid past the cap (which the server trigger would reject, breaking the save). The UI disables the
  // add affordance at the cap; this is the safety net.
  // initialUrl seeds the new reel's link (e.g. auto-assigned random footage); the auto-fetch
  // effect loads it just like a pasted link.
  function addRow(initialUrl?: string) {
    // Minted outside the updater: StrictMode double-invokes updaters, and an id is a one-per-reel resource.
    const id = newReelId();
    setEntries(prev => {
      if (prev.length >= MAX_REELS) return prev;
      const e = makeEmptyEntry(id, prev[0]?.mode ?? 'twitter');
      if (initialUrl) e.url = initialUrl;
      return [...prev, e];
    });
  }

  // Bulk-create reels (each optionally seeded with a footage URL), capped at MAX_REELS. Returns the
  // new reel ids synchronously (derived from the current entries ref) so the caller can attach a
  // card to each. If the current grid is a single blank reel, the first spec replaces it — UNLESS
  // keepExisting is set (a rebuild that reuses existing reels in the same batch must not let the sole
  // blank reel — which may itself be a reuse target — get consumed, or that reel is silently destroyed).
  function addReels(urls: (string | undefined)[], opts?: { keepExisting?: boolean }): string[] {
    const cur = entriesRef.current;
    const startBlank = !opts?.keepExisting && cur.length === 1 && !cur[0].url.trim() && !cur[0].localVideoSrc && !cur[0].data;
    const room = MAX_REELS - (startBlank ? 0 : cur.length);
    const mode = cur[0]?.mode ?? 'twitter';
    const created = urls.slice(0, Math.max(0, room)).map(url => {
      const e = makeEmptyEntry(newReelId(), mode);
      if (url) e.url = url;
      return e;
    });
    if (!created.length) return [];
    setEntries(prev => (startBlank ? created : [...prev, ...created]));
    return created.map(e => e.id);
  }

  function removeRow(id: string) {
    // Allow deleting any row, including the last — the grid tolerates zero entries (every entries[0]
    // access is guarded) and always shows the "add row" ghost card to recover. Previously this no-op'd
    // when only one row remained, so the Delete button silently did nothing on a single-reel workspace.
    setEntries(prev => prev.filter(e => e.id !== id));
    // GC the reel's stored upload from IndexedDB (nothing else references it — ids are unique).
    void deleteLocalVideo(id);
  }

  // Duplicate a row: insert a copy (new id) right after the source. Returns the new id so the caller can
  // copy the id-keyed editor state (framing / template / settings) and select the duplicate — or null
  // when the grid is at the cap (nothing added, so the caller must not carry state to a phantom id).
  function duplicateRow(id: string): string | null {
    if (entriesRef.current.length >= MAX_REELS) return null;
    const newId = newReelId();
    setEntries(prev => {
      if (prev.length >= MAX_REELS) return prev;
      const idx = prev.findIndex(e => e.id === id);
      if (idx < 0) return prev;
      const copy: VideoEntry = { ...prev[idx], id: newId };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
    return newId;
  }

  function resetEverything() {
    setEntries([makeEmptyEntry(newReelId())]);
  }

  // Delete every reel of ONE workspace (`styleId`): reset the grid to a single empty reel and GC the media
  // of the reels just deleted — and nothing else.
  //
  // The saved grid holds every style's reels, so the other workspaces' reels are still very much alive and
  // still own their uploads, card images, narration/commentary audio and thumbnails. Those rows are the only
  // record of what they own (this grid can't see them), so they're read from the file HERE, at delete time —
  // not from a snapshot — and everything they reference is spared. Anything else in either store belonged to
  // a reel the user just deleted, or is already orphaned, so the prune doubles as the GC it always was.
  function deleteAllReels(styleId: string) {
    // Work out what survives BEFORE anything is destroyed.
    let keep: ReelMediaIds = { videoIds: [], imageIds: [] };
    // An unreadable store (private mode) means no other workspace ever persisted a reel here, so sparing
    // nothing is right — and a throw must not take the reset or the GC down with it.
    try { keep = mediaIdsOutsideStyle(parseGrid(localStorage.getItem(GRID_STORAGE_KEY)), styleId); } catch { /* ignore */ }
    setEntries([makeEmptyEntry(newReelId())]);
    void pruneLocalVideos(keep.videoIds);
    void pruneOverlayImages(keep.imageIds);
  }

  function handleVideoError(id: string) {
    setEntries(prev => prev.map(e => e.id === id ? { ...e, videoFailed: true } : e));
  }

  function setMode(id: string, mode: VideoMode) {
    setEntries(prev => prev.map(e => e.id === id ? { ...e, mode } : e));
  }

  function updateEntry(id: string, field: 'url' | 'caption', value: string) {
    setEntries(prev => prev.map(e => e.id === id ? { ...e, [field]: value } : e));
  }

  /**
   * `keepStored` clears the in-memory source WITHOUT dropping the reel's stored bytes. Editing a link is
   * not the same as removing a video: a commentary reel keeps its own copy, and deleting it on a keystroke
   * destroyed the only surviving copy of a reel whose CDN link had already expired. The blob is keyed by
   * reel id, so a real replacement overwrites it anyway.
   */
  function updateLocalVideo(id: string, src: string, name: string, opts?: { keepStored?: boolean }) {
    // Clear any previously-stored bucket URL + poster: a changed/removed local file (or a link being
    // replaced by an upload) must be re-stored, so the persistence layer re-derives them from the new blob.
    setEntries(prev => prev.map(e =>
      e.id === id ? { ...e, localVideoSrc: src || undefined, localVideoName: name || undefined, videoUrl: undefined, posterUrl: undefined, data: null, error: '', videoFailed: false } : e
    ));
    // The replaced/removed clip's stored upload is now unreferenced — GC it from IndexedDB. (When a
    // NEW upload replaces it, CanvasGrid re-persists the new blob right after this.)
    if (!src && !opts?.keepStored) void deleteLocalVideo(id);
  }

  async function fetchVideo(id: string) {
    const currentEntry = entriesRef.current.find(e => e.id === id);
    if (!currentEntry || !currentEntry.url.trim()) {
      setEntries(prev => prev.map(e => e.id === id ? { ...e, error: 'URL is required' } : e));
      return;
    }
    // A caption is NOT required to fetch a video — the link/upload comes first and the caption can be
    // added (or left empty) afterwards. Only the URL is needed here (the caption isn't sent to the API).
    const url = currentEntry.url.trim();

    // Cache hit → restore instantly with NO API call. This is what makes returning to the reels section
    // (after switching away) not re-hit the download API for already-fetched links.
    const cached = getCachedVideo(url);
    if (cached) {
      setEntries(prev => prev.map(e =>
        e.id === id ? { ...e, loading: false, error: '', data: cached, videoFailed: false } : e
      ));
      return;
    }

    // Footage-library URLs point at our own R2 bucket — no resolver, no rate-limit queue, no codec
    // sniff (the library is H.264 by construction). Synthesize the VideoData directly.
    if (isFootageUrl(url)) {
      const data = footageVideoData(url);
      setCachedVideo(url, data);
      setEntries(prev => prev.map(e =>
        e.id === id ? { ...e, loading: false, error: '', data, videoFailed: false } : e
      ));
      return;
    }

    setEntries(prev => prev.map(e =>
      e.id === id ? { ...e, loading: true, error: '', data: null, videoFailed: false } : e
    ));

    // Route through the shared rate-limited queue so many reels fetch one-by-one (≥1s apart) instead of
    // all at once and tripping the API's 1/sec limit.
    const result = await enqueueVideoFetch(url, async () => {
      // A hung request must NOT freeze the shared fetch queue: reelVideoCache.runQueue awaits this serially,
      // so one stalled /api/download (slow upstream, flaky network) otherwise left EVERY queued reel stuck
      // on "loading" forever. A client-side timeout guarantees it settles; AbortSignal.timeout covers both
      // the response and the body read.
      try {
        const res = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
          signal: AbortSignal.timeout(30_000),
        });
        return { ok: res.ok, json: await res.json() };
      } catch (e) {
        const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
        return { ok: false, json: { error: timedOut ? 'The download timed out — please try again.' : 'Network error — please try again.' } };
      }
    });

    // The reel may have been deleted or its URL changed while queued — drop a stale result.
    const latest = entriesRef.current.find(e => e.id === id);
    if (!latest || latest.url.trim() !== url) return;

    const json = result.json as { error?: string; play?: string; hdplay?: string; wmplay?: string; images?: string[] };

    // Hard failure: the route returned a non-2xx with an error message (bad/unsupported/private
    // link, upstream error, timeout, etc.). Surface it verbatim.
    if (!result.ok) {
      const errorMsg = typeof json.error === 'string' ? json.error : 'Something went wrong';
      setEntries(prev => prev.map(e =>
        e.id === id ? { ...e, loading: false, error: errorMsg, data: null, videoFailed: false } : e
      ));
      return;
    }

    // Soft failure: the route can return 200 with NO usable video — a TikTok photo slideshow, an
    // Instagram/X photo-only post, or an otherwise empty payload. Without this the card would sit
    // empty with no explanation; instead tell the user what went wrong.
    const hasVideo = !!(json.play || json.hdplay || json.wmplay);
    if (!hasVideo) {
      const errorMsg = (json.images && json.images.length > 0)
        ? 'That link is a photo post — there’s no video to fetch.'
        : 'Couldn’t fetch a video from that link. Make sure it’s a public TikTok, Instagram, or X post that has a video.';
      setEntries(prev => prev.map(e =>
        e.id === id ? { ...e, loading: false, error: errorMsg, data: null, videoFailed: false } : e
      ));
      return;
    }

    // Drop an H.265 HD stream (export would fail) as long as an H.264 fallback exists.
    const data = { ...(json as VideoData) };
    if (data.hdplay && (data.play || data.wmplay) && !(await looksH264(data.hdplay))) data.hdplay = '';

    // Re-check staleness after the sniff (it awaits a network read).
    const fresh = entriesRef.current.find(e => e.id === id);
    if (!fresh || fresh.url.trim() !== url) return;

    setCachedVideo(url, data);   // cache for instant restore on the next visit
    setEntries(prev => prev.map(e =>
      e.id === id ? { ...e, loading: false, error: '', data, videoFailed: false } : e
    ));
  }

  async function fetchAllVideos() {
    // Caption optional here too — fetch every entry that has a URL and isn't already fetched/loading.
    const toFetch = entriesRef.current.filter(e => e.url.trim() && !e.data && !e.loading);
    for (const entry of toFetch) {
      await fetchVideo(entry.id);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // NOTE: "Download all" lives in CanvasGrid now — only the on-screen reel is mounted, so it must cycle the
  // selection to each reel before exporting (which this hook can't drive). A loop over canvasRefsMap here
  // would only ever find the displayed reel's ref.

  return {
    entries, setEntries, canvasRefsMap,
    addRow, addReels, removeRow, duplicateRow, resetEverything, deleteAllReels, updateEntry, updateLocalVideo, setMode, handleVideoError,
    fetchVideo, fetchAllVideos,
  };
}
