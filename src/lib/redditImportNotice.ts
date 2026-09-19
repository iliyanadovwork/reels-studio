// Turns /api/reddit's `degraded` + `imageStatus` into the one sentence a user can act on.
//
// Why this exists: the route can return HTTP 200 with a perfectly well-formed thread that is quietly
// missing its picture — because Reddit throttled the good transport and the fallback carries no media,
// or because the image download itself failed. Both used to be invisible, so the app looked broken and
// the only "fix" anyone could suggest was a hard refresh, which does nothing for either.
//
// The single most important distinction below is RETRYABLE vs NOT. Telling someone to try again when
// the post is a gallery wastes their time forever; NOT telling them when it was a throttle wastes the
// one action that actually works.

/** Mirrors the route's own union. Kept structural (plain strings) so the client never imports server code. */
export type ImageStatus =
  | 'ok'
  | 'fetch-failed'
  | 'transport-unavailable'
  | 'text' | 'gallery' | 'video' | 'nsfw' | 'no-rendition';

export interface ImportOutcome {
  /** Set by the route when the native transport failed and Apify served the thread instead. */
  degraded?: string;
  imageStatus?: string;
}

export interface ImportNotice {
  message: string;
  /** True when re-importing has a real chance of a better result. Drives "Re-import" affordances. */
  retryable: boolean;
}

/**
 * The notice for an import, or null when there is genuinely nothing to say.
 *
 * `degraded` outranks `imageStatus`: a fallback-served thread always reports
 * `transport-unavailable`, but the missing image is the least of it — the reply tree, the scores and
 * the comment set are all degraded too, and that's what the user needs to hear.
 */
export function importNotice(res: ImportOutcome | null | undefined): ImportNotice | null {
  if (!res) return null;

  if (res.degraded === 'apify-fallback') {
    return {
      message:
        'Reddit throttled the full import, so this came from the fallback — no post image, no reply '
        + 'tree, and no scores. Re-import in a minute for the complete thread.',
      retryable: true,
    };
  }

  switch (res.imageStatus) {
    // The post HAS a picture and fetching it failed. The only status where "try again" is honest.
    case 'fetch-failed':
      return { message: 'The post’s image couldn’t be downloaded — the card renders without it. Re-import to try again.', retryable: true };
    // Reached only if `degraded` is somehow absent; still better than silence.
    case 'transport-unavailable':
      return { message: 'This thread came from the fallback transport, which carries no images. Re-import to try for the picture.', retryable: true };
    // Everything below is a property of the POST. Retrying returns the same answer forever, so none of
    // these offer it — they exist to explain an absence, not to invite a second attempt.
    case 'gallery':
      return { message: 'This post is an image gallery, which isn’t supported yet — the card renders as text.', retryable: false };
    case 'nsfw':
      return { message: 'This post is marked NSFW, so its image is skipped.', retryable: false };
    case 'video':
      return { message: 'This post is a video — only photos can go on the card.', retryable: false };
    case 'no-rendition':
      return { message: 'Reddit served no usable size for this post’s image, so the card renders as text.', retryable: false };
    // 'ok' (it worked) and 'text' (nothing to find) are the healthy cases — say nothing at all.
    default:
      return null;
  }
}
