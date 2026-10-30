'use strict';

const { BrowserWindow, session, app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { detectPlatform, PLATFORM_MAP } = require('../../shared/constants');
const { requestBuffer, UA_PC, UA_MOBILE, mimeFromUrl, extFromMime } = require('./http');

/** 抓取专用持久化分区：登录一次，长期有效 */
const CAPTURE_PARTITION = 'persist:tnd-capture';

let cachedInjectBase = null;

function readInjectAssets() {
  if (cachedInjectBase) return cachedInjectBase;
  const injectDir = path.join(__dirname, '..', 'inject');
  const readabilityPath = require.resolve('@mozilla/readability/Readability.js');
  cachedInjectBase = {
    readability: fs.readFileSync(readabilityPath, 'utf8'),
    extract: fs.readFileSync(path.join(injectDir, 'extract-page.js'), 'utf8'),
    hook: fs.readFileSync(path.join(injectDir, 'network-hook.js'), 'utf8')
  };
  return cachedInjectBase;
}

/** 依据设置解析 User-Agent */
function resolveUserAgent(settings, platformKey) {
  const mode = (settings && settings.userAgentMode) || 'auto';
  if (mode === 'custom' && settings.customUA) return settings.customUA;
  if (mode === 'mobile') return UA_MOBILE;
  if (mode === 'pc') return UA_PC;
  // auto：小红书移动端页面结构更简单、更易提取；其余用桌面端
  if (platformKey === 'xiaohongshu') return UA_MOBILE;
  return UA_PC;
}

function isCanceled(flags) {
  return !!(flags && flags.canceled);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 屏幕外的安全坐标（Windows 允许负坐标，窗口完全不可见） */
const OFFSCREEN = { x: -24000, y: -24000 };

/**
 * 创建抓取窗口。
 *
 * 关键点一：必须让窗口处于「可见」状态。Electron 里 show:false 的窗口会被 Chromium
 * 当作后台页面，定时器被节流甚至冻结 —— 注入脚本里第一个 await sleep() 就再也回不来，
 * 表现为解析永久挂起（实测 105 秒后被硬超时掐断）。因此改为「屏幕外 + 完全透明 + 不抢焦点」。
 * 关键点二：backgroundThrottling:false，保证滚动懒加载与 SPA 渲染不被降频。
 */
function createCaptureWindow(opts) {
  const o = opts || {};
  const win = new BrowserWindow({
    show: true,
    width: 1440,
    height: 1000,
    x: OFFSCREEN.x,
    y: OFFSCREEN.y,
    skipTaskbar: true,
    focusable: false,
    frame: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: {
      partition: o.partition || CAPTURE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      javascript: true,
      images: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      spellcheck: false,
      sandbox: false
    }
  });
  win.setMenuBarVisibility(false);
  try { win.setOpacity(0); } catch (e) { /* 部分环境不支持，忽略 */ }
  try { win.webContents.setBackgroundThrottling(false); } catch (e) { /* ignore */ }
  try { win.blur(); } catch (e) { /* ignore */ }
  return win;
}

/** 等待主框架加载结束（或超时/失败），返回 { ok, status, error } */
function waitForLoad(win, url, timeout, userAgent) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: '页面加载超时（' + Math.round(timeout / 1000) + 's）' }), timeout);

    win.webContents.once('did-finish-load', () => done({ ok: true }));
    win.webContents.once('did-fail-load', (e, code, desc, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // -3 是用户/程序主动中断，通常发生在重定向抢占时
      if (code === -3) return;
      done({ ok: false, error: '页面加载失败：' + (desc || code) });
    });

    win.loadURL(url, userAgent ? { userAgent } : undefined).catch((err) => {
      done({ ok: false, error: '导航失败：' + (err && err.message ? err.message : String(err)) });
    });
  });
}

/** 统一取 webContents：既接受 BrowserWindow，也接受 WebContents（内置浏览器场景） */
function toWebContents(target) {
  if (!target) throw new Error('目标窗口不可用');
  return target.webContents ? target.webContents : target;
}

