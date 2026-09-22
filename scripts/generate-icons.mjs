/**
 * Generates the extension PNG icons without any dependencies.
 *
 * Minimal neutral design for v1: a rounded-square tile, a slash motif
 * (block), and the letters "BS". Drawn into an RGBA buffer with simple
 * 2D rasterization (signed distance functions for shapes), then encoded
 * as PNG using zlib (RFC 1950/1951) — no image libraries required.
 *
 * Outputs 16/32/48/128 px PNGs into public/icon/.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icon');

/** RGBA pixel buffer with basic fill helpers. */
function createCanvas(size) {
  const data = Buffer.alloc(size * size * 4, 0);
  const setPixel = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const srcA = a / 255;
    const dstA = data[i + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA === 0) return;
    for (let c = 0; c < 3; c++) {
      data[i + c] = Math.round((r * srcA + data[i + c] * dstA * (1 - srcA)) / outA);
    }
    data[i + 3] = Math.round(outA * 255);
  };
  return { size, data, setPixel };
}

/** Signed distance helpers (positive = outside). */
const sdRoundRect = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdSegment = (px, py, ax, ay, bx, by, r) => {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
};

/** Fill a region where sdf <= 0 with supersampled coverage. */
function fillShape(canvas, sdf, color, samples = 3) {
  const { size, setPixel } = canvas;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          if (sdf(px, py) <= 0) inside++;
        }
      }
      if (inside > 0) {
        const coverage = inside / (samples * samples);
        setPixel(x, y, [color[0], color[1], color[2], Math.round(color[3] * coverage)]);
      }
    }
  }
}

/**
 * Draw the glyph for one size. All coordinates are normalized to a 0..100
 * design grid and scaled to the target size.
 */
function drawIcon(size) {
  const canvas = createCanvas(size);
  const s = size / 100;
  const bg = [32, 33, 36, 255]; // neutral dark gray, theme-independent
  const fg = [235, 235, 235, 255]; // off-white
  const accent = [255, 96, 88, 255]; // muted red slash

  // Rounded square tile
  const inset = 6 * s;
  const radius = 18 * s;
  const center = size / 2;
  const half = size / 2 - inset;
  fillShape(
    canvas,
    (x, y) => sdRoundRect(x, y, center, center, half, half, radius),
    bg,
    size <= 32 ? 4 : 3,
  );

  // Slash motif across the tile
  const slashWidth = 7 * s;
  fillShape(
    canvas,
    (x, y) => sdSegment(x, y, 26 * s, 78 * s, 74 * s, 22 * s, slashWidth / 2),
    accent,
    size <= 32 ? 4 : 3,
  );

  // Letters "B" "S" simplified as two thick strokes each (kept legible at 16px)
  const stroke = 5.5 * s;
  const letter = (ox) => {
    // B: vertical stem + two bowls approximated by segments
    fillShape(canvas, (x, y) => sdSegment(x, y, ox, 30 * s, ox, 70 * s, stroke / 2), fg, 2);
    fillShape(canvas, (x, y) => sdSegment(x, y, ox, 30 * s, ox + 9 * s, 34 * s, stroke / 2), fg, 2);
    fillShape(
      canvas,
      (x, y) => sdSegment(x, y, ox + 9 * s, 34 * s, ox + 9 * s, 46 * s, stroke / 2),
      fg,
      2,
    );
    fillShape(
      canvas,
      (x, y) => sdSegment(x, y, ox, 50 * s, ox + 10 * s, 54 * s, stroke / 2),
      fg,
      2,
    );
    fillShape(
      canvas,
      (x, y) => sdSegment(x, y, ox + 10 * s, 54 * s, ox + 9 * s, 66 * s, stroke / 2),
      fg,
      2,
    );
    fillShape(canvas, (x, y) => sdSegment(x, y, ox + 9 * s, 66 * s, ox, 70 * s, stroke / 2), fg, 2);
  };
  letter(34 * s);
  // S: three horizontal bars connected
  const sx = 58 * s;
  fillShape(canvas, (x, y) => sdSegment(x, y, sx + 9 * s, 32 * s, sx, 36 * s, stroke / 2), fg, 2);
  fillShape(canvas, (x, y) => sdSegment(x, y, sx, 36 * s, sx, 48 * s, stroke / 2), fg, 2);
  fillShape(canvas, (x, y) => sdSegment(x, y, sx, 48 * s, sx + 9 * s, 52 * s, stroke / 2), fg, 2);
  fillShape(
    canvas,
    (x, y) => sdSegment(x, y, sx + 9 * s, 52 * s, sx + 9 * s, 64 * s, stroke / 2),
    fg,
    2,
  );
  fillShape(canvas, (x, y) => sdSegment(x, y, sx + 9 * s, 64 * s, sx, 68 * s, stroke / 2), fg, 2);

  return canvas.data;
}

/** Minimal PNG encoder (8-bit RGBA, no filtering). */
function encodePng(size, rgba) {
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, drawIcon(size));
  writeFileSync(join(outDir, `${size}.png`), png);
  console.log(`wrote public/icon/${size}.png (${png.length} bytes)`);
}
