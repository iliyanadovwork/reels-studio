import type { MutableRefObject } from 'react';
import type { MemeLine } from '@/lib/memeOcr';
import type { TwitterTemplateSettings } from '../twitterTemplateTypes';

/** An OCR-detected text line on an overlay image, plus whether the user wants it narrated and,
    optionally, which ElevenLabs voice reads it (absent = the default voice). Consecutive enabled
    lines with the same voice are spoken as one paragraph/take. */
export interface OcrTextLine extends MemeLine {
  enabled: boolean;
  voiceId?: string;
  /** Erase mode only: the line is muted AND its blur cover never lifts — the text is removed from the
      video outright (junk OCR). A merely-disabled line (enabled: false, erased falsy) stays VISIBLE:
      its cover lifts with the image, it's just never read. Meaningless for crop-mode overlays. */
  erased?: boolean;
  /** Added by hand (typed text + dragged box) rather than detected — survives a reveal-mode rebake,
      where detected lines are re-OCR'd from the image and manual ones would otherwise vanish. */
  manual?: boolean;
}

/** The two crop bars a reel canvas mounts: top edge and bottom edge. Both canvases crop vertically only
    (the video always spans the band's full width), so there are no corner/side handles and no move handle. */
export type Handle = 'tc' | 'bc';

export interface Box { x: number; y: number; w: number; h: number }

export interface RecordingState {
  isRecording: boolean;
  recProgress: number;
  recStatus: string;
}

export interface VideoTrimState {
  trimStart: number;
  trimEnd: number;
  duration: number;
  includeEdit: boolean;
  videoScale: number;
}

// The full per-reel framing — the only numbers that, together with the video link + template, let a
// reel re-render identically. Persisted (as plain JSON) by the Video Reels workspace; re-applied after
// the video reloads. All optional so a partial/legacy blob still restores what it can.
/** One kept span of the source video, in source-time seconds (a timeline clip). */
export interface ClipSegment { start: number; end: number }

/** An image layered on top of the reel video. Position/size are canvas px (1080×1920); start/end are
    SOURCE-time seconds (like clip segments) — the overlay is visible while the playhead is inside them.
    `src` is a runtime object URL and is NOT persisted; the blob lives in IndexedDB keyed by `id`. */
export interface ImageOverlay {
  id: string;
  name: string;
  x: number; y: number; w: number; h: number;
  start: number; end: number;
  src?: string;
  /** Progressive reveal steps: at source time `t` the visible (top-anchored) fraction eases to `h`.
      Sorted by t. Absent = the whole image is always visible. */
  reveals?: { t: number; h: number }[];
  /** Narration audio (ElevenLabs): blob lives in IndexedDB under `audioId`; starts playing at
      `audioStart` (source-time seconds) for `audioDuration` audio-seconds. `audioSrc` is runtime-only. */
  audioId?: string;
  audioStart?: number;
  audioDuration?: number;
  audioSrc?: string;
  /** Playback rate of the underlying video while this narration plays (baked into the reveal-step
      source times at generation). The video runs this much faster than the voice; absent = 1. */
  audioRate?: number;
  /** Per-voice narration takes on the stitched audio track (audio-time seconds) — lets the
      timeline show the voices as colored audio-channel blocks. */
  audioTakes?: { voiceId: string; start: number; duration: number }[];
  /** Commentary style: this narration is an INTRO over the START of the (un-sped) video. The video keeps
      its full length + its own audio (ducked under the intro), unlike a Reddit narration which IS the audio
      and defines the clip length. Also drives caption rendering. */
  intro?: boolean;
  /** Karaoke caption chunks (commentary), timed to the voice via ElevenLabs character timestamps. */
  captions?: { text: string; start: number; end: number }[];
  /** Speaker (author) per narration block, indexed like MemeLine.blockIdx — kept for a Reddit card
      so its voice cast can be reshuffled later without re-importing. */
  blockAuthors?: string[];
  /** Text lines OCR'd off the image right after it's added (auto). Rendered as click-to-toggle
      highlights on the selected overlay; only `enabled` lines are narrated/revealed. */
  ocrLines?: OcrTextLine[];
  /** Beats of silence to hold on WORDLESS content in the image — today, a Reddit post's picture (see
      lib/redditDwell). `afterLineIdx` indexes THIS overlay's `ocrLines`, so the two are only meaningful
      together; narration inserts the silence into the stitched track and reveals `bottomFrac` there. */
  dwells?: { afterLineIdx: number; sec: number; bottomFrac: number }[];
  /** Erase reveal mode (Reddit post image; see lib/redditTextErase). The atlas blob of blur-filled
      cover strips lives in IndexedDB under `coverAtlasId`; `coverSrc` is its runtime object URL
      (NOT persisted, like `src`). `coverPatches` says where each strip sits: atlas px in, card
      fractions out, `lineIdx` into this overlay's `ocrLines`. */
  coverAtlasId?: string;
  coverSrc?: string;
  coverAtlas?: { w: number; h: number };
  coverPatches?: { lineIdx: number; src: { x: number; y: number; w: number; h: number }; atlas: { x: number; y: number }; dest: { x: number; y: number; w: number; h: number } }[];
  /** When each cover strip lifts (SOURCE-time seconds, indexed like `coverPatches`; null = never —
      a muted line's text stays erased). Set with the narration, cleared with it, and shifted with
      `audioStart` when the overlay moves on the timeline. */
  coverLifts?: (number | null)[];
  /** What OCR read but THREW AWAY (with why) — so a missing line is a visible fact with a remedy
      (add it manually) instead of a silent absence. Capped small; refreshed on every (re)detect. */
  ocrDropped?: { text: string; reason: string }[];
}

