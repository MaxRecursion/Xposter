/**
 * Minimal image dimension reader for JPEG and PNG buffers.
 *
 * Exists because Pollinations silently downscales anything over its pixel
 * budget: a request for 1024x1024 comes back as 768x768 with a 200 OK. Without
 * an explicit check that regression is invisible, so we decode the header and
 * warn when what we got isn't what we asked for.
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** Returns the pixel dimensions of a JPEG/PNG buffer, or null if unparseable. */
export function readImageSize(buf: Buffer): ImageSize | null {
  return readPngSize(buf) ?? readJpegSize(buf);
}

function readPngSize(buf: Buffer): ImageSize | null {
  // 8-byte signature, then a 25-byte IHDR chunk whose width/height are at 16/20.
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readJpegSize(buf: Buffer): ImageSize | null {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 9 < buf.length) {
    // Markers are 0xFF followed by a type byte; padding 0xFF bytes are legal.
    if (buf[offset] !== 0xff) { offset++; continue; }

    const marker = buf[offset + 1];
    if (marker === 0xff) { offset++; continue; }

    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;

    // SOF0..SOF15 hold the frame dimensions. C4 (DHT), C8 (JPG) and CC (DAC)
    // sit in the same numeric range but are not frame headers.
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isSof) {
      if (offset + 9 >= buf.length) return null;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }

    // 0xDA (start of scan) means entropy-coded data follows — no SOF after this.
    if (marker === 0xda) return null;

    offset += 2 + length;
  }
  return null;
}
