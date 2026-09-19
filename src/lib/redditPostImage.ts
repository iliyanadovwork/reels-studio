// Pull the ONE post image out of a Reddit post's raw JSON (`listing[0].data.children[0].data`).
// NATIVE TRANSPORT ONLY: the Apify actor reads Reddit's RSS/recovery pages, so its `imageUrls` is []
// and its `domain` is "reddit.com" even for a plain i.redd.it photo post — there is nothing there to
// read (see the note on ApifyItem in api/reddit/route.ts). An Apify-served thread simply renders the
// card without an image, which is the same branch a text post takes.
//
// Two things make this less obvious than "read .url":
//   1. ESCAPING. Reddit HTML-escapes & → &amp; inside every preview.redd.it URL, and the escaped form
//      403s because the &amp; breaks the `s=` HMAC. raw_json=1 (which the route sends) normally
//      suppresses it, but the escaping belongs to the FIELD rather than the request, so unescape
//      unconditionally — it costs one pass and it's the failure that's invisible otherwise.
//   2. THE SIGNATURE COVERS THE WHOLE QUERY STRING, so a width cannot be synthesised (`&width=928`
//      → 403). Reddit hands out a ladder of pre-signed renditions (108/216/320/640/960/1080) and the
//      only choice available is WHICH RUNG to take. Taking the rung just wide enough for the card is
//      also what keeps the inlined data URI at ~100 KB instead of megabytes — no server-side re-encode.

/** Width the card draws a post image at — redditCard.ts's inner column (W 1024 − PAD 48×2). Lives in
    this node-pure module so the API route can size its rung pick without importing the canvas renderer.
    Only used to CHOOSE among Reddit's fixed rungs, so if the card's column ever moves the worst case is
    a rendition one step off, never a broken image. */
export const CARD_IMAGE_W = 928;

/** Tallest the image band may be. A phone screenshot is ~9:19.5, which at full column width would be a
    2000px band and a card taller than the reel — so past this the image gives up WIDTH instead, and is
    still shown whole. Deliberately not a crop: the band exists so the viewer sees what the post is. */
export const IMAGE_BAND_MAX_H = 900;

/** A pre-signed Reddit image URL plus the dimensions Reddit reported for it. `width`/`height` are 0 for
    the direct-link fallback below (a bare i.redd.it URL carries no dimensions) — the card derives its
    aspect from the decoded image either way. */
export interface RedditPostImage {
  url: string;
  width: number;
  height: number;
}

/**
 * Where the image band sits inside the card's text column: contain-fit, centred, capped at
 * IMAGE_BAND_MAX_H. `dx` is the offset from the column's left edge (0 unless the image had to narrow to
 * fit the cap). Null for a degenerate image — the caller then lays the card out as if there were none.
 *
 * Pure geometry, kept out of the canvas renderer so the cap is unit-testable: the renderer is a
 * measure-then-draw pass over a real 2D context and has no test harness in this repo.
 */
export function imageBandRect(
  naturalW: number, naturalH: number, columnW: number = CARD_IMAGE_W, maxH: number = IMAGE_BAND_MAX_H,
): { dx: number; w: number; h: number } | null {
  if (!(naturalW > 0) || !(naturalH > 0) || !(columnW > 0) || !(maxH > 0)) return null;
  const ratio = naturalH / naturalW;
  const w = Math.min(columnW, Math.round(maxH / ratio));
  const h = Math.min(maxH, Math.round(w * ratio));
  return w > 0 && h > 0 ? { dx: Math.round((columnW - w) / 2), w, h } : null;
}

// Same entity set as plainText() in api/reddit/route.ts, applied to a URL rather than prose: there a
// stray &amp; only reads wrong, here it silently 403s.
const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#x27;': "'", '&#39;': "'", '&quot;': '"',
};
const unescapeEntities = (s: string): string =>
  s.replace(/&(amp|lt|gt|#x27|#39|quot);/g, m => ENTITIES[m] ?? m);

const PREVIEW_HOSTS = /^(i|preview)\.redd\.it$/;   // the pre-signed renditions + the raw upload
const DIRECT_HOST = /^i\.redd\.it$/;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

/** https + a Reddit media host. Anything else is either not an image we may inline or (for an
    attacker-shaped payload) somewhere we should never fetch from. */
function hostAllowed(url: string, hosts: RegExp): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hosts.test(u.hostname);
  } catch { return false; }
}

const isImageUrl = (url: string): boolean => {
  try { return IMAGE_EXT.test(new URL(url).pathname); } catch { return false; }
};

/** One rendition entry ({ url, width, height }) → a usable candidate, or null. */
function toCandidate(raw: unknown): RedditPostImage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== 'string' || typeof r.width !== 'number' || typeof r.height !== 'number') return null;
  if (!(r.width > 0) || !(r.height > 0)) return null;
  const url = unescapeEntities(r.url);
  return hostAllowed(url, PREVIEW_HOSTS) ? { url, width: r.width, height: r.height } : null;
}

/** The narrowest rendition at least `minWidth` wide (Reddit's ladder tops out at 1080, so this is
    usually the last rung), else the widest one on offer — upscaling a 640 is still better than no
    image, and the card contains it to its column either way. */