/** User tweaks to a Reddit thread's TEXT, applied at Pick time — keyed by the imported thread's
    paragraph/comment indices IN THE FLYOUT'S UNIVERSE (paragraphs from splitParagraphs(post.body);
    comments = the depth-0-filtered list). The card render, narration (via the card's ocrLines) and
    YouTube copy all consume the EDITED text; empty/whitespace overrides mean "no override"
    (deselection is how you delete). `paraOrig`/`commentOrig` snapshot the ORIGINAL text at edit time —
    content anchors so a re-imported thread whose item drifted (edited/deleted/reordered on Reddit)
    SKIPS the stale override instead of silently rewriting the wrong item. */
export interface RedditThreadEdits {
  title?: string;
  paras?: Record<number, string>;
  comments?: Record<number, string>;
  paraOrig?: Record<number, string>;
  commentOrig?: Record<number, string>;
}

export interface Framing {
  box?: Box;
  videoOffset?: { x: number; y: number };
  videoScale?: number;
  trimStart?: number;
  trimEnd?: number;
  includeEdit?: boolean;
  /** Timeline clips when the video was split/cut into more than one span. Absent = simple trim
      (trimStart/trimEnd describe the single span). Kept alongside trim so legacy blobs restore. */
  segments?: ClipSegment[];
  /** Image layers on top of the video (runtime object URLs stripped — blobs re-hydrate from IndexedDB). */
  overlays?: Omit<ImageOverlay, 'src' | 'audioSrc' | 'coverSrc'>[];
  /** Background-music track id (lib/music.ts); absent = no music. */
  musicId?: string;
  /** Music bed volume 0..1 (absent = DEFAULT_MUSIC_VOLUME). */
  musicVolume?: number;
  /** Reddit thread import for this reel: the pasted link plus the picked comment/paragraph indices,
      so reopening the flyout (or reloading) can restore the exact selection after re-import — and the
      user's text edits (tweaked at Pick time; survive re-imports since text is re-fetched by index). */
  redditThread?: { url: string; comments?: number[]; paras?: number[]; edits?: RedditThreadEdits };
  /** Generated YouTube title + description for this reel (editable; /api/description). */
  ytTitle?: string;
  description?: string;
  /** Which reel STYLE this reel belongs to (see @/lib/reelStyles). Absent = legacy Reddit reel (detected by
      the "Reddit thread" overlay). Drives which pipeline/status/source applies. */
  styleId?: string;
  /** Custom thumbnail: IndexedDB key (images store) for a still held for THUMB_LEAD_S at the START of the
      export, so it can be picked in YouTube's Shorts frame picker. Absent = no thumbnail, no lead frames.
      The blob lives in IndexedDB like every other image; only the key is persisted here. */
  thumbnailId?: string;
  /** Original filename of that still, for the UI to show what's attached. */
  thumbnailName?: string;
  /** Commentary style: the written voice-over script narrated over the start of the uploaded video. */
  commentaryScript?: string;
  /** Fill the letterbox around the video box with a blurred cover-fit copy of the video (instead of the
      flat background color). Preview + export composite it identically. */
  bgBlur?: boolean;
}

