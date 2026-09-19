import { describe, it, expect } from 'vitest';
import { extractPostImage, inspectPostImage, imageBandRect, CARD_IMAGE_W, IMAGE_BAND_MAX_H } from './redditPostImage';

// Fixtures are trimmed copies of REAL /comments/{id}.json payloads (r/pics image post, r/worldnews
// link post, a self post, a gallery) — only the fields the extractor reads are kept.

const RUNGS = [
  { url: 'https://preview.redd.it/c8wk99m072dh1.jpeg?width=108&crop=smart&auto=webp&s=aaa', width: 108, height: 48 },
  { url: 'https://preview.redd.it/c8wk99m072dh1.jpeg?width=216&crop=smart&auto=webp&s=bbb', width: 216, height: 97 },
  { url: 'https://preview.redd.it/c8wk99m072dh1.jpeg?width=320&crop=smart&auto=webp&s=ccc', width: 320, height: 143 },
  { url: 'https://preview.redd.it/c8wk99m072dh1.jpeg?width=640&crop=smart&auto=webp&s=ddd', width: 640, height: 286 },
  { url: 'https://preview.redd.it/c8wk99m072dh1.jpeg?width=960&crop=smart&auto=webp&s=eee', width: 960, height: 430 },
  { url: 'https://preview.redd.it/c8wk99m072dh1.jpeg?width=1080&crop=smart&auto=webp&s=fff', width: 1080, height: 483 },
];

const imagePost = (over: Record<string, unknown> = {}) => ({
  title: 'A photo of a thing',
  author: 'SNCreestopherX',
  post_hint: 'image',
  is_self: false,
  is_video: false,
  is_reddit_media_domain: true,
  domain: 'i.redd.it',
  url: 'https://i.redd.it/c8wk99m072dh1.jpeg',
  url_overridden_by_dest: 'https://i.redd.it/c8wk99m072dh1.jpeg',
  thumbnail: 'https://preview.redd.it/c8wk99m072dh1.jpeg?width=140&crop=smart&auto=webp&s=thumb',
  preview: {
    enabled: true,
    images: [{
      source: { url: 'https://preview.redd.it/c8wk99m072dh1.jpeg?auto=webp&s=3264893e', width: 1320, height: 591 },
      resolutions: RUNGS,
      variants: {},
    }],
  },
  ...over,
});

describe('extractPostImage — picking a rendition', () => {
  it('takes the narrowest rung that still covers the card column, not the biggest available', () => {
    // 960 is the first rung ≥ 928, so it wins over 1080 and over the 1320-wide source. The rungs are
    // ~50-100 KB while the i.redd.it original can be 2 MB — choosing "just wide enough" is what removes
    // the need for any server-side re-encode.
    const img = extractPostImage(imagePost());
    expect(img).toEqual({ url: RUNGS[4].url, width: 960, height: 430 });
  });

  it('accepts a rung exactly as wide as the card column', () => {
    const rungs = [{ url: 'https://preview.redd.it/x.jpeg?s=1', width: CARD_IMAGE_W, height: 500 }, ...RUNGS.slice(5)];
    const img = extractPostImage(imagePost({ preview: { enabled: true, images: [{ resolutions: rungs }] } }));
    expect(img?.width).toBe(CARD_IMAGE_W);
  });

  it('falls back to the WIDEST candidate when every rung is narrower than the card', () => {
    // A small upload has no 960/1080 rung; the full-size source is then the best thing on offer.
    const img = extractPostImage(imagePost({
      preview: { enabled: true, images: [{
        source: { url: 'https://preview.redd.it/small.jpeg?auto=webp&s=zz', width: 700, height: 400 },
        resolutions: RUNGS.slice(0, 3),
      }] },
    }));
    expect(img).toEqual({ url: 'https://preview.redd.it/small.jpeg?auto=webp&s=zz', width: 700, height: 400 });
  });

  it('prefers the pre-scaled rung over the full-size source at the SAME width', () => {
    // Both cover the column, so both are valid — but the rung is already downscaled bytes while the
    // source is the original re-encoded on demand. The tie has to break towards the cheaper one,
    // because the whole point of picking a rung is keeping the inlined data URI at ~100 KB.
    const img = extractPostImage(imagePost({
      preview: { enabled: true, images: [{
        source: { url: 'https://preview.redd.it/src.jpeg?auto=webp&s=src', width: 1080, height: 483 },
        resolutions: [{ url: 'https://preview.redd.it/rung.jpeg?width=1080&s=rung', width: 1080, height: 483 }],
      }] },
    }));
    expect(img?.url).toBe('https://preview.redd.it/rung.jpeg?width=1080&s=rung');
  });

  it('never returns the 140px `thumbnail`', () => {
    const img = extractPostImage(imagePost({ preview: undefined }));
    expect(img?.url).not.toContain('width=140');
  });

  it('ignores malformed rungs (no width, no url, zero-sized) instead of throwing', () => {
    const img = extractPostImage(imagePost({
      preview: { enabled: true, images: [{
        resolutions: [null, 'nope', { url: 'https://preview.redd.it/a.jpeg?s=1' }, { width: 1080, height: 483 },
          { url: 'https://preview.redd.it/b.jpeg?s=2', width: 0, height: 0 }, RUNGS[5]],
      }] },
    }));
    expect(img).toEqual({ url: RUNGS[5].url, width: 1080, height: 483 });
  });
});

