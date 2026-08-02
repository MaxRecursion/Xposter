/**
 * Detect image MIME type from magic bytes.
 *
 * Shared by fal (CDN upload + data-URI refs) and Gemini (inline reference
 * parts) so PNG/WebP anchors are never mislabelled as JPEG.
 */
export function sniffMime(buf: Buffer): string {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 2 && buf.readUInt16BE(0) === 0xffd8) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

export function extensionForMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}
