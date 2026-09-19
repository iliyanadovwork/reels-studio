import { describe, it, expect } from 'vitest';
import { shouldPersistBytes, shouldRestoreBytes, styleKeepsOwnVideo } from './reelBytes';
import { MAX_UPLOAD_BYTES } from './videoIngest';

// A saved row reduced to what this module reads.
const row = (url: string, styleId?: string) => ({ url, framing: styleId ? { styleId } : {} });

describe('styleKeepsOwnVideo', () => {
  it('is commentary only — Reddit footage is library-backed and re-fetchable', () => {
    expect(styleKeepsOwnVideo('commentary')).toBe(true);
    expect(styleKeepsOwnVideo('reddit')).toBe(false);
    expect(styleKeepsOwnVideo('')).toBe(false);
  });
});

describe('shouldPersistBytes', () => {
  // Pre-existing contract, unchanged: an uploaded file exists nowhere else, so not storing it loses the
  // video on reload — true for every style, including Reddit.
  it('stores an upload whatever the style', () => {
    expect(shouldPersistBytes({ styleId: 'commentary', isUpload: true })).toBe(true);
    expect(shouldPersistBytes({ styleId: 'reddit', isUpload: true })).toBe(true);
  });

  // The new part: a resolved commentary link is a signed, expiring CDN URL, so the reel has to own a copy.
  it('stores a fetched link for commentary', () => {
    expect(shouldPersistBytes({ styleId: 'commentary', isUpload: false })).toBe(true);
  });

  // The unchanged part: Reddit footage re-fetches from R2 forever, and the clips are ~100 MB each.
  it('does NOT store a fetched link for Reddit', () => {
    expect(shouldPersistBytes({ styleId: 'reddit', isUpload: false })).toBe(false);
    expect(shouldPersistBytes({ styleId: '', isUpload: false })).toBe(false);
  });

  it('stores a blob right at the ceiling but not one past it', () => {
    expect(shouldPersistBytes({ styleId: 'commentary', isUpload: true, bytes: MAX_UPLOAD_BYTES })).toBe(true);
    expect(shouldPersistBytes({ styleId: 'commentary', isUpload: true, bytes: MAX_UPLOAD_BYTES + 1 })).toBe(false);
  });

  it('refuses a blob whose size makes no sense, rather than writing it', () => {
    for (const bytes of [0, -1, NaN, Infinity]) {
      expect(shouldPersistBytes({ styleId: 'commentary', isUpload: true, bytes }), String(bytes)).toBe(false);
    }
  });

  it('decides without a size when there isn’t one yet', () => {
    expect(shouldPersistBytes({ styleId: 'commentary', isUpload: false, bytes: null })).toBe(true);
    expect(shouldPersistBytes({ styleId: 'reddit', isUpload: false, bytes: undefined })).toBe(false);
  });
});

describe('shouldRestoreBytes', () => {
  // Exactly today's behaviour — a row with no link has always been an upload, and is read back from
  // IndexedDB. A legacy grid is nothing but rows like these plus Reddit links.
  it('reads back a row with no link, in any workspace', () => {
    expect(shouldRestoreBytes(row(''), 'reddit')).toBe(true);
    expect(shouldRestoreBytes(row('   '), 'reddit')).toBe(true);
    expect(shouldRestoreBytes(row(''), 'commentary')).toBe(true);
    expect(shouldRestoreBytes({ framing: {} }, 'reddit')).toBe(true);
  });

  // The regression this whole change exists to prevent: a linked commentary reel must not depend on its
  // (expiring) link to play.
  it('reads back a LINKED commentary row', () => {
    expect(shouldRestoreBytes(row('https://cdn.example/v.mp4?oe=6899AABB', 'commentary'), 'commentary')).toBe(true);
  });

  // Reddit is untouched: its linked rows re-fetch from the library exactly as before.
  it('does NOT read back a linked Reddit row', () => {
    expect(shouldRestoreBytes(row('https://r2.example/footage/clip.mp4', 'reddit'), 'reddit')).toBe(false);
  });

  // An untagged row is a legacy Reddit reel (reelPartition's rule) — it must keep re-fetching.
  it('treats an untagged linked row in the Reddit workspace as Reddit', () => {
    expect(shouldRestoreBytes(row('https://r2.example/footage/clip.mp4'), 'reddit')).toBe(false);
  });

  // A reel created in this workspace isn't tagged until the next save, so it is resolved the way that
  // save will tag it — otherwise a brand-new commentary reel would be read as Reddit's and skipped.
  it('resolves an untagged row the way the next save will tag it', () => {
    expect(shouldRestoreBytes(row('https://cdn.example/v.mp4'), 'commentary')).toBe(true);
  });

  // A tag always wins over the workspace: another style's row must not change meaning by being read here.
  it('never lets the active workspace override an explicit tag', () => {
    expect(shouldRestoreBytes(row('https://r2.example/clip.mp4', 'reddit'), 'commentary')).toBe(false);
    expect(shouldRestoreBytes(row('https://cdn.example/v.mp4', 'commentary'), 'reddit')).toBe(true);
  });

  it('has nothing to read back for a missing row', () => {
    expect(shouldRestoreBytes(null, 'commentary')).toBe(false);
    expect(shouldRestoreBytes(undefined, 'commentary')).toBe(false);
  });
});