/** 在页面主世界执行注入脚本，返回提取结果 */
async function runExtraction(target, platformKey, options) {
  const o = options || {};
  const wc = toWebContents(target);
  const assets = readInjectAssets();
  const injectOpts = {
    platform: platformKey,
    scrollRounds: o.scrollRounds,
    expandAll: !!o.expandAll,
    waitMs: o.waitMs || 12000,
    extraWait: o.extraWait || 0,
    skipWait: !!o.skipWait,
    skipScroll: !!o.skipScroll,
    rule: o.rule || null
  };

  const script = `
(async () => {
  try { window.__TND_OPTS__ = ${JSON.stringify(injectOpts)}; window.__TND_PLATFORM__ = ${JSON.stringify(platformKey)}; } catch (e) {}
  try {
    ${assets.readability}
  } catch (e) { /* Readability 注入失败时退化为选择器提取 */ }
  try {
    ${assets.extract}
  } catch (e) {
    return { ok: false, platform: ${JSON.stringify(platformKey)}, reason: '提取脚本执行失败：' + (e && e.message ? e.message : String(e)), url: location.href };
  }
  if (typeof window.__TND_EXTRACT__ !== 'function') {
    return { ok: false, platform: ${JSON.stringify(platformKey)}, reason: '提取脚本未就绪', url: location.href };
  }
  return await window.__TND_EXTRACT__();
})();
`;

  return wc.executeJavaScript(script, true);
}

/** 执行提取脚本，遇到框架被销毁/上下文重建等瞬时错误时自动重试 */
async function runExtractionRetry(target, platformKey, options, tries) {
  const max = tries || 3;
  let lastErr = null;
  for (let i = 0; i < max; i++) {
    try {
      return await runExtraction(target, platformKey, options);
    } catch (err) {
      lastErr = err;
      const msg = (err && err.message) || '';
      const transient = /WebFrame was removed|frame was destroyed|Script failed to execute|navigation/i.test(msg);
      if (!transient || i === max - 1) throw err;
      await sleep(1200);
    }
  }
  throw lastErr;
}

/**
 * 开启 CDP：页面上新文档创建时注入网络钩子，用于捕获 SPA 的 JSON 接口数据。
 * 失败不影响主流程。
 */
async function enableNetworkCapture(win) {
  const dbg = win.webContents.debugger;

  // 部分 Windows 环境下 debugger target 尚未就绪时，sendCommand 会永久 pending。
  // 先用 about:blank 预热一次导航，确保 target 已挂载，再附加调试器。
  const task = (async () => {
    try { await win.loadURL('about:blank'); } catch (e) { /* ignore */ }
    if (!dbg.isAttached()) dbg.attach('1.3');
    const assets = readInjectAssets();
    await dbg.sendCommand('Page.enable');
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: assets.hook });
    return true;
  })();

  let timedOut = false;
  task.catch(() => { /* 超时后仍可能 reject，提前吞掉避免 unhandledRejection */ });

  try {
    const ok = await Promise.race([
      task,
      new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(false); }, 6000))
    ]);
    if (!ok) {
      console.warn('[extractor] 网络捕获未启用：CDP 命令超时，已跳过（不影响正文提取）');
      try { if (dbg.isAttached()) dbg.detach(); } catch (e) { /* ignore */ }
      return false;
    }
    return true;
  } catch (err) {
    if (!timedOut) console.warn('[extractor] 网络捕获未启用:', err.message);
    try { if (dbg.isAttached()) dbg.detach(); } catch (e) { /* ignore */ }
    return false;
  }
}

function detachDebugger(win) {
  try {
    const dbg = win.webContents.debugger;
    if (dbg.isAttached()) dbg.detach();
  } catch (e) { /* ignore */ }
}

/**
 * 「深抓」：对 IMA 这类左侧目录 / 右侧正文的知识库，
 * 逐个点击目录条目并提取，最后合并为一篇带层级的文档。
 */
/**
 * 知识库深抓：把目录树完整展开后，逐个点开文档并提取，同时保留层级路径。
 *
 * 关键点：目录树是**动态增长**的 —— 展开上层文件夹会带出下层的文件夹。
 * 所以必须「反复扫描 → 点击折叠项 → 再看节点数是否增长」循环到底，
 * 一次性扫描只能拿到第一层（这正是早期版本抓不到深层内容的原因）。
 */
