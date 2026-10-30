'use strict';

const { BrowserWindow, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { localizeImages, CAPTURE_PARTITION } = require('./extractor');

/* ───────────────────────── 工具 ───────────────────────── */

/** 清理 Windows 非法文件名字符 */
function safeFileName(name, fallback) {
  let n = String(name || '').replace(/[\r\n\t]+/g, ' ').trim();
  n = n.replace(/[\\/:*?"<>|]/g, '·');
  n = n.replace(/\.+$/, '');
  n = n.replace(/\s{2,}/g, ' ');
  if (!n) n = fallback || '未命名';
  if (n.length > 90) n = n.slice(0, 90);
  return n;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateStamp(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
}

function timeStamp(d) {
  const t = d || new Date();
  return dateStamp(t) + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds());
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 依据模板生成文件名 */
function buildFileName(result, template) {
  const tpl = template || '{title}';
  const d = new Date();
  const values = {
    title: result.title || '未命名',
    platform: result.platformName || '通用网页',
    author: result.author || '',
    date: dateStamp(d),
    time: pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()),
    host: result.host || ''
  };
  let name = tpl.replace(/\{(\w+)\}/g, (_, k) => (values[k] !== undefined ? values[k] : ''));
  name = name.replace(/[_-]+$/g, '').trim();
  return safeFileName(name, values.title);
}

/* ───────────────────────── HTML 模板 ───────────────────────── */

const READER_CSS = `
:root { --tnd-fg:#1d1d1f; --tnd-fg2:#6e6e73; --tnd-line:#e6e6ea; --tnd-link:#0b62d6; --tnd-accent:#0b62d6; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; padding: 0; background: #fff; color: var(--tnd-fg);
  font-family: "Microsoft YaHei","PingFang SC","Hiragino Sans GB","Source Han Sans SC","Noto Sans CJK SC","Helvetica Neue",Arial,sans-serif;
  font-size: 16px; line-height: 1.85; letter-spacing: .01em;
  -webkit-font-smoothing: antialiased;
}
.tnd-page { max-width: 760px; margin: 0 auto; padding: 48px 40px 64px; }
.tnd-head { padding-bottom: 22px; margin-bottom: 30px; border-bottom: 1px solid var(--tnd-line); }
.tnd-title { font-size: 28px; line-height: 1.35; font-weight: 700; margin: 0 0 14px; letter-spacing: -.01em; }
.tnd-meta { font-size: 13px; color: var(--tnd-fg2); display: flex; flex-wrap: wrap; gap: 6px 18px; }
.tnd-meta span { display: inline-flex; align-items: center; gap: 5px; }
.tnd-meta b { font-weight: 500; color: var(--tnd-fg); }
.tnd-source { font-size: 12px; color: #9a9aa0; margin-top: 10px; word-break: break-all; }
.tnd-body { font-size: 16px; }
.tnd-body h1, .tnd-body h2, .tnd-body h3, .tnd-body h4, .tnd-body h5 { line-height: 1.4; font-weight: 700; margin: 1.6em 0 .7em; }
.tnd-body h1 { font-size: 24px; } .tnd-body h2 { font-size: 21px; } .tnd-body h3 { font-size: 18px; } .tnd-body h4 { font-size: 16px; }
.tnd-body p { margin: 0 0 1.05em; }
.tnd-body a { color: var(--tnd-link); text-decoration: none; }
.tnd-body img { max-width: 100% !important; height: auto !important; display: block; margin: 1.2em auto; border-radius: 8px; }
.tnd-body blockquote { margin: 1.2em 0; padding: 12px 18px; border-left: 3px solid var(--tnd-accent); background: #f7f9fc; color: #3a3a3e; border-radius: 0 8px 8px 0; }
.tnd-body blockquote p:last-child { margin-bottom: 0; }
.tnd-body ul, .tnd-body ol { padding-left: 1.5em; margin: 0 0 1.05em; }
.tnd-body li { margin: .35em 0; }
.tnd-body table { border-collapse: collapse; width: 100%; margin: 1.3em 0; font-size: 14px; }
.tnd-body th, .tnd-body td { border: 1px solid var(--tnd-line); padding: 9px 12px; text-align: left; vertical-align: top; }
.tnd-body th { background: #f5f7fa; font-weight: 600; }
.tnd-body tr:nth-child(even) td { background: #fafbfc; }
.tnd-body pre { background: #f6f7f9; border: 1px solid #ececf0; border-radius: 8px; padding: 14px 16px; overflow-x: auto; font-size: 13px; line-height: 1.65; font-family: "JetBrains Mono","Cascadia Mono",Consolas,"Courier New",monospace; }
.tnd-body code { background: #f2f3f5; border-radius: 4px; padding: 1px 5px; font-size: .92em; font-family: "JetBrains Mono","Cascadia Mono",Consolas,"Courier New",monospace; }
.tnd-body pre code { background: none; padding: 0; }
.tnd-body hr { border: none; border-top: 1px solid var(--tnd-line); margin: 2em 0; }
.tnd-body video, .tnd-body iframe { max-width: 100%; }
.tnd-gallery { display: block; }
.tnd-gallery img { width: 100%; }
.tnd-sec { margin-top: 44px; padding-top: 26px; border-top: 1px solid var(--tnd-line); }
.tnd-sec-title { font-size: 21px; font-weight: 700; margin: 0 0 16px; }
.tnd-toc { background: #f7f9fc; border: 1px solid #e8eef7; border-radius: 12px; padding: 18px 22px; margin: 0 0 34px; }
.tnd-toc h3 { margin: 0 0 10px; font-size: 15px; font-weight: 700; }
.tnd-toc ol { margin: 0; padding-left: 1.35em; font-size: 14px; line-height: 1.9; color: #3a3a3e; }
.tnd-foot { margin-top: 50px; padding-top: 18px; border-top: 1px solid var(--tnd-line); font-size: 12px; color: #9a9aa0; display: flex; justify-content: space-between; gap: 12px; }
@page { size: A4; margin: 16mm 14mm 16mm 14mm; }
@media print { .tnd-page { max-width: none; padding: 0; } .tnd-body img, .tnd-sec { page-break-inside: auto; } .tnd-sec-title { page-break-after: avoid; } }
`;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 组装导出用 HTML。
 * 内联样式（公众号排版的核心）全部保留，再叠加一套阅读器基础样式。
 */
function buildDocumentHtml(result, options) {
  const o = options || {};
  const sections = Array.isArray(result.sections) ? result.sections : null;
  const metaBits = [];
  if (result.author) metaBits.push('<span>作者：<b>' + escapeHtml(result.author) + '</b></span>');
  if (result.publishTime) metaBits.push('<span>时间：<b>' + escapeHtml(result.publishTime) + '</b></span>');
  metaBits.push('<span>来源：<b>' + escapeHtml(result.platformName || result.siteName || '') + '</b></span>');
  if (sections) metaBits.push('<span>共 <b>' + sections.length + '</b> 篇</span>');

  let bodyHtml;
  if (sections && sections.length) {
    const toc = sections.map((s) => '<li>' + escapeHtml(s.title || '') + '</li>').join('');
    bodyHtml =
      '<div class="tnd-toc"><h3>目录</h3><ol>' + toc + '</ol></div>' +
      sections
        .map(
          (s, i) =>
            '<section class="tnd-sec"><h2 class="tnd-sec-title">' +
            (i + 1) + '. ' + escapeHtml(s.title || '') +
            '</h2><div>' + (s.html || '') + '</div></section>'
        )
        .join('');
  } else {
    bodyHtml = result.contentHtml || '';
  }

  const footer = '<div class="tnd-foot"><span>由「特能导」导出 · ' + timeStamp() + '</span><span>' + escapeHtml(result.host || '') + '</span></div>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(result.title || '未命名')}</title>
<style>${READER_CSS}</style>
</head>
<body>
<div class="tnd-page">
  <div class="tnd-head">
    <h1 class="tnd-title">${escapeHtml(result.title || '未命名')}</h1>
    <div class="tnd-meta">${metaBits.join('')}</div>
    <div class="tnd-source">原文链接：${escapeHtml(result.requestedUrl || result.url || '')}</div>
  </div>
  <div class="tnd-body">${bodyHtml}</div>
  ${footer}
</div>
</body>
</html>`;
}

/* ───────────────────────── PDF ───────────────────────── */

const PAGE_SIZES = { A4: 'A4', A3: 'A3', A5: 'A5', Letter: 'Letter', Legal: 'Legal', Tabloid: 'Tabloid' };

async function htmlToPdf(html, outPath, options) {
  const o = options || {};
  const tmpFile = path.join(os.tmpdir(), 'tnd-pdf-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.html');
  fs.writeFileSync(tmpFile, html, 'utf8');

  // 同样使用「屏幕外可见窗口」：show:false 的窗口定时器会被节流，影响字体/图片等待
  const win = new BrowserWindow({
    show: true,
    x: -24000,
    y: -24000,
    width: 1240,
    height: 1754,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      images: true,
      backgroundThrottling: false,
      sandbox: false,
      partition: 'tnd-print'
    }
  });
  win.setMenuBarVisibility(false);
  try { win.setOpacity(0); } catch (e) { /* ignore */ }
  try { win.webContents.setBackgroundThrottling(false); } catch (e) { /* ignore */ }

  try {
    await win.loadFile(tmpFile);
    // 等待字体与图片就绪，避免 PDF 出现空白
    await win.webContents
      .executeJavaScript(
        `(async () => {
          try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
          const imgs = Array.from(document.images || []);
          await Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : new Promise((r) => { i.onload = r; i.onerror = r; setTimeout(r, 8000); }))));
          return true;
        })()`,
        true
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 350));

    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: PAGE_SIZES[o.pageSize] || 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      marginsType: 0,
      displayHeaderFooter: !!o.headerFooter,
      headerTemplate: '<div></div>',
      footerTemplate: '<div></div>',
      scale: 1
    });
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, pdf);
    return outPath;
  } finally {
    try { win.destroy(); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
  }
}

/* ───────────────────────── Markdown ───────────────────────── */

function htmlToMarkdown(html, options) {
  const o = options || {};
  const TurndownService = require('turndown');
  const { gfm } = require('turndown-plugin-gfm');

  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined'
  });
  try { td.use(gfm); } catch (e) { /* gfm 不可用时降级为默认规则 */ }

  // 图片：base64 → 本地相对路径
  td.addRule('tnd-image', {
    filter: 'img',
    replacement: (content, node) => {
      const src = node.getAttribute('src') || '';
      const alt = (node.getAttribute('alt') || '').replace(/\n/g, ' ');
      if (!src) return '';
      let out = src;
      if (/^data:/i.test(src)) {
        const key = o.dataUrlMap && o.dataUrlMap[src];
        if (!key) return '';
        out = key;
      }
      return '![' + alt + '](' + out + ')';
    }
  });

  // 去掉残留的样式属性干扰
  td.addRule('tnd-strip-attrs', {
    filter: (node) => ['span', 'section', 'div', 'font'].includes(node.nodeName.toLowerCase()),
    replacement: (content) => content
  });

  let md = td.turndown(html || '');

  // 规范化：去掉列表项之间的多余空行与超长缩进（网页 <li><p> 结构转出来的常见噪音）
  md = md
    .replace(/^([ \t]*)([-*+])\s{2,}/gm, '$1$2 ')
    .replace(/(\n[ \t]*(?:[-*+]|\d+\.)[ \t]+[^\n]*)\n[ \t]*\n(?=[ \t]*(?:[-*+]|\d+\.)[ \t]+)/g, '$1\n')
    .replace(/^([ \t]*)([-*+]|\d+\.)[ \t]+([^\n]*)\n[ \t]+\n/gm, '$1$2 $3\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();

  const head = [];
  if (o.title) head.push('# ' + o.title);
  const metaLine = [];
  if (o.author) metaLine.push('作者：' + o.author);
  if (o.publishTime) metaLine.push('时间：' + o.publishTime);
  if (o.sourceUrl) metaLine.push('原文：' + o.sourceUrl);
  if (metaLine.length) head.push('> ' + metaLine.join('　|　'));
  if (o.exportedAt) head.push('> 由「特能导」导出 · ' + o.exportedAt);

  return (head.join('\n\n') + (head.length ? '\n\n' : '') + md + '\n').replace(/\n{3,}/g, '\n\n');
}

/* ───────────────────────── Word ───────────────────────── */

function htmlToDocFallback(html, outPath) {
  // 降级方案：Word 可完整打开带样式的 HTML（.doc 扩展名）
  const wrapped =
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
    '<head><meta charset="utf-8"><title>document</title>' +
    '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->' +
    '</head><body>' + html + '</body></html>';
  fs.writeFileSync(outPath, wrapped, 'utf8');
  return outPath;
}

async function htmlToDocx(html, outPath, options) {
  const o = options || {};
  let HTMLtoDOCX = null;
  try {
    HTMLtoDOCX = require('html-to-docx');
  } catch (e) {
    HTMLtoDOCX = null;
  }

  if (typeof HTMLtoDOCX !== 'function') {
    return { path: htmlToDocFallback(html, outPath.replace(/\.docx$/i, '.doc')), engine: 'html-doc' };
  }

  try {
    const buf = await HTMLtoDOCX(html, null, {
      orientation: 'portrait',
      margins: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
      title: o.title || '特能导导出',
      creator: '特能导',
      font: '微软雅黑',
      fontSize: 22,
      lineHeight: o.lineHeight || 1.5,
      table: { row: { cantSplit: true } },
      footer: false,
      pageNumber: false,
      header: false,
      decodeUnicode: false
    });
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, buf);
    return { path: outPath, engine: 'html-to-docx' };
  } catch (err) {
    console.warn('[exporter] docx 生成失败，降级为 .doc：', err.message);
    return { path: htmlToDocFallback(html, outPath.replace(/\.docx$/i, '.doc')), engine: 'html-doc' };
  }
}

/* ───────────────────────── 汇总导出 ───────────────────────── */

/**
 * 导出一份抓取结果。
 * @param {object} result capture() 的返回值
 * @param {object} options { outDir, formats[], fileName, pageSize, refs[] }
 * @returns {Promise<{files: Array, dir: string, warnings: string[]}>}
 */
async function exportResult(result, options) {
  const o = options || {};
  const formats = (o.formats && o.formats.length ? o.formats : ['pdf', 'markdown', 'docx']).filter(Boolean);
  const outDir = ensureDir(o.outDir || path.join(os.homedir(), 'Downloads', '特能导导出'));
  const baseName = safeFileName(o.fileName || buildFileName(result, o.fileNameTemplate), '未命名');
  const warnings = [];
  const files = [];

  // 1) 图片本地化。
  //    逐篇（或整体）独立处理，而不是先拼接成一个 HTML、本地化后再用正则拆回来 ——
  //    后者只要本地化环节出一点异常，整个多文档结构就会静默丢失、降级成单文档。
  const assetsDir = path.join(outDir, baseName + '.assets');
  const needAssets = formats.includes('markdown') || formats.includes('html');
  const multi = Array.isArray(result.sections) && result.sections.length > 0;

  let sessionObj = null;
  try { sessionObj = session.fromPartition(CAPTURE_PARTITION); } catch (e) { sessionObj = null; }

  const imgCtx = {
    referer: result.url,
    session: sessionObj,
    assetsDir: needAssets ? assetsDir : null,
    flags: o.flags,
    maxImages: o.maxImages || 80
  };

  const emptyLocalized = (html) => ({ html: html || '', images: [], inlineMap: {}, total: 0, done: 0 });

  const aggregate = { images: [], inlineMap: {}, total: 0, done: 0 };
  const mergeLocalized = (r) => {
    if (!r) return;
    aggregate.images.push.apply(aggregate.images, r.images || []);
    Object.assign(aggregate.inlineMap, r.inlineMap || {});
    aggregate.total += r.total || 0;
    aggregate.done += r.done || 0;
  };

  try {
    if (multi) {
      const done = await Promise.all(
        result.sections.map(async (s) => {
          try {
            const r = await localizeImages(s.html || '', imgCtx);
            mergeLocalized(r);
            return Object.assign({}, s, { html: r.html });
          } catch (err) {
            warnings.push('「' + (s.title || '某篇文档') + '」的图片本地化失败：' + err.message);
            return s;
          }
        })
      );
      result = Object.assign({}, result, { sections: done });
    } else {
      const r = await localizeImages(result.contentHtml || '', imgCtx);
      mergeLocalized(r);
      result = Object.assign({}, result, { contentHtml: r.html });
    }
  } catch (err) {
    warnings.push('图片本地化失败：' + err.message);
  }

  if (aggregate.total > aggregate.done) {
    warnings.push('有 ' + (aggregate.total - aggregate.done) + ' 张图片未能下载，已保留原始链接。');
  }

  const localized = aggregate;
  const docHtml = buildDocumentHtml(result, {});

  // 2) 各格式输出
  if (formats.includes('html')) {
    const p = path.join(outDir, baseName + '.html');
    ensureDir(outDir);
    fs.writeFileSync(p, docHtml, 'utf8');
    files.push({ format: 'html', path: p });
  }

  if (formats.includes('pdf')) {
    const p = path.join(outDir, baseName + '.pdf');
    try {
      await htmlToPdf(docHtml, p, { pageSize: o.pageSize || 'A4' });
      files.push({ format: 'pdf', path: p });
    } catch (err) {
      warnings.push('PDF 生成失败：' + err.message);
    }
  }

  if (formats.includes('markdown')) {
    const p = path.join(outDir, baseName + '.md');
    try {
      const dataUrlMap = {};
      Object.keys(localized.inlineMap).forEach((url) => {
        const saved = (localized.images || []).find((x) => x.url === url);
        if (saved) dataUrlMap[localized.inlineMap[url]] = './' + baseName + '.assets/' + saved.name;
      });
      const md = htmlToMarkdown(docHtmlBody(result), {
        title: result.title,
        author: result.author,
        publishTime: result.publishTime,
        sourceUrl: result.requestedUrl || result.url,
        exportedAt: timeStamp(),
        dataUrlMap
      });
      fs.writeFileSync(p, md, 'utf8');
      files.push({ format: 'markdown', path: p });
    } catch (err) {
      warnings.push('Markdown 生成失败：' + err.message);
    }
  }

  if (formats.includes('docx') || formats.includes('word')) {
    const target = path.join(outDir, baseName + '.docx');
    const r = await htmlToDocx(docHtml, target, { title: result.title });
    files.push({ format: 'word', path: r.path, engine: r.engine });
  }

  if (formats.includes('txt')) {
    const p = path.join(outDir, baseName + '.txt');
    fs.writeFileSync(p, buildTxt(result), 'utf8');
    files.push({ format: 'txt', path: p });
  }

  if (formats.includes('json')) {
    const p = path.join(outDir, baseName + '.json');
    fs.writeFileSync(p, buildJson(result), 'utf8');
    files.push({ format: 'json', path: p });
  }

  if (formats.includes('csv')) {
    const p = path.join(outDir, baseName + '.csv');
    // 带 BOM，保证 Excel 打开中文不乱码
    fs.writeFileSync(p, '\ufeff' + buildCsv(result), 'utf8');
    files.push({ format: 'csv', path: p });
  }

  return { files, dir: outDir, assetsDir: needAssets && localized.images.length ? assetsDir : null, warnings };
}

/* ───────────────────────── TXT / JSON / CSV ───────────────────────── */

function metaLine(result) {
  const bits = [];
  if (result.author) bits.push('作者：' + result.author);
  if (result.publishTime) bits.push('时间：' + result.publishTime);
  if (result.platformName) bits.push('来源：' + result.platformName);
  return bits.join('　|　');
}

/** 纯文本正文 */
function buildTxt(result) {
  const L = [];
  L.push(result.title || '未命名');
  L.push('='.repeat(Math.min(60, (result.title || '').length * 2 + 10)));
  const m = metaLine(result);
  if (m) L.push(m);
  if (result.requestedUrl || result.url) L.push('原文：' + (result.requestedUrl || result.url));
  L.push('由「特能导」导出 · ' + timeStamp());
  L.push('');

  if (Array.isArray(result.sections) && result.sections.length) {
    result.sections.forEach((s, i) => {
      L.push('');
      L.push('─'.repeat(50));
      L.push((i + 1) + '. ' + (s.title || ''));
      if (s.path) L.push('目录：' + s.path);
      L.push('─'.repeat(50));
      L.push('');
      L.push((s.text || '').trim());
      L.push('');
    });
  } else {
    L.push((result.contentText || '').trim());
  }

  return L.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
}

/** 结构化 JSON：给 AI 或知识库系统消费 */
function buildJson(result) {
  const stripImages = (html) => String(html || '').replace(/src\s*=\s*"data:image\/[^"]*"/gi, 'src="[image]"');

  const base = {
    title: result.title || '',
    author: result.author || '',
    publishTime: result.publishTime || '',
    platform: result.platformName || '',
    host: result.host || '',
    sourceUrl: result.requestedUrl || result.url || '',
    keywords: result.keywords || '',
    description: result.description || '',
    exportedAt: new Date().toISOString(),
    exporter: '特能导',
    stats: result.stats || null,
    outline: result.outline || []
  };

  if (Array.isArray(result.sections) && result.sections.length) {
    base.documentCount = result.sections.length;
    base.documents = result.sections.map((s, i) => ({
      index: i + 1,
      title: s.title || '',
      path: s.path || '',
      url: s.url || '',
      content: (s.text || '').trim(),
      contentHtml: stripImages(s.html)
    }));
  } else {
    base.documentCount = 1;
    base.content = (result.contentText || '').trim();
    base.contentHtml = stripImages(result.contentHtml);
  }

  return JSON.stringify(base, null, 2);
}

/** CSV 清单：多文档时一行一篇，方便在 Excel 里做后续加工 */
function buildCsv(result) {
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
  const head = ['序号', '标题', '层级路径', '作者', '发布时间', '字数', '平台', '原文链接'];
  const rows = [head];

  if (Array.isArray(result.sections) && result.sections.length) {
    result.sections.forEach((s, i) => {
      rows.push([
        i + 1,
        s.title || '',
        s.path || '',
        result.author || '',
        result.publishTime || '',
        (s.text || '').replace(/\s+/g, '').length,
        result.platformName || '',
        s.url || ''
      ]);
    });
  } else {
    rows.push([
      1,
      result.title || '',
      '',
      result.author || '',
      result.publishTime || '',
      (result.contentText || '').replace(/\s+/g, '').length,
      result.platformName || '',
      result.requestedUrl || result.url || ''
    ]);
  }

  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

/** Markdown 转换只取正文区域，不重复标题与页脚 */
function docHtmlBody(result) {
  if (Array.isArray(result.sections) && result.sections.length) {
    return result.sections.map((s, i) => '## ' + (i + 1) + '. ' + (s.title || '') + '\n\n' + (s.html || '')).join('\n\n');
  }
  return result.contentHtml || '';
}

module.exports = {
  exportResult,
  buildDocumentHtml,
  htmlToPdf,
  htmlToMarkdown,
  htmlToDocx,
  safeFileName,
  buildFileName,
  dateStamp,
  timeStamp,
  ensureDir,
  READER_CSS
};
