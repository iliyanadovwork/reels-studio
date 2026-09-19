import type { VideoEntry } from '@/app/types';
import type { Framing } from '@/app/components/TikTokCanvas/types';
import type { StageInfo } from '@/app/components/PipelineView';
import { resolveMusicId, trackById, DEFAULT_MUSIC_ID } from '@/lib/music';

// Pure status/derivation for the bulk Pipeline view — extracted from CanvasGrid so the (bug-prone) count
// logic is unit-testable.
//
// Style-blind: this module used to hard-code both "is it a Reddit reel" and the "Reddit thread" overlay name,
// which meant the counts silently read 0/N for any other style with the same shape. It's now handed the
// owning style's own predicate + overlay name (see ReelStyle.computeStages), so the arithmetic is shared and
// the identity is the style's.

type FramingMap = Record<string, Framing>;

/** The bits of the calling style this module needs: whose reels these are, and what its narratable overlay
    is called. Structurally a subset of ReelStyle — passed rather than imported, so the registry can depend on
    this module without a cycle. */
export interface StyleProbe {
  isReel: (id: string, framingMap: FramingMap) => boolean;
  primaryOverlayName: string | null;
}

export interface PipelineRunState {
  batchOp: null | 'narration' | 'copy';
  batchProgress: { done: number; total: number };
  isDownloadingAll: boolean;
  downloadProgress: { done: number; total: number };
}

/** Per-stage {done,total,running,progress} over the reels `style` claims. total = # of those reels. */
export function computePipelineStages(entries: VideoEntry[], framingMap: FramingMap, run: PipelineRunState, style: StyleProbe): StageInfo[] {
  const mine = entries.filter(e => style.isReel(e.id, framingMap));
  const total = mine.length;
  const withFootage = mine.filter(e => e.localVideoSrc || e.videoUrl || e.data).length;
  // "Done" = the reel will have AUDIBLE music. resolveMusicId(undefined) → default track → done; '' ("No
  // music") → null → not done; a valid id → done; a STALE/removed id resolves non-null but trackById() is
  // null (nothing plays), so validate against the library — else a stale reel would falsely read done.
  const withMusic = mine.filter(e => trackById(resolveMusicId(framingMap[e.id]?.musicId)) !== null).length;
  // A style with no narratable overlay can't have a narrated reel by this measure — count 0 rather than
  // matching an unnamed overlay, which would let any audio-carrying layer read as "narrated".
  const narrated = style.primaryOverlayName === null ? 0 : mine.filter(
    e => ((framingMap[e.id]?.overlays ?? []).find(o => o.name === style.primaryOverlayName)?.audioDuration ?? 0) > 0,
  ).length;
  const copied = mine.filter(e => framingMap[e.id]?.ytTitle && framingMap[e.id]?.description).length;
  const narrRunning = run.batchOp === 'narration', copyRunning = run.batchOp === 'copy';
  return [
    { key: 'import',  done: total,       total, running: false },   // one node: the bulk builder does import + pick + edit
    { key: 'footage', done: withFootage, total, running: false },
    { key: 'music',   done: withMusic,   total, running: false },
    { key: 'narrate', done: narrated,    total, running: narrRunning, progress: narrRunning ? run.batchProgress : null },
    { key: 'copy',    done: copied,      total, running: copyRunning, progress: copyRunning ? run.batchProgress : null },
    // Export completion isn't persisted, so show live progress while running and idle (0/N) otherwise —
    // never a false "Done".
    { key: 'export',  done: run.isDownloadingAll ? run.downloadProgress.done : 0, total, running: run.isDownloadingAll, progress: run.isDownloadingAll ? run.downloadProgress : null },
  ];
}

/** The music track shared by ALL of the style's reels (for the drawer radio): the common raw musicId,
 *  defaulting only the UNSET (undefined) case to the default track so a fresh reel highlights it — while ''
 *  (explicit No music) stays '' and a genuinely mixed selection returns null (nothing highlighted). */
export function computePipelineMusicId(entries: VideoEntry[], framingMap: FramingMap, isReel: StyleProbe['isReel']): string | null {
  const mine = entries.filter(e => isReel(e.id, framingMap));
  if (!mine.length) return null;
  const first = framingMap[mine[0].id]?.musicId ?? DEFAULT_MUSIC_ID;
  return mine.every(e => (framingMap[e.id]?.musicId ?? DEFAULT_MUSIC_ID) === first) ? first : null;
}
