'use client';

import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { TikTokCanvasRef } from './TikTokCanvas/types';
import { CAROUSEL_PREVIEW_W } from './TemplateEditorCanvas/constants';
import { useTwitterTemplates } from '../hooks/useTwitterTemplates';
import { useReelPersistence, type SavedReel } from '../hooks/useReelPersistence';
import { makeEmptyEntry, newReelId, MAX_REELS } from '@/lib/entry';
import { getCachedVideo, prioritizeVideoFetch } from '@/lib/reelVideoCache';
import { saveLocalVideo, getLocalVideo, saveOverlayImage, getOverlayImage, deleteOverlayImage } from '@/lib/localVideoStore';
import { extractMemeLines, extractMemeLinesDetailed } from '@/lib/memeOcr';
import { insertManualLine } from '@/lib/manualLine';
import type { Framing, ImageOverlay, OcrTextLine } from './TikTokCanvas/types';
import { TemplatesEmptyState } from './TemplatesEmptyState';
import { defaultTwitterTemplateSettings } from './twitterTemplateTypes';
import type { VideoEntry, BrandProps } from '../types';
import type { RecordingState } from './TikTokCanvas/types';
import { VideoControlsBar } from './VideoControlsBar';
import { bestVideoUrl, proxyStreamUrl, fmtTime } from '@/lib/utils';
import { getVideoBlob } from '@/lib/reelVideoBlob';
import { Button, IconButton, Modal, HEADER_H } from './ui';
import { AutosaveChip } from './AutosaveChip';
import { ElementRail, RailActionButton } from './ElementRail';
import { ReelTemplatePreview } from './ReelTemplatePreview';
import { SlidesStrip } from './SlidesStrip';
import { EditorScrollBar } from './EditorScrollBar';
import { ZoomControl } from './ZoomControl';
import { ThemeToggle } from './ThemeToggle';
import { PipelineView, type StageKey } from './PipelineView';
import { SHORTS_MAX_SECONDS, estimateNarrationSeconds, reelDurationInfo } from '@/lib/reelDuration';
import { ttsClean } from '@/lib/ttsClean';
import { buildCaptions } from '@/lib/captions';
import { computePipelineMusicId } from '@/lib/pipelineStatus';
import { getReelStyle, type VoiceCast } from '@/lib/reelStyles';
import { styleOf, styleTagForSave } from '@/lib/reelPartition';
import { shouldPersistBytes, shouldRestoreBytes } from '@/lib/reelBytes';
import { checkVideoFile } from '@/lib/videoProbe';
import { surfacesFor } from './reelSurfaces';
import { memeOverlayRect, checkMemeImage } from '@/lib/memeImage';
import { MEME_OVERLAY_NAME } from '@/lib/reelStyles/meme';
import { CANVAS_W, CANVAS_H } from './TikTokCanvas/constants';
import { markRedditUsed } from '@/lib/redditScout/markUsed';
import { ScoutPanel } from './ScoutPanel';
import { canonicalThreadKey, partitionImportUrls, releaseByUrls, migrateScoutBuffer, postIdFromUrl } from '@/lib/redditScout/handoff';
import { parseStoredThreads, serializeThreads } from '@/lib/redditScout/bulkPersist';
import { applyThreadEdits, hasThreadEdits, remapCommentEdits, depth0IndexOf, splitParagraphs } from '@/lib/redditThreadEdits';
import { RedditThreadPicker } from './RedditThreadPicker';
import { toggleIndex, threadEstimateText, type ImportedRedditPost, type ImportedRedditComment, type PickableThread } from '@/lib/redditPicker';
import { importNotice, type ImportNotice } from '@/lib/redditImportNotice';
import type { RedditThreadEdits } from './TikTokCanvas/types';
import type { ScoutCandidate } from '@/lib/redditScout/types';
import { useObservedSize, fitScaleFor } from '@/app/hooks/useElementSize';
import { useEditorZoomPan, EDITOR_ZOOM_MIN as ZOOM_MIN, EDITOR_ZOOM_MAX as ZOOM_MAX } from '@/app/hooks/useEditorZoomPan';
import {
  UploadIcon, ArrowRightIcon, SpinnerIcon,
  CloseIcon, DownloadIcon, VideoIcon, LinkIcon, ChevronDownIcon, ChevronUpIcon, TrashIcon, CheckIcon,
} from '@/lib/icons';
import { fetchFootageManifest, isFootageUrl, canReassignFootage, type FootageSegment } from '@/lib/footage';
import { renderRedditCard, type RedditCardData, type RedditCardResult, type RedditComment } from '@/lib/redditCard';
import { planStitch, resolveDwells, buildReveals, dropCoveredDwells } from '@/lib/redditDwell';
import { coverLiftTimes, buildMemeCoverAssets } from '@/lib/redditTextErase';
import { getRevealModePref, setRevealModePref, REDDIT_REVEAL_LS, MEME_REVEAL_LS } from '@/lib/revealModePref';
import { readClipboardImage, imageUrlFromClipboard, fileFromImageUrl } from '@/lib/clipboardImage';
import type { ImageRevealMode } from '@/lib/redditImageLines';
import type { MemeLine } from '@/lib/memeOcr';
import { BACKGROUND_TRACKS, DEFAULT_MUSIC_VOLUME, resolveMusicId } from '@/lib/music';

const CARD_W = CAROUSEL_PREVIEW_W; // 410 — same width as canvas preview

// Height of the flow spacer at the end of the scroll content, reserving room so the reel centres above
// the docked slides strip rather than behind it (matches the carousels editor's SLIDES_DOCK_CLEARANCE).
const SLIDES_DOCK_CLEARANCE = 120;


interface CanvasGridProps {
  entries: VideoEntry[];
  setEntries?: Dispatch<SetStateAction<VideoEntry[]>>;   // present in the Video Reels workspace (entries are page-owned)
  canvasRefsMap: MutableRefObject<Map<string, TikTokCanvasRef>>;
  brand: BrandProps;
  onAddRow: (initialUrl?: string) => void;
  onAddReels?: (urls: (string | undefined)[], opts?: { keepExisting?: boolean }) => string[];
  onRemoveRow: (id: string) => void;
  onDuplicateRow: (id: string) => string | null;   // inserts a copy, returns the new id (null if at the reel cap)
  // Reset THIS style's grid to one empty reel and GC the media of the reels it deleted. Takes the style so
  // the GC can spare every blob the other workspaces' saved reels still own.
  onDeleteAllReels?: (styleId: string) => void;
  onHandleVideoError: (id: string) => void;
  onUpdateEntry: (id: string, field: 'url' | 'caption', value: string) => void;
  onUpdateLocalVideo: (id: string, src: string, name: string, opts?: { keepStored?: boolean }) => void;
  onFetchVideo: (id: string) => void;
  userId: string | null;
  videoMode: 'twitter' | 'caption';                          // current overlay style (drives the Twitter template picker + rendering)
  /** Which reel style THIS workspace is. Fixed for the component's lifetime — see @/lib/reelStyles. */
  styleId: string;
  onGoToTemplateEditor?: () => void;                         // reels posting: jump to the template editor when there are no reel templates
  viewToggle?: React.ReactNode;                              // Canvas ⇄ Sheet segmented control, rendered in the toolbar's left slot
  active?: boolean;                                          // false when the Sheet view is showing — suppresses the body-portalled scroll bar
  onRestored?: () => void;                                   // fires once the saved grid has been applied (Sheet sends wait for this)
  restored?: boolean;                                        // true on a nav-back remount (page-load restore already ran): re-seed maps, don't rebuild entries
  onGoHome?: () => void;                                     // return to the "what do you want to do today?" landing
}