describe('extractPostImage — HTML entity escaping', () => {
  it('unescapes &amp; in a preview URL (the escaped form 403s — the &amp; breaks the s= HMAC)', () => {
    const escaped = 'https://preview.redd.it/c8wk99m072dh1.jpeg?width=1080&amp;crop=smart&amp;auto=webp&amp;s=fff';
    const img = extractPostImage(imagePost({
      preview: { enabled: true, images: [{ resolutions: [{ url: escaped, width: 1080, height: 483 }] }] },
    }));
    expect(img?.url).toBe('https://preview.redd.it/c8wk99m072dh1.jpeg?width=1080&crop=smart&auto=webp&s=fff');
    expect(img?.url).not.toContain('&amp;');
  });

  it('leaves an already-clean URL byte-identical (raw_json=1 is the normal path — the signature is exact)', () => {
    const img = extractPostImage(imagePost());
    expect(img?.url).toBe(RUNGS[4].url);
  });
});

describe('extractPostImage — posts with no image', () => {
  it('returns null for a self/text post (no preview, no post_hint)', () => {
    expect(extractPostImage({
      title: 'AITA for asking my roommate to move out?',
      author: 'throwaway',
      selftext: 'Long story…',
      is_self: true,
      is_video: false,
      thumbnail: '',
    })).toBeNull();
  });

  it('returns null for an EXTERNAL LINK post, whose preview is an OG scrape of the linked page', () => {
    // Real shape: r/worldnews 1v5axes — post_hint "link", preview.enabled false, source 408x305 on
    // external-preview. Without the post_hint guard this renders a news site's share card as "the image".
    expect(extractPostImage({
      title: 'Something happened somewhere',
      post_hint: 'link',
      domain: 'ynetnews.com',
      is_reddit_media_domain: false,
      url: 'https://www.ynetnews.com/article/abc123',
      preview: { enabled: false, images: [{
        source: { url: 'https://external-preview.redd.it/og.jpg?auto=webp&s=zz', width: 408, height: 305 },
        resolutions: [{ url: 'https://external-preview.redd.it/og.jpg?width=320&s=yy', width: 320, height: 239 }],
      }] },
    })).toBeNull();
  });

  it('returns null for a gallery (out of scope this pass — order lives in gallery_data, bytes in media_metadata)', () => {
    // Captured shape: is_gallery true, and NO preview / post_hint at all.
    expect(extractPostImage({
      title: '5 photos of my dog',
      is_gallery: true,
      media_metadata: { abc123: { status: 'valid', e: 'Image', m: 'image/jpg', p: [{ x: 1080, y: 720, u: 'https://preview.redd.it/abc123.jpg?width=1080&amp;s=q' }] } },
      gallery_data: { items: [{ media_id: 'abc123', id: 1 }] },
      url: 'https://www.reddit.com/gallery/1ujshs0',
    })).toBeNull();
  });

  it('returns null for a gallery even when it ALSO looks like an image post', () => {
    // is_gallery is checked first and on its own, so a gallery that arrives carrying a preview or an
    // image hint (crossposts and edited posts vary) still can't sneak in as "the post's image" — which
    // would silently show picture 1 of 7 with no indication the rest exist.
    expect(extractPostImage(imagePost({ is_gallery: true, media_metadata: {}, gallery_data: { items: [] } }))).toBeNull();
  });

  it('returns null for a post that merely CARRIES a preview without declaring itself an image', () => {
    // post_hint is Reddit's own "this post IS an image" signal. Without it — a link post, a crosspost,
    // a self post whose body links a picture — a preview is just a thumbnail of something the post
    // refers to, not the image the post shows. Rendering it would put the wrong picture on the card.
    expect(extractPostImage({
      title: 'Check out this thing I found',
      is_self: true,
      selftext: 'https://i.redd.it/somebody-elses.jpeg',
      url: 'https://www.reddit.com/r/somesub/comments/abc123/check_out_this_thing/',
      preview: { enabled: true, images: [{ source: { url: 'https://preview.redd.it/somebody-elses.jpeg?auto=webp&s=q', width: 1200, height: 900 }, resolutions: RUNGS }] },
    })).toBeNull();
  });

  it('returns null when post_hint is present but is not "image"', () => {
    // The guard is an EQUALITY on 'image', not "has a hint" — and the difference is load-bearing.
    // A self post whose body embeds a picture, and a link post Reddit previewed, both arrive with a
    // hint AND a genuine preview.redd.it ladder (so the host allowlist won't save us here). Only
    // post_hint === 'image' means "the image IS the post".
    for (const hint of ['self', 'link', 'gallery', 'rich:image']) {
      expect(extractPostImage({
        title: 'Something else entirely',
        post_hint: hint,
        is_self: hint === 'self',
        url: 'https://www.reddit.com/r/somesub/comments/abc123/something_else/',
        preview: { enabled: true, images: [{ source: { url: 'https://preview.redd.it/other.jpeg?auto=webp&s=k', width: 1200, height: 900 }, resolutions: RUNGS }] },
      })).toBeNull();
    }
  });

  it('returns null for video posts (hosted and rich)', () => {
    expect(extractPostImage(imagePost({ is_video: true, post_hint: 'hosted:video' }))).toBeNull();
    expect(extractPostImage(imagePost({ is_video: false, post_hint: 'rich:video' }))).toBeNull();
  });

  it('returns null for an NSFW post — source/resolutions are the UNBLURRED original', () => {
    expect(extractPostImage(imagePost({ over_18: true }))).toBeNull();
  });

  it('returns null for junk input rather than throwing', () => {
    for (const junk of [null, undefined, 42, 'post', [], {}]) expect(extractPostImage(junk)).toBeNull();
  });
});

