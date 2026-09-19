// What a video file must be for a reel to survive the whole pipeline — decided when the file is ADDED,
// not when the user finally presses Export.
//
// Both exporters (useCommentaryRecording / useRedditRecording) demux with mp4box and hand the AVC decoder
// config to a VideoDecoder, so an HEVC/VP9/AV1 upload, or anything that isn't an ISOBMFF container, dies
// with "only H.264 MP4 videos are supported" — after the script has been written, the narration generated
// and the export started. That is the whole cost this module exists to move to the top of the flow.
//
// The bias here is deliberately asymmetric. A file we WRONGLY reject can never be used at all, while a file
// we wrongly accept fails exactly where it fails today. So every "I don't know" answer — an unreadable file,
// a container mediabunny doesn't recognise, a WebCodecs API that isn't there — resolves to ACCEPT, and the
// reject list names only the codecs/containers mp4box demonstrably cannot feed to an AVC decoder.

/**
 * Biggest video we accept, in bytes.
 *
 * Chosen to sit just under reelVideoBlob's MAX_BYTES (512 MiB): that cache silently drops anything larger,
 * so a file above it would be stored, played and then fail to byte-cache — the guard and the cache have to
 * agree on what "too big" means. 500 MiB is ~5-8 minutes of 1080p phone footage; a Short is 60s.
 */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/**
 * A file size a human can read, in the same 1024-based units as MAX_UPLOAD_BYTES — so a rejection can put
 * the file and the limit side by side without them appearing to disagree.
 *
 * Each unit is rounded BEFORE the unit is chosen: a 1023.7 MB file must not print as "1024 MB" next to a
 * "500 MB" limit.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 bytes';
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) {
    const mb = Math.round(bytes / MB);
    return mb >= 1024 ? `${(bytes / GB).toFixed(1)} GB` : `${mb} MB`;
  }
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return `${Math.round(bytes)} bytes`;
}

/**
 * The message to show for an over-size upload, or null when the file is fine.
 *
 * Names the ACTUAL size: "too large" alone leaves the user guessing whether they missed by 10 MB or 2 GB.
 * A non-finite/negative size (a Blob with no readable size) is accepted — see the module note on unknowns.
 */
export function uploadSizeError(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= MAX_UPLOAD_BYTES) return null;
  return `That video is ${formatBytes(bytes)} — the limit is ${formatBytes(MAX_UPLOAD_BYTES)}. `
    + 'Trim or compress it and try again.';
}

/** What a probe of the actual file bytes managed to learn. Every field is nullable: the probe reports what
    it could read, and this module decides what that means. */
export interface ExportProbe {
  /** mediabunny's InputFormat.name — 'MP4', 'QuickTime File Format', 'WebM', … null when unread. */
  container: string | null;
  /** False only when the file was parsed and genuinely has no video track. */
  hasVideoTrack: boolean;
  /** mediabunny's VideoCodec for the primary video track ('avc' | 'hevc' | 'vp9' | 'av1' | …). */
  videoCodec: string | null;
  /** RFC 6381 codec string off the decoder config ('avc1.640028'), when one could be built. */
  codecString: string | null;
  /** VideoDecoder.isConfigSupported() on that config. null = the check could not run, which is NOT a no. */
  decodable: boolean | null;
}

// Display names for the codecs mediabunny reports, so a rejection can say WHICH codec the file is rather
// than only what it isn't.
const CODEC_NAMES: Record<string, string> = {
  avc: 'H.264',
  hevc: 'HEVC (H.265)',
  vp9: 'VP9',
  vp8: 'VP8',
  av1: 'AV1',
  prores: 'ProRes',
};

// Containers mp4box cannot demux at all — an explicit REJECT list rather than an accept list, because a
// format mediabunny adds or renames tomorrow must fall through as "don't know" instead of being refused.
// (MP4 and QuickTime are both ISOBMFF, which is exactly what mp4box parses.)
const UNDEMUXABLE_CONTAINERS: Record<string, string> = {
  'WebM': 'a WebM file',
  'Matroska': 'a Matroska (MKV) file',
  'MP3': 'an MP3 file',
  'WAVE': 'a WAV file',
  'Ogg': 'an Ogg file',
  'FLAC': 'a FLAC file',
  'ADTS': 'an AAC (ADTS) file',
  'MPEG Transport Stream': 'an MPEG transport stream',
  'HTTP Live Streaming (HLS)': 'an HLS playlist',
};

/** Every container name on the reject list, so a test can assert the whole list rather than a sample of it. */
export const UNDEMUXABLE_CONTAINER_NAMES = Object.keys(UNDEMUXABLE_CONTAINERS);

const FIX = 'Re-encode it to H.264 MP4 and add it again.';

/** The codec family a probe describes, or null when nothing in it identifies one. */
function codecOf(probe: ExportProbe): string | null {
  // `in CODEC_NAMES` is the whole point, not a formality: a codec we have no display name for must resolve
  // to "unidentified" (→ accept), not to a rejection reading "That video is undefined".
  if (probe.videoCodec && probe.videoCodec in CODEC_NAMES) return probe.videoCodec;
  // A codec string is the fallback identification: mediabunny reports `codec: null` for a track whose
  // codec it can't classify, but the decoder config may still carry an RFC 6381 string. Lower-cased
  // because the caller decides on the RESULT, and a mixed-case string must not read as unidentified.
  const s = probe.codecString?.toLowerCase() ?? '';
  // The AVC prefixes are documentation, not a decision: 'avc' and null both fall through to accept below,
  // so nothing observable turns on them (any mutation of this line is an equivalent mutant). They stay so
  // the function reads as a complete classifier.
  if (s.startsWith('avc1') || s.startsWith('avc3')) return 'avc';
  if (s.startsWith('hvc1') || s.startsWith('hev1')) return 'hevc';
  if (s.startsWith('vp09') || s === 'vp9') return 'vp9';
  if (s.startsWith('vp08') || s === 'vp8') return 'vp8';
  if (s.startsWith('av01')) return 'av1';
  return null;
}

/**
 * The message to show for a video that could never be exported, or null to accept it.
 *
 * `null` in means the probe could not run (no WebCodecs, unreadable/unrecognised file) — which accepts, on
 * purpose. Rejecting there would block files that export perfectly well today.
 */
export function exportCodecError(probe: ExportProbe | null | undefined): string | null {
  if (!probe) return null;

  // Parsed, and there is no video in it at all (an audio file renamed .mp4, a cover-art-only track).
  if (!probe.hasVideoTrack) return 'That file has no video track. Add an H.264 MP4 video instead.';

  const codec = codecOf(probe);
  if (codec && codec !== 'avc') {
    return `That video is ${CODEC_NAMES[codec]} — reels can only be exported from H.264. ${FIX}`;
  }

  // H.264 (or an unidentified codec) in a container mp4box can't open — e.g. H.264 in an MKV.
  const container = probe.container ? UNDEMUXABLE_CONTAINERS[probe.container] : undefined;
  if (container) return `That file is ${container} — reels can only be exported from H.264 MP4. ${FIX}`;

  // The container and codec are fine but this browser's decoder refuses the actual config (10-bit or
  // 4:2:2 H.264, say). Only a definite `false` counts — `null` means the check never ran.
  if (probe.decodable === false) {
    return `This browser can’t decode that video — reels need 8-bit H.264 MP4. ${FIX}`;
  }

  return null;
}
