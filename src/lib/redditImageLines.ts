// Splice a Reddit post image's OCR'd text into the card's narration line map, so the narrator READS
// the image instead of holding a silent beat over it.
//
// The card's reveal is one top-anchored crop over a flattened PNG, and every narrated line is a
// MemeLine whose bottomFrac says how far down the card that crop opens when the line is spoken. The
// image band occupies a known rect on the card, and OCR (extractMemeLines) reports its lines with
// fractions OF THE IMAGE — so turning image text into card lines is an affine map of fractions from
// image space into card space, plus two boundary decisions:
//
//   · the LAST image line takes the same below-band boundary the silent dwell used to take, so the
//     pills ride along with it and nothing is left half-revealed (see redditCard's dwell comment);
//   · the lines are inserted after the last post line (blockIdx ≤ 1) — exactly where the dwell
//     anchored — and carry blockIdx 1 themselves: the image IS the post's content, so blockAuthors
//     and the auto-cast give it the post's voice with no new block plumbing.
//
// This math lives here, pure and tested, because its consumer (renderRedditCard) draws to a canvas
// and can't run under vitest's node environment.

import type { MemeLine, WordFilterOpts } from './memeOcr';

export interface BandRect { x: number; y: number; w: number; h: number }

/** Word-level OCR gates for REDDIT post images (memes, drawings, photos with sparse text) — stricter
    than the meme style's screenshot defaults, because narrated junk here goes straight into a voice
    track: low-confidence words ("ABORT I REORT" machine-label bleed) are dropped from kept lines, and
    a line that keeps fewer than two words was probably never text at all ("I SHIT" from a drawing).
    The meme style passes no opts and is byte-for-byte unaffected. */
export const REDDIT_IMAGE_OCR: WordFilterOpts = { dropWordsBelow: 45, minKeptWords: 2 };

/**
 * The reveal boundary BELOW the image band, as a card-height fraction — pills included: the midpoint
 * between the post's bottom (band + pills) and the first comment's top, or the card's bottom edge
 * when there are no comments. Shared by the silent dwell and the last OCR'd image line, so whichever
 * of them carries the image uncovers to exactly the same place and nothing is left half-revealed.
 */
export function belowBandBoundaryFrac(postBottom: number, firstCommentTop: number | null, cardH: number): number {
  if (!(cardH > 0)) return 1;
  const px = firstCommentTop === null ? cardH : (postBottom + firstCommentTop) / 2;
  return Math.min(1, Math.max(0, px / cardH));
}

/** How the image's narrated text is revealed on screen.
    'crop'  — the teleprompter default: the top-anchored crop opens through the image line by line.
    'erase' — the whole image appears at its first beat with every text line hidden under a blur
              cover strip; each strip lifts on its line's beat (see redditTextErase). The crop
              therefore jumps straight to the below-band boundary on the first image line. */
export type ImageRevealMode = 'crop' | 'erase';

export interface SpliceImageLinesOpts {
  /** The card's narration line map as built — title/body/comment rows only, no image lines. */
  lines: MemeLine[];
  /** OCR of the post image, with bottomFrac/bboxes as fractions of the IMAGE (extractMemeLines). */
  imageOcr: MemeLine[];
  /** The image band's rect on the card, in card pixels. */
  band: BandRect;
  cardW: number;
  cardH: number;
  /** The below-band boundary (card-height fraction) the dwell would have used — pills included. */
  finalBoundaryFrac: number;
  /** Reveal mode for the image lines (default 'crop'). */
  mode?: ImageRevealMode;
}

/**
 * The card's line map with the image's text spliced in as narratable lines.
 *
 * With an empty `imageOcr` this returns `lines` UNCHANGED (same reference), which is the signal the
 * caller uses to keep the silent dwell: no text found → today's behaviour, byte for byte.
 */
export function spliceImageLines({ lines, imageOcr, band, cardW, cardH, finalBoundaryFrac, mode = 'crop' }: SpliceImageLinesOpts): MemeLine[] {
  if (!imageOcr.length) return lines;

  // Insert where the dwell anchored: after the last post line. An image above every narratable line
  // (title switched off upstream produces no such rows) inserts at 0 — it still reads first.
  let insertAt = 0;
  lines.forEach((l, i) => { if (l.blockIdx <= 1) insertAt = i + 1; });

  const toCardX = (fx: number) => (band.x + fx * band.w) / cardW;
  const toCardY = (fy: number) => (band.y + fy * band.h) / cardH;

  const imageLines: MemeLine[] = imageOcr.map((ln, i) => {
    const last = i === imageOcr.length - 1;
    return {
      text: ln.text,
      // crop: interior boundaries map into the band; the last line takes the dwell's old below-band
      // boundary so the crop clears the whole image (and pills) as its final words land.
      // erase: EVERY line takes the below-band boundary — the whole image (and pills) appears at the
      // first image beat, and the per-line reveal is the cover strips lifting, not the crop moving.
      bottomFrac: mode === 'erase' || last ? finalBoundaryFrac : clamp01(toCardY(ln.bottomFrac)),
      // OCR's own block structure is kept — pauses between the image's visual text blocks are real —
      // but the last line always ends a block: what follows is the first comment.
      endsBlock: last || ln.endsBlock,
      blockIdx: 1,
      x0: clamp01(toCardX(ln.x0)),
      y0: clamp01(toCardY(ln.y0)),
      x1: clamp01(toCardX(ln.x1)),
      y1: clamp01(toCardY(ln.y1)),
      fromImage: true,
    };
  });

  return [...lines.slice(0, insertAt), ...imageLines, ...lines.slice(insertAt)];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