describe('extractPostImage — host safety', () => {
  it('refuses a preview URL that points somewhere other than Reddit', () => {
    expect(extractPostImage(imagePost({
      url: 'https://evil.example.com/x.jpg',
      url_overridden_by_dest: 'https://evil.example.com/x.jpg',
      preview: { enabled: true, images: [{ resolutions: [{ url: 'https://evil.example.com/huge.jpg', width: 1080, height: 483 }] }] },
    }))).toBeNull();
  });

  it('refuses a host that merely CONTAINS a Reddit media host', () => {
    // The allowlist is anchored (^…$) on purpose. Unanchored, every one of these would pass and the
    // server would fetch attacker-chosen bytes and inline them into the card as a data URI.
    for (const host of ['preview.redd.it.evil.com', 'i.redd.it.attacker.net', 'evil-preview.redd.it', 'notpreview.redd.it', 'xi.redd.it']) {
      expect(extractPostImage({
        post_hint: 'image',
        url: `https://${host}/x.jpeg`,
        url_overridden_by_dest: `https://${host}/x.jpeg`,
        is_reddit_media_domain: true,
        preview: { enabled: true, images: [{ resolutions: [{ url: `https://${host}/huge.jpeg?s=1`, width: 1080, height: 483 }] }] },
      })).toBeNull();
    }
  });

  it('refuses a non-https rendition', () => {
    expect(extractPostImage(imagePost({
      url: 'http://i.redd.it/c8wk99m072dh1.jpeg',
      url_overridden_by_dest: 'http://i.redd.it/c8wk99m072dh1.jpeg',
      preview: { enabled: true, images: [{ resolutions: [{ url: 'http://preview.redd.it/x.jpeg?s=1', width: 1080, height: 483 }] }] },
    }))).toBeNull();
  });
});

