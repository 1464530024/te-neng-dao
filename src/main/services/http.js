'use strict';

const { net, session } = require('electron');

const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

/**
 * 使用 Electron net 发起请求 —— 自动携带对应 session 的 Cookie，
 * 因此需要登录态的图片（公众号、知乎、小红书）也能下载成功。
 */
function electronRequest(url, opts) {
  const o = opts || {};
  const timeout = o.timeout || 30000;
  const maxBytes = o.maxBytes || 12 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({
        url,
        method: o.method || 'GET',
        session: o.session || undefined,
        partition: o.session ? undefined : (o.partition || undefined),
        useSessionCookies: true,
        redirect: 'follow'
      });
    } catch (err) {
      reject(err);
      return;
    }

    const headers = Object.assign(
      {
        'User-Agent': o.userAgent || UA_PC,
        Accept: o.accept || '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      o.headers || {}
    );
    if (o.referer) headers.Referer = o.referer;
    Object.keys(headers).forEach((k) => {
      try { req.setHeader(k, headers[k]); } catch (e) { /* ignore */ }
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.abort(); } catch (e) { /* ignore */ }
      reject(new Error('请求超时'));
    }, timeout);

    const chunks = [];
    let size = 0;

    req.on('response', (res) => {
      const status = res.statusCode;
      if (status >= 400) {
        clearTimeout(timer);
        settled = true;
        resolve({ ok: false, status, body: Buffer.alloc(0), headers: res.headers });
        try { res.resume(); } catch (e) { /* ignore */ }
        return;
      }
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          clearTimeout(timer);
          settled = true;
          try { req.abort(); } catch (e) { /* ignore */ }
          resolve({ ok: true, status, body: Buffer.concat(chunks), headers: res.headers, truncated: true });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, status, body: Buffer.concat(chunks), headers: res.headers });
      });
      res.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    if (o.body) req.write(o.body);
    req.end();
  });
}

/**
 * 纯 Node 通道下载。用于 Electron 网络层被拦截（实测 mmbiz.qpic.cn 会返回
 * net::ERR_BLOCKED_BY_CLIENT）时的兜底。不带 Cookie，但对公开图片足够。
 */
function nodeRequest(url, opts, depth) {
  const o = opts || {};
  const maxRedirect = 5;
  const d = depth || 0;

  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('URL 无效')); return; }

    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const headers = Object.assign(
      {
        'User-Agent': o.userAgent || UA_PC,
        Accept: o.accept || 'image/avif,image/webp,image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      o.headers || {}
    );
    if (o.referer) headers.Referer = o.referer;

    const req = mod.request(
      {
        method: o.method || 'GET',
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers,
        timeout: o.timeout || 30000
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && d < maxRedirect) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          nodeRequest(next, o, d + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode >= 400) {
          res.resume();
          resolve({ ok: false, status: res.statusCode, body: Buffer.alloc(0), headers: res.headers, via: 'node' });
          return;
        }
        const chunks = [];
        let size = 0;
        const maxBytes = o.maxBytes || 12 * 1024 * 1024;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            try { req.destroy(); } catch (e) { /* ignore */ }
            resolve({ ok: true, status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers, truncated: true, via: 'node' });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({ ok: true, status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers, via: 'node' })
        );
        res.on('error', reject);
      }
    );

    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } reject(new Error('请求超时')); });
    req.on('error', reject);

    if (o.body) {
      try { req.write(o.body); } catch (e) { /* ignore */ }
    }
    req.end();
  });
}

/**
 * 对外统一入口：先走 Electron 通道（可携带登录 Cookie），
 * 失败或返回异常时自动回退到 Node 直连通道。
 */
async function requestBuffer(url, opts) {
  const o = opts || {};
  let first = null;
  try {
    first = await electronRequest(url, o);
  } catch (err) {
    first = { ok: false, status: 0, body: Buffer.alloc(0), headers: {}, error: err.message };
  }

  const good = first.ok && first.body && first.body.length >= 32;
  if (good || o.noFallback) return first;

  try {
    const second = await nodeRequest(url, o);
    if (second.ok && second.body && second.body.length >= 32) return second;
    return second.ok ? second : first;
  } catch (err) {
    first.fallbackError = err.message;
    return first;
  }
}

function mimeFromUrl(url, fallback) {
  const m = String(url).split('?')[0].match(/\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i);
  if (!m) return fallback || 'image/png';
  const ext = m[1].toLowerCase();
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    avif: 'image/avif'
  };
  return map[ext] || fallback || 'image/png';
}

function extFromMime(mime, url) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
    'image/avif': '.avif'
  };
  if (map[m]) return map[m];
  const um = String(url).split('?')[0].match(/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i);
  return um ? '.' + um[1].toLowerCase() : '.png';
}

module.exports = { requestBuffer, UA_PC, UA_MOBILE, mimeFromUrl, extFromMime };
