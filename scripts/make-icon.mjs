/**
 * 生成插件图标（128×128 PNG，无外部依赖）。
 *
 * 为什么自己画：DSH 的 readPluginMeta 支持根 package.json 的 `icon` 字段
 * （文件或 data URL），缺了市场卡片就是默认占位图。仓库里没有设计资源，
 * 用代码生成一个可复现的占位图标，比塞二进制进 git 更可控。
 *
 * 用法：node scripts/make-icon.mjs
 * 输出：packages/dsh-audit-plugin/icon
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages', 'dsh-audit-plugin', 'icon');

const SIZE = 128;
const RADIUS = 26;

// 配色：深底 + 三根柱子（成本构成）——与"账单/处方"的语义一致
const BG = [11, 18, 32, 255];
const BARS = [
  [56, 189, 248, 255], // 天蓝
  [34, 197, 94, 255], // 绿
  [245, 158, 11, 255], // 琥珀
];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 圆角矩形覆盖判定 */
function inRoundedRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
const barX = [26, 55, 84];
const barW = 18;
const barH = [34, 56, 78];
const baseY = 100;

for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const o = rowStart + 1 + x * 4;
    let px = [0, 0, 0, 0];

    if (inRoundedRect(x, y, SIZE, SIZE, RADIUS)) {
      px = BG;
      // 柱子
      for (let b = 0; b < 3; b++) {
        const bx = barX[b];
        const top = baseY - barH[b];
        if (x >= bx && x < bx + barW && y >= top && y < baseY) px = BARS[b];
      }
      // 底部基线
      if (y >= baseY && y < baseY + 3 && x >= 20 && x < 108) px = [71, 85, 105, 255];
    }

    raw[o] = px[0];
    raw[o + 1] = px[1];
    raw[o + 2] = px[2];
    raw[o + 3] = px[3];
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`已生成 ${OUT}（${png.length} 字节）`);