describe('extractPostImage — direct i.redd.it fallback', () => {
  it('uses the post URL when Reddit sent no preview at all', () => {
    // Dimensions are unknown on this branch (a bare i.redd.it link carries none) — the card measures
    // the decoded image instead.
    expect(extractPostImage(imagePost({ preview: undefined })))
      .toEqual({ url: 'https://i.redd.it/c8wk99m072dh1.jpeg', width: 0, height: 0 });
  });

  it('prefers url_overridden_by_dest over `url` (which is the permalink on some shapes)', () => {
    expect(extractPostImage(imagePost({
      preview: undefined,
      url: 'https://www.reddit.com/r/pics/comments/1uvnonz/a_photo/',
      url_overridden_by_dest: 'https://i.redd.it/other123.png',
    }))?.url).toBe('https://i.redd.it/other123.png');
  });

  it('accepts a hintless post only when the link is itself a reddit-hosted image file', () => {
    const noHint = { is_reddit_media_domain: true, url: 'https://i.redd.it/abc.jpg' };
    expect(extractPostImage(noHint)?.url).toBe('https://i.redd.it/abc.jpg');
    // …and not when it's a link to a page that merely lives on a reddit media domain.
    expect(extractPostImage({ ...noHint, url: 'https://i.redd.it/abc' })).toBeNull();
  });

  it('returns null when the post URL is an image but NOT on a reddit host', () => {
    expect(extractPostImage({ post_hint: 'image', url: 'https://imgur.com/a/b.jpg' })).toBeNull();
  });
});

describe('imageBandRect — the band the card reserves', () => {
  const W = CARD_IMAGE_W;

  it('fills the column for a landscape image', () => {
    // 1320x591 (the r/pics fixture above) -> full width, aspect preserved.
    expect(imageBandRect(1320, 591, W)).toEqual({ dx: 0, w: 928, h: 415 });
  });

  it('fills the column for a moderately tall image that still fits the cap', () => {
    const r = imageBandRect(1080, 1000, W)!;
    expect(r.w).toBe(W);
    expect(r.h).toBeLessThanOrEqual(IMAGE_BAND_MAX_H);
    expect(r.dx).toBe(0);
  });

  it('caps a phone-screenshot aspect by NARROWING it — never by cropping, never by stretching the card', () => {
    // 1170x2532 is a 9:19.5 screenshot: at full column width the band would be ~2009px tall and the
    // card taller than the reel it sits in.
    const r = imageBandRect(1170, 2532, W)!;
    expect(r.h).toBe(IMAGE_BAND_MAX_H);
    expect(r.w).toBeLessThan(W);
    expect(r.w / r.h).toBeCloseTo(1170 / 2532, 2);      // whole image, undistorted
    expect(r.dx).toBe(Math.round((W - r.w) / 2));       // centred in the column
  });

  it('never exceeds the column or the cap, for any aspect', () => {
    for (const [w, h] of [[4284, 5712], [3000, 100], [100, 3000], [1, 1], [928, 900], [1080, 1428]]) {
      const r = imageBandRect(w, h, W)!;
      expect(r.w, `${w}x${h}`).toBeLessThanOrEqual(W);
      expect(r.h, `${w}x${h}`).toBeLessThanOrEqual(IMAGE_BAND_MAX_H);
      expect(r.dx + r.w, `${w}x${h}`).toBeLessThanOrEqual(W);
      // Aspect within 1% — RELATIVE, since rounding a 30:1 band to whole pixels can't be exact.
      expect(Math.abs((r.w / r.h) / (w / h) - 1), `${w}x${h}`).toBeLessThan(0.01);
    }
  });

  it('returns null for a degenerate image, so the card lays out as if there were none', () => {
    for (const [w, h] of [[0, 100], [100, 0], [-5, 100], [NaN, 100], [100, NaN]]) {
      expect(imageBandRect(w, h, W)).toBeNull();
    }
  });
});

// ── inspectPostImage: the REASON, not just the absence ─────────────────────────────────────────────
// extractPostImage collapses every no-image outcome into `null`, which is what let "gallery",
// "NSFW", "text post" and "the download failed" all reach the user as the same silent nothing.
// These lock the reasons in — and, critically, that the reason can never disagree with the image.

