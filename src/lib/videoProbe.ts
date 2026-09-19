// Reads a video file's actual bytes far enough to answer "will this ever export?" — the impure half of
// lib/videoIngest, kept apart from it so the decision logic stays a pure, node-testable function.
//
// mediabunny is already the exporter's muxer/demuxer, so this adds no dependency and — more importantly —
// asks the SAME library the export will use. It reads only the container headers (BlobSource is lazy), so
// probing a 400 MB file costs a few KB of reads, not a full pass through it.

import { exportCodecError, uploadSizeError, type ExportProbe } from './videoIngest';

/**
 * What the file is, as far as we can tell. Returns null when the probe could not run at all — an
 * unrecognised container, a read error, mediabunny failing to load — which lib/videoIngest treats as
 * "accept", because a probe that didn't run must never reject a file that would have exported fine.
 */
export async function probeVideoFile(file: Blob): Promise<ExportProbe | null> {
  try {
    const { Input, BlobSource, ALL_FORMATS } = await import('mediabunny');
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      const format = await input.getFormat();
      const track = await input.getPrimaryVideoTrack();
      if (!track) {
        return { container: format.name, hasVideoTrack: false, videoCodec: null, codecString: null, decodable: null };
      }
      const codecString = await track.getCodecParameterString().catch(() => null);
      // Deliberately NOT track.canDecode(): that helper folds every internal error into `false`, which would
      // turn a probe failure into a rejection. Ask VideoDecoder ourselves so a throw stays "unknown".
      let decodable: boolean | null = null;
      const config = await track.getDecoderConfig().catch(() => null);
      if (config && typeof VideoDecoder !== 'undefined') {
        try { decodable = (await VideoDecoder.isConfigSupported(config)).supported === true; }
        catch { decodable = null; }   // isConfigSupported throws on a config it considers malformed
      }
      return { container: format.name, hasVideoTrack: true, videoCodec: track.codec, codecString, decodable };
    } finally {
      input.dispose();   // drops the source's read cache — the file may be hundreds of MB
    }
  } catch {
    return null;
  }
}

/**
 * The one call an ingest point makes: the message to show the user, or null to accept the file.
 *
 * Size first — it's free, and there is no point parsing a 3 GB file we're going to refuse anyway.
 */
export async function checkVideoFile(file: Blob): Promise<string | null> {
  const tooBig = uploadSizeError(file.size);
  if (tooBig) return tooBig;
  return exportCodecError(await probeVideoFile(file));
}
