'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { RefObject, MutableRefObject } from 'react';
import { CANVAS_W, CANVAS_H } from '../constants';
import type { Box } from '../types';
import { getCachedBlob } from '@/lib/reelVideoBlob';

// The video box is always a centred band, independent of the clip's own dimensions: the Reddit canvas
// passes its template's band, the commentary canvas the whole 1080×1920 canvas. (Both canvases fit the
// frame INTO this box themselves — the old fit-to-clip layouts belonged to templates that no longer exist.)
function calcVideoBox(targetW: number, bandH: number): Box {
  return { x: (CANVAS_W - targetW) / 2, y: (CANVAS_H - bandH) / 2, w: targetW, h: bandH };
}

interface UseVideoLoadingParams {
  videoRef: RefObject<HTMLVideoElement | null>;
  videoSrc: string;
  videoTargetW: number;    // width of the centred video band (CANVAS_W − 2·videoPaddingX)
  videoBandHeight: number; // height of the centred video band
  boxRef: MutableRefObject<Box>;
  setBox: (b: Box) => void;
  videoOffsetRef: MutableRefObject<{ x: number; y: number }>;
  videoScaleRef: MutableRefObject<number>;
  setVideoScale: (s: number) => void;
  // Set true while the <video> is being swapped to a local blob so the draw loop freezes
  // on the last frame (no flash) and the metadata handler skips its framing/trim reset.
  blobSwapRef: MutableRefObject<boolean>;
  // The src whose saved framing has already been restored. When it matches videoSrc, a (deferred) load's
  // loadedmetadata must NOT reset the user's pan/zoom/trim — restore happened before the video ever loaded.
  framingAppliedSrcRef?: MutableRefObject<string | null>;
}

