// PNG reading and writing for the tools, with no dependencies: a PNG is a few
// chunks around a deflate stream, and node ships zlib. Used by make-icons (to
// write), smoke (to measure a real capture) and preview (to show one).

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** A decoded image: interleaved 8-bit samples, `channels` per pixel. */
export interface PNGImage {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}

/** What `analyse` reports about a capture. */
export interface PNGStats {
  width: number;
  height: number;
  mean: number;
  stdev: number;
  max: number;
  litFraction: number;
  colourFraction: number;
}

/** Encode 8-bit RGBA pixels as a PNG (filter: none). */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decode an 8-bit RGB/RGBA PNG (all five filter types). */
export function decodePng(buffer: Buffer): PNGImage {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('only 8-bit PNGs are supported');
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const current = out.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = previous ? previous[x] : 0;
      const c = previous && x >= channels ? previous[x - channels] : 0;
      const v = line[x];
      let value: number;
      switch (filter) {
        case 0: value = v; break;
        case 1: value = v + a; break;
        case 2: value = v + b; break;
        case 3: value = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown filter ${filter}`);
      }
      current[x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** How much picture there is: mean luminance, spread, colour, highlights. */
export function analyse(image: PNGImage): PNGStats {
  const { data, channels, width, height } = image;
  let sum = 0;
  let sum2 = 0;
  let max = 0;
  let coloured = 0;
  let lit = 0;
  const pixels = width * height;
  for (let i = 0; i < pixels; i++) {
    const at = i * channels;
    const r = data[at];
    const g = data[at + 1];
    const b = data[at + 2];
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sum += luma;
    sum2 += luma * luma;
    if (luma > max) max = luma;
    if (luma > 0.06) lit++;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 12) coloured++;
  }
  const mean = sum / pixels;
  return {
    width,
    height,
    mean,
    stdev: Math.sqrt(Math.max(0, sum2 / pixels - mean * mean)),
    max,
    litFraction: lit / pixels,
    colourFraction: coloured / pixels,
  };
}

/** Average a region of the image, for checking a corner against the centre. */
/**
 * The mean absolute luminance difference between two captures, per pixel. Two
 * frames of the same sky are never identical, so this is how a soak asks "is
 * this still being drawn, or is it frozen?"
 */
export function meanDifference(a: PNGImage, b: PNGImage): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  let sum = 0;
  const pixels = a.width * a.height;
  for (let i = 0; i < pixels; i++) {
    const at = i * a.channels;
    const other = i * b.channels;
    const la = (0.2126 * a.data[at]! + 0.7152 * a.data[at + 1]! + 0.0722 * a.data[at + 2]!) / 255;
    const lb = (0.2126 * b.data[other]! + 0.7152 * b.data[other + 1]! + 0.0722 * b.data[other + 2]!) / 255;
    sum += Math.abs(la - lb);
  }
  return sum / pixels;
}

export function regionMean(image: PNGImage, x0: number, y0: number, x1: number, y1: number): number {
  const { data, channels, width, height } = image;
  const left = Math.max(0, Math.min(width - 1, Math.floor(x0 * width)));
  const right = Math.max(left + 1, Math.min(width, Math.floor(x1 * width)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(y0 * height)));
  const bottom = Math.max(top + 1, Math.min(height, Math.floor(y1 * height)));
  let sum = 0;
  let count = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const at = (y * width + x) * channels;
      sum += (0.2126 * data[at] + 0.7152 * data[at + 1] + 0.0722 * data[at + 2]) / 255;
      count++;
    }
  }
  return count ? sum / count : 0;
}
