import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { isSafePublicUrl } from '@/lib/http';
import { redditBrowserJson } from '@/lib/redditBrowser';
import { selectComments, type RawCommentNode } from '@/lib/redditComments';
import { inspectPostImage } from '@/lib/redditPostImage';

// Resolve a Reddit thread URL into normalized card data for the Reddit template. Two transports:
// the official OAuth API when REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are configured (a free
// "script" app from reddit.com/prefs/apps — preferred, ToS-clean), else a headless-Chrome session
// that passes Reddit's bot challenge and reads the public .json endpoints (Reddit hard-403s plain
// HTTP clients). Avatars AND the post's image are fetched server-side and inlined as data URIs so the
// canvas renderer never deals with cross-origin images (it draws them, then toBlob()s the canvas for
// export — a tainted canvas throws there and takes the whole export down).

export const runtime = 'nodejs';

const UA = 'web:reels-studio:v1.0 (footage importer)';

const MAX_COMMENTS = 50;      // returned to the client for selection (top-level comments + their direct replies)
const MAX_AVATARS = 12;       // unique authors whose avatar images we inline

// skipAvatars: don't fetch per-author profile pictures. Avatar enrichment fires ~12 profile
// lookups + image downloads per thread, which throttles Reddit and jams the shared browser page
// under bulk import — bulk callers set this and cards fall back to colored initial discs.
// preferApify: use the Apify transport first (separate HTTP call — reliable and non-blocking) rather
// than the headless-browser transport, which is slow and stalls the server under bulk load.
const Schema = z.object({
  url: z.string().min(8).max(2000),
  skipAvatars: z.boolean().optional(),
  preferApify: z.boolean().optional(),
});

/** Why the response does or doesn't carry `post.image`.
 *
 *  This field exists because every no-image outcome used to look IDENTICAL on the wire — an absent
 *  `image` key, HTTP 200, no error — so "this is a text post", "this is a gallery we don't support",
 *  "the download timed out" and "the Apify fallback served this and never even tried" were
 *  indistinguishable to the client and to anyone debugging it.
 *
 *  Only 'fetch-failed' and 'transport-unavailable' are worth retrying; the rest are properties of the
 *  post itself and will return the same answer forever. */
type ImageStatus =
  | 'ok'
  | 'fetch-failed'            // the post HAS an image; downloading it failed (transient — retry)
  | 'transport-unavailable'   // Apify served this thread; that transport carries no media at all
  | 'text' | 'gallery' | 'video' | 'nsfw' | 'no-rendition';   // deterministic, from inspectPostImage

// ── token cache (module scope survives across requests in one server process) ───────────────────
let token: { value: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) throw new ConfigError();
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const json = await res.json() as { access_token: string; expires_in: number };
  token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return token.value;
}

class ConfigError extends Error {}

async function oauthGet(path: string): Promise<unknown> {
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    headers: { Authorization: `Bearer ${await getToken()}`, 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`reddit api ${res.status}`);
  return res.json();
}

/** Transport-agnostic GET: OAuth when configured, else the headless-browser session.
    `path` has no .json suffix (e.g. "/comments/abc123"); `query` is the raw query string. */
async function redditGet(path: string, query: string): Promise<unknown> {
  if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET) {
    return oauthGet(`${path}?${query}`);
  }
  return redditBrowserJson(`${path}.json?${query}`);
}

// ── Apify transport (primary when APIFY_TOKEN is set) ────────────────────────────────────────────
// Pay-per-result actor; returns a flat dataset of one post item + comment items in a single
// synchronous call. Reddit hides vote data from it, so scores are best-effort and often 0 —
// zero scores are mapped to '' so the template hides them instead of rendering "0".
const APIFY_ACTOR = process.env.APIFY_ACTOR ?? 'automation-lab~reddit-scraper';

