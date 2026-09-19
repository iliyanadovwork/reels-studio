'use client';

import type { ReactNode } from 'react';
import { RedditCanvas } from './TikTokCanvas/RedditCanvas';
import { CommentaryCanvas } from './TikTokCanvas/CommentaryCanvas';
import { MemeCanvas } from './TikTokCanvas/MemeCanvas';
import { CommentarySource } from './CommentarySource';
import { MemeSource } from './MemeSource';
import type { Framing, ImageOverlay, RecordingState, TikTokCanvasRef } from './TikTokCanvas/types';
import type { TwitterTemplateSettings } from './twitterTemplateTypes';

// The composition root for reel styles: which CANVAS a reel mounts, and which SOURCE surface creates one.
//
// These are the parts of a style that are React components rather than data, so they can't live on the
// ReelStyle descriptor in @/lib/reelStyles — that module is imported by pure libs and by the unit tests, and
// pulling the canvas stack (mp4box, WebCodecs, mediabunny) in behind it would make every one of them depend
// on the browser. So the descriptor stays data and this file holds the components, keyed by the same id.
//
// It IS a place that enumerates the styles, and deliberately so: a composition root is where that belongs.
// The point is that it's the ONLY one. CanvasGrid renders whatever comes back from here and no longer knows
// that Reddit, commentary or meme exist — adding a style means one entry below plus that style's own files,
// not an edit inside a 4000-line shell.
//
// Each entry adapts the shared context to its own canvas's props. That's why the context is a union of what
// the canvases need rather than a lowest common denominator: a style reads the fields it cares about and
// ignores the rest, which is what lets three canvases with genuinely different prop shapes coexist without
// being forced into one interface.

/** Everything the shell knows about ONE reel, handed to whichever canvas the style mounts. */
export interface ReelCanvasContext {
  entryId: string;
  /** Remount counter — bump to force a canvas to re-seed from `framing` (see commentary re-voicing). */
  epoch: number;
  videoSrc: string;
  videoId?: string;
  rowNumber: number;
  caption: string;
  framing: Framing | null;
  exportTitle?: string;
  exportDescription?: string;
  musicId: string | null;
  musicVolume: number | null;
  bgBlur: boolean;
  thumbnailId: string | null;
  /** Resolved tweet-template settings. Only the Reddit canvas draws them. */
  twitterSettings: TwitterTemplateSettings;
  overlayLogoSrc: string;
  overlayDisplayName: string;
  overlayHandle: string;
  /** Load the clip eagerly rather than deferring to preload="metadata". */
  eagerVideo: boolean;
  ocrBrush: { voiceId: string; color: string } | null;
  /** Meme add-missing-text: armed draft text (canvas switches drag to box-drawing) + completion. */
  manualLineDraft: string | null;
  onManualLine: (rect: { x0: number; y0: number; x1: number; y1: number }) => void;
  ocrVoiceColors: Record<string, string>;
  registerRef: (r: TikTokCanvasRef | null) => void;
  onVideoError: () => void;
  onFramingChange: () => void;
  onOverlaysChange: (overlays: ImageOverlay[]) => void;
  onRecordingStateChange: (state: RecordingState) => void;
}

/** What a source surface needs: whether it's open, how to close it, and the shell's create callbacks. */
export interface ReelSourceContext {
  open: boolean;
  onClose: () => void;
  /** Create a reel from a video + script (commentary). */
  onCreateCommentary: (source: { link?: string; video?: { url: string; name: string; file: Blob } }, script: string) => void;
  /** Create a reel from a meme image (meme). */
  onCreateMeme: (image: { url: string; name: string; file: Blob; width: number; height: number }) => void;
}

export interface ReelSurfaces {
  renderCanvas: (ctx: ReelCanvasContext) => ReactNode;
  /** Absent for a style whose reels are created some other way (Reddit builds them in bulk from threads). */
  renderSource?: (ctx: ReelSourceContext) => ReactNode;
}