// ── Reels posting rail: Link + Caption flyouts (edit the SELECTED reel) + URL/caption undo history ─────
const linkGlyph = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);
const SVG_PROPS = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const zoomInGlyph  = (<svg {...SVG_PROPS}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3M11 8v6M8 11h6" /></svg>);
const zoomOutGlyph = (<svg {...SVG_PROPS}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3M8 11h6" /></svg>);
const resetGlyph   = (<svg {...SVG_PROPS}><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" /><path d="M21 3v5h-5" /></svg>);
const centerGlyph  = (<svg {...SVG_PROPS}><circle cx="12" cy="12" r="2.5" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg>);
const timelineGlyph = (<svg {...SVG_PROPS}><path d="M3 12h18" /><rect x="8" y="9" width="4" height="6" rx="1" /></svg>);
const removeVideoGlyph = (<svg {...SVG_PROPS}><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10.5 21 8v8l-5-2.5" /><path d="m3 3 18 18" /></svg>);
const blurGlyph = (<svg {...SVG_PROPS}><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0C6 9.5 12 3 12 3z" /><path d="M9.5 13.5a2.5 2.5 0 0 0 2.5 2.5" /></svg>);
const scriptGlyph = (<svg {...SVG_PROPS}><path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M9 8h6M9 12h6M9 16h3" /></svg>);
const thumbGlyph = (<svg {...SVG_PROPS}><rect x="6" y="3" width="12" height="18" rx="2" /><circle cx="10" cy="9" r="1.4" /><path d="M18 16l-4-4-6 6" /></svg>);
const micGlyph = (<svg {...SVG_PROPS}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" /></svg>);
const shuffleGlyph = (<svg {...SVG_PROPS} width={13} height={13}><path d="M16 3h5v5" /><path d="M4 20 21 3" /><path d="M21 16v5h-5" /><path d="m15 15 6 6" /><path d="M4 4l5 5" /></svg>);
const redditGlyph = (<svg {...SVG_PROPS}><circle cx="12" cy="14" r="7" /><circle cx="9.5" cy="14" r="0.7" fill="currentColor" stroke="none" /><circle cx="14.5" cy="14" r="0.7" fill="currentColor" stroke="none" /><path d="M12 7c0-2.5 1.5-4 3.5-4" /><circle cx="16.5" cy="3" r="1.2" /></svg>);
const memeGlyph = (<svg {...SVG_PROPS}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>);
const musicGlyph = (<svg {...SVG_PROPS}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>);
const ytCopyGlyph = (<svg {...SVG_PROPS}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none" /></svg>);

// Left-rail sections that belong to a STYLE rather than to every reel. A section listed here shows only for
// a style whose `railSections` names it (ReelStyle.railSections); anything not listed — music, narration —
// is universal and always shows. Keep this in sync with the section ids built in the rail below: an id that
// is style-specific but missing from this set would leak into every style.
const RAIL_STYLE_SECTIONS = new Set(['link', 'commentary', 'reddit', 'yt-copy', 'meme']);

// The selected meme reel's image: what it is now, and a way to swap it. Replacing re-OCRs, which is why it
// warns when a narration already exists — the reveal steps are indexed to the OLD lines, so keeping them
// against a new image would un-crop to the wrong places.
function MemeImageFlyout({ overlay, onReplace, onModeChange, manualDraft, onArmManualLine }: {
  overlay: ImageOverlay | null;
  onReplace: (file: File) => void;
  /** Reprocess the CURRENT image after the reveal-mode pref changes (mode is baked at add time). */
  onModeChange: () => void;
  /** The armed add-missing-text draft (null = not adding). Owned by the workspace: the CANVAS needs
      it too, to switch the drag gesture into box-drawing. */
  manualDraft: string | null;
  onArmManualLine: (text: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const narrated = (overlay?.audioDuration ?? 0) > 0;
  const [revealMode, setRevealMode] = useState<ImageRevealMode>(() => getRevealModePref(MEME_REVEAL_LS));
  const [manualText, setManualText] = useState('');
  const lines = overlay?.ocrLines?.length ?? 0;
  const enabled = overlay?.ocrLines?.filter(l => l.enabled).length ?? 0;

  // ONE acceptance path for every way an image arrives (chooser, Paste button, ⌘V) — same gate.
  const acceptRef = useRef<(f: File) => void>(() => {});
  const accept = async (f: File) => {
    setChecking(true);
    const res = await checkMemeImage(f);
    setChecking(false);
    if (res.problem) { setError(res.problem); return; }
    if (res.url) URL.revokeObjectURL(res.url);   // the replace path re-reads the file itself
    setError('');
    onReplace(f);
  };
  acceptRef.current = f => void accept(f);

  // ⌘V while the flyout is open. This is the route the Paste BUTTON cannot serve: a file copied in
  // Finder is a file reference, invisible to clipboard.read() — but the paste EVENT delivers it as a
  // real File. Capture phase so the workspace's own video-paste handler never also acts on it.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      for (const it of Array.from(e.clipboardData?.items ?? [])) {
        if (it.kind !== 'file' || !it.type.startsWith('image/')) continue;
        const f = it.getAsFile();
        if (!f) continue;
        e.preventDefault();
        e.stopPropagation();
        acceptRef.current(f);
        return;
      }
      // No pixels — some sites' "Copy image" copies an <img> URL instead. getData is synchronous in a
      // paste event, so the URL check can gate preventDefault correctly before going async.
      const url = imageUrlFromClipboard(e.clipboardData?.getData('text/html'), e.clipboardData?.getData('text/plain'));
      if (url) {
        e.preventDefault();
        e.stopPropagation();
        void fileFromImageUrl(url).then(res => {
          if ('error' in res) setError(res.error);
          else acceptRef.current(res.file);
        });
      }
    };
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, []);

  return (
    <div className="flex flex-col gap-2">
      {overlay?.src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={overlay.src} alt="" className="max-h-48 w-auto self-start rounded-md border border-line object-contain" />
      )}
      <p className="text-caption text-fg-3">
        {/* A meme reel normally arrives WITH its image (the source modal), but "Add reel" makes a blank one —
            this style assigns footage to every new reel. That reel needs a way to acquire an image, or it's
            a dead end: it can never be narrated and never exports anything but silent footage. */}
        {!overlay
          ? 'This reel has no meme image yet — add one and its text will be read automatically.'
          : lines === 0
            ? 'No text was detected in this image — narration will read nothing. Try a sharper or larger screenshot.'
            : `${enabled} of ${lines} line${lines === 1 ? '' : 's'} set to narrate. Click lines on the image to include or skip them.`}
      </p>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          e.target.value = '';   // reset first, so re-picking the same file after a rejection re-fires
          if (f) void accept(f);
        }}
      />
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" loading={checking} onClick={() => fileRef.current?.click()}>
          {overlay ? 'Replace image' : 'Add meme image'}
        </Button>
        <Button
          variant="secondary" size="sm" disabled={checking}
          title="Paste an image from the clipboard"
          onClick={() => void (async () => {
            setError('');
            setChecking(true);              // visible feedback the instant the click lands
            const res = await readClipboardImage();
            setChecking(false);
            if ('error' in res) { setError(res.error); return; }
            void accept(res.file);
          })()}
        >
          Paste
        </Button>
      </div>
      {/* What OCR read but rejected — a missed line is a visible fact with a remedy, not a mystery. */}
      {overlay && (overlay.ocrDropped?.length ?? 0) > 0 && (
        <div className="flex flex-col gap-0.5 rounded-md border border-line bg-surface-2 px-2 py-1.5">
          <span className="text-caption text-fg-3">OCR skipped:</span>
          {overlay.ocrDropped!.map((d, i) => (
            <span key={i} className="text-caption text-fg-4">“{d.text}” — {d.reason}</span>
          ))}
        </div>
      )}
      {/* Add a line OCR missed: type it, then drag a box over it on the image. The line becomes a
          normal OcrTextLine — narrated, revealed, covered in erase mode, clickable like the rest. */}
      {overlay && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <input
              value={manualText}
              onChange={e => setManualText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && manualText.trim()) onArmManualLine(manualText.trim()); }}
              placeholder="Text OCR missed…"
              className="h-7 flex-1 min-w-0 rounded-md border border-line-strong bg-transparent px-2 text-caption text-fg placeholder:text-fg-3 outline-none"
            />
            <Button
              variant="secondary" size="sm"
              disabled={!manualText.trim() && !manualDraft}
              onClick={() => onArmManualLine(manualDraft ? null : manualText.trim())}
            >
              {manualDraft ? 'Cancel' : 'Draw its box'}
            </Button>
          </div>
          {manualDraft && (
            <span className="text-caption text-accent-text">
              Now drag a box over “{manualDraft}” on the image.
            </span>
          )}
        </div>
      )}
      {/* Text reveal mode — same choice the New-meme-reel modal offers, applied to THIS image on the
          spot: the mode is baked into the overlay (erase needs cover strips built), so switching
          reprocesses the current image through the same path as a replace. */}
      <div className="flex items-center gap-1.5">
        <span className="text-caption text-fg-3">Text reveal:</span>
        {([['crop', 'scroll'], ['erase', 'erase & reveal in place']] as const).map(([m, label]) => (
          <button
            key={m}
            type="button"
            title={m === 'crop'
              ? 'The image un-crops line by line as it’s read (teleprompter)'
              : 'The whole image shows with its text hidden; each line un-erases as it’s read'}
            onClick={() => {
              if (m === revealMode) return;
              setRevealMode(m);
              setRevealModePref(MEME_REVEAL_LS, m);
              if (overlay) onModeChange();   // rebake the current image in the new mode
            }}
            className={`rounded-md border px-2 py-0.5 text-caption transition-colors ${revealMode === m
              ? 'border-accent-border bg-accent-tint text-accent-text'
              : 'border-line-strong text-fg-3 hover:bg-hover'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {narrated && (
        <span className="text-caption text-fg-4">
          Replacing re-reads the text and clears the current narration — the reveal is timed to the old lines.
        </span>
      )}
      {error && <span className="text-caption text-danger-text">{error}</span>}
    </div>
  );
}

// A canvas getFraming() snapshot doesn't carry the flyout-only fields (Reddit thread link, YouTube
// title/description) — they live only in framingMap. Re-attach them from the existing entry so a
// snapshot (on reel switch or duplicate) can never silently drop them.
function withFramingSidecars(snapshot: Framing, prev: Framing | undefined): Framing {
  if (!prev) return snapshot;
  const out: Framing = { ...snapshot };
  if (prev.redditThread) out.redditThread = prev.redditThread;
  if (prev.ytTitle) out.ytTitle = prev.ytTitle;
  if (prev.description) out.description = prev.description;
  if (prev.styleId) out.styleId = prev.styleId;                     // reel-style tag — getFraming() doesn't emit it
  if (prev.commentaryScript) out.commentaryScript = prev.commentaryScript;
  if (prev.bgBlur) out.bgBlur = prev.bgBlur;                        // blurred letterbox fill — framingMap-only sidecar
  if (prev.thumbnailId) out.thumbnailId = prev.thumbnailId;         // custom thumbnail — ditto
  if (prev.thumbnailName) out.thumbnailName = prev.thumbnailName;
  // A canvas snapshot can't express "No music": the picker stores '', which resolves to null, so getFraming()
  // emits musicId: undefined — and undefined re-reads as "unset" → the DEFAULT track, resurrecting music the
  // user turned off. Carry the explicit choice (including '') across every snapshot.
  if (out.musicId === undefined && prev.musicId !== undefined) out.musicId = prev.musicId;
  if (out.musicVolume === undefined && prev.musicVolume !== undefined) out.musicVolume = prev.musicVolume;
  return out;
}

// Browse the shared background-footage library (R2 bucket) and pick a segment for the reel.
function FootagePicker({ activeUrl, onPick }: { activeUrl: string; onPick: (seg: FootageSegment) => void }) {
  const [open, setOpen] = useState(false);
  const [segments, setSegments] = useState<FootageSegment[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || segments) return;
    fetchFootageManifest().then(setSegments).catch(() => setError('Couldn’t load the footage library.'));
  }, [open, segments]);
  // Pick a random segment (never the one already active) — loads the manifest on demand so the
  // shuffle works without opening the list first.
  async function pickRandom() {
    try {
      const segs = segments ?? await fetchFootageManifest();
      if (!segments) setSegments(segs);
      const pool = segs.filter(s => s.url !== activeUrl);
      if (pool.length) onPick(pool[Math.floor(Math.random() * pool.length)]);
    } catch {
      setError('Couldn’t load the footage library.');
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => { setError(''); setOpen(o => !o); }}
          className="flex items-center gap-2 h-7 flex-1 min-w-0 text-body text-fg-2 hover:text-fg transition-colors focus-ring rounded-sm"
        >
          <VideoIcon size={13} className="shrink-0" />
          <span className="flex-1 text-left">Background footage</span>
          {open ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
        </button>
        <button
          type="button"
          onClick={pickRandom}
          title="Pick random footage"
          aria-label="Pick random footage"
          className="flex items-center justify-center size-7 shrink-0 rounded-sm text-fg-2 hover:text-fg hover:bg-hover transition-colors focus-ring"
        >
          {shuffleGlyph}
        </button>
      </div>
      {open && (
        error ? <span className="text-caption text-danger-text">{error}</span>
        : !segments ? <span className="text-caption text-fg-3">Loading footage…</span>
        : segments.length === 0 ? <span className="text-caption text-fg-3">No footage uploaded yet.</span>
        : (
          <div className="max-h-56 overflow-y-auto flex flex-col gap-0.5 pr-1">
            {segments.map(s => (
              <button
                key={s.name}
                type="button"
                onClick={() => onPick(s)}
                className={`flex items-center gap-2 px-1.5 h-7 rounded-sm text-caption text-left transition-colors focus-ring ${
                  activeUrl === s.url ? 'bg-active text-fg' : 'text-fg-2 hover:text-fg hover:bg-hover'
                }`}
              >
                <span className="flex-1 truncate">{s.name.replace(/\.mp4$/, '')}</span>
                <span className="text-fg-3 shrink-0">{Math.round(s.size / 1e6)} MB</span>
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
}

// The selected reel's video source — paste a URL / upload a file / pick library footage / fetch.
function ReelLinkFlyout({ entry, onUpdateField, onUpdateLocalVideo, onFetch, onPickFootage }: {
  entry: VideoEntry;
  onUpdateField: (field: 'url' | 'caption', value: string) => void;
  onUpdateLocalVideo: (src: string, name: string, file?: Blob, opts?: { keepStored?: boolean }) => void;
  onFetch: () => void;
  onPickFootage: (seg: FootageSegment) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  // "This reel holds an uploaded file" — a LINKED reel restored from its stored bytes also carries a
  // localVideoSrc, but its link is still the provenance to show, so it keeps the URL input.
  const hasLocal = !!entry.localVideoSrc && !entry.url.trim();
  const [fileError, setFileError] = useState('');
  const [checking, setChecking] = useState(false);
  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';   // reset first: re-picking the SAME file must re-fire
    if (!file) return;
    // Reject a file that could never be exported (or stored) HERE, while the user is still choosing one —
    // rather than at export, after the script has been written and the narration generated.
    setChecking(true);
    const problem = await checkVideoFile(file);
    setChecking(false);
    setFileError(problem ?? '');
    if (problem) return;
    onUpdateLocalVideo(URL.createObjectURL(file), file.name, file);
    onUpdateField('url', '');
  }
  function clearLocalVideo() {
    if (entry.localVideoSrc) URL.revokeObjectURL(entry.localVideoSrc);
    setFileError('');
    onUpdateLocalVideo('', '');
  }
  return (
    <div className="flex flex-col gap-2">
      {hasLocal ? (
        <div className="flex items-center gap-2">
          <VideoIcon size={13} className="text-fg-2 shrink-0" />
          <span className="text-body text-fg-2 truncate flex-1 min-w-0">{entry.localVideoName || 'Uploaded video'}</span>
          <IconButton icon={<UploadIcon />} label="Change video" variant="secondary" onClick={() => fileRef.current?.click()} />
          <IconButton icon={<CloseIcon size={13} />} label="Remove video" variant="secondary" onClick={clearLocalVideo} />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 border border-line-strong rounded-md px-2.5 h-9">
            <LinkIcon size={13} className="text-fg-3 shrink-0" />
            <input
              type="url"
              value={entry.url}
              onChange={e => {
                // Clear-then-set: this reel may be playing bytes we restored for the PREVIOUS link (a
                // commentary reel keeps its own copy). Re-pointing the link makes those the wrong video —
                // and localVideoSrc wins everywhere, so leaving them would pin it and swallow the new link.
                // Drop the restored bytes as the PLAYING source (localVideoSrc wins everywhere, so leaving
                // it would pin the old video and swallow the new link) — but keep them in IndexedDB. This
                // fires on every keystroke, and deleting there destroyed the only copy of a reel whose CDN
                // link had already expired. A real replacement overwrites the record anyway.
                if (entry.localVideoSrc) { URL.revokeObjectURL(entry.localVideoSrc); onUpdateLocalVideo('', '', undefined, { keepStored: true }); }
                setFileError('');   // the rejected file is moot once the reel is being pointed at a link
                onUpdateField('url', e.target.value);
              }}
              onKeyDown={e => { if (e.key === 'Enter') onFetch(); }}
              placeholder="Paste TikTok, Instagram or X URL…"
              className="flex-1 min-w-0 bg-transparent text-body text-fg placeholder:text-fg-3 outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <IconButton
              icon={checking ? <SpinnerIcon style={{ animation: 'spin 1s linear infinite' }} /> : <UploadIcon />}
              label={checking ? 'Checking video…' : 'Upload video file'}
              variant="secondary"
              onClick={() => fileRef.current?.click()}
              disabled={checking}
            />
            <IconButton
              icon={entry.loading ? <SpinnerIcon style={{ animation: 'spin 1s linear infinite' }} /> : <ArrowRightIcon />}
              label="Fetch video"
              variant="secondary"
              onClick={onFetch}
              disabled={entry.loading || !entry.url.trim() || (!!entry.data && !entry.videoFailed)}
            />
          </div>
        </>
      )}
      <FootagePicker activeUrl={isFootageUrl(entry.url) ? entry.url : ''} onPick={onPickFootage} />
      <input ref={fileRef} type="file" accept="video/*" className="hidden" onChange={handleFile} />
      {/* The rejected file was never attached, so this shows in place of the reel's own fetch error. */}
      {fileError && <span className="text-caption text-danger-text">{fileError}</span>}
      {entry.error && !hasLocal && !fileError && <span className="text-caption text-danger-text">{entry.error}</span>}
    </div>
  );
}

// ── Reddit thread flyout ─────────────────────────────────────────────────────────────────────────
// Paste a thread link → /api/reddit imports post + comments → tick the comments/replies to feature →
// the card renders (redditCard.ts) and lands on the canvas as a narratable image overlay whose
// ocrLines are synthetic (pixel-exact, no OCR pass). The picking UI itself is RedditThreadPicker —
// the same component the pipeline's bulk builder renders, so the two can't drift.
//
// ImportedRedditPost/Comment now live in '@/lib/redditPicker' (the picker + both hosts speak them), and
// splitParagraphs in '@/lib/redditThreadEdits' — ONE canonical splitter, shared with the edit-application
// logic, so pick indices and edit indices can never drift apart.

/** Re-normalize depths for an arbitrary selection: a reply whose parent isn't selected is promoted
    to one level under its nearest SELECTED ancestor (or to top level) so connector rails on the
    card only ever point at comments that are actually there. The post body is opt-in per
    paragraph — long story posts would otherwise dwarf the card (title is always the header). */
// How a post image's OCR'd text reveals ('crop' teleprompter vs 'erase' in place — see
// redditTextErase). A persisted preference rather than per-call plumbing: the mode must be BAKED at
// card render (the erase covers are card assets), and every card builder — flyout add, bulk build,
// copy rebuild — goes through buildRedditCardData, so one pref covers them all. Keys + accessors
// live in lib/revealModePref, shared with the pref UI (MemeSource / the Reddit flyout).
const getImageRevealMode = (): ImageRevealMode => getRevealModePref(REDDIT_REVEAL_LS);
const getMemeRevealMode = (): ImageRevealMode => getRevealModePref(MEME_REVEAL_LS);

function buildRedditCardData(post: ImportedRedditPost, comments: ImportedRedditComment[], selected: Set<number>, selectedParas: Set<number>): RedditCardData {
  const paras = splitParagraphs(post.body).filter((_, i) => selectedParas.has(i));
  const chain: (number | null)[] = [];   // chain[origDepth] = new depth of last SELECTED comment there
  const sel: RedditComment[] = [];
  comments.forEach((c, i) => {
    chain.length = c.depth;
    if (selected.has(i)) {
      let parentNew: number | null = null;
      for (let d = c.depth - 1; d >= 0; d--) { const v = chain[d]; if (v != null) { parentNew = v; break; } }
      const nd = parentNew == null ? 0 : parentNew + 1;
      sel.push({ user: c.user, body: c.body, timeAgo: c.timeAgo, score: c.score || undefined, depth: nd, isOP: c.isOP });
      chain[c.depth] = nd;
    } else {
      chain[c.depth] = null;
    }
  });
  return {
    user: post.user, timeAgo: post.timeAgo, title: post.title,
    body: paras.length ? paras.join('\n\n') : undefined,
    score: post.score || undefined, commentCount: post.commentCount || undefined, comments: sel,
    image: post.image,
    imageRevealMode: getImageRevealMode(),
  };
}

// YouTube copy generator — its own rail flyout. Reads the reel's saved Reddit thread link, imports
// the thread (cached for the mount), and generates title + description in one model call, or
// regenerates either individually. Fields persist per reel via Framing (ytTitle / description).
function YtCopyFlyout({ threadUrl, threadEdits, ytTitle, onYtTitleChange, description, onDescriptionChange }: {
  threadUrl: string | null;
  /** Pick-stage text edits for this reel — the copy must describe the tweaked thread, not the original. */
  threadEdits?: RedditThreadEdits;
  ytTitle: string;
  onYtTitleChange: (t: string) => void;
  description: string;
  onDescriptionChange: (d: string) => void;
}) {
  const [descBusy, setDescBusy] = useState<'both' | 'title' | 'description' | null>(null);
  const [descError, setDescError] = useState('');
  const [copied, setCopied] = useState<'title' | 'description' | null>(null);
  const threadCache = useRef<{ post: unknown; comments: unknown[] } | null>(null);

  async function generateCopy(only?: 'title' | 'description') {
    if (!threadUrl || descBusy) return;
    setDescBusy(only ?? 'both'); setDescError(''); setCopied(null);
    try {
      // Import the thread once per mount (cached), then reuse across regenerations.
      let thread = threadCache.current;
      if (!thread) {
        const imp = await fetch('/api/reddit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: threadUrl }),
          signal: AbortSignal.timeout(240_000),
        });
        const impJson = await imp.json();
        if (!imp.ok) throw new Error(impJson.error ?? 'Couldn’t load the thread.');
        thread = { post: impJson.post, comments: impJson.comments ?? [] };
        threadCache.current = thread;
      }
      // Apply the reel's Pick-stage text edits so the generated copy matches what's actually narrated.
      // remapCommentEdits: edit indices are authored in the flyout's depth-0-filtered universe; this raw
      // import is unfiltered, so keys must be translated onto actual array positions first.
      const rawComments = (thread.comments as ImportedRedditComment[]) ?? [];
      const eff = applyThreadEdits(
        thread.post as ImportedRedditPost,
        rawComments,
        remapCommentEdits(rawComments, threadEdits),
      );
      const res = await fetch('/api/description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: threadUrl, thread: { post: eff.post, comments: eff.comments }, only }),
        signal: AbortSignal.timeout(90_000),
      });
      if (eff.skipped.length) setDescError(`Note: ${eff.skipped.length} text tweak${eff.skipped.length === 1 ? '' : 's'} no longer matched the thread and ${eff.skipped.length === 1 ? 'was' : 'were'} skipped.`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Generation failed.');
      if (json.title !== undefined) onYtTitleChange(json.title);
      if (json.description !== undefined) onDescriptionChange(json.description);
    } catch (e) {
      setDescError(e instanceof Error ? e.message : 'Generation failed.');
    } finally {
      setDescBusy(null);
    }
  }
  const copyText = (kind: 'title' | 'description', text: string) => {
    void navigator.clipboard.writeText(text).then(() => { setCopied(kind); setTimeout(() => setCopied(null), 1500); });
  };

  if (!threadUrl) {
    return <p className="text-caption text-fg-3">Import a Reddit thread for this reel first (Reddit thread panel), then generate its YouTube title and description here.</p>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button variant="secondary" size="sm" loading={descBusy === 'both'} disabled={descBusy !== null} onClick={() => void generateCopy()}>
        {ytTitle || description ? 'Regenerate both' : 'Generate title & description'}
      </Button>
      {ytTitle && (
        <div className="flex items-center gap-2 pt-1">
          <span className="text-caption text-fg-3 flex-1">Title</span>
          <button type="button" disabled={descBusy !== null} onClick={() => void generateCopy('title')} className="text-caption text-fg-3 hover:text-fg underline underline-offset-2 disabled:opacity-40">
            {descBusy === 'title' ? 'Regenerating…' : 'Regenerate'}
          </button>
          <button type="button" onClick={() => copyText('title', ytTitle)} className="text-caption text-fg-3 hover:text-fg underline underline-offset-2">
            {copied === 'title' ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      )}
      {ytTitle && (
        <>
          <input
            type="text"
            value={ytTitle}
            onChange={e => onYtTitleChange(e.target.value)}
            className="w-full rounded-md border border-line-strong bg-transparent px-2 h-8 text-caption text-fg outline-none"
          />
          <span className={`text-caption ${ytTitle.length > 100 ? 'text-danger-text' : 'text-fg-3'}`}>{ytTitle.length} / 100</span>
        </>
      )}
      {description && (
        <div className="flex items-center gap-2 pt-1">
          <span className="text-caption text-fg-3 flex-1">Description</span>
          <button type="button" disabled={descBusy !== null} onClick={() => void generateCopy('description')} className="text-caption text-fg-3 hover:text-fg underline underline-offset-2 disabled:opacity-40">
            {descBusy === 'description' ? 'Regenerating…' : 'Regenerate'}
          </button>
          <button type="button" onClick={() => copyText('description', description)} className="text-caption text-fg-3 hover:text-fg underline underline-offset-2">
            {copied === 'description' ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      )}
      {description && (
        <>
          <textarea
            value={description}
            onChange={e => onDescriptionChange(e.target.value)}
            rows={7}
            className="w-full rounded-md border border-line-strong bg-transparent p-2 text-caption text-fg leading-snug outline-none resize-y"
          />
          <span className={`text-caption ${description.length > 5000 ? 'text-danger-text' : 'text-fg-3'}`}>{description.length} / 5000</span>
        </>
      )}
      {descError && <span className="text-caption text-danger-text">{descError}</span>}
    </div>
  );
}

function RedditFlyout({ hasVideo, saved, onSaveThread, onAdd, speed }: {
  hasVideo: boolean;
  /** Persisted thread state for this reel (rides Framing, like music). */
  saved?: { url: string; comments?: number[]; paras?: number[]; edits?: RedditThreadEdits } | null;
  onSaveThread: (s: { url: string; comments?: number[]; paras?: number[]; edits?: RedditThreadEdits } | null) => void;
  onAdd: (card: RedditCardResult, dims: { w: number; h: number }, blockAuthors: string[]) => Promise<void>;
  /** Narration speed — the picker's length estimate has to match what this reel will actually narrate. */
  speed: number;
}) {
  const [url, setUrl] = useState(saved?.url ?? '');
  const [busy, setBusy] = useState<'import' | 'add' | null>(null);
  const [error, setError] = useState('');
  // Separate from `error` on purpose: a degraded import SUCCEEDED — the thread is usable. Rendering it
  // in danger red would read as "this failed, don't proceed", which is the wrong instruction.
  const [notice, setNotice] = useState<ImportNotice | null>(null);
  // Mirrors the persisted pref (the card builders read the pref directly — see getImageRevealMode).
  const [imgRevealMode, setImgRevealMode] = useState<ImageRevealMode>(() => getImageRevealMode());
  const [post, setPost] = useState<ImportedRedditPost | null>(null);
  const [comments, setComments] = useState<ImportedRedditComment[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectedParas, setSelectedParas] = useState<Set<number>>(new Set());
  // Pick-stage TEXT edits (title / paragraph / comment overrides, keyed by import index). Persisted on
  // redditThread so they survive reloads AND re-imports (text is re-fetched; overrides re-apply by index).
  const [edits, setEdits] = useState<RedditThreadEdits>({});
  // The url the DISPLAYED post was imported from — the persist effect must save against this, never the
  // live input (typing a new url then toggling would otherwise attach the OLD thread's index-keyed
  // selections+edits to the NEW url).
  const importedUrlRef = useRef(saved?.url ?? '');

  async function importThread() {
    setBusy('import'); setError(''); setNotice(null); setPost(null); setComments([]); setSelected(new Set()); setSelectedParas(new Set()); setEdits({});
    try {
      const res = await fetch('/api/reddit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(240_000),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Import failed.');
      setPost(json.post);
      // A 200 can still be a DEGRADED import (Reddit throttled the good transport) or one whose image
      // failed to download. Both used to be completely invisible — same shape as a plain text post.
      setNotice(importNotice(json));
      // Depth-0 only — THIS filtered list is the universe comment-edit indices are authored in (the
      // copy paths remap onto their unfiltered arrays via remapCommentEdits).
      setComments((json.comments ?? []).filter((c: ImportedRedditComment) => (c.depth ?? 0) === 0));
      importedUrlRef.current = url.trim();
      // Persist the link with the reel; re-importing the saved link restores the saved selection + edits.
      if (saved?.url === url.trim()) {
        setSelected(new Set(saved.comments ?? []));
        setSelectedParas(new Set(saved.paras ?? []));
        setEdits(saved.edits ?? {});
      } else {
        onSaveThread({ url: url.trim() });   // new url → old selections AND edits are meaningless
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(null);
    }
  }

  const toggle = (kind: 'c' | 'p', i: number) =>
    (kind === 'c' ? setSelected : setSelectedParas)(prev => toggleIndex(prev, i));
  // Selection + text edits persist alongside the IMPORTED link (never the live input — see importedUrlRef).
  useEffect(() => {
    if (post && importedUrlRef.current) {
      onSaveThread({
        url: importedUrlRef.current, comments: [...selected], paras: [...selectedParas],
        edits: hasThreadEdits(edits) ? edits : undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, selectedParas, edits]);

  // The thread as the shared picker sees it. Its comment index space is THIS depth-0 list, which is also
  // the space redditThread.comments is stored in — see the depth-0 filter in importThread.
  const thread: PickableThread | null = useMemo(
    () => (post ? { post, comments, paragraphs: splitParagraphs(post.body), selectedComments: selected, selectedParas, edits } : null),
    [post, comments, selected, selectedParas, edits],
  );

  const totalSelected = selected.size + selectedParas.size;

  async function addToReel() {
    if (!post) return;
    setBusy('add'); setError('');
    try {
      // Apply the text edits BEFORE the card render — the card, its ocrLines (narration + reveals) and the
      // copy stage (which reads edits from redditThread) all inherit the tweaked text. remapCommentEdits
      // content-anchors the overrides onto THIS list (edits may have been authored against a differently
      // interleaved array, e.g. the bulk builder's full tree).
      const eff = applyThreadEdits(post, comments, remapCommentEdits(comments, hasThreadEdits(edits) ? edits : undefined));
      if (eff.skipped.length) setError(`Note: ${eff.skipped.length} tweak${eff.skipped.length === 1 ? '' : 's'} (${eff.skipped.join(', ')}) no longer matched the thread and ${eff.skipped.length === 1 ? 'was' : 'were'} skipped.`);
      const data = buildRedditCardData(eff.post, eff.comments, selected, selectedParas);
      const card = await renderRedditCard(data);
      // Author per narration block, aligned with MemeLine.blockIdx: 0/1 = post title/body,
      // 2+i = the i-th comment on the card. Lets the overlay arrive pre-painted per participant.
      const postAuthor = data.user.name.replace(/^u\//, '');
      const blockAuthors = [postAuthor, postAuthor, ...data.comments.map(c => c.user.name.replace(/^u\//, ''))];
      await onAdd(card, { w: card.width, h: card.height }, blockAuthors);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t render the card.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2 border border-line-strong rounded-md px-2.5 h-9 shrink-0">
        <LinkIcon size={13} className="text-fg-3 shrink-0" />
        <input
          type="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && url.trim() && !busy) void importThread(); }}
          placeholder="Paste a Reddit thread link…"
          className="flex-1 min-w-0 bg-transparent text-body text-fg placeholder:text-fg-3 outline-none"
        />
        <IconButton
          icon={busy === 'import' ? <SpinnerIcon style={{ animation: 'spin 1s linear infinite' }} /> : <ArrowRightIcon />}
          label="Import thread"
          variant="secondary"
          onClick={() => void importThread()}
          disabled={!url.trim() || busy !== null}
        />
      </div>
      {thread && (
        <>
          {/* The pipeline's picker, for this one reel: same list, reading pane, script preview, Clean text
              and undo/redo — minus everything multi-thread (no tabs, no "add more threads", no building). */}
          {/* Fills the modal body rather than a fixed viewport slice: the old h-[58vh] was sized for the
              rail flyout, and inside the centred modal it left dead space below the picker. */}
          <div className="flex flex-1 min-h-0 rounded-lg border border-line overflow-hidden">
            <RedditThreadPicker
              threadKey={importedUrlRef.current}
              thread={thread}
              speed={speed}
              onToggle={toggle}
              onEdits={setEdits}
            />
          </div>
          {/* shrink-0: the picker above is the only thing that should give up space. Without it the footer
              gets squeezed under its own content and the Add button drifts off the bottom of the modal. */}
          <div className="flex shrink-0 flex-col gap-2">
            <Button
              variant="primary"
              onClick={() => void addToReel()}
              disabled={busy !== null || totalSelected === 0 || !hasVideo}
            >
              {busy === 'add' ? 'Adding…' : `Add to reel${totalSelected ? ` (${totalSelected})` : ''}`}
            </Button>
            {/* Image-text reveal mode — only meaningful when the post HAS a picture. Baked at card
                render, so switching it after Add means re-adding; persisted, so bulk follows it too. */}
            {thread?.post.image && (
              <div className="flex items-center gap-1.5">
                <span className="text-caption text-fg-3">Image text:</span>
                {([['crop', 'scroll reveal'], ['erase', 'erase & reveal in place']] as const).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    title={m === 'crop'
                      ? 'The card scrolls through the image line by line (teleprompter)'
                      : 'The whole image appears with its text hidden; each line un-erases as it’s read'}
                    onClick={() => { setImgRevealMode(m); setRevealModePref(REDDIT_REVEAL_LS, m); }}
                    className={`rounded-md border px-2 py-0.5 text-caption transition-colors ${imgRevealMode === m
                      ? 'border-accent-border bg-accent-tint text-accent-text'
                      : 'border-line-strong text-fg-3 hover:bg-hover'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {!hasVideo && <span className="text-caption text-fg-3">Add a video to the reel first — the card overlays it.</span>}
          </div>
        </>
      )}
      {error && <span className="text-caption text-danger-text">{error}</span>}
      {/* Sits below the picker so it can't push the thread out of view. Only a RETRYABLE notice offers the
          button — telling someone to re-import a gallery would send them round a loop that can't succeed. */}
      {notice && (
        <div className="flex items-start gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-2">
          <span className="flex-1 text-caption leading-relaxed text-fg-2">{notice.message}</span>
          {notice.retryable && (
            <button
              type="button"
              onClick={() => void importThread()}
              disabled={busy !== null}
              className="shrink-0 text-caption font-medium text-accent-text hover:underline underline-offset-2 disabled:opacity-40"
            >
              Re-import
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Narration flyout ─────────────────────────────────────────────────────────────────────────────
// ElevenLabs narration for a meme overlay, straight off the image (OCR). Multiple voices: the first
// voice is the default narrator; arm another voice as a "brush" and click OCR line highlights on the
// overlay to paint paragraphs with it. Consecutive same-voice lines are spoken as one take; takes are
// stitched into one narration track, synced to the playhead in preview and mixed into the export,
// with the image un-cropping line by line as each line is read.
const LS_11L_KEY = 'reels:11labs-key';
const LS_11L_VOICE = 'reels:11labs-voice';       // legacy single-voice key, migrated into the list
const LS_11L_VOICES = 'reels:11labs-voices';
// Per-voice channel gain (0..1.5, 1 = as generated) — a mixer for the cast, since ElevenLabs
// voices vary in loudness. Applied when the takes are stitched, so changes need a regenerate.
const LS_VOICE_GAINS = 'reels:voice-gains';

// A style's fixed voice cast (Reddit's post + commenter pool) now lives with the style — see
// ReelStyle.voiceCast — so this shell shows A cast without knowing whose it is.
// Narration delivery speed via ElevenLabs' native `speed` setting (1 = natural, 1.2 = the API's
// max). Chosen in the Narration flyout, persisted per browser, applies to every generated take.
const LS_NARRATION_SPEED = 'reels:narration-speed';
const NARRATION_SPEEDS = [1, 1.05, 1.1, 1.15, 1.2] as const;
const DEFAULT_NARRATION_SPEED = 1.15;

// Short-length model (SHORTS_MAX_SECONDS / estimateNarrationSeconds / reelDurationInfo) lives in
// '@/lib/reelDuration' — imported at the top — so it's unit-testable in isolation.

// Known but disabled voices: excluded from the auto-cast pool AND substituted out at narration time,
// so a persisted assignment from an old card never actually voices them. Kept here only so the
// timeline still shows their name for a not-yet-regenerated take.
const DISABLED_VOICES = [
  { id: 'Z3R5wn05IrDiVCyEkUrK', name: 'Arabella' },   // Mysterious and Emotive (US) — disabled for now
  { id: 'Bj9UqZbhQsanLzgalpEG', name: 'Austin' },     // Deep Raspy and Authentic (US Southern) — disabled for now
  // Reddit is single-voice for now (see REDDIT_VOICE_CAST): its old supporting cast is retired here so a
  // card cast BEFORE that change re-voices to Mark on regeneration instead of keeping a stale voice mix.
  { id: 'NNl6r8mD7vthiJatiJt1', name: 'Bradford' },   // Expressive and Articulate (British)
  { id: 'EkK5I93UQWFDigLMpZcX', name: 'James' },      // Husky, Engaging and Bold (US)
  { id: 'aMSt68OGf4xUZAnLpTU8', name: 'Juniper' },    // Grounded and Professional (US)
];
const DISABLED_VOICE_IDS = new Set(DISABLED_VOICES.map(v => v.id));
const DEFAULT_VOICE = 'TX3LPaxmHKxFdv7VOQHJ';   // ElevenLabs "Liam" — energetic social-media narrator, premade so free-tier keys can use it

// Fit a rendered card into the 1080x1920 frame (whole card visible pre-narration) and cast its lines
// from `cast`. Shared by the single-add path and the bulk builder.
function cardOverlayLayout(lines: MemeLine[], dims: { w: number; h: number }, blockAuthors: string[], cast: VoiceCast | null) {
  const blockVoice = castBlockVoices(blockAuthors, cast);
  const ocrLines = lines.map(l => ({ ...l, enabled: true, voiceId: blockVoice[l.blockIdx] }));
  const w = Math.round(Math.min(0.8 * 1080, 1632 * (dims.w / dims.h)));
  const h = Math.round(w * (dims.h / dims.w));
  return { ocrLines, rect: { w, h, x: Math.round((1080 - w) / 2), y: Math.round((1920 - h) / 2) } };
}

// Cast a voice per narration block (indexed like blockAuthors / MemeLine.blockIdx). Fresh shuffle
// each call. The lead block's author (Reddit: the post) and its replies read as `cast.lead`; other
// speakers draw from the shuffled pool with the guarantee that no two consecutive blocks by DIFFERENT
// speakers share a voice (same speaker in a row keeps it; a voice may recur non-adjacently).
//
// A style with NO fixed cast returns no assignments at all: every line then carries an undefined
// voiceId and reads in the user's default narrator, which is exactly the un-cast behaviour. Returning
// an empty array rather than throwing keeps a cast-less style (meme) on the same code path.
function castBlockVoices(blockAuthors: string[], cast: VoiceCast | null): string[] {
  if (!cast || cast.pool.length === 0) return [];
  const pool = cast.pool.map(v => v.id).sort(() => Math.random() - 0.5);
  const postAuthor = blockAuthors[0] ?? '';
  const authorVoice = new Map<string, string>();
  let poolIdx = 0;
  const nextPoolVoice = (avoid: string | null): string => {
    let v = pool[poolIdx % pool.length];
    if (v === avoid && pool.length > 1) { poolIdx++; v = pool[poolIdx % pool.length]; }
    poolIdx++;
    return v;
  };
  const blockVoice: string[] = [];
  let prev: string | null = null;
  for (let b = 0; b < blockAuthors.length; b++) {
    const author = blockAuthors[b] ?? '';
    let v: string;
    if (b > 0 && author === (blockAuthors[b - 1] ?? '')) v = blockVoice[b - 1];
    else if (author === postAuthor) v = cast.lead.id;
    else { const known = authorVoice.get(author); v = known && known !== prev ? known : nextPoolVoice(prev); authorVoice.set(author, v); }
    blockVoice[b] = v; prev = v;
  }
  return blockVoice;
}
const VOICE_COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#fb7185'];

/** Mono 16-bit PCM WAV — used to stitch multiple ElevenLabs takes into one narration track that both
    the preview <audio> and the export's decodeAudioData handle without MP3-concatenation glitches. */
function encodeWavMono(samples: Float32Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const writeStr = (o: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(o + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function loadSavedVoices(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_11L_VOICES) ?? 'null');
    if (Array.isArray(saved) && saved.length > 0) return saved.map(String);
    return [localStorage.getItem(LS_11L_VOICE) ?? DEFAULT_VOICE];
  } catch {
    return [DEFAULT_VOICE];
  }
}

// Commentary reels: write/edit the voice-over SCRIPT for the selected reel and voice it in place.
// The script persists in Framing.commentaryScript (autosaved); voicing runs the same generator as the
// pipeline's Narrate step, so both paths produce the identical intro overlay (voice + karaoke captions).
function CommentaryScriptFlyout({ script, narrated, onScriptChange, onVoice }: {
  script: string;
  /** The reel already carries a voiced intro — voicing again replaces that take. */
  narrated: boolean;
  onScriptChange: (s: string) => void;
  onVoice: (onStatus: (s: string) => void) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const voice = async () => {
    if (busy) return;
    setBusy(true); setError(null); setStatus('Starting…');
    try {
      const err = await onVoice(setStatus);
      setError(err);
      setStatus(err ? '' : 'Voiced ✓ — press play to hear it with the captions.');
    } catch {
      setError('Narration failed — try again.');
      setStatus('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-caption text-fg-3">Commentary script <span className="text-fg-4">· spoken over the start</span></span>
      <textarea
        value={script}
        onChange={e => onScriptChange(e.target.value)}
        rows={8}
        placeholder="What the narrator says over the intro…"
        className="focus-ring w-full resize-y rounded-md border border-line bg-surface-1 px-2 py-1.5 text-body text-fg leading-relaxed placeholder:text-fg-4"
      />
      <Button variant="primary" size="sm" loading={busy} disabled={busy || !script.trim()} onClick={() => void voice()}>
        {narrated ? 'Re-voice narration' : 'Voice narration'}
      </Button>
      {status && !error && <span className="text-caption text-fg-3">{status}</span>}
      {error && <span className="text-caption text-danger-text">{error}</span>}
      {narrated && !busy && !status && <span className="text-caption text-fg-4">Narrated ✓ — voicing again replaces the current take.</span>}
    </div>
  );
}

function NarrateFlyout({ overlays, scripted, primaryOverlayName, voiceCast, voices, onVoicesChange, brushId, onBrushChange, voiceColors, speed, onSpeedChange, voiceGains, onVoiceGainsChange, onGenerate, onClearNarration, onShuffleVoices }: {
  overlays: ImageOverlay[];
  /** This reel's style is voiced from a SCRIPT (ReelStyle.narration === 'script'): the Narrate step writes
      one intro overlay, so the per-overlay narration controls below don't apply — see the scripted branch. */
  scripted: boolean;
  /** The style's narratable card overlay (ReelStyle.primaryOverlayName). An overlay by this name arrives
      pre-cast, so it shows the fixed cast instead of the editable palette. null = the style has none, and
      every overlay here is a plain user-added image. */
  primaryOverlayName: string | null;
  /** The style's fixed cast for that overlay, or null when the user picks the voices. */
  voiceCast: VoiceCast | null;
  voices: string[];
  onVoicesChange: (v: string[]) => void;
  brushId: string | null;
  onBrushChange: (id: string | null) => void;
  voiceColors: Record<string, string>;
  speed: number;
  onSpeedChange: (s: number) => void;
  voiceGains: Record<string, number>;
  onVoiceGainsChange: (g: Record<string, number>) => void;
  onGenerate: (overlayId: string, apiKey: string, onStatus: (s: string) => void) => Promise<string | null>;
  onClearNarration: (overlayId: string) => void;
  onShuffleVoices: (overlayId: string) => void;
}) {
  const [apiKey, setApiKey] = useState(() => { try { return localStorage.getItem(LS_11L_KEY) ?? ''; } catch { return ''; } });
  const [targetId, setTargetId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const target = overlays.find(o => o.id === targetId) ?? overlays[0];
  // Is the selected overlay this style's pre-cast card? Guarded on a non-null name so a style WITHOUT a
  // primary overlay can't match a nameless one and claim a cast it doesn't have.
  const targetIsCard = !!primaryOverlayName && target?.name === primaryOverlayName && !!voiceCast;

  // A script-voiced reel gets its voice from the Narrate step, which writes one intro overlay (voice +
  // karaoke captions) that the canvas plays/mixes exactly. Narrating an arbitrary overlay here would store
  // audio nothing ever voices, so the whole per-overlay UI (target picker, voice palette, brush, Generate)
  // is not offered. Clearing the intro stays — it's how you re-run the Narrate step, which skips a reel
  // that's already voiced.
  if (scripted) {
    const intro = overlays.find(o => o.intro && o.audioId);
    return (
      <div className="flex flex-col gap-2">
        <p className="text-caption text-fg-3">
          These reels are voiced from their script — write and voice it in the script panel
          (the document icon in this rail), or run the pipeline’s Narrate step.
        </p>
        {intro && (
          <button
            type="button"
            onClick={() => { onClearNarration(intro.id); setMsg('Narration removed — run Narrate to voice it again.'); }}
            className="self-start text-caption text-danger-text hover:underline underline-offset-2"
          >
            Remove narration
          </button>
        )}
        {msg && <span className="text-caption text-fg-3">{msg}</span>}
      </div>
    );
  }

  if (overlays.length === 0) {
    return <p className="text-caption text-fg-3">Add an image overlay first — then narrate it here.</p>;
  }

  const generate = async () => {
    if (!target || busy) return;
    setBusy(true); setMsg('Preparing narration…');
    try {
      const err = await onGenerate(target.id, apiKey.trim(), setMsg);
      setMsg(err ?? 'Narration attached — press play to watch the reveal.');
    } catch {
      setMsg('Narration failed — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {overlays.length > 1 && (
        <select
          value={target?.id ?? ''}
          onChange={e => setTargetId(e.target.value)}
          aria-label="Overlay to narrate"
          className="h-8 rounded-md border border-line-strong bg-transparent px-2 text-body text-fg outline-none"
        >
          {overlays.map(o => <option key={o.id} value={o.id}>{o.name || 'Image'}</option>)}
        </select>
      )}
      <input
        type="password"
        value={apiKey}
        onChange={e => { setApiKey(e.target.value); try { localStorage.setItem(LS_11L_KEY, e.target.value); } catch { /* ignore */ } }}
        placeholder="ElevenLabs API key (blank = server key)"
        className="h-8 rounded-md border border-line-strong bg-transparent px-2 text-body text-fg placeholder:text-fg-3 outline-none"
      />
      {targetIsCard && voiceCast ? (
        <>
          {/* This style's cards arrive auto-cast — show the fixed cast; dots arm a repaint brush. */}
          <p className="text-caption text-fg-3">Cast (auto-assigned) — arm a dot to repaint lines:</p>
          {/* One row per unique VOICE, not per cast slot: brush and gain are keyed by voice id, so a
              voice that is both the lead and in the pool (the whole cast, while single-voice Mark is
              in force) would render as two identical rows fighting over one key. First wins → the
              lead's 'the post' role is the one shown. */}
          {[{ ...voiceCast.lead, role: 'the post' }, ...voiceCast.pool.map(v => ({ ...v, role: 'commenter pool' }))]
            .filter((v, i, a) => a.findIndex(x => x.id === v.id) === i).map(v => (
            <div key={v.id} className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label={brushId === v.id ? `Disarm ${v.name} brush` : `Arm ${v.name} brush`}
                title={brushId === v.id ? 'Brush armed — click lines on the card; click here to disarm' : `Arm ${v.name}, then click lines on the card to paint them`}
                onClick={() => onBrushChange(brushId === v.id ? null : v.id)}
                className={`grid size-7 shrink-0 place-items-center rounded-md border transition-colors ${brushId === v.id ? 'border-accent bg-accent/15' : 'border-line-strong hover:border-accent-border'}`}
              >
                <span className="size-3 rounded-full" style={{ background: voiceColors[v.id] }} />
              </button>
              <span className="text-body text-fg truncate" title={`${v.name} — ${v.role}`}>{v.name}</span>
              {v.role === 'the post' && <span className="text-caption text-fg-3 shrink-0">post</span>}
              <input
                type="range" min={0} max={1.5} step={0.05}
                value={voiceGains[v.id] ?? 1}
                title={`Channel volume: ${Math.round((voiceGains[v.id] ?? 1) * 100)}% (applies on next Generate)`}
                onChange={e => onVoiceGainsChange({ ...voiceGains, [v.id]: Number(e.target.value) })}
                className="w-16 shrink-0 ml-auto"
              />
              <span className="text-caption text-fg-3 w-8 text-right shrink-0">{Math.round((voiceGains[v.id] ?? 1) * 100)}%</span>
            </div>
          ))}
        </>
      ) : (
        <>
          {/* Voice palette (meme/OCR overlays): row 0 is the default narrator; the colored dot arms
              that voice as a brush for painting lines on the overlay. */}
          {voices.map((v, i) => {
            const id = v.trim();
            return (
              <div key={i} className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={id && brushId === id ? 'Disarm voice brush' : `Arm voice ${i + 1} brush`}
                  title={id && brushId === id ? 'Brush armed — click lines on the image; click here to disarm' : 'Arm this voice, then click lines on the image to paint them'}
                  onClick={() => { if (id) onBrushChange(brushId === id ? null : id); }}
                  className={`grid size-7 shrink-0 place-items-center rounded-md border transition-colors ${id && brushId === id ? 'border-accent bg-accent/15' : 'border-line-strong hover:border-accent-border'}`}
                >
                  <span className="size-3 rounded-full" style={{ background: VOICE_COLORS[i % VOICE_COLORS.length] }} />
                </button>
                <input
                  type="text"
                  value={v}
                  onChange={e => onVoicesChange(voices.map((x, j) => (j === i ? e.target.value : x)))}
                  placeholder={i === 0 ? 'Default voice ID (Liam)' : 'Voice ID'}
                  className="h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-transparent px-2 text-body text-fg placeholder:text-fg-3 outline-none"
                />
                {id && (
                  <input
                    type="range" min={0} max={1.5} step={0.05}
                    value={voiceGains[id] ?? 1}
                    title={`Channel volume: ${Math.round((voiceGains[id] ?? 1) * 100)}% (applies on next Generate)`}
                    onChange={e => onVoiceGainsChange({ ...voiceGains, [id]: Number(e.target.value) })}
                    className="w-12 shrink-0"
                  />
                )}
                {i > 0 && (
                  <button
                    type="button"
                    aria-label="Remove voice"
                    onClick={() => { if (id && brushId === id) onBrushChange(null); onVoicesChange(voices.filter((_, j) => j !== i)); }}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 hover:text-danger-text"
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                )}
              </div>
            );
          })}
          {voices.length < VOICE_COLORS.length && (
            <button
              type="button"
              onClick={() => onVoicesChange([...voices, ''])}
              className="self-start text-caption text-fg-3 hover:text-fg underline underline-offset-2"
            >
              + Add voice
            </button>
          )}
        </>
      )}
      <p className="text-caption text-fg-3">
        {brushId != null
          ? 'Brush armed — click lines on the image to give them this voice. Same-voice lines read as one paragraph.'
          : targetIsCard && voiceCast
            ? `The post reads as ${voiceCast.lead.name}; each commenter gets a random cast voice, revealing line by line in sync.`
            : 'Reads the detected text as a hyped take, un-cropping line by line. Click lines on the overlay to skip them, or arm a voice dot to paint paragraphs.'}
      </p>
      {/* Delivery speed: ElevenLabs re-performs the read faster (1.2 is the API max) — reveal
          timing follows automatically. Applies to the next Generate. */}
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-caption text-fg-3 mr-0.5">Speed</span>
        {NARRATION_SPEEDS.map(s => (
          <button
            key={s}
            type="button"
            onClick={() => onSpeedChange(s)}
            className={`h-6 px-1.5 rounded-md border text-caption transition-colors ${
              speed === s ? 'border-accent bg-accent/15 text-fg' : 'border-line-strong text-fg-2 hover:text-fg hover:border-accent-border'
            }`}
          >
            {s === 1 ? '1x' : `${s}x`}
          </button>
        ))}
      </div>
      {targetIsCard && target.blockAuthors && (
        <button
          type="button"
          disabled={busy}
          onClick={() => { if (target) { onShuffleVoices(target.id); setMsg('Voices reshuffled — generate to hear them.'); } }}
          className="self-start text-caption text-fg-2 hover:text-fg underline underline-offset-2 disabled:opacity-40"
        >
          ⇄ Shuffle voices
        </button>
      )}
      <Button variant="primary" size="sm" loading={busy} onClick={generate}>
        {target?.audioId ? 'Regenerate narration' : 'Generate narration'}
      </Button>
      {target?.audioId && (
        <button
          type="button"
          disabled={busy}
          onClick={() => { if (target) { onClearNarration(target.id); setMsg('Narration removed.'); } }}
          className="self-start text-caption text-danger-text hover:underline underline-offset-2 disabled:opacity-40"
        >
          Remove narration
        </button>
      )}
      {msg && <span className="text-caption text-fg-3">{msg}</span>}
    </div>
  );
}

// The selected reel's video adjustments as a rail-island icon-button COLUMN (rail convention):
// zoom in, zoom out, reset (framing + trim + zoom back to defaults), center, and the timeline toggle.
function ReelAdjustFlyout({ zoom, onZoom, onResetTrim, onResetBox, onCenter, timelineOpen, onToggleTimeline, onRemoveVideo, bgBlur, onToggleBgBlur, thumbnailName, onPickThumbnail, onClearThumbnail, onShuffleFootage }: {
  zoom: number;
  onZoom: (z: number) => void;
  onResetTrim: () => void;
  onResetBox: () => void;
  onCenter: () => void;
  timelineOpen: boolean;
  onToggleTimeline: () => void;
  onRemoveVideo: () => void;
  /** Blurred letterbox fill for this reel (absent = the toggle is hidden, e.g. Reddit reels). */
  bgBlur?: boolean;
  onToggleBgBlur?: () => void;
  /** Custom thumbnail: a still held for a few frames at the very start of the export, so it can be picked
      in YouTube's Shorts frame picker (absent = the control is hidden — see @/lib/thumbnailLead). */
  thumbnailName?: string;
  onPickThumbnail?: (file: File) => void;
  onClearThumbnail?: () => void;
  /** Re-roll this reel's background footage (absent = the button is hidden, e.g. commentary reels, whose
      video is the uploaded clip rather than an assigned one). */
  onShuffleFootage?: () => void;
}) {
  const STEP = 0.05, MIN = 0.5, MAX = 3;
  const round2 = (z: number) => Math.round(z * 100) / 100;
  const thumbInputRef = useRef<HTMLInputElement>(null);
  // Just the button column — ElementRail provides the animated pill card (it expands in once a video
  // is loaded), so this renders only the content.
  return (
    <>
      <RailActionButton label={`Zoom in (${Math.round(zoom * 100)}%)`}  icon={zoomInGlyph}  disabled={zoom >= MAX} onClick={() => onZoom(Math.min(MAX, round2(zoom + STEP)))} />
      <RailActionButton label={`Zoom out (${Math.round(zoom * 100)}%)`} icon={zoomOutGlyph} disabled={zoom <= MIN} onClick={() => onZoom(Math.max(MIN, round2(zoom - STEP)))} />
      <RailActionButton label="Reset"  icon={resetGlyph}  onClick={() => { onResetBox(); onResetTrim(); onZoom(1); }} />
      <RailActionButton label="Center" icon={centerGlyph} onClick={onCenter} />
      {onToggleBgBlur && (
        <RailActionButton label={bgBlur ? 'Blur fill: on' : 'Blur fill: off'} icon={blurGlyph} onClick={onToggleBgBlur} active={!!bgBlur} />
      )}
      {onShuffleFootage && (
        <RailActionButton label="Shuffle footage" icon={shuffleGlyph} onClick={onShuffleFootage} />
      )}
      {onPickThumbnail && (
        <>
          {/* Click sets/replaces the still; when one is attached, a second click on the ACTIVE button clears
              it — the rail is an icon column with no room for a separate remove button. */}
          <RailActionButton
            label={thumbnailName ? `Thumbnail: ${thumbnailName} (click to remove)` : 'Set thumbnail'}
            icon={thumbGlyph}
            active={!!thumbnailName}
            onClick={() => { if (thumbnailName) onClearThumbnail?.(); else thumbInputRef.current?.click(); }}
          />
          <input
            ref={thumbInputRef} type="file" accept="image/*" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPickThumbnail(f); }}
          />
        </>
      )}
      <RailActionButton label={timelineOpen ? 'Hide timeline' : 'Open timeline'} icon={timelineGlyph} onClick={onToggleTimeline} active={timelineOpen} />
      <RailActionButton label="Remove video" icon={removeVideoGlyph} onClick={onRemoveVideo} />
    </>
  );
}

// Empty timeline strip — shown when the reels timeline is toggled open before a video is loaded.
// Matches VideoControlsBar's outer frame so the bottom strip looks consistent either way.
function EmptyTimeline() {
  return (
    <div className="shrink-0 mx-3 mb-3 rounded-lg border border-line bg-surface-1 px-4 py-3">
      <div className="h-14 rounded-md border border-dashed border-line bg-surface-2 flex items-center justify-center">
        <span className="text-caption text-fg-3">No video yet — paste a link or upload a clip to edit the timeline.</span>
      </div>
    </div>
  );
}

// Undo/redo history for the reels' URL + caption text edits. Snapshots the pre-edit state at the start of
// a typing burst and commits it on a 500ms debounce (coalescing the burst into one undo step), mirroring the
// template editor's history. Scope: the reels' url + caption only.
type ReelEditSnap = Record<string, { url: string; caption: string }>;
function useReelEditHistory(
  entries: VideoEntry[],
  onUpdateEntry: (id: string, field: 'url' | 'caption', value: string) => void,
) {
  const entriesRef = useRef(entries);
  useEffect(() => { entriesRef.current = entries; }, [entries]);
  const snap = useCallback((): ReelEditSnap => {
    const m: ReelEditSnap = {};
    for (const e of entriesRef.current) m[e.id] = { url: e.url ?? '', caption: e.caption ?? '' };
    return m;
  }, []);
  const past = useRef<ReelEditSnap[]>([]);
  const future = useRef<ReelEditSnap[]>([]);
  const base = useRef<ReelEditSnap | null>(null);   // pre-burst snapshot, committed on debounce
  const burstId = useRef<string | null>(null);      // the reel id the current burst is editing
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // canUndo/canRedo are held in state (computed from the ref stacks via refresh()), so the render never
  // reads refs — refresh runs only from the mutation handlers below.
  const [flags, setFlags] = useState({ canUndo: false, canRedo: false });
  const refresh = useCallback(() => {
    setFlags({ canUndo: past.current.length > 0 || base.current != null, canRedo: future.current.length > 0 });
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const commit = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (base.current) { past.current.push(base.current); base.current = null; refresh(); }
  }, [refresh]);
  const apply = useCallback((target: ReelEditSnap) => {
    for (const e of entriesRef.current) {
      const t = target[e.id];
      if (!t) continue;
      if ((e.url ?? '') !== t.url) onUpdateEntry(e.id, 'url', t.url);
      if ((e.caption ?? '') !== t.caption) onUpdateEntry(e.id, 'caption', t.caption);
    }
  }, [onUpdateEntry]);
  const recordEdit = useCallback((id: string, field: 'url' | 'caption', value: string) => {
    if (base.current && burstId.current !== id) commit();   // editing a different reel → close the prior reel's burst
    if (!base.current) { base.current = snap(); burstId.current = id; future.current = []; }   // burst start → a new edit clears redo
    onUpdateEntry(id, field, value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(commit, 500);
    refresh();
  }, [snap, onUpdateEntry, commit, refresh]);
  const undo = useCallback(() => {
    commit();   // flush any in-progress burst so it's undoable
    if (!past.current.length) return;
    const prev = past.current.pop()!;
    future.current.push(snap());
    apply(prev);
    refresh();
  }, [commit, snap, apply, refresh]);
  const redo = useCallback(() => {
    commit();
    if (!future.current.length) return;
    const next = future.current.pop()!;
    past.current.push(snap());
    apply(next);
    refresh();
  }, [commit, snap, apply, refresh]);

  return { recordEdit, undo, redo, canUndo: flags.canUndo, canRedo: flags.canRedo };
}

// ── Bulk builder ──────────────────────────────────────────────────────────────
// Paste many Reddit thread links, import them all, tick comments/paragraphs per thread on one page,
// then build a reel per thread (random footage + card). Keeps the human step (choosing comments)
// while automating the rest.
interface BulkThread {
  url: string;
  post: ImportedRedditPost;
  comments: ImportedRedditComment[];
  /** Why this import came back incomplete, if it did — see importNotice. Bulk is the path MOST exposed to
      Reddit's throttle (3 concurrent imports through one shared page), so a silent degrade here quietly
      builds a whole batch of reels with no images and no reply tree. Deliberately NOT persisted: it
      describes the import EVENT, and a restored thread was not imported in this session. */
  notice?: ImportNotice | null;
  paragraphs: string[];
  selectedComments: Set<number>;
  selectedParas: Set<number>;
  // Pick-stage text edits. Comment keys are DEPTH-0 space (the stored convention shared with the flyout
  // + copy paths); paragraph keys are paragraph index; both carry *Orig anchors for drift-skip.
  edits: RedditThreadEdits;
  // Build tracking. `builtSig` = the picks+edits signature at the moment this thread last built a reel;
  // `builtReelId` = the id of the reel it produced. A thread counts "built" (skipped on re-Build, shows a ✓)
  // only while builtSig === threadSig(t) AND builtReelId still exists in the grid — so changing any pick/edit
  // re-arms it, and deleting its specific reel re-arms it. On re-Build the thread OVERWRITES builtReelId in
  // place (see buildReelsFromThreads) rather than spawning a duplicate reel. Both persist across reloads.
  builtSig?: string;
  builtReelId?: string;
}

/** Stable signature of a thread's BUILD-relevant state (picks + edits). Two threads with the same
    signature would produce the same reel; a change to any pick or edit changes it. */
function threadSig(t: BulkThread): string {
  return JSON.stringify({
    c: [...t.selectedComments].sort((a, b) => a - b),
    p: [...t.selectedParas].sort((a, b) => a - b),
    e: t.edits,
  });
}

// The bulk builder's picking state (imported threads + comment/paragraph selections + text edits) is
// PERSISTED so it survives a reload — and, critically, an HMR remount (adding a hook to this component
// makes Fast Refresh drop its state, which once wiped a user's in-progress picks). localStorage, not
// IndexedDB: a session's worth of threads is well under quota, and a QuotaExceededError degrades to
// "not persisted" via the caller's try/catch rather than breaking the build.
const BULK_STORE_KEY = 'bulk:threads';
function loadBulkThreads(): BulkThread[] {
  try {
    // parseStoredThreads (tested) validates per-entry and never throws; wrap arrays back into Sets here.
    const parsed = parseStoredThreads<ImportedRedditPost, ImportedRedditComment>(JSON.parse(localStorage.getItem(BULK_STORE_KEY) ?? '[]'));
    return parsed.map(t => ({ ...t, selectedComments: new Set(t.selectedComments), selectedParas: new Set(t.selectedParas) }));
  } catch { return []; }   // localStorage undefined on the server / parse error → fresh
}
const serializeBulkThreads = (threads: BulkThread[]): string => serializeThreads(threads);

function BulkBuilder({ open, onClose, onBuild, speed, queuedUrls, onQueueConsumed, onQueueDone, existingReelIds, clearSignal }: {
  open: boolean;
  onClose: () => void;
  onBuild: (threads: Array<{ url: string; post: ImportedRedditPost; comments: ImportedRedditComment[]; selectedComments: number[]; selectedParas: number[]; edits?: RedditThreadEdits; replaceReelId?: string }>) => Promise<{ built: number; failed: number; builtUrls: string[]; reelIdByKey: Record<string, string> }>;
  speed: number;   // narration speed — scales the live length estimate shown while picking comments
  /** Scout → Import handoff: approved post urls to auto-import when the panel opens. */
  queuedUrls?: string[] | null;
  /** Fired the moment the queue is picked up (clears the parent's slot so the effect can't double-fire). */
  onQueueConsumed?: () => void;
  /** Fired when the queued import finishes (ALWAYS, even on failure), with every url now present in the
      builder — the parent uses it to clear its handoff indicator + surface import failures. The Scout
      buffer itself releases only at BUILD time (builder threads aren't reload-durable; reels are). */
  onQueueDone?: (presentUrls: string[], queuedCount: number) => void;
  /** Ids of the reels that currently exist in the grid — a thread counts "built" only while the reel it
      produced (builtReelId) is still one of these, so deleting that reel (or Clear pipeline) re-arms it. */
  existingReelIds: Set<string>;
  /** Increments when the parent's "Clear pipeline" is confirmed — wipes the imported/picked threads. */
  clearSignal: number;
}) {
  const [linksText, setLinksText] = useState('');
  const [threads, setThreads] = useState<BulkThread[]>(loadBulkThreads);
  // Restored threads land straight in the select phase (skip the empty paste screen).
  const [phase, setPhase] = useState<'input' | 'importing' | 'select' | 'building'>(() => (threads.length ? 'select' : 'input'));
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [activeThread, setActiveThread] = useState(0);              // which thread's tab is open
  const [addOpen, setAddOpen] = useState(false);                   // "add more threads" input visible (select phase)
  const [addText, setAddText] = useState('');
  const [adding, setAdding] = useState(false);                     // importing appended threads
  const importGen = useRef(0);   // bumped by reset(); an in-flight import from a prior generation lands nothing

  // Persist the picking state on every change. Same mount-echo guard as the Scout buffer: never write []
  // over stored threads until a non-empty set has been committed this mount (value-based, so a StrictMode
  // double-invoke or a failed read can't clobber). A genuine clear (Start over) writes [] after a real
  // commit. Threads are re-serialised whole — cheap for a session's worth, and always fully consistent.
  const bulkSawThreads = useRef(false);
  useEffect(() => {
    try {
      if (threads.length > 0) { bulkSawThreads.current = true; localStorage.setItem(BULK_STORE_KEY, serializeBulkThreads(threads)); return; }
      if (!bulkSawThreads.current) return;   // mount echo / failed read — don't clobber good data with []
      localStorage.setItem(BULK_STORE_KEY, '[]');
    } catch { /* quota exceeded / private mode — degrade to not-persisted, never break */ }
  }, [threads]);

  // Pick-stage text editing is the shared picker's job (it owns the editors, undo/redo and Clean text);
  // the builder only exposes WHERE the active thread's edits live.
  const setActiveEdits = (fn: (e: RedditThreadEdits) => RedditThreadEdits) =>
    setThreads(prev => prev.map((t, i) => (i === activeThread ? { ...t, edits: fn(t.edits) } : t)));

  // Import pasted links. append=false replaces the grid (initial import); append=true keeps the existing
  // threads and adds the new ones (dedup by URL) so more threads can be pulled in after the first fetch.
  // Returns every input url that is PRESENT in the builder afterwards (imported this run, or skipped by
  // dedup because its thread is already here) — the Scout handoff releases exactly these from its buffer.
  async function runImport(rawText: string, append: boolean): Promise<string[]> {
    // Partition via the canonical thread key (tested in lib/redditScout/handoff.ts) so www/trailing-slash/
    // ?utm variants of one thread never import twice; urls whose thread is already here count "present".
    const gen = importGen.current;   // a Start-over mid-import invalidates this run (see the post-await guard)
    const have = append ? new Set(threads.map(t => canonicalThreadKey(t.url))) : new Set<string>();
    const { toImport: urls, alreadyPresent } = partitionImportUrls(rawText, have);
    if (!urls.length) {
      setError(append && !alreadyPresent.length ? 'No new links to add (already imported, or none pasted).' : append ? '' : 'Paste at least one Reddit thread link.');
      return alreadyPresent;
    }
    setError('');
    setProgress({ done: 0, total: urls.length });
    if (append) setAdding(true); else setPhase('importing');
    // Native transport (skipping avatars) is fast AND carries the real comment tree incl. one reply
    // per comment; the avatar storm was the only thing that made it block, so skipAvatars keeps it
    // snappy. The route falls back to Apify automatically if native fails. Import a few at a time.
    const importOne = async (url: string): Promise<BulkThread | null> => {
      try {
        const res = await fetch('/api/reddit', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, skipAvatars: true }), signal: AbortSignal.timeout(180_000),
        });
        const json = await res.json();
        if (res.ok && json.post) {
          // Keep the full tree (top-level + replies) so the picker can group each comment with its reply.
          return { url, post: json.post, comments: json.comments ?? [], notice: importNotice(json), paragraphs: splitParagraphs(json.post.body), selectedComments: new Set(), selectedParas: new Set(), edits: {} };
        }
      } catch { /* skip a failed thread */ }
      return null;
    };
    const CONCURRENCY = 3;
    const results: (BulkThread | null)[] = new Array(urls.length).fill(null);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
      for (let i = next++; i < urls.length; i = next++) {
        results[i] = await importOne(urls[i]);
        setProgress(p => ({ ...p, done: p.done + 1 }));
      }
    }));
    // A Start-over while we awaited invalidated this run: the pre-reset thread state (and alreadyPresent,
    // computed against it) is gone. Land nothing, report NOTHING present — interrupted posts stay
    // buffered in the Scout for a clean re-send instead of being orphaned into hidden/replaced threads.
    if (gen !== importGen.current) {
      setAdding(false);
      if (!append) setPhase('input');
      return [];
    }
    const out = results.filter((t): t is BulkThread => !!t);
    const failedCount = urls.length - out.length;
    if (append) {
      setAdding(false);
      if (!out.length) { setError('None of those links could be added.'); return alreadyPresent; }
      const firstNew = threads.length;
      setThreads(prev => [...prev, ...out]);
      setActiveThread(firstNew);   // jump to the first newly-added thread
      setAddText(''); setAddOpen(false);
      if (failedCount) setError(`${failedCount} link${failedCount === 1 ? '' : 's'} failed to import — the rest were added.`);
    } else if (out.length) {
      setThreads(out);
      setActiveThread(0);
      setPhase('select');
      if (failedCount) setError(`${failedCount} link${failedCount === 1 ? '' : 's'} failed to import — the rest were added.`);
    } else {
      // Every link failed — return to the paste screen (phase is 'importing' right now) so the textarea +
      // "Import all" stay visible with the error, instead of stranding the user on a blank select screen.
      setPhase('input');
      setError('None of those links could be imported.');
    }
    return [...out.map(t => t.url), ...alreadyPresent];
  }

  // ── Scout → Import handoff: queued urls auto-import like pasted links (append when threads already
  // exist, initial import otherwise). The queue is consumed BEFORE the import starts (double-fire guard).
  // Deliberately NOT gated on `open`: the queue is only ever set together with opening the panel, the
  // component stays mounted while closed, and a busy-parked queue must still self-consume once phase/
  // adding settle — otherwise closing the panel at the wrong moment parks it (and the Scout node's
  // "running" pulse) forever. onQueueDone always fires (even on a rejection) so the parent's handoff
  // flag can't strand; it reports import failures — the buffer itself releases only at BUILD time.
  useEffect(() => {
    if (!queuedUrls?.length) return;
    if (phase === 'importing' || phase === 'building' || adding) return;   // busy — effect refires when phase/adding settle
    const urls = queuedUrls;
    onQueueConsumed?.();
    if (threads.length > 0) setAddOpen(true);   // surface the existing "Adding… x/y" progress strip
    void runImport(urls.join('\n'), threads.length > 0).then(
      present => onQueueDone?.(present, urls.length),
      () => onQueueDone?.([], urls.length),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedUrls, phase, adding]);

  // Discard everything and return to the paste screen (persistence keeps state across close, so this is
  // the explicit way to start a fresh batch). Bumping importGen invalidates any in-flight import so its
  // results can't land into (or report "present" against) the discarded thread state.
  function reset() {
    importGen.current++;
    setThreads([]); setLinksText(''); setPhase('input');
    setActiveThread(0); setError(''); setAddOpen(false); setAddText('');
  }

  // Parent "Clear pipeline" → wipe the imported/picked threads (they live here + in localStorage). The ref
  // guard skips the initial mount so an existing session isn't cleared just by mounting; only a genuine
  // increment fires reset(). The persistence effect then writes [] to bulk:threads once threads is emptied.
  const clearSignalSeen = useRef(clearSignal);
  useEffect(() => {
    if (clearSignal === clearSignalSeen.current) return;
    clearSignalSeen.current = clearSignal;
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSignal]);

  const toggle = (ti: number, kind: 'c' | 'p', idx: number) => setThreads(prev => prev.map((t, i) => {
    if (i !== ti) return t;
    return kind === 'c'
      ? { ...t, selectedComments: toggleIndex(t.selectedComments, idx) }
      : { ...t, selectedParas: toggleIndex(t.selectedParas, idx) };
  }));

  // A thread is "built" (skip on re-Build) while its picks+edits are unchanged since its last build AND the
  // specific reel it produced still exists. Changing a pick/edit OR deleting that reel re-arms it.
  const isBuilt = (t: BulkThread) => t.builtSig != null && t.builtSig === threadSig(t) && t.builtReelId != null && existingReelIds.has(t.builtReelId);
  const hasPicks = (t: BulkThread) => t.selectedComments.size + t.selectedParas.size > 0;
  const ready = threads.filter(hasPicks);                       // has ≥1 pick (for per-thread badges/estimate)
  const buildable = threads.filter(t => hasPicks(t) && !isBuilt(t));   // ready AND not-already-built-unchanged
  // When nothing new is buildable but ticked threads ARE built, the button becomes a "Rebuild" that
  // force-rebuilds them in place (reuse the same reel via builtReelId — keeps footage, re-renders the card).
  const rebuildMode = buildable.length === 0 && ready.length > 0;
  const buildTargets = rebuildMode ? ready : buildable;
  // Estimated final length of the reel a thread would build — title + its ticked paragraphs + ticked
  // comments (EDITED text, so the warning matches the built reel), at the current narration speed. Rough
  // (real duration lands once narrated), but enough to flag a thread that would blow past the 3:00 Shorts
  // limit BEFORE any TTS is spent. Same text the picker's own estimate uses — one function, no drift.
  const threadEstSeconds = (t: BulkThread) => estimateNarrationSeconds(threadEstimateText(t), speed);
  // Only estimate a thread that will actually build a reel (≥1 pick) — else a title-only phantom ~m:ss shows
  // for an untouched thread, disagreeing with the tab badge + Build button (both gated on picks).
  const at = threads[activeThread];
  const activeEst = at && at.selectedComments.size + at.selectedParas.size > 0 ? threadEstSeconds(at) : 0;

  async function build(toBuild: BulkThread[], closeOnDone = true) {
    if (!toBuild.length) return;
    // Snapshot each thread's signature NOW, from the exact picks being sent to build. Stamping builtSig
    // from the post-await `prev` instead would capture any pick/edit the user makes DURING the async build
    // — marking a reel "built" for content it doesn't actually contain (a false ✓ + a silently-unbuildable
    // edit). The build set is keyed by canonical thread key, so use the same key here.
    const sigByKey = new Map(toBuild.map(t => [canonicalThreadKey(t.url), threadSig(t)]));
    setPhase('building'); setError('');
    try {
      const r = await onBuild(toBuild.map(t => ({ url: t.url, post: t.post, comments: t.comments, selectedComments: [...t.selectedComments], selectedParas: [...t.selectedParas], edits: hasThreadEdits(t.edits) ? t.edits : undefined, replaceReelId: t.builtReelId })));
      // Stamp builtSig + builtReelId on exactly the threads whose reel FRAMED (reelIdByKey — a failed render
      // is in builtUrls but NOT here, so it re-arms). Stamp the signature we SENT (sigByKey), not the current
      // one, so a pick/edit made DURING the async build leaves the thread re-armed. Picks are KEPT — a built
      // thread just drops out of the Build set until you change a pick/edit or delete its reel. (Threads are
      // deduped by canonical key on import, so each key maps to exactly one thread here.)
      setThreads(prev => prev.map(t => {
        const k = canonicalThreadKey(t.url);
        const reelId = r.reelIdByKey[k];
        const sig = sigByKey.get(k);
        return reelId && sig != null ? { ...t, builtSig: sig, builtReelId: reelId } : t;
      }));
      const framed = Object.keys(r.reelIdByKey).length;   // reels that rendered a card (excludes cap-truncated + failed)
      if (framed >= toBuild.length && r.failed === 0) {   // clean full build: every ticked thread framed
        setPhase('select');
        if (closeOnDone) onClose();   // a rebuild keeps the panel open so you can keep refining
        return;
      }
      // Truncated (reel cap) or partial card failure: say exactly what happened; the un-built threads stay
      // buildable (a failed thread's reel never framed, so it re-arms). `r.built` counts reel SLOTS attempted
      // (a failed render leaves a blank one), so the truthful "made a card" count is `framed`.
      const parts: string[] = [];
      if (r.built < toBuild.length) parts.push(`${toBuild.length - r.built} thread${toBuild.length - r.built === 1 ? '' : 's'} didn't fit the reel cap`);
      if (r.failed) parts.push(`${r.failed} card${r.failed === 1 ? '' : 's'} failed to render`);
      setError(`Built ${framed} of ${toBuild.length} — ${parts.join('; ')}. The rest stay ready to build.`);
      setPhase('select');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Build failed.');
      setPhase('select');
    }
  }

  // Stay mounted while closed (parent always renders us) so the pasted links, imported threads, and
  // selections survive closing and reopening the panel — just render nothing until reopened.
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/50 p-4" onPointerDown={onClose}>
      <div className="flex flex-col w-full max-w-6xl max-h-[85vh] rounded-2xl bg-surface-1 border border-line-strong shadow-3" onPointerDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-line shrink-0">
          <span className="text-subheading font-semibold text-fg">Bulk build reels from Reddit threads</span>
          <IconButton icon={<CloseIcon size={14} />} label="Close" variant="secondary" onClick={onClose} />
        </div>

        {phase === 'input' && (
          <div className="flex flex-col gap-2 p-4">
            <span className="text-caption text-fg-3">Paste Reddit thread links — one per line.</span>
            <textarea
              value={linksText}
              onChange={e => setLinksText(e.target.value)}
              rows={8}
              placeholder={'https://www.reddit.com/r/AskReddit/comments/…\nhttps://www.reddit.com/r/…'}
              className="w-full rounded-md border border-line-strong bg-transparent p-2 text-body text-fg placeholder:text-fg-3 outline-none resize-y"
            />
            <Button variant="primary" size="sm" onClick={() => void runImport(linksText, false)} disabled={!linksText.trim()}>Import all</Button>
            {error && <span className="text-caption text-danger-text">{error}</span>}
          </div>
        )}

        {phase === 'importing' && (
          <div className="p-6 text-center text-body text-fg-2">Importing threads… {progress.done}/{progress.total}</div>
        )}

        {(phase === 'select' || phase === 'building') && (
          <>
            {/* Thread tabs: one per imported thread (badge = items ticked in it), plus a "+ Add threads"
                tab that reveals an inline paste box to import & append more threads mid-session. */}
            {threads.length >= 1 && (
              <div className="shrink-0 border-b border-line">
                <div className="flex gap-1 px-3 pt-2 pb-2 overflow-x-auto">
                  {threads.map((t, ti) => {
                    const picks = t.selectedComments.size + t.selectedParas.size;
                    const over = picks > 0 && threadEstSeconds(t) > SHORTS_MAX_SECONDS;   // would exceed the Shorts limit
                    const built = isBuilt(t);
                    return (
                      <button key={ti} type="button" onClick={() => setActiveThread(ti)}
                        title={t.notice?.message ?? (built ? 'Already built — change a pick to rebuild' : over ? 'Estimated over the 3:00 Shorts limit — untick some comments' : undefined)}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-caption whitespace-nowrap shrink-0 ${ti === activeThread ? 'bg-active text-fg font-medium' : 'text-fg-3 hover:bg-hover'}`}>
                        <span className="opacity-60">{ti + 1}</span>
                        {/* Only RETRYABLE notices get a mark. A gallery or a text post is simply what it is —
                            badging those would put a warning on half a normal batch and mean nothing. */}
                        {t.notice?.retryable && <span className="text-warning-text" aria-label="Imported incomplete">⚠</span>}
                        <span className="max-w-[150px] truncate">{t.post.title}</span>
                        {built
                          ? <span className="flex items-center justify-center size-4 rounded-full bg-success-tint text-success-text text-[10px] leading-none" title="Built">✓</span>
                          : picks > 0 && <span className={`flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[10px] leading-none ${over ? 'bg-danger-tint text-danger-text' : 'bg-action text-action-fg'}`}>{picks}</span>}
                      </button>
                    );
                  })}
                  <button type="button" onClick={() => setAddOpen(o => !o)}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-caption whitespace-nowrap shrink-0 border border-dashed ${addOpen ? 'border-action text-fg' : 'border-line-strong text-fg-3 hover:bg-hover'}`}>
                    + Add threads
                  </button>
                </div>
                {addOpen && (
                  <div className="flex flex-col gap-2 px-3 pb-3">
                    <textarea value={addText} onChange={e => setAddText(e.target.value)} rows={2}
                      placeholder={'Paste more Reddit thread links to add to this batch…'}
                      className="w-full rounded-md border border-line-strong bg-transparent p-2 text-caption text-fg placeholder:text-fg-3 outline-none resize-y" />
                    <div className="flex items-center gap-2">
                      <Button variant="primary" size="sm" loading={adding} disabled={!addText.trim()} onClick={() => void runImport(addText, true)}>
                        {adding ? `Adding… ${progress.done}/${progress.total}` : 'Import & add'}
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setAddText(''); }}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* The picker — the SAME component the canvas rail flyout renders. The builder adds only the
                multi-thread chrome around it (tabs, "+ Add threads", Build). */}
            <div className="flex-1 min-h-0 flex">
              {at && (
                <RedditThreadPicker
                  threadKey={at.url}
                  thread={at}
                  speed={speed}
                  onToggle={(kind, idx) => toggle(activeThread, kind, idx)}
                  onEdits={setActiveEdits}
                />
              )}
            </div>
            <div className="flex items-center gap-2 px-4 py-3 border-t border-line shrink-0">
              <Button variant="primary" size="sm" loading={phase === 'building'} disabled={!buildTargets.length} onClick={() => void build(buildTargets, !rebuildMode)}>
                {phase === 'building'
                  ? (rebuildMode ? 'Rebuilding…' : 'Building…')
                  : `${rebuildMode ? 'Rebuild' : 'Build'} ${buildTargets.length} reel${buildTargets.length === 1 ? '' : 's'}`}
              </Button>
              <span className="text-caption text-fg-3">
                {rebuildMode
                  ? 'All ticked threads are built ✓ — Rebuild re-renders them in place (same reel + footage). Change a pick to build only what changed.'
                  : 'Ticked threads become reels with a card + random footage. Your picks stay after building; a re-Build updates the same reel.'}
              </span>
              {/* Live length estimate for the OPEN thread — flags an over-limit reel before any TTS is spent. */}
              {activeEst > 0 && (
                <span className={`text-caption tabular-nums ${activeEst > SHORTS_MAX_SECONDS ? 'text-danger-text font-medium' : 'text-fg-3'}`}
                  title={activeEst > SHORTS_MAX_SECONDS ? 'Estimated over the 3:00 YouTube Shorts limit' : 'Estimated final length of this reel'}>
                  ~{fmtTime(activeEst > SHORTS_MAX_SECONDS ? Math.ceil(activeEst) : activeEst)}{activeEst > SHORTS_MAX_SECONDS ? ' · over 3:00 limit' : ''}
                </span>
              )}
              {error && <span className="text-caption text-danger-text">{error}</span>}
              <button type="button" onClick={reset} disabled={adding} className="ml-auto text-caption text-fg-3 hover:text-fg underline underline-offset-2 shrink-0 disabled:opacity-40 disabled:pointer-events-none">Start over</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── CanvasGrid ────────────────────────────────────────────────────────────────

// Remember the last-selected reel template per user so the Reels posting page reopens it instead of
// snapping back to the first one. The in-memory map survives section-switch remounts within a session;
// localStorage (read below) survives a full page reload. Mirrors the carousel editor's `de:tpl:` scheme.
const reelSelectionCache = new Map<string, string>();   // userId → reel-template id
const reelSelectionKey = (userId: string) => `de:reeltpl:${userId}`;

export function CanvasGrid({
  entries, setEntries, canvasRefsMap, brand,
  onAddRow, onAddReels, onRemoveRow, onDuplicateRow, onDeleteAllReels, onHandleVideoError,
  onUpdateEntry, onUpdateLocalVideo,
  onFetchVideo, userId,
  videoMode, styleId, onGoToTemplateEditor, viewToggle, active = true, onRestored, restored, onGoHome,
}: CanvasGridProps) {
  // No export quota in the client-only build — every export just runs.
  const exportGuard = useMemo(() => ({
    guard: async (_key: string, run: () => void | Promise<void>) => { await run(); return true; },
    consumeOne: async (_key: string) => true,
  }), []);
  // Export actions each drive a real-time canvas recording, so only ONE may run at a time — a second
  // would read a canvas that's already recording (exportBlob → null). `downloadingOne` covers the
  // single Download; Download-All has isDownloadingAll; every export button gates on both.
  const [downloadingOne, setDownloadingOne] = useState(false);
  // Saved Twitter/X overlay templates. The selected one's style applies to all twitter-mode rows
  // (defaults reproduce the original look when the user has none).
  const { templates: twitterTemplates, loaded: twitterLoaded } = useTwitterTemplates(userId);
  // Seed from the remembered selection (in-memory cache → localStorage) so a remount/reload reopens the
  // same template; falls back to the first one only when nothing is remembered.
  const [activeTwitterId, setActiveTwitterId] = useState<string | null>(() => {
    if (!userId) return null;
    const cached = reelSelectionCache.get(userId);
    if (cached) return cached;
    try { return localStorage.getItem(reelSelectionKey(userId)); } catch { return null; }
  });
  const activeTwitter = twitterTemplates.find(t => t.id === activeTwitterId) ?? twitterTemplates[0] ?? null;
  const twSettings = activeTwitter?.settings ?? defaultTwitterTemplateSettings();

  // If userId arrives after the initial render (the seed above ran with no user), restore then.
  useEffect(() => {
    if (activeTwitterId || !userId) return;
    let saved: string | null = reelSelectionCache.get(userId) ?? null;
    if (!saved) { try { saved = localStorage.getItem(reelSelectionKey(userId)); } catch { /* ignore */ } }
    if (saved) setActiveTwitterId(saved);
  }, [userId, activeTwitterId]);

  // Persist the selection: in-memory cache for fast remounts, localStorage for full reloads.
  useEffect(() => {
    if (!userId || !activeTwitterId) return;
    reelSelectionCache.set(userId, activeTwitterId);
    try { localStorage.setItem(reelSelectionKey(userId), activeTwitterId); } catch { /* ignore */ }
  }, [userId, activeTwitterId]);

  // Drop a remembered id whose template was since deleted, so it cleanly falls back to the first.
  useEffect(() => {
    if (!activeTwitterId || !twitterLoaded || twitterTemplates.length === 0) return;
    if (!twitterTemplates.some(t => t.id === activeTwitterId)) {
      setActiveTwitterId(null);
      if (userId) {
        reelSelectionCache.delete(userId);
        try { localStorage.removeItem(reelSelectionKey(userId)); } catch { /* ignore */ }
      }
    }
  }, [activeTwitterId, twitterLoaded, twitterTemplates, userId]);

  // ── Active reel style ──────────────────────────────────────────────────────────────────────────
  // Which reel STYLE this workspace is. It drives the pipeline flow + status, and — since the styles are
  // separate workspaces — WHICH saved reels this grid owns.
  //
  // The style is handed DOWN, not chosen here: page.tsx mounts one workspace per style and keys it on that
  // style, so this component is a Reddit workspace or a commentary workspace for its whole life and can
  // never switch. That removes the old post-mount localStorage read entirely — the style is known on the
  // first render, so the persistence hook is never handed a guess, and there is no in-between state where
  // the grid holds one style's reels while another is active.
  const activeStyleId = styleId;
  const activeStyle = getReelStyle(activeStyleId);
  // Everything that renders or restores the pipeline view reads this, so a style without one can never be
  // left stranded in a view it has no toggle to leave.
  const hasPipeline = activeStyle.hasPipeline;
  // The overlay carrying this style's narratable content. Every generic path that used to name Reddit's card
  // literally reads this instead — a style with no such overlay (null) is excluded from those paths rather
  // than falling through to matching any overlay.
  const primaryOverlayName = activeStyle.primaryOverlayName;
  // Source surfaces are still CONCRETE components mounted by this shell (BulkBuilder + ScoutPanel for
  // threads, CommentarySource for a video + script), so each is gated on the style declaring the rail
  // section it belongs to rather than on the style's id. That keeps `=== 'reddit'` out of the shell, but it
  // is not yet the real fix: a style can only have a source this file already imports. Moving the source
  // (and the canvas) behind a `renderSource`/`renderCanvas` on ReelStyle is the follow-up — that's the point
  // at which a new style needs no edit here at all.
  const hasThreadSource = activeStyle.railSections.includes('reddit');
  // Does this style create reels from a modal (vs. Reddit's bulk thread builder)? The label IS the
  // declaration — a style with one has a source surface in reelSurfaces, and its button says what it makes.
  const sourceLabel = activeStyle.sourceLabel;

  // ── Saved reels (autosave the whole grid) ──────────────────────────────────────────────────────
  // Each grid row is a saved reel: we persist only numbers/strings (link, caption, mode, inherited
  // template id, framing) and re-apply them on load. Re-fetching the link reloads the video; the canvas
  // then restores its exact crop/pan/zoom/trim via `initialFraming`. Only active in the Video Reels
  // workspace (where setEntries is provided). Scoped to the active style: the hook loads only that style's
  // rows and merges them back, so the other style's reels are neither shown here nor touched by a save.
  const { loaded: reelsLoaded, loadError: reelsLoadError, retryLoad: retryReelsLoad, initialRows, saveState: reelSaveState, scheduleSave } =
    useReelPersistence(setEntries ? userId : null, activeStyleId);
  const [framingMap, setFramingMap] = useState<Record<string, Framing>>({});
  // Live mirror of framingMap for callbacks that run across a chain of setState updates (Run all: the copy
  // phase writes ytTitle/description, then downloadAllReels — invoked from a closure captured BEFORE that
  // write — must still read the fresh values for the export filenames + .txt sidecars). Mirrors isDownloadingAllRef.
  const framingMapRef = useRef(framingMap);
  useEffect(() => { framingMapRef.current = framingMap; }, [framingMap]);
  // Live mirror of entries — buildReelsFromThreads reads it to decide, per thread, whether the reel it
  // built last time still exists (rebuild replaces it in place) vs. was deleted (build a fresh one). Entries
  // are the source of truth for reel existence: a single-reel delete removes the entry but does NOT prune
  // framingMap, so checking framingMap would resurrect a deleted reel's id.
  const entriesRef = useRef(entries);
  useEffect(() => { entriesRef.current = entries; }, [entries]);
  // Thread (post+comments) captured at bulk-build, keyed by reel id, so the copy phase can feed
  // /api/description WITHOUT re-importing via /api/reddit (the serialized-puppeteer step that caps copy
  // concurrency). In-memory / session-only — copy falls back to a re-import for reels from a prior reload.
  const threadCacheRef = useRef<Map<string, { url: string; post: ImportedRedditPost; comments: ImportedRedditComment[] }>>(new Map());
  // entryId → live image-overlay list, reported by each canvas — feeds the timeline's overlay lane.
  const [overlaysMap, setOverlaysMap] = useState<Record<string, ImageOverlay[]>>({});
  // Narration voice palette (voices[0] = default narrator) + the voice armed as a line-painting
  // brush on the OCR highlights. Persisted so the cast survives reloads.
  const [narrationVoices, setNarrationVoices] = useState<string[]>(loadSavedVoices);
  const [voiceBrushId, setVoiceBrushId] = useState<string | null>(null);
  const [voiceGains, setVoiceGains] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(LS_VOICE_GAINS) ?? '{}') as Record<string, number>; } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(LS_VOICE_GAINS, JSON.stringify(voiceGains)); } catch { /* ignore */ }
  }, [voiceGains]);
  const [narrationSpeed, setNarrationSpeed] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(LS_NARRATION_SPEED));
      return NARRATION_SPEEDS.includes(saved as typeof NARRATION_SPEEDS[number]) ? saved : DEFAULT_NARRATION_SPEED;
    } catch { return DEFAULT_NARRATION_SPEED; }
  });
  useEffect(() => {
    try { localStorage.setItem(LS_NARRATION_SPEED, String(narrationSpeed)); } catch { /* ignore */ }
  }, [narrationSpeed]);
  useEffect(() => {
    try { localStorage.setItem(LS_11L_VOICES, JSON.stringify(narrationVoices)); } catch { /* ignore */ }
  }, [narrationVoices]);
  // Every voice this workspace can show, in cast order — the style's fixed cast (if any) then the user's
  // palette. A cast-less style contributes nothing here and its lines all read in the default narrator.
  const styleCast = useMemo(
    () => (activeStyle.voiceCast ? [activeStyle.voiceCast.lead, ...activeStyle.voiceCast.pool] : []),
    [activeStyle.voiceCast],
  );
  const narrationVoiceColors = useMemo(() => {
    const m: Record<string, string> = {};
    narrationVoices.forEach((v, i) => { const id = v.trim(); if (id && !(id in m)) m[id] = VOICE_COLORS[i % VOICE_COLORS.length]; });
    // The style's cast gets stable tints too, so auto-cast highlights are distinct out of the box.
    for (const { id } of styleCast) {
      if (!(id in m)) m[id] = VOICE_COLORS[Object.keys(m).length % VOICE_COLORS.length];
    }
    return m;
  }, [narrationVoices, styleCast]);
  const castVoiceNames = useMemo(() => {
    const m: Record<string, string> = {};
    // DISABLED_VOICES are named too: a take generated before a voice was retired still shows its name on
    // the timeline, even though nothing will voice it again.
    for (const v of [...styleCast, ...DISABLED_VOICES]) m[v.id] = v.name;
    narrationVoices.forEach((v, i) => { const id = v.trim(); if (id && !(id in m)) m[id] = `Voice ${i + 1}`; });
    return m;
  }, [narrationVoices, styleCast]);
  const voiceBrush = useMemo(() => {
    if (!voiceBrushId) return null;
    return { voiceId: voiceBrushId, color: narrationVoiceColors[voiceBrushId] ?? VOICE_COLORS[0] };
  }, [voiceBrushId, narrationVoiceColors]);
  const [reelTemplateMap, setReelTemplateMap] = useState<Record<string, string | null>>({}); // entryId → template id
  // entryId → user-given reel name (shown/edited in the bottom strip). Kept OUTSIDE VideoEntry — like
  // framing/template above — because entries model the video pipeline (fetch/upload state) while the name
  // is pure saved-grid metadata; it rides the same autosave rows. '' / absent = unnamed (number only).
  const [reelNameMap, setReelNameMap] = useState<Record<string, string>>({});
  const [framingDirty, setFramingDirty] = useState(0);   // bumped when a reel's crop/pan/zoom/trim changes
  const markFramingDirty = useCallback(() => setFramingDirty(n => n + 1), []);
  // Which style's reels the grid is currently holding — null before the first restore. The ref guards the
  // restore against re-entry; the state is what gates the autosave, and because it's set in the same batch
  // as the restored entries it can only read true once those entries are COMMITTED. Without that, the one
  // render between "switched style" and "restored the new style's reels" would autosave the OLD workspace's
  // reels into the new style's slot — i.e. delete the reels it was about to show.
  const appliedStyleRef = useRef<string | null>(null);
  const [appliedStyle, setAppliedStyle] = useState<string | null>(null);
  const autoFetched = useRef<Map<string, string>>(new Map());   // entryId → last URL we auto-fetched (no repeats)
  // Reels whose stored bytes are still being read back out of IndexedDB (see the restore below). While an
  // id sits in here the auto-fetch leaves it alone — re-downloading a video we already hold is the exact
  // waste persisting it was meant to end.
  const [bytesRestoring, setBytesRestoring] = useState<ReadonlySet<string>>(() => new Set());

  // Restore the saved grid once per style, after that style's saved rows have loaded. Runs again when the
  // active style changes: the styles are separate workspaces, so a switch swaps the whole grid.
  useEffect(() => {
    if (!setEntries || !reelsLoaded) return;
    if (appliedStyleRef.current === activeStyleId) return;
    const isSwitch = appliedStyleRef.current !== null;   // swapping workspaces, not the first restore
    appliedStyleRef.current = activeStyleId;
    onRestored?.();   // safe to append from the Content Sheet now — this restore won't clobber
    const fm: Record<string, Framing> = {};
    const tm: Record<string, string | null> = {};
    const nm: Record<string, string> = {};
    const loaded: VideoEntry[] = initialRows.map(r => {
      fm[r.id] = r.framing ?? {};
      tm[r.id] = r.templateId ?? null;
      if (r.name) nm[r.id] = r.name;
      // Reuse a cached fetch if we have it (client-side cache survives section switches) → restore the
      // video instantly with no API call and no skeleton flash.
      const cached = r.url.trim() && !r.videoUrl ? getCachedVideo(r.url.trim()) : undefined;
      return { ...makeEmptyEntry(r.id, r.mode), url: r.url, caption: r.caption, videoUrl: r.videoUrl || undefined, posterUrl: r.posterUrl || undefined, data: cached ?? null };
    });
    setFramingMap(fm);
    setReelTemplateMap(tm);
    setReelNameMap(nm);
    // On the FIRST restore this page-load, rebuild the grid from the saved rows. On a nav-back remount
    // the entries are already live in HomeClient (freshest — they include an upload that finished while
    // the grid was unmounted), so we only re-seed the maps above and must NOT overwrite entries.
    // That's only sound while those live entries belong to the style we just loaded: on a switch — or on a
    // remount into a different workspace than the one they came from — they belong to the OTHER workspace,
    // and keeping them would autosave them into this style's slot, over its reels. Then the file wins.
    // (framingMap here is still the PRE-restore map, i.e. how this grid currently understands its entries;
    // no tag means Reddit, which is exactly what an untagged legacy grid is.)
    const keepLiveEntries = restored && !isSwitch && entries.every(e => styleOf({ framing: framingMap[e.id] }) === activeStyleId);
    if (!keepLiveEntries) {
      // Reset even when there are NO saved rows (loaded is []) — to a single empty reel — so a same-tab
      // account switch can't leave the previous user's entries live (the autosave would otherwise capture
      // and write them into THIS user's row). setEntries also triggers a re-render that re-runs the
      // autosave with the reset entries, cancelling any transient debounce armed with the old user's rows.
      // The blank reel gets a MINTED id, never the old hard-coded '1': it is about to be autosaved into this
      // style's slot, and both workspaces reaching for the same id gave them one shared IndexedDB record —
      // an upload in one showed up in the other, and deleting one destroyed the other's video.
      setEntries(loaded.length ? loaded : [makeEmptyEntry(newReelId())]);
      // Cached links already carry their video (data set above) — mark them so the auto-fetch effect
      // skips them. UNCACHED links (e.g. after a full refresh clears the in-memory cache) are left
      // UNMARKED so the auto-fetch effect re-downloads them. Fetching there (on a debounced timer) is
      // what makes it work: an immediate fetch here races useVideoEntries' entriesRef, which isn't yet
      // updated with the restored reels, so fetchVideo can't find the entry and bails with "URL required".
      // A switch re-enters the workspace from scratch, so its stale marks (set by the auto-fetch effect on
      // the previous visit) must go — else an uncached link would sit there never re-fetching.
      autoFetched.current.clear();
      loaded.forEach(e => {
        if (!e.url.trim() || e.videoUrl) return;
        if (e.data) autoFetched.current.set(e.id, e.url.trim());
      });
    }
    // Adopt the first saved row's template as the active default for the picker.
    const firstTpl = initialRows.find(r => r.templateId)?.templateId;
    if (firstTpl) setActiveTwitterId(firstTpl);
    // Restore stored videos from IndexedDB, as a fresh object URL, for every row that owns its bytes
    // (lib/reelBytes): uploads in any workspace, plus commentary's LINKED reels — whose resolved CDN URL is
    // signed and expires, so the link is provenance, not a video source. Marked in uploadedBlob first so the
    // persist effect doesn't re-write the same bytes. A miss just leaves the row on its link, as before.
    if (!keepLiveEntries) {
      const stored = initialRows.filter(r => shouldRestoreBytes(r, activeStyleId));
      // Held while the reads are in flight so the auto-fetch below can't resolve a link whose bytes we may
      // already have. STATE, not a ref: clearing an id has to re-render, or a row with nothing stored would
      // sit there never falling back to its link.
      if (stored.length) setBytesRestoring(new Set(stored.map(r => r.id)));
      for (const r of stored) {
        void getLocalVideo(r.id).then(hit => {
          if (!hit) return;
          const src = URL.createObjectURL(hit.blob);
          uploadedBlob.current.set(r.id, src);
          // Only adopt into the row we read for: if its link changed meanwhile the user re-pointed the reel,
          // and these are the previous video's bytes.
          setEntries(prev => prev.map(e => (e.id === r.id && !e.localVideoSrc && e.url.trim() === r.url.trim()
            ? { ...e, localVideoSrc: src, localVideoName: hit.name } : e)));
        }).catch(() => {}).finally(() => setBytesRestoring(prev => {
          if (!prev.has(r.id)) return prev;
          const next = new Set(prev);
          next.delete(r.id);
          return next;
        }));
      }
    }
    // Last: opens the autosave gate, in the same batch as the entries/maps above so it can only be read as
    // open once they're committed.
    setAppliedStyle(activeStyleId);
    // entries/framingMap are read (keepLiveEntries) so they're listed, but they only ever re-run the
    // appliedStyleRef check above — the restore body itself is once per style.
  }, [setEntries, reelsLoaded, initialRows, onRestored, restored, activeStyleId, entries, framingMap]);

  // Auto-fetch: in the reels section, a pasted/typed link fetches on its own (no Fetch button press).
  // Debounced via the effect's cleanup — while the URL keeps changing the timer resets; ~700ms after it
  // settles we fetch. Guarded so we never re-fetch the same URL or a row that's already loaded/uploading.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const e of entries) {
      if (e.loading || e.localVideoSrc || e.videoUrl) continue;
      if (e.data && !e.videoFailed) continue;                      // already fetched
      if (bytesRestoring.has(e.id)) continue;                      // its stored bytes may still be coming back
      const url = e.url.trim();
      if (!/^https?:\/\/\S+\.\S+/.test(url)) continue;             // wait for a complete-looking link
      if (autoFetched.current.get(e.id) === url) continue;         // already auto-fetched this exact URL
      const id = e.id;
      timers.push(setTimeout(() => { autoFetched.current.set(id, url); onFetchVideo(id); }, 700));
    }
    return () => timers.forEach(clearTimeout);
  }, [entries, onFetchVideo, bytesRestoring]);

  // Autosave: rebuild the rows from entries + live framing (read off each canvas ref) and debounce-save.
  // Gated on the grid actually holding the ACTIVE style's reels: a save is scoped to that style and replaces
  // its whole set, so saving while the grid still shows the previous workspace (the render between a style
  // switch and its restore) would wipe the incoming style's saved reels.
  useEffect(() => {
    if (!setEntries || appliedStyle !== activeStyleId) return;
    const rows: SavedReel[] = entries
      .map(e => ({
        id: e.id,
        name: reelNameMap[e.id] ?? '',
        mode: e.mode === 'caption' ? 'caption' : 'twitter',
        url: e.url ?? '',
        videoUrl: e.videoUrl ?? '',
        posterUrl: e.posterUrl ?? '',
        caption: e.caption ?? '',
        templateId: reelTemplateMap[e.id] ?? activeTwitterId ?? null,
        // Only trust the live canvas framing once the video is actually loaded (readyState >= 2). A
        // mounted-but-not-loaded canvas (still buffering, or a failed/timed-out video) holds the
        // full-canvas placeholder box, not the band — persisting it made sheet-sent reels reload
        // full-canvas. getFraming() already nulls while loading; this also covers the errored case.
        // Live canvas framing wins when loaded, but redditThread lives only in framingMap
        // (the canvas doesn't know about it) — merge it so autosave never drops the thread link.
        framing: {
          ...(((canvasRefsMap.current.get(e.id)?.getVideoElement()?.readyState ?? 0) >= 2
            ? canvasRefsMap.current.get(e.id)?.getFraming() : null) ?? framingMap[e.id] ?? {}),
          // Overlay/segment edits (OCR toggles, card move/retime, manual narration, timeline cuts) don't
          // depend on the video, but a Reddit reel's footage stays deferred so the readyState gate above
          // falls back to the STALE framingMap and drops them. Take them from the live canvas when mounted.
          ...(() => {
            const ov = canvasRefsMap.current.get(e.id)?.getOverlays()?.map(({ src, audioSrc, ...o }) => o);
            return ov ? { overlays: ov } : {};
          })(),
          ...(framingMap[e.id]?.redditThread ? { redditThread: framingMap[e.id].redditThread } : {}),
          ...(framingMap[e.id]?.description ? { description: framingMap[e.id].description } : {}),
          ...(framingMap[e.id]?.ytTitle ? { ytTitle: framingMap[e.id].ytTitle } : {}),
          // Every saved row carries a style tag, defaulted to this workspace's — and this is the ONLY place a
          // reel gets tagged unless something already knew its style (a commentary reel built from the Source
          // panel). It has to be: untagged reads as Reddit's, so in any other workspace an untagged reel would
          // be dropped by this very save. Tagging here rather than in framingMap at creation is deliberate —
          // a framing seeded with nothing but a styleId reads as "restore this saved framing" to the canvas,
          // which then skips its trim/zoom init. The gate above is what makes "this workspace's" true.
          styleId: styleTagForSave(framingMap[e.id], activeStyleId),
          ...(framingMap[e.id]?.commentaryScript ? { commentaryScript: framingMap[e.id].commentaryScript } : {}),
          ...(framingMap[e.id]?.bgBlur ? { bgBlur: true } : {}),
          // The thumbnail is a framingMap-only sidecar too (getFraming() doesn't emit it), so once the video
          // loaded and the live framing started winning the base spread, the key was dropped from the row —
          // losing the still on reload and orphaning its blob. It also has to be here for delete-all to be
          // safe: the saved rows are the only record of what the OTHER workspace's reels own, so a key
          // missing from them is a blob the GC can't tell from garbage (see lib/reelMedia).
          ...(framingMap[e.id]?.thumbnailId ? { thumbnailId: framingMap[e.id].thumbnailId, thumbnailName: framingMap[e.id].thumbnailName } : {}),
          // "No music" ('') can't survive a canvas snapshot — getFraming() emits undefined for it, which
          // re-reads as the DEFAULT track. Re-attach the explicit choice (see withFramingSidecars).
          ...(framingMap[e.id]?.musicId !== undefined ? { musicId: framingMap[e.id].musicId } : {}),
          ...(framingMap[e.id]?.musicVolume !== undefined ? { musicVolume: framingMap[e.id].musicVolume } : {}),
        },
      }));
    scheduleSave(rows);
  }, [entries, reelTemplateMap, reelNameMap, activeTwitterId, framingDirty, setEntries, appliedStyle, activeStyleId, scheduleSave, framingMap, canvasRefsMap]);

  // Persist reel videos to IndexedDB so a reel survives reload — fully client-side. Which reels own their
  // bytes (uploads everywhere; commentary's links too, Reddit's never) is lib/reelBytes' call; the effect
  // that drives this lives further down, next to the byte-cache download that produces a link's blob.
  const uploadedBlob = useRef<Map<string, string>>(new Map());   // entryId → the blob URL we've already persisted
  // Blob URL → the File/Blob it was made from, handed over at the moment of upload/download. Without this,
  // persisting meant fetch()-ing the object URL back into a SECOND full copy of a video we were already
  // holding — a pointless extra pass through memory on a 400 MB file. Paths that only ever have a URL
  // (a restored reel, anything we didn't mint ourselves) simply miss here and fall back to that fetch.
  const uploadSourceBlob = useRef<Map<string, Blob>>(new Map());
  const rememberUploadBytes = useCallback((blobUrl: string, blob: Blob) => {
    // Handovers are consumed on the very next render (the persist effect), so this holds ~1 entry; the cap
    // is only so an abandoned one (reel deleted before it persisted) can't pin a file handle forever.
    if (uploadSourceBlob.current.size >= 4) {
      const oldest = uploadSourceBlob.current.keys().next().value;
      if (oldest !== undefined) uploadSourceBlob.current.delete(oldest);
    }
    uploadSourceBlob.current.set(blobUrl, blob);
  }, []);
  const persistUpload = useCallback(async (id: string, blobUrl: string, name: string, policy: { styleId: string; isUpload: boolean }) => {
    try {
      const handed = uploadSourceBlob.current.get(blobUrl);
      uploadSourceBlob.current.delete(blobUrl);
      const blob: Blob = handed ?? (await fetch(blobUrl).then(r => r.blob()));
      // Re-decided with the size in hand: a blob past the ceiling is one the byte cache would refuse to
      // hold anyway, so storing it buys a reel that still can't be exported. The dedupe mark STAYS — this
      // is a permanent verdict on these exact bytes, and clearing it would make the effect re-decide (and
      // for a downloaded link, re-read the whole blob) on every entries change. Only a genuine FAILURE
      // below clears it, so that one can retry.
      if (!shouldPersistBytes({ ...policy, bytes: blob.size })) return;
      await saveLocalVideo(id, blob, name || 'reel');
    } catch { uploadedBlob.current.delete(id); }
  }, []);

  // URL + caption edit history (undo/redo via the rail + ⌘Z / ⌘⇧Z) for the reels posting page.
  const { recordEdit, undo, redo, canUndo, canRedo } = useReelEditHistory(entries, onUpdateEntry);

  // The video timeline (VideoControlsBar) keeps its own segment-edit history and reports it
  // up here, so the SAME rail island + ⌘Z drive it — no separate buttons in the bar. Timeline
  // edits take priority while the timeline is open and has history; otherwise we fall through
  // to the URL/caption history. The bar reports cleared state on unmount (timeline closed).
  const tlUndoRef = useRef<() => void>(() => {});
  const tlRedoRef = useRef<() => void>(() => {});
  const [tlCanUndo, setTlCanUndo] = useState(false);
  const [tlCanRedo, setTlCanRedo] = useState(false);
  const handleTimelineHistory = useCallback(
    (api: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean }) => {
      tlUndoRef.current = api.undo; tlRedoRef.current = api.redo;
      setTlCanUndo(api.canUndo); setTlCanRedo(api.canRedo);
    }, []);
  const mergedUndo = useCallback(() => { if (tlCanUndo) tlUndoRef.current(); else undo(); }, [tlCanUndo, undo]);
  const mergedRedo = useCallback(() => { if (tlCanRedo) tlRedoRef.current(); else redo(); }, [tlCanRedo, redo]);
  const mergedCanUndo = tlCanUndo || canUndo;
  const mergedCanRedo = tlCanRedo || canRedo;

  // Hold undo/redo in refs so the global keydown listener binds once (per videoMode), not every render.
  const undoRef = useRef(mergedUndo); const redoRef = useRef(mergedRedo);
  useEffect(() => { undoRef.current = mergedUndo; redoRef.current = mergedRedo; }, [mergedUndo, mergedRedo]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;   // let native text undo win in fields
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) redoRef.current(); else undoRef.current(); }
      else if (k === 'y') { e.preventDefault(); redoRef.current(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Centered template dropdown (mirrors the Carousels toolbar) — open state, measured anchor, refs.
  const [timelineOpen, setTimelineOpen] = useState(false);   // video-timeline editor — closed by default
  const toolbarRef = useRef<HTMLDivElement>(null);

  const videoRenderEntries = entries.filter(e =>
    !e.loading && (
      e.localVideoSrc || e.videoUrl || (e.data && !(e.data.images && e.data.images.length > 0))
    )
  );

  const [selectedId,                setSelectedId]                = useState<string>(entries[0]?.id ?? '');
  // Which reel is actually on screen — lags selectedId by one fade so the current reel can fade OUT
  // before we swap to (and fade IN) the next. reelVisible drives that fade's opacity.
  const [displayId,   setDisplayId]   = useState(selectedId);
  const [reelVisible, setReelVisible] = useState(true);
  const [recordingStateMap, setRecordingStateMap] = useState<Record<string, RecordingState>>({});

  const [canvasRefVersion,  setCanvasRefVersion]  = useState(0);
  const [videoZoomMap,      setVideoZoomMap]      = useState<Record<string, number>>({});

  const scrollRef  = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lane = useObservedSize(scrollRef);
  // Height-aware: video cards are 9:16 (tall), so fit to BOTH dims or a tall card overflows the viewport.
  const fitFactor = fitScaleFor(lane, CARD_W, Math.round(CARD_W * 16 / 9));
  // Focal-anchored pinch/Ctrl-scroll zoom with a one-shot absolute-100% default (shared editor scaffolding).
  const { viewScale, setViewScale, captureFocal, attachScroll } = useEditorZoomPan({
    scrollRef, contentRef, fitFactor, laneWidth: lane.width,
  });

  const prevLengthRef         = useRef(entries.length);
  // The <video> element each reel's canvas last registered. Compared (rather than just "have we seen this
  // reel?") so a canvas that REMOUNTS — same reel, new element — still forces the re-render that lets the
  // transport re-bind its listeners. Not cleared on unmount: the ref callback fires with null on every
  // render (its identity changes), so treating that as "gone" would bump on every render.
  const canvasVideoEls        = useRef(new Map<string, HTMLVideoElement | null>());

  // Switching reels is instant — swap the rendered reel to the selection immediately, no fade. We don't
  // recenter: the reel centres on mount via the focal effect and the layout is identical, so scroll persists.
  // (A deleted selection is handled by the selectedId-validity effect below, which then re-runs this.)
  //
  // Only the DISPLAYED reel mounts a live <video>+canvas (see the render map) — a large grid must never
  // mount hundreds of videos (a 486-reel account would hang the browser). So before switching, snapshot
  // the OUTGOING reel's live framing into framingMap: its canvas is still mounted here (displayId hasn't
  // changed yet this render), getFraming() reads the current crop/pan/zoom/trim, and both autosave and the
  // reel's next mount read framingMap once the canvas ref is gone. getFraming() returns null mid-load
  // (framing not yet applied) — skip then, keeping the last-known value rather than a placeholder.
  const displayIdRef = useRef(displayId);
  const isDownloadingAllRef = useRef(false);   // set from isDownloadingAll below; read here (declared later)
  useEffect(() => { displayIdRef.current = displayId; }, [displayId]);
  useEffect(() => {
    const outgoing = displayIdRef.current;
    // Skip during Download-All: it cycles selectedId through every reel to export them, and capturing
    // each would materialize default framing + churn autosave for no user edit.
    if (outgoing && outgoing !== selectedId && !isDownloadingAllRef.current) {
      const outRef = canvasRefsMap.current.get(outgoing);
      // Only snapshot the FRAMING NUMBERS of a reel whose video is actually LOADED (readyState ≥ 2). A
      // mid-load canvas reports a placeholder full-canvas box + zero-length trim, and getFraming() can't
      // self-detect that for a session-added reel (null initialFraming) — persisting it would corrupt the
      // reel's crop/trim.
      const loaded = (outRef?.getVideoElement()?.readyState ?? 0) >= 2;
      const f = loaded ? outRef?.getFraming() : null;
      // …but the OVERLAY/segment edits don't depend on the video at all, and a deferred reel's footage may
      // not have decoded a frame yet (preload="metadata" — see lib/videoPreload). Gating those on it silently
      // dropped every OCR toggle, card move/retime, manual narration and timeline cut the moment the user
      // clicked another reel. Capture them over the saved framing whenever the canvas is mounted.
      const liveOverlays = outRef?.getOverlays()?.map(({ src, audioSrc, ...o }) => o);
      const liveSegs = outRef?.getSegments?.();
      if (f || liveOverlays) setFramingMap(prev => {
        const cur = prev[outgoing];
        const base = f ? withFramingSidecars(f, cur) : { ...(cur ?? {}) };
        const merged: Framing = {
          ...base,
          ...(liveOverlays ? { overlays: liveOverlays } : {}),
          ...(liveSegs !== undefined ? { segments: liveSegs ?? undefined } : {}),
        };
        // Only commit when the framing actually changed, so merely navigating between reels doesn't
        // trigger an autosave (a whole-array upsert) on every switch.
        return cur && JSON.stringify(cur) === JSON.stringify(merged) ? prev : { ...prev, [outgoing]: merged };
      });
    }
    setDisplayId(selectedId);
    setReelVisible(true);
  }, [selectedId]);

  // Keep the active template tracking the reel currently on screen. A reel's effective template is
  // reelTemplateMap[id] ?? activeTwitterId, so syncing activeTwitterId to the selected reel's template
  // means template-less reels — freshly added, or SENT from the Content Sheet — inherit the band of the
  // reel you're actually looking at, not whatever template happened to be picked last. (If the selected
  // reel has no explicit template it's already using activeTwitterId, so leave it be.)
  useEffect(() => {
    const t = reelTemplateMap[selectedId];
    if (t) setActiveTwitterId(t);
  }, [selectedId, reelTemplateMap]);

  // Keep selectedId valid: if the selected reel is deleted, fall back to the first reel so the canvas
  // and the bottom strip's highlight stay coherent.
  useEffect(() => {
    if (selectedId && !entries.some(e => e.id === selectedId)) setSelectedId(entries[0]?.id ?? '');
  }, [entries, selectedId, active]);

  // Prioritise the reel you're looking at: when you switch to one whose video is still waiting in the
  // rate-limited fetch queue, bump it to the front so it loads next instead of behind the others. No-op
  // if it isn't queued (already fetched, or already downloading).
  useEffect(() => {
    const e = entries.find(x => x.id === selectedId);
    if (e && !e.data && !e.videoUrl && !e.localVideoSrc && e.url.trim()) prioritizeVideoFetch(e.url.trim());
  }, [selectedId, entries]);

  // When a new entry is added, select and scroll to it
  useEffect(() => {
    if (entries.length > prevLengthRef.current) {
      const newest = entries[entries.length - 1];
      if (newest) setTimeout(() => setSelectedId(newest.id), 30);
    }
    prevLengthRef.current = entries.length;
  }, [entries.length]);

  // Only the active reel plays: pause every other reel's video whenever the focus changes. Videos
  // never autoplay, so pausing the ones you flick away from keeps at most one playing at a time.
  // Going Home only hides the workspace (display:none), which does NOT stop an HTMLVideoElement — so a
  // reel left playing would keep its audio, narration and music running over the Home screen with no
  // visible control. Pause everything the moment the workspace stops being active.
  useEffect(() => {
    if (!active) { canvasRefsMap.current.forEach(ref => ref.pause()); return; }
    canvasRefsMap.current.forEach((ref, id) => { if (id !== selectedId) ref.pause(); });
  }, [selectedId, canvasRefsMap]);


  // Paste-to-fill the selected row: ⌘/Ctrl+V a video file from the clipboard sets it as the
  // selected reel's media — the same as clicking that row's Upload button — so the user doesn't
  // have to. Ignored while typing so text / URL paste still works. Reels media are local object
  // URLs (no bucket upload), matching the Upload handlers; only video files are intercepted,
  // anything else falls through to default paste.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      // The workspace stays MOUNTED behind Home (display:none), so without this a ⌘V on the Home landing
      // would land on the hidden workspace's selected reel and overwrite its video.
      if (!active) return;
      const sel = entries.find(en => en.id === selectedId) ?? entries[0];
      if (!sel) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.kind !== 'file' || !it.type.startsWith('video/')) continue;
        const file = it.getAsFile();
        if (!file) continue;
        e.preventDefault();
        // Same gate as the Upload button: a file that can't be stored or exported is refused now, with a
        // reason, instead of at export. The clipboard item is read synchronously above — only the check
        // and the attach are deferred.
        void (async () => {
          const problem = await checkVideoFile(file);
          if (problem) { setReelNotice(problem); return; }
          if (sel.localVideoSrc?.startsWith('blob:')) URL.revokeObjectURL(sel.localVideoSrc);
          const src = URL.createObjectURL(file);
          rememberUploadBytes(src, file);
          onUpdateLocalVideo(sel.id, src, file.name);
          onUpdateEntry(sel.id, 'url', '');
        })();
        return;
      }
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [entries, selectedId, onUpdateLocalVideo, onUpdateEntry, active, rememberUploadBytes]);

  // Duplicate a reel: copy the entry, then carry over all id-keyed editor state (reel
  // framing/template/zoom/scale) to the new id, and select the copy. Framing prefers the LIVE value
  // off the canvas ref so the duplicate matches exactly what's on screen.
  const handleDuplicate = useCallback((id: string) => {
    const newId = onDuplicateRow(id);
    if (!newId) { setReelNotice(`You’ve hit the ${MAX_REELS}-reel limit — remove one to add another.`); return; }
    const carry = <T,>(set: Dispatch<SetStateAction<Record<string, T>>>) =>
      set(prev => (id in prev ? { ...prev, [newId]: prev[id] } : prev));
    carry(setVideoZoomMap);
    carry(setReelNameMap);   // the copy keeps the source's name (rename it apart afterwards)
    setReelTemplateMap(prev => ({ ...prev, [newId]: prev[id] ?? activeTwitterId ?? null }));
    setFramingMap(prev => {
      const snap = canvasRefsMap.current.get(id)?.getFraming();
      return { ...prev, [newId]: snap ? withFramingSidecars(snap, prev[id]) : (prev[id] ?? {}) };
    });
    setSelectedId(newId);
  }, [onDuplicateRow, activeTwitterId]);

  const getVideoZoom = useCallback((id: string) => videoZoomMap[id] ?? 1, [videoZoomMap]);

  // Add an image overlay to a reel: persist the blob (IndexedDB) so it survives reloads, then hand a
  // fresh object URL to the canvas, which sizes/centres it and selects it. OCR runs in the background
  // right away so the click-to-toggle narration highlights appear on the overlay once the text is read.
  // Custom thumbnail: the still is held for a few frames at the very START of this reel's export, which is
  // the only way to get a chosen image into a Short (YouTube offers no thumbnail upload for Shorts — you
  // pick a video frame). The blob lives in IndexedDB like every other image; framing keeps only the key.
  // The blob delete stays OUTSIDE the setFramingMap updater: React double-invokes updaters in StrictMode,
  // so a side effect in there would fire twice. framingMapRef mirrors the committed map, which is exactly
  // the "what is attached right now" the delete needs.
  const setReelThumbnail = useCallback(async (id: string, file: File) => {
    const thumbnailId = `th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await saveOverlayImage(thumbnailId, file, file.name);
    const old = framingMapRef.current[id]?.thumbnailId;
    setFramingMap(prev => ({ ...prev, [id]: { ...prev[id], thumbnailId, thumbnailName: file.name } }));
    if (old && old !== thumbnailId) void deleteOverlayImage(old);   // replaced → don't orphan the old blob
    markFramingDirty();
  }, [markFramingDirty]);

  const clearReelThumbnail = useCallback((id: string) => {
    const old = framingMapRef.current[id]?.thumbnailId;
    if (!old) return;
    setFramingMap(prev => {
      const next = { ...prev[id] };
      delete next.thumbnailId;
      delete next.thumbnailName;
      return { ...prev, [id]: next };
    });
    void deleteOverlayImage(old);
    markFramingDirty();
  }, [markFramingDirty]);


  // Add a rendered Reddit card as an overlay. Same persistence path as an uploaded image, but the
  // narration lines are synthetic (from the renderer's layout) instead of OCR'd. addImageOverlay
  // commits the overlay inside img.onload, so the lines attach via a short retry loop; if they
  // somehow miss, generateNarration's OCR fallback still reads the card.
  /** Persist an erase-mode card's cover atlas and return the overlay fields that reference it —
      empty for crop-mode cards, so spreading the result is always safe. */
  const saveCoverAtlas = async (card: Pick<RedditCardResult, 'coverAtlas' | 'coverPatches'>): Promise<Partial<ImageOverlay>> => {
    if (!card.coverAtlas || !card.coverPatches?.length) return {};
    const coverAtlasId = `cov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await saveOverlayImage(coverAtlasId, card.coverAtlas.blob, 'reddit-card-covers.png');
    return { coverAtlasId, coverAtlas: { w: card.coverAtlas.w, h: card.coverAtlas.h }, coverPatches: card.coverPatches };
  };

  const addRedditCard = useCallback(async (id: string, card: RedditCardResult, dims: { w: number; h: number }, blockAuthors: string[]) => {
    if (!primaryOverlayName) return;   // a style with no card overlay has no Reddit-thread flyout to call this
    const ref = canvasRefsMap.current.get(id);
    // Replace any existing card on this reel — re-adding updates the thread, never stacks a
    // second card (removeOverlay also GCs its stored image + narration audio).
    for (const o of ref?.getOverlays() ?? []) {
      if (o.name === primaryOverlayName) ref?.removeOverlay(o.id);
    }
    const overlayId = `ov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await saveOverlayImage(overlayId, card.blob, 'reddit-card.png');
    // Erase mode's cover-strip atlas: its own blob beside the card's (removeOverlay, the rebuild GC
    // and reelMedia all know coverAtlasId, so it lives and dies with the card).
    const covers = await saveCoverAtlas(card);
    const url = URL.createObjectURL(card.blob);
    ref?.addImageOverlay(overlayId, url, primaryOverlayName);
    // Cast + fit the card (blockAuthors stored so Shuffle voices can re-cast later without re-import).
    // dwells ride along with ocrLines because they're anchored to its indices (lib/redditDwell).
    const { ocrLines, rect } = cardOverlayLayout(card.lines, dims, blockAuthors, activeStyle.voiceCast);
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 150));
      canvasRefsMap.current.get(id)?.updateOverlay(overlayId, { ocrLines, blockAuthors, dwells: card.dwells, ...covers, ...rect });
    }
  }, [canvasRefsMap, primaryOverlayName, activeStyle.voiceCast]);

  // Reshuffle a card's voice cast on demand (uses the stored blockAuthors). Recolors the line
  // highlights immediately; the user then regenerates narration to hear the new cast.
  const shuffleCardVoices = useCallback((entryId: string, overlayId: string) => {
    const ref = canvasRefsMap.current.get(entryId);
    const o = ref?.getOverlays().find(x => x.id === overlayId);
    if (!o?.ocrLines || !o.blockAuthors) return;
    const blockVoice = castBlockVoices(o.blockAuthors, activeStyle.voiceCast);
    if (!blockVoice.length) return;   // no fixed cast → nothing to reshuffle
    ref?.updateOverlay(overlayId, { ocrLines: o.ocrLines.map(l => ({ ...l, voiceId: blockVoice[l.blockIdx] })) });
  }, [canvasRefsMap, activeStyle.voiceCast]);

  // Generate ElevenLabs narration for an overlay and attach it. The meme's text is read straight off
  // the image (OCR — nothing to type). Consecutive enabled lines with the same painted voice form one
  // paragraph, spoken as its own excited take; the takes are stitched into a single narration track.
  // The reveal is adapted to that audio: character timestamps (offset by each take's position in the
  // stitched track) say when each OCR text LINE is reached, and the image un-crops to that line's own
  // boundary just before its first word lands. Returns an error message, or null on success.
  const generateNarration = useCallback(async (entryId: string, overlayId: string, apiKey: string, onStatus?: (s: string) => void): Promise<string | null> => {
    const ref = canvasRefsMap.current.get(entryId);
    const overlay = ref?.getOverlays().find(o => o.id === overlayId);
    if (!ref || !overlay?.src) return 'The overlay image isn’t loaded yet — try again in a moment.';
    // Per-overlay narration is Reddit-only (see TikTokCanvasRef.setOverlayNarration). A canvas that doesn't
    // implement it can't hold the result — and its export wouldn't play it — so refuse up front instead of
    // burning a TTS call and reporting success on audio nothing will ever voice.
    if (!ref.setOverlayNarration) return 'This reel’s style doesn’t narrate image overlays.';

    // The image was OCR'd when it was added; run it now only if that hasn't landed yet (e.g. the
    // user hit Generate immediately). Only lines the user left enabled get narrated.
    let ocrLines = overlay.ocrLines;
    if (!ocrLines?.length) {
      onStatus?.('Reading the meme text…');
      try {
        ocrLines = (await extractMemeLines(overlay.src)).map(l => ({ ...l, enabled: true }));
      } catch (e) {
        console.error('[narration] OCR failed:', e);
        return 'Couldn’t read the image — OCR failed to load.';
      }
      if (ocrLines.length === 0) return 'No readable text found in the image.';
      ref.updateOverlay(overlayId, { ocrLines });
    }
    // Dwells (silent holds on wordless content — a Reddit post's image) are anchored to the CARD's own
    // line indices, so they're only meaningful alongside the line map that shipped with them: read them
    // before any OCR fallback can replace it, and translate the anchors onto the enabled lines below.
    // dropCoveredDwells is the OTHER half of the card's always-ship-the-dwell contract: an image whose
    // OCR'd lines are still enabled narrates through them (dwell redundant → dropped); mute them all
    // and the dwell takes back over, so the image never loses its screen time to a junk-line cleanup.
    const cardDwells = overlay.ocrLines?.length ? dropCoveredDwells(overlay.dwells, overlay.ocrLines) : undefined;
    const memeLines = ocrLines.filter(l => l.enabled);
    if (memeLines.length === 0) return 'Every text line is unselected — click lines on the image to include them.';
    const dwells = resolveDwells(cardDwells, ocrLines.map(l => l.enabled));

    // Consecutive same-voice lines form one spoken paragraph (one TTS take with that voice).
    const defaultVoice = (narrationVoices[0] ?? '').trim() || DEFAULT_VOICE;
    // A disabled voice (e.g. persisted on an old card) is revoiced to the first voice of the style's cast,
    // so it's never actually spoken even after regeneration. A cast-less style falls back to the default
    // narrator, which is what its un-painted lines already read in.
    const subst = activeStyle.voiceCast?.pool[0]?.id ?? defaultVoice;
    const groups: { voiceId: string; lines: typeof memeLines }[] = [];
    for (const line of memeLines) {
      let vid = (line.voiceId ?? '').trim() || defaultVoice;
      if (DISABLED_VOICE_IDS.has(vid)) vid = subst;
      const g = groups[groups.length - 1];
      if (g && g.voiceId === vid) g.lines.push(line);
      else groups.push({ voiceId: vid, lines: [line] });
    }

    // One take per group. Within a take: lines joined with spaces, terminal punctuation added only at
    // block ends — the voice pauses between blocks but flows straight through mid-sentence line
    // wraps. Each take is decoded to PCM so the takes can be stitched into ONE narration track, with
    // per-line beat times = take offset + the line's first-character timestamp.
    const MIX_SR = 44100;
    const GROUP_GAP_S = 0.25;   // breath between voices
    const segments: { samples: Float32Array; beats: number[]; voiceId: string }[] = [];
    const ac = new AudioContext({ sampleRate: MIX_SR });
    try {
      // Build each voice group's text upfront (pure — join lines, add terminal punctuation at block ends,
      // record per-line char offsets for beat timing), then fire ALL the /api/tts calls CONCURRENTLY
      // (bounded). ElevenLabs round-trips dominate narration time, so a card with N voices generates ~N×
      // faster. Decode + stitch below stays strictly in group order, so the output WAV is byte-identical.
      const groupTexts = groups.map(g => {
        // Clean each line for the NARRATOR only (URLs, emojis, symbols, shouted ALL-CAPS) — the on-screen
        // card keeps the authored text, and the reveal maps by line INDEX, so cleaning WITHIN a line can't
        // desync it. If a whole voice-group cleans away to nothing (e.g. a comment that's only a link), fall
        // back to its original text so ElevenLabs still gets non-empty input.
        const build = (clean: boolean) => {
          let joined = '';
          const offs: number[] = [];
          for (let i = 0; i < g.lines.length; i++) {
            const line = g.lines[i];
            // The line's own endsBlock flag is honoured IN ADDITION to the blockIdx transition: for
            // every native producer the two coincide, but a Reddit card's spliced image lines share
            // the post's blockIdx while keeping OCR's real block structure in the flag — without the
            // OR, the pause between the post body and the image text (and between the image's own
            // caption blocks) silently vanished and the voice read them as one run-on sentence.
            const endsBlock = line.endsBlock || i === g.lines.length - 1 || g.lines[i + 1].blockIdx !== line.blockIdx;
            const t = clean ? ttsClean(line.text) : line.text;
            if (joined) joined += ' ';
            offs.push(joined.length);
            if (t) joined += t;
            // End a block with a period so the voice pauses between blocks — attached to whatever content the
            // block produced, even when its LAST line cleaned away to nothing (a bare link/emoji line).
            if (endsBlock) {
              joined = joined.replace(/\s+$/, '');
              if (joined && !/[.!?…,:;]$/.test(joined)) joined += '.';
            }
          }
          return { joined, offs };
        };
        let r = build(true);
        if (!r.joined.trim()) r = build(false);
        return { joined: r.joined, offs: r.offs, voiceId: g.voiceId };
      });
      type TtsOut = { audioB64?: string; starts?: number[]; error?: string };
      const ttsResults = new Array<TtsOut>(groups.length);
      const TTS_ATTEMPTS = 4;         // 1 try + 3 retries — rides out transient ElevenLabs rate-limits (429→502)
      const fetchTts = async (gi: number): Promise<TtsOut> => {
        const gt = groupTexts[gi];
        let lastErr = 'Narration failed — the voice service is busy; try again in a moment.';
        for (let attempt = 0; attempt < TTS_ATTEMPTS; attempt++) {
          // Exponential backoff with jitter (0.6s → 1.2s → 2.4s) so concurrent groups that collide on a rate
          // limit don't re-fire in lockstep. The /api/tts route folds ElevenLabs' 429 into a 502 + a retryable hint.
          if (attempt) await new Promise(r => setTimeout(r, 600 * 2 ** (attempt - 1) + Math.random() * 400));
          let res: Response;
          try {
            res = await fetch('/api/tts', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                apiKey, voiceId: gt.voiceId, text: gt.joined,
                // Excited meme-narrator delivery: low stability + high style = animated, hyped read. `speed`
                // is ElevenLabs' native pacing — reveal sync holds because the timestamps describe the sped audio.
                voiceSettings: { stability: 0.35, similarity_boost: 0.8, style: 0.6, use_speaker_boost: true, speed: narrationSpeed },
              }),
            });
          } catch { lastErr = 'Could not reach the narration service.'; continue; }   // network blip → retry
          const json = await res.json().catch(() => ({})) as {
            audio_base64?: string; alignment?: { character_start_times_seconds?: number[] }; error?: string; retryable?: boolean;
          };
          if (res.ok) return { audioB64: json.audio_base64, starts: json.alignment?.character_start_times_seconds };
          if (json.error) lastErr = json.error;   // keep the ACTUAL message (bad key/plan/voice) to surface if we give up
          // Retry only rate-limits / transient upstream 5xx; a deterministic config failure (retryable:false)
          // won't improve, so surface its real message immediately instead of burning retries.
          const retryable = res.status === 502 ? json.retryable !== false : (res.status === 429 || res.status === 503);
          if (!retryable) return { error: lastErr };
        }
        return { error: lastErr };
      };
      // Cap at 2 — narrate-all is serial across cards, so this is the global ElevenLabs concurrency; 2 is the
      // free-tier ceiling (still ~2× faster than serial) and, with the backoff above, rides out brief 429s.
      const TTS_CONCURRENCY = 2;
      let nextGi = 0, doneGroups = 0, poolFailed = false;
      await Promise.all(Array.from({ length: Math.min(TTS_CONCURRENCY, groups.length) }, async () => {
        // Stop claiming NEW groups once any group has definitively failed (fetchTts already exhausted its
        // retries) — the whole card's narration fails on the first error anyway, so firing the rest just
        // burns TTS calls and slows Cancel. Claims are contiguous (nextGi++ is atomic in JS) and in-flight
        // groups still store their result, so the decode loop below never hits an undefined slot before the
        // first error. At most CONCURRENCY-1 extra groups finish after the failure — unavoidable with a pool.
        while (!poolFailed) {
          const gi = nextGi++;
          if (gi >= groups.length) break;
          const out = await fetchTts(gi);
          ttsResults[gi] = out;
          if (out.error) poolFailed = true;
          doneGroups++;
          onStatus?.(groups.length > 1 ? `Generating voices ${doneGroups}/${groups.length}…` : 'Generating narration…');
        }
      }));
      // Decode + gain + collect segments STRICTLY in group order — the stitched track must match serial output.
      for (let gi = 0; gi < groups.length; gi++) {
        const r = ttsResults[gi];
        // A slot is undefined only if the pool short-circuited before claiming this group, which happens
        // strictly AFTER a lower-gi group errored — so the r.error return below fires first. Guard anyway so
        // the loop can never deref undefined regardless of ordering.
        if (!r || r.error) return r?.error ?? 'Narration failed.';
        if (!r.audioB64 || !r.starts?.length) return 'ElevenLabs returned no audio.';
        const bytes = Uint8Array.from(atob(r.audioB64), c => c.charCodeAt(0));
        let decoded: AudioBuffer;
        try {
          decoded = await ac.decodeAudioData(bytes.buffer);
        } catch {
          return 'Couldn’t decode the narration audio.';
        }
        const starts = r.starts;
        const samples = Float32Array.from(decoded.getChannelData(0));   // ElevenLabs is mono
        // Channel gain: balance this voice against the rest of the cast (soft-clipped at ±1).
        const gain = voiceGains[groups[gi].voiceId] ?? 1;
        if (gain !== 1) {
          for (let i = 0; i < samples.length; i++) samples[i] = Math.max(-1, Math.min(1, samples[i] * gain));
        }
        segments.push({
          samples,
          beats: groupTexts[gi].offs.map(off => starts[Math.min(off, starts.length - 1)] ?? 0),
          voiceId: groups[gi].voiceId,
        });
      }
    } finally {
      void ac.close();
    }

    // Stitch the takes (with a breath of silence between voices) and WAV-encode the result. planStitch
    // owns the arithmetic — where each take lands, each line's absolute beat, and where a dwell splices
    // its silence in — so the whole layout is unit-tested; here we only copy the samples it points at.
    // With no dwells it reproduces the plain end-to-end stitch exactly.
    const gapSamples = Math.round(GROUP_GAP_S * MIX_SR);
    const plan = planStitch({
      takes: segments.map(s => ({ samples: s.samples.length, beats: s.beats, voiceId: s.voiceId })),
      dwells, gapSamples, sampleRate: MIX_SR,
    });
    const stitched = new Float32Array(plan.totalSamples);
    for (const c of plan.copies) stitched.set(segments[c.takeIdx].samples.subarray(c.from, c.to), c.dst);
    const beatStarts = plan.beatStarts;                 // audio-time per enabled line, in memeLines order
    const audioTakes = plan.audioTakes;                 // timeline channel blocks
    const audioDuration = plan.totalSamples / MIX_SR;   // grows by every dwell — the hold is real audio
    const blob = encodeWavMono(stitched, MIX_SR);
    const audioId = `aud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await saveOverlayImage(audioId, blob, 'narration.wav');

    // Each OCR line carries its own crop boundary, so text↔reveal mapping is exact (monotonic —
    // never crop back up). Each line un-crops a breath BEFORE its first word so the text is on
    // screen as it's read; a dwell un-crops ON its silence instead (nothing to read ahead of). Reveal
    // times live in SOURCE time: the background video runs VIDEO_RATE× faster than the voice, so
    // audio-time beats are scaled up onto the video's clock.
    const REVEAL_LEAD_S = 0.15;
    const VIDEO_RATE = 1.25;   // slight background speed-up, brainrot style
    const audioStart = overlay.start;
    const reveals = buildReveals({
      lineBeats: beatStarts,
      lineFracs: memeLines.map(l => l.bottomFrac),
      dwells, dwellStarts: plan.dwellStarts,
      audioStart, leadS: REVEAL_LEAD_S, rate: VIDEO_RATE,
    });

    onStatus?.(`Narrating ${memeLines.length} line${memeLines.length === 1 ? '' : 's'} in ${groups.length} voice${groups.length === 1 ? '' : 's'}…`);

    // Erase-mode cover lifts: each strip lifts on its line's beat, with the SAME lead the crop uses,
    // so the two reveal mechanisms never disagree about when a line "arrives". Derived from
    // beatStarts (enabled-line order) — the reveals array can't be used, it drops equal-h steps.
    let coverLifts: (number | null)[] | undefined;
    if (overlay.coverPatches?.length) {
      const enabledIdxOf = new Map<number, number>();
      let en = 0;
      ocrLines.forEach((l, i) => { if (l.enabled) enabledIdxOf.set(i, en++); });
      coverLifts = coverLiftTimes(overlay.coverPatches, ocrLines, cardIdx => {
        const ei = enabledIdxOf.get(cardIdx);
        return ei === undefined ? undefined : audioStart + Math.max(0, beatStarts[ei] - REVEAL_LEAD_S) * VIDEO_RATE;
      });
    }

    // A meme in erase mode is ALL image lines with covers: the image sits full-size where it was
    // placed and only the covers move, so no crop steps at all — reveals would pin the overlay to
    // the teleprompter midline and scroll a fully-visible image for no reason. A Reddit card keeps
    // its reveals (title/body/comments still crop-scroll around the covered band).
    const allImageErase = !!overlay.coverPatches?.length && ocrLines.every(l => l.fromImage);
    ref.setOverlayNarration?.(overlayId, { reveals: allImageErase ? [] : reveals, audioId, audioStart, audioDuration, audioSrc: URL.createObjectURL(blob), audioRate: VIDEO_RATE, audioTakes, coverLifts });

    // The style's card overlay snaps to the reading layout once narrated: readable width, top-anchored.
    // The teleprompter scroll in drawOverlays keeps the reveal front pinned on screen from there,
    // however long the text is (reference: reddit-story shorts). A user-added image on the same reel is
    // left where they put it — only the card is re-laid-out.
    if (primaryOverlayName && overlay.name === primaryOverlayName) {
      const w = 886;   // ~82% of the 1080 canvas — comment text stays readable in the export
      const h = Math.round(w * (overlay.h / overlay.w));
      // An erase-mode meme plays STATIC — no crop steps, so drawOverlays honours o.y instead of the
      // teleprompter pin — and a top-anchored reading layout would leave it visibly high for the whole
      // reel. Center it; the crop modes keep the top anchor (their y is pinned during playback anyway).
      const y = allImageErase ? Math.max(0, Math.round((1920 - h) / 2)) : 110;
      ref.updateOverlay(overlayId, { x: Math.round((1080 - w) / 2), y, w, h });
    }
    return null;
  }, [canvasRefsMap, narrationVoices, narrationSpeed, voiceGains, primaryOverlayName, activeStyle.voiceCast]);

  // COMMENTARY narration: voice the reel's written `commentaryScript` (one voice, Liam) as an INTRO over the
  // start of the uploaded video. Unlike Reddit narration this doesn't read card pixels or build reveals —
  // it writes a single audio-carrier overlay (intro:true, audioRate:1) straight into framingMap, plus caption
  // chunks timed to the voice. No mounted canvas needed: the audio re-hydrates from IndexedDB on mount and
  // the export mixes it (ducking the video's own audio under it). Returns null on success, else an error string.
  const generateCommentaryNarration = useCallback(async (reelId: string, apiKey: string, onStatus?: (s: string) => void): Promise<string | null> => {
    const script = (framingMap[reelId]?.commentaryScript ?? '').trim();
    if (!script) return 'No commentary script — add one in the Commentary step first.';
    const text = ttsClean(script);
    if (!text) return 'The script has nothing to narrate after cleaning.';
    onStatus?.('Voicing commentary…');
    const TTS_ATTEMPTS = 4;
    let lastErr = 'Narration failed — the voice service is busy; try again in a moment.';
    let audioB64: string | undefined, starts: number[] | undefined;
    for (let attempt = 0; attempt < TTS_ATTEMPTS; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 600 * 2 ** (attempt - 1) + Math.random() * 400));
      let res: Response;
      try {
        res = await fetch('/api/tts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey, voiceId: DEFAULT_VOICE, text,
            // Commentary read: a touch more stability + less style than the meme narrator, for a level voice-over.
            voiceSettings: { stability: 0.45, similarity_boost: 0.8, style: 0.4, use_speaker_boost: true, speed: narrationSpeed },
          }),
        });
      } catch { lastErr = 'Could not reach the narration service.'; continue; }
      const json = await res.json().catch(() => ({})) as {
        audio_base64?: string; alignment?: { character_start_times_seconds?: number[] }; error?: string; retryable?: boolean;
      };
      if (res.ok) { audioB64 = json.audio_base64; starts = json.alignment?.character_start_times_seconds; break; }
      if (json.error) lastErr = json.error;
      const retryable = res.status === 502 ? json.retryable !== false : (res.status === 429 || res.status === 503);
      if (!retryable) return lastErr;
    }
    if (!audioB64) return lastErr;
    const bytes = Uint8Array.from(atob(audioB64), c => c.charCodeAt(0));
    const ac = new AudioContext();
    let decoded: AudioBuffer;
    try { decoded = await ac.decodeAudioData(bytes.buffer); }
    catch { void ac.close(); return 'Couldn’t decode the narration audio.'; }
    void ac.close();
    // Re-encode to WAV (like Reddit narration): the preview <audio> and export decodeAudioData handle it cleanly.
    const blob = encodeWavMono(Float32Array.from(decoded.getChannelData(0)), decoded.sampleRate);
    const audioDuration = decoded.duration;
    const audioId = `aud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await saveOverlayImage(audioId, blob, 'commentary.wav');
    const captions = buildCaptions(text, starts ?? [], audioDuration);
    const overlay: Omit<ImageOverlay, 'src' | 'audioSrc'> = {
      id: `ov-commentary-${Date.now().toString(36)}`, name: 'Commentary',
      x: 0, y: 0, w: CANVAS_W, h: CANVAS_H, start: 0, end: 3600,
      audioId, audioStart: 0, audioDuration, audioRate: 1, intro: true, captions,
    };
    // Commentary reels carry exactly one overlay (the voice); replace wholesale so a re-narrate is idempotent.
    // GC the PREVIOUS take's audio blob (nothing references it after the replace), and bump the canvas epoch
    // so a mounted canvas remounts + re-seeds the fresh intro (a seeded canvas never re-reads framingMap).
    const oldAudioIds = (framingMap[reelId]?.overlays ?? []).filter(o => o.intro && o.audioId && o.audioId !== audioId).map(o => o.audioId!);
    // The remount re-seeds from framingMap, but framingMap only receives live canvas edits on switch-away —
    // so capture the CURRENT live framing (crop/pan/zoom/trim the user just made) first, or re-voicing
    // would silently revert them to the last snapshot.
    const liveRef = canvasRefsMap.current.get(reelId);
    const liveFraming = (liveRef?.getVideoElement()?.readyState ?? 0) >= 2 ? liveRef?.getFraming() : null;
    setFramingMap(prev => {
      const base = liveFraming ? withFramingSidecars(liveFraming, prev[reelId]) : (prev[reelId] ?? {});
      return { ...prev, [reelId]: { ...base, overlays: [overlay] } };
    });
    for (const old of oldAudioIds) void deleteOverlayImage(old);
    setCanvasEpochMap(prev => ({ ...prev, [reelId]: (prev[reelId] ?? 0) + 1 }));
    markFramingDirty();
    return null;
  }, [framingMap, narrationSpeed, setFramingMap, markFramingDirty, canvasRefsMap]);

  // Remount key per commentary canvas — bumped after (re)voicing so a mounted canvas re-seeds the fresh
  // intro overlay from framingMap instead of holding (and later snapshotting back) a stale live list.
  const [canvasEpochMap, setCanvasEpochMap] = useState<Record<string, number>>({});

  const applyVideoZoom = useCallback((id: string, s: number) => {
    const clamped = Math.max(0.5, Math.min(3, s));
    setVideoZoomMap(prev => ({ ...prev, [id]: clamped }));
    canvasRefsMap.current.get(id)?.setZoom(clamped);
  }, [canvasRefsMap]);

  // ── Download (one reel, or all) ───────────────────────────────────────────────
  // Only the on-screen reel is mounted (canvasRefsMap holds a single ref), so "Download all" can't just
  // loop the refs — it cycles the selection to each reel, waits for it to mount + load, then exports.
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  useEffect(() => { isDownloadingAllRef.current = isDownloadingAll; }, [isDownloadingAll]);
  const [downloadProgress, setDownloadProgress] = useState({ done: 0, total: 0 });
  // Post-batch summary when a "download all" didn't produce every reel — otherwise the zip silently
  // omits failed/never-ready reels and the user thinks they got everything.
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  // Batch generation across every reel — narration (cycles each reel on-screen) or YouTube copy (pure
  // API). Live progress + a cancel flag, since narrating many reels can take several minutes.
  const [batchOp, setBatchOp] = useState<null | 'narration' | 'copy'>(null);
  const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0, status: '' });
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const batchCancelRef = useRef(false);
  // Dismissible toolbar notice for an action the grid refused: an add/duplicate blocked by the MAX_REELS
  // cap, or a pasted video file we won't take (too big, or a codec that could never export).
  const [reelNotice, setReelNotice] = useState<string | null>(null);
  const atReelCap = entries.length >= MAX_REELS;

  // "Add reel": with the auto-random toggle on, seed the new reel with a random footage segment;
  // otherwise add a blank reel. Manifest load falls back to blank on error. NOTE: no blob pre-warm
  // here — firing a full-file download per add saturated the browser's ~6-connection-per-host limit
  // when several reels were added quickly, starving the on-screen reel's video stream. The selected
  // reel is pre-warmed instead (one at a time), and the timeline warms itself when opened.
  const handleAddRow = useCallback(async () => {
    if (atReelCap) { setReelNotice(`You’ve hit the ${MAX_REELS}-reel limit — remove one to add another.`); return; }
    // The new reel is deliberately left OUT of framingMap: the row builder stamps this workspace's style at
    // save time (styleTagForSave), which is all the tag it needs. Seeding a bare { styleId } here instead
    // made initialFraming truthy-but-empty, so the canvas' apply effect stamped framingAppliedSrcRef and
    // useVideoLoading then SKIPPED its offset/scale/trim init — the reel sat at trimEnd 0 and saved that way.
    // A style whose video is interchangeable background footage ALWAYS gets a clip picked for it — that is
    // what its video is, and there is no link input to fill in instead. A style that brings its own video
    // gets a blank reel to drop it into.
    if (!activeStyle.assignsFootage) { onAddRow(); return; }
    try {
      const segs = await fetchFootageManifest();
      const seg = segs.length ? segs[Math.floor(Math.random() * segs.length)] : null;
      onAddRow(seg?.url);
    } catch {
      onAddRow();       // library unreachable → a blank reel is better than no reel
    }
  }, [atReelCap, activeStyle.assignsFootage, onAddRow]);

  // NOTE: no selected-reel video pre-warm. It existed to warm the timeline's scrub blob, but eagerly
  // full-downloading each selected reel's ~100MB clip (incl. every reel a batch narration cycles through)
  // stalled the build/narrate/copy flow. The clip now loads lazily (preload="metadata") and is fetched in
  // full only at export — see RedditCanvas <video>. Re-add a size-gated warm here if the timeline returns.

  const [bulkOpen, setBulkOpen] = useState(false);
  // Canvas ⇄ Pipeline (bulk stages-as-nodes) view — persisted so a reload reopens the view you were on.
  // Start false on server + first client render (this flips the WHOLE view, so a localStorage initializer
  // would hydrate-mismatch); restore the persisted value AFTER mount, then persist on change.
  const [pipelineView, setPipelineView] = useState(false);
  const pipelineViewRestored = useRef(false);
  useEffect(() => {
    if (!pipelineViewRestored.current) {
      pipelineViewRestored.current = true;
      try { if (hasPipeline && localStorage.getItem('reels:pipelineView') === '1') setPipelineView(true); } catch { /* SSR/private */ }
      return;   // don't persist the mount default over a stored value before we've read it
    }
    try { localStorage.setItem('reels:pipelineView', pipelineView ? '1' : '0'); } catch { /* quota/private */ }
  }, [pipelineView]);

  // Commentary SOURCE: create a reel from an uploaded video + script, tagged styleId='commentary'. The video
  // auto-persists (the localVideoSrc effect), and the tag makes commentary.computeStages count it.
  // Open state for whichever source modal this style declares (reelSurfaces.renderSource).
  const [sourceOpen, setSourceOpen] = useState(false);
  const [redditOpen, setRedditOpen] = useState(false);
  const createCommentaryReel = (source: { link?: string; video?: { url: string; name: string; file: Blob } }, script: string) => {
    // Seed the reel's URL with the link so the auto-fetch effect resolves it (Instagram/TikTok/X/YouTube via
    // /api/download) — same path the rest of the app uses. A file upload sets localVideoSrc instead.
    const ids = onAddReels?.([source.link || undefined]) ?? [];
    const id = ids[0];
    if (!id) return;
    if (source.video) {
      rememberUploadBytes(source.video.url, source.video.file);   // the persist effect gets the File, not a re-read
      onUpdateLocalVideo(id, source.video.url, source.video.name);
    }
    setFramingMap(prev => ({ ...prev, [id]: { ...prev[id], styleId: 'commentary', ...(script ? { commentaryScript: script } : {}) } }));
    markFramingDirty();
    setSelectedId(id);
  };

  // Meme SOURCE: create a reel from an image + a random background clip, tagged styleId='meme'.
  //
  // The image is written straight into the saved framing as this style's overlay — the same shape the bulk
  // thread builder writes a card in — so no canvas mount is needed and the reel survives a reload before it
  // is ever selected. It is OCR'd here rather than at Narrate time so the line highlights are ready the
  // moment the reel opens; generateNarration's own OCR fallback still covers a failure here.
  const createMemeReel = useCallback(async (image: { url: string; name: string; file: Blob; width: number; height: number }) => {
    if (!onAddReels) return;
    // Random background footage, exactly as handleAddRow does for an assigned-footage style. A manifest
    // failure yields a blank reel rather than no reel — the footage can be picked or shuffled afterwards.
    const segs = await fetchFootageManifest().catch(() => [] as FootageSegment[]);
    const seg = segs.length ? segs[Math.floor(Math.random() * segs.length)] : null;
    const ids = onAddReels([seg?.url]);
    const id = ids[0];
    if (!id) return;
    const overlayId = `ov-meme-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await saveOverlayImage(overlayId, image.file, image.name);
    const rect = memeOverlayRect(image.width, image.height);
    // OCR up front so the lines are paintable immediately. A failure is NOT fatal: the overlay lands without
    // ocrLines and generateNarration reads the image itself when the user narrates.
    let ocrLines: OcrTextLine[] | undefined;
    let ocrDropped: ImageOverlay['ocrDropped'];
    let covers: Partial<ImageOverlay> = {};
    try {
      const { lines, dropped } = await extractMemeLinesDetailed(image.url);
      ocrDropped = dropped.slice(0, 5);
      if (lines.length) {
        // Erase mode: the whole meme appears at once with its text under blur covers that lift per
        // line (fromImage marks every line so narration knows to emit covers, not crop steps).
        // Best-effort like OCR itself — a cover failure just leaves the classic crop reveal.
        const erase = getMemeRevealMode() === 'erase';
        ocrLines = lines.map(l => ({ ...l, enabled: true, ...(erase ? { fromImage: true } : {}) }));
        if (erase) covers = await saveCoverAtlas(await buildMemeCoverAssets(image.url, lines) ?? {});
      }
    } catch (e) {
      console.error('[meme ocr]', e);
    }
    const overlay: Omit<ImageOverlay, 'src' | 'audioSrc' | 'coverSrc'> = {
      id: overlayId, name: MEME_OVERLAY_NAME, ...rect, start: 0, end: 3600, ocrLines, ocrDropped, ...covers,
    };
    setFramingMap(prev => ({ ...prev, [id]: { ...prev[id], styleId: 'meme', overlays: [overlay] } }));
    markFramingDirty();
    setSelectedId(id);
  }, [onAddReels, setFramingMap, markFramingDirty]);

  // Swap a meme reel's image. Goes through the MOUNTED canvas (this only runs for the selected reel, whose
  // canvas is the one on screen) so the live overlay list is the thing updated — writing to framingMap alone
  // would be invisible until a remount, and switching away would snapshot the stale live list back over it.
  //
  // Any existing narration is DROPPED, not carried: the reveal steps and the audio are indexed to the old
  // image's OCR lines, so keeping them would un-crop to the wrong places and read text that isn't there.
  // Add-missing-text: the armed draft (text waiting for its box). The canvas switches its overlay
  // drag into box-drawing while non-null; completing the drag calls addManualLine below.
  const [manualDraft, setManualDraft] = useState<string | null>(null);
  const addManualLine = useCallback((reelId: string, rect: { x0: number; y0: number; x1: number; y1: number }) => {
    const text = manualDraft?.trim();
    setManualDraft(null);
    if (!text) return;
    const ref = canvasRefsMap.current.get(reelId);
    const ov = ref?.getOverlays().find(o => o.name === MEME_OVERLAY_NAME);
    if (!ref || !ov) return;
    const erase = !!ov.coverPatches?.length;
    ref.updateOverlay(ov.id, { ocrLines: insertManualLine(ov.ocrLines ?? [], { text, ...rect }, { fromImage: erase }) });
    markFramingDirty();
    // Erase mode: the new line needs a cover strip, and covers are baked — rebake the image (the
    // reapply path re-detects and carries every manual line, including this one, back in).
    if (erase) setTimeout(() => void reapplyMemeModeRef.current(reelId), 200);
  }, [manualDraft, canvasRefsMap, markFramingDirty]);
  const reapplyMemeModeRef = useRef<(reelId: string) => Promise<void>>(async () => {});

  /** Rebake the reel's CURRENT meme image after a reveal-mode change: its bytes live in IndexedDB
      under the overlay id, so it re-enters replaceMemeImage exactly like a fresh pick — same OCR,
      same cover build, same narration-clearing semantics. */
  const reapplyMemeMode = useCallback(async (reelId: string) => {
    const ov = (overlaysMap[reelId]?.length ? overlaysMap[reelId] : framingMapRef.current[reelId]?.overlays ?? [])
      .find(o => o.name === MEME_OVERLAY_NAME);
    if (!ov) return;
    const hit = await getOverlayImage(ov.id);
    if (!hit) return;
    const manual = (ov.ocrLines ?? []).filter(l => l.manual);
    void replaceMemeImageRef.current(reelId, new File([hit.blob], hit.name || 'meme.png', { type: hit.blob.type || 'image/png' }), manual);
  }, [overlaysMap]);
  const replaceMemeImageRef = useRef<(reelId: string, f: File, keepManual?: OcrTextLine[]) => Promise<void>>(async () => {});
  reapplyMemeModeRef.current = reapplyMemeMode;

  // Ref-bridged call to shuffleReelFootage (defined LATER in the file): the no-canvas image-add path
  // needs to assign footage AFTER its framing save commits — the assignment guard (canReassignFootage)
  // only allows a blank reel once its style card exists in framingMap, so both the closure and the
  // timing must be fresh. Reassigned every render; invoked on a short delay so the save has rendered.
  const autoFootageRef = useRef<(id: string) => void>(() => {});

  const replaceMemeImage = useCallback(async (reelId: string, file: File, keepManual?: OcrTextLine[]) => {
    const ref = canvasRefsMap.current.get(reelId);
    const check = await checkMemeImage(file);
    if (check.problem || !check.url) return;   // the flyout already surfaced the reason
    const overlayId = `ov-meme-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await saveOverlayImage(overlayId, file, file.name);
    let ocrLines: OcrTextLine[] | undefined;
    let ocrDropped: ImageOverlay['ocrDropped'];
    let covers: Partial<ImageOverlay> = {};
    try {
      const erase = getMemeRevealMode() === 'erase';
      const { lines, dropped } = await extractMemeLinesDetailed(check.url);
      ocrDropped = dropped.slice(0, 5);
      ocrLines = lines.length ? lines.map(l => ({ ...l, enabled: true, ...(erase ? { fromImage: true } : {}) })) : undefined;
      // A rebake (mode switch, manual-line add) re-detects from the SAME image — the caller passes the
      // manual lines so they survive; a genuinely new image passes none (old boxes are meaningless).
      for (const m of keepManual ?? []) {
        ocrLines = insertManualLine(ocrLines ?? [], m, { fromImage: erase });
      }
      const coverSource = ocrLines?.length ? ocrLines : undefined;
      if (erase && coverSource) covers = await saveCoverAtlas(await buildMemeCoverAssets(check.url, coverSource) ?? {});
    } catch (e) {
      console.error('[meme ocr]', e);
    }
    const rect = memeOverlayRect(check.width ?? 1, check.height ?? 1);
    if (ref) {
      // Mounted reel: swap on the LIVE canvas. Remove the old one FIRST (which GCs its image +
      // narration blobs), then add the new.
      const prevOverlay = ref.getOverlays().find(o => o.name === MEME_OVERLAY_NAME);
      if (prevOverlay) ref.removeOverlay(prevOverlay.id);
      ref.addImageOverlay(overlayId, check.url, MEME_OVERLAY_NAME);
      // addImageOverlay commits inside img.onload, so the lines/rect attach via a short retry loop — the
      // same shape addRedditCard uses for the identical race.
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(r => setTimeout(r, 150));
        canvasRefsMap.current.get(reelId)?.updateOverlay(overlayId, { ocrLines, ocrDropped, ...covers, ...rect, start: 0, end: 3600 });
      }
    } else {
      // NO canvas — a video-less reel never mounts one (the exact case a blank 'Add reel' reel whose
      // footage assignment failed lands in). This used to be a SILENT dead end: the flyout accepted the
      // image, checked it, handed it over, and nothing happened. Write the overlay straight into the
      // saved framing instead — the same no-mount path createMemeReel and the bulk builder use — after
      // GC'ing any previous meme overlay's blobs (image, narration, cover atlas).
      setFramingMap(prev => {
        const f = prev[reelId] ?? {};
        const old = (f.overlays ?? []).filter(o => o.name === MEME_OVERLAY_NAME);
        for (const o of old) {
          void deleteOverlayImage(o.id);
          if (o.audioId) void deleteOverlayImage(o.audioId);
          if (o.coverAtlasId) void deleteOverlayImage(o.coverAtlasId);
        }
        const kept = (f.overlays ?? []).filter(o => o.name !== MEME_OVERLAY_NAME);
        const overlay: Omit<ImageOverlay, 'src' | 'audioSrc' | 'coverSrc'> = {
          id: overlayId, name: MEME_OVERLAY_NAME, ...rect, start: 0, end: 3600, ocrLines, ocrDropped, ...covers,
        };
        return { ...prev, [reelId]: { ...f, styleId: 'meme', overlays: [overlay, ...kept] } };
      });
      // A blank reel was un-shuffleable until this save (canReassignFootage requires the style card),
      // which is HOW a reel ends up video-less in the first place — so finish the job: give it footage,
      // which mounts the canvas, which displays the image that was just saved.
      setTimeout(() => autoFootageRef.current(reelId), 150);
    }
    markFramingDirty();
  }, [canvasRefsMap, markFramingDirty, setFramingMap]);
  replaceMemeImageRef.current = replaceMemeImage;

  // Bulk build: turn a set of imported threads (each with its picked comments/paragraphs) into reels.
  // Each reel gets random footage + its Reddit card written straight into the saved framing +
  // IndexedDB — no canvas mount needed, so it scales to many reels at once. The card appears when
  // the reel is selected (or Download All cycles it); narration stays a per-reel/batch step.
  // Returns { built, failed, builtUrls, reelIdByKey }. `built` = reels we attempted to frame (fresh slots
  // that fit the reel cap + reused reels), so built < threads.length only when the grid is full (callers
  // must NOT treat the surplus as done). `failed` = reels whose card render threw (the reel exists; its card
  // can be re-imported). `reelIdByKey` maps canonicalThreadKey → reel id for the reels that FRAMED
  // SUCCESSFULLY — the bulk builder stamps builtSig/builtReelId only for these, so a failed or cap-truncated
  // thread stays buildable. A thread carrying `replaceReelId` whose reel still exists is REBUILT in place
  // (its existing reel's card is overwritten, footage/music kept) instead of spawning a duplicate reel.
  // Deliberately does NOT throw on partial failure — callers need the counts to reconcile their state
  // (the Scout buffer keeps unbuilt entries; the bulk builder keeps selections + shows the error).
  const buildReelsFromThreads = useCallback(async (threads: Array<{
    url: string; post: ImportedRedditPost; comments: ImportedRedditComment[];
    selectedComments: number[]; selectedParas: number[]; edits?: RedditThreadEdits; replaceReelId?: string;
  }>): Promise<{ built: number; failed: number; builtUrls: string[]; reelIdByKey: Record<string, string> }> => {
    // cardName is this style's narratable overlay. The bulk builder only ever runs for a style that HAS one
    // (it's the thread-card builder), so a null here means it was wired to a style it doesn't belong to —
    // bail rather than write a nameless overlay that nothing downstream could find again.
    const cardName = primaryOverlayName;
    if (!onAddReels || !threads.length || !cardName) return { built: 0, failed: 0, builtUrls: [], reelIdByKey: {} };
    const segs = await fetchFootageManifest().catch(() => [] as FootageSegment[]);
    const rand = () => (segs.length ? segs[Math.floor(Math.random() * segs.length)].url : undefined);
    // REBUILD vs. fresh: a thread whose prior reel still exists overwrites it in place (no new slot, footage
    // kept); the rest get new slots. Existence is checked against LIVE entries — the source of truth — since
    // a single-reel delete drops the entry without pruning framingMap, so its id may linger there.
    const liveIds = new Set(entriesRef.current.map(e => e.id));
    const reuse: typeof threads = [];
    const fresh: typeof threads = [];
    for (const t of threads) (t.replaceReelId && liveIds.has(t.replaceReelId) ? reuse : fresh).push(t);
    // Fresh threads take new slots (reel cap may truncate → freshIds.length ≤ fresh.length); reused threads
    // keep their own id. `jobs` is every reel we'll actually frame, paired with its id.
    // keepExisting when we're reusing reels this batch: else addReels' "replace the sole blank reel"
    // shortcut could consume a reuse target that happens to be blank (no footage), destroying it.
    const freshIds = onAddReels(fresh.map(() => rand()), reuse.length ? { keepExisting: true } : undefined);
    const jobs: Array<{ t: (typeof threads)[number]; reelId: string; isReuse: boolean }> = [
      ...reuse.map(t => ({ t, reelId: t.replaceReelId!, isReuse: true })),
      ...freshIds.map((reelId, i) => ({ t: fresh[i], reelId, isReuse: false })),
    ];
    // allSettled: one reel's card-render failure (e.g. canvas.toBlob → null on iOS/Safari size limits) must
    // not abort its siblings' framing writes, the tail below, or their ledger marks.
    const results = await Promise.allSettled(jobs.map(async ({ t, reelId, isReuse }, i) => {
      // Apply the Pick-stage text edits (comment keys are depth-0 space; t.comments is the full tree, so
      // remap depth-0→full first — identical to the copy paths). Empty/absent edits = identity.
      const eff = applyThreadEdits(t.post, t.comments, remapCommentEdits(t.comments, t.edits));
      const data = buildRedditCardData(eff.post, eff.comments, new Set(t.selectedComments), new Set(t.selectedParas));
      const card = await renderRedditCard(data);
      const postAuthor = data.user.name.replace(/^u\//, '');
      const blockAuthors = [postAuthor, postAuthor, ...data.comments.map(c => c.user.name.replace(/^u\//, ''))];
      const { ocrLines, rect } = cardOverlayLayout(card.lines, { w: card.width, h: card.height }, blockAuthors, activeStyle.voiceCast);
      const overlayId = `ov-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`;
      await saveOverlayImage(overlayId, card.blob, 'reddit-card.png');
      const covers = await saveCoverAtlas(card);
      const overlay: Omit<ImageOverlay, 'src' | 'audioSrc' | 'coverSrc'> = { id: overlayId, name: cardName, ...rect, start: 0, end: 3600, ocrLines, blockAuthors, dwells: card.dwells, ...covers };
      // On a rebuild-in-place, capture the reel's PREVIOUS overlays BEFORE overwriting. Base this on the LIVE
      // canvas when the reel is mounted — framingMap lags the displayed reel (a card narrated since its last
      // snapshot carries its audioId only on the live overlay), so trusting framingMap alone would orphan the
      // narration WAV — else on framingMap (accurate for an unmounted reel, snapshotted on switch-away). Only
      // the card (name === cardName) is replaced; user-added overlays (uploaded images) are KEPT.
      const reuseRef = isReuse ? canvasRefsMap.current.get(reelId) : undefined;
      const prevOverlays: ImageOverlay[] = isReuse ? (reuseRef?.getOverlays() ?? framingMapRef.current[reelId]?.overlays ?? []) : [];
      // Strip runtime-only fields (src/audioSrc are object URLs that don't survive a reload) before these go
      // back into framingMap — matches how getFraming() persists overlays.
      const keptOverlays = prevOverlays.filter(o => o.name !== cardName && o.id !== overlayId).map(({ src: _src, audioSrc: _audioSrc, coverSrc: _coverSrc, ...o }) => o);
      threadCacheRef.current.set(reelId, { url: t.url, post: t.post, comments: t.comments });   // url-tagged so copy skips the re-import ONLY while the thread is unchanged
      // Store the comment selection in DEPTH-0 space (the flyout — the sole reader of redditThread.comments
      // — restores it onto its depth-0-filtered list; storing full-tree indices would mis-highlight for
      // reply-heavy threads). Card + copy are unaffected (both use t.selectedComments / edits directly).
      // Rebuild swaps the card overlay (dropping its stale narration — the text changed) but spreads
      // prev[reelId] so music/other framing survive, and re-appends any kept user overlays.
      // styleId tags the reel with the workspace that built it. Written in the SAME framingMap update as the
      // card so it rides along with real framing — a styleId-only framing would read as "restore this saved
      // framing" to the canvas, which then skips its trim/zoom init (see handleAddRow).
      const selDepth0 = t.selectedComments.map(fi => depth0IndexOf(t.comments, fi)).filter((k): k is number => k != null);
      setFramingMap(prev => ({ ...prev, [reelId]: { ...prev[reelId], styleId: activeStyleId, overlays: [overlay, ...keptOverlays], redditThread: { url: t.url, comments: selDepth0, paras: t.selectedParas, edits: hasThreadEdits(t.edits) ? t.edits : undefined } } }));
      if (isReuse) {
        // GC only the OLD card's blobs (its image + narration audio) — never a kept user overlay's blob.
        for (const po of prevOverlays) {
          if (po.name === cardName && po.id !== overlayId) {
            void deleteOverlayImage(po.id);
            if (po.audioId) void deleteOverlayImage(po.audioId);
            if (po.coverAtlasId) void deleteOverlayImage(po.coverAtlasId);
          }
        }
        // A mounted reel seeds its overlays exactly once, so the setFramingMap above never reaches its live
        // canvas — the on-screen card, the export, and the autosaved framing would all keep the OLD card.
        // Push the rebuilt card straight into the live canvas (no-op when this reel isn't the mounted one);
        // replaceRedditCard preserves the reel's user overlays too. Optional-called: it's implemented by
        // RedditCanvas only, and a rebuild target is by definition a Reddit reel.
        reuseRef?.replaceRedditCard?.(overlay);
      }
      // Shared no-repeat ledger — marked HERE, per reel, only after this reel actually framed: threads
      // truncated by the reel cap (addReels slices at MAX_REELS) or whose card failed to render must NOT
      // be recorded 'used' (§4.4: skipped ≠ decided), and one sibling's failure must not drop the others'
      // marks. Best-effort/fire-and-forget — a ledger blip never breaks building.
      void markRedditUsed(t.url, t.post.title);
      return { key: canonicalThreadKey(t.url), reelId };
    }));
    markFramingDirty();
    if (jobs[0]) setSelectedId(jobs[0].reelId);
    const failed = results.filter(r => r.status === 'rejected').length;
    // reelIdByKey: only the reels that framed successfully (a failed render left the old/blank card, so its
    // thread must re-arm). builtUrls: every reel that now exists (incl. failed-render blanks) — the Scout
    // buffer releases exactly these (release-at-build: presence in the builder isn't reload-durable, a reel is).
    const reelIdByKey: Record<string, string> = {};
    for (const res of results) if (res.status === 'fulfilled') reelIdByKey[res.value.key] = res.value.reelId;
    return { built: jobs.length, failed, builtUrls: jobs.map(j => j.t.url), reelIdByKey };
    // primaryOverlayName + voiceCast are read at build time (the card's name and its cast), so they belong
    // here — a captured stale copy would name the overlay something the rest of the shell no longer looks for.
  }, [onAddReels, setFramingMap, markFramingDirty, activeStyleId, primaryOverlayName, activeStyle.voiceCast]);

  // Destructive-clear confirm. 'reels' = the rail's "Delete all reels" (reels only — imported threads are
  // KEPT so a built thread can rebuild after its reel is deleted); 'pipeline' = the pipeline view's "Clear
  // pipeline" (reels AND the Import & pick node's imported threads). null = closed.
  const [confirmClear, setConfirmClear] = useState<null | 'reels' | 'pipeline'>(null);
  // Bumped when the user confirms "Clear pipeline" — the always-mounted BulkBuilder watches it and wipes its
  // imported/picked threads (they live in the child's own state + localStorage, out of reach from here).
  const [bulkClearSignal, setBulkClearSignal] = useState(0);
  const hasReelContent = entries.length > 1
    || (!!entries[0] && !!(entries[0].url?.trim() || entries[0].videoUrl || entries[0].localVideoSrc || entries[0].caption?.trim()));
  // Any export in flight — every export button disables while one runs, since they share the reel
  // canvases and only one recording can run at a time.
  // Includes batchOp so a batch generate (which cycles selectedId + mutates each canvas) disables every
  // export/delete control — otherwise a single-reel Download recorded mid-batch yields a broken MP4, and
  // Delete-all mid-batch wipes the grid while the batch is still writing framing. (At batch entry batchOp
  // is still null, so this never self-locks the batch functions' own guards.)
  const exportBusy = downloadingOne || isDownloadingAll || !!batchOp;

  // Wait until reel `id`'s canvas has mounted (after the swap fade) and its video is ready enough to export.
  const waitForReelReady = useCallback(async (id: string, timeoutMs = 15000): Promise<TikTokCanvasRef | null> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ref = canvasRefsMap.current.get(id);
      const video = ref?.getVideoElement();
      // Export-ready = the canvas is mounted and its <video> has a src. A deferred element only pulls
      // metadata (lib/videoPreload), so we must NOT wait on readyState; export fetches the file bytes +
      // reads dimensions from the demux itself, so it only needs the src (the URL) resolved.
      if (ref && video && (video.src || video.currentSrc)) return ref;
      await new Promise(r => setTimeout(r, 80));
    }
    return canvasRefsMap.current.get(id) ?? null;
  }, [canvasRefsMap]);

  // Wait until reel `id`'s canvas has mounted AND its overlay `overlayId` has re-hydrated its image blob
  // (object URL) from IndexedDB — narration reads the overlay's pixels, so it can't run before then.
  const waitForOverlay = useCallback(async (id: string, overlayId: string, timeoutMs = 15000): Promise<TikTokCanvasRef | null> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ref = canvasRefsMap.current.get(id);
      if (ref && ref.getOverlays().find(o => o.id === overlayId)?.src) return ref;
      await new Promise(r => setTimeout(r, 100));
    }
    return canvasRefsMap.current.get(id) ?? null;
  }, [canvasRefsMap]);

  const downloadAllReels = useCallback(async () => {
    if (isDownloadingAll || downloadingOne) return;
    const toDownload = entries.filter(e => !e.loading
      && (e.localVideoSrc || e.videoUrl || (e.data && !(e.data.images && e.data.images.length > 0))));
    if (toDownload.length === 0) return;
    const original = selectedId;
    // Export in strip/number order (FIFO) so the files come out numbered 1→N. Only the displayed reel is
    // mounted (virtualized), so we flip each reel on-screen (setSelectedId) and waitForReelReady before
    // exporting it; each reel's crop/pan/zoom is restored from framingMap on that mount.
    const ordered = toDownload;
    // One dated folder for the whole batch (filesystem-safe, no colons): YYYY-MM-DD_HH-MM-SS.
    const now = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const folder = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}_${p2(now.getHours())}-${p2(now.getMinutes())}-${p2(now.getSeconds())}`;
    setIsDownloadingAll(true);
    setDownloadNotice(null);
    setDownloadProgress({ done: 0, total: ordered.length });
    // Collect every reel's export as bytes (in number order), then bundle into ONE zip named the folder,
    // with each file nested under `<folder>/` so it extracts to a single dated folder.
    const files: Record<string, Uint8Array> = {};
    let omitted = 0;              // reels that never rendered (canvas not ready, or export failed/empty)
    let stoppedForQuota = false;  // export quota ran out mid-batch
    try {
      for (let i = 0; i < ordered.length; i++) {
        const entry = ordered[i];
        // Pipeline: start downloading the NEXT reel's bytes while this one exports, so flipping to it
        // isn't gated on a fresh CDN fetch (its canvas then loads instantly from the blob cache).
        const next = ordered[i + 1];
        // Prefetch the SAME url the reel will mount + export from — activeVideoSrc resolves data-first
        // (data ? bestVideoUrl(data) : videoUrl), so this must match or the prefetch warms the wrong key
        // and export re-downloads. Skip if it already has a local/downloaded blob.
        const nextSrc = next && !next.localVideoSrc && !videoBlobUrlsRef.current[next.id]
          ? (next.data ? bestVideoUrl(next.data) : (next.videoUrl ?? null))
          : null;
        if (nextSrc) void getVideoBlob(nextSrc);
        let ref = canvasRefsMap.current.get(entry.id);
        const vid = ref?.getVideoElement();
        if (!ref || !vid || vid.readyState < 2) {
          setSelectedId(entry.id);
          ref = (await waitForReelReady(entry.id)) ?? undefined;
        }
        if (ref) {
          // Each finished reel is one export (FREE_TIER_PLAN.md), charged once the canvas is
          // actually ready — keyed by entry, so a failed export retries free and a spent quota
          // ends the batch (whatever exported before the stop still zips below).
          if (!(await exportGuard.consumeOne(`reel:${entry.id}`))) { stoppedForQuota = true; break; }
          try {
            const blob = await ref.exportBlob();
            if (blob) {
              const reelNo = entries.findIndex(x => x.id === entry.id) + 1;
              // Name from the generated YouTube title if present, else the caption.
              const rawName = framingMapRef.current[entry.id]?.ytTitle || entry.caption || '';
              const cap = rawName.replace(/[/\\:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
              const stem = `${String(reelNo).padStart(2, '0')}_${cap || 'reel'}`;
              // Numbering is unique by construction, but a filename map silently drops an entry on a key
              // clash — so never let one reel overwrite another: suffix _2, _3, … if the name is taken.
              let name = `${stem}.mp4`;
              for (let n = 2; files[`${folder}/${name}`]; n++) name = `${stem}_${n}.mp4`;
              files[`${folder}/${name}`] = new Uint8Array(await blob.arrayBuffer());
              // Paired text file: the generated YouTube title + description if present, else blank.
              const ytTitle = framingMapRef.current[entry.id]?.ytTitle ?? '';
              const ytDesc = framingMapRef.current[entry.id]?.description ?? '';
              const txt = (ytTitle || ytDesc) ? `${ytTitle}\n\n${ytDesc}`.trim() + '\n' : '';
              files[`${folder}/${name.replace(/\.mp4$/, '.txt')}`] = new TextEncoder().encode(txt);
            } else { omitted++; }   // exportBlob returned null → nothing rendered
          } catch (err) { omitted++; console.error(`Failed to export reel ${entry.id}:`, err); }
        } else { omitted++; }       // canvas never became ready within the timeout
        setDownloadProgress(p => ({ ...p, done: i + 1 }));
      }
      if (Object.keys(files).length > 0) {
        // Store-only (level 0) — the MP4s are already compressed, so this is just fast bundling.
        // fflate loads on demand: only this export path needs it, so it stays out of the initial bundle.
        const { zip } = await import('fflate');
        const zipped = await new Promise<Uint8Array>((resolve, reject) =>
          zip(files, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data))));
        const url = URL.createObjectURL(new Blob([zipped as BlobPart], { type: 'application/zip' }));
        Object.assign(document.createElement('a'), { href: url, download: `${folder}.zip` }).click();
        URL.revokeObjectURL(url);
      }
      // Tell the user when the zip isn't the whole set (rendered count vs attempted), instead of
      // silently handing over a short zip.
      const got = Object.keys(files).length;
      // consumeOne returns false for BOTH a real quota-exhaustion and a transient quota-check failure,
      // so don't assert "limit reached" (a false paywall on a network blip) — point at the export-limit
      // chip, which shows the true remaining count, and stay accurate either way.
      if (stoppedForQuota) setDownloadNotice(`Stopped at ${got} of ${ordered.length} — check your export limit.`);
      else if (omitted > 0) setDownloadNotice(`Downloaded ${got} of ${ordered.length} — ${omitted} couldn’t be rendered.`);
    } finally {
      setSelectedId(original);   // restore the user's reel (no-op if already there)
      setReelVisible(true);
      setIsDownloadingAll(false);
    }
  }, [isDownloadingAll, downloadingOne, entries, selectedId, canvasRefsMap, waitForReelReady, exportGuard]);

  // ── Batch generate (narration / YouTube copy for every reel) ─────────────────────────────────────
  // Narrate every un-narrated Reddit reel. Narration needs the reel's canvas mounted (it reads the card
  // pixels + ocrLines off the ref), so — like Download All — we flip each reel on-screen, wait for its
  // overlay image to hydrate, generate, then snapshot the result into framingMap so it survives cycling
  // away and reload. Serial (ElevenLabs is the bottleneck) with live per-reel status and cancel.
  const batchGenerateNarration = useCallback(async () => {
    if (batchOp || exportBusy) return;
    // Client key is optional: /api/tts falls back to the server's ELEVENLABS_API_KEY. If neither exists,
    // generateNarration surfaces a clear per-reel error and the run reports how many failed.
    let apiKey = '';
    try { apiKey = (localStorage.getItem(LS_11L_KEY) ?? '').trim(); } catch { /* ignore */ }
    // A style with no narratable card overlay has nothing for this batch to target — its reels are voiced by
    // the scripted narrator instead. Guarded rather than matched loosely: `o.name === null` would silently
    // find nothing anyway, but an explicit empty target list gives the right notice instead of a confusing one.
    const targets = primaryOverlayName === null ? [] : entries.flatMap(e => {
      const ov = framingMap[e.id]?.overlays?.find(o => o.name === primaryOverlayName);
      if (!ov) return [];
      // Prefer the LIVE canvas audioId for the mounted reel — framingMap lags a reel the user just narrated
      // manually and hasn't switched away from, which would otherwise get re-narrated (wasted TTS + orphan blob).
      const liveAudioId = canvasRefsMap.current.get(e.id)?.getOverlays().find(o => o.id === ov.id)?.audioId;
      return (liveAudioId ?? ov.audioId) ? [] : [{ id: e.id, overlayId: ov.id }];
    });
    if (!targets.length) { setBatchNotice(`No un-narrated ${activeStyle.name} reels found (add some, or they’re already narrated).`); return; }
    const original = selectedId;
    batchCancelRef.current = false;
    setBatchNotice(null); setBatchOp('narration');
    setBatchProgress({ done: 0, total: targets.length, status: 'Starting…' });
    let errors = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        if (batchCancelRef.current) break;
        const { id, overlayId } = targets[i];
        setBatchProgress(p => ({ ...p, status: `Reel ${i + 1}/${targets.length}: loading…` }));
        setSelectedId(id);
        const ref = await waitForOverlay(id, overlayId);
        if (!ref || !ref.getOverlays().find(o => o.id === overlayId)?.src) {
          errors++; setBatchProgress(p => ({ ...p, done: p.done + 1 })); continue;
        }
        const err = await generateNarration(id, overlayId, apiKey, s =>
          setBatchProgress(p => ({ ...p, status: `Reel ${i + 1}/${targets.length}: ${s}` })));
        if (err) { errors++; console.error('[batch narration]', id, err); }
        else {
          // Snapshot the fresh narration so it persists once we cycle off this reel. getFraming() returns
          // null while the video is still loading (so it'd silently drop the last reel's narration) —
          // capture the narrated overlays DIRECTLY instead, stripping the runtime-only object URLs.
          const ovs = canvasRefsMap.current.get(id)?.getOverlays();
          if (ovs) setFramingMap(prev => ({ ...prev, [id]: { ...prev[id], overlays: ovs.map(({ src, audioSrc, ...o }) => o) } }));
        }
        setBatchProgress(p => ({ ...p, done: p.done + 1 }));
      }
    } finally {
      setSelectedId(original);
      markFramingDirty();
      setBatchOp(null);
      setBatchProgress(p => ({ ...p, status: '' }));
    }
    setBatchNotice(batchCancelRef.current ? 'Narration cancelled.'
      : errors ? `Narration finished — ${errors} reel${errors === 1 ? '' : 's'} failed (open them to retry).`
      : 'Narration generated for every reel. ✓');
    return { errors };   // let Run all aggregate the outcome across phases (its own setBatchNotice would else hide this)
  }, [batchOp, exportBusy, entries, framingMap, selectedId, generateNarration, waitForOverlay, canvasRefsMap, setFramingMap, markFramingDirty, primaryOverlayName, activeStyle.name]);

  // Narrate every un-narrated COMMENTARY reel that has a script. Unlike the Reddit path this needs no mounted
  // canvas (generateCommentaryNarration writes straight to framingMap), so it's a simple serial loop — the
  // ElevenLabs call is the bottleneck. Reuses the same batchOp/progress/cancel plumbing + notice.
  const batchGenerateCommentaryNarration = useCallback(async () => {
    if (batchOp || exportBusy) return { errors: 0 };
    let apiKey = '';
    try { apiKey = (localStorage.getItem(LS_11L_KEY) ?? '').trim(); } catch { /* ignore */ }
    const targets = entries.filter(e => {
      const f = framingMap[e.id];
      // EFFECTIVE style, the same rule the save uses (styleTagForSave): a reel created in this workspace
      // isn't tagged until it's saved, and reading the raw tag skipped exactly those — a just-created reel
      // with a script sat un-narrated until a save happened to land first.
      if (styleTagForSave(f, activeStyleId) !== activeStyleId) return false;
      if (!(f?.commentaryScript ?? '').trim()) return false;                    // nothing to voice yet
      // Prefer the LIVE canvas overlays for a mounted reel — framingMap lags a reel whose narration was just
      // cleared and that the user hasn't switched away from. Reading the stale map would skip it as "already
      // narrated" AFTER clearOverlayNarration deleted its audio blob, leaving a permanently silent reel.
      // Same staleness guard batchGenerateNarration uses for Reddit reels above.
      const live = canvasRefsMap.current.get(e.id)?.getOverlays();
      const intro = (live ?? f?.overlays ?? []).find(o => o.intro);
      return !((intro?.audioDuration ?? 0) > 0);                                // already narrated → skip
    });
    if (!targets.length) { setBatchNotice('No un-narrated commentary reels with a script found (add a script in the Commentary step).'); return { errors: 0 }; }
    batchCancelRef.current = false;
    setBatchNotice(null); setBatchOp('narration');
    setBatchProgress({ done: 0, total: targets.length, status: 'Starting…' });
    let errors = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        if (batchCancelRef.current) break;
        setBatchProgress(p => ({ ...p, status: `Reel ${i + 1}/${targets.length}: voicing…` }));
        const err = await generateCommentaryNarration(targets[i].id, apiKey, s =>
          setBatchProgress(p => ({ ...p, status: `Reel ${i + 1}/${targets.length}: ${s}` })));
        if (err) { errors++; console.error('[commentary narration]', targets[i].id, err); }
        setBatchProgress(p => ({ ...p, done: p.done + 1 }));
      }
    } finally {
      markFramingDirty();
      setBatchOp(null);
      setBatchProgress(p => ({ ...p, status: '' }));
    }
    setBatchNotice(batchCancelRef.current ? 'Narration cancelled.'
      : errors ? `Commentary narration finished — ${errors} reel${errors === 1 ? '' : 's'} failed (open them to retry).`
      : 'Commentary narrated for every reel. ✓');
    return { errors };
  }, [batchOp, exportBusy, entries, framingMap, generateCommentaryNarration, markFramingDirty, activeStyleId]);

  // Generate a YouTube title + description for every Reddit reel that's missing one. Pure API (re-imports
  // the thread + hits /api/description), so no canvas mount needed — runs a couple in parallel.
  const batchGenerateCopy = useCallback(async () => {
    if (batchOp || exportBusy) return;
    const targets = entries.flatMap(e => {
      const f = framingMap[e.id];
      const url = f?.redditThread?.url;
      const needTitle = !f?.ytTitle, needDesc = !f?.description;
      // Only regenerate the field(s) actually missing — never clobber a title/description the user already
      // wrote. When both are missing, only=undefined regenerates both.
      return url && (needTitle || needDesc)
        ? [{ id: e.id, url, only: needTitle && needDesc ? undefined : (needTitle ? 'title' as const : 'description' as const) }]
        : [];
    });
    if (!targets.length) { setBatchNotice('No reels need copy — they either have no Reddit thread or already have a title & description.'); return; }
    batchCancelRef.current = false;
    setBatchNotice(null); setBatchOp('copy');
    setBatchProgress({ done: 0, total: targets.length, status: '' });
    let errors = 0;
    let skippedEdits = 0;   // drift-anchored text tweaks that no longer matched their thread
    const CONCURRENCY = 2;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
      for (let i = next++; i < targets.length && !batchCancelRef.current; i = next++) {
        const { id, url, only } = targets[i];
        // Retry once (with a short backoff) — a transient rate-limit / re-import hiccup under concurrency
        // shouldn't silently leave a reel without copy.
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok && !batchCancelRef.current; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
          try {
            // Reuse the thread captured at bulk-build — /api/description only reads post.title/body +
            // comment bodies, so we skip re-importing via /api/reddit (avatars aren't read, and the native
            // transport's shared browser page serializes concurrent imports). Trust the cache ONLY when its
            // tagged url matches this reel's CURRENT url — if the reel was re-pointed to a different thread
            // (RedditFlyout) the cache is stale, so fall through to a re-import of the current url. Also
            // covers reels created before this / restored after a reload (no cache entry).
            const cached = threadCacheRef.current.get(id);
            let thread = cached && cached.url === url ? { post: cached.post, comments: cached.comments } : undefined;
            if (!thread) {
              const imp = await fetch('/api/reddit', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, skipAvatars: true }), signal: AbortSignal.timeout(240_000),
              });
              const impJson = await imp.json();
              if (!imp.ok) throw new Error(impJson.error ?? 'thread load failed');
              thread = { post: impJson.post, comments: impJson.comments ?? [] };
            }
            // The user's Pick-stage text edits apply here too — the description must describe the
            // TWEAKED thread (the one actually narrated on the card), not Reddit's original. Read the
            // edits FRESH (framingMapRef, not the targets snapshot) so a tweak made mid-batch counts.
            // remapCommentEdits: edit indices live in the flyout's depth-0-filtered universe, but THIS
            // array is unfiltered (raw import / full-tree bulk cache) — translate or the override lands
            // on the wrong comment. Drift-anchored overrides skip when content no longer matches.
            const edits = framingMapRef.current[id]?.redditThread?.edits;
            const eff = applyThreadEdits(thread.post, thread.comments, remapCommentEdits(thread.comments, edits));
            if (eff.skipped.length) skippedEdits += eff.skipped.length;
            const res = await fetch('/api/description', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url, thread: { post: eff.post, comments: eff.comments }, only }),
              signal: AbortSignal.timeout(90_000),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error ?? 'copy generation failed');
            setFramingMap(prev => ({
              ...prev,
              [id]: {
                ...prev[id],
                ...(json.title !== undefined ? { ytTitle: json.title } : {}),
                ...(json.description !== undefined ? { description: json.description } : {}),
              },
            }));
            ok = true;
          } catch (e) { if (attempt === 1) { errors++; console.error('[batch copy]', e); } }
        }
        setBatchProgress(p => ({ ...p, done: p.done + 1 }));
      }
    }));
    markFramingDirty();
    setBatchOp(null);
    const skipNote = skippedEdits ? ` (${skippedEdits} text tweak${skippedEdits === 1 ? '' : 's'} no longer matched and ${skippedEdits === 1 ? 'was' : 'were'} skipped)` : '';
    setBatchNotice(batchCancelRef.current ? 'Copy generation cancelled.'
      : errors ? `Copy finished — ${errors} reel${errors === 1 ? '' : 's'} failed.${skipNote}`
      : `Title & description generated for every reel. ✓${skipNote}`);
    return { errors };
  }, [batchOp, exportBusy, entries, framingMap, setFramingMap, markFramingDirty]);

  // ── Run all: narrate every reel → write copy for every reel → download all, in one click ─────────
  // Continue-through-failures: each phase reports its own progress + count of failures (narration/copy
  // notices, Download-All's "N couldn't be rendered"), so a couple of bad reels never abort the batch.
  // Cancellable during the narrate/copy phases (the Cancel link sets batchCancelRef); once the export
  // phase starts it runs to completion. runningAll gates the individual batch buttons but is deliberately
  // NOT folded into exportBusy — the sub-functions guard on exportBusy and would otherwise self-block.
  const [runningAll, setRunningAll] = useState(false);
  const runAll = useCallback(async () => {
    if (runningAll || batchOp || exportBusy) return;
    setRunningAll(true);
    batchCancelRef.current = false;   // clear any STALE cancel from a prior batch, else the guards below would
                                      // silently skip copy+export whenever narration takes its no-targets return.
    try {
      // Same branch runPipelineStage takes for the narrate node. Hard-coding the card batch here made
      // "Run all" a silent no-op on script-voiced reels (its targets need a card overlay) that
      // still finished with "Run all complete. ✓" — so a reel exported with no voice-over looked fine.
      const nar = activeStyle.narration === 'script'
        ? await batchGenerateCommentaryNarration()
        : await batchGenerateNarration();
      if (batchCancelRef.current) return;          // cancelled mid-narration → stop before copy
      // Run the copy phase only for a style that declares a 'copy' stage, rather than firing its
      // YouTube-worded notice mid-run for a style that has no such step.
      const cp = activeStyle.stages.some(s => s.key === 'copy') ? await batchGenerateCopy() : { errors: 0 };
      if (batchCancelRef.current) return;          // cancelled mid-copy → stop before export
      await downloadAllReels();
      // One combined summary owns the final notice, so a phase's transient message (incl. the "nothing to
      // do" no-op notices, and copy overwriting narration's failure count) never hides the real outcome.
      const parts: string[] = [];
      if (nar?.errors) parts.push(`narration ${nar.errors} failed`);
      if (cp?.errors) parts.push(`copy ${cp.errors} failed`);
      setBatchNotice(parts.length ? `Run all done — ${parts.join(', ')} (open those reels to retry).` : 'Run all complete. ✓');
    } finally {
      setRunningAll(false);
    }
    // batchGenerateCommentaryNarration + activeStyle were missing here: the callback captured the FIRST
    // render's copies, so a script-voiced workspace ran "Run all" against a stale narrator closure.
  }, [runningAll, batchOp, exportBusy, batchGenerateNarration, batchGenerateCommentaryNarration, batchGenerateCopy, downloadAllReels, activeStyle]);

  // ── Reddit Scout: approved-post buffer + panel state ──────────────────────────────────────────────
  // The buffer PERSISTS (localStorage): a Use marks the post 'used' in the permanent ledger immediately,
  // so losing the buffer on reload would orphan approved posts (used forever, never imported). Entries
  // leave the buffer only when their thread is actually PRESENT in the bulk builder (see the handoff).
  const [scoutOpen, setScoutOpen] = useState(false);
  const [scoutNewCount, setScoutNewCount] = useState(0);
  const [scoutBuffer, setScoutBuffer] = useState<ScoutCandidate[]>(() => {
    // Shape-validation + legacy migration live in the tested lib (migrateScoutBuffer).
    try { return migrateScoutBuffer(JSON.parse(localStorage.getItem('scout:buffer') ?? '[]')); }
    catch { return []; }
  });
  // Persist guards (the buffer was once lost to exactly this):
  // 1. MOUNT-ECHO / FAILED-READ CLOBBER: never write [] over storage until a NON-EMPTY buffer has been
  //    committed this mount. Value-based (not run-count) so it survives StrictMode's double effect-invoke
  //    — a persisted ref would leave the 2nd invoke "armed" and clobber anyway. A legitimate emptying
  //    (release-at-build/undo) is always preceded by a non-empty commit that sets the flag.
  // 2. TOMBSTONE: whenever we decline/replace a stored buffer with [], stash the old value under
  //    scout:buffer:prev first — including at the failed-read DIVERGENCE (state [], storage non-empty),
  //    before a later first add can overwrite it unguarded. A one-slot net beneath the ledger restore.
  const scoutSawNonEmpty = useRef(false);
  useEffect(() => {
    try {
      if (scoutBuffer.length > 0) {
        scoutSawNonEmpty.current = true;
        localStorage.setItem('scout:buffer', JSON.stringify(scoutBuffer));
        return;
      }
      const prev = localStorage.getItem('scout:buffer');
      if (prev && prev !== '[]') localStorage.setItem('scout:buffer:prev', prev);   // tombstone before any []
      if (!scoutSawNonEmpty.current) return;   // mount echo / failed read — do NOT write [] over good data
      localStorage.setItem('scout:buffer', '[]');   // genuine emptying after a real commit
    } catch { /* quota/private */ }
  }, [scoutBuffer]);
  const scoutBufferedIds = useMemo(() => new Set(scoutBuffer.map(c => c.id)), [scoutBuffer]);
  // Post ids that already have a workspace reel — excluded from a ledger restore (they're done).
  const scoutBuiltPostIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of entries) {
      const url = framingMap[e.id]?.redditThread?.url;
      const pid = url ? postIdFromUrl(url) : null;
      if (pid) ids.add(pid);
    }
    return ids;
  }, [entries, framingMap]);

  // Ids of every reel currently in the grid — the bulk builder marks a thread "built" only while the reel
  // it produced (builtReelId) is still here, so deleting that reel (or Clear pipeline) re-arms the thread.
  const existingReelIds = useMemo(() => new Set(entries.map(e => e.id)), [entries]);

  const scoutBufferAdd = useCallback((c: ScoutCandidate) => {
    setScoutBuffer(prev => (prev.some(x => x.id === c.id) ? prev : [...prev, c]));
  }, []);

  const scoutBufferRemove = useCallback((id: string) => {
    setScoutBuffer(prev => prev.filter(c => c.id !== id));
  }, []);

  // ── Scout → Import handoff. "Send N to Import" queues the approved urls for the bulk builder, which
  // auto-imports them (full comment trees — richer than anything the Scout captured). The buffer releases
  // a post only at BUILD time (release-at-build: builder threads are NOT reload-durable, a grid reel is) —
  // so a failed import, a reload before Build, or a Start-over all leave the post buffered for a clean
  // re-send (its ledger row already says 'used'; the builder dedups a re-sent thread that's still there).
  const [scoutImportQueue, setScoutImportQueue] = useState<string[] | null>(null);
  const [scoutHandoffRunning, setScoutHandoffRunning] = useState(false);
  const sendScoutToImport = useCallback((ids: string[]) => {
    const wanted = new Set(ids);
    const chosen = scoutBuffer.filter(c => wanted.has(c.id));   // preserve buffer order; ignore unknown ids
    if (!chosen.length) return;
    setScoutImportQueue(chosen.map(c => c.permalink));
    setScoutOpen(false);
    setBulkOpen(true);
  }, [scoutBuffer]);
  // Import finished (or failed): clear the running pulse and surface failures — visible even if the
  // builder was closed mid-import (its internal error line wouldn't be). queuedCount arrives per-handoff
  // (from the effect's own `urls`), so overlapping subset sends can't corrupt the failure count.
  const onScoutQueueDone = useCallback((presentUrls: string[], queuedCount: number) => {
    setScoutHandoffRunning(false);
    const failed = queuedCount - presentUrls.length;
    if (failed > 0) setBatchNotice(`${failed} approved post${failed === 1 ? '' : 's'} failed to import — still buffered in Scout for a re-send.`);
  }, []);
  // Release-at-build: exactly the threads that now HAVE a grid reel leave the buffer (tested lib fn).
  const releaseScoutForBuilt = useCallback((builtUrls: string[]) => {
    if (builtUrls.length) setScoutBuffer(prev => releaseByUrls(prev, builtUrls));
  }, []);

  // ── Bulk pipeline (stages-as-nodes) — pure status derivation lives in '@/lib/pipelineStatus' (tested) ──
  const pipelineStages = useMemo(
    () => {
      const reelStages = activeStyle.computeStages(entries, framingMap, { batchOp, batchProgress, isDownloadingAll, downloadProgress });
      // Reddit leads with a Scout SOURCE node whose status is the discovery funnel (shell-only state, not reel
      // counts) — prepended here since computeStages only covers the reel-based stages.
      if (activeStyle.id === 'reddit') {
        return [
          { key: 'scout', done: scoutBuffer.length, total: scoutBuffer.length, running: scoutImportQueue !== null || scoutHandoffRunning, statusLine: `${scoutNewCount} new · ${scoutBuffer.length} buffered` },
          ...reelStages,
        ];
      }
      return reelStages;
    },
    [activeStyle, entries, framingMap, batchOp, batchProgress, isDownloadingAll, downloadProgress, scoutBuffer.length, scoutImportQueue, scoutHandoffRunning, scoutNewCount],
  );
  // Reel count for the active style = the total on any reel-based stage (Export exists in every style).
  const pipelineTotalReels = pipelineStages.find(s => s.key === 'export')?.total ?? 0;
  const pipelineMusicId = useMemo(() => computePipelineMusicId(entries, framingMap, activeStyle.isReel), [entries, framingMap, activeStyle]);

  const applyMusicToAll = useCallback((id: string | null) => {
    if (exportBusy) return;                              // don't change a reel's music mid-export
    setFramingMap(prev => {
      const next = { ...prev };
      for (const e of entries) {
        if (activeStyle.isReel(e.id, prev)) next[e.id] = { ...prev[e.id], musicId: id ?? '' };
      }
      return next;
    });
    markFramingDirty();
  }, [entries, setFramingMap, markFramingDirty, exportBusy]);

  // Does this reel carry its style's narratable card? Used only to tell "a reel of ours that never got its
  // clip" from "an upload whose bytes are still loading" when the url is blank — see canReassignFootage.
  const hasStyleCard = useCallback((id: string) => (
    !!primaryOverlayName && (framingMap[id]?.overlays ?? []).some(o => o.name === primaryOverlayName)
  ), [framingMap, primaryOverlayName]);

  // Re-roll a fresh random library clip for every Reddit reel (clear-then-set: drop data/videoUrl + set the
  // new footage url so the auto-fetch re-resolves it). No-op without setEntries (non-workspace host).
  // Re-roll ONE reel's background footage. The bulk shuffle is a pipeline stage; this is the escape hatch
  // for a single bad clip, since Reddit reels have no footage picker (their video is assigned, not chosen).
  const shuffleReelFootage = useCallback(async (id: string) => {
    if (!setEntries || exportBusy) return;                              // don't swap footage mid-export
    const segs = await fetchFootageManifest().catch(() => [] as FootageSegment[]);
    if (!segs.length) return;
    setEntries(prev => prev.map(e => {
      if (e.id !== id) return e;
      // Same guard as the bulk shuffle: only a clip WE assigned may be replaced. This path never had one —
      // an uploaded reel was skipped, but a reel holding a pasted link had its url overwritten.
      if (!canReassignFootage({ url: e.url, hasLocalVideo: !!e.localVideoSrc, hasStyleCard: hasStyleCard(e.id) })) return e;
      const pool = segs.filter(s => s.url !== e.url);                   // exclude the current clip → always a real change
      const pick = (pool.length ? pool : segs)[Math.floor(Math.random() * (pool.length || segs.length))];
      autoFetched.current.delete(e.id);                                 // let the auto-fetch resolve the new url
      return { ...e, url: pick.url, data: null, videoUrl: undefined };
    }));
  }, [setEntries, exportBusy, hasStyleCard]);

  autoFootageRef.current = id => {
    const e = entries.find(x => x.id === id);
    if (e && !e.localVideoSrc && !(e.url ?? '').trim()) void shuffleReelFootage(id);
  };

  const shuffleAllFootage = useCallback(async () => {
    if (!setEntries || exportBusy) return;                              // don't swap footage mid-export
    const segs = await fetchFootageManifest().catch(() => [] as FootageSegment[]);
    if (!segs.length) return;
    setEntries(prev => prev.map(e => {
      // Reels of THIS style, by the style's own predicate — the old `o.name === 'Reddit thread'` test meant
      // any other style's reels were silently skipped by the bulk shuffle even when their video is exactly
      // the same interchangeable library footage.
      //
      // …but the style predicate is TAG-based, and the autosave stamps this workspace's tag on every row, so
      // on its own it selects every reel here — including one holding a pasted link, whose url this would
      // then overwrite with a random clip (a Reddit reel stores no bytes, so that link is the only pointer
      // to its video). canReassignFootage is the guard the old overlay test was accidentally providing:
      // only ever replace a video we assigned. It is STRICTER than either version — a card-less link reel
      // was reachable before this refactor too, via the single-reel shuffle below.
      if (!activeStyle.isReel(e.id, framingMap)) return e;
      if (!canReassignFootage({ url: e.url, hasLocalVideo: !!e.localVideoSrc, hasStyleCard: hasStyleCard(e.id) })) return e;
      const pool = segs.filter(s => s.url !== e.url);                   // exclude the current clip → always a real change (no same-url no-op)
      const pick = (pool.length ? pool : segs)[Math.floor(Math.random() * (pool.length || segs.length))];
      autoFetched.current.delete(e.id);                                // clear the "already fetched this url" guard so it re-resolves
      return { ...e, url: pick.url, data: null, videoUrl: undefined };
    }));
  }, [setEntries, framingMap, exportBusy, activeStyle, hasStyleCard]);

  // The reel canvas stays mounted (just hidden) in Pipeline view, so pause it on entry — otherwise a reel
  // left playing (via the timeline) keeps its video/narration/music audio looping with no visible control.
  useEffect(() => { if (pipelineView) canvasRefsMap.current.get(displayId)?.pause(); }, [pipelineView, displayId, canvasRefsMap]);

  const runPipelineStage = useCallback((key: StageKey) => {
    if (key === 'footage') void shuffleAllFootage();
    else if (key === 'narrate') void (activeStyle.narration === 'script' ? batchGenerateCommentaryNarration() : batchGenerateNarration());
    else if (key === 'copy') void batchGenerateCopy();
    else if (key === 'export') void downloadAllReels();
  }, [activeStyle, shuffleAllFootage, batchGenerateNarration, batchGenerateCommentaryNarration, batchGenerateCopy, downloadAllReels]);

  const selectedEntry = entries.find(e => e.id === selectedId) ?? entries[0];
  // Reel STYLE of the selection, from the same source of truth that routes the canvas (see the grid below).
  // Drives the rail gates — which flyouts it offers, whether it can re-roll footage, whether a blurred
  // letterbox is a thing it even has.
  // A reel created in this workspace has no tag yet (tagging happens at save), so resolve its EFFECTIVE
  // style the way the save will: untagged belongs to the workspace it is in. Reading the raw tag made a
  // brand-new commentary reel render as a Reddit one.
  const selectedStyle = getReelStyle(styleTagForSave(selectedEntry ? framingMap[selectedEntry.id] : undefined, activeStyleId));
  // Object URL for the SELECTED reel's custom thumbnail, purely so the timeline can show what plays first.
  // Created and revoked in one effect (no leak under StrictMode's double-invoke) and re-derived whenever the
  // stored still changes, so replacing or clearing a thumbnail updates the marker.
  const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(null);
  const selectedThumbId = selectedEntry ? framingMap[selectedEntry.id]?.thumbnailId : undefined;
  useEffect(() => {
    if (!selectedThumbId) { setThumbnailPreview(null); return; }
    let url = '';
    let cancelled = false;
    void getOverlayImage(selectedThumbId).then(rec => {
      if (cancelled || !rec) return;
      url = URL.createObjectURL(rec.blob);
      setThumbnailPreview(url);
    });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); setThumbnailPreview(null); };
  }, [selectedThumbId]);

  const showVideoControls = !!selectedEntry && (
    !!selectedEntry.localVideoSrc || !!selectedEntry.videoUrl || (!!selectedEntry.data && !selectedEntry.loading)
  );
  // The bottom timeline strip shows whenever it's toggled open AND either a video is loaded (the real
  // VideoControlsBar) or there's no video yet (an empty-timeline placeholder).
  const timelineStripShown = timelineOpen && !!selectedEntry;

  // canvasRefVersion forces re-derivation when refs populate
  const activeVideoRef = showVideoControls && canvasRefVersion >= 0
    ? (canvasRefsMap.current.get(selectedEntry!.id) ?? null)
    : null;

  const activeRecordingState = showVideoControls
    ? (recordingStateMap[selectedEntry!.id] ?? null)
    : null;

  // Source URL for the selected reel's video — fed to the timeline for filmstrip thumbnail extraction.
  // Byte-cache the active reel's video so export doesn't re-download the (short-lived) CDN URL — which
  // 403s once it expires. We fetch the full file through the proxy once, while the link is fresh, into a
  // blob and prefer that as the source; export then reads the blob directly instead of re-hitting the CDN.
  const [videoBlobUrls, setVideoBlobUrls] = useState<Record<string, string>>({});
  const blobFetchingRef = useRef<Set<string>>(new Set());
  // Revoke every cached blob URL on unmount — each one pins the full video bytes in memory, so
  // section-switching without this leaks the entire byte-cache every visit.
  const videoBlobUrlsRef = useRef(videoBlobUrls);
  useEffect(() => { videoBlobUrlsRef.current = videoBlobUrls; }, [videoBlobUrls]);
  useEffect(() => () => { for (const url of Object.values(videoBlobUrlsRef.current)) URL.revokeObjectURL(url); }, []);

  const activeVideoSrc = useMemo(() => {
    if (!showVideoControls) return null;
    // Prefer the in-session source (local blob → downloaded blob → the proxy stream we're already
    // playing) over videoUrl. A background store setting videoUrl mid-session must NOT flip the source,
    // which would reload the <video> and reset the user's live crop/pan/zoom/trim. videoUrl is only the
    // source on a fresh load, when data is null (auto-fetch skips already-stored reels).
    return selectedEntry!.localVideoSrc
      ?? videoBlobUrls[selectedEntry!.id]
      ?? (selectedEntry!.data ? bestVideoUrl(selectedEntry!.data) : selectedEntry!.videoUrl ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showVideoControls,
    selectedEntry?.id,
    selectedEntry?.localVideoSrc,
    selectedEntry?.videoUrl,
    selectedEntry?.data?.play,
    selectedEntry?.data?.hdplay,
    selectedEntry?.data?.wmplay,
    videoBlobUrls,
  ]);

  // Whether the SELECTED reel's stored bytes are still in flight — narrowed to a boolean because the effect
  // below depends on it, and depending on the whole set would re-run (and so cancel + restart) an in-flight
  // download once for every OTHER row whose read happens to settle.
  const selectedBytesRestoring = !!selectedEntry && bytesRestoring.has(selectedEntry.id);

  // Best-effort: download the selected link-fetched reel's bytes into a blob once it loads (uploads and
  // persisted reels are already stable, so they're skipped). If the download fails (e.g. the URL already
  // expired), we just fall back to the CDN URL and export may still 403 — but the common
  // fetch→edit→export flow caches the bytes while the link is fresh.
  useEffect(() => {
    const e = selectedEntry;
    if (!e) return;
    if (e.localVideoSrc || e.videoUrl || !e.data) return;
    // Footage reels stream from our own R2 (URLs never expire) and are large ~100MB clips — eagerly
    // full-downloading one into a blob just to view/narrate stalls the pipeline (and a batch cycling every
    // reel would download them all). Skip: footage streams via <video> and is fetched in full only at
    // export. This pre-download stays ONLY for expiring TikTok/IG/X CDN links, where caching bytes early
    // guards against the link 403-ing before export.
    if (isFootageUrl(e.url) || isFootageUrl(e.data.hdplay || e.data.play || '')) return;
    // Its stored bytes may still be coming back out of IndexedDB — downloading the same video again is
    // the exact waste persisting it was meant to end. Reachable whenever the restore rebuilt entries with
    // a CACHED `data` (getCachedVideo survives a section switch, so a re-entry into this workspace has the
    // resolved link in hand before the read finishes). A miss clears the flag and this effect re-runs.
    if (selectedBytesRestoring) return;
    if (videoBlobUrls[e.id] || blobFetchingRef.current.has(e.id)) return;
    const proxyUrl = bestVideoUrl(e.data);
    if (!proxyUrl) return;
    blobFetchingRef.current.add(e.id);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(proxyUrl);
        if (cancelled) return;
        // This is the only load a deferred LINK reel gets (footage/uploads early-return above). A dead
        // response = the TikTok/IG/X CDN URL expired — flag it so the reel goes videoFailed, which re-enables
        // the Fetch button + auto-fetch so the user can re-scrape. (Was a silent return before deferral.)
        if (!res.ok) { onHandleVideoError(e.id); return; }
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        if (cancelled) { URL.revokeObjectURL(blobUrl); return; }
        rememberUploadBytes(blobUrl, blob);   // hand the bytes to the persist effect rather than make it re-read them
        setVideoBlobUrls(prev => {
          if (prev[e.id]) { URL.revokeObjectURL(blobUrl); return prev; }
          return { ...prev, [e.id]: blobUrl };
        });
      } catch { if (!cancelled) onHandleVideoError(e.id); }
      finally { blobFetchingRef.current.delete(e.id); }
    })();
    return () => { cancelled = true; };
  }, [selectedEntry, videoBlobUrls, onHandleVideoError, rememberUploadBytes, selectedBytesRestoring]);

  // Write each reel's video bytes to IndexedDB, once per distinct blob. Two sources feed it: an uploaded
  // file's object URL, and the blob the effect above downloaded for a linked reel — the latter being what
  // makes a commentary reel self-contained, since its resolved link is a SIGNED URL that expires (the reel
  // would eventually 403 on load AND on export). Reddit's library footage is deliberately not stored: it
  // re-fetches from R2 forever and the clips are ~100 MB each.
  useEffect(() => {
    if (!setEntries) return;
    for (const e of entries) {
      if (e.mode !== 'twitter' && e.mode !== 'caption') continue;
      const isUpload = !!e.localVideoSrc?.startsWith('blob:');
      const src = isUpload ? e.localVideoSrc! : videoBlobUrls[e.id];
      if (!src) continue;
      // Untagged reels belong to the workspace they're in — resolve the style the way the autosave will.
      const styleId = styleTagForSave(framingMap[e.id], activeStyleId);
      if (!shouldPersistBytes({ styleId, isUpload })) continue;
      if (uploadedBlob.current.get(e.id) === src) continue;   // (re)persist only when the blob is new
      uploadedBlob.current.set(e.id, src);
      void persistUpload(e.id, src, e.localVideoName ?? '', { styleId, isUpload });
    }
  }, [entries, setEntries, persistUpload, videoBlobUrls, framingMap, activeStyleId]);

  // First-run / empty state: reels posting in twitter mode with no reel templates → send to the editor.
  // While templates are still loading, render blank (not the posting UI) so it doesn't flash for a frame.
  // (Caption mode doesn't use a reel template, so it's unaffected.)
  if (videoMode === 'twitter' && twitterTemplates.length === 0) {
    return twitterLoaded ? (
      <TemplatesEmptyState
        title="No reel templates yet"
        description="You need a reel template before you can make a reel. Create one in the template editor first."
        actionLabel="Go to template editor"
        onAction={() => onGoToTemplateEditor?.()}
      />
    ) : <div className="h-full w-full" />;
  }

  return (
    <div className="relative w-full flex flex-col h-full overflow-hidden">

      {/* ── Element rail (mirrors the template editor): link + caption flyouts edit the SELECTED reel,
            with undo/redo for the URL/caption edits beneath. ── */}
      {selectedEntry && !pipelineView && (
        <ElementRail
          categories={[
            { id: 'link', label: 'Video link', icon: linkGlyph, content: (
              <ReelLinkFlyout
                entry={selectedEntry}
                onUpdateField={(f, v) => recordEdit(selectedEntry.id, f, v)}
                onUpdateLocalVideo={(s, n, file, opts) => {
                  // Hand the File itself to the persist effect — it would otherwise read the whole video
                  // back through the object URL just to recover the Blob we already have.
                  if (file && s) rememberUploadBytes(s, file);
                  onUpdateLocalVideo(selectedEntry.id, s, n, opts);
                }}
                onFetch={() => onFetchVideo(selectedEntry.id)}
                onPickFootage={seg => {
                  // Replace whatever the reel currently holds (upload or link) with the picked segment:
                  // clear the local video + data, drop the auto-fetch guard so re-picking a previously
                  // used segment still fetches, then set the URL — the auto-fetch effect does the rest.
                  onUpdateLocalVideo(selectedEntry.id, '', '');
                  autoFetched.current.delete(selectedEntry.id);
                  recordEdit(selectedEntry.id, 'url', seg.url);
                  // Pre-warm the blob cache so the timeline's filmstrip (which needs the whole file)
                  // opens instantly by the time the user gets there. Same key the canvas/timeline use:
                  // bestVideoUrl(footageVideoData(url)) resolves to proxyStreamUrl(url).
                  void getVideoBlob(proxyStreamUrl(seg.url));
                }}
              />
            ) },
            // Wide enough for the shared picker's two panes (list | reading & script) — the same layout the
            // pipeline's builder uses. Narrower and the reading pane can't hold a comment.
            // Opens a CENTRED modal, not a rail flyout: the picker is the same wide two-pane surface the
            // pipeline builder uses, and the rail panel is anchored beside the rail — at this width it just
            // ran off the viewport and clipped the reading pane.
            { id: 'commentary', label: 'Commentary script', icon: scriptGlyph, width: 340, content: (
              <CommentaryScriptFlyout
                key={selectedEntry.id}
                script={framingMap[selectedEntry.id]?.commentaryScript ?? ''}
                narrated={((framingMap[selectedEntry.id]?.overlays ?? []).find(o => o.intro)?.audioDuration ?? 0) > 0}
                onScriptChange={s => {
                  setFramingMap(prev => ({ ...prev, [selectedEntry.id]: { ...prev[selectedEntry.id], commentaryScript: s || undefined } }));
                  markFramingDirty();
                }}
                onVoice={onStatus => {
                  let apiKey = '';
                  try { apiKey = (localStorage.getItem(LS_11L_KEY) ?? '').trim(); } catch { /* ignore */ }
                  return generateCommentaryNarration(selectedEntry.id, apiKey, onStatus);
                }}
              />
            ) },
            { id: 'reddit', label: 'Reddit thread', icon: redditGlyph, onOpen: () => setRedditOpen(true) },
            { id: 'meme', label: 'Meme image', icon: memeGlyph, width: 300, content: (
              <MemeImageFlyout
                key={selectedEntry.id}
                overlay={((overlaysMap[selectedEntry.id]?.length ? overlaysMap[selectedEntry.id] : framingMap[selectedEntry.id]?.overlays) ?? []).find(o => o.name === MEME_OVERLAY_NAME) ?? null}
                onReplace={file => void replaceMemeImage(selectedEntry.id, file)}
                onModeChange={() => void reapplyMemeMode(selectedEntry.id)}
                manualDraft={manualDraft}
                onArmManualLine={setManualDraft}
              />
            ) },
            { id: 'yt-copy', label: 'YouTube copy', icon: ytCopyGlyph, width: 340, content: (
              <YtCopyFlyout
                key={selectedEntry.id}
                threadUrl={framingMap[selectedEntry.id]?.redditThread?.url ?? null}
                threadEdits={framingMap[selectedEntry.id]?.redditThread?.edits}
                ytTitle={framingMap[selectedEntry.id]?.ytTitle ?? ''}
                onYtTitleChange={t => {
                  setFramingMap(prev => ({ ...prev, [selectedEntry.id]: { ...prev[selectedEntry.id], ytTitle: t || undefined } }));
                  markFramingDirty();
                }}
                description={framingMap[selectedEntry.id]?.description ?? ''}
                onDescriptionChange={d => {
                  setFramingMap(prev => ({ ...prev, [selectedEntry.id]: { ...prev[selectedEntry.id], description: d || undefined } }));
                  markFramingDirty();
                }}
              />
            ) },
            { id: 'music', label: 'Background music', icon: musicGlyph, content: (
              <div className="flex flex-col gap-0.5">
                {[null, ...BACKGROUND_TRACKS].map(t => {
                  const active = resolveMusicId(framingMap[selectedEntry.id]?.musicId) === (t?.id ?? null);
                  return (
                    <button
                      key={t?.id ?? 'none'}
                      type="button"
                      onClick={() => {
                        // '' is the explicit "No music" choice (distinct from unset, which defaults to a track).
                        setFramingMap(prev => ({ ...prev, [selectedEntry.id]: { ...prev[selectedEntry.id], musicId: t?.id ?? '' } }));
                        markFramingDirty();
                      }}
                      className={`flex items-center gap-2 px-1.5 h-8 rounded-sm text-body text-left transition-colors focus-ring ${
                        active ? 'bg-active text-fg' : 'text-fg-2 hover:text-fg hover:bg-hover'
                      }`}
                    >
                      <span className="flex-1 truncate">{t?.name ?? 'No music'}</span>
                      {active && <CheckIcon size={11} className="shrink-0" />}
                    </button>
                  );
                })}
                {resolveMusicId(framingMap[selectedEntry.id]?.musicId) && (
                  <label className="flex items-center gap-2 pt-1.5">
                    <span className="text-caption text-fg-3 shrink-0">Volume</span>
                    <input
                      type="range" min={0} max={0.5} step={0.01}
                      value={framingMap[selectedEntry.id]?.musicVolume ?? DEFAULT_MUSIC_VOLUME}
                      onChange={e => {
                        const v = Number(e.target.value);
                        setFramingMap(prev => ({ ...prev, [selectedEntry.id]: { ...prev[selectedEntry.id], musicVolume: v } }));
                        markFramingDirty();
                      }}
                      className="flex-1 min-w-0 accent-[var(--color-accent,#46d160)]"
                    />
                    <span className="text-caption text-fg-2 w-9 text-right">
                      {Math.round((framingMap[selectedEntry.id]?.musicVolume ?? DEFAULT_MUSIC_VOLUME) * 100)}%
                    </span>
                  </label>
                )}
                <span className="text-caption text-fg-3 pt-1">Loops quietly under the narration — in preview and in the export.</span>
              </div>
            ) },
            { id: 'narrate', label: 'Narration', icon: micGlyph, content: (
              <NarrateFlyout
                overlays={overlaysMap[selectedEntry.id] ?? []}
                scripted={selectedStyle.narration === 'script'}
                primaryOverlayName={selectedStyle.primaryOverlayName}
                voiceCast={selectedStyle.voiceCast}
                voices={narrationVoices}
                onVoicesChange={setNarrationVoices}
                brushId={voiceBrushId}
                onBrushChange={setVoiceBrushId}
                voiceColors={narrationVoiceColors}
                speed={narrationSpeed}
                onSpeedChange={setNarrationSpeed}
                voiceGains={voiceGains}
                onVoiceGainsChange={setVoiceGains}
                onGenerate={(overlayId, apiKey, onStatus) => generateNarration(selectedEntry.id, overlayId, apiKey, onStatus)}
                onClearNarration={overlayId => canvasRefsMap.current.get(selectedEntry.id)?.clearOverlayNarration(overlayId)}
                onShuffleVoices={overlayId => shuffleCardVoices(selectedEntry.id, overlayId)}
              />
            ) },
          // Each style keeps only its own source flyouts (ReelStyle.railSections): a Reddit reel's video IS
          // background footage, assigned automatically, so a link/upload input is the wrong affordance for
          // it; commentary is the reverse — the uploaded or linked video is the whole reel, and it has no
          // thread or YouTube-copy step. Dropping the thread flyout from a commentary reel also closes the
          // last path by which one could acquire a user-added image overlay (its "Add to reel" calls
          // addRedditCard → addImageOverlay), which the Add-image and Narrate gates already block.
          //
          // ALLOW-list, not a deny-list: a section absent from every style's railSections is hidden
          // everywhere, so adding a new style-specific flyout can't leak it into the styles that predate it.
          ].filter(c => !RAIL_STYLE_SECTIONS.has(c.id) || selectedStyle.railSections.includes(c.id))}
          extraIsland={(
            // Adjust island: per-reel framing/trim controls as a rail-style icon-button column.
            <ReelAdjustFlyout
              zoom={getVideoZoom(selectedEntry.id)}
              onZoom={z => applyVideoZoom(selectedEntry.id, z)}
              onResetTrim={() => canvasRefsMap.current.get(selectedEntry.id)?.resetTrim()}
              onResetBox={() => canvasRefsMap.current.get(selectedEntry.id)?.resetBox()}
              onCenter={() => canvasRefsMap.current.get(selectedEntry.id)?.centerBox()}
              timelineOpen={timelineOpen}
              onToggleTimeline={() => setTimelineOpen(o => !o)}
              // Image overlays are a Reddit-card concept: a commentary reel voices only its intro, so an
              // image layer added here could never be narrated (and its reveal would just be silent chrome).
              // Hidden rather than disabled — same as the blur toggle below.
              // Both styles: YouTube offers no thumbnail upload for ANY Short, so the held-frame trick is
              // as useful on a commentary reel as on a Reddit one. Both exporters honour the lead.
              thumbnailName={framingMap[selectedEntry.id]?.thumbnailName}
              onPickThumbnail={file => void setReelThumbnail(selectedEntry.id, file)}
              onClearThumbnail={() => clearReelThumbnail(selectedEntry.id)}
              // A style whose clip is ASSIGNED has no footage picker, so this is the way to change it. A
              // style that brings its own video has nothing to re-roll.
              onShuffleFootage={selectedStyle.assignsFootage ? () => void shuffleReelFootage(selectedEntry.id) : undefined}
              // Blurred letterbox fill — only for a style that HAS visible letterbox (ReelStyle.supportsBgBlur).
              bgBlur={selectedStyle.supportsBgBlur ? (framingMap[selectedEntry.id]?.bgBlur ?? false) : undefined}
              onToggleBgBlur={
                selectedStyle.supportsBgBlur
                  ? () => {
                      setFramingMap(prev => ({ ...prev, [selectedEntry.id]: { ...prev[selectedEntry.id], bgBlur: !prev[selectedEntry.id]?.bgBlur } }));
                      markFramingDirty();
                    }
                  : undefined
              }
              onRemoveVideo={() => {
                // Erase the loaded clip + its link → showVideoControls flips false, so the island
                // collapses back out. Clearing the URL too prevents an auto re-fetch.
                if (selectedEntry.localVideoSrc) URL.revokeObjectURL(selectedEntry.localVideoSrc);
                onUpdateLocalVideo(selectedEntry.id, '', '');
                recordEdit(selectedEntry.id, 'url', '');
                setTimelineOpen(false);   // close the timeline too — no video left to edit
              }}
            />
          )}
          extraIslandOpen={showVideoControls}
          onUndo={mergedUndo}
          onRedo={mergedRedo}
          canUndo={mergedCanUndo}
          canRedo={mergedCanRedo}
          bottomSlot={onDeleteAllReels && hasReelContent ? (
            // Its own rail island (matches the undo/redo card): a size-9 rounded-xl icon button,
            // danger-tinted, so it reads as a sibling of the rail's other action buttons.
            <div className="w-full flex flex-col items-center gap-1 rounded-2xl bg-surface-1 border border-line shadow-2 p-1.5">
              <button
                type="button"
                title="Delete all reels"
                aria-label="Delete all reels"
                disabled={exportBusy || isDownloadingAll}
                onClick={() => setConfirmClear('reels')}
                className="flex items-center justify-center size-9 rounded-xl text-danger-text hover:bg-danger-tint transition-colors focus-ring disabled:opacity-35 disabled:cursor-not-allowed"
              >
                <TrashIcon size={16} />
              </button>
            </div>
          ) : undefined}
        />
      )}

      {/* ── Toolbar (mirrors the Carousels toolbar: zoom · centred template dropdown · autosave + download) ── */}
      <div ref={toolbarRef} className="relative flex items-center justify-between gap-4 px-4 border-b border-line shrink-0 bg-surface-1" style={{ height: HEADER_H }}>
        {/* Left slot: the Canvas ⇄ Sheet toggle when the host provides one; otherwise an empty
            spacer keeping justify-between honest (autosave + download stay pinned right even when
            the absolutely-centred template dropdown is the only other child). Mirrors Carousels. */}
        <div className="flex items-center gap-2">
          {onGoHome && (
            <button type="button" onClick={onGoHome} title="Back to home"
              className="focus-ring flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-caption text-fg-3 transition-colors hover:text-fg hover:border-line-strong">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" />
              </svg>
              Home
            </button>
          )}
          {viewToggle}
          {/* Canvas ⇄ Pipeline (bulk stages-as-nodes) view switch. Reddit only: its pipeline is a real
              multi-stage batch flow (scout → import → footage → narrate → copy → export), whereas a
              commentary reel is made one at a time on the canvas, so a pipeline over it is empty ceremony. */}
          {hasPipeline && (
            <div className="flex items-center rounded-full border border-line p-0.5">
              {(['canvas', 'pipeline'] as const).map(m => (
                <button key={m} type="button" onClick={() => setPipelineView(m === 'pipeline')}
                  className={`focus-ring rounded-full px-2.5 py-1 text-caption capitalize transition-colors ${
                    (m === 'pipeline') === pipelineView ? 'bg-active text-fg font-medium' : 'text-fg-3 hover:text-fg'}`}>
                  {m}
                </button>
              ))}
            </div>
          )}
          <ThemeToggle />
        </div>

        {/* Right: autosave + export quota + download (styled like Carousels). */}
        <div className="flex items-center gap-3">
          {/* Sustained load failure: the persistence guard keeps `loaded` false so autosave can't
              overwrite the saved grid with an empty one — but that also means edits made now won't
              save. Say so and offer a retry instead of a silently-empty, silently-unsaved canvas. */}
          {reelsLoadError && (
            <span className="flex items-center gap-1.5 text-caption text-danger-text whitespace-nowrap">
              Couldn&apos;t load your reels — edits won&apos;t save yet
              <button type="button" onClick={retryReelsLoad} className="underline underline-offset-2 hover:text-fg focus-ring rounded-xs">Retry</button>
            </span>
          )}
          {downloadNotice && (
            <span className="flex items-center gap-1.5 text-caption text-fg-2 whitespace-nowrap">
              {downloadNotice}
              <button type="button" onClick={() => setDownloadNotice(null)} aria-label="Dismiss" className="text-fg-4 hover:text-fg focus-ring rounded-xs">×</button>
            </span>
          )}
          {/* Live batch-generation status (detailed per-reel step) and post-run summary. */}
          {batchOp && (
            <span className="flex items-center gap-1.5 text-caption text-fg-2 whitespace-nowrap max-w-[440px] truncate" title={batchProgress.status}>
              {batchProgress.status || `${batchProgress.done}/${batchProgress.total}`}
            </span>
          )}
          {batchNotice && (
            <span className="flex items-center gap-1.5 text-caption text-fg-2 whitespace-nowrap">
              {batchNotice}
              <button type="button" onClick={() => setBatchNotice(null)} aria-label="Dismiss" className="text-fg-4 hover:text-fg focus-ring rounded-xs">×</button>
            </span>
          )}
          {reelNotice && (
            /* No whitespace-nowrap here (unlike its siblings): a rejected-file message is a sentence, not a count. */
            <span className="flex items-center gap-1.5 text-caption text-fg-2 max-w-[420px]">
              {reelNotice}
              <button type="button" onClick={() => setReelNotice(null)} aria-label="Dismiss" className="text-fg-4 hover:text-fg focus-ring rounded-xs">×</button>
            </span>
          )}
          <AutosaveChip state={reelSaveState} />
          {/* Commentary's only way to create a reel. It used to live in the pipeline's Upload stage, which
              that style no longer has. Gated on the style OWNING this source, not on it lacking a pipeline —
              those happened to coincide for two styles and would not for a third. */}
          {sourceLabel && (
            <Button variant="primary" size="sm" onClick={() => setSourceOpen(true)}>{sourceLabel}</Button>
          )}
          {/* Download just the on-screen reel — keeps its live crop/pan/zoom. (Canvas view only.) */}
          {showVideoControls && selectedEntry && !pipelineView && (
            <Button
              variant="primary"
              size="sm"
              loading={downloadingOne}
              onClick={async () => {
                if (exportBusy) return;
                const id = selectedEntry.id;
                setDownloadingOne(true);
                // Surface a failure in the toolbar: the canvas status only shows WHILE recording, so an
                // export that throws (e.g. the clip fetch 502s / a link URL expired) would otherwise fail
                // completely silently — no file, no message. setDownloadNotice paints a dismissible line.
                try { await exportGuard.guard(`reel:${id}`, () => canvasRefsMap.current.get(id)?.startDownload()); }
                catch (err) { console.error('[reel download]', err); setDownloadNotice(err instanceof Error ? err.message : 'Export failed — please try again.'); }
                finally { setDownloadingOne(false); }
              }}
              disabled={exportBusy}
              leadingIcon={<DownloadIcon size={13} />}
              className="rounded-full"
            >
              Download
            </Button>
          )}
          {onAddReels && !pipelineView && hasThreadSource && (
            <Button variant="secondary" size="sm" onClick={() => setBulkOpen(true)} className="rounded-full">
              Bulk build
            </Button>
          )}
          {/* One-click pipeline (Run all) + the individual batch steps, with live progress + cancel. Run all
              chains narrate → copy → download; each step reports its own count. Shown once this workspace has
              at least one reel carrying its style's narratable card — there's nothing to batch before that. */}
          {hasPipeline && !!primaryOverlayName && entries.some(e => framingMap[e.id]?.overlays?.some(o => o.name === primaryOverlayName)) && !pipelineView && (
            <>
              <Button variant="primary" size="sm" onClick={() => void runAll()} disabled={exportBusy || runningAll} className="rounded-full">
                {runningAll
                  ? (batchOp === 'narration' ? `Narrating ${batchProgress.done}/${batchProgress.total}…`
                    : batchOp === 'copy' ? `Writing copy ${batchProgress.done}/${batchProgress.total}…`
                    : isDownloadingAll ? `Exporting ${downloadProgress.done}/${downloadProgress.total}…`
                    : 'Running…')
                  : 'Run all'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void batchGenerateCopy()} disabled={exportBusy || !!batchOp || runningAll} className="rounded-full">
                {batchOp === 'copy' && !runningAll ? `Writing copy ${batchProgress.done}/${batchProgress.total}…` : 'Generate copy (all)'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void batchGenerateNarration()} disabled={exportBusy || !!batchOp || runningAll} className="rounded-full">
                {batchOp === 'narration' && !runningAll ? `Narrating ${batchProgress.done}/${batchProgress.total}…` : 'Generate narration (all)'}
              </Button>
              {/* Cancel is only meaningful in the narrate/copy phases (batchOp set); once Run all reaches the
                  export phase it runs to completion — show a static hint so the control slot doesn't just vanish. */}
              {batchOp ? (
                <button type="button" onClick={() => { batchCancelRef.current = true; }} className="text-caption text-fg-3 hover:text-fg underline underline-offset-2">Cancel</button>
              ) : runningAll && isDownloadingAll ? (
                <span className="text-caption text-fg-3">Export can’t be cancelled</span>
              ) : null}
            </>
          )}
          {/* Download every reel (cycles through them); only shown when there's more than one. (Canvas view only.) */}
          {videoRenderEntries.length > 1 && !pipelineView && (
            <Button
              variant="secondary"
              size="sm"
              onClick={downloadAllReels}
              disabled={exportBusy || !!batchOp || runningAll}
              leadingIcon={<DownloadIcon size={13} />}
              className="rounded-full"
            >
              {isDownloadingAll && !runningAll ? `Downloading ${downloadProgress.done}/${downloadProgress.total}…` : 'Download All'}
            </Button>
          )}
        </div>
      </div>
      {/* Always mounted (renders null while closed) so pasted links, imported threads, and selections
          survive closing and reopening the panel. */}
      {/* Reddit-only, and MOUNT-gated rather than render-gated: BulkBuilder seeds its state from the
          global `bulk:threads` key before its own `open` check, so mounting it in another workspace put
          Reddit's imported threads within reach of that workspace's "Clear pipeline". ScoutPanel owns the
          equally-global `scout:buffer`. Neither key is style-partitioned the way reels:grid is. */}
      {/* Reddit thread picker — centred like the pipeline's builder so the two-pane layout has room. */}
      {redditOpen && selectedEntry && (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/50 p-4" onPointerDown={() => setRedditOpen(false)}>
          <div className="flex flex-col w-full max-w-5xl max-h-[85vh] rounded-2xl bg-surface-1 border border-line-strong shadow-3" onPointerDown={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-line shrink-0">
              <span className="text-subheading font-semibold text-fg">Reddit thread</span>
              <IconButton icon={<CloseIcon size={14} />} label="Close" variant="secondary" onClick={() => setRedditOpen(false)} />
            </div>
            {/* flex column, not a block: the picker sizes itself with flex-1 + min-h-0 all the way down
                (same chain as the builder). A percentage height against a flex item doesn't reliably
                constrain, so the panes grew past the card and overflow-hidden clipped them unscrollably. */}
            <div className="flex flex-col flex-1 min-h-0 p-4">
              <RedditFlyout
                key={selectedEntry.id}
                speed={narrationSpeed}
                saved={framingMap[selectedEntry.id]?.redditThread ?? null}
                onSaveThread={t => {
                  // Re-pointing the reel to a different thread invalidates the build-time thread cache (copy
                  // must re-import the new url). Read the prior url from the live ref, not a stale closure.
                  if (framingMapRef.current[selectedEntry.id]?.redditThread?.url !== t?.url) threadCacheRef.current.delete(selectedEntry.id);
                  setFramingMap(prev => ({ ...prev, [selectedEntry.id]: { ...prev[selectedEntry.id], redditThread: t ?? undefined } }));
                  markFramingDirty();
                }}
                hasVideo={!!(selectedEntry.localVideoSrc || selectedEntry.data || selectedEntry.videoUrl)}
                onAdd={async (card, dims, blockAuthors) => {
                  await addRedditCard(selectedEntry.id, card, dims, blockAuthors);
                  setRedditOpen(false);   // the card is on the reel — get out of the way so they can see it
                }}
              />
            </div>
          </div>
        </div>
      )}
      {hasThreadSource && <BulkBuilder
        open={bulkOpen} onClose={() => setBulkOpen(false)} speed={narrationSpeed}
        onBuild={async ts => {
          const r = await buildReelsFromThreads(ts);
          releaseScoutForBuilt(r.builtUrls);   // release-at-build: reels exist for exactly these urls now
          return r;
        }}
        queuedUrls={scoutImportQueue}
        onQueueConsumed={() => { setScoutImportQueue(null); setScoutHandoffRunning(true); }}
        onQueueDone={onScoutQueueDone}
        existingReelIds={existingReelIds}
        clearSignal={bulkClearSignal}
      />}
      {/* The style's own source surface (reelSurfaces) — the modal that creates one of its reels. A style
          that builds reels some other way (Reddit, in bulk from threads) declares none and renders nothing. */}
      {surfacesFor(activeStyleId).renderSource?.({
        open: sourceOpen,
        onClose: () => setSourceOpen(false),
        onCreateCommentary: createCommentaryReel,
        onCreateMeme: createMemeReel,
      })}
      {/* Reddit Scout — the wide review panel opened from the pipeline's Scout node. */}
      {hasThreadSource && <ScoutPanel
        open={scoutOpen}
        onClose={() => setScoutOpen(false)}
        bufferedPosts={scoutBuffer}
        bufferedIds={scoutBufferedIds}
        onBuffer={scoutBufferAdd}
        onUnbuffer={scoutBufferRemove}
        onSendToImport={sendScoutToImport}
        builtPostIds={scoutBuiltPostIds}
        onNewCount={setScoutNewCount}
      />}

      {onDeleteAllReels && (
        <Modal
          open={confirmClear !== null}
          onClose={() => setConfirmClear(null)}
          title={confirmClear === 'pipeline' ? 'Clear the pipeline?' : 'Delete all reels?'}
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setConfirmClear(null)}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={() => {
                const mode = confirmClear;
                // Scoped to the active workspace: it deletes this style's reels and GCs only their media —
                // the other styles' reels are still in the saved grid and still own their blobs.
                onDeleteAllReels(activeStyleId);
                // The per-reel state maps (keyed by id) are cleared too, so nothing from the deleted reels
                // can bleed onto the fresh one and get re-saved. Clearing gives a true clean slate.
                setFramingMap({}); setReelTemplateMap({}); setReelNameMap({}); setVideoZoomMap({}); setRecordingStateMap({}); setOverlaysMap({});
                // "Clear pipeline" also empties the Import & pick node's imported/picked threads.
                if (mode === 'pipeline') setBulkClearSignal(n => n + 1);
                setConfirmClear(null);
              }}>{confirmClear === 'pipeline' ? 'Clear pipeline' : 'Delete all reels'}</Button>
            </>
          }
        >
          <p className="text-caption text-fg-3">
            {confirmClear === 'pipeline'
              ? 'This removes every reel AND the imported threads in the Import & pick node, and permanently deletes the reels’ stored videos. Your Scout buffer is kept. It can’t be undone — download anything you want to keep first.'
              : 'This removes every reel from your workspace and permanently deletes their stored videos. It can’t be undone. Download anything you want to keep first.'}
          </p>
        </Modal>
      )}

      {/* Bulk pipeline view (stages-as-nodes) — shown in place of the reel canvas while active. The reel
          canvas stays MOUNTED (just hidden) so the current reel's live framing isn't lost on the switch. */}
      {hasPipeline && pipelineView && (
        <PipelineView
          stageDefs={activeStyle.stages}

          activeStyleId={activeStyleId}
          styleName={activeStyle.name}
          onOpenSource={() => setSourceOpen(true)}
          sourceLabel={sourceLabel}
          stages={pipelineStages}
          totalReels={pipelineTotalReels}
          runningAll={runningAll}
          busy={exportBusy || runningAll}
          onRunAll={runAll}
          onRunStage={runPipelineStage}
          onOpenBulkBuilder={() => setBulkOpen(true)}
          onOpenScout={() => setScoutOpen(true)}
          musicTracks={BACKGROUND_TRACKS}
          currentMusicId={pipelineMusicId}
          onPickMusic={applyMusicToAll}
          narrationSpeeds={NARRATION_SPEEDS}
          narrationSpeed={narrationSpeed}
          onNarrationSpeed={setNarrationSpeed}
          onClearPipeline={onDeleteAllReels && hasReelContent ? () => setConfirmClear('pipeline') : undefined}
        />
      )}
      {/* ── Reel canvas — one reel at a time, like the carousels editor (switch via the docked strip) ── */}
      <div
        ref={attachScroll}
        className={`flex-1 overflow-auto overscroll-contain no-native-scrollbar flex flex-col [align-items:safe_center] [justify-content:safe_center]${pipelineView ? ' hidden' : ''}`}
      >
        {/* World wrapper — width = lane × viewScale/ZOOM_MIN. At min zoom it exactly fills the view (whole
            reel visible, nothing to pan); zoom in and it overflows so you pan within that one reel. The
            pannable area is always just the min-zoom view scaled up — never an unbounded void. */}
        <div className="flex justify-center" style={{ minWidth: lane.width ? lane.width * viewScale / ZOOM_MIN : undefined }}>
        <div ref={contentRef} className="flex flex-col items-center py-6 px-4" style={{ zoom: fitFactor * viewScale, opacity: reelVisible ? 1 : 0 }}>
          {/* VIRTUALIZED: only the displayed reel mounts a live canvas — mounting every reel's <video>
              would hang the browser on a large grid (a real account has 486 reels). A reel's edits
              (crop/zoom/pan/trim) live inside its canvas while mounted, so before a switch unmounts the
              outgoing reel we snapshot its getFraming() into framingMap (see the [selectedId] effect
              above); its next mount replays that via initialFraming. Do NOT revert to keeping all reels
              mounted without also removing that capture, or edits are lost. displayId lags selectedId by
              one render, which is why the capture reads the still-mounted outgoing reel. */}
          {entries.map((entry, index) => {
            // Virtualized: only the displayed reel renders its (heavy) canvas + template compute. Every
            // other reel is a zero-cost hidden placeholder — navigation is the SlidesStrip below, and the
            // outgoing reel's framing was snapshotted into framingMap on the switch, so nothing is lost.
            if (entry.id !== displayId) return <div key={entry.id} className="hidden" aria-hidden />;
            // Each reel renders with ITS OWN inherited template (so a saved grid can mix templates);
            // falls back to the active picker selection, then the default look. A commentary reel has no
            // tweet template at all — it renders on CommentaryCanvas below — so rowSettings now only reaches
            // its skeleton preview, while the video is still being fetched. Keep that pinned to the full-bleed
            // default so the skeleton previews what the reel WILL be, not a tweet card it will never draw.
            const rowStyle = getReelStyle(styleTagForSave(framingMap[entry.id], activeStyleId));
            const isCommentary = rowStyle.narration === 'script';
            const rowTemplateId = reelTemplateMap[entry.id] ?? activeTwitterId;
            const rowSettings = isCommentary
              ? defaultTwitterTemplateSettings()   // full-bleed band (1920, cellMargin 0, no cells)
              : (twitterTemplates.find(t => t.id === rowTemplateId)?.settings ?? twSettings);

            const hasRender = !entry.loading && (
              !!entry.localVideoSrc
              || !!entry.videoUrl
              || (!!entry.data && !(entry.data.images && entry.data.images.length > 0))
            );
            const rowVideoSrc = entry.localVideoSrc ?? (entry.data ? bestVideoUrl(entry.data) : entry.videoUrl ?? '');
            // One registrar for both canvases: whichever one this reel mounts, the workspace holds it as a
            // TikTokCanvasRef, so export / bulk export / the pipeline keep calling through canvasRefsMap
            // without caring which. On a style switch React detaches the old ref (delete) before attaching
            // the new one (set), so the map never ends up empty for a mounted reel.
            const registerCanvasRef = (r: TikTokCanvasRef | null) => {
              if (r) {
                canvasRefsMap.current.set(entry.id, r);
                // Re-render the workspace (and so the transport) whenever this reel's video ELEMENT changes —
                // first mount, or a remount that swapped in a new one. Re-registering the same element on a
                // plain re-render is a no-op, so this can't loop.
                const el = r.getVideoElement();
                if (canvasVideoEls.current.get(entry.id) !== el) {
                  canvasVideoEls.current.set(entry.id, el);
                  setCanvasRefVersion(v => v + 1);
                }
              } else {
                canvasRefsMap.current.delete(entry.id);
              }
            };

            return (
              <div
                key={entry.id}
                className="flex flex-col gap-3"
                style={{ width: CARD_W }}
              >
                {/* URL + caption live in the left rail's link/caption flyouts. */}

                {/* Template + video skeleton — what the reel will look like, shown until a video is added. */}
                {!hasRender && entry.mode === 'twitter' && !entry.loading && (
                  <div className="mt-2">
                    <ReelTemplatePreview settings={rowSettings} brand={brand} width={CARD_W} overlayCaption={entry.caption} />
                  </div>
                )}
                {/* Canvas render (only when ready) */}
                {hasRender && (
                  <div className="flex flex-col gap-4 mt-2">
                    {/* Selection ring + canvas */}
                    <div
                      onClick={() => setSelectedId(entry.id)}
                      className="relative cursor-pointer transition-all duration-150 mt-1 ring-1 ring-line hover:ring-line-strong"
                    >
                      {/* A commentary reel is a full-bleed video + karaoke captions and nothing else, so it
                          renders on its own canvas rather than through the tweet/cell machinery — the two
                          styles kept interfering through branches that were constants on each side. */}
                      {/* Which canvas this reel mounts is the STYLE's answer, not a branch here — see
                          reelSurfaces. The shell hands over everything it knows about the reel and the
                          style's entry adapts it to its own canvas's props. */}
                      {surfacesFor(rowStyle.id).renderCanvas({
                        entryId: entry.id,
                        epoch: canvasEpochMap[entry.id] ?? 0,
                        videoSrc: rowVideoSrc,
                        videoId: entry.data?.id,
                        rowNumber: index,
                        caption: entry.caption,
                        framing: framingMap[entry.id] ?? null,
                        exportTitle: framingMap[entry.id]?.ytTitle,
                        exportDescription: framingMap[entry.id]?.description,
                        musicId: resolveMusicId(framingMap[entry.id]?.musicId),
                        musicVolume: framingMap[entry.id]?.musicVolume ?? null,
                        bgBlur: framingMap[entry.id]?.bgBlur ?? false,
                        thumbnailId: framingMap[entry.id]?.thumbnailId ?? null,
                        twitterSettings: rowSettings,
                        overlayLogoSrc: brand.logoSrc || '/templatelogo.png',
                        overlayDisplayName: rowSettings.defaultDisplayName || brand.displayName || 'Your Name',
                        overlayHandle: rowSettings.defaultHandle || brand.handle || '@yourhandle',
                        // Defer the ~100MB clip until the reel has its card; without one there'd be nothing
                        // to hide a black band, so load eagerly. A style with no card always loads eagerly.
                        eagerVideo: !rowStyle.primaryOverlayName || !(framingMap[entry.id]?.overlays ?? []).some(o => o.name === rowStyle.primaryOverlayName),
                        ocrBrush: voiceBrush,
                        manualLineDraft: manualDraft,
                        onManualLine: rect => addManualLine(entry.id, rect),
                        ocrVoiceColors: narrationVoiceColors,
                        registerRef: registerCanvasRef,
                        onVideoError: () => onHandleVideoError(entry.id),
                        onFramingChange: markFramingDirty,
                        onOverlaysChange: list => setOverlaysMap(prev => ({ ...prev, [entry.id]: list })),
                        onRecordingStateChange: state => setRecordingStateMap(prev => ({ ...prev, [entry.id]: state })),
                      })}
                      {/* Export progress — a bar across the bottom of the current reel while it downloads. */}
                      {(() => {
                        const rec = recordingStateMap[entry.id];
                        if (!rec?.isRecording) return null;
                        return (
                          <div className="absolute inset-x-0 bottom-0 z-20 h-2 bg-black/50 overflow-hidden">
                            <div
                              className="h-full bg-accent transition-[width] duration-200 ease-out"
                              style={{ width: `${Math.max(2, Math.round(rec.recProgress * 100))}%` }}
                            />
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </div>
        {/* Spacer reserving room for the docked slides strip — a flow element (not container padding) so
            safe-centre can still scroll the reel to its top. */}
        <div aria-hidden className="shrink-0" style={{ height: SLIDES_DOCK_CLEARANCE }} />
      </div>

      {/* ── Video timeline — bottom panel; toggled from the on-canvas button. Sits in FRONT of the left
            rail (z-30) so the undo/redo island tucks behind the timeline instead of overlapping it. ── */}
      <div className="relative bg-surface-1" style={{ zIndex: 40 }}>
        {timelineStripShown && !pipelineView && (
          showVideoControls ? (
            <VideoControlsBar
              entryId={selectedEntry!.id}
              activeRef={activeVideoRef}
              recordingState={activeRecordingState}
              videoSrc={activeVideoSrc}
              overlays={overlaysMap[selectedEntry!.id] ?? []}
              voiceColors={narrationVoiceColors}
              voiceNames={castVoiceNames}
              onHistory={handleTimelineHistory}
              thumbnailSrc={thumbnailPreview}
            />
          ) : (
            <EmptyTimeline />
          )
        )}
      </div>

      {/* Add-reel card — docked at the bottom of the lane (like the Carousels slides strip), so it's
          out of the spotlight carousel flow and never pushes the active reel off-centre. Click-through
          outer that tracks the rail; the centred card captures clicks and is capped to the canvas region.
          Hidden while the reel video timeline is open — the timeline takes over the bottom strip. */}
      {!timelineStripShown && !pipelineView && (
      <div className="fixed bottom-4 z-30 flex justify-center pointer-events-none" style={{ left: 'var(--rail-w, 0px)', right: 0 }}>
        {/* Cap the strip to the canvas region so it stays centred under the reel. */}
        <div className="pointer-events-auto" style={{ maxWidth: 'calc(100% - 20%)' }}>
          <SlidesStrip
            slides={entries.map(e => {
              const rs = recordingStateMap[e.id];
              // The on-screen reel's LIVE overlays (audioDuration once narrated, enabled ocrLines as toggled)
              // live in overlaysMap; framingMap is only re-snapshotted when you switch reels. Read the live copy
              // for the displayed reel so the badge reacts to narrate/clear + line toggles immediately; every
              // other reel (canvas unmounted) falls back to its already-fresh framingMap snapshot.
              // Trust the live list whenever it exists (arrays are truthy, so an empty [] — overlay removed —
              // correctly clears the badge instead of falling back to the stale snapshot). undefined (canvas
              // not mounted yet) falls back to framingMap.
              const live = e.id === displayId ? overlaysMap[e.id] : undefined;
              const framing = live ? ({ ...framingMap[e.id], overlays: live } as Framing) : framingMap[e.id];
              const dur = reelDurationInfo(framing, narrationSpeed, primaryOverlayName);
              const over = !!dur && dur.seconds > SHORTS_MAX_SECONDS;
              return {
                id: e.id, name: reelNameMap[e.id] ?? '',
                progress: rs?.isRecording ? rs.recProgress : undefined,
                // Ceil an over-limit value so the red pill never prints "3:00" (a floored 180.4s) — that would
                // read as at-limit while colored over. In-limit values stay floored (179.6s → "2:59", not "3:00").
                duration: dur ? { label: (dur.estimated ? '~' : '') + fmtTime(over ? Math.ceil(dur.seconds) : dur.seconds), over } : undefined,
              };
            })}
            activeSlideId={selectedId}
            onSelect={setSelectedId}
            onAdd={() => void handleAddRow()}
            // Renames land in the name map, which is an autosave-effect dep — so they persist onto the
            // reel's saved-grid row through the normal debounced save, no extra write path.
            onRename={(id, name) => setReelNameMap(prev => ({ ...prev, [id]: name }))}
            onDelete={onRemoveRow}
            onDuplicate={handleDuplicate}
            onReorder={() => {}}
            numbered
          />
        </div>
      </div>
      )}

      {/* Portals into <body>, so the wrapper's display:none (Sheet view) can't hide it — gate on active. */}
      {active && !pipelineView && (
        <EditorScrollBar
          targetRef={scrollRef}
          zoom={fitFactor * viewScale}
          extent={Math.max(0, 1 - (viewScale - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN))}
          style={{ left: 'var(--rail-w, 0px)', right: 0 }}
        />
      )}

      {/* Bottom-left zoom box — hidden while the reel timeline is open (it would overlap the timeline). */}
      {!timelineStripShown && !pipelineView && (
        <ZoomControl value={fitFactor * viewScale} min={fitFactor * ZOOM_MIN} max={fitFactor * ZOOM_MAX} resetTo={1} onChange={v => { captureFocal(); setViewScale(v / fitFactor); }} />
      )}
    </div>
  );
}
