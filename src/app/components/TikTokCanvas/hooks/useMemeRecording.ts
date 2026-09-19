'use client';

import { useState, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';

// @ts-expect-error -- mp4box ships no usable type declarations
import MP4Box from 'mp4box';

import { CANVAS_W, CANVAS_H } from '../constants';
import { fullBleedVideoRects } from '../drawing/fullBleedVideo';
import { drawBlurredBackdrop, createBackdropScratch, visibleSourceRect } from '../drawing/blurBackdrop';
import { trackById, trackStreamSrc, DEFAULT_MUSIC_VOLUME } from '@/lib/music';
import { drawImageOverlays } from '../drawing/drawOverlays';
import { exportLead, isLeadFrame, sourceTimeFor, totalOutputFrames, shiftForLead } from '@/lib/thumbnailLead';
import { getOverlayImage } from '@/lib/localVideoStore';
import { getCachedBlob } from '@/lib/reelVideoBlob';
import type { Box, ImageOverlay } from '../types';
import type { EncodedAudioPacketSource as TEncodedAudioPacketSource, EncodedPacket as TEncodedPacket } from 'mediabunny';

// The MEME export path — the MP4 twin of MemeCanvas. Like its canvas, it is a fork that takes the audio
// model from the Reddit exporter and the composition from the commentary one, and knows about neither:
//
//  • AUDIO/TIMING (as Reddit): the narration IS the reel's audio, so the video is muted, sped up to
//    `audioRate`, truncated to the voice-over (+1s of tail) and LOOPED when the voice outruns the footage.
//    This is the part that must not be re-derived — the reveal steps, the export length and the preview all
//    agree only because they share this arithmetic.
//  • COMPOSITION (as commentary): no template. The clip is cover-fit to the whole 1080x1920 frame through
//    drawing/fullBleedVideo — the same helper MemeCanvas previews through, so the MP4 and the editor
//    composite from one formula — with an optional blurred backdrop filling whatever the crop leaves, and
//    the meme image drawn on top by the shared drawImageOverlays (reveal steps included).

/** A decoded frame waiting to be composited, tagged with its SOURCE time in seconds. */
type QueuedFrame = { frame: VideoFrame; ts: number };

// Local blobs (uploads / byte-cached downloads) are fetched directly; anything remote goes through
// /api/proxy (same-origin URLs like the proxy itself are also direct-fetchable).
function isDirectFetchable(url: string): boolean {
  if (url.startsWith('blob:')) return true;   // byte-cached local blob
  return url.startsWith('/');                 // same-origin (e.g. an /api/proxy stream URL)
}

export interface UseMemeRecordingConfig {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  rowNumber: number;
  videoId?: string;
  boxRef: MutableRefObject<Box>;
  videoOffsetRef: MutableRefObject<{ x: number; y: number }>;
  videoScaleRef: MutableRefObject<number>;
  trimStartRef: MutableRefObject<number>;
  trimEndRef: MutableRefObject<number>;
  includeEditRef: MutableRefObject<boolean>;
  overlayCaption: string;
  /** Generated YouTube title — used as the export filename when present (falls back to caption). */
  exportTitle?: string;
  /** Generated YouTube description. With a title, the export becomes a .zip of MP4 + .txt. */
  exportDescription?: string;
  /** Image overlays (topmost layer); drawn on frames whose source time is inside [start,end]. */
  overlaysRef: MutableRefObject<ImageOverlay[]>;
  overlayImgsRef: MutableRefObject<Map<string, HTMLImageElement>>;
  /** Fill the letterbox with a blurred cover-fit copy of the video (see Framing.bgBlur). */
  bgBlurRef?: MutableRefObject<boolean>;
  /** Background-music track id (lib/music.ts) — mixed under the export audio. */
  musicIdRef?: MutableRefObject<string | null>;
  /** Music bed volume 0..1 (default DEFAULT_MUSIC_VOLUME). */
  musicVolumeRef?: MutableRefObject<number>;
  /** IndexedDB key of a custom thumbnail still. Present = hold it for THUMB_LEAD_S before the footage
      (see @/lib/thumbnailLead), so it can be picked in YouTube's Shorts frame picker. */
  thumbnailIdRef?: MutableRefObject<string | null>;
}

export function useMemeRecording(config: UseMemeRecordingConfig) {
  const [isRecording, setIsRecording] = useState(false);
  const [recProgress, setRecProgressRaw] = useState(0);
  const [recStatus, setRecStatus] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);
  // The encode loop reports progress per frame — hundreds of awaited micro-steps in one async chain.
  // React dev treats that as a nested-update cascade ("maximum update depth"), so throttle the actual
  // setState to meaningful changes; terminal values (0 / 1) always pass so the UI can't miss the end.
  const lastProgressRef = useRef(0);
  const setRecProgress = (p: number) => {
    if (p !== 0 && p !== 1 && Math.abs(p - lastProgressRef.current) < 0.01) return;
    lastProgressRef.current = p;
    setRecProgressRaw(p);
  };

  async function startRecording(opts?: { returnBlob?: boolean }): Promise<Blob | void> {
    const {
      canvasRef, videoRef, rowNumber, videoId,
      boxRef, videoOffsetRef, videoScaleRef,
      trimStartRef, trimEndRef, includeEditRef,
      overlaysRef, overlayImgsRef,
      overlayCaption, exportTitle, exportDescription,
      bgBlurRef,
      musicIdRef, musicVolumeRef, thumbnailIdRef,
    } = config;
    // Scratch canvas for the blurred letterbox backdrop (created on first use, reused across frames).
    let backdropScratch: OffscreenCanvas | null = null;

    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || isRecording) throw new Error('Cannot start recording');

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const signal = abortController.signal;

    setIsRecording(true);
    setRecProgress(0);
    setRecStatus('Initializing...');

    // A terminal status (error, "Saved:", "Exported without audio") is set on the same synchronous
    // job as the finally below, so without this flag the finally's setRecStatus('') coalesces it away
    // and it never renders. Set it wherever a status must survive to be seen (its own timeout clears it).
    let keepStatus = false;

    try {
      const mediabunny = await import('mediabunny');
      const {
        Output, Mp4OutputFormat, BufferTarget, VideoSample, VideoSampleSource,
        EncodedAudioPacketSource, EncodedVideoPacketSource, EncodedPacketSink, EncodedPacket,
        Input, BlobSource, ALL_FORMATS, QUALITY_HIGH,
      } = mediabunny;

      const EXPORT_FPS = 30;
      const EXPORT_FRAME_DURATION = 1 / EXPORT_FPS;

      async function mergeWithEdit(mainBuffer: ArrayBuffer, mainDuration: number): Promise<ArrayBuffer> {
        setRecStatus('Appending edit clip...');

        const editResp = await fetch('/edit.mp4');
        if (!editResp.ok) throw new Error(`Failed to fetch edit.mp4: ${editResp.status}`);
        const editArrayBuffer = await editResp.arrayBuffer();

        const mkMain = () => new Input({ source: new BlobSource(new Blob([mainBuffer], { type: 'video/mp4' })), formats: ALL_FORMATS });
        const mkEdit = () => new Input({ source: new BlobSource(new Blob([editArrayBuffer], { type: 'video/mp4' })), formats: ALL_FORMATS });

        const mainVideoTrack = await mkMain().getPrimaryVideoTrack();
        const editVideoTrack = await mkEdit().getPrimaryVideoTrack();
        if (!mainVideoTrack || !editVideoTrack) throw new Error('Missing video track for merge');

        const mainVideoConfig = await mainVideoTrack.getDecoderConfig();
        const editVideoConfig = await editVideoTrack.getDecoderConfig();

        const mainVPackets: TEncodedPacket[] = [];
        for await (const p of new EncodedPacketSink(mainVideoTrack).packets()) mainVPackets.push(p);
        let editVPackets: TEncodedPacket[] = [];
        for await (const p of new EncodedPacketSink(editVideoTrack).packets()) editVPackets.push(p);
        if (editVPackets.length > 0) {
          const firstTs = editVPackets[0].timestamp;
          editVPackets = editVPackets.map(p => p.clone({ timestamp: p.timestamp - firstTs + mainDuration }));
        }

        const MERGED_SR = 44100;
        const AFRAME = 1024;
        const allAudioPackets: TEncodedPacket[] = [];
        let sharedAudioConfig: AudioDecoderConfig | null = null;
        setRecStatus('Mixing audio...');
        try {
          if (typeof AudioEncoder === 'undefined' || typeof OfflineAudioContext === 'undefined')
            throw new Error('Web Audio API not supported');

          const tempCtx = new AudioContext({ sampleRate: MERGED_SR });
          let mainAudioBuffer: AudioBuffer;
          try { mainAudioBuffer = await tempCtx.decodeAudioData(mainBuffer.slice(0)); }
          catch { mainAudioBuffer = tempCtx.createBuffer(2, Math.ceil(mainDuration * MERGED_SR), MERGED_SR); }
          const editAudioBuffer = await tempCtx.decodeAudioData(editArrayBuffer.slice(0));
          await tempCtx.close();

          const totalSamples = Math.ceil((mainDuration + editAudioBuffer.duration) * MERGED_SR);
          const mixCh = 2;
          const offCtx = new OfflineAudioContext(mixCh, totalSamples, MERGED_SR);
          const ms = offCtx.createBufferSource(); ms.buffer = mainAudioBuffer; ms.connect(offCtx.destination); ms.start(0);
          const es = offCtx.createBufferSource(); es.buffer = editAudioBuffer; es.connect(offCtx.destination); es.start(mainDuration);
          const mixed = await offCtx.startRendering();

          const mixLen = mixed.length;
          const chunks: EncodedAudioChunk[] = [];
          let encCfg: AudioDecoderConfig | null = null;
          let encErr: Error | null = null;
          const enc = new AudioEncoder({
            output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => {
              chunks.push(chunk);
              if (meta?.decoderConfig && !encCfg) encCfg = meta.decoderConfig;
            },
            error: (e: Error) => { encErr = e; },
          });
          enc.configure({ codec: 'mp4a.40.2', sampleRate: MERGED_SR, numberOfChannels: mixCh, bitrate: 128_000 });

          const chData = Array.from({ length: mixCh }, (_, c) => mixed.getChannelData(c));
          let tMicros = 0;
          for (let offset = 0; offset < mixLen; offset += AFRAME) {
            const fc = Math.min(AFRAME, mixLen - offset);
            const planar = new Float32Array(fc * mixCh);
            for (let c = 0; c < mixCh; c++) {
              const src = chData[c];
              for (let i = 0; i < fc; i++) planar[c * fc + i] = src[offset + i] ?? 0;
            }
            const ad = new AudioData({ format: 'f32-planar', sampleRate: MERGED_SR, numberOfFrames: fc, numberOfChannels: mixCh, timestamp: tMicros, data: planar });
            enc.encode(ad);
            ad.close();
            tMicros += Math.round((fc / MERGED_SR) * 1_000_000);
          }
          await enc.flush();
          enc.close();
          if (encErr) throw encErr;

          if (chunks.length > 0) {
            if (!encCfg) {
              const sfIdx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350].indexOf(MERGED_SR);
              const si = sfIdx >= 0 ? sfIdx : 4;
              encCfg = { codec: 'mp4a.40.2', sampleRate: MERGED_SR, numberOfChannels: mixCh, description: new Uint8Array([(2 << 3) | (si >> 1), ((si & 1) << 7) | (mixCh << 3)]) };
            }
            sharedAudioConfig = encCfg;
            for (const chunk of chunks) allAudioPackets.push(EncodedPacket.fromEncodedChunk(chunk));
          }
        } catch (audioErr) {
          console.error('[mergeWithEdit] audio mix/encode failed:', audioErr);
        }

        const mergeOut = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
        const mergeVSrc = new EncodedVideoPacketSource('avc');
        mergeOut.addVideoTrack(mergeVSrc);
        let mergeASrc: TEncodedAudioPacketSource | null = null;
        if (allAudioPackets.length > 0) {
          mergeASrc = new EncodedAudioPacketSource('aac');
          mergeOut.addAudioTrack(mergeASrc);
        }
        await mergeOut.start();
        for (let i = 0; i < mainVPackets.length; i++) await mergeVSrc.add(mainVPackets[i], i === 0 && mainVideoConfig ? { decoderConfig: mainVideoConfig } : undefined);
        for (let i = 0; i < editVPackets.length; i++) await mergeVSrc.add(editVPackets[i], i === 0 && editVideoConfig ? { decoderConfig: editVideoConfig } : undefined);
        if (mergeASrc) {
          for (let i = 0; i < allAudioPackets.length; i++) await mergeASrc.add(allAudioPackets[i], i === 0 && sharedAudioConfig ? { decoderConfig: sharedAudioConfig } : undefined);
        }
        setRecStatus('Finalizing merged video...');
        await mergeOut.finalize();
        const merged = mergeOut.target.buffer;
        if (!merged) throw new Error('No buffer from merge output');
        return merged;
      }

      // ── Fetch + demux source video ────────────────────────────────────────────
      const videoSrcUrl = video.src || video.currentSrc;
      const videoUrl = isDirectFetchable(videoSrcUrl)     // local blob or same-origin
        ? videoSrcUrl
        : videoSrcUrl.includes('/api/proxy')
          ? videoSrcUrl
          : `/api/proxy?url=${encodeURIComponent(videoSrcUrl)}&stream=1`;

      setRecStatus('Downloading video file...');
      let arrayBuffer: ArrayBuffer;
      // A batch export prefetches the NEXT reel's bytes (getVideoBlob) while the current reel encodes, so the
      // file is often already fully downloaded in the shared blob cache — reuse it instead of re-fetching the
      // ~100MB footage from the CDN a second time. The prefetch keys the cache by the RELATIVE proxy url
      // (bestVideoUrl → "/api/proxy?stream=1&url=…"), but video.src resolves to an ABSOLUTE url, so also probe
      // the relative pathname+search form (how the prefetch stored it).
      let relSrc = videoSrcUrl;
      try { const u = new URL(videoSrcUrl, window.location.href); relSrc = u.pathname + u.search; } catch { /* keep as-is */ }
      const cachedBlob = getCachedBlob(videoSrcUrl) ?? getCachedBlob(videoUrl) ?? getCachedBlob(relSrc);
      try {
        if (cachedBlob) {
          arrayBuffer = await cachedBlob.arrayBuffer();
        } else {
          const response = await fetch(videoUrl);
          if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          arrayBuffer = await response.arrayBuffer();
        }
      } catch (fetchError) {
        console.error('[EXPORT] ❌ Download failed:', fetchError);
        throw new Error(`Failed to download video: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`);
      }

      setRecStatus('Parsing video file...');

      const MP4BoxFile = MP4Box.createFile();
      const videoSamples: Array<{ data: Uint8Array; timestamp: number; duration: number; isKeyframe: boolean }> = [];
      const audioSamples: Array<{ data: Uint8Array; timestamp: number; duration: number }> = [];
      let videoTrackId: number | null = null;
      let audioTrackId: number | null = null;
      let videoTimescale = 90000;
      let audioTimescale = 44100;
      // Source video dimensions read from the demuxed track — the <video> element is deferred
      // (lib/videoPreload) and may not have decoded, so we can't rely on video.videoWidth/Height here.
      let srcW = 0, srcH = 0;

      MP4BoxFile.onReady = (info: { tracks?: Array<{ id: number; type: string; timescale?: number }> }) => {
        for (const track of info.tracks || []) {
          if (track.type === 'video' && !videoTrackId) {
            videoTrackId = track.id; videoTimescale = track.timescale || 90000;
            const vt = track as { video?: { width?: number; height?: number }; track_width?: number; track_height?: number };
            srcW = vt.video?.width || vt.track_width || 0;
            srcH = vt.video?.height || vt.track_height || 0;
          }
          if (track.type === 'audio' && !audioTrackId) { audioTrackId = track.id; audioTimescale = track.timescale || 44100; }
        }
        if (videoTrackId) MP4BoxFile.setExtractionOptions(videoTrackId, null, { nbSamples: Infinity });
        if (audioTrackId) MP4BoxFile.setExtractionOptions(audioTrackId, null, { nbSamples: Infinity });
        MP4BoxFile.start();
      };

      MP4BoxFile.onSamples = (id: number, _user: unknown, samples: Array<{ data: ArrayBuffer; cts: number; duration: number; is_sync: boolean }>) => {
        if (id === videoTrackId) {
          for (const s of samples) videoSamples.push({ data: new Uint8Array(s.data), timestamp: s.cts / videoTimescale, duration: s.duration / videoTimescale, isKeyframe: s.is_sync });
        }
        if (id === audioTrackId) {
          for (const s of samples) audioSamples.push({ data: new Uint8Array(s.data), timestamp: s.cts / audioTimescale, duration: s.duration / audioTimescale });
        }
      };

      MP4BoxFile.onError = (e: unknown) => console.error('[EXPORT] ❌ MP4Box error:', e);

      const copy = arrayBuffer.slice(0);
      // @ts-expect-error -- mp4box ships no usable type declarations
      copy.fileStart = 0;
      MP4BoxFile.appendBuffer(copy);
      MP4BoxFile.flush();

      await new Promise<void>((resolve, reject) => {
        const t = Date.now();
        const id = setInterval(() => {
          if (videoSamples.length > 0) { clearInterval(id); resolve(); }
          else if (Date.now() - t > 10000) { clearInterval(id); reject(new Error('Timeout extracting video samples')); }
        }, 100);
      });

      if (videoSamples.length === 0) throw new Error('No video samples found');

      const lastSample = videoSamples[videoSamples.length - 1];
      const fullDuration = lastSample.timestamp + lastSample.duration;
      const clipStart = trimStartRef.current;
      // The footage window we can draw from (the trimmed clip, or the whole file) — this is what we LOOP.
      const loopEnd = trimEndRef.current > 0 && trimEndRef.current <= fullDuration ? trimEndRef.current : fullDuration;

      // Narrated reels: the background video runs `audioRate`× fast (baked into the overlay), and the voice-over
      // IS the audio. When the narration is LONGER than the footage, we loop the footage to cover it (rather than
      // cutting the reel off mid-sentence). Looping is only supported from the clip start (clipStart 0): a trimmed
      // start decodes a pre-roll keyframe whose frames would break the monotonic per-pass timeline, so there we
      // keep the old single-pass behaviour (truncate at the footage end).
      const narrated = overlaysRef.current.filter(o => o.audioId && (o.audioDuration ?? 0) > 0);
      const videoRate = narrated.length ? Math.max(1, ...narrated.map(o => o.audioRate ?? 1)) : 1;
      const POST_NARRATION_PAD_S = 1;   // wall-clock seconds of video after the voice-over ends
      const canLoop = clipStart <= 0.001;
      let clipEnd = loopEnd;      // footage-bounded end — used to filter source-audio packets + bound each decode pass
      let sourceEnd = loopEnd;    // where the OUTPUT's source timeline ends; may exceed loopEnd → the footage loops
      if (narrated.length > 0) {
        const narrEndSource = Math.max(...narrated.map(o => (o.audioStart ?? o.start) + (o.audioDuration ?? 0) * (o.audioRate ?? 1)));
        const wanted = narrEndSource + POST_NARRATION_PAD_S * videoRate;   // source-time needed for the full voice-over + tail
        clipEnd = Math.max(clipStart + 0.1, Math.min(loopEnd, wanted));
        sourceEnd = canLoop ? Math.max(clipStart + 0.1, wanted) : clipEnd;   // loop → full narration; else truncate at footage
      }
      const footSpan = Math.max(0.1, loopEnd - clipStart);          // one loop of footage, in source seconds
      const willLoop = canLoop && sourceEnd > loopEnd + 1e-6;       // narration actually outruns the clip → loop it
      const clipDuration = Math.max(0.1, sourceEnd - clipStart);
      const outputDuration = clipDuration / videoRate;   // sped-up video compresses the output timeline (sizes the audio mix + frame count)

      // ── Custom thumbnail lead ────────────────────────────────────────────────
      // Decoded up front: a failed load must fall back to a normal export, not abort one. `lead` is NO_LEAD
      // whenever there's no usable still, which makes every lead-aware call below a no-op.
      let thumbBitmap: ImageBitmap | null = null;
      if (thumbnailIdRef?.current) {
        try {
          const rec = await getOverlayImage(thumbnailIdRef.current);
          if (rec) thumbBitmap = await createImageBitmap(rec.blob);
        } catch (e) { console.warn('[EXPORT] thumbnail still could not be decoded — exporting without it:', e); }
      }
      const lead = exportLead(!!thumbBitmap, EXPORT_FPS);
      // The mix and the trailing merge span the footage PLUS the held frames.
      const totalDuration = outputDuration + lead.seconds;
      const totalFrames = totalOutputFrames(outputDuration, EXPORT_FPS, lead);

      // E1: bound the DECODE to the composited window. The consumer only draws [clipStart, clipEnd] (up to
      // totalFrames), but the producer used to decode the ENTIRE file — pure waste on a narration-truncated
      // or trimmed reel (a 40s clip bounded to ~20s decodes ~2x the frames it uses). Decode from the
      // keyframe at/before clipStart (required to reconstruct clipStart) through clipEnd + a reorder margin.
      // No-op for a full clip: clipStart=0 → decodeStartIdx=0, and clipEnd=fullDuration → decodeEndIdx=end.
      let decodeStartIdx = 0;
      for (let i = 0; i < videoSamples.length; i++) {
        if (videoSamples[i].timestamp > clipStart) break;
        if (videoSamples[i].isKeyframe) decodeStartIdx = i;
      }
      // A looping reel re-decodes the WHOLE footage window each pass, so bound the decode at loopEnd; a
      // single-pass reel stops at clipEnd (the narration-truncated / trimmed end) to avoid wasted decode.
      const perPassEnd = willLoop ? loopEnd : clipEnd;
      // The +0.5 reorder look-ahead is only for a clean FINAL frame. On a LOOPING pass it must be 0: feeding
      // ~0.5s past loopEnd (only possible on an end-TRIMMED clip — an untrimmed loopEnd is fullDuration, with
      // no samples beyond it) would replay trimmed-away footage at every seam AND push each restart's head out
      // by a backwards timestamp jump the monotonic consumer can't place. Each pass's IDR keyframe flushes the
      // reorder tail, so the frame at loopEnd still emits without the margin.
      const decodeMargin = willLoop ? 0 : 0.5;
      let decodeEndIdx = videoSamples.length;
      for (let i = decodeStartIdx; i < videoSamples.length; i++) {
        if (videoSamples[i].timestamp > perPassEnd + decodeMargin) { decodeEndIdx = i; break; }
      }

      // ── Extract AVC decoder description from MP4Box ──────────────────────────
      let description: Uint8Array | undefined;
      if (typeof MP4BoxFile.getSampleDescription === 'function') {
        const descs = MP4BoxFile.getSampleDescription(videoTrackId);
        if (descs?.[0]) description = descs[0].avcC?.config || descs[0].avcC;
      }
      if (!description) {
        try {
          const stsd = MP4BoxFile.getTrackById(videoTrackId)?.mdia?.minf?.stbl?.stsd;
          const entry = stsd?.entries?.[0];
          if (entry?.avcC?.config?.length > 0) description = new Uint8Array(entry.avcC.config);
          else if (typeof entry?.avcC?.subarray === 'function') description = entry.avcC.subarray();
          else if (typeof entry?.avcC?.start !== 'undefined' && entry?.avcC?.size) description = new Uint8Array(arrayBuffer, entry.avcC.start + 8, entry.avcC.size - 8);
        } catch (descErr) { console.warn('[EXPORT] description extraction fallback failed:', descErr); }
      }
      if (!description) {
        // No AVC config = the source isn't H.264/MP4 (e.g. an HEVC or WebM upload). The decoder is
        // AVC-only, so fail now with a message the user can act on instead of a cryptic decoder crash.
        throw new Error('This video can’t be exported — only H.264 MP4 videos are supported. Try a different file.');
      }

      // ── Set up output container + audio BEFORE decoding so we can stream ─────
      setRecStatus('Preparing audio...');

      const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
      // prefer-hardware routes H.264 encode through the OS encoder (VideoToolbox on macOS) — materially
      // faster than software AVC, and it transparently falls back to software if unavailable. latencyMode
      // is left at the default 'quality' on purpose: 'realtime' can drop frames, and encode is already
      // back-pressured by awaiting every add() below, so we take the speed without the quality risk.
      const videoSource = new VideoSampleSource({ codec: 'avc', bitrate: QUALITY_HIGH, hardwareAcceleration: 'prefer-hardware' });
      output.addVideoTrack(videoSource);

      let audioSource: TEncodedAudioPacketSource | null = null;
      let audioPackets: TEncodedPacket[] = [];
      let audioDecoderConfigForExport: AudioDecoderConfig | null = null;

      // ── Narration track ───────────────────────────────────────────────────────
      // Overlays with ElevenLabs narration replace the source audio outright (the underlying video
      // is muted — the meme voice-over IS the audio): decode the narration(s), place them on the
      // export timeline in an OfflineAudioContext, re-encode AAC. The fast AAC packet-copy path
      // below can't do that, so a narrated reel whose mix fails exports silent (source audio would
      // be desynced anyway once the video is sped up).
      const musicTrack = trackById(musicIdRef?.current);
      if ((narrated.length > 0 || musicTrack) && typeof AudioEncoder !== 'undefined' && typeof OfflineAudioContext !== 'undefined') {
        setRecStatus('Mixing narration...');
        try {
          const MIX_SR = 44100, MIX_CH = 2, AFRAME = 1024;
          const tempCtx = new AudioContext({ sampleRate: MIX_SR });
          const narrBufs: { start: number; buf: AudioBuffer }[] = [];
          for (const o of narrated) {
            const rec = await getOverlayImage(o.audioId!);
            if (!rec) continue;
            try {
              narrBufs.push({ start: (o.audioStart ?? o.start), buf: await tempCtx.decodeAudioData(await rec.blob.arrayBuffer()) });
            } catch { /* skip an undecodable narration */ }
          }
          // Background music: decoded once, looped across the whole output at a low gain.
          let musicBuf: AudioBuffer | null = null;
          if (musicTrack) {
            try {
              const res = await fetch(trackStreamSrc(musicTrack));
              if (res.ok) musicBuf = await tempCtx.decodeAudioData(await res.arrayBuffer());
            } catch { /* music is optional — export continues without it */ }
          }
          // With music but NO narration the source audio must join this mix (the packet-copy path below
          // can't blend). A narration mutes the source outright, so it never joins.
          let sourceBuf: AudioBuffer | null = null;
          if (narrated.length === 0 && musicBuf && audioSamples.length > 0) {
            try { sourceBuf = await tempCtx.decodeAudioData(arrayBuffer.slice(0)); }
            catch { /* keep the voice/music rather than dropping the mix */ }
          }
          await tempCtx.close();

          if (narrBufs.length > 0 || musicBuf) {
            // Every cue below is shifted by lead.seconds so the mix moves as ONE block with the video. The
            // held thumbnail frames therefore play silent, and the voice still lands on the same footage.
            const offA = new OfflineAudioContext(MIX_CH, Math.ceil(totalDuration * MIX_SR), MIX_SR);
            for (const n of narrBufs) {
              const src = offA.createBufferSource();
              src.buffer = n.buf;
              src.connect(offA.destination);
              // Narration anchor on the OUTPUT timeline: source-time offset compressed by the
              // video speed-up (the voice itself plays at 1×). The narration is tied to the footage,
              // so a mid-narration trim skips its head.
              const when = (n.start - clipStart) / videoRate;
              if (when >= 0) src.start(shiftForLead(when, lead));
              else src.start(lead.seconds, -when);   // clip starts mid-narration → skip its head
            }
            if (musicBuf) {
              const gain = offA.createGain();
              gain.gain.value = musicVolumeRef?.current ?? DEFAULT_MUSIC_VOLUME;
              gain.connect(offA.destination);
              const src = offA.createBufferSource();
              src.buffer = musicBuf;
              src.loop = true;                     // covers any output length
              src.connect(gain);
              src.start(lead.seconds);
            }
            if (sourceBuf) {
              const src = offA.createBufferSource();
              src.buffer = sourceBuf;
              src.connect(offA.destination);
              src.start(lead.seconds, clipStart);  // sourceBuf only exists when there's no narration → videoRate is 1
            }
            const mixed = await offA.startRendering();

            const chunks: EncodedAudioChunk[] = [];
            let encCfg: AudioDecoderConfig | null = null;
            let encErr: Error | null = null;
            const enc = new AudioEncoder({
              output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => {
                chunks.push(chunk);
                if (meta?.decoderConfig && !encCfg) encCfg = meta.decoderConfig;
              },
              error: (e: Error) => { encErr = e; },
            });
            enc.configure({ codec: 'mp4a.40.2', sampleRate: MIX_SR, numberOfChannels: MIX_CH, bitrate: 128_000 });
            const chData = Array.from({ length: MIX_CH }, (_, c) => mixed.getChannelData(c));
            let tMicros = 0;
            for (let offset = 0; offset < mixed.length; offset += AFRAME) {
              const fc = Math.min(AFRAME, mixed.length - offset);
              const planar = new Float32Array(fc * MIX_CH);
              for (let c = 0; c < MIX_CH; c++) {
                const chan = chData[c];
                for (let i = 0; i < fc; i++) planar[c * fc + i] = chan[offset + i] ?? 0;
              }
              const ad = new AudioData({ format: 'f32-planar', sampleRate: MIX_SR, numberOfFrames: fc, numberOfChannels: MIX_CH, timestamp: tMicros, data: planar });
              enc.encode(ad);
              ad.close();
              tMicros += Math.round((fc / MIX_SR) * 1_000_000);
            }
            await enc.flush();
            enc.close();
            if (encErr) throw encErr;

            if (chunks.length > 0) {
              if (!encCfg) {
                const sfIdx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350].indexOf(MIX_SR);
                const si = sfIdx >= 0 ? sfIdx : 4;
                encCfg = { codec: 'mp4a.40.2', sampleRate: MIX_SR, numberOfChannels: MIX_CH, description: new Uint8Array([(2 << 3) | (si >> 1), ((si & 1) << 7) | (MIX_CH << 3)]) };
              }
              audioSource = new EncodedAudioPacketSource('aac');
              output.addAudioTrack(audioSource);
              audioPackets = chunks.map(chunk => EncodedPacket.fromEncodedChunk(chunk));
              audioDecoderConfigForExport = encCfg;
            }
          }
        } catch (e) {
          console.error('[narration mix] failed — exporting without audio:', e);
        }
      }

      if (!audioSource && narrated.length === 0 && audioSamples.length > 0) {
        try {
          const input = new Input({ source: new BlobSource(new Blob([arrayBuffer], { type: 'video/mp4' })), formats: ALL_FORMATS });
          const audioTrack = await input.getPrimaryAudioTrack();
          if (audioTrack) {
            audioDecoderConfigForExport = await audioTrack.getDecoderConfig();
            audioSource = new EncodedAudioPacketSource('aac');
            output.addAudioTrack(audioSource);
            const sink = new EncodedPacketSink(audioTrack);
            for await (const packet of sink.packets()) audioPackets.push(packet);
            const firstTs = audioPackets[0]?.timestamp || 0;
            audioPackets = audioPackets
              .map(p => p.clone({ timestamp: p.timestamp - firstTs }))
              .filter(p => p.timestamp >= clipStart && p.timestamp < clipEnd);
            if (audioPackets.length > 0) {
              const firstTrim = audioPackets[0].timestamp;
              audioPackets = audioPackets.map(p => p.clone({ timestamp: p.timestamp - firstTrim }));
            }
          }
        } catch (e) { console.error('[audio setup]', e); }
      }
      // The source had audio but it failed to extract/trim → the export will be silent. Surfaced after
      // finalize so the user knows before they discover it on Instagram.
      const audioDropped = audioSamples.length > 0 && (!audioSource || audioPackets.length === 0);

      // No logo, free-element images or text fonts to preload: a meme reel draws no template at all, only
      // the clip and the meme image (decoded just below).

      // Ensure every image overlay is decoded before the frame loop (object URLs — no CORS taint).
      // The erase-mode cover atlas is a second bitmap per overlay (keyed by coverAtlasId in the
      // same map) — skipping it wouldn't fail the export, it would ship one with NO covers: every
      // "erased" text line readable from frame one, which is exactly the mode's one job.
      for (const o of overlaysRef.current) {
        const pending: Array<{ key: string; url: string }> = [];
        if (o.src) pending.push({ key: o.id, url: o.src });
        if (o.coverAtlasId && o.coverSrc) pending.push({ key: o.coverAtlasId, url: o.coverSrc });
        for (const { key, url } of pending) {
          const existing = overlayImgsRef.current.get(key);
          if (existing?.complete && existing.naturalWidth > 0) continue;
          await new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => { overlayImgsRef.current.set(key, img); resolve(); };
            img.onerror = () => resolve();
            img.src = url;
          });
        }
      }

      await output.start();

      // ── Streaming decode + render ────────────────────────────────────────────
      // The previous design queued ALL chunks then awaited flush(), which
      // deadlocks: the decoder's GPU frame pool fills up after a handful of
      // outputs, and frames never get closed until flush returns. Now we
      // consume + close frames as they arrive so the pool stays drained.
      setRecStatus('Encoding...');

      const frameQueue: QueuedFrame[] = [];
      let decoderError: Error | null = null;
      let producerDone = false;
      let consumerWaiter: (() => void) | null = null;
      let producerWaiter: (() => void) | null = null;
      const wakeConsumer = () => { const r = consumerWaiter; consumerWaiter = null; r?.(); };
      const wakeProducer = () => { const r = producerWaiter; producerWaiter = null; r?.(); };

      // Bounded wait for the next decoded frame. A silently-stalled VideoDecoder — Windows hardware decode
      // can stop emitting frames with NO `output` and NO `error` — would otherwise leave the consumer (and
      // the whole export) hanging forever. A healthy decoder emits frames in milliseconds, so 20s with zero
      // new frames is a definite stall: reject so the export fails cleanly (and retryable) instead of freezing.
      const STALL_MS = 20_000;
      const waitForFrame = () => new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Video export stalled while decoding — please try again.')), STALL_MS);
        consumerWaiter = () => { clearTimeout(t); resolve(); };
      });

      const decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          frameQueue.push({ frame, ts: frame.timestamp / 1_000_000 });
          wakeConsumer();
        },
        error: (e: Error) => {
          decoderError = e;
          console.error('[EXPORT] ❌ VideoDecoder error:', e, 'name:', e?.name, 'message:', e?.message);
          wakeConsumer();
          wakeProducer();
        },
      });

      decoder.configure({ codec: 'avc1.64001F', codedWidth: 1080, codedHeight: 1920, description });

      // Cap how many decoded frames sit in memory before the producer waits.
      // Empirically Chromium's H.264 decoder needs ~4-8 frames in flight for
      // reorder buffer; 12 leaves headroom without blowing GPU memory.
      const MAX_BUFFERED = 12;

      const producer = (async () => {
        try {
          // Loop the footage: pass `p` re-decodes the window with every timestamp shifted by p × footSpan, so
          // the consumer sees ONE continuous, monotonically-increasing stream covering the full output. Each
          // pass restarts at the clip-start keyframe (an IDR at sample 0 when clipStart is 0), which resets the
          // decoder's references; the ~1-frame seam is the loop's jump-cut. A non-looping reel runs one pass.
          for (let pass = 0; ; pass++) {
            const baseTs = pass * footSpan;
            if (clipStart + baseTs >= sourceEnd) break;   // output fully covered
            let stopped = false;
            for (let i = decodeStartIdx; i < decodeEndIdx; i++) {
              if (signal.aborted) throw new Error('Cancelled');
              if (decoderError) throw decoderError;
              while (frameQueue.length >= MAX_BUFFERED) {
                await new Promise<void>((r) => { producerWaiter = r; });
                if (signal.aborted) throw new Error('Cancelled');
                if (decoderError) throw decoderError;
              }
              const s = videoSamples[i];
              const presentTs = s.timestamp + baseTs;
              if (presentTs > sourceEnd + 0.5) { stopped = true; break; }   // enough for the final (partial) pass
              decoder.decode(new EncodedVideoChunk({
                type: s.isKeyframe ? 'key' : 'delta',
                timestamp: presentTs * 1_000_000,
                data: s.data,
              }));
              setRecProgress(0.05 + Math.min(1, presentTs / Math.max(0.1, sourceEnd)) * 0.1);
            }
            if (stopped || !willLoop) break;   // covered the output, or a single-pass (non-looping) reel
          }
          // Bound flush too: decoder.flush() can hang on a stalled hardware decoder, which would leave the
          // final `await producer` below hanging forever. A healthy flush is near-instant (frames stream out
          // continuously above), so a generous timeout never cuts a real one.
          let flushTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            decoder.flush().finally(() => clearTimeout(flushTimer)),
            new Promise<never>((_, reject) => { flushTimer = setTimeout(() => reject(new Error('Video export stalled (decoder flush timed out) — please try again.')), STALL_MS + 10_000); }),
          ]);
        } finally {
          producerDone = true;
          wakeConsumer();
        }
      })();
      // Surface producer failure to the consumer loop.
      producer.catch((e) => {
        if (!decoderError) decoderError = e instanceof Error ? e : new Error(String(e));
        producerDone = true;
        wakeConsumer();
      });

      const offscreen = new OffscreenCanvas(CANVAS_W, CANVAS_H);
      const offCtx = offscreen.getContext('2d')!;
      let currentFrame: QueuedFrame | null = null;

      // Hand back the latest decoded frame with ts <= targetTs, closing earlier frames as we step past
      // them. Waits for the producer if nothing's available yet; null = the producer is done and nothing
      // is left. It also parks each frame it adopts in `currentFrame`, so the cleanup below closes
      // whatever we're holding even when this throws (abort / decoder error) mid-advance.
      const advanceTo = async (targetTs: number): Promise<QueuedFrame | null> => {
        while (true) {
          if (decoderError) throw decoderError;
          if (signal.aborted) throw new Error('Cancelled');

          while (frameQueue.length > 0 && frameQueue[0].ts <= targetTs) {
            if (currentFrame) currentFrame.frame.close();
            currentFrame = frameQueue.shift()!;
            wakeProducer();
          }

          // Queue head (if any) has ts > targetTs — we're settled.
          if (frameQueue.length > 0) {
            // First-frame edge case: no current frame because the first decoded
            // frame's ts is already past targetTs. Adopt it anyway.
            if (!currentFrame) {
              currentFrame = frameQueue.shift()!;
              wakeProducer();
            }
            return currentFrame;
          }

          // Queue empty + producer done → no more frames coming.
          if (producerDone) return currentFrame;

          // Wait for the next decoded frame (bounded — see waitForFrame: a stalled decoder fails cleanly).
          await waitForFrame();
        }
      };

      try {
        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
          if (signal.aborted) throw new Error('Cancelled');

          // ── Held thumbnail frames ────────────────────────────────────────────
          // Emitted before the decoder is ever advanced, so they cost no decode and can't perturb the
          // monotonic source timeline the producer/consumer handshake depends on. Drawn cover-fit: the
          // still is 9:16 like the canvas, but a mismatched upload gets cropped rather than distorted.
          if (isLeadFrame(frameIdx, lead)) {
            offCtx.fillStyle = '#000';
            offCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
            const bw = thumbBitmap!.width, bh = thumbBitmap!.height;
            const s = Math.max(CANVAS_W / bw, CANVAS_H / bh);
            offCtx.drawImage(thumbBitmap!, (CANVAS_W - bw * s) / 2, (CANVAS_H - bh * s) / 2, bw * s, bh * s);
            const leadSample = new VideoSample(offscreen, { timestamp: frameIdx * EXPORT_FRAME_DURATION + clipStart, duration: EXPORT_FRAME_DURATION });
            await videoSource.add(leadSample);
            leadSample.close();
            setRecProgress(0.15 + (frameIdx / totalFrames) * 0.7);
            continue;
          }

          // Source position advances videoRate× per output frame — the background plays sped-up. The lead
          // is subtracted first, so a thumbnailed reel samples exactly the frames it would have without one.
          const targetTs = sourceTimeFor(frameIdx, lead, EXPORT_FRAME_DURATION, videoRate, clipStart);
          currentFrame = await advanceTo(targetTs);
          if (!currentFrame) {
            console.warn('[EXPORT] no frame available at idx', frameIdx, '— stopping render early');
            break;
          }

          // ── Full-bleed composite: black frame · cover-fit clip (blurred backdrop) · meme on top ──
          offCtx.fillStyle = '#000';
          offCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);

          const vw = srcW || video?.videoWidth || 1080;
          const vh = srcH || video?.videoHeight || 1920;

          // Same helper MemeCanvas previews through: the frame is cover-fit to the WHOLE canvas plus the
          // manual zoom/pan, and only the CLIP window follows the crop bars.
          const { draw: fbDraw, clip: fbClip } = fullBleedVideoRects(
            vw, vh, videoScaleRef.current, videoOffsetRef.current, boxRef.current,
          );

          // Blurred letterbox fill: the CROPPED-VISIBLE slice cover-fit over the whole canvas, so the bars
          // echo only what the viewer actually sees — never the cropped-away parts of the source.
          if (bgBlurRef?.current) {
            const vis = visibleSourceRect(fbDraw, fbClip, vw, vh);
            drawBlurredBackdrop(offCtx, currentFrame.frame, vw, vh, backdropScratch ??= createBackdropScratch(), vis);
          }

          offCtx.save();
          offCtx.beginPath();
          offCtx.rect(fbClip.x, fbClip.y, fbClip.w, fbClip.h);
          offCtx.clip();
          offCtx.drawImage(currentFrame.frame, fbDraw.dx, fbDraw.dy, fbDraw.dw, fbDraw.dh);
          offCtx.restore();
          // Image overlays — topmost layer; targetTs is source-time seconds, same domain as the
          // overlays' [start,end] windows and reveal-step times.
          drawImageOverlays(offCtx, overlaysRef.current, overlayImgsRef.current, targetTs);

          // Output timestamps stay uniform at EXPORT_FPS — the speed-up lives in how far targetTs
          // stepped through the SOURCE per frame, not in the output timing.
          const sample = new VideoSample(offscreen, { timestamp: frameIdx * EXPORT_FRAME_DURATION + clipStart, duration: EXPORT_FRAME_DURATION });
          await videoSource.add(sample);
          sample.close();
          setRecProgress(0.15 + (frameIdx / totalFrames) * 0.7);
        }
      } finally {
        if (currentFrame) { currentFrame.frame.close(); currentFrame = null; }
        while (frameQueue.length > 0) frameQueue.shift()!.frame.close();
        wakeProducer(); // in case it's still waiting on backpressure
      }

      // Wait for producer (decode + flush) to complete before closing decoder.
      try { await producer; } catch { /* already surfaced via decoderError */ }
      if (decoderError) throw decoderError;
      try { decoder.close(); } catch { /* may already be closed */ }

      if (audioSource && audioPackets.length > 0) {
        setRecStatus('Adding audio...');
        for (let i = 0; i < audioPackets.length; i++) {
          await audioSource.add(audioPackets[i], i === 0 && audioDecoderConfigForExport ? { decoderConfig: audioDecoderConfigForExport } : undefined);
        }
      }

      setRecStatus('Finalizing...');
      setRecProgress(0.95);
      await output.finalize();

      let buffer = output.target.buffer;
      if (!buffer) throw new Error('No buffer received from output');
      if (includeEditRef.current) buffer = await mergeWithEdit(buffer, totalDuration);

      const blob = new Blob([buffer], { type: 'video/mp4' });

      // Pre-render mode (Post scheduler): hand the baked MP4 back to the caller instead of
      // saving/downloading it — they upload it and post it to Instagram.
      if (opts?.returnBlob) { setRecProgress(1); return blob; }

      // Filename = the generated YouTube title if present, else the on-card caption; sanitized of
      // filesystem-unsafe characters and word-boundary truncated. Falls back to row/id naming.
      const sanitize = (s: string) => s.replace(/[/\\:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
      let nameBase = sanitize(exportTitle || '') || sanitize(overlayCaption || '');
      if (nameBase.length > 80) {
        const cut = nameBase.slice(0, 80);
        const lastSpace = cut.lastIndexOf(' ');
        nameBase = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
      }
      if (!nameBase) nameBase = videoId ?? 'export';
      // Prefix the reel number (its card position) so every export is numbered and sorts in order —
      // reel 1 → "01_….mp4", reel 2 → "02_….mp4", etc.
      nameBase = `${String(rowNumber + 1).padStart(2, '0')}_${nameBase}`;

      // With generated copy, ship the pair "Download all" ships: the MP4 plus a .txt of the title +
      // description, bundled so one file lands. Without copy there is nothing to pair, so the MP4 is
      // downloaded bare exactly as before. Store-only (level 0) — the MP4 is already compressed.
      const ytTitle = (exportTitle ?? '').trim();
      const ytDesc = (exportDescription ?? '').trim();
      if (ytTitle || ytDesc) {
        const { zip } = await import('fflate');
        const files: Record<string, Uint8Array> = {
          [`${nameBase}.mp4`]: new Uint8Array(await blob.arrayBuffer()),
          [`${nameBase}.txt`]: new TextEncoder().encode(`${ytTitle}\n\n${ytDesc}`.trim() + '\n'),
        };
        const zipped = await new Promise<Uint8Array>((resolve, reject) =>
          zip(files, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data))));
        const zurl = URL.createObjectURL(new Blob([zipped as BlobPart], { type: 'application/zip' }));
        Object.assign(document.createElement('a'), { href: zurl, download: `${nameBase}.zip` }).click();
        URL.revokeObjectURL(zurl);
      } else {
        const url = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), { href: url, download: `${nameBase}.mp4` }).click();
        URL.revokeObjectURL(url);
      }
      // A silently-muted export is worse than a visible warning.
      if (audioDropped) { setRecStatus('⚠ Exported without audio'); setTimeout(() => setRecStatus(''), 6000); keepStatus = true; }
      setRecProgress(1);

    } catch (error) {
      if (error instanceof Error && error.message !== 'Cancelled') {
        console.error('[EXPORT] ❌ EXPORT FAILED:', error);
        console.error('[EXPORT] stack:', error.stack);
        keepStatus = true;
        setRecStatus(`Error: ${error.message}`);
        setTimeout(() => setRecStatus(''), 8000);
        throw error;
      }
    } finally {
      setIsRecording(false);
      setRecProgress(0);
      // Don't wipe a terminal status set just above (error / saved / audio warning): React batches
      // these synchronous updates, so clearing here would coalesce it to '' and it would never render.
      // Each terminal status carries its own timeout to clear itself after it's been seen.
      if (!keepStatus) setRecStatus('');
      const v = config.videoRef.current;
      if (v) { v.muted = true; v.pause(); v.currentTime = 0; v.loop = true; v.playbackRate = 1.0; }
      abortControllerRef.current = null;
    }
  }

  function cancelRecording() {
    abortControllerRef.current?.abort();
    setIsRecording(false);
    setRecProgress(0);
    setRecStatus('');
    const v = config.videoRef.current;
    if (v) { v.muted = true; v.pause(); v.currentTime = 0; v.playbackRate = 1.0; v.loop = true; }
  }

  return { isRecording, recProgress, recStatus, startRecording, cancelRecording };
}
