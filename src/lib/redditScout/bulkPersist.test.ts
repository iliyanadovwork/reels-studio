import { describe, it, expect } from 'vitest';
import { parseStoredThreads, serializeThreads } from './bulkPersist';

// Expectations from the contract: restore must be TOTAL (never throw) and PER-ENTRY isolated (one bad
// entry never nukes the batch — the whole point, since this state is a user's picking work), while
// dropping only genuinely-malformed entries. Selections round-trip through arrays.

type P = { title: string; body?: string };
type C = { body: string };

const valid = {
  url: 'https://reddit.com/r/x/comments/1/a/', post: { title: 'T', body: 'p one\n\np two' },
  comments: [{ body: 'c0' }], paragraphs: ['p one', 'p two'],
  selectedComments: [0], selectedParas: [1], edits: { title: 'edited' },
};

describe('parseStoredThreads', () => {
  it('round-trips a valid entry', () => {
    const [t] = parseStoredThreads<P, C>([valid]);
    expect(t).toMatchObject({ url: valid.url, selectedComments: [0], selectedParas: [1], edits: { title: 'edited' } });
    expect(t.paragraphs).toEqual(['p one', 'p two']);
  });

  it('PER-ENTRY isolation: one malformed entry is dropped, the valid ones survive', () => {
    const out = parseStoredThreads<P, C>([valid, null, {}, { url: 'x' }, { post: { title: 'no url' } }, valid]);
    expect(out).toHaveLength(2);   // both copies of `valid`; the 4 bad entries dropped, batch NOT nuked
  });

  it('a non-string post.body with missing paragraphs does NOT throw (would once have nuked the batch)', () => {
    const bad = { url: 'https://redd.it/2', post: { title: 'T', body: 42 } };   // no paragraphs, non-string body
    const out = parseStoredThreads<P, C>([bad, valid]);
    expect(out).toHaveLength(2);
    expect(out[0].paragraphs).toEqual([]);   // derived safely from a non-string body
  });

  it('coerces/repairs internals: non-array comments → [], junk selection indices filtered, bad edits → {}', () => {
    const messy = {
      url: 'https://redd.it/3', post: { title: 'T' },
      comments: 'nope', selectedComments: [0, -1, 2.5, 'x', 3], selectedParas: null, edits: [1, 2],
    };
    const [t] = parseStoredThreads<P, C>([messy]);
    expect(t.comments).toEqual([]);
    expect(t.selectedComments).toEqual([0, 3]);   // negatives / floats / non-numbers dropped
    expect(t.selectedParas).toEqual([]);
    expect(t.edits).toEqual({});                   // an array is not a valid edits object
  });

  it('non-array / junk root → [] (never throws)', () => {
    expect(parseStoredThreads<P, C>(null)).toEqual([]);
    expect(parseStoredThreads<P, C>('nope')).toEqual([]);
    expect(parseStoredThreads<P, C>({})).toEqual([]);
  });
});

describe('serializeThreads ↔ parseStoredThreads round-trip', () => {
  it('Sets serialize as arrays and parse back to the same arrays', () => {
    const threads = [{
      url: valid.url, post: { title: 'T', body: 'b' } as P, comments: [{ body: 'c' }] as C[],
      paragraphs: ['b'], selectedComments: new Set([2, 0]), selectedParas: new Set([1]), edits: {},
    }];
    const restored = parseStoredThreads<P, C>(JSON.parse(serializeThreads(threads)));
    expect(restored[0].selectedComments).toEqual([2, 0]);
    expect(restored[0].selectedParas).toEqual([1]);
  });

  it('drops the post image — a ~100KB data URI per thread would blow the localStorage quota', () => {
    // The failure this guards is not "the image is missing", it's QuotaExceededError taking the user's
    // whole picking session with it. Everything else about the post must still round-trip.
    const image = `data:image/jpeg;base64,${'A'.repeat(200_000)}`;
    const threads = [{
      url: valid.url, post: { title: 'T', body: 'b', image } as unknown as P, comments: [] as C[],
      paragraphs: ['b'], selectedComments: new Set([0]), selectedParas: new Set<number>(), edits: {},
    }];
    const json = serializeThreads(threads);
    expect(json).not.toContain('AAAA');
    expect(json.length).toBeLessThan(1000);
    const [t] = parseStoredThreads<P, C>(JSON.parse(json));
    expect(t.post).toEqual({ title: 'T', body: 'b' });
    // …and the caller's own object is NOT mutated — the in-memory thread still builds a card with it.
    expect((threads[0].post as unknown as { image?: string }).image).toBe(image);
  });

  it('builtSig + builtReelId survive a round-trip (a built thread stays built after reload)', () => {
    const threads = [{
      url: valid.url, post: { title: 'T' } as P, comments: [] as C[], paragraphs: [],
      selectedComments: new Set([0]), selectedParas: new Set<number>(), edits: {},
      builtSig: 'sig-abc', builtReelId: 'reel-123',
    }];
    const [t] = parseStoredThreads<P, C>(JSON.parse(serializeThreads(threads)));
    expect(t.builtSig).toBe('sig-abc');
    expect(t.builtReelId).toBe('reel-123');
  });
});

describe('build-tracking fields (builtSig / builtReelId)', () => {
  it('a never-built thread parses with NEITHER key present (so isBuilt reads it as un-built, not falsely built)', () => {
    const [t] = parseStoredThreads<P, C>([valid]);   // `valid` carries no builtSig/builtReelId
    expect('builtSig' in t).toBe(false);
    expect('builtReelId' in t).toBe(false);
  });

  it('a non-string builtSig/builtReelId is dropped (corrupt storage can never fabricate a built stamp)', () => {
    const [t] = parseStoredThreads<P, C>([{ ...valid, builtSig: 42, builtReelId: { id: 'x' } }]);
    expect('builtSig' in t).toBe(false);
    expect('builtReelId' in t).toBe(false);
  });

  it('round-trips a thread that built one field but not the other (stamped sig, reel deleted → id cleared)', () => {
    // Defensive: the two fields are independent in storage; a half-set state must not corrupt the other.
    const threads = [{
      url: valid.url, post: { title: 'T' } as P, comments: [] as C[], paragraphs: [],
      selectedComments: new Set<number>(), selectedParas: new Set<number>(), edits: {},
      builtSig: 'sig-only', builtReelId: undefined,
    }];
    const [t] = parseStoredThreads<P, C>(JSON.parse(serializeThreads(threads)));
    expect(t.builtSig).toBe('sig-only');
    expect('builtReelId' in t).toBe(false);
  });
});
