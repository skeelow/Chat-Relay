// Relay Chat — the tray icon, drawn in code (M4.3): a 16×16 PNG built with
// node:zlib only — no binary assets, no dependencies. Two variants: the
// normal green dot, and a red-dot alert icon for when approvals are
// waiting. Plus the tooltip text format from the packet. Pure: no Electron
// imports, so Node's test runner can verify the bytes.

import { deflateSync } from 'node:zlib';

/** The tooltip format (D17-4): "Relay Chat — N pending, M approvals waiting". */
export function trayTooltipText(pending: number, approvals: number): string {
  return `Relay Chat — ${pending} pending, ${approvals} approvals waiting`;
}

/** Standard CRC-32 (the PNG chunk checksum). Exposed for the test vector. */
export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const chunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([head, data, tail]);
};

/**
 * A 16×16 RGBA PNG: a dark rounded square with a colored status dot. The
 * alert variant draws the dot red instead of green — visibly different in
 * the tray. Every pixel is computed, nothing is loaded.
 */
export function buildIconPng(options: { alert: boolean }): Buffer {
  const size = 16;
  const [dotR, dotG, dotB] = options.alert ? [227, 27, 27] : [46, 204, 113];
  const px = (x: number, y: number): [number, number, number, number] => {
    const inSquare = x >= 2 && x < 14 && y >= 2 && y < 14;
    if (!inSquare) return [0, 0, 0, 0]; // transparent corners
    const dx = x - 8;
    const dy = y - 9;
    if (dx * dx + dy * dy <= 9) return [dotR, dotG, dotB, 255]; // the dot
    return [27, 30, 33, 255]; // the dark square
  };
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x, y);
      raw[rowStart + 1 + x * 4] = r;
      raw[rowStart + 2 + x * 4] = g;
      raw[rowStart + 3 + x * 4] = b;
      raw[rowStart + 4 + x * 4] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
