'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SaveState } from '../components/AutosaveChip';
import type { Framing } from '../components/TikTokCanvas/types';
import { rowsForStyle } from '@/lib/reelPartition';
import { mergeGridJson, parseGrid, GRID_STORAGE_KEY } from '@/lib/reelGridStore';

// One saved reel = one grid row, persisted as plain numbers/strings (never the video bytes). The whole
// grid is stored as a single JSON array in localStorage — fully client-side, no backend involved.
export interface SavedReel {
  id: string;
  name: string;                  // optional user label ('' = unnamed)
  mode: 'twitter' | 'caption';
  url: string;                   // pasted link (re-fetched on load); empty for uploads
  videoUrl: string;              // kept for shape-compat with the original schema (always '' here)
  posterUrl: string;             // ditto
  caption: string;
  templateId: string | null;     // inherited reel template → text boxes / pfp / positions
  framing: Framing;              // crop / pan / zoom / trim
}

const STORAGE_KEY = GRID_STORAGE_KEY;
const DEBOUNCE_MS = 800;

/**
 * Saved-grid persistence for ONE reel style. The file holds every style's reels; this hook is the boundary
 * that keeps a workspace from ever seeing — or overwriting — another style's rows: it hands back only its
 * own style's rows on load, and on save writes its rows back merged into whatever is in the file at that
 * moment (see reelGridStore).
 *
 * `styleId === null` means the caller hasn't resolved which workspace it is yet (the active style is read
 * from localStorage after mount). Nothing loads or saves until it does — restoring under a GUESSED style
 * would show the wrong workspace's reels and then save them into the wrong slot.
 */
export function useReelPersistence(userId: string | null | undefined, styleId: string | null) {
  const [fetchedStyle, setFetchedStyle] = useState<string | null>(null);
  const [initialRows, setInitialRows] = useState<SavedReel[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revert = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest pending rows, flushed on unmount — tagged with the style that armed them, so a save queued just
  // before a workspace switch still lands in ITS style's slot rather than whichever is active when it lands.
  const pending = useRef<{ styleId: string; rows: SavedReel[] } | null>(null);

  // `loaded` is per-STYLE: while a switch is in flight, `initialRows` still holds the previous workspace's
  // rows, so the caller must keep waiting rather than restore them into the new one.
  const loaded = !userId || (styleId !== null && fetchedStyle === styleId);

  // localStorage can't transiently fail the way a network read can, so load errors don't happen here.
  const retryLoad = useCallback(() => {}, []);

  useEffect(() => {
    if (!userId || !styleId) return;
    try {
      const rows = parseGrid(localStorage.getItem(STORAGE_KEY))
        .map(normalizeReel)
        .filter((r): r is SavedReel => r !== null);
      setInitialRows(rowsForStyle(rows, styleId));
    } catch {
      setInitialRows([]);
    }
    setFetchedStyle(styleId);
  }, [userId, styleId]);

  // Write `rows` back as the complete set for `sid`, merged into the file AS IT IS NOW. Re-reading here
  // (rather than merging into the snapshot taken at load) is what makes the workspaces independent: the
  // other one may have added, changed or deleted its reels since this one loaded.
  const writeMerged = useCallback((sid: string, rows: SavedReel[]) => {
    localStorage.setItem(STORAGE_KEY, mergeGridJson(localStorage.getItem(STORAGE_KEY), sid, rows));
  }, []);

  const flush = useCallback((sid: string, rows: SavedReel[]) => {
    setSaveState('saving');
    try {
      writeMerged(sid, rows);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
    if (revert.current) clearTimeout(revert.current);
    revert.current = setTimeout(() => setSaveState(prev => (prev === 'saved' ? 'idle' : prev)), 1500);
  }, [writeMerged]);

  // Flush a pending (still-debounced) save synchronously — safe outside React.
  const flushPending = useCallback(() => {
    if (!debounce.current) return;
    clearTimeout(debounce.current);
    debounce.current = null;
    const p = pending.current;
    pending.current = null;
    if (p) {
      try { writeMerged(p.styleId, p.rows); } catch { /* ignore */ }
    }
  }, [writeMerged]);

  // Debounced autosave — call on any change (link/caption/mode/template/framing).
  const scheduleSave = useCallback((rows: SavedReel[]) => {
    if (!userId || !styleId) return;
    // A pending save belongs to the style that armed it. If the workspace switched while it was still
    // debouncing, write it out NOW — replacing it here would drop the other style's last edit on the floor.
    if (pending.current && pending.current.styleId !== styleId) flushPending();
    pending.current = { styleId, rows };
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { debounce.current = null; flush(styleId, rows); }, DEBOUNCE_MS);
  }, [userId, styleId, flush, flushPending]);

  // Flush on unmount and on tab-close / backgrounding.
  useEffect(() => () => {
    if (revert.current) clearTimeout(revert.current);
    flushPending();
  }, [flushPending]);
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushPending(); };
    window.addEventListener('pagehide', flushPending);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushPending);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushPending]);

  return { loaded, loadError: false, retryLoad, initialRows, saveState, scheduleSave };
}

