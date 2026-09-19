'use client';

import { useRef, useState } from 'react';
import { Modal, Button, IconButton } from './ui';
import { UploadIcon, CloseIcon, VideoIcon, LinkIcon } from '@/lib/icons';
import { checkVideoFile } from '@/lib/videoProbe';

// Commentary-style SOURCE: a video — paste a LINK (Instagram / TikTok / X / YouTube, fetched like the rest of
// the app) or upload a file — plus the voice-over script. The shared engine (render, narration, export) does
// the rest. A link and a file are mutually exclusive; whichever is set wins.
export function CommentarySource({ open, onClose, onCreate }: {
  open: boolean;
  onClose: () => void;
  onCreate: (source: { link?: string; video?: { url: string; name: string; file: Blob } }, script: string) => void;
}) {
  const [link, setLink] = useState('');
  // The File rides along with its object URL: the reel persists these bytes to IndexedDB, and re-reading
  // them back through the URL would push the whole video through memory a second time.
  const [video, setVideo] = useState<{ url: string; name: string; file: Blob } | null>(null);
  const [script, setScript] = useState('');
  const [fileError, setFileError] = useState('');
  const [checking, setChecking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Revoke a replaced object URL (never the one handed to onCreate — the reel keeps using it).
  const pick = async (f: File | undefined) => {
    if (!f || !f.type.startsWith('video/')) return;
    // A video that's too big to store, or in a codec the exporter can't read, is refused HERE — before a
    // script is written and voiced against it.
    setChecking(true);
    const problem = await checkVideoFile(f);
    setChecking(false);
    setFileError(problem ?? '');
    if (problem) return;
    setLink('');   // picking a file clears any typed link
    setVideo(prev => { if (prev) URL.revokeObjectURL(prev.url); return { url: URL.createObjectURL(f), name: f.name, file: f }; });
  };
  const removeVideo = () => { setFileError(''); setVideo(prev => { if (prev) URL.revokeObjectURL(prev.url); return null; }); };

  const trimmedLink = link.trim();
  const canCreate = !!trimmedLink || !!video;
  const create = () => {
    if (trimmedLink) onCreate({ link: trimmedLink }, script.trim());
    else if (video) onCreate({ video }, script.trim());
    else return;
    setLink(''); setVideo(null); setScript(''); setFileError('');
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New commentary reel"
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!canCreate} onClick={create}>Create reel</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-caption text-fg-3">Video link <span className="text-fg-4">· Instagram, TikTok, X, YouTube</span></span>
          <div className={`flex items-center gap-2 rounded-md border border-line bg-surface-1 px-2.5 py-2 ${video ? 'opacity-40' : ''}`}>
            <LinkIcon size={14} />
            <input
              value={link}
              // Typing a link abandons the file the user was choosing, so a rejection message about that
              // file must go with it — otherwise it sits under the (now irrelevant) upload button.
              onChange={e => { setLink(e.target.value); setFileError(''); if (e.target.value.trim() && video) removeVideo(); }}
              placeholder="Paste a reel / post link…"
              disabled={!!video}
              className="flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-4"
            />
          </div>
        </div>

        <div className="flex items-center gap-3 text-caption text-fg-4">
          <span className="h-px flex-1 bg-line" /> or upload a file <span className="h-px flex-1 bg-line" />
        </div>

        <div className="flex flex-col gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              e.target.value = '';   // reset first, so re-picking the same file after a rejection re-fires
              void pick(f);
            }}
          />
          {video ? (
            <div className="flex items-center gap-2 rounded-md border border-line bg-surface-1 px-2.5 py-2">
              <VideoIcon size={14} />
              <span className="flex-1 truncate text-body text-fg">{video.name}</span>
              <IconButton icon={<CloseIcon size={13} />} label="Remove video" variant="secondary" onClick={removeVideo} />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={!!trimmedLink || checking}
              className="focus-ring flex items-center justify-center gap-2 rounded-md border border-dashed border-line-strong px-3 py-4 text-caption text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <UploadIcon /> {checking ? 'Checking video…' : 'Choose a video file'}
            </button>
          )}
          {fileError && <span className="text-caption text-danger-text">{fileError}</span>}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-caption text-fg-3">Commentary script <span className="text-fg-4">· spoken over the start</span></span>
          <textarea
            value={script}
            onChange={e => setScript(e.target.value)}
            rows={4}
            placeholder="What the narrator says over the intro…"
            className="focus-ring w-full resize-y rounded-md border border-line bg-surface-1 px-2 py-1.5 text-body text-fg leading-relaxed placeholder:text-fg-4"
          />
          <span className="text-caption text-fg-4">Optional — you can add it later. It’s voiced by ElevenLabs and shown as synced captions.</span>
        </div>
      </div>
    </Modal>
  );
}