export function useVideoLoading({
  videoRef, videoSrc, videoTargetW, videoBandHeight,
  boxRef, setBox, videoOffsetRef, videoScaleRef, setVideoScale, blobSwapRef, framingAppliedSrcRef,
}: UseVideoLoadingParams) {
  const ownedBlobUrlRef = useRef<string | null>(null);   // this canvas's blob: URL, revoked on src change
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const trimStartRef = useRef(0);
  const trimEndRef = useRef(0);

  // Recalculate the box when the band changes (template switch) for an already-loaded video.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const b = calcVideoBox(videoTargetW, videoBandHeight);
    boxRef.current = b;
    setBox(b);
    videoOffsetRef.current = { x: 0, y: 0 };
    videoScaleRef.current = 1;
    setVideoScale(1);
  }, [videoTargetW, videoBandHeight]);

  // Set box and duration on metadata load
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const handleLoadedMetadata = () => {
      // Duration is a property of the FILE, so it's the same across a same-file blob swap — publish it before
      // any guard. It used to sit below the swap early-return, and a mount-time swap (cached blob) suppressed
      // the only loadedmetadata this canvas ever got, leaving videoDuration 0 — which hides the crop bars.
      const dur = isFinite(video.duration) ? video.duration : 0;
      setVideoDuration(dur);
      if (blobSwapRef.current) return;   // same-file blob swap → keep the user's crop/zoom/trim
      // A deferred (preload="metadata") reel restores its saved framing on mount, BEFORE the clip loads;
      // when the user later plays it, this loadedmetadata fires — it must NOT reset the user's crop/pan/zoom/
      // trim (that would clobber the restored framing and get autosaved). So EVERY reset here — including the
      // band box, which carries the user's crop — is skipped once framing is applied for this source. (The
      // safety-net effect below still seeds the band for a fresh reel: it only fires on the placeholder box.)
      const framingApplied = !!framingAppliedSrcRef?.current && framingAppliedSrcRef.current === videoSrc;
      if (!framingApplied) {
        if (video.videoWidth && video.videoHeight) {
          const b = calcVideoBox(videoTargetW, videoBandHeight);
          boxRef.current = b;
          setBox(b);
          videoOffsetRef.current = { x: 0, y: 0 };
          videoScaleRef.current = 1;
          setVideoScale(1);
        }
        setTrimStart(0);
        setTrimEnd(dur);
        trimStartRef.current = 0;
        trimEndRef.current = dur;
      } else if (dur > 0 && (trimEndRef.current <= 0 || trimEndRef.current > dur + 0.05)) {
        // Restored framing that carries NO trim (a reel seeded with just a styleId/script, or a bulk-built
        // row) would keep trimEnd 0 forever — an empty clip window. Same repair when the restored trim
        // outruns THIS clip (the reel's footage was swapped). Either way, the whole clip is the sane window.
        setTrimEnd(dur);
        trimEndRef.current = dur;
        if (trimStartRef.current >= dur) { setTrimStart(0); trimStartRef.current = 0; }
      }
      setCurrentTime(0);
    };
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    return () => video.removeEventListener('loadedmetadata', handleLoadedMetadata);
  }, [videoSrc, videoTargetW, videoBandHeight]);

  // Safety net: once loading finishes, if the box is STILL the full-canvas placeholder, force the band.
  // calcVideoBox in the loadedmetadata handler above can miss it (metadata that fired before the listener
  // attached, a cached/blob-swap load, etc.), which left sheet-sent reels rendering full-canvas until a
  // template switch (the band-change effect) recomputed it — this makes that recompute happen on every
  // load. Only fires when the box is the untouched placeholder; a real band/crop is left alone.
  useEffect(() => {
    if (isVideoLoading) return;
    const b = boxRef.current;
    if (b.x !== 0 || b.y !== 0 || b.w !== CANVAS_W || b.h !== CANVAS_H) return;
    const nb = calcVideoBox(videoTargetW, videoBandHeight);
    boxRef.current = nb;
    setBox(nb);
  }, [isVideoLoading, videoSrc, videoTargetW, videoBandHeight]);

  // Loading/error state flips with the src during render; the effect below only
  // touches the <video> element.
  // A source is loadable if it's a DIRECT file — an uploaded blob: URL, or our own Supabase Storage
  // https URL for a persisted upload — OR a proxied link (`/api/proxy?...url=<target>`). The only
  // rejected non-empty case is the empty-proxy sentinel `/api/proxy?stream=1&url=` (bestVideoUrl of
  // not-yet-fetched data). This gate previously required the `url=` substring, so uploads (blob:/Storage,
  // which have none) never got their src assigned and rendered as a black crop box.
  const srcValid = !!videoSrc
    && !videoSrc.endsWith('url=')
    && (/^(blob:|data:|https?:)/i.test(videoSrc) || videoSrc.includes('url='));
  const [prevSrc, setPrevSrc] = useState<string | null>(null);
  if (videoSrc !== prevSrc) {
    setPrevSrc(videoSrc);
    if (srcValid) setVideoError(null);
    // Deferred loading: the <video> is preload="metadata" (lib/videoPreload), so a new src reads the moov
    // box and nothing more until play/export. Never show the "Loading video…" spinner for it — that's a
    // byte-range read, not a download. It only becomes "loading" if the user plays it (handled below).
    setIsVideoLoading(false);
  }

  // Load new video src
  useEffect(() => {
    blobSwapRef.current = false;   // a new source is loading — never stay frozen from a prior swap
    if (!srcValid) return;
    const video = videoRef.current;
    if (!video) {
      const t = setTimeout(() => setIsVideoLoading(false), 0);
      return () => clearTimeout(t);
    }

    video.pause();
    video.removeAttribute('src');
    video.load();
    video.src = videoSrc;

    // Clear any residual spinner once data actually arrives (only happens if the user plays the deferred
    // clip). No eager-load timeout/error: a deferred element intentionally never downloads the FILE until
    // played or exported, so a "failed to load" timeout would be a false alarm — a genuinely bad URL
    // surfaces at export instead.
    const clearLoading = () => { if (video.readyState >= 1) setIsVideoLoading(false); };
    const handleError = () => setIsVideoLoading(false);

    video.addEventListener('loadedmetadata', clearLoading);
    video.addEventListener('loadeddata', clearLoading);
    video.addEventListener('error', handleError);

    return () => {
      video.removeEventListener('loadedmetadata', clearLoading);
      video.removeEventListener('loadeddata', clearLoading);
      video.removeEventListener('error', handleError);
    };
  }, [videoSrc, srcValid]);

  // ── Local-blob swap ─────────────────────────────────────────────────────────
  // The proxy src streams quickly for initial playback, but seeking it range-fetches
  // the CDN (slow scrubbing). When the whole file is ALREADY downloaded (the active
  // reel's filmstrip does this), swap the <video> to a local blob so seeks hit memory.
  // Gated on the cache (no new download) so non-active mounted canvases don't download.
  // The swap is imperative (videoSrc state unchanged) and preserves framing/trim.
  // Triggered by the timeline (which downloads the file) via the canvas ref, plus a
  // one-shot attempt on mount for the already-cached case.
  const swapToLocalBlob = useCallback(() => {
    // A blob: src is already a local file (an upload) — seeking it hits memory, so swapping to yet
    // another blob is pure waste (and re-buffers the file). Only remote/proxy sources benefit.
    if (!srcValid || ownedBlobUrlRef.current || videoSrc.startsWith('blob:')) return;
    const v = videoRef.current;
    const blob = getCachedBlob(videoSrc);
    if (!v || !blob) return;
    const url = URL.createObjectURL(blob);
    ownedBlobUrlRef.current = url;
    const t = v.currentTime, wasPlaying = !v.paused;
    blobSwapRef.current = true;   // freeze the draw loop + skip the metadata reset
    const finish = () => {
      v.removeEventListener('seeked', finish);
      v.removeEventListener('loadeddata', finish);
      blobSwapRef.current = false;
      if (wasPlaying) v.play().catch(() => {});
    };
    const onMeta = () => {
      v.removeEventListener('loadedmetadata', onMeta);
      try { v.currentTime = t; } catch { /* ignore */ }
      v.addEventListener('seeked', finish, { once: true });
      v.addEventListener('loadeddata', finish, { once: true });   // covers t===0 (no 'seeked')
    };
    v.addEventListener('loadedmetadata', onMeta, { once: true });
    v.src = url;
    v.load();
    setTimeout(() => { blobSwapRef.current = false; }, 5000);   // safety: never freeze forever
  }, [videoSrc, srcValid, videoRef, blobSwapRef]);

  useEffect(() => { swapToLocalBlob(); }, [swapToLocalBlob]);   // already-cached (e.g. reopened reel)

  // Revoke this canvas's blob URL when the source changes or the canvas unmounts.
  useEffect(() => () => {
    if (ownedBlobUrlRef.current) { URL.revokeObjectURL(ownedBlobUrlRef.current); ownedBlobUrlRef.current = null; }
  }, [videoSrc]);

  return {
    isVideoLoading, videoError, setVideoError,
    videoDuration, trimStart, trimEnd, setTrimStart, setTrimEnd,
    currentTime, setCurrentTime, trimStartRef, trimEndRef, swapToLocalBlob,
  };
}
