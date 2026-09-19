// Manually-added text lines: when OCR misses text (boxed buttons, stylized fonts), the user types it
// and drags a box over it — producing a line indistinguishable from a detected one downstream
// (narration, reveals, erase covers, click states all consume OcrTextLine).
//
// The hard part is not the line, it's the NEIGHBOURS: every line's bottomFrac is the reveal crop
// boundary in the gap below it, so inserting a line between two others must move the earlier line's
// boundary up into the new gap. Rather than patching around the insertion point, boundaries are
// recomputed for the whole list from the bboxes — same midpoint convention as memeOcr, minus its
// dropped-chrome adjustments (those candidates are long gone by now; a plain midpoint stays in the
// visual gap, which is all a boundary must do).

import type { OcrTextLine } from '@/app/components/TikTokCanvas/types';

/** Insert a manual line into an overlay's ocrLines, keeping vertical order and rebuilding every
    reveal boundary. Returns a NEW array; inputs are not mutated. */
export function insertManualLine(
  lines: readonly OcrTextLine[],
  manual: { text: string; x0: number; y0: number; x1: number; y1: number },
  opts?: { fromImage?: boolean },
): OcrTextLine[] {
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  const x0 = clamp01(Math.min(manual.x0, manual.x1));
  const x1 = clamp01(Math.max(manual.x0, manual.x1));
  const y0 = clamp01(Math.min(manual.y0, manual.y1));
  const y1 = clamp01(Math.max(manual.y0, manual.y1));

  const sorted = [...lines].sort((a, b) => a.y0 - b.y0);
  let at = sorted.findIndex(l => l.y0 > y0);
  if (at < 0) at = sorted.length;

  // The new line joins the visual block of the line ABOVE it when their vertical gap is under one
  // line-height (same heuristic memeOcr groups with); otherwise the one below; otherwise block 0.
  const above = sorted[at - 1];
  const below = sorted[at];
  const h = Math.max(1e-6, y1 - y0);
  const blockIdx =
    above && y0 - above.y1 <= Math.max(h, above.y1 - above.y0) ? above.blockIdx
      : below ? below.blockIdx
        : above ? above.blockIdx
          : 0;

  const line: OcrTextLine = {
    text: manual.text.trim(),
    x0, y0, x1, y1,
    bottomFrac: 1,            // recomputed below
    endsBlock: false,         // recomputed below
    blockIdx,
    enabled: true,
    manual: true,
    ...(opts?.fromImage ? { fromImage: true } : {}),
  };
  const out = [...sorted.slice(0, at), line, ...sorted.slice(at)];
  return recalcBoundaries(out);
}

/** Rebuild every line's bottomFrac (midpoint of the gap to the next line, last line → 1, clamped
    monotonic so a reveal can never crop back up) and endsBlock (blockIdx transition — the convention
    every producer uses). Pure; returns a new array. */
export function recalcBoundaries(lines: readonly OcrTextLine[]): OcrTextLine[] {
  let prevBoundary = 0;
  return lines.map((l, i) => {
    const next = lines[i + 1];
    let boundary = next ? (l.y1 + next.y0) / 2 : 1;
    boundary = Math.min(1, Math.max(boundary, prevBoundary, l.y1));
    prevBoundary = boundary;
    return {
      ...l,
      bottomFrac: boundary,
      endsBlock: !next || next.blockIdx !== l.blockIdx,
    };
  });
}
