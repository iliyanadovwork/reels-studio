import { describe, it, expect } from 'vitest';
import { imageUrlFromClipboard } from './clipboardImage';

// Pixel-less "Copy image" (observed live: clipboard types text/plain + text/html for a copied image)
// puts markup or a bare URL on the clipboard. These pin what we extract — and what we refuse.

describe('imageUrlFromClipboard', () => {
  it('pulls the src out of a copied <img> tag', () => {
    expect(imageUrlFromClipboard('<meta charset="utf-8"><img src="https://cdn.site.com/a/b.png" alt="x">'))
      .toBe('https://cdn.site.com/a/b.png');
  });

  it('decodes &amp; in query strings — signed CDN URLs break without it', () => {
    expect(imageUrlFromClipboard('<img src="https://cdn.io/i.jpg?w=1&amp;s=abc">'))
      .toBe('https://cdn.io/i.jpg?w=1&s=abc');
  });

  it('accepts single quotes and extra attributes before src', () => {
    expect(imageUrlFromClipboard("<img class='big' data-x='1' src='https://h.com/p.webp'/>"))
      .toBe('https://h.com/p.webp');
  });

  it('falls back to a bare URL in text/plain', () => {
    expect(imageUrlFromClipboard(undefined, ' https://images.example.com/full.jpeg ')).toBe('https://images.example.com/full.jpeg');
  });

  it('prefers the html <img> over the plain text', () => {
    expect(imageUrlFromClipboard('<img src="https://a.com/1.png">', 'https://b.com/2.png')).toBe('https://a.com/1.png');
  });

  it('refuses non-http schemes wherever they appear', () => {
    expect(imageUrlFromClipboard('<img src="data:image/png;base64,AAAA">')).toBeNull();
    expect(imageUrlFromClipboard('<img src="file:///etc/passwd">')).toBeNull();
    expect(imageUrlFromClipboard(undefined, 'javascript:alert(1)')).toBeNull();
  });

  it('refuses prose that merely contains a URL — pasting an article must not fetch a picture', () => {
    expect(imageUrlFromClipboard(undefined, 'read this https://a.com/x.png thanks')).toBeNull();
    expect(imageUrlFromClipboard('<p>no images here</p>', 'plain words')).toBeNull();
  });

  it('handles empty and missing flavors', () => {
    expect(imageUrlFromClipboard()).toBeNull();
    expect(imageUrlFromClipboard('', '')).toBeNull();
  });
});