async function deepCapture(target, base, options) {
  const wc = toWebContents(target);
  const dbg = (m) => { if (process.env.TND_DEBUG) console.error('[deep] ' + m); };

  // ① 递归展开所有层级的文件夹
  let expandStat = null;
  try {
    expandStat = await wc.executeJavaScript(
      `(async () => {
        if (typeof window.__TND_TREE_EXPAND__ !== 'function') return null;
        return await window.__TND_TREE_EXPAND__(${options.deepExpandRounds || 12});
      })()`,
      true
    );
    dbg('展开完成 ' + JSON.stringify(expandStat));
  } catch (err) {
    dbg('展开失败：' + err.message);
  }

  // ② 展开后重新提取完整目录树（此时才包含深层文件夹里的文件）
  let directory = base.directory || [];
  try {
    const treeRes = await runExtractionRetry(wc, base.platform, {
      skipWait: true,
      skipScroll: true,
      expandAll: false
    }, 2);
    if (treeRes && treeRes.ok && Array.isArray(treeRes.directory) && treeRes.directory.length) {
      directory = treeRes.directory;
      dbg('重新扫描到 ' + directory.length + ' 个节点');
    }
  } catch (err) {
    dbg('目录重扫失败：' + err.message);
  }

  // ③ 只处理叶子文件（文件夹本身不产出内容）
  const files = directory.filter((d) => !d.isFolder && d.title);
  if (!files.length) return null;

  const limit = Math.min(files.length, options.deepLimit || 200);
  const sections = [];
  let prevHash = '';

  for (let i = 0; i < limit; i++) {
    if (isCanceled(options.flags)) break;
    const node = files[i];

    try {
      const clicked = await wc.executeJavaScript(
        `(() => {
          if (typeof window.__TND_TREE_CLICK__ !== 'function') return false;
          return window.__TND_TREE_CLICK__(${JSON.stringify(node.path || '')}, ${JSON.stringify(node.title)});
        })()`,
        true
      );
      if (!clicked) { dbg('定位失败：' + node.title); continue; }

      await sleep(options.deepWait || 1700);

      // 内容已渲染完毕，跳过等待与滚动，直接提取
      const one = await runExtractionRetry(wc, base.platform, {
        skipWait: true,
        skipScroll: true,
        expandAll: false
      }, 2);
      if (!one || !one.ok) { dbg('提取失败：' + node.title); continue; }

      const hash = crypto.createHash('md5').update(one.contentHtml || '').digest('hex');
      if (hash === prevHash) { dbg('内容与上一篇相同，跳过：' + node.title); continue; }
      prevHash = hash;

      sections.push({
        // 标题以**目录树里的节点名**为准：那是知识库作者命名的权威名称，
        // 而页面标题常常是站点名或产品名（例如整站都叫「XX 知识库」）。
        title: node.title || one.title,
        path: node.path || node.title,
        chars: (one.contentText || '').length,
        html: one.contentHtml,
        text: one.contentText,
        url: one.url,
        order: i
      });

      dbg('已抓取 ' + sections.length + '/' + limit + '　' + (node.path || node.title));
      if (options.onItem) {
        options.onItem({ index: sections.length, total: limit, title: node.title, path: node.path });
      }
    } catch (err) {
      dbg('第 ' + i + ' 项失败：' + err.message);
    }
  }

  if (!sections.length) return null;
  return sections;
}

