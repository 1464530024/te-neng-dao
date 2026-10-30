/**
 * 由 build/logo-src.png 生成应用所需的全套图标：
 *   build/icon.ico     多尺寸（16/24/32/48/64/128/256）Windows 应用与安装包图标
 *   build/icon.png     256×256 应用图标
 *   build/tray.png     32×32 托盘图标
 *   src/renderer/assets/logo.png  界面用 logo
 * 用法：node scripts/make-icons.js
 */
'use strict';

const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'logo-src.png');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** 手工拼装 ICO 容器（各尺寸以 PNG 形式内嵌，Vista+ 原生支持） */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  let offset = 6 + 16 * count;
  const dirs = [];
  entries.forEach((e) => {
    const d = Buffer.alloc(16);
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 0);
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 1);
    d.writeUInt8(0, 2);
    d.writeUInt8(0, 3);
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.buf.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.buf.length;
    dirs.push(d);
  });

  return Buffer.concat([header].concat(dirs, entries.map((e) => e.buf)));
}

/** 把非正方形原图补成正方形（白底），保证缩放不变形 */
async function toSquare(img) {
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  if (w === h) return img;
  const side = Math.max(w, h);
  const canvas = new Jimp(side, side, 0xffffffff);
  canvas.composite(img, Math.floor((side - w) / 2), Math.floor((side - h) / 2));
  return canvas;
}

async function renderSize(base, size) {
  const clone = base.clone();
  clone.resize(size, size, Jimp.RESIZE_BICUBIC);
  clone.quality(92);
  return clone.getBufferAsync(Jimp.MIME_PNG);
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error('找不到源图:', SRC);
    process.exit(1);
  }

  const raw = await Jimp.read(SRC);
  const base = await toSquare(raw);
  console.log('源图尺寸:', raw.bitmap.width + '×' + raw.bitmap.height, '→ 基准:', base.bitmap.width + '×' + base.bitmap.height);

  const entries = [];
  for (const s of SIZES) {
    entries.push({ size: s, buf: await renderSize(base, s) });
  }

  const ico = buildIco(entries);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico);
  console.log('已生成 build/icon.ico', (ico.length / 1024).toFixed(1) + ' KB');

  const png256 = await renderSize(base, 256);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png256);
  console.log('已生成 build/icon.png');

  const tray = await renderSize(base, 32);
  fs.writeFileSync(path.join(ROOT, 'build', 'tray.png'), tray);
  console.log('已生成 build/tray.png');

  const uiLogo = await renderSize(base, 128);
  const uiDir = path.join(ROOT, 'src', 'renderer', 'assets');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.writeFileSync(path.join(uiDir, 'logo.png'), uiLogo);
  console.log('已生成 src/renderer/assets/logo.png');
})().catch((err) => {
  console.error('生成图标失败:', err);
  process.exit(1);
});
