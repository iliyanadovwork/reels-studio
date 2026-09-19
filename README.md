# Reels Studio

A short-form video workspace that takes a Reddit thread and produces a finished,
narrated, captioned 1080×1920 MP4, with the render happening **in the browser**,
not on a server.

Next.js 16 / React 19 / TypeScript. 33,833 lines across 169 files, **832 tests**,
`tsc --noEmit` clean.

---

## The pipeline

```
Scout  →  Import  →  Pick  →  Narrate  →  Copy  →  Export
```

**Scout** (`docs/reddit-scout/`, `src/app/api/reddit-scout/`) surfaces popular Reddit
threads suited to the "thread over gameplay footage" format, and permanently records
every post used *or rejected*, so nothing is ever suggested twice.

**Narrate** (`src/app/api/tts/`) is the interesting one, see below.

**Export** composites the reel and encodes H.264 entirely client-side: mp4box demux →
WebCodecs → mediabunny mux. When a source's HD stream is H.265, it falls back to the
H.264 variant automatically, so export always works rather than failing late.

Three canvas types, `MemeCanvas`, `RedditCanvas`, `CommentaryCanvas`, share one
timeline editor with trim, split, delete, filmstrip thumbnails, a zoomable ruler and
undo/redo. Everything persists locally (localStorage + IndexedDB); uploaded video
survives a reload.

## Narration, and why the timestamps matter

`src/app/api/tts/route.ts` calls ElevenLabs' **`/with-timestamps`** endpoint rather than
plain text-to-speech, and keeps `alignment.character_start_times_seconds`.

That array is the whole point. Captions are not guessed from word counts or an estimated
words-per-minute, each line's reveal is placed at the audio time of its **first
character**, so the on-screen text lands on the syllable being spoken. The reveal leads
the audio slightly (`REVEAL_LEAD_S`), because a caption appearing exactly on the beat
reads as late.

Consecutive lines are grouped by voice and each group is synthesised as one request, so a
multi-voice script stays natural inside a speaker's turn instead of being cut per line.
Groups are decoded and stitched strictly in order. The delivery-speed control uses
ElevenLabs' native speed rather than post-hoc resampling, and the timestamps come back
already reflecting the sped audio, which is why captions stay aligned when you change it.

## Performance

each change with its stage, expected win and risk. The ones that shipped:

| | Change | Win |
|---|---|---|
| **N1** | Fire per-voice TTS calls through a bounded pool, decode and stitch strictly in group order | multi-voice cards generate ~N× faster, **byte-identical WAV** |
| **C1** | Cache `{post, comments}` at bulk-build instead of re-importing per reel | removes a ~650 ms serialized re-import per reel |
| **E1** | Bound the WebCodecs decode to `[keyframe ≤ clipStart, clipEnd + 0.5s]` | a trimmed reel skips frames it never draws, up to ~2× on short clips |
| **E2** | `hardwareAcceleration: 'prefer-hardware'` on the H.264 encoder | VideoToolbox on macOS, transparent software fallback |

Export is the dominant cost (CPU-bound, ~30-90 s/reel), which is why E1 and E2 matter most.

The same pass fixed a bug worth naming: narration was issuing a `/api/tts` call for
*every* voice group instead of bailing after the first failure, wasted API credits and a
slower Cancel. `fetchTts` now also retries 4 times with exponential backoff and jitter
(0.6 → 1.2 → 2.4 s).

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 832 tests
npx tsc --noEmit
```

Set `ELEVENLABS_API_KEY` in `.env.local` for narration, or paste a key into the
Narration panel at runtime, which is the path the UI offers so the server never needs one.

Link-based reels need the dev server running: `/api/download` resolves the link and
`/api/proxy` streams the CDN video past CORS. Uploads are fully client-side.

## Layout

```
src/app/api/tts/                    ElevenLabs narration with character timestamps
src/app/api/reddit-scout/           thread discovery and the seen/rejected ledger
src/app/api/download, /proxy        link resolution and CORS-passthrough streaming
src/app/components/CanvasGrid.tsx   the pipeline orchestrator
src/app/components/TikTokCanvas/    the three canvases and the recording hooks
docs/reddit-scout/                  requirements, build plan, schema and migrations
```

