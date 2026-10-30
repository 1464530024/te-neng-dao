'use strict';

/**
 * IMA 知识库 —— OpenAPI 直连导出。
 *
 * 实现对齐开源项目 wandao（https://github.com/tllovesxs/wandao）的 ima 导出插件：
 *   · 认证：HTTP 请求头 ima-openapi-clientid / ima-openapi-apikey
 *   · 凭据：到 https://ima.qq.com/agent-interface 登录后申请 ClientID + APIKey
 *   · 所有接口为 POST + JSON
 *
 * 输出格式（与 wandao 一致）：按知识库目录结构落盘
 *   输出根目录/
 *     知识库名/
 *       文件夹1/文件夹2/
 *         文档标题.md               ← 笔记正文（含 # 标题）
 *         文档标题_assets/          ← 该文档的图片
 *           image-001.png
 *         附件标题.pdf              ← 原始文件（附件）
 *
 *   命名规则：非法字符 → `_`，空白折叠，去首尾 ` .`，截 180 字；同名加 `_2`。
 */

const fs = require('fs');
const path = require('path');
const { requestBuffer } = require('./http');
const { downloadFile } = require('./downloader');

const BASE = process.env.TND_IMA_OPENAPI_BASE || 'https://ima.qq.com/openapi';
const MAX_DEPTH = 12;

/* ───────────────────────── 基础工具 ───────────────────────── */

/**
 * 文件名清理（对齐 wandao 的 sanitize_filename）：
 * 非法字符替换为 `_`，空白折叠为单空格，去掉首尾的点与空格，截断 180 字。
 */
function sanitizeFilename(name, fallback) {
  let t = String(name == null ? '' : name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  return t.slice(0, 180) || (fallback || 'untitled');
}

/** 同名唯一化（对齐 wandao 的 unique_path）：`名称.ext` → `名称_2.ext` → `名称_3.ext` */
function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const stem = path.basename(p, ext);
  const dir = path.dirname(p);
  for (let i = 2; i < 10000; i++) {
    const c = path.join(dir, stem + '_' + i + ext);
    if (!fs.existsSync(c)) return c;
  }
  return path.join(dir, stem + '_' + Date.now() + ext);
}

/** 宽松取值：多字段候选中取第一个非空值（支持 'a.b.c' 嵌套路径） */
function pick(o, keys, fallback) {
  if (o && typeof o === 'object') {
    for (const k of keys) {
      const v = readPath(o, k);
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return fallback === undefined ? '' : fallback;
}

function readPath(o, keyPath) {
  if (keyPath.indexOf('.') < 0) return o[keyPath];
  let cur = o;
  for (const s of String(keyPath).split('.')) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
    cur = cur[s];
  }
  return cur;
}

function cleanText(s) {
  return String(s == null ? '' : s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ───────────────────────── 扩展名 / MIME ───────────────────────── */

const CONTENT_EXTENSIONS = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/x-rar-compressed': '.rar',
  'application/x-7z-compressed': '.7z',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/html': '.html',
  'application/json': '.json',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg'
};

/** 推断下载文件的扩展名（对齐 wandao 的 extension_for_download） */
function extensionForDownload(title, mediaType, contentType) {
  const suffix = path.extname(String(title || ''));
  if (suffix) return suffix;
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (CONTENT_EXTENSIONS[ct]) return CONTENT_EXTENSIONS[ct];
  return '.bin';
}

function imgExt(contentType, url) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (CONTENT_EXTENSIONS[ct] && CONTENT_EXTENSIONS[ct].match(/^\.(png|jpg|gif|webp|bmp|svg)$/)) {
    return CONTENT_EXTENSIONS[ct];
  }
  const m = String(url).split('?')[0].match(/\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff)$/i);
  return m ? '.' + m[1].toLowerCase() : '.png';
}

/* ───────────────────────── 节点识别 ───────────────────────── */