function normalizeReel(r: unknown): SavedReel | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  return {
    id: o.id,
    name: typeof o.name === 'string' ? o.name : '',
    // The "caption" (clean) template was removed — nothing can produce that mode any more, and the canvas
    // no longer knows how to draw it. A legacy blob can still carry it, so coerce it back here, at the
    // restore boundary, rather than letting an unrenderable mode reach the grid.
    mode: 'twitter',
    url: typeof o.url === 'string' ? o.url : '',
    videoUrl: typeof o.videoUrl === 'string' ? o.videoUrl : '',
    posterUrl: typeof o.posterUrl === 'string' ? o.posterUrl : '',
    caption: typeof o.caption === 'string' ? o.caption : '',
    templateId: typeof o.templateId === 'string' ? o.templateId : null,
    framing: normalizeFraming(o.framing),
  };
}

// Coerce a persisted `framing` blob into a shape the draw loop / effects can consume without throwing.
// The reel row itself is validated (normalizeReel), but framing was previously cast through with only a
// `typeof === 'object'` check — so a legacy/corrupt blob could feed a non-array `overlays`/`reveals`/
// `ocrLines` into `.map`, a NaN `musicVolume` into `<audio>.volume` (RangeError), or a wrong-typed
// `redditThread` into the flyout. This drops/repairs each internal so restore is total for any shape.
// Recognised fields are copied through unchanged when valid — a well-formed framing round-trips intact.
function num(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }
export function normalizeFraming(f: unknown): Framing {
  if (!f || typeof f !== 'object') return {};
  const o = f as Record<string, unknown>;
  const out: Framing = {};
  if (o.box && typeof o.box === 'object') out.box = o.box as Framing['box'];
  if (o.videoOffset && typeof o.videoOffset === 'object') out.videoOffset = o.videoOffset as Framing['videoOffset'];
  const vs = num(o.videoScale); if (vs !== undefined) out.videoScale = vs;
  const ts = num(o.trimStart);  if (ts !== undefined) out.trimStart = ts;
  const te = num(o.trimEnd);    if (te !== undefined) out.trimEnd = te;
  if (typeof o.includeEdit === 'boolean') out.includeEdit = o.includeEdit;
  if (Array.isArray(o.segments)) {
    out.segments = (o.segments as unknown[]).filter((s): s is { start: number; end: number } =>
      !!s && typeof s === 'object' && Number.isFinite((s as { start?: unknown }).start) && Number.isFinite((s as { end?: unknown }).end));
  }
  if (Array.isArray(o.overlays)) {
    out.overlays = (o.overlays as unknown[])
      .filter((ov): ov is Record<string, unknown> => !!ov && typeof ov === 'object')
      .map(ov => {
        const n: Record<string, unknown> = { ...ov };   // keep id/name/geometry/audio fields as-is
        // Runtime object URLs must NEVER survive persistence: a stale one blocks rehydration (the
        // "only rehydrate when missing" guards see a value and skip), which silently strips an
        // erase reel of its covers after reload. The strip sites remove them at write; this is the
        // belt for any blob persisted before a strip site learned about a new field.
        delete n.src; delete n.audioSrc; delete n.coverSrc;
        // Only the array-typed internals the draw loop / narration iterate are sanitised, so a
        // non-array (or array-with-holes) can never reach `.map`/index access at draw time.
        n.reveals = Array.isArray(ov.reveals)
          ? (ov.reveals as unknown[]).filter((r): r is { t: number; h: number } =>
              !!r && typeof r === 'object' && Number.isFinite((r as { t?: unknown }).t) && Number.isFinite((r as { h?: unknown }).h))
          : undefined;
        n.ocrLines    = Array.isArray(ov.ocrLines)    ? (ov.ocrLines as unknown[]).filter(l => !!l && typeof l === 'object') : undefined;
        n.ocrDropped  = Array.isArray(ov.ocrDropped)  ? (ov.ocrDropped as unknown[]).filter(d => !!d && typeof d === 'object'
          && typeof (d as { text?: unknown }).text === 'string' && typeof (d as { reason?: unknown }).reason === 'string').slice(0, 8) : undefined;
        n.blockAuthors= Array.isArray(ov.blockAuthors)? (ov.blockAuthors as unknown[]).filter(a => typeof a === 'string')     : undefined;
        n.audioTakes  = Array.isArray(ov.audioTakes)  ? (ov.audioTakes as unknown[]).filter(t => !!t && typeof t === 'object'): undefined;
        // Image dwells: every field is read as a number by the stitcher, so a junk entry would produce
        // NaN silence and a NaN reveal boundary.
        n.dwells      = Array.isArray(ov.dwells)      ? (ov.dwells as unknown[]).filter((d): d is { afterLineIdx: number; sec: number; bottomFrac: number } =>
          !!d && typeof d === 'object' && ['afterLineIdx', 'sec', 'bottomFrac'].every(k => Number.isFinite((d as Record<string, unknown>)[k]))) : undefined;
        // Erase-mode covers: each patch is read as nested rects by the draw loop, and lifts are
        // read by index alongside them — a junk entry would draw NaN rects every frame.
        // Patches and lifts are a POSITIONAL pair (the draw loop indexes lifts by patch index), so
        // they are filtered TOGETHER: dropping an invalid patch drops its lift entry too, never
        // shifting a later cover onto an earlier cover's beat.
        if (Array.isArray(ov.coverPatches)) {
          const rect = (r: unknown, keys: string[]) => !!r && typeof r === 'object' && keys.every(k => Number.isFinite((r as Record<string, unknown>)[k]));
          const rawLifts = Array.isArray(ov.coverLifts) ? (ov.coverLifts as unknown[]) : null;
          const patches: unknown[] = [];
          const lifts: (number | null)[] = [];
          (ov.coverPatches as unknown[]).forEach((cp, i) => {
            if (!cp || typeof cp !== 'object') return;
            const c = cp as Record<string, unknown>;
            if (!Number.isFinite(c.lineIdx) || !rect(c.src, ['x', 'y', 'w', 'h']) || !rect(c.atlas, ['x', 'y']) || !rect(c.dest, ['x', 'y', 'w', 'h'])) return;
            patches.push(cp);
            if (rawLifts) lifts.push(Number.isFinite(rawLifts[i]) ? rawLifts[i] as number : null);
          });
          n.coverPatches = patches;
          n.coverLifts = rawLifts ? lifts : undefined;
        } else {
          n.coverPatches = undefined;
          n.coverLifts = undefined;
        }
        return n;
      }) as Framing['overlays'];
  }
  if (typeof o.musicId === 'string') out.musicId = o.musicId;
  const mv = num(o.musicVolume); if (mv !== undefined) out.musicVolume = Math.min(1, Math.max(0, mv));
  if (typeof o.ytTitle === 'string') out.ytTitle = o.ytTitle;
  if (typeof o.description === 'string') out.description = o.description;
  if (typeof o.styleId === 'string') out.styleId = o.styleId;                 // reel-style tag (survives reload)
  if (typeof o.commentaryScript === 'string') out.commentaryScript = o.commentaryScript;
  if (typeof o.bgBlur === 'boolean') out.bgBlur = o.bgBlur;                   // blurred letterbox fill
  // Custom thumbnail: the key of a still in IndexedDB, held for a few frames at the start of the export.
  // This is an ALLOWLIST — a field missing here is silently dropped on reload, which for these two would
  // lose the thumbnail while orphaning its blob.
  if (typeof o.thumbnailId === 'string') out.thumbnailId = o.thumbnailId;
  if (typeof o.thumbnailName === 'string') out.thumbnailName = o.thumbnailName;
  if (o.redditThread && typeof o.redditThread === 'object') {
    const rt = o.redditThread as Record<string, unknown>;
    if (typeof rt.url === 'string') {
      out.redditThread = {
        url: rt.url,
        comments: Array.isArray(rt.comments) ? (rt.comments as unknown[]).filter((n): n is number => Number.isFinite(n)) : undefined,
        paras:    Array.isArray(rt.paras)    ? (rt.paras as unknown[]).filter((n): n is number => Number.isFinite(n))    : undefined,
      };
      // Pick-stage TEXT edits: sanitise to non-empty-string-valued, non-negative-integer-keyed records
      // so a legacy/corrupt blob can never feed junk into the card/copy edit application.
      if (rt.edits && typeof rt.edits === 'object' && !Array.isArray(rt.edits)) {
        const ed = rt.edits as Record<string, unknown>;
        const rec = (v: unknown): Record<number, string> | undefined => {
          if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
          const r: Record<number, string> = {};
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            // Strict digit-key check — Number('') === 0 would smuggle an empty-string key in as index 0.
            if (/^\d+$/.test(k) && typeof val === 'string' && val.trim()) r[Number(k)] = val;
          }
          return Object.keys(r).length ? r : undefined;
        };
        const edits: NonNullable<Framing['redditThread']>['edits'] = {};
        if (typeof ed.title === 'string' && ed.title.trim()) edits.title = ed.title;
        const pe = rec(ed.paras);       if (pe) edits.paras = pe;
        const ce = rec(ed.comments);    if (ce) edits.comments = ce;
        const po = rec(ed.paraOrig);    if (po) edits.paraOrig = po;      // drift anchors ride along
        const co = rec(ed.commentOrig); if (co) edits.commentOrig = co;
        if (edits.title || edits.paras || edits.comments) out.redditThread.edits = edits;
      }
    }
  }
  return out;
}