/** 单页抓取（含失败重试一次） */
async function captureOnce(url, options) {
  const settings = options.settings || {};
  const platformDef = detectPlatform(url);
  const platformKey = options.forcePlatform || platformDef.key;
  const ua = resolveUserAgent(settings, platformKey);

  const t0 = Date.now();
  const stage = (m) => { if (process.env.TND_DEBUG) console.error('[cap ' + String(Date.now() - t0).padStart(6) + 'ms] ' + m); };

  const win = createCaptureWindow({});
  if (options.ctx) options.ctx.win = win;
  let captured = false;
  try {
    stage('窗口已创建');
    if (settings.proxyEnabled && settings.proxyRules) {
      try { await win.webContents.session.setProxy({ proxyRules: settings.proxyRules }); } catch (e) { /* ignore */ }
    }
    if (options.captureApi !== false) {
      await enableNetworkCapture(win);
      stage('网络捕获阶段结束');
    }

    const loaded = await waitForLoad(win, url, settings.timeout || 60000, ua);
    stage('页面加载结束 ok=' + loaded.ok + (loaded.error ? ' err=' + loaded.error : ''));
    if (!loaded.ok) throw new Error(loaded.error);

    captured = true;
    let rule = null;
    try { rule = require('./plugins').matchRule(url); } catch (e) { rule = null; }

    // SPA 在首帧之后常有一次路由跳转，此时执行脚本会撞上 "WebFrame was removed"。
    // 给一段短暂静默期，并对脚本执行本身做重试。
    await sleep(700);
    stage('开始执行提取脚本');
    const result = await runExtractionRetry(win, platformKey, {
      scrollRounds: options.scrollRounds !== undefined ? options.scrollRounds : platformDef.scrollRounds,
      expandAll: options.expandAll !== undefined ? options.expandAll : platformDef.expandAll,
      waitMs: options.waitMs || 12000,
      extraWait: options.extraWait || 0,
      rule
    });
    stage('提取脚本返回 ok=' + (result && result.ok) + (result && result.stats ? ' phases=' + JSON.stringify(result.stats.phases) : ''));

    result.platformKey = platformKey;
    result.platformName = (PLATFORM_MAP[platformKey] || {}).name || '通用网页';
    result.requestedUrl = url;
    if (!result.tree) result.tree = null;
    if (!result.directory) result.directory = null;

    // 深抓（IMA 等带目录的知识库）
    const wantDeep = options.deep === true || (options.deep === undefined && platformKey === 'ima');
    if (wantDeep && result.ok && result.directory && result.directory.length) {
      const sections = await deepCapture(win, result, options);
      if (sections && sections.length) {
        result.sections = sections;
        result.deepCount = sections.length;
      }
    }

    // 记录最终可分享的登录态分区，方便内置浏览器复用
    result.partition = CAPTURE_PARTITION;
    return result;
  } finally {
    detachDebugger(win);
    try { win.destroy(); } catch (e) { /* ignore */ }
  }
}

/**
 * 对外主入口：抓取一个 URL，失败自动重试。
 * @returns {Promise<object>} 提取结果，ok=false 时含 reason
 */
async function capture(url, options) {
  const o = options || {};
  const settings = o.settings || {};
  const retries = Number.isFinite(o.retries) ? o.retries : (settings.autoRetry !== undefined ? settings.autoRetry : 1);
  // 单次尝试的硬上限：即使页面脚本卡死也必须能返回，不能让任务永久挂起
  const hardLimit = Math.max(45000, (settings.timeout || 60000) + 45000);
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (isCanceled(o.flags)) return { ok: false, canceled: true, url, reason: '任务已取消' };

    const ctx = { win: null };
    const r = await withTimeout(captureOnce(url, Object.assign({}, o, { ctx })), hardLimit, () => {
      try { if (ctx.win && !ctx.win.isDestroyed()) ctx.win.destroy(); } catch (e) { /* ignore */ }
      try { if (ctx.win) detachDebugger(ctx.win); } catch (e) { /* ignore */ }
    });

    if (isCanceled(o.flags)) return { ok: false, canceled: true, url, reason: '任务已取消' };
    if (r && r.ok) return r;
    lastErr = (r && r.reason) || '未知错误';

    if (attempt < retries) await sleep(1200);
  }

  return { ok: false, url, reason: lastErr || '提取失败', platformKey: detectPlatform(url).key };
}

/** 超时兜底：resolve 而非 reject，超时后执行 onTimeout 清理资源 */
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (typeof onTimeout === 'function') onTimeout(); } catch (e) { /* ignore */ }
      resolve({ ok: false, reason: '解析耗时过长，已自动中断（' + Math.round(ms / 1000) + 's）' });
    }, ms);

    promise
      .then((r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: (err && err.message) || String(err) });
      });
  });
}

