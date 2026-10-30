'use strict';

/**
 * 资源嗅探器。
 *
 * 通过 CDP 的 Network 域监听内置浏览器页面的网络请求，抓取可下载的资源。
 *
 * 设计约束（按需求）：
 *  1. **只收** 图片 / 文档 / 压缩包 / 其他文件；
 *  2. **明确排除视频与音频**（含 HLS/DASH 分片、流媒体）；
 *  3. 默认关闭，必须由用户点击「嗅探」按钮才开始；
 *  4. 同时扫描已加载页面 DOM，避免「点了嗅探却只能看到之后新增的资源」。
 */

const { webContents } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { requestBuffer, extFromMime } = require('./http');

/* ───────── 扩展名 / MIME 规则 ───────── */

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|tiff?|heic)(?:[?#]|$)/i;
const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|txt|md|markdown|csv|tsv|json|xml|rtf|epub|mobi|wps|et|dps|pages|numbers|key)(?:[?#]|$)/i;
const ZIP_EXT = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst)(?:[?#]|$)/i;
const FILE_EXT = /\.(exe|msi|apk|ipa|dmg|pkg|deb|rpm|iso|img|bin|dat|psd|ai|sketch|fig|xd|ttf|otf|woff2?|eot|srt|ass|vtt|lrc|torrent|sql|db|bak)(?:[?#]|$)/i;

/** 视频 / 音频：一律不收 */
const MEDIA_EXT = /\.(mp4|m4v|mov|avi|mkv|wmv|flv|f4v|webm|mpg|mpeg|3gp|3g2|rmvb|rm|asf|ogv|ts|m2ts|m3u8|m4s|mpd|mp3|wav|flac|aac|m4a|oga|ogg|opus|wma|ape|mid|midi|amr|aiff|mka)(?:[?#]|$)/i;

/** 网页自身资源，无下载价值 */
const WEB_ASSET_EXT = /\.(html?|xhtml|css|js|mjs|cjs|map|php|asp|aspx|jsp)(?:[?#]|$)/i;

const DOC_MIME = /application\/(pdf|x-shockwave-flash)|msword|officedocument|ms-excel|ms-powerpoint|rtf|epub|x-msdownload\.x-ms-application/i;
const ZIP_MIME = /application\/(zip|x-zip|x-rar|x-7z|x-tar|gzip|x-gzip|x-bzip2|x-xz|octet-stream)/i;

/** 无法从扩展名/MIME 判断、但明确属于文档下载的 CDP 资源类型 */
const FILE_LIKE_TYPES = new Set(['Other', 'Document', 'XHR', 'Fetch', 'Preflight', 'Ping', 'CSPViolationReport']);

function fileBaseName(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last.split('?')[0]) || u.hostname;
  } catch (e) {
    return String(url).split('/').pop() || url;
  }
}

/**
 * 判定一个网络资源是否该被收录，并给出分类。
 * @returns {{url,kind,mime,size,name}|null}
 */
function classify(type, url, mime, headers) {
  if (!url || !/^https?:/i.test(url)) return null;

  const clean = String(url).split('#')[0];
  const m = String(mime || '').toLowerCase();

  // ① 硬性排除：视频 / 音频（MIME、CDP 类型、扩展名三重判断）
  if (/^(video|audio)\//.test(m)) return null;
  if (type === 'Media') return null;
  if (MEDIA_EXT.test(clean)) return null;

  // ② 归类。扩展名优先 —— 它对静态资源链接最可靠；
  //    很多站点返回 application/octet-stream，先看 MIME 会把 .exe 误判成压缩包。
  let kind = null;
  if (IMG_EXT.test(clean)) kind = 'image';
  else if (DOC_EXT.test(clean)) kind = 'doc';
  else if (ZIP_EXT.test(clean)) kind = 'zip';
  else if (FILE_EXT.test(clean)) kind = 'file';

  // 扩展名判断不出来时，再用 MIME 兜底
  if (!kind) {
    if (/^image\//.test(m)) kind = 'image';
    else if (DOC_MIME.test(m)) kind = 'doc';
    else if (ZIP_MIME.test(m)) kind = 'zip';
  }

  // 认不出是「可下载文件」的一律丢弃
  if (!kind) return null;

  // ③ 排除网页自身资源。
  //    注意：这里不能再简单地对 type === 'Document' 直接 return null ——
  //    点击一个 PDF/Word 链接时，CDP 上报的资源类型正是 Document，
  //    早期版本因此把用户真正想要的文档全过滤掉了。改为看扩展名与 MIME。
  if (WEB_ASSET_EXT.test(clean)) return null;
  if (/^(text\/html|application\/xhtml|text\/css)/.test(m)) return null;
  if (/javascript/.test(m)) return null;
  if (type === 'Script' || type === 'Stylesheet' || type === 'Font') return null;

  // 接口请求：只有 URL 明确带文件后缀时才算资源，避免把业务接口 JSON 全部收进来
  if ((type === 'XHR' || type === 'Fetch') && !DOC_EXT.test(clean) && !ZIP_EXT.test(clean) && !FILE_EXT.test(clean)) {
    return null;
  }

  // 只接受已知的资源类型，其余（Preflight/Ping 等）若无明确后缀则丢弃
  if (type && !FILE_LIKE_TYPES.has(type) && type !== 'Image' && type !== 'Media') {
    return null;
  }

  // ④ 过滤埋点/统计用的微型图片（1×1 透明像素之类），只对图片生效
  //    注意：content-length 缺失时 size 为 0，此时不做过小判断，避免误杀
  const size = Number(
    (headers && (headers['content-length'] || headers['Content-Length'])) || 0
  ) || 0;
  if (kind === 'image' && size > 0 && size < 1536) return null;

  return {
    id: crypto.createHash('md5').update(clean).digest('hex').slice(0, 12),
    url: clean,
    kind,
    mime: mime || '',
    size,
    name: fileBaseName(clean)
  };
}

/* ───────── 嗅探会话 ───────── */

class Sniffer extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<number, object>} webContentsId → session */
    this.sessions = new Map();
  }

  getSession(id) {
    return this.sessions.get(Number(id)) || null;
  }

  /** 是否正在嗅探 */
  isRunning(id) {
    const s = this.getSession(id);
    return !!(s && s.running);
  }

  list(id) {
    const s = this.getSession(id);
    return s ? s.items : [];
  }

  /**
   * 开始嗅探。
   * @param {number} webContentsId webview 的 webContents id
   */
  async start(webContentsId) {
    const id = Number(webContentsId);
    const wc = webContents.fromId(id);
    if (!wc || wc.isDestroyed()) throw new Error('页面不可用，请刷新后重试');

    const existing = this.sessions.get(id);
    if (existing && existing.running) return existing.items;

    const session = {
      id,
      running: true,
      items: [],
      seen: new Set(),
      dbg: null,
      handler: null
    };

    // 复用已有结果（停止后再开启不会丢已嗅探到的内容）
    if (existing) {
      session.items = existing.items;
      session.seen = existing.seen;
    }

    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('Network.enable');
    } catch (err) {
      try { if (dbg.isAttached()) dbg.detach(); } catch (e) { /* ignore */ }
      throw new Error('无法启动嗅探：' + (err && err.message ? err.message : String(err)));
    }

    const handler = (_event, method, params) => {
      try {
        if (method === 'Network.responseReceived') {
          const res = params.response || {};
          const item = classify(params.type, res.url, res.mimeType, res.headers);
          if (item) this._push(session, item);
        }
      } catch (e) { /* 单条异常不影响监听 */ }
    };

    dbg.on('message', handler);
    session.dbg = dbg;
    session.handler = handler;

    this.sessions.set(id, session);

    // 页面销毁时自动清理，避免句柄泄漏
    wc.once('destroyed', () => {
      const s = this.sessions.get(id);
      if (s) {
        try { if (s.dbg && s.dbg.isAttached()) s.dbg.detach(); } catch (e) { /* ignore */ }
        s.running = false;
      }
    });

    // 扫描已渲染页面中现成的资源
    await this.scanDom(id).catch(() => {});

    return session.items;
  }

  /** 停止嗅探（保留已收集到的结果） */
  stop(webContentsId) {
    const id = Number(webContentsId);
    const s = this.sessions.get(id);
    if (!s) return [];
    s.running = false;
    try {
      if (s.dbg && s.handler) s.dbg.off('message', s.handler);
      if (s.dbg && s.dbg.isAttached()) s.dbg.detach();
    } catch (e) { /* ignore */ }
    return s.items;
  }

  clear(webContentsId) {
    const id = Number(webContentsId);
    const s = this.sessions.get(id);
    if (!s) return [];
    s.items = [];
    s.seen = new Set();
    this.emit('update', { webContentsId: id, items: s.items });
    return s.items;
  }

  /** 扫描页面 DOM 中已存在的资源（图片、指向文件的链接） */
  async scanDom(webContentsId) {
    const id = Number(webContentsId);
    const s = this.sessions.get(id);
    const wc = webContents.fromId(id);
    if (!s || !wc || wc.isDestroyed()) return [];

    const urls = await wc
      .executeJavaScript(
        `(() => {
          const out = [];
          const push = (u) => {
            if (!u) return;
            const s = String(u).trim();
            if (!s || s.startsWith('javascript:') || s.startsWith('mailto:') || s.startsWith('tel:') || s === '#') return;
            out.push(s.split('#')[0]);
          };

          // 图片：currentSrc 已是绝对地址
          document.querySelectorAll('img').forEach((el) => {
            push(el.currentSrc || el.src || el.getAttribute('data-src') || el.getAttribute('data-original'));
          });

          // 链接：必须用 a.href —— DOM 属性会自动补全成绝对地址。
          // 用 getAttribute('href') 拿到的是 /files/x.pdf 这类相对路径，
          // 早期版本在主进程里按 /^https?:/ 预过滤时把它们全丢掉了，
          // 这正是「页面上的 PDF/Word 链接嗅探不到」的根因。
          document.querySelectorAll('a[href]').forEach((a) => push(a.href));

          // 一些站点把下载地址放在 data-* 上，由脚本动态触发
          document.querySelectorAll('[data-href],[data-url],[data-download-url],[data-file]').forEach((el) => {
            push(el.getAttribute('data-href') || el.getAttribute('data-url') ||
                 el.getAttribute('data-download-url') || el.getAttribute('data-file'));
          });

          // 内嵌对象与图标
          document.querySelectorAll('object[data],embed[src],link[rel*="icon"]').forEach((el) => {
            push(el.getAttribute('data') || el.getAttribute('src') || el.getAttribute('href'));
          });

          return Array.from(new Set(out));
        })()`,
        true
      )
      .catch(() => []);

    let added = 0;
    (urls || []).forEach((u) => {
      const abs = (() => { try { return new URL(u, wc.getURL()).href; } catch (e) { return ''; } })();
      if (!abs) return;
      const item = classify('Other', abs, '', null);
      if (item) { if (this._push(s, item)) added += 1; }
    });

    return s.items;
  }

  _push(session, item) {
    if (session.seen.has(item.url)) return false;
    session.seen.add(item.url);
    session.items.push(item);
    this.emit('update', { webContentsId: session.id, items: session.items, added: item });
    return true;
  }

  /**
   * 下载嗅探到的资源。
   * @returns {Promise<{saved:Array, failed:Array}>}
   */
  async download(webContentsId, urls, outDir, options) {
    const o = options || {};
    const id = Number(webContentsId);
    const s = this.sessions.get(id);
    const list = Array.isArray(urls) ? urls : [urls];
    const meta = new Map((s ? s.items : []).map((i) => [i.url, i]));

    fs.mkdirSync(outDir, { recursive: true });

    const { session: electronSession } = require('electron');
    const ses = electronSession.fromPartition(o.partition || 'persist:tnd-capture');
    const referer = o.referer || '';

    const saved = [];
    const failed = [];
    const used = new Set();

    // 并发 4 条，避免把目标站打崩
    let cursor = 0;
    const workers = new Array(Math.min(4, list.length)).fill(0).map(async () => {
      while (cursor < list.length) {
        const idx = cursor++;
        const url = list[idx];
        if (!url) continue;
        try {
          const res = await requestBuffer(url, {
            session: ses,
            referer,
            timeout: 60000,
            maxBytes: o.maxBytes || 300 * 1024 * 1024
          });
          if (!res.ok || !res.body || !res.body.length) throw new Error('HTTP ' + res.status);

          const mime = (res.headers && res.headers['content-type']
            ? String(res.headers['content-type']).split(';')[0]
            : '') || (meta.get(url) || {}).mime || '';
          const info = meta.get(url) || {};
          let ext = path.extname(info.name || '') || extFromMime(mime, url);
          let base = path.basename(info.name || fileBaseName(url), path.extname(info.name || ''));

          base = String(base || 'resource').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
          let name = base + ext;
          let n = 1;
          while (used.has(name.toLowerCase())) { name = base + '(' + n + ')' + ext; n += 1; }
          used.add(name.toLowerCase());

          const filePath = path.join(outDir, name);
          fs.writeFileSync(filePath, res.body);
          saved.push({ url, path: filePath, size: res.body.length, name });
        } catch (err) {
          failed.push({ url, error: (err && err.message) || String(err) });
        }
      }
    });
    await Promise.all(workers);

    return { saved, failed };
  }

  dispose(id) {
    const n = Number(id);
    this.stop(n);
    this.sessions.delete(n);
  }
}

module.exports = { Sniffer, classify, MEDIA_EXT, IMG_EXT, DOC_EXT, ZIP_EXT, FILE_EXT, WEB_ASSET_EXT };