/** 是否文件夹（宽松规则，参考 wandao 的 is_folder_item） */
function isFolderNode(o) {
  if (!o || typeof o !== 'object') return false;
  const id = pick(o, ['media_id', 'folder_id', 'mediaId', 'folderId'], '');
  if (/^folder_/i.test(String(id))) return true;
  if (pick(o, ['is_folder', 'isFolder'], false) === true) return true;
  const nodeType = String(pick(o, ['nodeType', 'type'], '')).toLowerCase();
  if (nodeType === 'folder' || nodeType === 'directory' || nodeType === 'knowledge_base' || nodeType === 'catalog') return true;
  if (o.children && Array.isArray(o.children) && o.children.length) return true;
  const hasListKey = ['folder_number', 'folderNumber', 'file_number', 'is_top']
    .some((k) => Object.prototype.hasOwnProperty.call(o, k));
  if (hasListKey && !pick(o, ['url', 'link', 'download_url', 'file_url'], '')) return true;
  return false;
}

function nodeTitle(o) {
  return cleanText(pick(o, ['name', 'title', 'file_name', 'doc_name', 'fileName', 'media_name', 'folder_name'], ''));
}

function normalizeNode(o, index) {
  const title = nodeTitle(o) || ('未命名-' + (index + 1));
  const isFolder = isFolderNode(o);
  const id = pick(o, ['media_id', 'folder_id', 'mediaId', 'folderId', 'nodeId', 'node_id', 'id', 'file_id'], '');
  const mediaType = Number(pick(o, ['media_type', 'mediaType'], 0)) || 0;
  return { title, isFolder, id: String(id), mediaType };
}

/* ───────────────────────── 响应解析 ───────────────────────── */

function findNodeArray(o, depth) {
  if (!o || depth > 8) return null;
  if (Array.isArray(o)) return o;
  if (typeof o !== 'object') return null;
  const keys = ['knowledge_list', 'knowledgeList', 'knowledge_base_list', 'searched_knowledge_base_list',
    'list', 'folders', 'docs', 'media_list', 'mediaList', 'items', 'file_list', 'fileList'];
  for (const k of keys) {
    if (Array.isArray(o[k])) return o[k];
  }
  if (o.data) {
    const inner = findNodeArray(o.data, depth + 1);
    if (inner) return inner;
  }
  return null;
}

function extractNodeList(resp) {
  const arr = findNodeArray(resp);
  return Array.isArray(arr) ? arr : [];
}

function extractKbList(resp) {
  const arr = findNodeArray(resp);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      id: String(pick(x, ['knowledge_base_id', 'kb_id', 'knowledgeBaseId', 'id', 'kbId'], '')),
      name: cleanText(pick(x, ['name', 'title', 'kb_name', 'knowledge_base_name'], ''))
    }))
    .filter((x) => x.id);
}

/** 从 get_doc_content 响应提取正文 Markdown（多字段兜底） */
function extractContentText(resp) {
  const candidates = ['content', 'doc_content', 'docContent', 'markdown', 'text', 'plain_text', 'plainText', 'doc_text'];
  for (const c of candidates) {
    const v = resp && resp[c];
    if (typeof v === 'string' && v.trim()) return v;
    const d = resp && resp.data && resp.data[c];
    if (typeof d === 'string' && d.trim()) return d;
  }
  const deep = resp && resp.data;
  if (deep && typeof deep === 'object') {
    for (const c of ['content', 'doc_content', 'markdown', 'text']) {
      if (deep[c] && typeof deep[c] === 'object') {
        for (const c2 of ['content', 'text', 'markdown', 'plain_text']) {
          if (typeof deep[c][c2] === 'string' && deep[c][c2].trim()) return deep[c][c2];
        }
      }
    }
  }
  return '';
}

function noteIdFromMediaInfo(info) {
  return String(pick(info, ['note_id', 'noteId', 'notebook_id', 'notebookId',
    'data.note_id', 'data.noteId', 'data.notebook_id', 'data.notebookId'], ''));
}

/* ───────────────────────── 客户端 ───────────────────────── */

