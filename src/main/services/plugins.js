'use strict';

const { session, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CAPTURE_PARTITION = 'persist:tnd-capture';

let ctx = {
  userData: '',
  getSettings: () => ({}),
  saveSettings: () => {}
};

let extFile = '';
let ruleFile = '';
let extensions = [];
let rules = [];
const loadedSessions = new Set();

/* ───────── 持久化 ───────── */

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v;
    }
  } catch (e) { /* ignore */ }
  return fallback;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function init(c) {
  ctx = Object.assign(ctx, c || {});
  const dir = path.join(ctx.userData, 'data');
  fs.mkdirSync(dir, { recursive: true });
  extFile = path.join(dir, 'extensions.json');
  ruleFile = path.join(dir, 'rules.json');
  extensions = readJson(extFile, []);
  rules = readJson(ruleFile, []);
  return { extensions, rules };
}

/* ───────── 自定义解析规则 ───────── */

function listRules() {
  return rules;
}

function addRule(rule) {
  const r = rule || {};
  if (!r.hostPattern) throw new Error('请填写域名匹配规则，例如 example.com');
  const item = {
    id: r.id || 'rule-' + crypto.randomBytes(4).toString('hex'),
    name: r.name || r.hostPattern,
    hostPattern: r.hostPattern.trim(),
    titleSelector: r.titleSelector || '',
    authorSelector: r.authorSelector || '',
    timeSelector: r.timeSelector || '',
    contentSelectors: Array.isArray(r.contentSelectors)
      ? r.contentSelectors
      : String(r.contentSelectors || '').split('\n').map((s) => s.trim()).filter(Boolean),
    removeSelectors: Array.isArray(r.removeSelectors)
      ? r.removeSelectors
      : String(r.removeSelectors || '').split('\n').map((s) => s.trim()).filter(Boolean),
    enabled: r.enabled !== false,
    createdAt: new Date().toISOString()
  };
  const i = rules.findIndex((x) => x.id === item.id);
  if (i >= 0) rules[i] = item;
  else rules.unshift(item);
  writeJson(ruleFile, rules);
  return rules;
}

function removeRule(id) {
  rules = rules.filter((r) => r.id !== id);
  writeJson(ruleFile, rules);
  return rules;
}

/** 找到匹配当前 URL 的规则 */
function matchRule(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { return null; }
  return rules.find((r) => {
    if (r.enabled === false) return false;
    const p = String(r.hostPattern).trim();
    if (!p) return false;
    if (p.startsWith('*.')) return host.endsWith(p.slice(1));
    return host === p || host.endsWith('.' + p) || host.includes(p);
  }) || null;
}

/* ───────── Chrome 扩展 ───────── */

/** 从 .crx 中剥离头部，得到纯 zip buffer */
function crxToZip(buf) {
  if (buf.slice(0, 4).toString('ascii') !== 'Cr24') return buf;
  // CRX3: magic(4) version(4) headerSize(4) header(headerSize) zip...
  const version = buf.readUInt32LE(4);
  let offset = 12;
  if (version === 3) {
    const headerSize = buf.readUInt32LE(8);
    offset = 12 + headerSize;
  } else {
    offset = buf.readUInt32LE(8) + 12; // CRX2: pubkeyLen + sigLen
  }
  // 兜底：直接搜索 zip 起点
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const idx = buf.indexOf(sig, offset);
  return buf.slice(idx >= 0 ? idx : offset);
}

