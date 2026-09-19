import type { RedditThreadEdits } from '@/app/components/TikTokCanvas/types';
import { splitParagraphs } from '@/lib/redditThreadEdits';

// Pure parse/validate for the bulk builder's PERSISTED picking state (localStorage 'bulk:threads'). This
// exists because losing this state once wiped a user's in-progress picks — so it's load-bearing and
// unit-tested. Selections are stored/loaded as arrays (JSON has no Set); the component wraps them in Sets.

export interface StoredThread<P, C> {
  url: string;
  post: P;
  comments: C[];
  paragraphs: string[];
  selectedComments: number[];
  selectedParas: number[];
  edits: RedditThreadEdits;
  builtSig?: string;      // signature of the picks+edits when a reel was last built from this thread (undefined = never built)
  builtReelId?: string;   // id of the reel that build produced — re-Build overwrites it in place; deleting it re-arms the thread
}

const nonNegInts = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n >= 0) : [];

/** Validate persisted threads. PER-ENTRY isolation: a malformed (or throwing) entry is dropped, never
    the whole batch. Generic over the post/comment shape (the caller supplies its concrete types). */
export function parseStoredThreads<P, C>(raw: unknown): StoredThread<P, C>[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t): StoredThread<P, C>[] => {
    try {
      const o = t as Partial<StoredThread<P, C>> | null;
      const post = o?.post as { title?: unknown; body?: unknown } | undefined;
      if (!o || typeof o.url !== 'string' || !post || typeof post.title !== 'string') return [];
      return [{
        url: o.url,
        post: o.post as P,
        comments: Array.isArray(o.comments) ? (o.comments as C[]) : [],
        paragraphs: Array.isArray(o.paragraphs) ? o.paragraphs : splitParagraphs(typeof post.body === 'string' ? post.body : ''),
        selectedComments: nonNegInts(o.selectedComments),
        selectedParas: nonNegInts(o.selectedParas),
        edits: o.edits && typeof o.edits === 'object' && !Array.isArray(o.edits) ? (o.edits as RedditThreadEdits) : {},
        ...(typeof o.builtSig === 'string' ? { builtSig: o.builtSig } : {}),
        ...(typeof o.builtReelId === 'string' ? { builtReelId: o.builtReelId } : {}),
      }];
    } catch { return []; }
  });
}

/** Serialize threads for storage — selections as arrays. Keeps the on-disk shape in one place with the
    parser so they can't drift.

    The post's inlined `image` is DROPPED here, and only here: it's a ~100-150KB data URI against a ~5MB
    localStorage quota, so a few dozen threads would throw QuotaExceededError and take the user's
    in-progress picks with them (the failure this file exists to prevent). The in-memory thread keeps
    its image, so building from the picks in this session still renders it; a thread restored after a
    reload just builds a card without one, and re-importing brings it back. */
export function serializeThreads<P, C>(threads: Array<{
  url: string; post: P; comments: C[]; paragraphs: string[];
  selectedComments: Iterable<number>; selectedParas: Iterable<number>; edits: RedditThreadEdits; builtSig?: string; builtReelId?: string;
}>): string {
  return JSON.stringify(threads.map(t => ({
    url: t.url, post: stripPostImage(t.post), comments: t.comments, paragraphs: t.paragraphs,
    selectedComments: [...t.selectedComments], selectedParas: [...t.selectedParas], edits: t.edits, builtSig: t.builtSig, builtReelId: t.builtReelId,
  })));
}

/** The post minus its inlined image — untouched (and not copied) when there is none. */
function stripPostImage<P>(post: P): P {
  if (!post || typeof post !== 'object' || !('image' in post)) return post;
  const rest = { ...(post as object) } as P & { image?: unknown };
  delete rest.image;
  return rest;
}