describe('inspectPostImage — skip reasons', () => {
  it('reports no skip when it found an image', () => {
    const r = inspectPostImage(imagePost());
    expect(r.image).not.toBeNull();
    expect(r.skip).toBeNull();
  });

  it('names each permanent reason distinctly', () => {
    expect(inspectPostImage(imagePost({ is_gallery: true })).skip).toBe('gallery');
    expect(inspectPostImage(imagePost({ over_18: true })).skip).toBe('nsfw');
    expect(inspectPostImage(imagePost({ is_video: true })).skip).toBe('video');
    expect(inspectPostImage(imagePost({ post_hint: 'hosted:video' })).skip).toBe('video');
    expect(inspectPostImage(imagePost({ post_hint: 'rich:video' })).skip).toBe('video');
  });

  it('calls a post with nothing to find "text", not a failure', () => {
    // This is the healthy majority case; misreporting it would make the app nag on every text thread.
    expect(inspectPostImage({ title: 'Just words', is_self: true, selftext: 'hi' }).skip).toBe('text');
    expect(inspectPostImage(null).skip).toBe('text');
    expect(inspectPostImage('not an object').skip).toBe('text');
  });

  it('calls an external LINK post "text" — its preview is an OG scrape, not the post’s image', () => {
    const link = imagePost({
      post_hint: 'link', is_reddit_media_domain: false,
      url: 'https://example.com/article', url_overridden_by_dest: 'https://example.com/article',
    });
    expect(inspectPostImage(link).skip).toBe('text');
  });

  it('distinguishes "an image post whose ladder yielded nothing" from "no image post"', () => {
    // post_hint says image, but there is no usable rendition AND no direct i.redd.it link to fall back
    // on. That is NOT a text post — reporting it as one would hide a real extraction gap.
    const barren = imagePost({
      preview: { enabled: true, images: [{ source: null, resolutions: [] }] },
      url: 'https://example.com/x', url_overridden_by_dest: 'https://example.com/x',
      is_reddit_media_domain: false,
    });
    const r = inspectPostImage(barren);
    expect(r.image).toBeNull();
    expect(r.skip).toBe('no-rendition');
  });

  it('THE INVARIANT: image and skip are exactly complementary, never both or neither', () => {
    const cases = [
      imagePost(), imagePost({ is_gallery: true }), imagePost({ over_18: true }),
      imagePost({ is_video: true }), { title: 'text only' }, null, undefined, 42,
      imagePost({ preview: undefined }),
      imagePost({ preview: { images: [] } }),
    ];
    for (const [i, c] of cases.entries()) {
      const r = inspectPostImage(c);
      expect(!!r.image, `case ${i}`).toBe(r.skip === null);
    }
  });

  it('stays in lockstep with extractPostImage for every case', () => {
    // The wrapper must never disagree with the inspector — one set of guards is the whole point.
    const cases = [
      imagePost(), imagePost({ is_gallery: true }), imagePost({ over_18: true }),
      imagePost({ is_video: true }), imagePost({ post_hint: 'link', is_reddit_media_domain: false }),
      { title: 'text only' }, null,
    ];
    for (const [i, c] of cases.entries()) {
      expect(extractPostImage(c), `case ${i}`).toEqual(inspectPostImage(c).image);
    }
  });

  it('honours the minWidth argument the same way through both entry points', () => {
    expect(inspectPostImage(imagePost(), 200).image?.width).toBe(extractPostImage(imagePost(), 200)?.width);
    expect(inspectPostImage(imagePost(), 200).image?.width).toBe(216);
  });
});

describe('inspectPostImage — over_18 ordering (regression)', () => {
  it('an NSFW TEXT post is "text", not "nsfw" — it never had an image to skip', () => {
    // over_18 is set on EVERY submission type, so testing it before the isImagePost gate made a plain
    // NSFW story report 'nsfw' — which the flyout renders as "its image is skipped" about a post with
    // no image. r/tifu and r/confession posts are routinely NSFW-tagged, so this nagged on real input.
    const r = inspectPostImage({
      title: 'A story', is_self: true, selftext: 'words', over_18: true,
      is_video: false, is_gallery: false, is_reddit_media_domain: false,
      url: 'https://www.reddit.com/r/confession/comments/abc/a_story/',
    });
    expect(r.image).toBeNull();
    expect(r.skip).toBe('text');
  });

  it('still refuses an NSFW IMAGE post — the safety property is unchanged', () => {
    // The whole reason the guard exists: preview.source is the UNBLURRED original.
    const r = inspectPostImage(imagePost({ over_18: true }));
    expect(r.image).toBeNull();
    expect(r.skip).toBe('nsfw');
    expect(extractPostImage(imagePost({ over_18: true }))).toBeNull();
  });

  it('refuses an NSFW post that reaches the direct i.redd.it fallback too', () => {
    // No preview ladder, so extraction would otherwise fall through to the full-size original.
    const r = inspectPostImage(imagePost({ over_18: true, preview: undefined }));
    expect(r.image).toBeNull();
    expect(r.skip).toBe('nsfw');
  });

  it('an NSFW external LINK post is "text" — its preview was never this post’s image', () => {
    const r = inspectPostImage(imagePost({
      over_18: true, post_hint: 'link', is_reddit_media_domain: false,
      url: 'https://example.com/x', url_overridden_by_dest: 'https://example.com/x',
    }));
    expect(r.skip).toBe('text');
  });
});