class ImaClient {
  constructor(credentials) {
    this.clientId = String((credentials && credentials.clientId) || '').replace(/^\uFEFF/, '').trim();
    this.apiKey = String((credentials && credentials.apiKey) || '').replace(/^\uFEFF/, '').trim();
  }

  hasCredentials() {
    return !!(this.clientId && this.apiKey);
  }

  async post(basePath, body, options) {
    if (!this.hasCredentials()) {
      throw new Error('缺少 IMA ClientID/APIKey，请先在 IMA 页面或设置里配置');
    }
    const url = BASE + basePath;
    const headers = {
      'Content-Type': 'application/json',
      'ima-openapi-clientid': this.clientId,
      'ima-openapi-apikey': this.apiKey
    };

    let res = null;
    try {
      res = await requestBuffer(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body || {}),
        timeout: (options && options.timeout) || 30000,
        maxBytes: (options && options.maxBytes) || 64 * 1024 * 1024
      });
    } catch (err) {
      throw new Error('IMA 接口请求失败：' + (err && err.message ? err.message : String(err)));
    }
    if (!res.ok) throw new Error('IMA 接口 HTTP ' + res.status + '（' + basePath + '）');

    let data = null;
    try {
      data = JSON.parse(res.body.toString('utf8'));
    } catch (e) {
      throw new Error('IMA 接口返回非 JSON：' + basePath);
    }

    const code = pick(data, ['code', 'ret_code', 'retCode', 'status'], 0);
    if (Number(code) !== 0 && Number(code) !== 200) {
      const msg = pick(data, ['msg', 'message', 'errorMsg', 'err_msg'], '') || '未知错误';
      const err = new Error('IMA 接口错误 code=' + code + '：' + msg);
      err.code = Number(code);
      throw err;
    }
    return data;
  }

  wiki(action, payload) {
    return this.post('/wiki/v1/' + action, payload);
  }

  note(action, payload) {
    return this.post('/note/v1/' + action, payload);
  }
}

/* ───────────────────────── 目录遍历 ───────────────────────── */

/**
 * 递归遍历知识库，保留层级片段。
 * @returns {Promise<Array>} 节点列表，每个含 {title,mediaId,isFolder,depth,path,relativeParts,kbId,kbName,mediaType,exportId}
 */
async function walkFolder(client, kbId, folderId, parts, depth, flags, onLog, kbName) {
  const out = [];
  if (depth > MAX_DEPTH || (flags && flags.canceled)) return out;

  let cursor = '';
  for (;;) {
    const resp = await client.wiki('get_knowledge_list', {
      knowledge_base_id: kbId,
      folder_id: folderId || '',
      cursor,
      limit: 50
    });
    const list = extractNodeList(resp);
    if (!list.length) break;

    let index = 0;
    for (const raw of list) {
      if (flags && flags.canceled) return out;
      const item = normalizeNode(raw, index++);
      const relativeParts = parts.slice();
      const thisPath = relativeParts.concat([item.title]).join('/');

      out.push({
        title: item.title,
        mediaId: item.id,
        isFolder: item.isFolder,
        depth,
        path: thisPath,
        relativeParts,
        kbId,
        kbName: kbName || '',
        mediaType: item.mediaType,
        exportId: item.id
      });

      if (item.isFolder && item.id) {
        if (onLog) onLog('展开文件夹：' + thisPath);
        const children = await walkFolder(client, kbId, item.id, relativeParts.concat([item.title]), depth + 1, flags, onLog, kbName);
        for (const c of children) out.push(c);
      }
    }

    const next = pick(resp, ['next_cursor', 'nextCursor', 'data.next_cursor'], '');
    const isEnd = pick(resp, ['is_end', 'isEnd', 'has_more'], false);
    if (!next || String(isEnd) === 'true' || String(isEnd) === '1') break;
    cursor = next;
  }
  return out;
}

/* ───────────────────────── 图片本地化（Markdown） ───────────────────────── */

