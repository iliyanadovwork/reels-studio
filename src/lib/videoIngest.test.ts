import { describe, it, expect } from 'vitest';
import {
  MAX_UPLOAD_BYTES, formatBytes, uploadSizeError, exportCodecError, UNDEMUXABLE_CONTAINER_NAMES,
  type ExportProbe,
} from './videoIngest';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** A probe of a file that WOULD export: H.264 in an MP4, decodable. Tests override one field at a time. */
const probe = (over: Partial<ExportProbe> = {}): ExportProbe => ({
  container: 'MP4',
  hasVideoTrack: true,
  videoCodec: 'avc',
  codecString: 'avc1.640028',
  decodable: true,
  ...over,
});

describe('formatBytes', () => {
  it('climbs the 1024-based ladder', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * MB)).toBe('5 MB');
    expect(formatBytes(2 * GB)).toBe('2.0 GB');
  });

  // Each unit switches AT its own boundary, and rounds rather than truncates. Both were unpinned: a
  // `>` boundary printed a 1 MB file as "1024 KB", and a floor turned 1.5 KB into "1 KB".
  it('switches unit exactly at each boundary', () => {
    expect(formatBytes(1023)).toBe('1023 bytes');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(MB)).toBe('1 MB');
    expect(formatBytes(GB)).toBe('1.0 GB');
  });

  it('rounds to the nearest unit rather than truncating', () => {
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(1.6 * MB)).toBe('2 MB');
  });

  it('states the limit as exactly "500 MB" — the number the guard is documented with', () => {
    expect(formatBytes(MAX_UPLOAD_BYTES)).toBe('500 MB');
  });

  // The MB branch rounds before the unit is chosen, so a size just under 1 GB must not print as a
  // nonsense "1024 MB" in the same sentence as a "500 MB" limit.
  it('promotes to GB rather than rounding up to 1024 MB', () => {
    expect(formatBytes(1023.7 * MB)).toBe('1.0 GB');
    expect(formatBytes(1023.4 * MB)).toBe('1023 MB');
  });

  it('never prints a negative or NaN size', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(-5)).toBe('0 bytes');
    expect(formatBytes(NaN)).toBe('0 bytes');
  });
});

describe('uploadSizeError', () => {
  it('accepts a file at exactly the limit', () => {
    expect(uploadSizeError(MAX_UPLOAD_BYTES)).toBeNull();
    expect(uploadSizeError(MAX_UPLOAD_BYTES - 1)).toBeNull();
    expect(uploadSizeError(0)).toBeNull();
  });

  it('rejects one byte over', () => {
    expect(uploadSizeError(MAX_UPLOAD_BYTES + 1)).not.toBeNull();
  });

  // "Too large" alone leaves the user guessing whether they missed by 10 MB or by 2 GB.
  it('names the ACTUAL size and the limit', () => {
    const msg = uploadSizeError(1.5 * GB);
    expect(msg).toContain('1.5 GB');
    expect(msg).toContain('500 MB');
  });

  it('tells the user what to do about it', () => {
    expect(uploadSizeError(2 * GB)!.toLowerCase()).toMatch(/trim|compress/);
  });

  // A Blob with an unreadable size must not be refused — see the module's accept-on-unknown rule.
  it('accepts a size it cannot read', () => {
    expect(uploadSizeError(NaN)).toBeNull();
    expect(uploadSizeError(Infinity)).toBeNull();
  });
});

