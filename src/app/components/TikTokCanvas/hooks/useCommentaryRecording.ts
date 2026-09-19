'use client';

import { useState, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';

// @ts-expect-error -- mp4box ships no usable type declarations
import MP4Box from 'mp4box';

import { CANVAS_W, CANVAS_H } from '../constants';
import { trackById, trackStreamSrc, DEFAULT_MUSIC_VOLUME } from '@/lib/music';
import { drawImageOverlays } from '../drawing/drawOverlays';
import { drawCommentaryCaptions } from '../drawing/commentaryCaptions';
import { drawBlurredBackdrop, createBackdropScratch, visibleSourceRect } from '../drawing/blurBackdrop';
import { fullBleedVideoRects } from '../drawing/fullBleedVideo';
import { introVoiceStartOutput, introVoiceEndOutput } from '@/lib/introTiming';
import { commentaryPlan, absolutePositionAt, isIntroPhase, COMMENTARY_DUCK_GAIN } from '@/lib/commentaryPlan';
import { exportLead, isLeadFrame, totalOutputFrames, shiftForLead } from '@/lib/thumbnailLead';
import { getOverlayImage } from '@/lib/localVideoStore';
import { getCachedBlob } from '@/lib/reelVideoBlob';
import type { Box, ImageOverlay } from '../types';
import type { EncodedAudioPacketSource as TEncodedAudioPacketSource, EncodedPacket as TEncodedPacket } from 'mediabunny';

// The COMMENTARY export path. A commentary reel is one thing only: a full-bleed uploaded/linked video, an
// ElevenLabs voice-over INTRO over its start (the video keeps its own audio, ducked under the voice), and
// karaoke captions on the intro clock. It has no tweet header, no reel cells, no free elements, no caption
// template and no custom-thumbnail lead — so none of that machinery lives here.
//
// This is a deliberate fork of useRedditRecording (the Reddit path), not a wrapper: the two styles kept
// interfering through shared branches, and every one of those branches was a constant on this side. In
// particular `isIntro` is always TRUE here, which collapses to: the video is never sped up (rate 1), the
// clip is never truncated to the narration, the footage never loops, and the source audio always joins the
// offline mix ducked under the voice rather than being muted by it.

/** A decoded frame waiting to be composited, tagged with its SOURCE time in seconds. */
type QueuedFrame = { frame: VideoFrame; ts: number };

// Local blobs (uploads / byte-cached downloads) are fetched directly; anything remote goes through
// /api/proxy (same-origin URLs like the proxy itself are also direct-fetchable).
function isDirectFetchable(url: string): boolean {
  if (url.startsWith('blob:')) return true;   // byte-cached local blob
  return url.startsWith('/');                 // same-origin (e.g. an /api/proxy stream URL)
}

export interface UseCommentaryRecordingConfig {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  rowNumber: number;
  videoId?: string;
  /** Crop window: only y/h are read — the full-bleed video always spans the canvas width. */
  boxRef: MutableRefObject<Box>;
  videoOffsetRef: MutableRefObject<{ x: number; y: number }>;
  videoScaleRef: MutableRefObject<number>;
  trimStartRef: MutableRefObject<number>;
  trimEndRef: MutableRefObject<number>;
  includeEditRef: MutableRefObject<boolean>;
  /** On-card caption — used only as the export filename fallback (commentary draws no caption). */
  overlayCaption: string;
  /** Generated YouTube title — used as the export filename when present (falls back to caption). */
  exportTitle?: string;
  /** Generated YouTube description. With a title, the export becomes a .zip of MP4 + .txt. */
  exportDescription?: string;
  /** Overlays: the intro (voice-over + captions) plus any image layers, drawn while the playhead
      is inside their [start,end] window. */
  overlaysRef: MutableRefObject<ImageOverlay[]>;
  overlayImgsRef: MutableRefObject<Map<string, HTMLImageElement>>;
  /** Background-music track id (lib/music.ts) — mixed under the export audio. */
  musicIdRef?: MutableRefObject<string | null>;
  /** Music bed volume 0..1 (default DEFAULT_MUSIC_VOLUME). */
  musicVolumeRef?: MutableRefObject<number>;
  /** IndexedDB key of a custom thumbnail still, held for THUMB_LEAD_S before the footage so it can be
      picked in YouTube's Shorts frame picker (see @/lib/thumbnailLead). */
  thumbnailIdRef?: MutableRefObject<string | null>;
  /** Blurred-video letterbox fill (Framing.bgBlur) — drawn behind the video box, matching the preview. */
  bgBlurRef?: MutableRefObject<boolean>;
}

export function useCommentaryRecording(config: UseCommentaryRecordingConfig) {
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
      musicIdRef, musicVolumeRef, bgBlurRef, thumbnailIdRef,
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
      const MIX_SR = 44100, MIX_CH = 2;   // every mix below renders at this rate/layout before AAC

      // Encode a rendered mix to AAC packets plus the decoder config the muxer needs. Both audio paths —
      // the reel's own mix and the appended edit clip's — go through here so they can't drift apart.
      async function encodeMixToAac(mixed: AudioBuffer): Promise<{ packets: TEncodedPacket[]; config: AudioDecoderConfig | null }> {
        const AFRAME = 1024;
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
        if (chunks.length === 0) return { packets: [], config: null };

        // Some encoders never emit a decoderConfig — hand-build the AAC-LC AudioSpecificConfig so the
        // muxer still gets a description it can write.
        let config: AudioDecoderConfig | null = encCfg;
        if (!config) {
          const sfIdx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350].indexOf(MIX_SR);
          const si = sfIdx >= 0 ? sfIdx : 4;
          config = { codec: 'mp4a.40.2', sampleRate: MIX_SR, numberOfChannels: MIX_CH, description: new Uint8Array([(2 << 3) | (si >> 1), ((si & 1) << 7) | (MIX_CH << 3)]) };
        }
        return { packets: chunks.map(chunk => EncodedPacket.fromEncodedChunk(chunk)), config };
      }

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

        let allAudioPackets: TEncodedPacket[] = [];
        let sharedAudioConfig: AudioDecoderConfig | null = null;
        setRecStatus('Mixing audio...');
        try {
          if (typeof AudioEncoder === 'undefined' || typeof OfflineAudioContext === 'undefined')
            throw new Error('Web Audio API not supported');

          const tempCtx = new AudioContext({ sampleRate: MIX_SR });
          let mainAudioBuffer: AudioBuffer;
          try { mainAudioBuffer = await tempCtx.decodeAudioData(mainBuffer.slice(0)); }
          catch { mainAudioBuffer = tempCtx.createBuffer(MIX_CH, Math.ceil(mainDuration * MIX_SR), MIX_SR); }
          const editAudioBuffer = await tempCtx.decodeAudioData(editArrayBuffer.slice(0));
          await tempCtx.close();

          const totalSamples = Math.ceil((mainDuration + editAudioBuffer.duration) * MIX_SR);
          const offA = new OfflineAudioContext(MIX_CH, totalSamples, MIX_SR);
          const ms = offA.createBufferSource(); ms.buffer = mainAudioBuffer; ms.connect(offA.destination); ms.start(0);
          const es = offA.createBufferSource(); es.buffer = editAudioBuffer; es.connect(offA.destination); es.start(mainDuration);

          const aac = await encodeMixToAac(await offA.startRendering());
          allAudioPackets = aac.packets;
          sharedAudioConfig = aac.config;
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
      let videoTrackId: number | null = null;
      let videoTimescale = 90000;
      // The audio never goes through mp4box: the mix decodes the whole file with WebAudio and the copy path
      // re-reads it with mediabunny, so all we need from the demux is WHETHER the file has an audio track
      // (extracting its samples here would copy the entire track into memory for nothing).
      let hasSourceAudio = false;
      // Source video dimensions read from the demuxed track — the <video> element may still be loading,
      // so we can't rely on video.videoWidth/Height here.
      let srcW = 0, srcH = 0;

      MP4BoxFile.onReady = (info: { tracks?: Array<{ id: number; type: string; timescale?: number }> }) => {
        for (const track of info.tracks || []) {
          if (track.type === 'video' && !videoTrackId) {
            videoTrackId = track.id; videoTimescale = track.timescale || 90000;
            const vt = track as { video?: { width?: number; height?: number }; track_width?: number; track_height?: number };
            srcW = vt.video?.width || vt.track_width || 0;
            srcH = vt.video?.height || vt.track_height || 0;
          }
          if (track.type === 'audio') hasSourceAudio = true;
        }
        if (videoTrackId) MP4BoxFile.setExtractionOptions(videoTrackId, null, { nbSamples: Infinity });
        MP4BoxFile.start();
      };

      MP4BoxFile.onSamples = (id: number, _user: unknown, samples: Array<{ data: ArrayBuffer; cts: number; duration: number; is_sync: boolean }>) => {
        if (id !== videoTrackId) return;
        for (const s of samples) videoSamples.push({ data: new Uint8Array(s.data), timestamp: s.cts / videoTimescale, duration: s.duration / videoTimescale, isKeyframe: s.is_sync });
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
      // The clip is exactly the trim window — the intro plays OVER the video's start, so it never
      // shortens, extends or loops the footage the way a Reddit narration does.
      const clipStart = trimStartRef.current;
      const clipEnd = trimEndRef.current > 0 && trimEndRef.current <= fullDuration ? trimEndRef.current : fullDuration;
      const clipSpan = Math.max(0.1, clipEnd - clipStart);
      // The reel plays its clip TWICE (lib/commentaryPlan): once under the commentary with its own audio
      // heavily muted (looping if the voice outlasts it), then restarted from the beginning at full volume.
      // So the output runs intro + clip, and the source is decoded across `plan.passes` passes.
      const introOverlay = (overlaysRef.current ?? []).find(o => o.intro && o.audioId && (o.audioDuration ?? 0) > 0);
      const plan = commentaryPlan(introOverlay?.audioDuration ?? 0, clipSpan);
      const outputDuration = Math.max(0.1, plan.total);   // rate 1: output seconds == source seconds
      // Custom thumbnail: decoded up front so a bad still falls back to a normal export rather than
      // aborting one. NO_LEAD when there's none, which makes every call below a no-op.
      let thumbBitmap: ImageBitmap | null = null;
      if (thumbnailIdRef?.current) {
        try {
          const rec = await getOverlayImage(thumbnailIdRef.current);
          if (rec) thumbBitmap = await createImageBitmap(rec.blob);
        } catch (e) { console.warn('[EXPORT] thumbnail still could not be decoded — exporting without it:', e); }
      }
      const lead = exportLead(!!thumbBitmap, EXPORT_FPS);
      const totalDuration = outputDuration + lead.seconds;
      const totalFrames = totalOutputFrames(outputDuration, EXPORT_FPS, lead);

      // The narration: a commentary reel carries exactly ONE voice-over (CanvasGrid replaces the overlay
      // wholesale on every re-narrate), and it is always the INTRO — anchored to the output start, played at
      // its natural rate, with the video's own audio ducked under it rather than muted. May be absent: the
      // reel is exportable before it has been voiced.
      const intro = overlaysRef.current.find(o => o.intro && o.audioId && (o.audioDuration ?? 0) > 0) ?? null;

      // E1: bound the DECODE to the composited window. The consumer only draws [clipStart, clipEnd], but the
      // producer would otherwise decode the ENTIRE file — pure waste on a trimmed reel. Decode from the
      // keyframe at/before clipStart (required to reconstruct clipStart) through clipEnd + a reorder margin
      // (the +0.5 look-ahead buys a clean FINAL frame). No-op for an untrimmed clip.
      let decodeStartIdx = 0;
      for (let i = 0; i < videoSamples.length; i++) {
        if (videoSamples[i].timestamp > clipStart) break;
        if (videoSamples[i].isKeyframe) decodeStartIdx = i;
      }
      // The +0.5 reorder look-ahead only buys a clean FINAL frame. Across MULTIPLE passes it must be 0:
      // feeding samples past clipEnd would emit frames whose shifted timestamps land inside the NEXT pass's
      // window — the consumer would adopt end-of-clip content as that pass's opening frames. Each pass's
      // keyframe flushes the decoder anyway, so nothing is lost by stopping exactly at clipEnd.
      const decodeMargin = plan.passes > 1 ? 0 : 0.5;
      let decodeEndIdx = videoSamples.length;
      for (let i = decodeStartIdx; i < videoSamples.length; i++) {
        if (videoSamples[i].timestamp > clipEnd + decodeMargin) { decodeEndIdx = i; break; }
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

      // ── Intro voice + music mix ───────────────────────────────────────────────
      // Up to three sources land on one offline timeline and are re-encoded to AAC: the intro voice, the
      // optional music bed, and the video's OWN audio ducked under the voice. The fast AAC packet-copy
      // path below can't blend, so it only runs when there's nothing to mix.
      const musicTrack = trackById(musicIdRef?.current);
      if ((intro || musicTrack) && typeof AudioEncoder !== 'undefined' && typeof OfflineAudioContext !== 'undefined') {
        setRecStatus('Mixing narration...');
        try {
          const tempCtx = new AudioContext({ sampleRate: MIX_SR });
          // Decoded voice + its OUTPUT-time anchors, resolved once here so the placement and the duck
          // envelope below can't disagree about where the voice starts and ends.
          let voice: { buf: AudioBuffer; startOut: number; endOut: number } | null = null;
          if (intro) {
            const rec = await getOverlayImage(intro.audioId!);
            try {
              if (rec) {
                const at = intro.audioStart ?? intro.start;
                voice = {
                  buf: await tempCtx.decodeAudioData(await rec.blob.arrayBuffer()),
                  startOut: introVoiceStartOutput(at, clipStart, 1),
                  endOut: introVoiceEndOutput(at, intro.audioDuration ?? 0, clipStart, 1),
                };
              }
            } catch { /* an undecodable voice-over still exports the video */ }
          }
          // Background music: decoded once, looped across the whole output at a low gain.
          let musicBuf: AudioBuffer | null = null;
          if (musicTrack) {
            try {
              const res = await fetch(trackStreamSrc(musicTrack));
              if (res.ok) musicBuf = await tempCtx.decodeAudioData(await res.arrayBuffer());
            } catch { /* music is optional — export continues without it */ }
          }
          // The video keeps its own audio, so it joins the mix too — but only if there IS a mix for it to
          // join (otherwise the packet-copy path carries it through untouched, and cheaper).
          let sourceBuf: AudioBuffer | null = null;
          if ((voice || musicBuf) && hasSourceAudio) {
            try { sourceBuf = await tempCtx.decodeAudioData(arrayBuffer.slice(0)); }
            catch { /* keep the voice/music rather than dropping the mix */ }
          }
          await tempCtx.close();

          if (voice || musicBuf) {
            // Output time == source time here (rate 1), so the mix spans exactly the clip.
            // Every cue shifts by lead.seconds so the mix moves with the video and the held frames play silent.
            const offA = new OfflineAudioContext(MIX_CH, Math.ceil(totalDuration * MIX_SR), MIX_SR);
            if (voice) {
              const src = offA.createBufferSource();
              src.buffer = voice.buf;
              src.connect(offA.destination);
              // The intro is anchored to the output START and must play in FULL — even if the video is
              // trimmed (clipStart > 0) — so it never skips its head; it just starts at output 0.
              src.start(shiftForLead(voice.startOut, lead));
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
              if (voice) {
                // The clip's audio plays TWICE, mirroring the picture (lib/commentaryPlan):
                //  · under the commentary, heavily muted and looping to cover the voice,
                //  · then again in full at normal volume once the voice ends.
                const under = offA.createBufferSource();
                under.buffer = sourceBuf;
                under.loop = true;                   // a long commentary outlasts the clip
                under.loopStart = clipStart;
                under.loopEnd = clipEnd;
                const g = offA.createGain();
                g.gain.value = COMMENTARY_DUCK_GAIN;
                under.connect(g); g.connect(offA.destination);
                under.start(lead.seconds, clipStart);
                under.stop(shiftForLead(plan.introDur, lead));

                const main = offA.createBufferSource();
                main.buffer = sourceBuf;
                main.connect(offA.destination);
                main.start(shiftForLead(plan.introDur, lead), clipStart, clipSpan);
              } else {
                // Not voiced yet: the reel is simply the clip, once, at full volume.
                const only = offA.createBufferSource();
                only.buffer = sourceBuf;
                only.connect(offA.destination);
                only.start(lead.seconds, clipStart, clipSpan);
              }
            }

            const aac = await encodeMixToAac(await offA.startRendering());
            if (aac.packets.length > 0) {
              audioSource = new EncodedAudioPacketSource('aac');
              output.addAudioTrack(audioSource);
              audioPackets = aac.packets;
              audioDecoderConfigForExport = aac.config;
            }
          }
        } catch (e) {
          console.error('[narration mix] failed — exporting without audio:', e);
        }
      }

      if (!audioSource && !intro && hasSourceAudio) {
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
      const audioDropped = hasSourceAudio && (!audioSource || audioPackets.length === 0);

      // Ensure every image overlay is decoded before the frame loop (object URLs — no CORS taint).
      for (const o of overlaysRef.current) {
        if (!o.src) continue;
        const existing = overlayImgsRef.current.get(o.id);
        if (existing?.complete && existing.naturalWidth > 0) continue;
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => { overlayImgsRef.current.set(o.id, img); resolve(); };
          img.onerror = () => resolve();
          img.src = o.src!;
        });
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

      // Each pass re-decodes the clip from the keyframe at/before clipStart, so it emits PRE-ROLL frames
      // whose (shifted) timestamps fall before that pass's start. They're needed to decode the rest, but
      // handing them to the consumer would walk its monotonic timeline backwards and let a stale frame be
      // adopted. The producer raises this bound at each pass; anything below it is decoded and dropped.
      let minPresentTs = -Infinity;
      const decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          const ts = frame.timestamp / 1_000_000;
          if (ts < minPresentTs - 1e-6) { frame.close(); return; }
          frameQueue.push({ frame, ts });
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

      // decoder.flush() can hang on a stalled hardware decoder, which would leave the `await producer` below
      // hanging forever. A healthy flush is near-instant (frames stream out continuously), so a generous
      // timeout never cuts a real one. Used between passes AND at the end.
      const flushBounded = async () => {
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          decoder.flush().finally(() => clearTimeout(flushTimer)),
          new Promise<never>((_, reject) => { flushTimer = setTimeout(() => reject(new Error('Video export stalled (decoder flush timed out) — please try again.')), STALL_MS + 10_000); }),
        ]);
      };

      const producer = (async () => {
        try {
          // One pass per time the clip is shown (see plan.passes): the commentary phase loops it as needed,
          // then phase B replays it once more. Pass `p` re-feeds the same samples with every timestamp
          // shifted by p × clipSpan, so the consumer sees ONE monotonically increasing timeline. Each pass
          // restarts at a keyframe, which resets the decoder's references; the seam is a clean jump-cut.
          const sourceEnd = clipStart + plan.passes * clipSpan;
          for (let pass = 0; pass < plan.passes; pass++) {
            const baseTs = pass * clipSpan;
            minPresentTs = clipStart + baseTs;   // drop this pass's pre-roll (see the decoder's output above)
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
              if (presentTs > sourceEnd + 0.5) break;   // enough for the final (possibly partial) pass
              decoder.decode(new EncodedVideoChunk({
                type: s.isKeyframe ? 'key' : 'delta',
                timestamp: presentTs * 1_000_000,
                data: s.data,
              }));
              setRecProgress(0.05 + Math.min(1, presentTs / Math.max(0.1, sourceEnd)) * 0.1);
            }
            // Drain THIS pass before raising the bound for the next one. decode() is asynchronous and this
            // loop's only yield is the queue-full wait — which never triggers while frames are being dropped
            // — so without this the producer ran every pass synchronously, leaving minPresentTs at the LAST
            // pass before a single frame emerged. Every earlier pass was then discarded, the consumer
            // starved through the commentary and held one frame: the video was frozen under the voice.
            // flush() resolves only once this pass's frames are all out (and yields, so the consumer drains).
            // Safe between passes: each begins at a keyframe, which is what resets the decoder anyway.
            await flushBounded();
          }
          // The per-pass flush above already drained the last pass; this is a no-op safety net.
          await flushBounded();
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

          // Held thumbnail frames, emitted before the decoder is advanced so they cost no decode and
          // can't perturb the monotonic source timeline the producer/consumer handshake relies on.
          if (isLeadFrame(frameIdx, lead)) {
            offCtx.fillStyle = '#000';
            offCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
            const bw = thumbBitmap!.width, bh = thumbBitmap!.height;
            const sc = Math.max(CANVAS_W / bw, CANVAS_H / bh);
            offCtx.drawImage(thumbBitmap!, (CANVAS_W - bw * sc) / 2, (CANVAS_H - bh * sc) / 2, bw * sc, bh * sc);
            const leadSample = new VideoSample(offscreen, { timestamp: frameIdx * EXPORT_FRAME_DURATION + clipStart, duration: EXPORT_FRAME_DURATION });
            await videoSource.add(leadSample);
            leadSample.close();
            setRecProgress(0.15 + (frameIdx / totalFrames) * 0.7);
            continue;
          }

          // Rate 1: one output frame is one frame of the composition. The lead is subtracted first, so a
          // thumbnailed reel samples exactly the frames it would have without one. `absolutePositionAt`
          // turns output time into the position on the producer's multi-pass timeline — advancing 1:1 under
          // the commentary, then jumping to the next whole pass when it ends (the restart).
          const contentIdx = frameIdx - lead.frames;
          const outT = contentIdx * EXPORT_FRAME_DURATION;
          const targetTs = clipStart + absolutePositionAt(outT, plan);
          currentFrame = await advanceTo(targetTs);
          if (!currentFrame) {
            console.warn('[EXPORT] no frame available at idx', frameIdx, '— stopping render early');
            break;
          }

          // ── Full-bleed video ─────────────────────────────────────────────────
          // Composited through the SAME helper as the live canvas (see drawing/fullBleedVideo), so the
          // exported frame and the preview cannot drift apart: cover-fit to the whole canvas plus the
          // manual zoom/pan, with only the clip window following the crop bars.
          offCtx.fillStyle = '#000';
          offCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);

          const vw = srcW || video.videoWidth || CANVAS_W;
          const vh = srcH || video.videoHeight || CANVAS_H;
          const { draw, clip } = fullBleedVideoRects(vw, vh, videoScaleRef.current, videoOffsetRef.current, boxRef.current);

          // Blurred-video letterbox fill — same helper + same CROPPED-VISIBLE slice as the preview, so
          // both composite identically (the bars never echo cropped-away parts of the source).
          if (bgBlurRef?.current) {
            const vis = visibleSourceRect(draw, clip, vw, vh);
            drawBlurredBackdrop(offCtx, currentFrame.frame, vw, vh, backdropScratch ??= createBackdropScratch(), vis);
          }

          offCtx.save();
          offCtx.beginPath();
          offCtx.rect(clip.x, clip.y, clip.w, clip.h);
          offCtx.clip();
          offCtx.drawImage(currentFrame.frame, draw.dx, draw.dy, draw.dw, draw.dh);
          offCtx.restore();

          // Image overlays — targetTs is source-time seconds, the same domain as the overlays'
          // [start,end] windows and reveal-step times.
          drawImageOverlays(offCtx, overlaysRef.current, overlayImgsRef.current, targetTs);
          // Karaoke captions, topmost. They run on the intro clock: the output start (clipStart) maps to
          // caption-time 0, so they stay in step with the voice however the video is trimmed.
          // Captions belong to the commentary only — the voice starts at output 0, so output time IS the
          // caption clock. Phase B (the clip replayed in full) carries none.
          if (isIntroPhase(outT, plan)) drawCommentaryCaptions(offCtx, overlaysRef.current, outT);

          // Output timestamps stay uniform at EXPORT_FPS; at rate 1 they coincide with the source time
          // this frame sampled (both offset by clipStart), so targetTs IS the output timestamp.
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
