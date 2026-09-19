'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal, Button, IconButton } from './ui';
import { getRevealModePref, setRevealModePref, MEME_REVEAL_LS } from '@/lib/revealModePref';
import { readClipboardImage, imageUrlFromClipboard, fileFromImageUrl } from '@/lib/clipboardImage';
import type { ImageRevealMode } from '@/lib/redditImageLines';
import { UploadIcon, CloseIcon } from '@/lib/icons';
import { checkMemeImage } from '@/lib/memeImage';

// Meme-style SOURCE: the image to narrate. That's the whole input — the background clip is assigned from the
// shared footage library (the style declares assignsFootage), and the words come from OCR rather than
// anything typed, so unlike CommentarySource there is no script box and no link field.
//
// The image is validated HERE — before a reel exists — because everything downstream assumes a decodable
// raster of a sane size: OCR reads its pixels, the canvas draws it at 1080-wide, and the blob goes to
// IndexedDB. A file rejected at export instead would be rejected after the user had already narrated it.
export function MemeSource({ open, onClose, onCreate }: {
  open: boolean;
  onClose: () => void;
  onCreate: (image: { url: string; name: string; file: Blob; width: number; height: number }) => void;
}) {
  const [image, setImage] = useState<{ url: string; name: string; file: Blob; width: number; height: number } | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Revoke a replaced preview URL — never the one handed to onCreate, which the reel goes on using.
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setChecking(true);
    const res = await checkMemeImage(f);
    setChecking(false);
    if (res.problem) { setError(res.problem); return; }
    setError('');
    setImage(prev => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { url: res.url!, name: f.name, file: f, width: res.width!, height: res.height! };
    });
  };
  const remove = () => { setError(''); setImage(prev => { if (prev) URL.revokeObjectURL(prev.url); return null; }); };

  // The CLICKABLE route to the clipboard — ⌘V (below) already works, but it's invisible: nothing on
  // screen says so except the button label, and a paste is often a mouse-driven moment (copy image in
  // the browser → click over here). navigator.clipboard.read() needs a user gesture + permission,
  // which a click IS; the first use shows Chrome's permission prompt once.
  const pasteFromClipboard = async () => {
    setError('');
    setChecking(true);                      // visible feedback the instant the click lands
    const res = await readClipboardImage();
    setChecking(false);
    if ('error' in res) { setError(res.error); return; }
    await pick(res.file);
  };

  // ⌘V an image straight into the open modal — how a meme usually arrives (screenshot / copied image),
  // and the workspace's own paste handler only takes video files. Scoped to while this modal is open.
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent) => {
      for (const it of Array.from(e.clipboardData?.items ?? [])) {
        if (it.kind !== 'file' || !it.type.startsWith('image/')) continue;
        const f = it.getAsFile();
        if (!f) continue;
        e.preventDefault();
        e.stopPropagation();
        void pick(f);
        return;
      }
      // No pixels — chase a copied <img> URL through the guarded server fetch (see clipboardImage).
      const url = imageUrlFromClipboard(e.clipboardData?.getData('text/html'), e.clipboardData?.getData('text/plain'));
      if (url) {
        e.preventDefault();
        e.stopPropagation();
        void fileFromImageUrl(url).then(res => {
          if ('error' in res) setError(res.error);
          else void pick(res.file);
        });
      }
    };
    // Capture phase: the workspace listens for paste on window too, and must not also act on this event.
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, [open]);

  // Text reveal mode for the NEW reel — baked at create (the erase covers are built with the
  // overlay), persisted so the next reel remembers. See lib/redditTextErase for what erase does.
  const [revealMode, setRevealMode] = useState<ImageRevealMode>(() => getRevealModePref(MEME_REVEAL_LS));

  const create = () => {
    if (!image) return;
    onCreate(image);
    setImage(null); setError('');   // NOT revoked — the reel now owns this URL
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New meme reel"
      size="md"
      footer={
        <>
          <div className="mr-auto flex items-center gap-1.5">
            <span className="text-caption text-fg-3">Text reveal:</span>
            {([['crop', 'scroll'], ['erase', 'erase & reveal in place']] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                title={m === 'crop'
                  ? 'The image un-crops line by line as it’s read (teleprompter)'
                  : 'The whole image shows with its text hidden; each line un-erases as it’s read'}
                onClick={() => { setRevealMode(m); setRevealModePref(MEME_REVEAL_LS, m); }}
                className={`rounded-md border px-2 py-0.5 text-caption transition-colors ${revealMode === m
                  ? 'border-accent-border bg-accent-tint text-accent-text'
                  : 'border-line-strong text-fg-3 hover:bg-hover'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!image} onClick={create}>Create reel</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-caption text-fg-3">Meme image <span className="text-fg-4">· screenshot, meme, comment thread</span></span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              e.target.value = '';   // reset first, so re-picking the same file after a rejection re-fires
              void pick(f);
            }}
          />
          {image ? (
            <div className="flex flex-col gap-2">
              {/* Preview at the aspect the canvas will draw — what you see is what gets read. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.url} alt="" className="max-h-64 w-auto self-start rounded-md border border-line object-contain" />
              <div className="flex items-center gap-2 rounded-md border border-line bg-surface-1 px-2.5 py-2">
                <span className="flex-1 truncate text-body text-fg">{image.name}</span>
                <span className="shrink-0 text-caption text-fg-4">{image.width}×{image.height}</span>
                <IconButton icon={<CloseIcon size={13} />} label="Remove image" variant="secondary" onClick={remove} />
              </div>
            </div>
          ) : (
            <div className="flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={checking}
                className="focus-ring flex flex-1 items-center justify-center gap-2 rounded-md border border-dashed border-line-strong px-3 py-6 text-caption text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
              >
                <UploadIcon /> {checking ? 'Checking image…' : 'Choose an image'}
              </button>
              <button
                type="button"
                onClick={() => void pasteFromClipboard()}
                disabled={checking}
                title="Paste an image from the clipboard (⌘V anywhere in this window works too)"
                className="focus-ring flex items-center justify-center rounded-md border border-dashed border-line-strong px-4 text-caption text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
              >
                Paste
              </button>
            </div>
          )}
          {error && <span className="text-caption text-danger-text">{error}</span>}
        </div>

        <span className="text-caption text-fg-4">
          The reel gets a random background clip from the footage library. The text is read off the image
          automatically — you pick which lines to narrate, and the meme un-crops line by line as it&apos;s read.
        </span>
      </div>
    </Modal>
  );
}