const SURFACES: Record<string, ReelSurfaces> = {
  reddit: {
    renderCanvas: c => (
      <RedditCanvas
        ref={c.registerRef}
        videoSrc={c.videoSrc}
        videoId={c.videoId}
        rowNumber={c.rowNumber}
        onVideoError={c.onVideoError}
        overlayLogoSrc={c.overlayLogoSrc}
        overlayDisplayName={c.overlayDisplayName}
        overlayHandle={c.overlayHandle}
        overlayCaption={c.caption}
        twitterSettings={c.twitterSettings}
        initialFraming={c.framing}
        exportTitle={c.exportTitle}
        exportDescription={c.exportDescription}
        musicId={c.musicId}
        musicVolume={c.musicVolume}
        eagerVideo={c.eagerVideo}
        thumbnailId={c.thumbnailId}
        onFramingChange={c.onFramingChange}
        onOverlaysChange={c.onOverlaysChange}
        ocrBrush={c.ocrBrush}
        ocrVoiceColors={c.ocrVoiceColors}
        onRecordingStateChange={c.onRecordingStateChange}
      />
    ),
  },

  commentary: {
    // Epoch-keyed: re-voicing the SELECTED reel writes a fresh intro overlay into framingMap, which a seeded
    // (mounted) canvas would never pick up — worse, switching away would snapshot the stale live overlays
    // back OVER it. Bumping the epoch remounts the canvas so it re-seeds from framingMap.
    renderCanvas: c => (
      <CommentaryCanvas
        key={`cc-${c.entryId}:${c.epoch}`}
        ref={c.registerRef}
        videoSrc={c.videoSrc}
        videoId={c.videoId}
        rowNumber={c.rowNumber}
        onVideoError={c.onVideoError}
        overlayCaption={c.caption}
        initialFraming={c.framing}
        exportTitle={c.exportTitle}
        exportDescription={c.exportDescription}
        musicId={c.musicId}
        musicVolume={c.musicVolume}
        bgBlur={c.bgBlur}
        thumbnailId={c.thumbnailId}
        onFramingChange={c.onFramingChange}
        onOverlaysChange={c.onOverlaysChange}
        onRecordingStateChange={c.onRecordingStateChange}
      />
    ),
    renderSource: c => (
      <CommentarySource open={c.open} onClose={c.onClose} onCreate={c.onCreateCommentary} />
    ),
  },

  meme: {
    renderCanvas: c => (
      <MemeCanvas
        ref={c.registerRef}
        videoSrc={c.videoSrc}
        videoId={c.videoId}
        rowNumber={c.rowNumber}
        onVideoError={c.onVideoError}
        overlayCaption={c.caption}
        initialFraming={c.framing}
        exportTitle={c.exportTitle}
        exportDescription={c.exportDescription}
        musicId={c.musicId}
        musicVolume={c.musicVolume}
        bgBlur={c.bgBlur}
        thumbnailId={c.thumbnailId}
        onFramingChange={c.onFramingChange}
        onOverlaysChange={c.onOverlaysChange}
        ocrBrush={c.ocrBrush}
        manualLineDraft={c.manualLineDraft}
        onManualLine={c.onManualLine}
        ocrVoiceColors={c.ocrVoiceColors}
        onRecordingStateChange={c.onRecordingStateChange}
      />
    ),
    renderSource: c => (
      <MemeSource open={c.open} onClose={c.onClose} onCreate={c.onCreateMeme} />
    ),
  },
};

/**
 * Surfaces for a style id. Falls back to Reddit's for an unknown id, matching getReelStyle's fallback — a
 * reel we can't identify still renders on the canvas its framing was most likely written for, rather than
 * disappearing from the grid.
 */
export function surfacesFor(styleId: string): ReelSurfaces {
  return SURFACES[styleId] ?? SURFACES.reddit;
}
