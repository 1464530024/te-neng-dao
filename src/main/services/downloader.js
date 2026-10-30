'use strict';

/**
 * 文件直下通道。
 *
 * 当用户粘贴的链接本身就指向一份文件（.zip / .rar / .pdf / .docx / .xlsx …）时，
 * 走这里直接下载，而不是当作网页去解析正文。
 *
 * 与 http.js 的区别：这里**流式写盘**，不把整个文件读进内存，
 * 因此可以安全处理几百 MB 的压缩包。
 */

const { net, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { UA_PC } = require('./http');

const CAPTURE_PARTITION = 'persist:tnd-capture';

/** 从 content-disposition 或 URL 推断文件名 */
function pickFileName(url, headers) {
  const cd = (headers && (headers['content-disposition'] || headers['Content-Disposition'])) || '';
  let name = '';

  if (cd) {
    // filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf
    let m = cd.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
    if (m) {
      try { name = decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch (e) { name = m[1].trim(); }
    }
    if (!name) {
      m = cd.match(/filename\s*=\s*"([^"]+)"/i) || cd.match(/filename\s*=\s*([^;]+)/i);
      if (m) name = m[1].trim();
    }
  }

  if (!name) {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop() || '';
      name = decodeURIComponent(last);
    } catch (e) {
      name = String(url).split('/').pop() || '';
    }
  }

  name = String(name).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s{2,}/g, ' ').trim();
  return name.slice(0, 120) || '下载文件';
}

/** 同名文件自动加序号，避免覆盖 */
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  let n = 1;
  while (fs.existsSync(p)) {
    p = path.join(dir, base + '(' + n + ')' + ext);
    n += 1;
  }
  return p;
}

/** 流式下载：Electron net 通道（可携带登录 Cookie） */
function viaElectron(url, filePath, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({
        url,
        method: 'GET',
        session: o.session || session.fromPartition(CAPTURE_PARTITION),
        useSessionCookies: true,
        redirect: 'follow'
      });
    } catch (err) {
      reject(err);
      return;
    }

    const headers = {
      'User-Agent': o.userAgent || UA_PC,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    };
    if (o.referer) headers.Referer = o.referer;
    if (o.headers && typeof o.headers === 'object') Object.assign(headers, o.headers);
    Object.keys(headers).forEach((k) => {
      try { req.setHeader(k, headers[k]); } catch (e) { /* ignore */ }
    });

    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    const timer = setTimeout(() => {
      try { req.abort(); } catch (e) { /* ignore */ }
      done(reject, new Error('下载超时'));
    }, o.timeout || 300000);

    let ws = null;

    req.on('response', (res) => {
      if (res.statusCode >= 400) {
        clearTimeout(timer);
        try { res.resume(); } catch (e) { /* ignore */ }
        done(reject, new Error('HTTP ' + res.statusCode));
        return;
      }

      ws = fs.createWriteStream(filePath);
      let size = 0;

      res.on('data', (chunk) => {
        size += chunk.length;
        if (o.maxBytes && size > o.maxBytes) {
          try { req.abort(); } catch (e) { /* ignore */ }
          try { ws.destroy(); } catch (e) { /* ignore */ }
          clearTimeout(timer);
          done(reject, new Error('文件超过大小上限'));
          return;
        }
        ws.write(chunk);
      });
      res.on('end', () => {
        ws.end(() => {
          clearTimeout(timer);
          done(resolve, { size, headers: res.headers, status: res.statusCode });
        });
      });
      res.on('error', (err) => {
        clearTimeout(timer);
        try { ws.destroy(); } catch (e) { /* ignore */ }
        done(reject, err);
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      if (ws) { try { ws.destroy(); } catch (e) { /* ignore */ } }
      done(reject, err);
    });

    req.end();
  });
}

/** 流式下载：Node 直连兜底（应对 ERR_BLOCKED_BY_CLIENT） */
function viaNode(url, filePath, opts, depth) {
  const o = opts || {};
  const d = depth || 0;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('URL 无效')); return; }

    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const headers = { 'User-Agent': o.userAgent || UA_PC, Accept: '*/*' };
    if (o.referer) headers.Referer = o.referer;
    if (o.headers && typeof o.headers === 'object') Object.assign(headers, o.headers);

    const req = mod.get({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      headers,
      timeout: o.timeout || 300000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && d < 5) {
        res.resume();
        viaNode(new URL(res.headers.location, url).href, filePath, o, d + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode >= 400) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }

      const ws = fs.createWriteStream(filePath);
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (o.maxBytes && size > o.maxBytes) {
          try { req.destroy(); } catch (e) { /* ignore */ }
          try { ws.destroy(); } catch (e) { /* ignore */ }
          reject(new Error('文件超过大小上限'));
          return;
        }
        ws.write(chunk);
      });
      res.on('end', () => ws.end(() => resolve({ size, headers: res.headers, status: res.statusCode })));
      res.on('error', (err) => { try { ws.destroy(); } catch (e) { /* ignore */ } reject(err); });
    });

    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } reject(new Error('下载超时')); });
    req.on('error', reject);
  });
}

/**
 * 下载一个文件到指定目录。
 * @returns {Promise<{ok:boolean, path?:string, name?:string, size?:number, error?:string}>}
 */
async function downloadFile(url, outDir, options) {
  const o = options || {};
  fs.mkdirSync(outDir, { recursive: true });

  // 先用 Electron 通道（能带 Cookie）。文件名要在拿到响应头之后才能定，
  // 所以先写临时文件，成功后再按真实文件名重命名。
  const tmp = path.join(outDir, '.tnd-download-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.part');

  let result = null;
  let lastErr = null;

  try {
    result = await viaElectron(url, tmp, o);
  } catch (err) {
    lastErr = err;
  }

  if (!result) {
    try {
      result = await viaNode(url, tmp, o);
      lastErr = null;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!result) {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    return { ok: false, error: (lastErr && lastErr.message) || '下载失败' };
  }

  const name = pickFileName(url, result.headers);
  const finalPath = uniquePath(outDir, name);
  try {
    fs.renameSync(tmp, finalPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    return { ok: false, error: '写入文件失败：' + err.message };
  }

  return { ok: true, path: finalPath, name: path.basename(finalPath), size: result.size };
}

module.exports = { downloadFile, pickFileName, uniquePath };
