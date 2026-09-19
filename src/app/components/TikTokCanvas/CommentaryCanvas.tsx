'use client';

import { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react';

import { CANVAS_W, CANVAS_H, DISPLAY_SCALE } from './constants';
import type { Box, ClipSegment, Framing, ImageOverlay, RecordingState, TikTokCanvasRef } from './types';
import { getOverlayImage, deleteOverlayImage } from '@/lib/localVideoStore';
import { drawImageOverlays } from './drawing/drawOverlays';
import { drawCommentaryCaptions } from './drawing/commentaryCaptions';
import { drawBlurredBackdrop, createBackdropScratch, visibleSourceRect } from './drawing/blurBackdrop';
import { fullBleedVideoRects } from './drawing/fullBleedVideo';
import { COMMENTARY_DUCK_GAIN } from '@/lib/commentaryPlan';
import { VideoOverlays } from './ui/VideoOverlays';
import { useVideoLoading } from './hooks/useVideoLoading';
import { useDrag } from './hooks/useDrag';
import { useCommentaryRecording } from './hooks/useCommentaryRecording';
import { trackById, trackStreamSrc, DEFAULT_MUSIC_VOLUME } from '@/lib/music';

// The COMMENTARY canvas. A commentary reel is one thing only: a full-bleed uploaded/linked video, an
// ElevenLabs voice-over INTRO over its start (the video keeps its own audio, ducked under the voice), and
// karaoke captions on the intro clock. No tweet header, no reel cells, no free elements, no caption template
// and no market row — so none of that machinery lives here, nor the template plumbing that chose between them.
//
// This is a deliberate fork of TikTokCanvas (the Reddit/market path), not a wrapper: the two styles kept
// interfering through shared branches that were constants on this side. CanvasGrid already pinned this reel
// to defaultTwitterTemplateSettings() — a full-bleed band (bandX 0, bandY 0, 1080×1920, no corner radius, no
// cells) — so reelLayout/reelVideoRect collapse to "cover-fit the video to the whole canvas". That collapse
// lives in drawing/fullBleedVideo, which the exporter draws through too, so the preview and the MP4 composite
// from one formula rather than two copies (fullBleedVideo.test.ts pins it against the band math it replaced).

/** Props are the commentary subset of RedditCanvasProps: no logo/name/handle, no twitterSettings, no OCR
    brush, no custom thumbnail (all Reddit-only), and no eagerVideo/cropHandles toggles —
    a commentary reel always loads eagerly and always shows its crop bars. The REF type is the shared one
    (TikTokCanvasRef), so the workspace can mount either canvas for a reel without touching a single call —
    minus its Reddit-only methods (replaceRedditCard, setOverlayNarration), which are optional there and
    unimplemented here. */
export interface CommentaryCanvasProps {
  videoSrc: string;
  videoId?: string;
  rowNumber?: number;
  /** Generated YouTube title — used as the export filename when present (falls back to the caption). */
  exportTitle?: string;
  exportDescription?: string;
  onVideoError?: () => void;
  /** The reel's caption. Commentary draws none (its words are the karaoke captions); kept only as the
      export-filename fallback. */
  overlayCaption?: string;
  onRecordingStateChange?: (state: RecordingState) => void;
  /** Saved framing to restore once the video has (re)loaded — pan/zoom/trim/overlays of a saved reel. */
  initialFraming?: Framing | null;
  /** Fired whenever the user changes framing (crop/zoom/trim/pan) so the workspace can autosave it. */
  onFramingChange?: () => void;
  /** Fired with the current overlay list whenever it changes, so the workspace can hand it to the timeline. */
  onOverlaysChange?: (overlays: ImageOverlay[]) => void;
  /** Background-music track id (lib/music.ts): loops quietly under playback and mixes into the export. */
  musicId?: string | null;
  /** Music bed volume 0..1 (default DEFAULT_MUSIC_VOLUME) — same gain in preview and export. */
  musicVolume?: number | null;
  /** Fill the letterbox with a blurred cover-fit copy of the video (see Framing.bgBlur). */
  bgBlur?: boolean | null;
  /** IndexedDB key of a custom thumbnail still — held for a few frames at the start of the EXPORT only. */
  thumbnailId?: string | null;
}

export const CommentaryCanvas = forwardRef<TikTokCanvasRef, CommentaryCanvasProps>(function CommentaryCanvas({
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
  musicId = null,
  musicVolume = null,
  bgBlur = null,
  thumbnailId = null,
}: CommentaryCanvasProps, ref) {
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

  // Timeline clip list (multi-cut edits), owned by the canvas so it persists with the framing and
  // survives the timeline panel unmounting. null = simple trim; the timeline seeds itself from this.
  const timelineSegmentsRef = useRef<ClipSegment[] | null>(null);

  // ── Overlays — normally just the commentary INTRO (voice-over + captions, no image). Image layers can no
  //    longer be ADDED to a commentary reel (the rail's "Add image" is style-gated), but a reel saved before
  //    that gate still draws whatever it holds, inside its [start,end] window ──
  const [overlays, setOverlays] = useState<ImageOverlay[]>([]);
  const overlaysRef = useRef<ImageOverlay[]>([]);
  const overlaysSeededRef = useRef(false);   // overlays restored from initialFraming exactly once (mount-seed OR applyFraming)
  const overlayImgsRef = useRef<Map<string, HTMLImageElement>>(new Map());   // id → decoded image
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);

  // ── Hooks ────────────────────────────────────────────────────────────────────

  // Latches the src whose saved framing has been restored (set by the restore effect below). Declared
  // above useVideoLoading so the metadata handler can tell "already restored" from "fresh reel" and NOT
  // reset the user's crop/pan/trim when a deferred clip finally loads (on play). See H1 regression fix.
  const framingAppliedSrcRef = useRef<string | null>(null);
  // The commentary reel is ONE full-bleed band: the video covers the whole 1080×1920 canvas. That is exactly
  // the box defaultTwitterTemplateSettings() produced through reelLayout, so the seeded framing is unchanged —
  // it just no longer travels through a template.
  const {
    isVideoLoading, videoError, setVideoError,
    videoDuration, trimStart, trimEnd, setTrimStart, setTrimEnd,
    currentTime, setCurrentTime, trimStartRef, trimEndRef, swapToLocalBlob,
  } = useVideoLoading({
    videoRef, videoSrc, videoTargetW: CANVAS_W, videoBandHeight: CANVAS_H,
    boxRef, setBox, videoOffsetRef, videoScaleRef, setVideoScale, blobSwapRef, framingAppliedSrcRef,
  });

  // Video zoom is controlled ONLY by the Adjust flyout's Zoom slider (TikTokCanvasRef.setZoom) — a stray
  // scroll or trackpad pinch over a reel must never change its framing.

  // Notify the workspace when framing changes (crop resize, zoom, trim, OR panning the video inside the
  // crop). Panning only mutates videoOffsetRef, so useDrag's onChange (drag-end) is the signal for it.
  const onFramingChangeRef = useRef(onFramingChange);
  useEffect(() => { onFramingChangeRef.current = onFramingChange; });
  const notifyFraming = useCallback(() => onFramingChangeRef.current?.(), []);

  // Crop-bar dragging (tc/bc): resizes the video box; the draw loop + export clip to it, so dragging the
  // bars IS the crop. Commits framing on drag end (same signal as every other framing edit).
  const { startDrag: startCropDrag } = useDrag({ boxRef, setBox, canvasRef, onChange: notifyFraming });

  const onOverlaysChangeRef = useRef(onOverlaysChange);
  useEffect(() => { onOverlaysChangeRef.current = onOverlaysChange; });
  // Single write path for the overlay list: refs for the draw/export loops, state for the editing UI,
  // the workspace callback for the timeline, and (usually) a framing notification for autosave.
  const commitOverlays = useCallback((next: ImageOverlay[], opts: { silent?: boolean } = {}) => {
    overlaysRef.current = next;
    setOverlays(next);
    onOverlaysChangeRef.current?.(next);
    if (!opts.silent) notifyFraming();
  }, [notifyFraming]);

  // Re-hydrate restored overlays: a saved overlay comes back without `src`/`audioSrc` (object URLs don't
  // survive a reload) — load its blob from IndexedDB and mint a fresh URL. The intro carries audio only.
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
    }
  }, [overlays, commitOverlays]);

  // ── Intro voice preview: ONE <audio> for the voice-over, slaved to the video playhead ──
  // A commentary reel carries exactly one narration — the intro — and useCommentaryRecording mixes exactly
  // that one, so the preview deliberately voices nothing else either (a Reddit reel's per-card <audio> map
  // has no counterpart here).
  const introAudioRef = useRef<HTMLAudioElement | null>(null);

  // Playback phase. A commentary reel plays its clip TWICE (see lib/commentaryPlan): under the commentary
  // with its own audio heavily muted, then — the instant the voice ends — restarted from the beginning at
  // full volume. The VOICE is the phase clock, not the video: the clip may loop several times beneath a long
  // commentary, so the video's own playhead can't tell us how far in we are.
  const phaseRef = useRef<'intro' | 'main'>('intro');
  // Restart the composition from the top: clip at its start, voice rewound, back under the commentary.
  const restartComposition = useCallback(() => {
    const v = videoRef.current;
    const el = introAudioRef.current;
    phaseRef.current = 'intro';
    if (el) { el.pause(); el.currentTime = 0; }
    if (v) v.currentTime = trimStartRef.current;
  }, [trimStartRef]);
  // Our own rewind-to-clip-start seeks must not read as the user asking to replay from the top (below).
  const internalSeekRef = useRef(false);
  // Leave the commentary: restart the clip and hand it back its own audio.
  const enterMainPhase = useCallback(() => {
    const v = videoRef.current;
    const el = introAudioRef.current;
    phaseRef.current = 'main';
    if (el) { el.pause(); el.currentTime = 0; }
    if (v) {
      // Only flag a seek we actually perform: a no-op assignment fires no `seeked`, and the flag would then
      // sit armed and swallow the user's next scrub back to the start.
      const target = trimStartRef.current;
      if (Math.abs(v.currentTime - target) > 0.001) { internalSeekRef.current = true; v.currentTime = target; }
      v.volume = 1;
    }
  }, [trimStartRef]);

  useEffect(() => {
    const intro = overlays.find(o => o.intro && o.audioSrc);
    let el = introAudioRef.current;
    if (!intro) {
      if (el) { el.pause(); el.removeAttribute('src'); }
      return;
    }
    if (!el) { el = new Audio(); el.preload = 'auto'; introAudioRef.current = el; }
    if (el.src !== intro.audioSrc) el.src = intro.audioSrc!;
    // The voice ENDING is what ends phase A — the clip then restarts at full volume.
    const onEnded = () => enterMainPhase();
    el.addEventListener('ended', onEnded);
    return () => el?.removeEventListener('ended', onEnded);
  }, [overlays, enterMainPhase]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sync = () => {
      const intro = overlaysRef.current.find(o => o.intro && o.audioId);
      // The voice plays OVER the video, which keeps its own audio at its own speed — so unlike a Reddit
      // narration this never mutes or speeds up the element. Enforced here so playback also recovers after
      // an export, which leaves the element muted and at 1×.
      if (v.muted) v.muted = false;
      if (v.playbackRate !== 1) v.playbackRate = 1;

      // No commentary at all → the reel is just the clip, at full volume.
      if (!intro) {
        phaseRef.current = 'main';
        if (v.volume !== 1) v.volume = 1;
        return;
      }
      // The voice's <audio> is created only once its blob has re-hydrated from IndexedDB (async), so it can
      // be missing for the first moments of a reel that IS voiced. That is NOT "no commentary": latching the
      // phase to 'main' here silenced the voice for the whole playthrough. Hold the phase and wait — the next
      // sync (timeupdate fires continuously while playing) picks the element up.
      const el = introAudioRef.current;
      const underCommentary = phaseRef.current === 'intro';
      // Under the commentary the clip's own audio is pushed right down so the voice carries the frame;
      // afterwards it plays at full volume. The export mixes the same two gains.
      const wantVol = underCommentary ? COMMENTARY_DUCK_GAIN : 1;
      if (Math.abs(v.volume - wantVol) > 0.01) v.volume = wantVol;

      if (!el) return;                              // voice not hydrated yet (phase held above)
      if (!underCommentary) {                       // phase B: the clip plays on its own
        if (!el.paused) el.pause();
        return;
      }
      // Phase A: the voice runs at its own natural rate alongside the (possibly looping) clip — it is the
      // phase clock, so it is never re-seeked to follow the video's playhead.
      if (v.paused) {
        if (!el.paused) el.pause();
        return;
      }
      if (el.paused) void el.play().catch(() => { /* autoplay policy — user will interact */ });
    };
    // Scrubbing back to the clip's start means "play the reel from the top" — and the top of a commentary
    // reel is the commentary. Without this only the automatic end-of-reel loop ever returned to phase A, so
    // once the appended clip had played you could never hear the voice again without a remount. Our OWN
    // rewind (entering phase B lands on the very same source position) is flagged and ignored.
    const onSeeked = () => {
      if (internalSeekRef.current) { internalSeekRef.current = false; return; }
      if (!overlaysRef.current.some(o => o.intro && o.audioId)) return;
      if (v.currentTime > trimStartRef.current + 0.15) return;   // seeking anywhere else keeps the phase
      phaseRef.current = 'intro';
      const el = introAudioRef.current;
      if (el) { el.currentTime = 0; if (!el.paused) el.pause(); }
      sync();   // resume the voice immediately if we're playing
    };
    v.addEventListener('timeupdate', sync);
    v.addEventListener('play', sync);
    v.addEventListener('pause', sync);
    v.addEventListener('seeked', sync);
    v.addEventListener('seeked', onSeeked);
    return () => {
      v.removeEventListener('timeupdate', sync);
      v.removeEventListener('play', sync);
      v.removeEventListener('pause', sync);
      v.removeEventListener('seeked', sync);
      v.removeEventListener('seeked', onSeeked);
      introAudioRef.current?.pause();
    };
  }, [videoSrc]);
  useEffect(() => () => {
    const el = introAudioRef.current;
    if (el) { el.pause(); el.removeAttribute('src'); }
    // Revoke the overlay object URLs this canvas minted (image + narration WAV) so cycling selection
    // through many reels doesn't pin tens of MB of blobs until reload. The underlying blobs live in
    // IndexedDB and re-mint fresh URLs on the next mount — so do NOT delete them here.
    for (const o of overlaysRef.current) {
      if (o.src) URL.revokeObjectURL(o.src);
      if (o.audioSrc) URL.revokeObjectURL(o.audioSrc);
    }
  }, []);

  // Background music: a quiet loop under playback (position-agnostic ambience — no seek sync).
  // The export mixes the same track at the same gain, so preview matches the MP4.
  const musicIdRef = useRef<string | null>(musicId);
  musicIdRef.current = musicId;
  // Blurred letterbox fill — ref'd (like musicId) so the draw/export loops read it without restarting.
  const bgBlurRef = useRef<boolean>(!!bgBlur);
  bgBlurRef.current = !!bgBlur;
  const backdropScratchRef = useRef<OffscreenCanvas | null>(null);
  // Export-only, like musicId: the editor preview deliberately never shows the held frames.
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
  // Volume changes apply live to the running loop (no element re-creation, no loop restart).
  useEffect(() => {
    if (musicElRef.current) musicElRef.current.volume = musicVolume ?? DEFAULT_MUSIC_VOLUME;
  }, [musicVolume]);

  // Lazily decode an overlay's image for the draw loops.
  const getOverlayImg = useCallback((o: ImageOverlay): HTMLImageElement | null => {
    if (!o.src) return null;
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

  const removeOverlayFn = useCallback((id: string) => {
    const doomed = overlaysRef.current.find(x => x.id === id);
    if (doomed?.src) URL.revokeObjectURL(doomed.src);
    if (doomed?.audioSrc) URL.revokeObjectURL(doomed.audioSrc);
    if (doomed?.audioId) void deleteOverlayImage(doomed.audioId);
    if (doomed?.intro) { introAudioRef.current?.pause(); introAudioRef.current?.removeAttribute('src'); }
    overlayImgsRef.current.delete(id);
    commitOverlays(overlaysRef.current.filter(x => x.id !== id));
    setSelectedOverlayId(prev => (prev === id ? null : prev));
    // Deleting the intro lifts its duck: the sync() loop otherwise only heals the volume on the next timeupdate.
    const v = videoRef.current;
    if (v && !overlaysRef.current.some(x => x.intro)) v.volume = 1;
    void deleteOverlayImage(id);
  }, [commitOverlays]);

  // Backspace/Delete removes the selected overlay — matching every canvas editor. Guarded so
  // typing in an input/textarea (flyout URL fields, captions) never deletes anything.
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

  const { isRecording, recProgress, recStatus, startRecording, cancelRecording } = useCommentaryRecording({
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
    // Restore the crop the top/bottom bars set. A commentary reel is ALWAYS the full-bleed band, so only the
    // vertical window (y/h) is the user's crop — x/w are pinned to the canvas rather than trusted from the
    // blob, which keeps a box saved under some other layout (a narrow reel band) from letterboxing the video.
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
    // Only touch the cuts when the framing actually carries the field. A mid-session sidecar write (script,
    // music, blur…) MINTS this reel's framingMap entry, which flips initialFraming null→truthy and fires this
    // apply for the first time — unconditionally nulling it there would silently drop the user's live cuts.
    if (f.segments !== undefined) {
      timelineSegmentsRef.current = Array.isArray(f.segments) && f.segments.length
        ? f.segments.map(s => ({ start: s.start, end: s.end }))
        : null;
    }
    // Overlays are seeded once — usually by the mount effect below (which runs BEFORE the video loads).
    // Guarded so this late apply (fired after the video finally loads) can't re-commit the saved overlays
    // and WIPE a narration generated in between.
    if (Array.isArray(f.overlays) && !overlaysSeededRef.current) {
      overlaysSeededRef.current = true;
      commitOverlays(f.overlays.map(o => ({ ...o })), { silent: true });   // audioSrc re-hydrates from IndexedDB
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed overlays from saved framing on mount, INDEPENDENT of video readiness: the intro is pure audio +
  // captions (re-hydrated from IndexedDB), so a slow/large clip must not gate it. Runs once; the guarded
  // apply above is then a no-op for overlays. A reel whose initialFraming gains an intro later still seeds
  // on that change (batch narration writes straight into framingMap).
  useEffect(() => {
    if (overlaysSeededRef.current) return;
    const ov = initialFraming?.overlays;
    if (!Array.isArray(ov) || ov.length === 0) return;
    overlaysSeededRef.current = true;
    commitOverlays(ov.map(o => ({ ...o })), { silent: true });
    // Authoring flow: a commentary reel mounts with NO overlays, so onLoadedMetadata already poster-seeked the
    // upload to t=1 before this seed brings in the intro. Nothing else un-seeks it, so the FIRST play would
    // start ~1s into the intro (voice + captions clipped), diverging from the export which starts at output 0.
    // If this seed carries an intro and the video is paused ahead of the output start, pull it back.
    const v = videoRef.current;
    if (v && v.paused && ov.some(o => o.intro) && v.currentTime > trimStartRef.current + 0.05) {
      v.currentTime = trimStartRef.current;
    }
  }, [initialFraming, commitOverlays]);

  // useVideoLoading resets framing whenever a video (re)loads. So restore a saved reel's framing only
  // AFTER loading finishes, once per source — otherwise the reset would clobber it. (framingAppliedSrcRef
  // is declared above, next to the useVideoLoading call, so the metadata handler can read it.)
  // Current source + saved-framing prop, readable from getFraming() without a stale imperative closure.
  const videoSrcRef = useRef(videoSrc); videoSrcRef.current = videoSrc;
  const initialFramingRef = useRef(initialFraming); initialFramingRef.current = initialFraming;
  // Readable from getFraming(): while true, boxRef is still the full-canvas placeholder, not the band.
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

  // Also fire on state-backed framing changes (crop resize / zoom / trim / include-edit). Pan is covered
  // by useDrag's onChange above. Skips the initial mount.
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
    // Coalesce rapid scrub seeks: only one seek in flight, always re-target to the
    // latest position when it completes (drops intermediate targets) — see onSeeked.
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
    getCommentaryPlayback: () => ({
      underCommentary: phaseRef.current === 'intro',
      voiceTime: introAudioRef.current?.currentTime ?? 0,
    }),
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
        // anchor is an absolute source time, so shift it by the same delta. A pure trim (one edge) leaves
        // it anchored. No reveal steps to shift alongside it — this canvas never writes any (see the
        // missing setOverlayNarration below).
        if (patch.start != null && patch.end != null) {
          const delta = patch.start - x.start;
          const isMove = Math.abs((patch.end - patch.start) - (x.end - x.start)) < 0.002;
          if (isMove && Math.abs(delta) > 0.0001 && next.audioStart != null) next.audioStart += delta;
        }
        return next;
      }));
    },
    removeOverlay: removeOverlayFn,
    // No replaceRedditCard: it's the bulk builder pushing a rebuilt thread card into a mounted reel, and a
    // commentary reel has no card to replace. It's one of the ref contract's two optional Reddit-only
    // methods (setOverlayNarration below is the other), so this canvas simply doesn't answer it.
    getOverlays: () => overlaysRef.current,
    // No setOverlayNarration either: per-overlay narration is the Reddit card's teleprompter reveal, and
    // a commentary reel's ONE narration — the intro — is written straight into framingMap by the Narrate
    // step, never through the ref. The workspace's Narrate flyout no longer offers it for this style, so
    // there is nothing left to store; it's optional on TikTokCanvasRef and unimplemented here, which makes
    // an attempt fail loudly (generateNarration checks for it) instead of storing audio nothing plays.
    clearOverlayNarration: (id) => {
      // Strip the narration (audio + captions) but keep the overlay itself, so it can be re-narrated
      // (the Narrate step skips an already-voiced reel). GC the stored audio blob.
      const o = overlaysRef.current.find(x => x.id === id);
      if (!o) return;
      if (o.audioSrc) URL.revokeObjectURL(o.audioSrc);
      if (o.audioId) void deleteOverlayImage(o.audioId);
      if (o.intro) { introAudioRef.current?.pause(); introAudioRef.current?.removeAttribute('src'); }
      // Lift the intro duck — the sync() loop only restores the volume on the next timeupdate.
      const v = videoRef.current;
      if (v && !overlaysRef.current.some(x => x.id !== id && x.intro)) v.volume = 1;
      commitOverlays(overlaysRef.current.map(x => (x.id === id ? {
        ...x,
        audioId: undefined, audioStart: undefined,
        audioDuration: undefined, audioSrc: undefined, audioRate: undefined, audioTakes: undefined, intro: undefined, captions: undefined,
      } : x)));
    },
    getFraming: (): Framing | null =>
      // Return null while boxRef is still the placeholder (NOT the reel's band), so the autosave/capture
      // never persist it: (a) while the video is loading — boxRef is the full-canvas placeholder until
      // loadedmetadata runs calcVideoBox; (b) a saved reel whose framing hasn't been applied for the
      // current source yet. Once loaded, boxRef holds the real band/crop and we return it.
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

    // ── Draw loop — throttled to ~10 fps when paused to spare CPU ──────────────
    let lastDrawTime = 0;
    // Force an immediate redraw whenever the video seeks (timeline scrub, frame-step,
    // J/K/L) so the preview tracks the playhead at full framerate even while paused.
    const onSeeked = () => {
      lastDrawTime = 0;   // redraw at full framerate the instant a frame decodes
      // Drain the coalesced scrub target: chase the latest cursor position.
      const p = pendingSeekRef.current;
      if (p != null) { pendingSeekRef.current = null; if (Math.abs(p - video.currentTime) > 0.001) video.currentTime = p; }
    };
    video.addEventListener('seeked', onSeeked);

    function draw() {
      if (!active) return;
      raf.current = requestAnimationFrame(draw);

      // Hold the last frame while the <video> is mid-swap to a local blob (avoids a flash).
      if (blobSwapRef.current) return;

      // Hold the last frame while a seek is in flight with no decoded frame ready — drawing
      // it would paint black/garbage. We repaint on 'seeked' the moment the frame lands.
      // (readyState >= 3 means the current frame IS available, so a fast local seek still draws.)
      if (video.seeking && video.readyState < 3) return;

      // Throttle to ~10fps when paused and idle; bypass throttle while dragging for smooth 60fps
      if (video.paused && !isDraggingRef.current) {
        const now = performance.now();
        if (now - lastDrawTime < 100) return;
        lastDrawTime = now;
      }

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        // Full-bleed composite (see drawing/fullBleedVideo): the frame is cover-fit to the WHOLE canvas plus
        // the manual zoom/pan, and only the CLIP window follows the crop bars. boxRef seeds to the whole
        // canvas, so an untouched reel is uncropped. useCommentaryRecording exports through the same helper.
        const { draw, clip } = fullBleedVideoRects(
          video.videoWidth, video.videoHeight, videoScaleRef.current, videoOffsetRef.current, boxRef.current,
        );

        // Blurred-video letterbox fill: paint the CROPPED-VISIBLE slice of the frame cover-fit over the
        // whole canvas (blurred + dimmed), so the bars echo only what the viewer actually sees — never
        // the cropped-away parts of the source.
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

      // Image overlays — visible while the playhead is inside their time window.
      for (const o of overlaysRef.current) getOverlayImg(o);   // lazy-decode into the shared map
      drawImageOverlays(ctx, overlaysRef.current, overlayImgsRef.current, video.currentTime);
      // Karaoke captions, topmost. They run on the intro clock (output start = trimStart), so they stay
      // in step with the voice however the video is trimmed.
      // Captions belong to the commentary only, and the VOICE is their clock — the clip may loop beneath a
      // long commentary, so its playhead can't time them. Phase B (the reel proper) shows none.
      if (phaseRef.current === 'intro') {
        drawCommentaryCaptions(ctx, overlaysRef.current, introAudioRef.current?.currentTime ?? 0);
      }
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

  // Centre the visible (cropped) band vertically, panning the video by the same delta so the framing
  // inside the crop travels with it. Re-centring an already-centred reel is a no-op (idempotent).
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
          and export clip to the box, so what you see is what exports. Always shown (a commentary reel has no
          card covering the video). Coords: canvas px × DISPLAY_SCALE. */}
      {videoDuration > 0 && !isRecording && (
        <>
          {/* Box outline so the crop edges are visible against the footage. */}
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
          × = delete). Shown only while the playhead is inside the overlay's window — matching what the
          canvas is actually drawing. The intro carries no image, so it never renders chrome; a legacy reel
          that still holds an image layer can be moved/removed here (no new one can be added).
          The chrome sits at the overlay's own y — unlike a Reddit card there is no reveal to center-pin it
          to, since this canvas never writes reveal steps. Coordinates are canvas px × DISPLAY_SCALE. */}
      {overlays.map(o => {
        if (!o.src || currentTime < o.start || currentTime > o.end) return null;
        const sel = selectedOverlayId === o.id;
        return (
          <div
            key={o.id}
            role="button"
            aria-label={`Image overlay ${o.name}`}
            onPointerDown={e => startOverlayDrag(e, o.id, 'move')}
            className={`absolute ${sel ? 'ring-2 ring-accent' : 'ring-1 ring-transparent hover:ring-accent-border'} cursor-move`}
            style={{
              left: o.x * DISPLAY_SCALE, top: o.y * DISPLAY_SCALE,
              width: o.w * DISPLAY_SCALE, height: o.h * DISPLAY_SCALE,
              touchAction: 'none',
            }}
          >
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
        // Always eager: a commentary reel has no card to hide a deferred black band, so the clip must show
        // its frame in the editor. (A Reddit reel defers a remote clip to save the ~100MB download.)
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
          if (trimEndRef.current > 0 && v.currentTime >= trimEndRef.current) {
            // Under the commentary the clip just loops to cover the voice; once the reel proper has played
            // through, the whole composition starts over (back under the commentary from its first word).
            if (phaseRef.current === 'main') restartComposition();
            else v.currentTime = trimStartRef.current;
          }
        }}
        onLoadedMetadata={() => {
          const v = videoRef.current;
          if (!v) return;
          // A metadata-only load holds NO frame, so we seek to force a poster to decode — otherwise the
          // canvas draws black (readyState stays 1). Once the reel has an intro the poster is the CLIP
          // START (+a hair so the seek actually fires) to stay aligned with playback; before that (no
          // narration yet) t=1 is a nicer thumbnail than a black first frame.
          if (overlaysRef.current.some(o => o.intro)) v.currentTime = trimStartRef.current + 0.05;
          else if (v.duration > 1) v.currentTime = 1;
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
        style={{ display: 'none' }}
      />
    </div>
  );
});
