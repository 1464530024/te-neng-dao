/**
 * 把 PDF 首页渲染成 PNG，用于人工核对导出排版。
 * 用法：electron.exe scripts/shot-pdf.js --pdf=xxx.pdf --out=xxx.png
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.on('window-all-closed', () => { /* 自行控制退出 */ });

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
}

app.whenReady().then(async () => {
  const pdf = arg('pdf');
  const out = arg('out', path.join(__dirname, '..', 'logs', 'pdf-shot.png'));
  const pages = Number(arg('pages', '1')) || 1;

  if (!pdf || !fs.existsSync(pdf)) {
    console.log('PDF 不存在: ' + pdf);
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({
    show: true,
    x: 60,
    y: 60,
    width: 1000,
    height: 1320,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { plugins: true, backgroundThrottling: false }
  });
  // 注意：不能把窗口设为全透明，否则 capturePage 会报 "display surface not available"
  try { win.setOpacity(1); } catch (e) { /* ignore */ }

  try {
    await win.loadURL('file:///' + pdf.replace(/\\/g, '/'));
    await new Promise((r) => setTimeout(r, 4000));
    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, img.toPNG());
    console.log('SHOT ' + out);
  } catch (err) {
    console.log('PDF_SHOT_FAIL ' + err.message);
  }
  app.exit(0);
});
