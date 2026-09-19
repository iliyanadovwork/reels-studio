'use client';

import { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react';

import { CANVAS_W, CANVAS_H, DISPLAY_SCALE } from './constants';
import type { Box, ClipSegment, Framing, ImageOverlay, RecordingState, TikTokCanvasRef } from './types';
import { getOverlayImage, deleteOverlayImage } from '@/lib/localVideoStore';
import { drawImageOverlays, overlayRevealFraction } from './drawing/drawOverlays';
import { drawBlurredBackdrop, createBackdropScratch, visibleSourceRect } from './drawing/blurBackdrop';
import { fullBleedVideoRects } from './drawing/fullBleedVideo';
import { VideoOverlays } from './ui/VideoOverlays';
import { useVideoLoading } from './hooks/useVideoLoading';
import { useDrag } from './hooks/useDrag';
import { useMemeRecording } from './hooks/useMemeRecording';
import { trackById, trackStreamSrc, DEFAULT_MUSIC_VOLUME } from '@/lib/music';

// The MEME canvas. A meme reel is a full-bleed background clip with ONE image floating over it — a meme, a
// screenshot, a comment thread — narrated line by line off its own OCR'd text, un-cropping to each line as
// the voice reaches it.
//
// It is a deliberate fork, the third one, and it borrows from both of its siblings without depending on
// either — the two existing canvases already established that a style owns its canvas outright, because the
// branches they shared were constants on each side.
//
//  • From the COMMENTARY canvas: the composition. A meme reel has no tweet template, no header, no cells and
//    no free elements — "a meme is just a meme" — so the clip is cover-fit to the whole 1080×1920 frame
//    through drawing/fullBleedVideo, with the crop bars as the only framing control and an optional blurred
//    backdrop filling whatever the crop leaves.
//  • From the REDDIT canvas: the audio. The narration IS the reel's soundtrack, so the video is muted and run
//    at the overlay's baked-in `audioRate`, and each narrated overlay drives its own <audio> slaved to the
//    playhead. That is why this canvas DOES implement setOverlayNarration (the commentary one does not): a
//    meme's voice is generated from the image's pixels through the same generateNarration path a Reddit card
//    uses, and it has to land somewhere.
//
// What it takes from NEITHER is any knowledge of them: no import here reaches RedditCanvas or
// CommentaryCanvas, and nothing in either reaches this.

export interface MemeCanvasProps {
  videoSrc: string;
  videoId?: string;
  rowNumber?: number;
  /** Generated YouTube title — used as the export filename when present (falls back to the caption). */
  exportTitle?: string;
  exportDescription?: string;
  onVideoError?: () => void;
  /** The reel's caption. A meme reel draws none; kept only as the export-filename fallback. */
  overlayCaption?: string;
  onRecordingStateChange?: (state: RecordingState) => void;
  /** Saved framing to restore once the video has (re)loaded — pan/zoom/trim/overlays of a saved reel. */
  initialFraming?: Framing | null;
  onFramingChange?: () => void;
  onOverlaysChange?: (overlays: ImageOverlay[]) => void;
  /** Armed narration-voice brush: while set, clicking an OCR line paints it with this voice instead of
      toggling it in/out of the narration. */
  ocrBrush?: { voiceId: string; color: string } | null;
  /** Armed add-missing-text draft: while non-null, dragging on the selected overlay draws the new
      line's box (overlay-local fractions) instead of moving the overlay. */
  manualLineDraft?: string | null;
  onManualLine?: (rect: { x0: number; y0: number; x1: number; y1: number }) => void;
  /** voiceId → display color for OCR line highlights (lines with no voice use the accent style). */
  ocrVoiceColors?: Record<string, string>;
  musicId?: string | null;
  musicVolume?: number | null;
  /** Fill the letterbox with a blurred cover-fit copy of the video (see Framing.bgBlur). */
  bgBlur?: boolean | null;
  /** IndexedDB key of a custom thumbnail still — held for a few frames at the start of the EXPORT only. */
  thumbnailId?: string | null;
}

export const MemeCanvas = forwardRef<TikTokCanvasRef, MemeCanvasProps>(function MemeCanvas({
  videoSrc,
  videoId,
  rowNumber = 0,
  exportTitle = '',
  exportDescription = '',
  onVideoError,
  overlayCaption = '',
  onRecordingStateChange,
  initialFraming = null,
  onFramingChange,
  onOverlaysChange,
  ocrBrush = null,
  manualLineDraft = null,
  onManualLine,
  ocrVoiceColors,
  musicId = null,
  musicVolume = null,
  bgBlur = null,
  thumbnailId = null,
}: MemeCanvasProps, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingSeekRef = useRef<number | null>(null);   // latest scrub target while a seek is in flight
  const blobSwapRef = useRef(false);                    // true while swapping the <video> to a local blob
  const raf = useRef(0);

  const videoOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const videoScaleRef = useRef<number>(1);
  const [videoScale, setVideoScale] = useState(1);

  const boxRef = useRef<Box>({ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H });
  const [box, setBox] = useState<Box>({ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H });

  const [includeEdit, setIncludeEdit] = useState(false);
  const includeEditRef = useRef(false);

  // Timeline clip list (multi-cut edits), owned by the canvas so it persists with the framing and survives
  // the timeline panel unmounting. null = simple trim; the timeline seeds itself from this.
  const timelineSegmentsRef = useRef<ClipSegment[] | null>(null);

  // ── Overlays — the meme image, plus any extra image the user layered on ──
  const [overlays, setOverlays] = useState<ImageOverlay[]>([]);
  const overlaysRef = useRef<ImageOverlay[]>([]);
  const overlaysSeededRef = useRef(false);   // restored from initialFraming exactly once (mount-seed OR applyFraming)
  const overlayImgsRef = useRef<Map<string, HTMLImageElement>>(new Map());   // id → decoded image
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);

  // ── Hooks ────────────────────────────────────────────────────────────────────

  // Latches the src whose saved framing has been restored (set by the restore effect below). Declared above
  // useVideoLoading so the metadata handler can tell "already restored" from "fresh reel" and NOT reset the
  // user's crop/pan/trim when a deferred clip finally loads.
  const framingAppliedSrcRef = useRef<string | null>(null);
  // One full-bleed band: the clip covers the whole 1080×1920 canvas, exactly like a commentary reel.
  const {
    isVideoLoading, videoError, setVideoError,
    videoDuration, trimStart, trimEnd, setTrimStart, setTrimEnd,
    currentTime, setCurrentTime, trimStartRef, trimEndRef, swapToLocalBlob,
  } = useVideoLoading({
    videoRef, videoSrc, videoTargetW: CANVAS_W, videoBandHeight: CANVAS_H,
    boxRef, setBox, videoOffsetRef, videoScaleRef, setVideoScale, blobSwapRef, framingAppliedSrcRef,
  });

  const onFramingChangeRef = useRef(onFramingChange);
  useEffect(() => { onFramingChangeRef.current = onFramingChange; });
  const notifyFraming = useCallback(() => onFramingChangeRef.current?.(), []);

  // Crop-bar dragging (tc/bc): resizes the video box; the draw loop + export clip to it, so dragging the
  // bars IS the crop. Commits framing on drag end (same signal as every other framing edit).
  const { startDrag: startCropDrag } = useDrag({ boxRef, setBox, canvasRef, onChange: notifyFraming });

  const onOverlaysChangeRef = useRef(onOverlaysChange);
  useEffect(() => { onOverlaysChangeRef.current = onOverlaysChange; });
  // Single write path for the overlay list: refs for the draw/export loops, state for the editing UI, the
  // workspace callback for the timeline, and (usually) a framing notification for autosave.
  const commitOverlays = useCallback((next: ImageOverlay[], opts: { silent?: boolean } = {}) => {
    overlaysRef.current = next;
    setOverlays(next);
    onOverlaysChangeRef.current?.(next);
    if (!opts.silent) notifyFraming();
  }, [notifyFraming]);

  // Re-hydrate restored overlays: a saved overlay comes back without `src`/`audioSrc` (object URLs don't
  // survive a reload) — load its blob from IndexedDB and mint a fresh URL.
  useEffect(() => {
    for (const o of overlays) {
      if (!o.src) {
        void getOverlayImage(o.id).then(hit => {
          if (!hit) return;
          const src = URL.createObjectURL(hit.blob);
          if (!overlaysRef.current.some(x => x.id === o.id && !x.src)) { URL.revokeObjectURL(src); return; }
          commitOverlays(overlaysRef.current.map(x => (x.id === o.id && !x.src ? { ...x, src } : x)), { silent: true });
        }).catch(() => {});
      }
      if (o.audioId && !o.audioSrc) {
        const audioId = o.audioId;
        void getOverlayImage(audioId).then(hit => {
          if (!hit) return;
          const audioSrc = URL.createObjectURL(hit.blob);
          if (!overlaysRef.current.some(x => x.id === o.id && !x.audioSrc)) { URL.revokeObjectURL(audioSrc); return; }
          commitOverlays(overlaysRef.current.map(x => (x.id === o.id && !x.audioSrc ? { ...x, audioSrc } : x)), { silent: true });
        }).catch(() => {});
      }
      // Erase-mode cover atlas: same lifecycle as `src`, its own blob under coverAtlasId.
      if (o.coverAtlasId && !o.coverSrc) {
        const coverAtlasId = o.coverAtlasId;
        void getOverlayImage(coverAtlasId).then(hit => {
          if (!hit) return;
          const coverSrc = URL.createObjectURL(hit.blob);
          if (!overlaysRef.current.some(x => x.id === o.id && !x.coverSrc)) { URL.revokeObjectURL(coverSrc); return; }
          commitOverlays(overlaysRef.current.map(x => (x.id === o.id && !x.coverSrc ? { ...x, coverSrc } : x)), { silent: true });
        }).catch(() => {});
      }
    }
  }, [overlays, commitOverlays]);

  // ── Narration audio preview: one <audio> per narrated overlay, slaved to the video playhead ──
  const overlayAudioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  useEffect(() => {
    const map = overlayAudioElsRef.current;
    const live = new Set<string>();
    for (const o of overlays) {
      if (!o.audioId || !o.audioSrc) continue;
      live.add(o.id);
      let el = map.get(o.id);
      if (!el) { el = new Audio(); el.preload = 'auto'; map.set(o.id, el); }
      if (el.src !== o.audioSrc) el.src = o.audioSrc;
    }
    for (const [id, el] of map) {
      if (!live.has(id)) { el.pause(); el.removeAttribute('src'); map.delete(id); }
    }
  }, [overlays]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const els = overlayAudioElsRef.current;
    const sync = () => {
      // A narrated overlay silences the underlying clip (the voice-over IS the audio) and runs it slightly
      // fast (the overlay's baked-in rate). Enforced here so it also recovers after an export, which leaves
      // the element muted and at 1×.
      const narrated = overlaysRef.current.filter(o => o.audioId);
      const wantMuted = narrated.length > 0;
      const wantRate = narrated.length ? Math.max(1, ...narrated.map(o => o.audioRate ?? 1)) : 1;
      if (v.muted !== wantMuted) v.muted = wantMuted;
      if (v.playbackRate !== wantRate) v.playbackRate = wantRate;
      const ct = v.currentTime;
      for (const o of overlaysRef.current) {
        const el = els.get(o.id);
        if (!el || !o.audioId) continue;
        // Source time → audio time: the video advances `audioRate`× faster than the voice.
        const rel = (ct - (o.audioStart ?? o.start)) / (o.audioRate ?? 1);
        const within = rel >= 0 && rel < (o.audioDuration ?? 0);
        if (v.paused || !within) {
          if (!el.paused) el.pause();
          if (within) el.currentTime = Math.max(0, rel);   // scrub-while-paused keeps it primed
          continue;
        }
        if (Math.abs(el.currentTime - rel) > 0.3) el.currentTime = rel;
        if (el.paused) void el.play().catch(() => { /* autoplay policy — user will interact */ });
      }
    };
    v.addEventListener('timeupdate', sync);
    v.addEventListener('play', sync);
    v.addEventListener('pause', sync);
    v.addEventListener('seeked', sync);
    return () => {
      v.removeEventListener('timeupdate', sync);
      v.removeEventListener('play', sync);
      v.removeEventListener('pause', sync);
      v.removeEventListener('seeked', sync);
      for (const el of els.values()) el.pause();
    };
  }, [videoSrc]);
  useEffect(() => () => {
    for (const el of overlayAudioElsRef.current.values()) { el.pause(); el.removeAttribute('src'); }
    overlayAudioElsRef.current.clear();
    // Revoke the overlay object URLs this canvas minted (image + narration WAV) so cycling selection through
    // many reels doesn't pin tens of MB of blobs until reload. The underlying blobs live in IndexedDB and
    // re-mint fresh URLs on the next mount — so do NOT delete them here.
    for (const o of overlaysRef.current) {
      if (o.src) URL.revokeObjectURL(o.src);
      if (o.audioSrc) URL.revokeObjectURL(o.audioSrc);
      if (o.coverSrc) URL.revokeObjectURL(o.coverSrc);
    }
  }, []);

  // Background music: a quiet loop under playback (position-agnostic ambience — no seek sync).
  // The export mixes the same track at the same gain, so preview matches the MP4.
  const musicIdRef = useRef<string | null>(musicId);
  musicIdRef.current = musicId;
  const bgBlurRef = useRef<boolean>(!!bgBlur);
  bgBlurRef.current = !!bgBlur;
  const backdropScratchRef = useRef<OffscreenCanvas | null>(null);
  const thumbnailIdRef = useRef<string | null>(thumbnailId);
  thumbnailIdRef.current = thumbnailId;
  const musicVolumeRef = useRef<number>(musicVolume ?? DEFAULT_MUSIC_VOLUME);
  musicVolumeRef.current = musicVolume ?? DEFAULT_MUSIC_VOLUME;
  const musicElRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const track = trackById(musicId);
    const v = videoRef.current;
    if (!track || !v) return;
    const el = new Audio(trackStreamSrc(track));
    el.loop = true;
    el.volume = musicVolumeRef.current;
    el.preload = 'auto';
    musicElRef.current = el;
    const sync = () => {
      if (v.paused) { if (!el.paused) el.pause(); }
      else if (el.paused) void el.play().catch(() => { /* autoplay policy — user will interact */ });
    };
    v.addEventListener('play', sync);
    v.addEventListener('pause', sync);
    sync();
    return () => {
      v.removeEventListener('play', sync);
      v.removeEventListener('pause', sync);
      el.pause();
      el.removeAttribute('src');
      if (musicElRef.current === el) musicElRef.current = null;
    };
  }, [musicId, videoSrc, videoRef]);
  useEffect(() => {
    if (musicElRef.current) musicElRef.current.volume = musicVolume ?? DEFAULT_MUSIC_VOLUME;
  }, [musicVolume]);

  // Lazily decode an overlay's image for the draw loops.
  const getOverlayImg = useCallback((o: ImageOverlay): HTMLImageElement | null => {
    if (!o.src) return null;
    // The erase-mode cover atlas rides the same map under its own id — drawImageOverlays looks it
    // up by o.coverAtlasId, so decoding it here keeps one decode path for everything the draw needs.
    if (o.coverAtlasId && o.coverSrc && !overlayImgsRef.current.has(o.coverAtlasId)) {
      const atlas = new Image();
      atlas.src = o.coverSrc;
      overlayImgsRef.current.set(o.coverAtlasId, atlas);
    }
    let img = overlayImgsRef.current.get(o.id);
    if (!img) { img = new Image(); img.src = o.src; overlayImgsRef.current.set(o.id, img); }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }, []);

  // ── Overlay canvas interactions: drag to move, corner handle to resize (aspect kept) ──
  const isDraggingRef = useRef(false);   // an overlay gesture is live → draw at full framerate
  const overlayDragRef = useRef<{ id: string; mode: 'move' | 'resize'; startX: number; startY: number; base: ImageOverlay } | null>(null);
  const startOverlayDrag = useCallback((e: React.PointerEvent, id: string, mode: 'move' | 'resize') => {
    e.preventDefault(); e.stopPropagation();
    const o = overlaysRef.current.find(x => x.id === id);
    if (!o) return;
    setSelectedOverlayId(id);
    overlayDragRef.current = { id, mode, startX: e.clientX, startY: e.clientY, base: { ...o } };
    isDraggingRef.current = true;
    const onMove = (ev: PointerEvent) => {
      const drag = overlayDragRef.current; if (!drag) return;
      const rect = canvasRef.current?.getBoundingClientRect(); if (!rect || rect.width === 0) return;
      const scale = rect.width / CANVAS_W;   // includes DISPLAY_SCALE and the page's CSS zoom
      const dx = (ev.clientX - drag.startX) / scale;
      const dy = (ev.clientY - drag.startY) / scale;
      const b = drag.base;
      let patch: Partial<ImageOverlay>;
      if (drag.mode === 'move') {
        patch = {
          x: Math.max(-b.w + 40, Math.min(CANVAS_W - 40, b.x + dx)),
          y: Math.max(-b.h + 40, Math.min(CANVAS_H - 40, b.y + dy)),
        };
      } else {
        const w = Math.max(60, b.w + dx);
        patch = { w, h: w * (b.h / b.w) };
      }
      commitOverlays(overlaysRef.current.map(x => (x.id === drag.id ? { ...x, ...patch } : x)), { silent: true });
    };
    const onUp = () => {
      overlayDragRef.current = null;
      isDraggingRef.current = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      notifyFraming();   // one autosave signal per gesture, not per pointermove
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [commitOverlays, notifyFraming]);

  // Click on an OCR line highlight: with a voice brush armed, paint the line with that voice (click again to
  // unpaint back to the default voice); otherwise flip the line in/out of the narration.
  const ocrBrushRef = useRef(ocrBrush); ocrBrushRef.current = ocrBrush;

  // Add-missing-text box drawing: pointer-drag in overlay-local FRACTIONS (the OcrTextLine bbox
  // space), previewed live, completed upward on release. Armed by the flyout via manualLineDraft.
  const [drawRect, setDrawRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const onManualLineRef = useRef(onManualLine); onManualLineRef.current = onManualLine;
  const startManualDraw = useCallback((e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fx = (cx: number) => Math.min(1, Math.max(0, (cx - box.left) / box.width));
    const fy = (cy: number) => Math.min(1, Math.max(0, (cy - box.top) / box.height));
    const x0 = fx(e.clientX), y0 = fy(e.clientY);
    setDrawRect({ x0, y0, x1: x0, y1: y0 });
    const onMove = (ev: PointerEvent) => setDrawRect({ x0, y0, x1: fx(ev.clientX), y1: fy(ev.clientY) });
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDrawRect(null);
      const rect = { x0: Math.min(x0, fx(ev.clientX)), y0: Math.min(y0, fy(ev.clientY)), x1: Math.max(x0, fx(ev.clientX)), y1: Math.max(y0, fy(ev.clientY)) };
      // A sub-2% box is a slip, not a line — ignore it rather than minting an invisible sliver.
      if (rect.x1 - rect.x0 > 0.02 && rect.y1 - rect.y0 > 0.01) onManualLineRef.current?.(rect);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);
  const toggleOcrLine = useCallback((id: string, idx: number) => {
    const brush = ocrBrushRef.current;
    commitOverlays(overlaysRef.current.map(x => (x.id === id && x.ocrLines
      ? {
        ...x,
        ocrLines: x.ocrLines.map((l, i) => {
          if (i !== idx) return l;
          if (brush) {
            return l.voiceId === brush.voiceId
              ? { ...l, voiceId: undefined }
              : { ...l, voiceId: brush.voiceId, enabled: true, erased: false };   // painting a voice implies narrating it
          }
          // Erase-mode overlays cycle THREE states — narrated → silent-but-visible (cover lifts with
          // the image) → erased (cover never lifts; the text is removed from the video) → narrated.
          // Overlays without covers keep the plain two-state toggle.
          if (!x.coverPatches?.length) return { ...l, enabled: !l.enabled };
          if (l.enabled) return { ...l, enabled: false, erased: false };
          if (!l.erased) return { ...l, enabled: false, erased: true };
          return { ...l, enabled: true, erased: false };
        }),
      }
      : x)));
  }, [commitOverlays]);

  const removeOverlayFn = useCallback((id: string) => {
    const doomed = overlaysRef.current.find(x => x.id === id);
    if (doomed?.src) URL.revokeObjectURL(doomed.src);
    if (doomed?.audioSrc) URL.revokeObjectURL(doomed.audioSrc);
    if (doomed?.audioId) void deleteOverlayImage(doomed.audioId);
    if (doomed?.coverSrc) URL.revokeObjectURL(doomed.coverSrc);
    if (doomed?.coverAtlasId) { void deleteOverlayImage(doomed.coverAtlasId); overlayImgsRef.current.delete(doomed.coverAtlasId); }
    const audioEl = overlayAudioElsRef.current.get(id);
    if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); overlayAudioElsRef.current.delete(id); }
    overlayImgsRef.current.delete(id);
    commitOverlays(overlaysRef.current.filter(x => x.id !== id));
    setSelectedOverlayId(prev => (prev === id ? null : prev));
    // Deleting the last narration: restore the clip's audio (un-mute, un-speed) right away rather than
    // waiting for the sync() loop's next timeupdate.
    const v = videoRef.current;
    if (v && !overlaysRef.current.some(x => x.audioId)) { v.muted = false; v.playbackRate = 1; }
    void deleteOverlayImage(id);
  }, [commitOverlays]);

  // Backspace/Delete removes the selected overlay — matching every canvas editor. Guarded so typing in an
  // input/textarea never deletes anything.
  useEffect(() => {
    if (!selectedOverlayId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      // The workspace stays mounted behind the Home screen, so a Delete there would silently drop this
      // reel's selected overlay AND its stored blob. offsetParent is null exactly when hidden.
      if (!canvasRef.current || canvasRef.current.offsetParent === null) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      removeOverlayFn(selectedOverlayId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedOverlayId, removeOverlayFn]);

  const { isRecording, recProgress, recStatus, startRecording, cancelRecording } = useMemeRecording({
    canvasRef, videoRef, rowNumber, videoId,
    boxRef, videoOffsetRef, videoScaleRef,
    trimStartRef, trimEndRef, includeEditRef,
    overlayCaption, exportTitle, exportDescription,
    overlaysRef, overlayImgsRef,
    musicIdRef, musicVolumeRef,
    bgBlurRef,
    thumbnailIdRef,
  });

  // Re-apply a saved framing (pan/zoom/trim/overlays). Setters from useState/useVideoLoading are stable.
  const applyFramingFn = useCallback((f: Framing) => {
    // A meme reel is ALWAYS the full-bleed band, so only the vertical window (y/h) is the user's crop — x/w
    // are pinned to the canvas rather than trusted from the blob, which keeps a box saved under some other
    // layout from letterboxing the video.
    if (f.box) {
      const y = Math.max(0, Math.min(CANVAS_H, f.box.y));
      const h = Math.max(1, Math.min(CANVAS_H - y, f.box.h));
      const b = { x: 0, y, w: CANVAS_W, h };
      boxRef.current = b;
      setBox(b);
    }
    if (f.videoOffset) videoOffsetRef.current = { ...f.videoOffset };
    if (typeof f.videoScale === 'number') {
      const c = Math.max(0.5, Math.min(3, f.videoScale));
      videoScaleRef.current = c; setVideoScale(c);
    }
    if (typeof f.trimStart === 'number') { trimStartRef.current = f.trimStart; setTrimStart(f.trimStart); }
    if (typeof f.trimEnd === 'number') { trimEndRef.current = f.trimEnd; setTrimEnd(f.trimEnd); }
    if (typeof f.includeEdit === 'boolean') { includeEditRef.current = f.includeEdit; setIncludeEdit(f.includeEdit); }
    // Only touch the cuts when the framing actually carries the field. A mid-session sidecar write (music,
    // blur…) MINTS this reel's framingMap entry, which flips initialFraming null→truthy and fires this apply
    // for the first time — unconditionally nulling it there would silently drop the user's live cuts.
    if (f.segments !== undefined) {
      timelineSegmentsRef.current = Array.isArray(f.segments) && f.segments.length
        ? f.segments.map(s => ({ start: s.start, end: s.end }))
        : null;
    }
    // Overlays are seeded once — usually by the mount effect below (which runs BEFORE the video loads).
    // Guarded so this late apply (fired after the video finally loads) can't re-commit the saved overlays and
    // WIPE a narration generated in between.
    if (Array.isArray(f.overlays) && !overlaysSeededRef.current) {
      overlaysSeededRef.current = true;
      commitOverlays(f.overlays.map(o => ({ ...o })), { silent: true });   // src/audioSrc re-hydrate from IndexedDB
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed overlays from saved framing on mount, INDEPENDENT of video readiness: the meme image and its
  // narration live in IndexedDB, so a slow/large clip must not gate them. Runs once; the guarded apply above
  // is then a no-op for overlays.
  useEffect(() => {
    if (overlaysSeededRef.current) return;
    const ov = initialFraming?.overlays;
    if (!Array.isArray(ov) || ov.length === 0) return;
    overlaysSeededRef.current = true;
    commitOverlays(ov.map(o => ({ ...o })), { silent: true });
    // Auto-select the meme: its OCR line highlights (click-to-skip, voice brush) render only on the
    // SELECTED overlay, and a seeded reel otherwise opens with nothing selected — the user stares at
    // their image wondering where the clickable lines went (a live addImageOverlay already selects).
    const meme = ov.find(o => o.ocrLines?.length);
    if (meme) setSelectedOverlayId(meme.id);
  }, [initialFraming, commitOverlays]);

  // useVideoLoading resets framing whenever a video (re)loads. So restore a saved reel's framing only AFTER
  // loading finishes, once per source — otherwise the reset would clobber it.
  const videoSrcRef = useRef(videoSrc); videoSrcRef.current = videoSrc;
  const initialFramingRef = useRef(initialFraming); initialFramingRef.current = initialFraming;
  const isVideoLoadingRef = useRef(isVideoLoading); isVideoLoadingRef.current = isVideoLoading;
  useEffect(() => {
    if (isVideoLoading || !initialFraming || !videoSrc) return;
    if (framingAppliedSrcRef.current === videoSrc) return;
    // The SAME reel's src can flip mid-session (an IndexedDB byte-restore swaps a proxy URL for a blob).
    // Re-applying the mount-time framing there would revert every edit made since, so once this canvas has
    // restored, a later src change only re-stamps the latch — the live framing already IS the truth.
    const alreadyRestored = framingAppliedSrcRef.current !== null;
    framingAppliedSrcRef.current = videoSrc;
    if (alreadyRestored) return;
    applyFramingFn(initialFraming);
  }, [isVideoLoading, initialFraming, videoSrc, applyFramingFn]);

  // Also fire on state-backed framing changes (crop resize / zoom / trim / include-edit). Pan is covered by
  // useDrag's onChange above. Skips the initial mount.
  const framingMountedRef = useRef(false);
  useEffect(() => {
    if (!framingMountedRef.current) { framingMountedRef.current = true; return; }
    notifyFraming();
  }, [box, videoScale, trimStart, trimEnd, includeEdit, notifyFraming]);

  useImperativeHandle(ref, () => ({
    startDownload: () => (!isRecording ? startRecording().then(() => undefined) : Promise.resolve()),
    exportBlob: async () => (!isRecording ? ((await startRecording({ returnBlob: true })) ?? null) : null),
    cancelExport: cancelRecording,
    play: () => { const v = videoRef.current; if (v) v.play()?.catch(() => {}); },
    pause: () => { const v = videoRef.current; if (v) v.pause(); },
    // Coalesce rapid scrub seeks: only one seek in flight, always re-target to the latest position when it
    // completes (drops intermediate targets) — see onSeeked in the draw loop.
    seekTo: (t: number) => {
      const v = videoRef.current; if (!v) return;
      if (v.seeking) { pendingSeekRef.current = t; }
      else { pendingSeekRef.current = null; v.currentTime = t; }
    },
    setTrimRange: (start: number, end: number) => {
      trimStartRef.current = start; trimEndRef.current = end;
      setTrimStart(start); setTrimEnd(end);
    },
    resetTrim: () => {
      trimStartRef.current = 0; trimEndRef.current = videoDuration;
      setTrimStart(0); setTrimEnd(videoDuration);
      timelineSegmentsRef.current = null;   // cuts are part of the trim — reset clears them too
      const v = videoRef.current; if (v) v.currentTime = 0;
    },
    zoomIn, zoomOut, resetZoom,
    setZoom: (s: number) => { const c = Math.max(0.5, Math.min(3, s)); videoScaleRef.current = c; setVideoScale(c); },
    resetBox,
    centerBox: centerEverything,
    setIncludeEdit: (v: boolean) => { setIncludeEdit(v); includeEditRef.current = v; },
    getVideoElement: () => videoRef.current,
    useLocalBlob: swapToLocalBlob,   // timeline asks us to swap to the downloaded blob (fast seeking)
    getTrimState: () => ({ trimStart, trimEnd, duration: videoDuration, includeEdit, videoScale }),
    setSegments: (segs: ClipSegment[] | null) => {
      timelineSegmentsRef.current = segs && segs.length ? segs.map(s => ({ ...s })) : null;
      // Trim-range changes already notify via state; interior cuts (same outer bounds) need this one.
      notifyFraming();
    },
    getSegments: () => timelineSegmentsRef.current,
    addImageOverlay: (id: string, src: string, name: string) => {
      const img = new Image();
      img.onload = () => {
        overlayImgsRef.current.set(id, img);
        const w = Math.round(CANVAS_W * 0.6);
        const h = Math.round(w * (img.naturalHeight / Math.max(1, img.naturalWidth)));
        const end = trimEndRef.current > 0 ? trimEndRef.current : (videoRef.current?.duration || 5);
        const o: ImageOverlay = {
          id, name, src,
          x: Math.round((CANVAS_W - w) / 2), y: Math.round((CANVAS_H - h) / 2), w, h,
          start: trimStartRef.current || 0, end,
        };
        commitOverlays([...overlaysRef.current, o]);
        setSelectedOverlayId(id);
      };
      img.src = src;
    },
    updateOverlay: (id: string, patch: Partial<Omit<ImageOverlay, 'id' | 'src'>>) => {
      commitOverlays(overlaysRef.current.map(x => {
        if (x.id !== id) return x;
        const next = { ...x, ...patch };
        // A timeline MOVE (both edges shift, length preserved) carries the narration with it: the audio
        // anchor and every reveal step are absolute source times, so shift them by the same delta. A pure
        // trim (one edge) leaves them anchored.
        if (patch.start != null && patch.end != null) {
          const delta = patch.start - x.start;
          const isMove = Math.abs((patch.end - patch.start) - (x.end - x.start)) < 0.002;
          if (isMove && Math.abs(delta) > 0.0001) {
            if (next.audioStart != null) next.audioStart += delta;
            // Cover lift times are absolute source times too; null (never lifts) stays null.
            if (next.coverLifts) next.coverLifts = next.coverLifts.map(t => (t === null ? null : t + delta));
            if (next.reveals) next.reveals = next.reveals.map(r => ({ t: r.t + delta, h: r.h }));
          }
        }
        return next;
      }));
    },
    removeOverlay: removeOverlayFn,
    getOverlays: () => overlaysRef.current,
    // No replaceRedditCard: that is the bulk thread builder pushing a rebuilt card into a mounted reel, and a
    // meme reel has no thread. It is one of the ref contract's optional methods, so this canvas simply
    // doesn't answer it.
    setOverlayNarration: (id, n) => {
      commitOverlays(overlaysRef.current.map(x => (x.id === id ? {
        ...x,
        reveals: n.reveals,
        coverLifts: n.coverLifts,
        audioId: n.audioId,
        audioStart: n.audioStart,
        audioDuration: n.audioDuration,
        audioSrc: n.audioSrc,
        audioRate: n.audioRate,
        audioTakes: n.audioTakes,
        // Extend the window so the voice finishes inside it, +2s of tail (source-time: the video runs
        // `audioRate`× faster than the voice).
        end: Math.max(x.end, n.audioStart + (n.audioDuration + 2) * n.audioRate),
      } : x)));
    },
    clearOverlayNarration: (id) => {
      // Strip the narration (audio + reveals) but keep the image and its ocrLines, so it can be re-narrated
      // (the Narrate step skips an already-voiced reel). GC the stored audio blob.
      const o = overlaysRef.current.find(x => x.id === id);
      if (!o) return;
      if (o.audioSrc) URL.revokeObjectURL(o.audioSrc);
      if (o.audioId) void deleteOverlayImage(o.audioId);
      const el = overlayAudioElsRef.current.get(id);
      if (el) { el.pause(); el.removeAttribute('src'); overlayAudioElsRef.current.delete(id); }
      const v = videoRef.current;
      if (v && !overlaysRef.current.some(x => x.id !== id && x.audioId)) { v.muted = false; v.playbackRate = 1; }
      commitOverlays(overlaysRef.current.map(x => (x.id === id ? {
        ...x,
        reveals: undefined, audioId: undefined, audioStart: undefined, coverLifts: undefined,
        audioDuration: undefined, audioSrc: undefined, audioRate: undefined, audioTakes: undefined,
      } : x)));
    },
    getFraming: (): Framing | null =>
      // Return null while boxRef is still the placeholder (NOT the reel's band), so the autosave/capture
      // never persist it: (a) while the video is loading; (b) a saved reel whose framing hasn't been applied
      // for the current source yet.
      (isVideoLoadingRef.current || (initialFramingRef.current && framingAppliedSrcRef.current !== videoSrcRef.current)) ? null : ({
        box: { ...boxRef.current },
        videoOffset: { ...videoOffsetRef.current },
        videoScale: videoScaleRef.current,
        trimStart: trimStartRef.current,
        trimEnd: trimEndRef.current,
        includeEdit: includeEditRef.current,
        segments: timelineSegmentsRef.current ?? undefined,
        overlays: overlaysRef.current.length
          ? overlaysRef.current.map(({ src: _src, audioSrc: _audioSrc, coverSrc: _coverSrc, ...rest }) => rest)
          : undefined,
        musicId: musicIdRef.current ?? undefined,
        musicVolume: musicIdRef.current ? musicVolumeRef.current : undefined,
      }),
    applyFraming: applyFramingFn,
  }), [isRecording, startRecording, cancelRecording, videoDuration, trimStart, trimEnd, includeEdit, videoScale, applyFramingFn, swapToLocalBlob, commitOverlays, removeOverlayFn]);

  const onRecordingStateChangeRef = useRef(onRecordingStateChange);
  useEffect(() => { onRecordingStateChangeRef.current = onRecordingStateChange; });
  useEffect(() => {
    onRecordingStateChangeRef.current?.({ isRecording, recProgress, recStatus });
  }, [isRecording, recProgress, recStatus]);

  // ── Main draw loop ────────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    const v = videoRef.current;
    if (!canvas || !v) return;
    const video = v;
    const ctx = canvas.getContext('2d')!;
    let active = true;

    let lastDrawTime = 0;
    // Force an immediate redraw whenever the video seeks (timeline scrub, frame-step, J/K/L) so the preview
    // tracks the playhead at full framerate even while paused.
    const onSeeked = () => {
      lastDrawTime = 0;
      const p = pendingSeekRef.current;
      if (p != null) { pendingSeekRef.current = null; if (Math.abs(p - video.currentTime) > 0.001) video.currentTime = p; }
    };
    video.addEventListener('seeked', onSeeked);

    function draw() {
      if (!active) return;
      raf.current = requestAnimationFrame(draw);

      // Hold the last frame while the <video> is mid-swap to a local blob (avoids a flash).
      if (blobSwapRef.current) return;
      // Hold the last frame while a seek is in flight with no decoded frame ready — drawing it would paint
      // black/garbage. We repaint on 'seeked' the moment the frame lands.
      if (video.seeking && video.readyState < 3) return;

      // Throttle to ~10fps when paused and idle; bypass while dragging for smooth 60fps.
      if (video.paused && !isDraggingRef.current) {
        const now = performance.now();
        if (now - lastDrawTime < 100) return;
        lastDrawTime = now;
      }

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        // Full-bleed composite (see drawing/fullBleedVideo): the frame is cover-fit to the WHOLE canvas plus
        // the manual zoom/pan, and only the CLIP window follows the crop bars. useMemeRecording exports
        // through the same helper, so the preview and the MP4 composite from one formula.
        const { draw, clip } = fullBleedVideoRects(
          video.videoWidth, video.videoHeight, videoScaleRef.current, videoOffsetRef.current, boxRef.current,
        );

        // Blurred-video letterbox fill: paint the CROPPED-VISIBLE slice of the frame cover-fit over the whole
        // canvas (blurred + dimmed), so the bars echo only what the viewer actually sees.
        if (bgBlurRef.current) {
          const vis = visibleSourceRect(draw, clip, video.videoWidth, video.videoHeight);
          drawBlurredBackdrop(ctx, video, video.videoWidth, video.videoHeight, backdropScratchRef.current ??= createBackdropScratch(), vis);
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(clip.x, clip.y, clip.w, clip.h);
        ctx.clip();
        ctx.drawImage(video, draw.dx, draw.dy, draw.dw, draw.dh);
        ctx.restore();
      }

      // The meme itself, topmost — un-cropping per its reveal steps as the narration reaches each line.
      for (const o of overlaysRef.current) getOverlayImg(o);   // lazy-decode into the shared map
      drawImageOverlays(ctx, overlaysRef.current, overlayImgsRef.current, video.currentTime);
    }

    draw();
    return () => { active = false; cancelAnimationFrame(raf.current); video.removeEventListener('seeked', onSeeked); };
  // videoScale/box/overlays intentionally omitted: the loop reads their refs directly, so including them
  // would restart the RAF loop on every zoom step or overlay drag causing a visible frame drop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSrc]);

  // ── Interaction handlers ──────────────────────────────────────────────────────

  // Back to the full-bleed band: uncropped, unpanned, unzoomed.
  function resetBox() {
    const b = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
    boxRef.current = b;
    setBox(b);
    videoOffsetRef.current = { x: 0, y: 0 };
    videoScaleRef.current = 1;
    setVideoScale(1);
  }

  // Centre the visible (cropped) band vertically, panning the video by the same delta so the framing inside
  // the crop travels with it. Re-centring an already-centred reel is a no-op (idempotent).
  function centerEverything() {
    const b = boxRef.current;
    const dy = (CANVAS_H - b.h) / 2 - b.y;
    boxRef.current = { ...b, y: b.y + dy };
    videoOffsetRef.current = { x: videoOffsetRef.current.x, y: videoOffsetRef.current.y + dy };
    setBox({ ...boxRef.current });
  }

  function zoomIn() { const n = Math.min(3, videoScaleRef.current + 0.05); videoScaleRef.current = n; setVideoScale(n); }
  function zoomOut() { const n = Math.max(0.5, videoScaleRef.current - 0.05); videoScaleRef.current = n; setVideoScale(n); }
  function resetZoom() { videoScaleRef.current = 1; setVideoScale(1); }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div
      className="relative"
      style={{ width: CANVAS_W * DISPLAY_SCALE, height: CANVAS_H * DISPLAY_SCALE, overflow: 'visible' }}
    >
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        style={{ width: CANVAS_W * DISPLAY_SCALE, height: CANVAS_H * DISPLAY_SCALE }}
        className="block border border-line"
      />
      <VideoOverlays isVideoLoading={isVideoLoading} videoError={videoError} />
      {/* Crop bars (tc/bc): drag the top/bottom edge of the video box to crop it vertically — the draw loop
          and export clip to the box, so what you see is what exports. Always shown: a meme floats OVER the
          clip rather than covering it, so the footage is visible and worth framing. */}
      {videoDuration > 0 && !isRecording && (
        <>
          <div
            className="pointer-events-none absolute border border-white/35"
            style={{ left: box.x * DISPLAY_SCALE, top: box.y * DISPLAY_SCALE, width: box.w * DISPLAY_SCALE, height: box.h * DISPLAY_SCALE }}
          />
          {([['tc', box.y], ['bc', box.y + box.h]] as const).map(([h, edgeY]) => (
            <div
              key={h}
              onMouseDown={e => startCropDrag(e, h)}
              className="absolute flex items-center justify-center cursor-ns-resize"
              style={{ left: box.x * DISPLAY_SCALE, top: edgeY * DISPLAY_SCALE - 7, width: box.w * DISPLAY_SCALE, height: 14, touchAction: 'none' }}
              role="slider"
              aria-label={h === 'tc' ? 'Crop video top' : 'Crop video bottom'}
              tabIndex={-1}
            >
              <div className="h-[5px] w-14 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.6)] ring-1 ring-black/30" />
            </div>
          ))}
        </>
      )}
      {/* Image-overlay editing chrome: one positioned div per overlay (drag = move, corner = resize,
          × = delete), plus the OCR line highlights that decide what gets narrated. Shown only while the
          playhead is inside the overlay's window — matching what the canvas is actually drawing. */}
      {overlays.map(o => {
        if (!o.src || currentTime < o.start || currentTime > o.end) return null;
        const sel = selectedOverlayId === o.id;
        // A narrated meme draws center-pinned (reveal front at the canvas midline) — the editing chrome
        // tracks that drawn position so the highlights always sit on the image's actual pixels.
        const chromeTop = o.reveals?.length ? 960 - o.h * overlayRevealFraction(o, currentTime) : o.y;
        return (
          <div
            key={o.id}
            role="button"
            aria-label={`Image overlay ${o.name}`}
            onPointerDown={e => (manualLineDraft && sel ? startManualDraw(e) : startOverlayDrag(e, o.id, 'move'))}
            className={`absolute ${sel ? 'ring-2 ring-accent' : 'ring-1 ring-transparent hover:ring-accent-border'} cursor-move`}
            style={{
              left: o.x * DISPLAY_SCALE, top: chromeTop * DISPLAY_SCALE,
              width: o.w * DISPLAY_SCALE, height: o.h * DISPLAY_SCALE,
              touchAction: 'none',
            }}
          >
            {/* OCR text lines as clickable narration highlights: enabled lines glow (tinted by their assigned
                voice's color), excluded lines dim with a strike. With a voice brush armed, clicking paints
                the line with that voice. Shown while the overlay is selected. */}
            {sel && drawRect && (
              <span
                aria-hidden
                className="absolute rounded-[3px] ring-2 ring-accent bg-accent/20 pointer-events-none"
                style={{
                  left: Math.min(drawRect.x0, drawRect.x1) * o.w * DISPLAY_SCALE,
                  top: Math.min(drawRect.y0, drawRect.y1) * o.h * DISPLAY_SCALE,
                  width: Math.abs(drawRect.x1 - drawRect.x0) * o.w * DISPLAY_SCALE,
                  height: Math.abs(drawRect.y1 - drawRect.y0) * o.h * DISPLAY_SCALE,
                }}
              />
            )}
            {sel && o.ocrLines?.map((ln, i) => {
              const voiceColor = ln.voiceId ? ocrVoiceColors?.[ln.voiceId] : undefined;
              return (
                <button
                  key={i}
                  type="button"
                  title={`${ocrBrush ? 'Click to paint with the armed voice'
                    : ln.enabled ? (o.coverPatches?.length ? 'Click to mute — the text stays visible' : 'Click to skip')
                      : ln.erased ? 'ERASED from the video — click to narrate again'
                        : o.coverPatches?.length ? 'Muted (still visible) — click to erase it from the video' : 'Click to narrate'}: “${ln.text}”`}
                  aria-label={`${ocrBrush ? 'Paint voice on' : ln.enabled ? 'Mute' : ln.erased ? 'Narrate' : 'Erase or narrate'}: ${ln.text}`}
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); toggleOcrLine(o.id, i); }}
                  className={`absolute rounded-[3px] ring-1 transition-colors ${ocrBrush ? 'cursor-crosshair' : ''} ${ln.enabled
                    ? (voiceColor ? '' : 'ring-accent bg-accent/15 hover:bg-accent/25')
                    : ln.erased ? 'ring-danger-border bg-black/80 hover:bg-black/70'
                      : 'ring-line bg-black/60 hover:bg-black/45'}`}
                  style={{
                    left: ln.x0 * o.w * DISPLAY_SCALE - 2, top: ln.y0 * o.h * DISPLAY_SCALE - 2,
                    width: (ln.x1 - ln.x0) * o.w * DISPLAY_SCALE + 4, height: (ln.y1 - ln.y0) * o.h * DISPLAY_SCALE + 4,
                    ...(ln.enabled && voiceColor ? { boxShadow: `inset 0 0 0 1px ${voiceColor}`, background: `${voiceColor}2b` } : {}),
                  }}
                >
                  {!ln.enabled && <span className="absolute left-0 right-0 top-1/2 h-px bg-danger-text/80" aria-hidden />}
                  {ln.erased && <span className="absolute left-0 right-0 top-1/2 -translate-y-[3px] h-px bg-danger-text/80" aria-hidden />}
                </button>
              );
            })}
            {sel && (
              <>
                <div
                  onPointerDown={e => startOverlayDrag(e, o.id, 'resize')}
                  className="absolute -right-1.5 -bottom-1.5 size-3 rounded-full bg-accent cursor-nwse-resize"
                  style={{ touchAction: 'none' }}
                  aria-label="Resize overlay"
                />
                <button
                  type="button"
                  aria-label="Remove overlay"
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); removeOverlayFn(o.id); }}
                  className="absolute -right-2.5 -top-2.5 grid size-5 place-items-center rounded-full bg-surface-overlay border border-line text-fg-2 hover:text-danger-text"
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </>
            )}
          </div>
        );
      })}
      <video
        ref={videoRef}
        crossOrigin="anonymous"
        // Always eager: the clip is the visible background of every meme reel, so a deferred load would show
        // a black band under the image in the editor.
        preload="auto"
        loop playsInline
        onPlay={() => {
          const v = videoRef.current;
          if (v && v.currentTime < trimStartRef.current) v.currentTime = trimStartRef.current;
        }}
        onTimeUpdate={() => {
          const v = videoRef.current;
          if (!v) return;
          setCurrentTime(v.currentTime);
          // The narration is the reel's length: loop the clip back to the trim start beneath it, exactly as
          // the exporter loops the footage when the voice outruns the clip.
          if (trimEndRef.current > 0 && v.currentTime >= trimEndRef.current) v.currentTime = trimStartRef.current;
        }}
        onLoadedMetadata={() => {
          const v = videoRef.current;
          if (!v) return;
          // A metadata-only load holds NO frame, so seek to force a poster to decode — otherwise the canvas
          // draws black (readyState stays 1). t=1 is a nicer poster than a black first frame.
          if (v.duration > 1) v.currentTime = 1;
        }}
        onError={(e) => {
          const v = e.target as HTMLVideoElement;
          const errorCode = v.error?.code;
          if (!errorCode) return;
          const msgs: Record<number, string> = {
            4: 'Video format not supported. Try refreshing the page.',
            3: 'Video decode error. The file may be corrupted.',
            2: 'Network error. Check your internet connection.',
          };
          setVideoError(msgs[errorCode] ?? 'Failed to load video. The link may be invalid.');
          onVideoError?.();
        }}
        src={videoSrc}
        style={{ display: 'none' }}
      />
    </div>
  );
});
