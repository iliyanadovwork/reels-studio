// OCR a meme/screenshot overlay into narratable text LINES, each with its own reveal boundary.
// Tesseract.js (lazy-loaded, worker reused across generates) reads the image; recognized lines are
// cleaned of social-UI chrome (timestamps, Like/Reply rows, reaction counts, avatar misreads), then
// grouped into visual blocks by vertical gaps — blocks matter because sentence flow and boundary
// padding differ at block edges — but the reveal unit is the LINE: the crop opens one text line at a
// time as the narrator reaches it. Narration text and crop geometry come from the same source, so
// they can never disagree.

import type { Worker } from 'tesseract.js';

export interface MemeLine {
  text: string;
  /** Crop boundary after this line, as a fraction of image height (last line = 1). */
  bottomFrac: number;
  /** True when this line ends a visual block — joining adds terminal punctuation only there, so the
      narrator pauses between blocks but flows straight through mid-sentence line wraps. */
  endsBlock: boolean;
  /** Which visual block this line belongs to — lets callers recompute block ends after filtering. */
  blockIdx: number;
  /** The line's bounding box, as fractions of image width/height — for drawing selectable
      highlights over the text on the overlay. */
  x0: number; y0: number; x1: number; y1: number;
  /** True on lines spliced in from a Reddit post image's OCR (redditImageLines). They share the
      post's blockIdx for voice casting, so this flag is the ONLY way narration and the erase-mode
      cover machinery can tell them from body text. Native producers never set it. */
  fromImage?: boolean;
}

let workerPromise: Promise<Worker> | null = null;
function getWorker(): Promise<Worker> {
  workerPromise ??= import('tesseract.js').then(m => m.createWorker('eng'));
  return workerPromise;
}

const MIN_CONFIDENCE = 65;
// Social-UI chrome the narrator must skip: relative timestamps ("18m …") anywhere they lead, and
// SHORT Like/Reply action rows — the length cap keeps real sentences that happen to start with
// "like…" ("like a neighbor minding their own business").
const isChromeLine = (text: string): boolean =>
  /^\d+\s*[smhdwy]\b/i.test(text) ||
  (/^(?:like|reply|share|follow|see translation)\b/i.test(text) && text.length <= 24);

interface OcrLine { text: string; x0: number; x1: number; y0: number; y1: number; conf: number }