function extractMdImageUrls(markdown) {
  const out = [];
  const seen = new Set();
  const re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const u = m[1];
    if (/^https?:/i.test(u) && !seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

/**
 * 下载 Markdown 中的远程图片到 assetsDir，改写为相对引用。
 * 命名对齐 wandao：`image-001.ext`；引用形如 `文档名_assets/image-001.png`。
 */
async function localizeMdImages(markdown, assetsDir, failures) {
  const urls = extractMdImageUrls(markdown);
  if (!urls.length) return { md: markdown, downloaded: 0 };

  fs.mkdirSync(assetsDir, { recursive: true });
  const assetsName = path.basename(assetsDir);
  const replacements = {};
  let downloaded = 0;
  let seq = 0;

  for (const url of urls) {
    if (replacements[url]) continue;
    seq += 1;
    try {
      const res = await requestBuffer(url, { timeout: 30000, maxBytes: 20 * 1024 * 1024 });
      if (!res.ok || !res.body || res.body.length < 16) throw new Error('HTTP ' + res.status);
      const ct = (res.headers && res.headers['content-type']) || '';
      const ext = imgExt(ct, url);
      const target = uniquePath(path.join(assetsDir, 'image-' + String(seq).padStart(3, '0') + ext));
      fs.writeFileSync(target, res.body);
      replacements[url] = assetsName + '/' + path.basename(target);
      downloaded += 1;
    } catch (err) {
      failures.push({ url, reason: (err && err.message) || String(err) });
    }
  }

  let md = markdown;
  Object.keys(replacements).forEach((u) => { md = md.split(u).join(replacements[u]); });
  return { md, downloaded };
}

/* ───────────────────────── 落盘：笔记 / 附件 ───────────────────────── */

/** 保存一篇笔记（Markdown）：正文 + 图片本地化（对齐 wandao 的 save_note_entry） */
async function saveNoteEntry(client, entry, targetDir, failures) {
  const mediaInfo = await client.wiki('get_media_info', { media_id: entry.mediaId });
  const noteId = noteIdFromMediaInfo(mediaInfo);
  if (!noteId) throw new Error('笔记类型没有返回 note_id');

  let text = '';
  try {
    const r = await client.note('get_doc_content', { note_id: noteId, target_content_format: 1 });
    text = extractContentText(r).trim();
  } catch (e) {
    const r = await client.note('get_doc_content', { note_id: noteId, target_content_format: 0 });
    text = extractContentText(r).trim();
  }
  if (!text) text = '# ' + entry.title + '\n\n> ima 笔记接口未返回可导出的正文。';
  else if (!text.startsWith('#')) text = '# ' + entry.title + '\n\n' + text + '\n';

  fs.mkdirSync(targetDir, { recursive: true });
  let name = sanitizeFilename(entry.title);
  if (!/\.(md|markdown)$/i.test(name)) name += '.md';
  const target = uniquePath(path.join(targetDir, name));
  const assetsDir = path.join(targetDir, path.basename(target, path.extname(target)) + '_assets');

  const { md } = await localizeMdImages(text, assetsDir, failures);
  fs.writeFileSync(target, md, 'utf8');
  return target;
}

/** 保存一个媒体节点（笔记或附件），对齐 wandao 的 save_media_entry */
async function saveMediaEntry(client, entry, outputRoot, failures, kbName, autoOutputFolder) {
  const parts = (entry.relativeParts || []).map((p) => sanitizeFilename(p, 'folder'));
  const dirParts = (autoOutputFolder === false) ? parts
    : [sanitizeFilename(kbName || entry.kbName, 'knowledge-base')].concat(parts);
  const targetDir = path.join.apply(path, [outputRoot].concat(dirParts));
  fs.mkdirSync(targetDir, { recursive: true });

  const mediaInfo = await client.wiki('get_media_info', { media_id: entry.mediaId });
  const mediaType = Number(pick(mediaInfo, ['media_type', 'mediaType'], entry.mediaType || 0)) || 0;

  if (mediaType === 11) {
    const p = await saveNoteEntry(client, entry, targetDir, failures);
    return { status: 'note', path: p };
  }

  const urlInfo = pick(mediaInfo, ['url_info', 'urlInfo'], null);
  const url = String(
    (urlInfo && typeof urlInfo === 'object' && pick(urlInfo, ['url', 'download_url', 'cos_url', 'file_url'], '')) ||
    pick(mediaInfo, ['url', 'download_url', 'file_url'], '')
  );
  const headers = (urlInfo && typeof urlInfo === 'object' && urlInfo.headers && typeof urlInfo.headers === 'object')
    ? urlInfo.headers : {};
  if (!url) return { status: 'skipped', reason: 'ima 未返回可下载原文链接' };

  const tmpDir = path.join(targetDir, '.tnd-ima-tmp');
  const dl = await downloadFile(url, tmpDir, {
    headers,
    timeout: 300000,
    maxBytes: 2 * 1024 * 1024 * 1024
  });
  if (!dl.ok) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    return { status: 'skipped', reason: dl.error || '下载失败' };
  }

  let name = sanitizeFilename(entry.title);
  if (!path.extname(name)) name += path.extname(dl.name) || '.bin';
  const target = uniquePath(path.join(targetDir, name));
  try {
    fs.renameSync(dl.path, target);
  } catch (err) {
    fs.copyFileSync(dl.path, target);
    try { fs.unlinkSync(dl.path); } catch (e) { /* ignore */ }
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  // Markdown 文件：本地化其中的远程图片
  if (/\.(md|markdown)$/i.test(target)) {
    try {
      let text = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '');
      const assetsDir = path.join(targetDir, path.basename(target, path.extname(target)) + '_assets');
      const r = await localizeMdImages(text, assetsDir, failures);
      fs.writeFileSync(target, r.md, 'utf8');
    } catch (e) { /* 保持原始内容 */ }
  }
  return { status: 'exported', path: target };
}

/* ───────────────────────── 对外入口 ───────────────────────── */

/**
 * 列出当前账号下的知识库。
 * @returns {Promise<{ok:boolean, reason?:string, list?:Array<{id,name}>}>}
 */
async function listKnowledgeBases(credentials) {
  const client = new ImaClient(credentials);
  if (!client.hasCredentials()) return { ok: false, reason: '未配置 IMA 开放接口凭据' };
  try {
    const resp = await client.wiki('search_knowledge_base', { cursor: '', limit: 50, query: '' });
    return { ok: true, list: extractKbList(resp) };
  } catch (err) {
    return { ok: false, reason: (err && err.message) || String(err) };
  }
}

/**
 * 读取知识库目录树（供界面展示与勾选）。
 * @param {object} options { credentials, knowledgeBaseId, knowledgeBaseName, onLog, flags }
 * @returns {Promise<{ok, reason?, entries?:Array}>}
 */
async function scanToc(options) {
  const o = options || {};
  const client = new ImaClient(o.credentials);
  if (!client.hasCredentials()) return { ok: false, reason: '未配置 IMA 开放接口凭据' };
  if (!o.knowledgeBaseId) return { ok: false, reason: '请先选择知识库' };
  try {
    const entries = await walkFolder(client, o.knowledgeBaseId, '', [], 0, o.flags, o.onLog, o.knowledgeBaseName);
    const files = entries.filter((e) => !e.isFolder);
    return {
      ok: true,
      kbId: o.knowledgeBaseId,
      kbName: o.knowledgeBaseName || '',
      entries,
      stats: { nodes: entries.length, folders: entries.length - files.length, files: files.length }
    };
  } catch (err) {
    return { ok: false, reason: (err && err.message) || String(err) };
  }
}

/**
 * 导出知识库到本地目录（对齐 wandao 的输出格式）。
 * @param {object} options
 *   { credentials, knowledgeBaseId, knowledgeBaseName, outputRoot,
 *     docIds?, onItem?, onLog?, flags? }
 * @returns {Promise<{ok, reason?, output?, exportedDocs?, skippedDocs?, failures?, stats?}>}
 */
async function exportToTree(options) {
  const o = options || {};
  const client = new ImaClient(o.credentials);
  if (!client.hasCredentials()) return { ok: false, reason: '未配置 IMA 开放接口凭据' };
  if (!o.knowledgeBaseId) return { ok: false, reason: '请先选择知识库' };

  const log = o.onLog || (() => {});
  const kbName = o.knowledgeBaseName || 'IMA知识库';
  const started = Date.now();

  try {
    log('读取目录树…');
    const all = await walkFolder(client, o.knowledgeBaseId, '', [], 0, o.flags, log, kbName);
    if (o.flags && o.flags.canceled) return { ok: false, canceled: true, reason: '已取消' };

    let docs = all.filter((n) => !n.isFolder);
    if (o.docIds && o.docIds.length) {
      const set = new Set(o.docIds);
      docs = docs.filter((d) => set.has(d.exportId) || set.has(d.mediaId));
    }
    if (!docs.length) return { ok: false, reason: '没有可导出的文档' };

    const outputRoot = path.resolve(o.outputRoot || process.cwd());
    const autoOutputFolder = o.autoOutputFolder !== false;
    const total = docs.length;
    let exported = 0;
    let skipped = 0;
    const failures = [];
    const resourceFailures = [];

    for (let i = 0; i < total; i++) {
      if (o.flags && o.flags.canceled) break;
      const entry = docs[i];
      if (o.onItem) o.onItem({ index: i + 1, total, title: entry.title, path: entry.path, phase: 'started' });
      try {
        const r = await saveMediaEntry(client, entry, outputRoot, resourceFailures, kbName, autoOutputFolder);
        if (r.status === 'note' || r.status === 'exported') {
          exported += 1;
          log('已导出 ' + (i + 1) + '/' + total + '　' + entry.path);
          if (o.onItem) o.onItem({ index: i + 1, total, title: entry.title, path: entry.path, phase: 'done', file: r.path });
        } else {
          skipped += 1;
          if (r.reason) failures.push({ title: entry.title, reason: r.reason });
          log('跳过 ' + (i + 1) + '/' + total + '　' + entry.path + (r.reason ? '：' + r.reason : ''));
          if (o.onItem) o.onItem({ index: i + 1, total, title: entry.title, path: entry.path, phase: 'skipped', reason: r.reason });
        }
      } catch (err) {
        skipped += 1;
        failures.push({ title: entry.title, reason: (err && err.message) || String(err) });
        log('失败 ' + (i + 1) + '/' + total + '　' + entry.path + '：' + ((err && err.message) || err));
        if (o.onItem) o.onItem({ index: i + 1, total, title: entry.title, path: entry.path, phase: 'failed', reason: (err && err.message) || String(err) });
      }
    }

    const output = autoOutputFolder
      ? path.join(outputRoot, sanitizeFilename(kbName, 'knowledge-base'))
      : outputRoot;
    return {
      ok: true,
      provider: 'ima',
      mode: 'export',
      knowledgeBaseName: kbName,
      knowledgeBaseId: o.knowledgeBaseId,
      output,
      selectedDocs: total,
      exportedDocs: exported,
      skippedDocs: skipped,
      failureCount: failures.length,
      failures: failures.slice(0, 20),
      resourceFailureCount: resourceFailures.length,
      resourceFailures: resourceFailures.slice(0, 20),
      elapsedSeconds: Math.round((Date.now() - started) / 100) / 10
    };
  } catch (err) {
    return { ok: false, reason: (err && err.message) || String(err) };
  }
}

module.exports = {
  ImaClient,
  listKnowledgeBases,
  scanToc,
  exportToTree,
  isFolderNode,
  // 供自检测试使用的纯函数
  _internals: {
    sanitizeFilename, uniquePath, extensionForDownload, imgExt,
    extractMdImageUrls, extractContentText, normalizeNode,
    extractKbList, extractNodeList, findNodeArray, isFolderNode
  }
};