/** Props of the REDDIT canvas (see RedditCanvas.tsx). The commentary reel renders on CommentaryCanvas with
    its own (much smaller) props; both share the TikTokCanvasRef contract below, so the workspace can mount
    either one for a reel without touching a single call. */
export interface RedditCanvasProps {
  videoSrc: string;
  videoId?: string;
  rowNumber?: number;
  /** Generated YouTube title — used as the export filename when present (falls back to caption). */
  exportTitle?: string;
  /** Generated YouTube description. Present with a title, the single export ships a .zip of the MP4 plus a
      .txt of the copy — the same pair "Download all" writes, so one reel and many agree. */
  exportDescription?: string;
  onVideoError?: () => void;
  overlayLogoSrc?: string;
  overlayDisplayName?: string;
  overlayHandle?: string;
  overlayCaption?: string;
  /** Twitter/X overlay style (colors, caption size, avatar shape, toggles). Defaults reproduce the original look. */
  twitterSettings?: TwitterTemplateSettings;
  onRecordingStateChange?: (state: RecordingState) => void;
  /** Saved framing to restore once the video has (re)loaded — crop/pan/zoom/trim of a saved reel. */
  initialFraming?: Framing | null;
  /** Fired whenever the user changes framing (crop/pan/zoom/trim) so the workspace can autosave it. */
  onFramingChange?: () => void;
  /** Fired with the current overlay list whenever it changes (add/move/resize/retime/remove/restore),
      so the workspace can hand it to the timeline. */
  onOverlaysChange?: (overlays: ImageOverlay[]) => void;
  /** Armed narration-voice brush: while set, clicking an OCR line highlight paints that line with
      this voice instead of toggling it in/out of the narration. */
  ocrBrush?: { voiceId: string; color: string } | null;
  /** Background-music track id (lib/music.ts): loops quietly under playback and mixes into the export. */
  musicId?: string | null;
  /** Music bed volume 0..1 (default DEFAULT_MUSIC_VOLUME) — same gain in preview and export. */
  musicVolume?: number | null;
  /** voiceId → display color for OCR line highlights (lines with no voice use the accent style). */
  ocrVoiceColors?: Record<string, string>;
  /** Load the video EAGERLY (preload="auto") even for a remote clip. On until the reel has its Reddit card;
      after that it falls back to the deferred "metadata" (lib/videoPreload) — still enough to decode a poster
      frame and publish a duration, without eager-downloading the ~100MB clip. */
  eagerVideo?: boolean;
  /** Fill the letterbox with a blurred cover-fit copy of the video (see Framing.bgBlur). */
  bgBlur?: boolean | null;
  /** IndexedDB key of a custom thumbnail still (see Framing.thumbnailId) — held for a few frames at the
      start of the EXPORT only; the editor preview is unaffected. */
  thumbnailId?: string | null;
}

