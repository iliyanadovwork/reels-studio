// Read an image off the system clipboard via the async Clipboard API. One implementation for every
// "Paste" button (the New-meme-reel modal, the per-reel Meme-image flyout) so they can't drift on
// permission handling or messaging. A click IS the user gesture the API needs; Chrome asks
// permission once per origin.

export type ClipboardImageResult = { file: File } | { error: string };

/** The image URL a pixel-less "Copy image" actually put on the clipboard, if any: some sites'
    custom context menus copy an <img> tag (text/html) or a bare URL (text/plain) instead of image
    data. Pure (regex, no DOM) so it's node-testable and usable from both the button and ⌘V paths. */
export function imageUrlFromClipboard(html?: string, text?: string): string | null {
  const m = html?.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) {
    const url = m[1].replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(url)) return url;
  }
  const t = text?.trim() ?? '';
  return /^https?:\/\/\S+$/i.test(t) ? t : null;
}

/** Download a pasted image URL through the guarded server route (client fetch would be CORS-blocked
    and would taint the canvas), returning it as a File on the same path a chosen file takes. */
export async function fileFromImageUrl(url: string): Promise<ClipboardImageResult> {
  try {
    const res = await fetch('/api/fetch-image', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { error: (j as { error?: string }).error ?? 'Couldn’t download that image.' };
    }
    const blob = await res.blob();
    const name = new URL(url).pathname.split('/').pop() || 'pasted-image';
    return { file: new File([blob], name, { type: blob.type || 'image/png' }) };
  } catch {
    return { error: 'Couldn’t download that image.' };
  }
}

export async function readClipboardImage(): Promise<ClipboardImageResult> {
  try {
    // clipboard.read() can PEND FOREVER: it fires a permission prompt, and until the user answers,
    // the promise neither resolves nor rejects — which a button click renders as "nothing happened".
    // The race converts that silence into instructions. (If permission is granted after the timeout,
    // the next click succeeds instantly — the grant is remembered.)
    const items = await Promise.race([
      navigator.clipboard.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new DOMException('pending', 'TimeoutError')), 4000)),
    ]);
    for (const item of items) {
      const type = item.types.find(t => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      return { file: new File([blob], `pasted-${Date.now().toString(36)}.${type.split('/')[1] || 'png'}`, { type }) };
    }
    // No pixels — but some sites' "Copy image" puts an <img> URL on the clipboard instead of image
    // data (observed live: types were text/plain + text/html for a copied image). Chase the URL
    // through the guarded server fetch before giving up.
    let html: string | undefined, text: string | undefined;
    for (const item of items) {
      if (!html && item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
      if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
    }
    const url = imageUrlFromClipboard(html, text);
    if (url) return fileFromImageUrl(url);
    return { error: 'No image data on the clipboard. If you copied a file, press ⌘V instead — the button only reads copied image pixels (right-click → Copy Image, or a screenshot).' };
  } catch (e) {
    console.warn('[clipboard] read failed:', e);
    const name = e instanceof DOMException ? e.name : '';
    return {
      error: name === 'TimeoutError'
        ? 'Chrome is waiting for clipboard permission — look for a prompt or clipboard icon by the address bar, allow it, then click Paste again. (⌘V works without any permission.)'
        : name === 'NotAllowedError'
          ? 'Chrome blocked the clipboard read — allow it from the clipboard icon in the address bar, or press ⌘V.'
          : 'Couldn’t read the clipboard — press ⌘V instead.',
    };
  }
}
