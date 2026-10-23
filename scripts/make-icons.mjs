import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKGROUND = [12, 14, 16, 255];
const GLYPH = [23, 18, 7, 255];
const AMBER_TOP = [255, 201, 100];
const AMBER_BOTTOM = [226, 164, 58];

function roundedRect(buffer, dim, x0, y0, x1, y1, radius, colorAt) {
  const px0 = Math.max(0, Math.floor(x0 * dim));
  const py0 = Math.max(0, Math.floor(y0 * dim));
  const px1 = Math.min(dim, Math.ceil(x1 * dim));
  const py1 = Math.min(dim, Math.ceil(y1 * dim));
  const r = radius * dim;
  const left = x0 * dim + r;
  const right = x1 * dim - r;
  const top = y0 * dim + r;
  const bottom = y1 * dim - r;
  for (let y = py0; y < py1; y += 1) {
    const color = colorAt(y / dim);
    const cy = Math.min(bottom, Math.max(top, y + 0.5));
    for (let x = px0; x < px1; x += 1) {
      const cx = Math.min(right, Math.max(left, x + 0.5));
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > r * r) continue;
      const index = (y * dim + x) * 4;
      buffer[index] = color[0];
      buffer[index + 1] = color[1];
      buffer[index + 2] = color[2];
      buffer[index + 3] = 255;
    }
  }
}

function disc(buffer, dim, cx, cy, radius, color) {
  const px0 = Math.max(0, Math.floor((cx - radius) * dim));
  const py0 = Math.max(0, Math.floor((cy - radius) * dim));
  const px1 = Math.min(dim, Math.ceil((cx + radius) * dim));
  const py1 = Math.min(dim, Math.ceil((cy + radius) * dim));
  const ox = cx * dim;
  const oy = cy * dim;
  const r = radius * dim;
  for (let y = py0; y < py1; y += 1) {
    for (let x = px0; x < px1; x += 1) {
      const dx = x + 0.5 - ox;
      const dy = y + 0.5 - oy;
      if (dx * dx + dy * dy > r * r) continue;
      const index = (y * dim + x) * 4;
      buffer[index] = color[0];
      buffer[index + 1] = color[1];
      buffer[index + 2] = color[2];
      buffer[index + 3] = 255;
    }
  }
}

function ring(buffer, dim, cx, cy, inner, outer, color) {
  const px0 = Math.max(0, Math.floor((cx - outer) * dim));
  const py0 = Math.max(0, Math.floor((cy - outer) * dim));
  const px1 = Math.min(dim, Math.ceil((cx + outer) * dim));
  const py1 = Math.min(dim, Math.ceil((cy + outer) * dim));
  const ox = cx * dim;
  const oy = cy * dim;
  const r0 = inner * dim;
  const r1 = outer * dim;
  for (let y = py0; y < py1; y += 1) {
    for (let x = px0; x < px1; x += 1) {
      const dx = x + 0.5 - ox;
      const dy = y + 0.5 - oy;
      const d2 = dx * dx + dy * dy;
      if (d2 < r0 * r0 || d2 > r1 * r1) continue;
      const index = (y * dim + x) * 4;
      buffer[index] = color[0];
      buffer[index + 1] = color[1];
      buffer[index + 2] = color[2];
      buffer[index + 3] = 255;
    }
  }
}

function render(size) {
  const samples = size >= 1024 ? 2 : 4;
  const dim = size * samples;
  const hi = new Uint8Array(dim * dim * 4);
  for (let y = 0; y < dim; y += 1) {
    const index = y * dim * 4;
    for (let x = 0; x < dim; x += 1) {
      hi[index + x * 4] = BACKGROUND[0];
      hi[index + x * 4 + 1] = BACKGROUND[1];
      hi[index + x * 4 + 2] = BACKGROUND[2];
      hi[index + x * 4 + 3] = 255;
    }
  }
  const amber = (y) => {
    const t = Math.min(1, Math.max(0, (y - 0.095) / 0.81));
    return [
      Math.round(AMBER_TOP[0] + (AMBER_BOTTOM[0] - AMBER_TOP[0]) * t),
      Math.round(AMBER_TOP[1] + (AMBER_BOTTOM[1] - AMBER_TOP[1]) * t),
      Math.round(AMBER_TOP[2] + (AMBER_BOTTOM[2] - AMBER_TOP[2]) * t),
    ];
  };
  roundedRect(hi, dim, 0.095, 0.095, 0.905, 0.905, 0.195, amber);
  roundedRect(hi, dim, 0.315, 0.245, 0.785, 0.545, 0.045, () => GLYPH);
  disc(hi, dim, 0.3, 0.72, 0.035, GLYPH);
  ring(hi, dim, 0.3, 0.72, 0.082, 0.112, GLYPH);
  ring(hi, dim, 0.3, 0.72, 0.142, 0.172, GLYPH);

  const out = new Uint8Array(size * size * 4);
  const area = samples * samples;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const index = ((y * samples + sy) * dim + (x * samples + sx)) * 4;
          r += hi[index];
          g += hi[index + 1];
          b += hi[index + 2];
        }
      }
      const index = (y * size + x) * 4;
      out[index] = Math.round(r / area);
      out[index + 1] = Math.round(g / area);
      out[index + 2] = Math.round(b / area);
      out[index + 3] = 255;
    }
  }
  return out;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  const images = [];
  entries.forEach((entry, index) => {
    const position = 6 + index * 16;
    header[position] = entry.size >= 256 ? 0 : entry.size;
    header[position + 1] = entry.size >= 256 ? 0 : entry.size;
    header[position + 2] = 0;
    header[position + 3] = 0;
    header.writeUInt16LE(1, position + 4);
    header.writeUInt16LE(32, position + 6);
    header.writeUInt32LE(entry.png.length, position + 8);
    header.writeUInt32LE(offset, position + 12);
    offset += entry.png.length;
    images.push(entry.png);
  });
  return Buffer.concat([header, ...images]);
}

function write(path, data) {
  const target = resolve(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  console.log(`wrote ${path} (${data.length} bytes)`);
}

const cache = new Map();
function iconPng(size) {
  if (!cache.has(size)) cache.set(size, png(size, render(size)));
  return cache.get(size);
}

write('web/public/icon-192.png', iconPng(192));
write('web/public/icon-512.png', iconPng(512));
write('assets/icon.png', iconPng(1024));
write(
  'build/icon.ico',
  ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: iconPng(size) }))),
);