export interface TikTokCanvasRef {
  startDownload: () => Promise<void>;
  /** Bake the reel (crop/overlay/trim) to an MP4 Blob instead of downloading — used by the Post scheduler. */
  exportBlob: () => Promise<Blob | null>;
  cancelExport: () => void;
  play: () => void;
  pause: () => void;
  seekTo: (t: number) => void;
  setTrimRange: (start: number, end: number) => void;
  resetTrim: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  setZoom: (scale: number) => void;
  resetBox: () => void;
  centerBox: () => void;
  setIncludeEdit: (v: boolean) => void;
  getVideoElement: () => HTMLVideoElement | null;
  /** COMMENTARY-ONLY (optional, like the other style-specific methods): where playback sits in the
   *  two-phase composition — under the commentary (with how far into the voice-over we are), or past it
   *  playing the appended clip. The timeline needs this because the clip's own playhead can't tell the
   *  phases apart: it runs 0→clipEnd in BOTH, and may loop under a long commentary. */
  getCommentaryPlayback?: () => { underCommentary: boolean; voiceTime: number };
  useLocalBlob: () => void;   // swap playback to the downloaded local blob (fast seeking)
  getTrimState: () => VideoTrimState;
  /** Timeline clip list, held here so it persists with the framing. null = simple trim (≤1 clip). */
  setSegments: (segs: ClipSegment[] | null) => void;
  getSegments: () => ClipSegment[] | null;
  /** Image overlays: add (src = object URL; sized/centred when the image loads), retime/replace fields,
      and remove (also GC's the stored blob). */
  addImageOverlay: (id: string, src: string, name: string) => void;
  updateOverlay: (id: string, patch: Partial<Omit<ImageOverlay, 'id' | 'src'>>) => void;
  removeOverlay: (id: string) => void;
  /** Replace ALL overlays with one freshly-rebuilt Reddit card, tearing down the previous overlays' live
   *  state (image, narration audio element + object URLs) and un-muting the video. Used by the bulk builder's
   *  rebuild-in-place path when the reel is already MOUNTED: overlays are seeded once, so a framingMap change
   *  alone never reaches the live canvas. The new card's image blob must already be in IndexedDB (src
   *  re-hydrates from there). Does NOT GC the old IndexedDB blobs — the caller does that for both mounted and
   *  unmounted reels.
   *  REDDIT-ONLY, hence optional: a commentary reel has no card to replace and the bulk builder never targets
   *  one, so CommentaryCanvas simply doesn't implement it — call it as `ref.replaceRedditCard?.(…)`. */
  replaceRedditCard?: (overlay: Omit<ImageOverlay, 'src' | 'audioSrc'>) => void;
  getOverlays: () => ImageOverlay[];
  /** Attach generated narration to an overlay: reveal steps + audio (already persisted to IndexedDB).
   *  Extends the overlay's end so the narration finishes inside its window.
   *  REDDIT-ONLY, hence optional (same precedent as replaceRedditCard above): per-overlay narration is a
   *  Reddit-card concept — a commentary reel's voice-over is its SCRIPT, written straight into the framing
   *  as a single intro overlay — so CommentaryCanvas doesn't implement it. Call it as
   *  `ref.setOverlayNarration?.(…)`, and treat its absence as "this style can't be narrated per-overlay"
   *  rather than generating into the void. */
  setOverlayNarration?: (id: string, n: { reveals: { t: number; h: number }[]; audioId: string; audioStart: number; audioDuration: number; audioSrc: string; audioRate: number; audioTakes?: { voiceId: string; start: number; duration: number }[]; coverLifts?: (number | null)[] }) => void;
  /** Remove an overlay's narration (audio + reveals) but keep the image + ocrLines. Kept non-optional:
      a commentary reel clears its INTRO through here too. */
  clearOverlayNarration: (id: string) => void;
  /** Snapshot the current framing (crop/pan/zoom/trim) for persistence. Returns null while a saved
   *  reel's video is still loading (framing not yet applied) so callers keep the known-good value. */
  getFraming: () => Framing | null;
  /** Re-apply a saved framing immediately (used after a reload to restore the exact crop). */
  applyFraming: (f: Framing) => void;
}

export interface DrawHeaderOptions {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  cx: number;
  cy: number;
  cw: number;
  overlayCaption: string;
  overlayLogoSrc: string;
  overlayDisplayName: string;
  overlayHandle: string;
  overlayVerified: boolean;
  logoImgRef: MutableRefObject<HTMLImageElement | null>;
  verifiedImgRef: MutableRefObject<HTMLImageElement | null>;
  avatarImg?: HTMLImageElement | null;   // pre-loaded per-cell avatar image; overrides the brand logo when set
  s: TwitterTemplateSettings;   // resolved overlay style (colors, caption size, avatar shape, toggles)
  placeholder?: boolean;        // editor-only: draw an image skeleton for the avatar when no logo image
  fillBg?: boolean;             // paint the opaque header-bg rect behind the banner (default true). Free
                                // banner elements pass false so they overlay the video/content transparently.
}