// NO IMAGE FIELDS, and that is not an oversight: the actor reads Reddit's public RSS/recovery pages,
// which carry no media. A verified run against a genuine i.redd.it photo post came back with
// imageUrls: [], thumbnail: "", domain: "reddit.com", isSelf: true and its own warning that "media
// metadata may be unavailable". Post images are therefore NATIVE-ONLY (see nativeImport); an
// Apify-served thread renders the card without one, which is the same branch a text post takes.
interface ApifyItem {
  type: 'post' | 'comment';
  title?: string; author?: string; subreddit?: string; selfText?: string;
  body?: string; score?: number; numComments?: number; createdAt?: string;
  depth?: number; isSubmitter?: boolean;
}

const isoToEpoch = (iso?: string): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? Date.now() / 1000 : t / 1000;
};

async function apifyImport(threadUrl: string) {
  const res = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${process.env.APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [threadUrl], includeComments: true, maxCommentsPerPost: 60, commentDepth: 4 }),
      signal: AbortSignal.timeout(180_000),
    },
  );
  if (!res.ok) throw new Error(`apify ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const items = await res.json() as ApifyItem[];
  const p = items.find(i => i.type === 'post');
  if (!p?.title) throw new Error('apify returned no post');

  const body = p.selfText && !/^submitted by \/u\//.test(p.selfText) ? plainText(p.selfText) : undefined;
  const comments: OutComment[] = items
    .filter(i => i.type === 'comment')
    .map(c => ({ ...c, cleanBody: plainText(c.body ?? '') }))
    .filter(c => c.author && c.author !== '[deleted]' && c.author !== 'AutoModerator'
      && c.cleanBody && c.cleanBody !== '[removed]' && c.cleanBody !== '[deleted]')
    .slice(0, MAX_COMMENTS)
    .map(c => ({
      user: { name: c.author! },
      body: c.cleanBody,
      timeAgo: timeAgo(isoToEpoch(c.createdAt)),
      score: c.score && c.score > 0 ? fmtScore(c.score) : '',
      depth: Math.max(0, c.depth ?? 0),
      isOP: !!c.isSubmitter,
    }));

  return {
    // The actor scrapes no media, so a thread served from here NEVER has a picture — regardless of
    // whether the post actually has one. Saying so explicitly is what stops it reading as a text post.
    imageStatus: 'transport-unavailable' as ImageStatus,
    post: {
      user: { name: `u/${p.author ?? 'unknown'}` },
      subreddit: p.subreddit ? `r/${p.subreddit}` : undefined,
      timeAgo: timeAgo(isoToEpoch(p.createdAt)),
      title: plainText(p.title),
      body,
      score: p.score && p.score > 0 ? fmtScore(p.score) : '',
      commentCount: p.numComments && p.numComments > 0 ? fmtScore(p.numComments) : '',
    },
    comments,
  };
}

// ── URL → thread id ──────────────────────────────────────────────────────────────────────────────
async function resolveThreadId(raw: string): Promise<string | null> {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.replace(/^www\.|^old\.|^new\.|^np\./, '');
  if (host === 'redd.it') return url.pathname.split('/').filter(Boolean)[0] ?? null;
  if (host !== 'reddit.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const ci = parts.indexOf('comments');
  if (ci >= 0 && parts[ci + 1]) return parts[ci + 1];
  // share links: /r/<sub>/s/<token> — follow the redirect (no auth needed for a 3xx Location)
  if (parts.length >= 3 && parts[2] === 's' && await isSafePublicUrl(raw)) {
    const res = await fetch(raw, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
    const loc = res.headers.get('location');
    if (loc) return resolveThreadId(loc);
  }
  return null;
}

// ── formatting helpers ───────────────────────────────────────────────────────────────────────────
const fmtScore = (n: number): string =>
  n >= 100_000 ? `${Math.round(n / 1000)}K` : n >= 10_000 ? `${(n / 1000).toFixed(1)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

function timeAgo(createdUtc: number): string {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - createdUtc));
  const units: [number, string][] = [[31_536_000, 'y'], [2_592_000, 'mo'], [86_400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [div, label] of units) if (s >= div) return `${Math.floor(s / div)}${label} ago`;
  return 'now';
}

/** Strip the markdown that would read wrong on canvas/narration; keep the words. */
function plainText(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')       // links → label
    .replace(/[*_~^]{1,3}([^*_~^]+)[*_~^]{1,3}/g, '$1')
    .replace(/^&gt;.*$/gm, '')                      // quote lines
    .replace(/&(amp|lt|gt|#x27|#39|quot);/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#x27;': "'", '&#39;': "'", '&quot;': '"' }[m] ?? m))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface RawComment {
  kind: string;
  data: {
    author?: string; body?: string; score?: number; created_utc?: number; depth?: number;
    distinguished?: string | null; stickied?: boolean;
    replies?: { data?: { children?: RawComment[] } } | '';
  };
}

interface OutComment {
  user: { name: string; avatar?: string };
  body: string; timeAgo: string; score: string; depth: number; isOP: boolean;
}

// Flatten a reddit comment listing to top-level comments, each followed by its DIRECT replies (depth 1)
// in order — the picker shows them under a "view replies" expander, and the card renderer nests by depth.
// The listing is fetched with depth=2 so one reply level is available; deeper replies (depth 2+) are
// intentionally dropped (v1 = direct replies only). Selection (which nodes, order, caps) is the tested
// pure selectComments; here we only apply the usable filter + formatting.
const REPLIES_PER_COMMENT = 10;
function flattenComments(children: RawComment[], postAuthor: string): OutComment[] {
  // Clean each body once and reuse it in both the usable check and the output (a WeakMap on the data
  // node; '' is a valid cached value, so guard on `undefined`).
  const cache = new WeakMap<object, string>();
  const clean = (d: RawComment['data']): string => {
    let b = cache.get(d);
    if (b === undefined) { b = plainText(d.body ?? ''); cache.set(d, b); }
    return b;
  };
  const isUsable = (d: RawComment['data']): boolean => {
    const body = clean(d);
    return !(!d.author || d.author === '[deleted]' || d.author === 'AutoModerator'
      || d.stickied || !body || body === '[removed]' || body === '[deleted]');
  };
  return selectComments<RawComment['data']>(children as RawCommentNode[], isUsable, { maxComments: MAX_COMMENTS, repliesPerComment: REPLIES_PER_COMMENT })
    .map(({ data: d, depth }) => ({
      user: { name: d.author! },
      body: clean(d),
      timeAgo: timeAgo(d.created_utc ?? Date.now() / 1000),
      score: fmtScore(d.score ?? 0),
      depth,
      isOP: d.author === postAuthor,
    }));
}

/** Fetch a user's avatar and inline it as a data URI (undefined on any failure — renderer falls
    back to the colored initial disc). */
async function fetchAvatar(name: string): Promise<string | undefined> {
  try {
    const about = await redditGet(`/user/${encodeURIComponent(name)}/about`, 'raw_json=1') as
      { data?: { snoovatar_img?: string; icon_img?: string } };
    const src = about.data?.snoovatar_img || about.data?.icon_img;
    if (!src || !(await isSafePublicUrl(src))) return undefined;
    const res = await fetch(src, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    const type = res.headers.get('content-type') ?? 'image/png';
    if (!type.startsWith('image/')) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > 300_000) return undefined;   // keep the response payload sane
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch { return undefined; }
}

// A post image is a photo, not a 2KB avatar. Reddit's pre-signed 1080 rendition measures 50-200 KB, so
// this cap is a guard rail (it only bites on the direct-i.redd.it fallback, where the original can be
// megabytes) rather than the normal path — over cap simply means no image.
const MAX_POST_IMAGE_BYTES = 1_000_000;

/** Inline a post's image as a data URI — the same trick as fetchAvatar, and for the same reason: the
    card is drawn to a canvas and toBlob()'d for export, and a cross-origin drawImage would TAINT that
    canvas and make toBlob throw. Every failure path returns undefined, i.e. "render the card without
    the image", which is the required behaviour: never break the export over a picture. */
async function fetchPostImage(src: string): Promise<string | undefined> {
  try {
    if (!(await isSafePublicUrl(src))) {
      // Loud for the same reason as the non-200 below. isSafePublicUrl does an uncached dns.lookup and
      // FAILS CLOSED, so a transient EAI_AGAIN — likely when 13 lookups contend for libuv's 4 threads —
      // is indistinguishable here from a genuinely unsafe host. Silence made both read as "no image".
      console.warn(`[reddit] post image host rejected or unresolvable: ${src.slice(0, 120)}`);
      return undefined;
    }
    // No Accept header, exactly like fetchAvatar: Reddit then serves image/jpeg rather than webp.
    const res = await fetch(src, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      // Loud on purpose. The classic failure here is an HTML-escaped preview URL (&amp; breaks the s=
      // HMAC → 403), and swallowing it silently reads as "images just never appear".
      console.warn(`[reddit] post image ${res.status} — card renders without it: ${src.slice(0, 120)}`);
      return undefined;
    }
    const type = res.headers.get('content-type') ?? 'image/jpeg';
    if (!type.startsWith('image/')) {
      console.warn(`[reddit] post image served ${type}, not an image — rendering without it: ${src.slice(0, 120)}`);
      return undefined;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_POST_IMAGE_BYTES) {
      console.warn(`[reddit] post image is ${Math.round(buf.byteLength / 1024)}KB — over cap, rendering without it`);
      return undefined;
    }
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch (e) {
    // The 15s AbortSignal.timeout, ECONNRESET and body-read aborts all land here. This was the last
    // mute exit in the file: it turns a transient network failure into a card that silently has no
    // picture, which is the single hardest version of this bug to diagnose from the outside.
    console.warn(`[reddit] post image fetch failed (${e instanceof Error ? e.message : e}): ${src.slice(0, 120)}`);
    return undefined;
  }
}

export async function POST(request: NextRequest) {
  const parsed = Schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'url is required' }, { status: 400 });

  try {
    const threadId = await resolveThreadId(parsed.data.url.trim());
    if (!threadId) {
      return NextResponse.json({ error: 'That doesn’t look like a Reddit thread link.' }, { status: 400 });
    }

    // Transport order: native (oauth/browser) first — it carries the real comment TREE, scores and
    // avatars, while the Apify actor flattens every comment to depth 0 and hides votes. Apify is
    // the fallback for environments without Chrome, or the primary with REDDIT_TRANSPORT=apify.
    const skipAvatars = parsed.data.skipAvatars === true;
    // Apify first when the caller prefers it (bulk) or REDDIT_TRANSPORT=apify; else native first.
    const apifyFirst = (parsed.data.preferApify === true || process.env.REDDIT_TRANSPORT === 'apify') && !!process.env.APIFY_TOKEN;
    if (apifyFirst) {
      try { return NextResponse.json(await apifyWithAvatars(threadId, skipAvatars)); }
      catch (e) { console.error('[reddit] apify transport failed, trying native:', e); }
    }
    try {
      return NextResponse.json(await nativeImport(threadId, skipAvatars));
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      if (!apifyFirst && process.env.APIFY_TOKEN) {
        console.error('[reddit] native transport failed, falling back to apify:', e);
        // `degraded` is the client's only way to know this happened. The fallback returns HTTP 200 with a
        // perfectly well-formed thread, but a SUBSTANTIALLY worse one: no post image, no reply tree (every
        // comment flattened to depth 0), no scores, and a different comment set. Without this marker the
        // user just sees a thread that quietly lost its picture and has no reason to retry.
        return NextResponse.json({ ...await apifyWithAvatars(threadId, skipAvatars), degraded: 'apify-fallback' as const });
      }
      throw e;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      return NextResponse.json(
        { error: 'Reddit import isn’t configured — add REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to .env.local (create a free script app at reddit.com/prefs/apps).' },
        { status: 501 },
      );
    }
    console.error('[reddit]', e);
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    return NextResponse.json({ error: timedOut ? 'Reddit took too long — try again.' : 'Couldn’t fetch that thread from Reddit.' }, { status: 502 });
  }
}

/** Apify thread import + best-effort avatar enrichment over the native transport (the actor
    doesn't scrape user profiles). Enrichment failure just leaves the initial discs. */
async function apifyWithAvatars(threadId: string, skipAvatars = false) {
  const data = await apifyImport(`https://www.reddit.com/comments/${threadId}/`);
  if (skipAvatars) return data;
  try {
    const names = [...new Set([
      data.post.user.name.replace(/^u\//, ''),
      ...data.comments.map(c => c.user.name),
    ])].slice(0, MAX_AVATARS);
    const avatars = new Map(await Promise.all(names.map(async n => [n, await fetchAvatar(n)] as const)));
    const postAuthor = data.post.user.name.replace(/^u\//, '');
    (data.post.user as { avatar?: string }).avatar = avatars.get(postAuthor);
    for (const c of data.comments) c.user.avatar = avatars.get(c.user.name) ?? undefined;
  } catch (e) {
    console.warn('[reddit] avatar enrichment unavailable:', e instanceof Error ? e.message : e);
  }
  return data;
}

/** Full-fidelity import over oauth/browser: real comment tree, scores, and avatars. */
async function nativeImport(threadId: string, skipAvatars = false) {
  const listing = await redditGet(`/comments/${threadId}`, 'limit=100&depth=2&raw_json=1&sort=top') as
      [{ data: { children: [{ data: Record<string, unknown> }] } }, { data: { children: RawComment[] } }];
    const p = listing[0]?.data?.children?.[0]?.data as {
      author?: string; title?: string; selftext?: string; score?: number;
      num_comments?: number; created_utc?: number; subreddit_name_prefixed?: string;
    } | undefined;
    if (!p?.title) throw new Error('thread unreadable — deleted or private?');

    const comments = flattenComments(listing[1]?.data?.children ?? [], p.author ?? '');

    // The post's image, inlined so the card renderer only ever sees same-origin bytes. Deliberately NOT
    // gated on skipAvatars: that flag exists to avoid the ~12 /user/about lookups that throttle Reddit
    // and jam the shared browser page, whereas this is ONE plain server-side fetch of ~100KB to a CDN
    // that needs no auth — it never touches the puppeteer page, so bulk keeps its images.
    // Started here and awaited after the avatars so the two overlap — it's the only outbound work in
    // this function that doesn't go through Reddit's rate-limited JSON endpoints.
    const { image: found, skip } = inspectPostImage(p);
    const imagePending = found ? fetchPostImage(found.url) : Promise.resolve(undefined);

    // avatars: post author first, then commenters in order, capped (skipped for bulk — the
    // per-author lookups are what throttle Reddit and jam the shared browser page under load).
    const avatars = new Map<string, string | undefined>();
    if (!skipAvatars) {
      const names = [...new Set([p.author, ...comments.map(c => c.user.name)])].filter((n): n is string => !!n && n !== '[deleted]').slice(0, MAX_AVATARS);
      for (const [n, a] of await Promise.all(names.map(async n => [n, await fetchAvatar(n)] as const))) avatars.set(n, a);
      for (const c of comments) c.user.avatar = avatars.get(c.user.name) ?? undefined;
    }
    const image = await imagePending;
    // `found && !image` is the ONLY retryable case: the post has a picture and the download of it failed.
    // Everything else is a property of the post, so "try again" would be a lie.
    const imageStatus: ImageStatus = image ? 'ok' : found ? 'fetch-failed' : (skip ?? 'text');

    return {
      imageStatus,
      post: {
        user: { name: `u/${p.author ?? 'unknown'}`, avatar: p.author ? avatars.get(p.author) : undefined },
        subreddit: p.subreddit_name_prefixed,
        timeAgo: timeAgo(p.created_utc ?? Date.now() / 1000),
        title: plainText(p.title),
        body: p.selftext ? plainText(p.selftext) : undefined,
        score: fmtScore(p.score ?? 0),
        commentCount: fmtScore(p.num_comments ?? 0),
        image,
      },
      comments,
    };
}
