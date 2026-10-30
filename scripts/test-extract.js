/**
 * 抓取与导出链路自测（以 Electron 主进程方式运行，不启动界面）
 * 用法：electron.exe scripts/test-extract.js --url=https://xxx --out=./logs/test-out
 */
'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const { capture } = require('../src/main/services/extractor');
const { exportResult } = require('../src/main/services/exporter');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// 抓取/导出过程中会临时创建并销毁窗口，必须阻止 Electron 的默认「窗口全关即退出」行为
app.on('window-all-closed', () => { /* 由脚本自行控制退出时机 */ });

app.whenReady().then(async () => {
  const url = arg('url');
  const outBase = arg('out', path.join(__dirname, '..', 'logs', 'test-out'));
  const formats = (arg('formats', 'pdf,markdown,docx,html')).split(',').filter(Boolean);
  const deep = arg('deep', '1') !== '0';

  if (!url) {
    console.log('缺少 --url 参数');
    app.exit(1);
    return;
  }

  const t0 = Date.now();
  const result = await capture(url, {
    settings: { timeout: 60000, autoRetry: 0, userAgentMode: 'auto' },
    flags: {},
    deep
  });

  console.log('RESULT ' + JSON.stringify({
    ok: result.ok,
    platform: result.platformKey,
    title: result.title,
    author: result.author,
    publishTime: result.publishTime,
    chars: result.stats && result.stats.chars,
    images: result.stats && result.stats.images,
    directory: result.directory ? result.directory.length : 0,
    deepCount: result.deepCount || 0,
    usedReadability: result.stats && result.stats.usedReadability,
    fallback: result.stats && result.stats.fallback,
    reason: result.reason || '',
    ms: Date.now() - t0
  }));

  if (!result.ok) {
    app.exit(2);
    return;
  }

  try {
    const exported = await exportResult(result, {
      outDir: outBase,
      formats,
      fileName: result.title,
      pageSize: 'A4'
    });
    console.log('FILES ' + JSON.stringify(exported.files.map((f) => ({
      format: f.format,
      engine: f.engine || '',
      size: (() => { try { return fs.statSync(f.path).size; } catch (e) { return -1; } })(),
      path: f.path
    }))));
    if (exported.warnings && exported.warnings.length) console.log('WARN ' + JSON.stringify(exported.warnings));
  } catch (err) {
    console.log('EXPORT_FAIL ' + err.message);
    app.exit(3);
    return;
  }

  app.exit(0);
});
