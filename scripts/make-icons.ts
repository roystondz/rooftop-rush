// Draws the app icons (home screen, browser tab) as PNG files in public/icons/, using only
// Node's built-in zlib. Run it again after changing the design: npx tsx scripts/make-icons.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

type RGBA = [number, number, number, number];

const NAVY: RGBA = [7, 11, 28, 255];
const NAVY_LIGHT: RGBA = [24, 32, 74, 255];
const CYAN: RGBA = [34, 211, 238, 255];
const WHITE: RGBA = [240, 244, 255, 255];
const PATCH: RGBA = [17, 22, 46, 255];
const GOLD: RGBA = [250, 204, 21, 255];

/**
 * One icon. `safe` shrinks the artwork into the middle 80% so Android can crop it to any shape
 * ("maskable"); `rounded` gives the plain icon its own rounded corners.
 */
function drawIcon(size: number, opts: { safe: boolean; rounded: boolean }): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const scale = opts.safe ? 0.8 : 1;
  const c = size / 2;
  const R = (size / 2) * scale; // artwork radius
  const corner = size * 0.22;

  // A football: a pentagon in the middle, five more cut off by the edge, joined by seams.
  // Each patch: centre x, y, size, rotation (in ball units, where the ball's radius is 1).
  const patches: [number, number, number, number][] = [[0, 0, 0.3, -Math.PI / 2]];
  const seams: [number, number, number, number][] = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    patches.push([Math.cos(a) * 0.98, Math.sin(a) * 0.98, 0.36, a + Math.PI / 2]);
    seams.push([Math.cos(a) * 0.3, Math.sin(a) * 0.3, Math.cos(a) * 0.7, Math.sin(a) * 0.7]);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 4×4 supersampling for smooth edges.
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const fx = x + (sx + 0.5) / 4;
          const fy = y + (sy + 0.5) / 4;
          const col = shade(fx, fy);
          for (let k = 0; k < 4; k++) acc[k] += col[k];
        }
      }
      const o = (y * size + x) * 4;
      for (let k = 0; k < 4; k++) px[o + k] = Math.round(acc[k] / 16);
    }
  }
  return png(size, px);

  function shade(fx: number, fy: number): RGBA {
    if (opts.rounded && outsideRoundedSquare(fx, fy, size, corner)) return [0, 0, 0, 0];
    const dx = (fx - c) / R;
    const dy = (fy - c) / R;
    const d = Math.hypot(dx, dy);
    // Background: navy, a little lighter towards the top.
    let col = mix(NAVY_LIGHT, NAVY, Math.min(1, fy / size));
    // A gold "rooftop" line across the bottom.
    if (dy > 0.78 && dy < 0.84 && Math.abs(dx) < 0.62) col = GOLD;
    // Neon ring.
    if (d > 0.66 && d < 0.74) col = CYAN;
    // Ball with patches.
    if (d < 0.58) {
      col = WHITE;
      const bx = dx / 0.58;
      const by = dy / 0.58;
      for (const [x1, y1, x2, y2] of seams) if (segmentDistance(bx, by, x1, y1, x2, y2) < 0.035) col = PATCH;
      for (const [px, py, pr, rot] of patches) if (inPentagon(bx - px, by - py, pr, rot)) col = PATCH;
    }
    return col;
  }
}

/** Is (x, y) inside a regular pentagon of circumradius r, one corner pointing along `rot`? */
function inPentagon(x: number, y: number, r: number, rot: number): boolean {
  const apothem = r * Math.cos(Math.PI / 5);
  for (let i = 0; i < 5; i++) {
    // Each edge's outward normal points halfway between two corners.
    const a = rot + Math.PI / 5 + (i * 2 * Math.PI) / 5;
    if (x * Math.cos(a) + y * Math.sin(a) > apothem) return false;
  }
  return true;
}

function segmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function outsideRoundedSquare(x: number, y: number, size: number, r: number): boolean {
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return Math.hypot(x - cx, y - cy) > r;
}

const mix = (a: RGBA, b: RGBA, t: number): RGBA => a.map((v, i) => v + (b[i] - v) * t) as RGBA;

// --- a minimal PNG writer (RGBA, no filtering) ---------------------------------------

function png(size: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', drawIcon(192, { safe: false, rounded: true }));
writeFileSync('public/icons/icon-512.png', drawIcon(512, { safe: false, rounded: true }));
writeFileSync('public/icons/maskable-512.png', drawIcon(512, { safe: true, rounded: false }));
// iOS rounds the corners itself and doesn't want transparency.
writeFileSync('public/icons/apple-touch-icon.png', drawIcon(180, { safe: false, rounded: false }));
writeFileSync('public/icons/favicon-32.png', drawIcon(32, { safe: false, rounded: true }));
console.log('Icons written to public/icons/');
