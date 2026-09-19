import { describe, it, expect } from 'vitest';
import { importNotice } from './redditImportNotice';

// The whole point of this module is that a user can tell RETRYABLE apart from PERMANENT. These tests are
// written against that behaviour rather than the exact wording, except where the wording is the feature.

describe('importNotice', () => {
  it('says nothing when the image arrived', () => {
    expect(importNotice({ imageStatus: 'ok' })).toBeNull();
  });

  it('says nothing for a plain text post — the overwhelmingly common case', () => {
    // A false alarm here would fire on almost every import and train the user to ignore the notice.
    expect(importNotice({ imageStatus: 'text' })).toBeNull();
  });

  it('is null-safe for a response with no status at all', () => {
    // Older/other callers, or a route that returns before setting it — must not throw or nag.
    expect(importNotice({})).toBeNull();
    expect(importNotice(null)).toBeNull();
    expect(importNotice(undefined)).toBeNull();
    expect(importNotice({ imageStatus: 'something-new-we-added-later' })).toBeNull();
  });

  describe('retryable — re-importing can genuinely produce a different result', () => {
    it('flags the throttled fallback, and mentions MORE than the image', () => {
      const n = importNotice({ degraded: 'apify-fallback', imageStatus: 'transport-unavailable' });
      expect(n?.retryable).toBe(true);
      // The image is the least of it — the reply tree and scores are gone too. If the message only
      // mentioned the picture the user would accept a badly degraded thread without knowing.
      expect(n?.message).toMatch(/reply tree/i);
      expect(n?.message).toMatch(/scores/i);
    });

    it('flags a failed image download', () => {
      const n = importNotice({ imageStatus: 'fetch-failed' });
      expect(n?.retryable).toBe(true);
    });

    it('flags a fallback-served thread even when `degraded` is missing', () => {
      // Defence in depth: the two markers are set independently in the route, so imageStatus alone
      // must still be enough to explain the absence.
      expect(importNotice({ imageStatus: 'transport-unavailable' })?.retryable).toBe(true);
    });
  });

  describe('permanent — retrying returns the same answer forever', () => {
    // Offering "Re-import" on any of these sends the user round a loop that cannot succeed.
    it.each(['gallery', 'nsfw', 'video', 'no-rendition'])('%s is not retryable', status => {
      const n = importNotice({ imageStatus: status });
      expect(n, status).not.toBeNull();
      expect(n?.retryable, status).toBe(false);
    });

    it('never tells the user to try again in a permanent message', () => {
      for (const status of ['gallery', 'nsfw', 'video', 'no-rendition']) {
        expect(importNotice({ imageStatus: status })?.message, status).not.toMatch(/re-?import|try again/i);
      }
    });

    it('explains the specific reason rather than one generic line', () => {
      // Four distinct causes must not collapse into one message — that's the bug this module exists to fix.
      const msgs = ['gallery', 'nsfw', 'video', 'no-rendition'].map(s => importNotice({ imageStatus: s })!.message);
      expect(new Set(msgs).size).toBe(4);
    });
  });

  it('lets `degraded` outrank a specific image status', () => {
    // A fallback import that ALSO happens to be a gallery is still, first and foremost, degraded —
    // and degraded is the retryable one. Reporting "gallery, not retryable" would strand the user.
    const n = importNotice({ degraded: 'apify-fallback', imageStatus: 'gallery' });
    expect(n?.retryable).toBe(true);
    expect(n?.message).toMatch(/throttled/i);
  });

  it('ignores an unrecognised `degraded` value rather than inventing a message', () => {
    expect(importNotice({ degraded: 'some-future-mode', imageStatus: 'ok' })).toBeNull();
  });
});
