import { NextRequest, NextResponse } from 'next/server';
import { isSafePublicUrl } from '@/lib/http';

// Fetch ONE image by URL for the paste-by-URL flow (lib/clipboardImage): some sites' "Copy image"
// puts an <img> URL on the clipboard instead of pixels, and the browser can't fetch it itself —
// cross-origin bytes would taint the canvas the meme pipeline draws into. Guarded exactly like the
// Reddit post-image fetch: public hosts only (isSafePublicUrl fails closed on private ranges),
// image/* content types only, hard size cap.

const MAX_BYTES = 8_000_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export async function POST(request: NextRequest) {
  const { url } = await request.json().catch(() => ({}));
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'url required' }, { status: 400 });
  }
  if (!(await isSafePublicUrl(url))) {
    return NextResponse.json({ error: 'That image host can’t be reached.' }, { status: 400 });
  }
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return NextResponse.json({ error: `The image URL answered ${res.status}.` }, { status: 502 });
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return NextResponse.json({ error: 'That URL isn’t an image.' }, { status: 415 });
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return NextResponse.json({ error: 'That image is too large to paste.' }, { status: 413 });
    return new NextResponse(buf, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Couldn’t download that image.' }, { status: 502 });
  }
}