describe('exportCodecError', () => {
  it('accepts H.264 in an MP4', () => {
    expect(exportCodecError(probe())).toBeNull();
  });

  // mp4box parses ISOBMFF, which QuickTime is — a .mov with an avc1 track demuxes and exports.
  it('accepts H.264 in a QuickTime container', () => {
    expect(exportCodecError(probe({ container: 'QuickTime File Format' }))).toBeNull();
  });

  it('rejects every non-AVC codec, naming it', () => {
    expect(exportCodecError(probe({ videoCodec: 'hevc', codecString: 'hvc1.1.6.L93.B0' }))).toContain('HEVC');
    expect(exportCodecError(probe({ videoCodec: 'av1', codecString: 'av01.0.05M.08' }))).toContain('AV1');
    expect(exportCodecError(probe({ videoCodec: 'vp9', container: 'WebM', codecString: 'vp09.00.10.08' }))).toContain('VP9');
    expect(exportCodecError(probe({ videoCodec: 'vp8', container: 'WebM', codecString: null }))).toContain('VP8');
    expect(exportCodecError(probe({ videoCodec: 'prores', container: 'QuickTime File Format', codecString: null }))).toContain('ProRes');
  });

  it('says what to do, not just what failed', () => {
    const msg = exportCodecError(probe({ videoCodec: 'hevc', codecString: 'hvc1.1.6.L93.B0' }))!;
    expect(msg).toContain('H.264');
    expect(msg.toLowerCase()).toContain('re-encode');
  });

  // mediabunny reports codec: null for a track it can't classify, but the decoder config may still
  // carry an RFC 6381 string — which is enough to identify it.
  it('falls back to the codec string when the codec family is unreported', () => {
    expect(exportCodecError(probe({ videoCodec: null, codecString: 'hvc1.1.6.L93.B0' }))).toContain('HEVC');
    expect(exportCodecError(probe({ videoCodec: null, codecString: 'vp09.00.10.08' }))).toContain('VP9');
    expect(exportCodecError(probe({ videoCodec: null, codecString: 'av01.0.05M.08' }))).toContain('AV1');
    expect(exportCodecError(probe({ videoCodec: null, codecString: 'AVC1.640028' }))).toBeNull();
    expect(exportCodecError(probe({ videoCodec: null, codecString: 'avc3.640028' }))).toBeNull();
  });

  // The lower-case here has to be asserted on a REJECT: an uppercase string that fails to match simply
  // falls through to accept, so pinning it with an accepted codec would pass either way.
  it('reads a codec string case-insensitively', () => {
    expect(exportCodecError(probe({ videoCodec: null, codecString: 'HVC1.1.6.L93.B0' }))).toContain('HEVC');
    expect(exportCodecError(probe({ videoCodec: null, codecString: 'AV01.0.05M.08' }))).toContain('AV1');
  });

  // A codec family we have no display name for is UNIDENTIFIED, not rejected. Without that, the message
  // interpolates `undefined` — "That video is undefined" — and refuses a file that may export fine.
  it('accepts a codec family it has no name for, rather than saying "undefined"', () => {
    for (const videoCodec of ['vvc', 'ffv1', 'theora', 'mystery-codec-2030']) {
      expect(exportCodecError(probe({ videoCodec, codecString: null })), videoCodec).toBeNull();
    }
  });

  it('rejects a file with no video track', () => {
    const msg = exportCodecError(probe({ hasVideoTrack: false, videoCodec: null, codecString: null }));
    expect(msg).toContain('no video track');
  });

  // H.264 inside an MKV: the codec is right but mp4box cannot open the container at all.
  it('rejects an H.264 stream in a container mp4box cannot demux', () => {
    expect(exportCodecError(probe({ container: 'Matroska' }))).toContain('MKV');
    expect(exportCodecError(probe({ container: 'WebM' }))).toContain('WebM');
  });

  // The WHOLE reject list, not a sample of it: these are mediabunny's exact InputFormat.name strings, so a
  // typo or a dropped entry silently lets that container through to fail at export instead.
  it('rejects every container on the list, each with an actionable message', () => {
    expect(UNDEMUXABLE_CONTAINER_NAMES).toEqual([
      'WebM', 'Matroska', 'MP3', 'WAVE', 'Ogg', 'FLAC', 'ADTS', 'MPEG Transport Stream',
      'HTTP Live Streaming (HLS)',
    ]);
    for (const container of UNDEMUXABLE_CONTAINER_NAMES) {
      const msg = exportCodecError(probe({ container }));
      expect(msg, container).not.toBeNull();
      expect(msg!.toLowerCase(), container).toContain('re-encode');
    }
  });

  // MP4 and QuickTime are both ISOBMFF — the exact thing mp4box parses — so neither may ever join the list.
  it('never rejects the two containers mp4box can demux', () => {
    expect(UNDEMUXABLE_CONTAINER_NAMES).not.toContain('MP4');
    expect(UNDEMUXABLE_CONTAINER_NAMES).not.toContain('QuickTime File Format');
  });

  // The reject list is deliberately explicit: a format mediabunny adds or renames must fall through as
  // "don't know" rather than being refused by an accept-list that hasn't heard of it.
  it('accepts an unrecognised container rather than guessing', () => {
    expect(exportCodecError(probe({ container: 'Some Format From 2030' }))).toBeNull();
    expect(exportCodecError(probe({ container: null }))).toBeNull();
  });

  it('rejects a config this browser explicitly cannot decode', () => {
    expect(exportCodecError(probe({ decodable: false }))).not.toBeNull();
  });

  // `null` means the check never ran (no WebCodecs, no decoder config) — that is not a "no".
  it('accepts when decodability could not be checked', () => {
    expect(exportCodecError(probe({ decodable: null }))).toBeNull();
  });

  it('accepts a file it learned nothing about', () => {
    expect(exportCodecError(null)).toBeNull();
    expect(exportCodecError(undefined)).toBeNull();
    expect(exportCodecError(probe({ container: null, videoCodec: null, codecString: null, decodable: null }))).toBeNull();
  });
});