/**
 * 图片本地化：把 HTML 中的远程图片替换为内嵌 base64（自包含）
 * 并把图片落盘到 assetsDir（供 Markdown 引用）。
 */
/** 解码 HTML 实体 —— 序列化后的 src 里 & 会变成 &amp;，不还原会导致下载到错误 URL */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2f;/gi, '/');
}

async function localizeImages(html, ctx) {
  const o = ctx || {};
  // 拿不到 Electron session 时降级为 Node 直连通道（例如脱离主进程的脚本环境）
  let sessionObj = o.session || null;
  if (!sessionObj) {
    try { sessionObj = session.fromPartition(CAPTURE_PARTITION); } catch (e) { sessionObj = null; }
  }
  const imgTagRe = /<img\b[^>]*?\bsrc\s*=\s*("|')([^"']+)\1[^>]*>/gi;

  // 收集唯一的（解码后）图片地址
  const found = [];
  const seen = new Set();
  let m;
  while ((m = imgTagRe.exec(html)) !== null) {
    const src = decodeEntities(m[2]);
    if (!/^https?:/i.test(src)) continue;
    const key = src.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(key);
  }
  if (!found.length) return { html, images: [], inlineMap: {}, total: 0, done: 0 };

  const targets = found.slice(0, Math.min(found.length, o.maxImages || 90));
  const concurrency = 5;
  const inlineMap = {};
  const savedImages = [];

  let cursor = 0;
  const workers = new Array(Math.min(concurrency, targets.length)).fill(0).map(async () => {
    while (cursor < targets.length) {
      const idx = cursor++;
      const url = targets[idx];
      if (isCanceled(o.flags)) return;
      try {
        const res = await requestBuffer(url, {
          session: sessionObj,
          referer: o.referer,
          timeout: 20000,
          maxBytes: o.maxImageBytes || 10 * 1024 * 1024
        });
        if (!res.ok || !res.body || res.body.length < 32) throw new Error('HTTP ' + res.status);
        const mime =
          (res.headers && res.headers['content-type'] ? String(res.headers['content-type']).split(';')[0] : '') ||
          mimeFromUrl(url);
        if (!/^image\//i.test(mime)) throw new Error('非图片响应: ' + mime);
        inlineMap[url] = 'data:' + mime + ';base64,' + res.body.toString('base64');

        if (o.assetsDir) {
          const ext = extFromMime(mime, url);
          const name = 'img-' + String(idx + 1).padStart(3, '0') + '-' + crypto.createHash('md5').update(url).digest('hex').slice(0, 8) + ext;
          fs.mkdirSync(o.assetsDir, { recursive: true });
          const filePath = path.join(o.assetsDir, name);
          fs.writeFileSync(filePath, res.body);
          savedImages.push({ url, name, filePath });
        }
      } catch (err) {
        // 单张图失败不影响整体，导出结果里会提示
        if (process.env.TND_DEBUG) {
          console.error('[img] 下载失败 ' + url.slice(0, 110) + ' → ' + (err && err.message));
        }
      }
    }
  });
  await Promise.all(workers);

  // 用回调式替换：只在 <img> 标签内就地替换，避免全局字符串正则误伤
  const out = html.replace(imgTagRe, (full, quote, rawSrc) => {
    const decoded = decodeEntities(rawSrc).split('#')[0];
    const dataUrl = inlineMap[decoded];
    if (!dataUrl) return full;
    return full.replace(quote + rawSrc + quote, quote + dataUrl + quote);
  });

  return { html: out, images: savedImages, inlineMap, total: found.length, done: Object.keys(inlineMap).length };
}

module.exports = {
  capture,
  captureOnce,
  localizeImages,
  createCaptureWindow,
  waitForLoad,
  runExtraction,
  runExtractionRetry,
  enableNetworkCapture,
  detachDebugger,
  resolveUserAgent,
  CAPTURE_PARTITION
};
