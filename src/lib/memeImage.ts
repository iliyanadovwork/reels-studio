import { formatBytes } from './videoIngest';

// What a meme image must be for a reel to survive the whole pipeline — decided when the file is ADDED, not
// when the user finally presses Export. Sibling of videoIngest.ts, and deliberately much smaller: an image
// has no codec problem, so the only real failure modes are "the browser can't decode it" and "it's too big
// to keep".
//
// The bias is the same as videoIngest's, for the same reason: a file we WRONGLY reject can never be used at
// all, while a file we wrongly accept fails where it would have failed anyway. The difference is that
// decodability here is CHEAP and certain to check — the browser either produces an image with non-zero
// dimensions or it doesn't — so unlike the video guard this one can afford to be sure rather than lenient.

/**
 * Biggest meme image we accept, in bytes.
 *
 * Two orders of magnitude below the video cap on purpose. The blob is written to IndexedDB alongside the
 * reel's other media and decoded into memory on every canvas mount AND every export frame, so a 100 MB PNG
 * is a real cost for something that renders into at most a 1080-wide box. 25 MiB comfortably fits any
 * screenshot or phone photo.
 */
export const MAX_MEME_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Smallest image whose text OCR has any chance of reading. Tesseract needs roughly 20px of glyph height;
 * below a couple of hundred pixels across, a meme's text is unreadable and the reel would narrate nothing.
 * A warning rather than a rejection would be ignored, and the user would discover it at the Narrate step.
 */
export const MIN_MEME_IMAGE_PX = 200;

export interface MemeImageCheck {
  /** Human-readable reason to refuse the file, or null when it's fine. */
  problem: string | null;
  /** Object URL for the decoded image (only when problem === null). The caller owns it. */
  url?: string;
  width?: number;
  height?: number;
}

/**
 * Decide whether `file` can become a meme reel, and (on success) hand back a preview URL plus its intrinsic
 * size — the caller needs those anyway to lay the overlay out, so decoding twice would be waste.
 *
 * On ANY rejection the object URL is revoked before returning, so a refused file leaks nothing.
 */
export async function checkMemeImage(file: File | Blob): Promise<MemeImageCheck> {
  const type = file.type ?? '';
  if (type && !type.startsWith('image/')) {
    return { problem: 'That isn’t an image file — pick a PNG, JPEG, WebP or GIF.' };
  }
  if (file.size > MAX_MEME_IMAGE_BYTES) {
    return { problem: `That image is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_MEME_IMAGE_BYTES)}.` };
  }
  if (file.size === 0) return { problem: 'That file is empty.' };

  const url = URL.createObjectURL(file);
  const dims = await new Promise<{ w: number; h: number } | null>(resolve => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
  if (!dims || !dims.w || !dims.h) {
    URL.revokeObjectURL(url);
    // An image/* MIME type the browser still can't decode — a corrupt file, or a format this browser
    // doesn't ship (e.g. AVIF on an older Safari). Either way it would draw nothing on the canvas.
    return { problem: 'Couldn’t read that image — it may be corrupt or in a format this browser can’t open.' };
  }
  if (dims.w < MIN_MEME_IMAGE_PX || dims.h < MIN_MEME_IMAGE_PX) {
    URL.revokeObjectURL(url);
    return { problem: `That image is only ${dims.w}×${dims.h} — too small to read text from (${MIN_MEME_IMAGE_PX}px minimum).` };
  }
  return { problem: null, url, width: dims.w, height: dims.h };
}

/**
 * Where a meme image sits on the 1080×1920 canvas before it's narrated: centred, as wide as it can be
 * without exceeding 86% of the frame or running past the vertical safe area.
 *
 * Pure so it can be tested, and shared by the create path and any later re-fit. Once narration exists the
 * overlay is re-laid-out to the reading width and the teleprompter pin in drawOverlays takes over the
 * vertical position, so this is purely the PRE-narration look.
 */
export function memeOverlayRect(
  imgW: number,
  imgH: number,
  canvasW = 1080,
  canvasH = 1920,
): { x: number; y: number; w: number; h: number } {
  // Floor BOTH dimensions before deriving the aspect. checkMemeImage already refuses a 0-sized image, but
  // this is exported and pure: a 0 height would otherwise give aspect 0 → a zero-height overlay that draws
  // nothing at all, which is far worse than the square fallback a degenerate input gets here.
  const aspect = Math.max(1, imgH) / Math.max(1, imgW);
  // Width-first, then clamp by height: a tall screenshot must not run off the top and bottom of the frame.
  const maxW = canvasW * 0.86;
  const maxH = canvasH * 0.72;
  let w = maxW;
  let h = w * aspect;
  if (h > maxH) { h = maxH; w = h / aspect; }
  return {
    w: Math.round(w),
    h: Math.round(h),
    x: Math.round((canvasW - w) / 2),
    y: Math.round((canvasH - h) / 2),
  };
}
