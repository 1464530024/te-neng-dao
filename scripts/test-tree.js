/**
 * 目录树探测诊断脚本。
 * 用法：electron.exe scripts/test-tree.js --url=http://127.0.0.1:18766/kb
 */
'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const extractor = require('../src/main/services/extractor');

app.on('window-all-closed', () => { /* 自行控制退出 */ });

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
}

app.whenReady().then(async () => {
  const url = arg('url');
  if (!url) { console.log('缺少 --url'); app.exit(1); return; }

  const injectDir = path.join(__dirname, '..', 'src', 'main', 'inject');
  const readability = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8');
  const extract = fs.readFileSync(path.join(injectDir, 'extract-page.js'), 'utf8');

  const win = extractor.createCaptureWindow({});
  try {
    const loaded = await extractor.waitForLoad(win, url, 30000, '');
    console.log('LOADED ' + JSON.stringify(loaded));
    await new Promise((r) => setTimeout(r, 1500));

    // 注意：findTreeRoot / collectTreeItems 是 __TND_EXTRACT__ 内部的闭包函数，
    // 外部作用域访问不到，必须通过暴露出来的 window.__TND_TREE_LIST__ 调用。
    const script = `(async () => {
      try { ${readability} } catch (e) {}
      try { ${extract} } catch (e) { return { fatal: e.message }; }

      let list = null;
      let err = '';
      let expandResult = null;
      try {
        list = window.__TND_TREE_LIST__ ? window.__TND_TREE_LIST__() : 'no-fn';
      } catch (e) { err = e.message; }

      if (window.__TND_TREE_EXPAND__) {
        try { expandResult = await window.__TND_TREE_EXPAND__(12); } catch (e) { expandResult = { error: e.message }; }
        try { list = window.__TND_TREE_LIST__(); } catch (e) { /* ignore */ }
      }

      const probe = (() => {
        const c = document.querySelector('.catalog') || document.querySelector('[class*="tree"]');
        if (!c) return 'no-catalog';
        const r = c.getBoundingClientRect();
        return {
          cls: String(c.className),
          left: Math.round(r.left),
          width: Math.round(r.width),
          viewport: window.innerWidth,
          offsetParent: c.offsetParent ? c.offsetParent.tagName : null,
          treeNodes: c.querySelectorAll('.tree-node').length,
          folderNodes: c.querySelectorAll('.tree-node.folder').length
        };
      })();

      return {
        hasExtractFn: typeof window.__TND_EXTRACT__,
        hasListFn: typeof window.__TND_TREE_LIST__,
        hasExpandFn: typeof window.__TND_TREE_EXPAND__,
        hasClickFn: typeof window.__TND_TREE_CLICK__,
        itemCount: Array.isArray(list) ? list.length : -1,
        list: Array.isArray(list) ? list.slice(0, 10) : list,
        err,
        expandResult,
        probe
      };
    })()`;

    const r = await win.webContents.executeJavaScript(script, true);
    console.log('TREE ' + JSON.stringify(r));
  } catch (err) {
    console.log('FAIL ' + err.message);
  }
  try { win.destroy(); } catch (e) { /* ignore */ }
  app.exit(0);
});