function pickRendition(cands: RedditPostImage[], minWidth: number): RedditPostImage | null {
  if (!cands.length) return null;
  const byWidth = [...cands].sort((a, b) => a.width - b.width);
  return byWidth.find(c => c.width >= minWidth) ?? byWidth[byWidth.length - 1];
}

/** Why a post yielded no image. Every value here is DETERMINISTIC for a given post — retrying cannot
    change any of them, which is exactly what makes them worth telling the caller apart from a transient
    download failure (the one case where "try again" is honest advice). */
export type PostImageSkip =
  | 'gallery'      // multi-image post — needs its own band, deliberately out of scope
  | 'video'        // a video post, not a photo
  | 'nsfw'         // over_18: `preview` carries the UNBLURRED original, so we refuse it
  | 'text'         // no image to find — the common, healthy case
  | 'no-rendition'; // an image post whose preview ladder yielded nothing usable

/** An image, or the reason there isn't one. */
export interface PostImageInspection {
  image: RedditPostImage | null;
  /** null exactly when `image` is non-null. */
  skip: PostImageSkip | null;
}

/**
 * The image a post SHOWS *and why not* when it has none. Callers that only want the image use
 * `extractPostImage`; the route uses this one so it can report a truthful `imageStatus` instead of
 * letting "text post", "gallery" and "the download failed" all collapse into an absent field.
 *
 * Every guard below is a false positive we'd otherwise render as "the post's image".
 */
export function inspectPostImage(post: unknown, minWidth: number = CARD_IMAGE_W): PostImageInspection {
  if (!post || typeof post !== 'object') return { image: null, skip: 'text' };
  const p = post as Record<string, unknown>;

  // Galleries are explicitly out of scope for this pass: their order lives in gallery_data.items[] and
  // their bytes in media_metadata[] (no `preview` at all), so they need their own band, not a silent
  // "first image wins". Short-circuit deliberately rather than half-handling them.
  if (p.is_gallery === true) return { image: null, skip: 'gallery' };
  const hint = typeof p.post_hint === 'string' ? p.post_hint : '';
  if (p.is_video === true || hint === 'hosted:video' || hint === 'rich:video') return { image: null, skip: 'video' };

  const direct = typeof p.url_overridden_by_dest === 'string' ? p.url_overridden_by_dest
    : typeof p.url === 'string' ? p.url : '';
  // post_hint === 'image' is the load-bearing guard. An external LINK post ALSO carries a `preview` —
  // but it's an OG scrape of the linked page (preview.enabled: false, ~400px wide, on
  // external-preview.redd.it), and rendering that as "the post's image" is simply wrong. The second
  // clause covers the odd post that arrives without a hint: an i.redd.it URL ending in an image
  // extension cannot be anything but this post's image.
  const isImagePost = hint === 'image'
    || (p.is_reddit_media_domain === true && hostAllowed(direct, DIRECT_HOST) && isImageUrl(direct));
  if (!isImagePost) return { image: null, skip: 'text' };

  // NSFW: `preview.images[].source` and `.resolutions` are the UNBLURRED original (only `variants`
  // carries the blurred copy Reddit actually displays), so an over_18 post would put explicit pixels in
  // a reel with no way to notice before export. Skip it — the card falls back to today's text layout.
  //
  // Checked AFTER the isImagePost gate, not before: `over_18` is set on every submission type, so
  // testing it first made every NSFW TEXT post report 'nsfw' and tell the user an image had been
  // skipped when the post never had one. Nothing but an image post reaches the extraction below, so
  // the safety property is identical either way.
  if (p.over_18 === true) return { image: null, skip: 'nsfw' };

  const preview = p.preview as { images?: unknown } | null | undefined;
  const first = preview && Array.isArray(preview.images) ? preview.images[0] : undefined;
  const cands: RedditPostImage[] = [];
  if (first && typeof first === 'object') {
    const img = first as Record<string, unknown>;
    // resolutions first, source last: both are ranked by width below, but a same-width tie should
    // resolve to the cheaper pre-scaled rung rather than the full-size original.
    if (Array.isArray(img.resolutions)) for (const r of img.resolutions) {
      const c = toCandidate(r);
      if (c) cands.push(c);
    }
    const src = toCandidate(img.source);
    if (src) cands.push(src);
  }
  // `thumbnail` is never a candidate: it's 140px wide and would render as a postage stamp.
  const rung = pickRendition(cands, minWidth);
  if (rung) return { image: rung, skip: null };

  // Last resort — the post's own i.redd.it link. No ladder here, so this is the FULL-SIZE original; the
  // route's byte cap is what stops a 2 MB photo from riding along as base64 (over cap = no image).
  if (hostAllowed(direct, DIRECT_HOST) && isImageUrl(direct)) {
    return { image: { url: direct, width: 0, height: 0 }, skip: null };
  }
  return { image: null, skip: 'no-rendition' };
}

/**
 * The image a post SHOWS, or null when it has none (which must stay the common case). Thin wrapper over
 * `inspectPostImage` — one set of guards, so the image and the reason can never disagree.
 */
export function extractPostImage(post: unknown, minWidth: number = CARD_IMAGE_W): RedditPostImage | null {
  return inspectPostImage(post, minWidth).image;
}
