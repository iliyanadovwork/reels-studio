import { describe, it, expect } from 'vitest';
import { reelPreload } from './videoPreload';

// A saved Reddit reel whose background is an R2 library clip: RedditCanvas renders it from
// bestVideoUrl(footageVideoData(url)), i.e. a same-origin /api/proxy stream URL.
const FOOTAGE_SRC = '/api/proxy?stream=1&url=https%3A%2F%2Fpub-63dabe78ed9342c5a94e50b584141711.r2.dev%2Fsegments%2Fvideo1.18.mp4';
const CDN_SRC = 'https://cdn.example.com/reel.mp4?oe=deadbeef';
const UPLOAD_SRC = 'blob:http://localhost:3000/6f1a-2b3c';

describe('reelPreload', () => {
  // THE REGRESSION. A carded Reddit reel is not eager, and its footage src is an http proxy URL, not a
  // blob — the exact combination that used to render "none". With "none" the element fetches nothing at
  // all: readyState stays 0, so the draw loop's readyState>=2 guard never draws a frame and the reel is a
  // black band under its card, permanently (the timeline that would heal it needs a duration that only
  // `loadedmetadata` can supply, and `loadedmetadata` never fires). "metadata" is the floor.
  it('still loads metadata for a deferred remote footage clip — never "none"', () => {
    expect(reelPreload(FOOTAGE_SRC, { eager: false })).toBe('metadata');
  });

  it('defers a remote CDN link the same way', () => {
    expect(reelPreload(CDN_SRC, { eager: false })).toBe('metadata');
  });

  // The deferral is about not pulling ~100MB over the network. Local bytes cost nothing to read, so they
  // decode a real first frame with no poster seek needed.
  it('loads local bytes eagerly', () => {
    expect(reelPreload(UPLOAD_SRC, { eager: false })).toBe('auto');
    expect(reelPreload('data:video/mp4;base64,AAAA', { eager: false })).toBe('auto');
    expect(reelPreload('BLOB:http://x/y', { eager: false })).toBe('auto');   // scheme match is case-insensitive
  });

  // A reel with no card has nothing to look at while it waits, so it opts out of the deferral entirely.
  it('honours eager for a remote clip', () => {
    expect(reelPreload(FOOTAGE_SRC, { eager: true })).toBe('auto');
    expect(reelPreload(CDN_SRC, { eager: true })).toBe('auto');
  });

  // Only a src that IS local bytes counts. A remote src that merely mentions one in its query (the proxy
  // carries the target URL there) is still a network fetch, so it must stay deferred.
  it('matches the local-bytes scheme at the start, not anywhere in the src', () => {
    expect(reelPreload('/api/proxy?stream=1&url=blob%3Ax', { eager: false })).toBe('metadata');
    expect(reelPreload('/api/proxy?stream=1&url=blob:x', { eager: false })).toBe('metadata');
    expect(reelPreload('https://cdn.example.com/data:video.mp4', { eager: false })).toBe('metadata');
  });

  it('treats a missing src as deferred rather than throwing', () => {
    expect(reelPreload(null)).toBe('metadata');
    expect(reelPreload(undefined)).toBe('metadata');
    expect(reelPreload('')).toBe('metadata');
    expect(reelPreload(FOOTAGE_SRC)).toBe('metadata');   // opts omitted === not eager
  });

  // The invariant behind all of the above, stated once: whatever the inputs, the element is allowed to
  // read at least the moov box. Any future value of "don't bother loading" reintroduces the black reel.
  it('never returns "none" for any input combination', () => {
    const srcs = [FOOTAGE_SRC, CDN_SRC, UPLOAD_SRC, 'data:video/mp4;base64,AA', '', null, undefined,
      'https://pub-63dabe78ed9342c5a94e50b584141711.r2.dev/segments/video1.18.mp4', '/api/proxy?stream=1&url='];
    for (const src of srcs) {
      for (const eager of [true, false, undefined]) {
        const got = reelPreload(src, { eager });
        expect(['auto', 'metadata'], `src=${String(src)} eager=${String(eager)}`).toContain(got);
      }
    }
  });
});
