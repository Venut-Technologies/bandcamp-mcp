#!/usr/bin/env node
// Draws assets/icon.png (512x512) and assets/icon-400.png from shapes in this
// file: a record on a dark square. Everything here is generic geometry — no
// third-party logo, wordmark or colour scheme is copied, because the icon
// stands next to Bandcamp's name in registries and must not look like theirs.
//
// Usage: node scripts/make-icon.mjs
// Deterministic: the same source always produces the same bytes, so a rebuild
// shows up as no diff.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const SIZES = [
  [512, "icon.png"],
  [400, "icon-400.png"],
];
// Rendered at 4x and averaged down: cheap anti-aliasing without a library.
const SUPERSAMPLE = 4;

const BACKGROUND = [24, 27, 38]; // deep indigo
const RECORD = [17, 19, 27]; // near-black vinyl
const GROOVE = [92, 102, 128]; // cool grey
const LABEL = [232, 163, 61]; // amber
const SPINDLE = [24, 27, 38];

// Everything is expressed as a fraction of the canvas, so both sizes are the
// same drawing rather than two hand-tuned ones.
const CORNER_RADIUS = 0.18;
const RECORD_RADIUS = 0.36;
const GROOVE_RADII = [0.32, 0.275, 0.23];
const GROOVE_WIDTH = 0.012;
const LABEL_RADIUS = 0.13;
const SPINDLE_RADIUS = 0.022;

const inRoundedSquare = (x, y, r) => {
  // A rounded square filling the canvas: (0.5, 0.5) centre, half-side 0.5.
  // dx/dy measure how far a point lies past the straight part of each side,
  // so only points past both — the corner quadrant — need the radius test.
  const dx = Math.abs(x - 0.5) - (0.5 - r);
  const dy = Math.abs(y - 0.5) - (0.5 - r);
  if (dx <= 0 || dy <= 0) return true;
  return Math.hypot(dx, dy) <= r;
};

function colourAt(x, y) {
  if (!inRoundedSquare(x, y, CORNER_RADIUS)) return null; // transparent corner
  const d = Math.hypot(x - 0.5, y - 0.5);
  if (d <= SPINDLE_RADIUS) return SPINDLE;
  if (d <= LABEL_RADIUS) return LABEL;
  if (d <= RECORD_RADIUS) {
    for (const radius of GROOVE_RADII) {
      if (Math.abs(d - radius) <= GROOVE_WIDTH / 2) return GROOVE;
    }
    return RECORD;
  }
  return BACKGROUND;
}

function render(size) {
  const big = size * SUPERSAMPLE;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const colour = colourAt(
            (x * SUPERSAMPLE + sx + 0.5) / big,
            (y * SUPERSAMPLE + sy + 0.5) / big
          );
          if (colour) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            a += 255;
          }
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const covered = a / 255;
      const offset = (y * size + x) * 4;
      // Un-premultiply: the averaged colour belongs to the covered samples only.
      pixels[offset] = covered ? Math.round(r / covered) : 0;
      pixels[offset + 1] = covered ? Math.round(g / covered) : 0;
      pixels[offset + 2] = covered ? Math.round(b / covered) : 0;
      pixels[offset + 3] = Math.round(a / samples);
    }
  }
  return pixels;
}

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // Each scanline is prefixed with filter type 0 (none): the drawing is flat,
  // so a filter would buy little and cost clarity here.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [size, name] of SIZES) {
  const png = encodePng(size, render(size));
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`${name}: ${size}x${size}, ${(png.length / 1024).toFixed(1)} kB`);
}
