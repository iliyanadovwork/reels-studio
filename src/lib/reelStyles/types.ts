import type { ReactNode } from 'react';
import type { Framing } from '@/app/components/TikTokCanvas/types';
import type { VideoEntry } from '@/app/types';
import type { StageInfo } from '@/app/components/PipelineView';
import type { PipelineRunState } from '@/lib/pipelineStatus';

// A reel STYLE is a self-contained kind of YouTube Short (Reddit thread, commentary, meme, …). It owns the
// shape of its pipeline — the ordered stage nodes and how they look — how to recognise one of its reels, and
// the CAPABILITIES the shared shell needs in order to host it. The shared engine (canvas render, export,
// narration, music) is style-agnostic and driven by this descriptor, so new styles are ADDED as a registry
// entry rather than hand-built.
//
// The capability block below exists because a third style answered the question the old note here left open.
// The shell used to ask `activeStyleId === 'reddit'` and, worse, `overlay.name === 'Reddit thread'` — the
// latter in SHARED libs (reelDuration, pipelineStatus) and in the bulk footage shuffle. Those aren't style
// checks, they're capability checks wearing a style's name, and they fail silently for any style that isn't
// the one hard-coded: a reel with an identical narratable overlay under a different name gets no duration
// badge, no pipeline counts, and no footage shuffle. Every such branch now reads a field here instead, so a
// style declares what it is and the shell never enumerates which styles exist.

/** One pipeline stage's identity + node appearance. `key` drives status lookup and the drawer controls. */
export interface StageDef {
  key: string;
  type: 'Source' | 'Build' | 'Action' | 'Output';
  title: string;
  sub: string;
  icon: ReactNode;
}

/** One narrator in a style's fixed cast. */
export interface CastVoice {
  id: string;
  name: string;
}

/**
 * A style whose primary overlay arrives PRE-CAST (Reddit: the post reads as one voice, commenters draw from a
 * pool) declares the cast here. The narration flyout shows it read-only instead of the editable voice palette,
 * and the disabled-voice substitution draws its replacement from `pool`. `null` = the user picks the voices.
 */
export interface VoiceCast {
  /** Reads the lead block (Reddit: the post, and any reply by its author). */
  lead: CastVoice;
  /** Drawn from for every other speaker. Must be non-empty when a cast is declared. */
  pool: CastVoice[];
}

/** How a reel of this style acquires its voice-over. Drives which batch narrator the shell runs. */
export type NarrationMode =
  /** Voiced from text OCR'd off the primary overlay image, revealing line by line (Reddit, meme). */
  | 'overlay'
  /** Voiced from a written script into a single intro overlay over the video (commentary). */
  | 'script';

export interface ReelStyle {
  id: string;
  name: string;
  /** Ordered pipeline stages (left→right in the flow), with each node's look. */
  stages: StageDef[];
  /** Is the reel `id` one of THIS style? Checks the explicit styleId tag, falling back to style-specific
      detection for legacy reels created before the tag existed. */
  isReel: (id: string, framingMap: Record<string, Framing>) => boolean;
  /** Per-stage status over this style's reels (done/total/running). Returns the REEL-based stages; a source
      node that needs shell-only state (e.g. the Reddit Scout) is prepended by the shell. */
  computeStages: (entries: VideoEntry[], framingMap: Record<string, Framing>, run: PipelineRunState) => StageInfo[];

  // ── Capabilities: what the shared shell needs to know to host this style ────────────────────────────

  /**
   * Name of the overlay carrying this style's narratable content — the OCR'd card/image that owns the reel's
   * text, its narration audio and its reveal steps. This is the reel's LENGTH (reelDuration), its narrate
   * status (pipelineStatus), and what marks it as having background footage worth re-rolling.
   *
   * `null` for a style with no such overlay (commentary, whose voice is a script written into an intro
   * carrier). Callers must treat null as "this style has none" and not fall back to matching every overlay —
   * an unnamed match would make a commentary reel's intro answer to Reddit's duration model.
   */
  primaryOverlayName: string | null;
  /** Does this style get the bulk Pipeline (stages-as-nodes) view? A style made one reel at a time doesn't. */
  hasPipeline: boolean;
  /**
   * Does a reel of this style own a private copy of its video bytes in IndexedDB (true), or keep re-fetching
   * from its URL (false)? See lib/reelBytes for why the two answers exist — a style whose video is a signed,
   * expiring CDN link MUST store its bytes; one whose video is a ~100MB interchangeable library clip must not.
   */
  keepsOwnVideo: boolean;
  /**
   * Are new reels handed a random clip from the shared R2 footage library? True for styles whose video is
   * interchangeable background (Reddit, meme) — they have no link input to fill in instead. False for a style
   * that brings its own video, which gets a blank reel to drop it into.
   */
  assignsFootage: boolean;
  /** How this style's reels are voiced — selects the batch narrator and the narration flyout's shape. */
  narration: NarrationMode;
  /**
   * Is there visible letterbox around the video worth filling with a blurred cover-fit copy? False for a
   * style whose video sits behind a full-screen card — the blur is drawn, but nothing ever sees it, so
   * offering the toggle is a control that appears to do nothing.
   */
  supportsBgBlur: boolean;
  /** Fixed cast for `primaryOverlayName` overlays, or null when the user picks the voices. */
  voiceCast: VoiceCast | null;
  /**
   * Label for the button that creates a reel of this style ("New commentary reel", "New meme reel"). Shown
   * on the toolbar and in the pipeline's source-stage drawer. null for a style whose reels are created some
   * other way entirely (Reddit builds them in bulk from imported threads).
   */
  sourceLabel: string | null;
  /**
   * Ids of the style-optional left-rail flyouts this style shows (see RAIL_STYLE_SECTIONS in CanvasGrid).
   * Sections not in this list are hidden; sections outside that optional set are shown to every style.
   * An allow-list rather than a deny-list so a NEW section defaults to hidden for existing styles — the
   * old deny-list silently leaked each new flyout into every style that hadn't been taught to exclude it.
   */
  railSections: string[];
}