function cleanLine(raw: string): string {
  return raw
    .replace(/\|/g, 'I')                                  // pipe is almost always a misread capital I
    .replace(/[®©™]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:[^A-Za-z"'‘“]{1,2}\s+)+/, '')            // leading avatar/arrow misreads ("3 ", "» ")
    .replace(/(?:\s+[^A-Za-z0-9"'’”.!?)]{1,2})+$/, '')     // trailing chevrons/carets ("— v")
    .trim();
}

const alphaCount = (s: string) => (s.match(/[a-z]/gi) ?? []).length;

/** Optional word-level gates applied INSIDE recognized lines. Tesseract scores every word; a line can
    clear the line-level confidence bar while dragging garbage words along (labels from a drawing
    sitting beside real text OCR as low-confidence fragments on the same line). With no opts the
    output is byte-identical to before these gates existed — the meme style relies on that. */
export interface WordFilterOpts {
  /** Drop words whose own confidence is below this before the line is cleaned and judged. */
  dropWordsBelow?: number;
  /** After word filtering, drop the whole line when fewer than this many words survive. */
  minKeptWords?: number;
}

/** A line's text rebuilt from its confident words, or null when too few survive to be a real line.
    Pure — exported for tests. */
export function confidentWordsText(
  words: readonly { text?: string; confidence?: number }[] | undefined,
  opts: WordFilterOpts,
): string | null {
  const floor = opts.dropWordsBelow;
  if (floor == null || !words?.length) return null;
  const kept = words.filter(w => (w.text ?? '').trim() && (w.confidence ?? 0) >= floor);
  if (kept.length < (opts.minKeptWords ?? 1)) return null;
  return kept.map(w => (w.text ?? '').trim()).join(' ');
}

/** A dropped OCR candidate and why — surfaced in the UI so misses aren't silent. */
export interface DroppedLine { text: string; reason: string }

/** Why a recognized line is kept or dropped — pure, exported for tests. `text` is the CLEANED line
    (post word-filter when opts are in force); `conf` is tesseract's line confidence. */
export function classifyOcrLine(text: string, conf: number): string | null {
  if (conf < MIN_CONFIDENCE) return `low confidence (${Math.round(conf)})`;
  if (alphaCount(text) < 3) return 'too short (under 3 letters)';
  if (isChromeLine(text)) return 'looks like social-UI chrome';
  return null;
}

export async function extractMemeLines(src: string, opts?: WordFilterOpts): Promise<MemeLine[]> {
  return (await extractMemeLinesDetailed(src, opts)).lines;
}

export async function extractMemeLinesDetailed(src: string, opts?: WordFilterOpts): Promise<{ lines: MemeLine[]; dropped: DroppedLine[] }> {
  const img = await new Promise<HTMLImageElement | null>(resolve => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = src;
  });
  if (!img || !img.naturalHeight) return { lines: [], dropped: [] };

  const worker = await getWorker();
  const { data } = await worker.recognize(src, {}, { blocks: true, text: true });
  const all: OcrLine[] = (data.blocks ?? [])
    .flatMap(b => b.paragraphs ?? [])
    .flatMap(p => p.lines ?? [])
    .map(l => ({
      // With word gates in force, the line's text is rebuilt from its confident words BEFORE cleaning;
      // a line that loses too many words becomes '' and falls into `dropped` below — where it still
      // shapes the crop boundaries, exactly like the chrome lines that were always filtered there.
      text: cleanLine(opts?.dropWordsBelow != null ? confidentWordsText(l.words, opts) ?? '' : l.text ?? ''),
      x0: l.bbox.x0, x1: l.bbox.x1, y0: l.bbox.y0, y1: l.bbox.y1, conf: l.confidence ?? 0,
    }))
    .sort((a, b) => a.y0 - b.y0);

  const kept: OcrLine[] = [];
  const dropped: OcrLine[] = [];
  const droppedWhy: DroppedLine[] = [];
  for (const l of all) {
    const reason = classifyOcrLine(l.text, l.conf);
    if (!reason) { kept.push(l); continue; }
    dropped.push(l);
    // Only report drops a human could act on: an empty text (word filter ate everything) reads as
    // noise, not a missed line.
    if (l.text.trim()) droppedWhy.push({ text: l.text.slice(0, 60), reason });
  }
  if (kept.length === 0) return { lines: [], dropped: droppedWhy };

  // Group lines into visual blocks: split when the gap to the next line clearly exceeds the local
  // line height (caption fonts are big, comment fonts small — a fixed gap would split one of them).
  const blocks: { lines: OcrLine[]; top: number; bot: number }[] = [];
  for (const l of kept) {
    const cur = blocks[blocks.length - 1];
    const prev = cur?.lines[cur.lines.length - 1];
    const localH = prev ? ((prev.y1 - prev.y0) + (l.y1 - l.y0)) / 2 : 0;
    if (cur && prev && l.y0 - cur.bot <= Math.max(localH * 0.9, 8)) {
      cur.lines.push(l);
      cur.bot = Math.max(cur.bot, l.y1);
    } else {
      blocks.push({ lines: [l], top: l.y0, bot: l.y1 });
    }
  }

  // One reveal boundary per LINE. Inside a block it's the midpoint of the (tiny) line gap; after a
  // block's last line it's the midpoint of the empty band to the next block, with dropped chrome
  // lines (timestamps, avatar rows) assigned to whichever side they sit closer to — a crop must
  // never slice through a comment's "18m Like Reply" strip or the next comment's avatar.
  const H = img.naturalHeight;
  const W = img.naturalWidth;
  const out: MemeLine[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    for (let j = 0; j < b.lines.length; j++) {
      const l = b.lines[j];
      const endsBlock = j === b.lines.length - 1;
      const box = { blockIdx: i, x0: l.x0 / W, y0: l.y0 / H, x1: l.x1 / W, y1: l.y1 / H };
      if (!endsBlock) {
        out.push({ text: l.text, bottomFrac: Math.min(1, (l.y1 + b.lines[j + 1].y0) / 2 / H), endsBlock, ...box });
        continue;
      }
      if (i === blocks.length - 1) {
        out.push({ text: l.text, bottomFrac: 1, endsBlock, ...box });
        continue;
      }
      let bot = b.bot;
      let top = blocks[i + 1].top;
      for (const d of dropped) {
        const c = (d.y0 + d.y1) / 2;
        if (c <= bot || c >= top) continue;
        if (c - bot <= top - c) bot = Math.max(bot, d.y1);
        else top = Math.min(top, d.y0);
      }
      if (top < bot) top = bot;
      out.push({ text: l.text, bottomFrac: Math.min(1, (bot + top) / 2 / H), endsBlock, ...box });
    }
  }
  return { lines: out, dropped: droppedWhy };
}