function readManifest(dir) {
  const p = path.join(dir, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch (e) {
    return null;
  }
}

function extInfoFromDir(dir) {
  const m = readManifest(dir);
  if (!m) return null;
  return {
    name: m.name || path.basename(dir),
    version: m.version || '0.0.0',
    manifestVersion: m.manifest_version || 2,
    description: m.description || ''
  };
}

async function loadIntoSession(dir) {
  const ses = session.fromPartition(CAPTURE_PARTITION);
  return ses.loadExtension(dir, { allowFileAccess: true });
}

async function applyAll() {
  const tasks = extensions
    .filter((x) => x.enabled !== false && x.path && fs.existsSync(x.path))
    .map(async (x) => {
      try {
        await loadIntoSession(x.path);
        x.loaded = true;
        x.loadError = '';
      } catch (err) {
        x.loaded = false;
        x.loadError = err && err.message ? err.message : String(err);
        console.warn('[plugins] 扩展加载失败 ' + x.name + ':', x.loadError);
      }
    });
  await Promise.all(tasks);
  writeJson(extFile, extensions);
  return extensions;
}

function list() {
  return extensions.map((x) => ({
    id: x.id,
    name: x.name,
    version: x.version,
    manifestVersion: x.manifestVersion,
    description: x.description,
    path: x.path,
    enabled: x.enabled !== false,
    loaded: !!x.loaded,
    loadError: x.loadError || '',
    installedAt: x.installedAt
  }));
}

/**
 * 交互式安装：支持「解压后的扩展文件夹」/「.crx」/「.zip」。
 */
async function installInteractive(win) {
  const pick = await dialog.showOpenDialog(win, {
    title: '选择浏览器扩展（文件夹 / .crx / .zip）',
    buttonLabel: '安装此扩展',
    properties: ['openFile', 'openDirectory'],
    filters: [
      { name: 'Chrome 扩展', extensions: ['crx', 'zip'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (pick.canceled || !pick.filePaths.length) return { canceled: true };

  const target = pick.filePaths[0];
  const stat = fs.statSync(target);
  const id = 'ext-' + crypto.randomBytes(5).toString('hex');
  const dest = path.join(ctx.userData, 'plugins', id);
  fs.mkdirSync(dest, { recursive: true });

  let workingDir = target;

  if (stat.isDirectory()) {
    const info = extInfoFromDir(target);
    if (!info) throw new Error('该文件夹内没有有效的 manifest.json，不是浏览器扩展目录');
    // 复制一份，避免用户后续移动/删除原目录导致扩展失效
    copyDir(target, dest);
    workingDir = dest;
  } else {
    const AdmZip = safeRequire('adm-zip');
    if (!AdmZip) throw new Error('缺少解压组件（adm-zip），无法解压 crx/zip，请改选已解压的扩展文件夹');
    const raw = fs.readFileSync(target);
    const isCrx = raw.slice(0, 4).toString('ascii') === 'Cr24' || path.extname(target).toLowerCase() === '.crx';
    const zipBuf = isCrx ? crxToZip(raw) : raw;
    const zip = new AdmZip(zipBuf);
    zip.extractAllTo(dest, true);
    // 有些 crx 解压后多一层目录
    if (!fs.existsSync(path.join(dest, 'manifest.json'))) {
      const subs = fs.readdirSync(dest).filter((n) => fs.statSync(path.join(dest, n)).isDirectory());
      for (const s of subs) {
        if (fs.existsSync(path.join(dest, s, 'manifest.json'))) {
          const inner = path.join(dest, s);
          fs.readdirSync(inner).forEach((n) => fs.renameSync(path.join(inner, n), path.join(dest, n)));
          try { fs.rmSync(inner, { recursive: true, force: true }); } catch (e) { /* ignore */ }
          break;
        }
      }
    }
    const info = extInfoFromDir(dest);
    if (!info) throw new Error('扩展包内没有找到 manifest.json，可能不是标准的 Chrome 扩展');
  }

  const info = extInfoFromDir(workingDir) || { name: path.basename(workingDir), version: '0.0.0' };
  const record = {
    id,
    name: info.name,
    version: info.version,
    manifestVersion: info.manifestVersion,
    description: info.description,
    path: workingDir,
    enabled: true,
    installedAt: new Date().toISOString()
  };

  try {
    await loadIntoSession(workingDir);
    record.loaded = true;
  } catch (err) {
    record.loaded = false;
    record.loadError = err && err.message ? err.message : String(err);
  }

  extensions.unshift(record);
  writeJson(extFile, extensions);
  return { canceled: false, extension: record };
}

function remove(id) {
  const i = extensions.findIndex((x) => x.id === id);
  if (i < 0) return list();
  const item = extensions[i];
  // 只删除应用内托管目录下的副本，用户自己的原始目录不动
  try {
    const managed = path.join(ctx.userData, 'plugins');
    if (item.path && item.path.startsWith(managed)) fs.rmSync(item.path, { recursive: true, force: true });
  } catch (e) { /* ignore */ }
  extensions.splice(i, 1);
  writeJson(extFile, extensions);
  return list();
}

function toggle(id, enabled) {
  const item = extensions.find((x) => x.id === id);
  if (!item) return list();
  item.enabled = !!enabled;
  if (!enabled) item.loaded = false;
  writeJson(extFile, extensions);
  return list();
}

function describe() {
  return {
    extensions: list(),
    rules: listRules(),
    note: 'Chrome 扩展在应用启动时加载到抓取会话。启用/禁用变更需要重启应用后生效；卸载扩展即时生效。'
  };
}

/* ───────── 小工具 ───────── */

function safeRequire(name) {
  try { return require(name); } catch (e) { return null; }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

module.exports = {
  init,
  applyAll,
  list,
  installInteractive,
  remove,
  toggle,
  describe,
  listRules,
  addRule,
  removeRule,
  matchRule,
  CAPTURE_PARTITION
};
