'use strict';

const {
  app, BrowserWindow, ipcMain, shell, dialog, session, Menu, Tray,
  nativeImage, Notification, webContents, nativeTheme, clipboard
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  APP_NAME, APP_ID, DEFAULT_SETTINGS, detectPlatform, extractUrls, PLATFORM_MAP, EXPORT_FORMATS,
  SEARCH_ENGINES, BROWSER_HOME_PRESETS, SNIFF_KINDS, buildSearchUrl, looksLikeUrl
} = require('../shared/constants');
const { JsonStore, HistoryStore } = require('./services/store');
const { TaskQueue, newId, nowIso } = require('./services/taskQueue');
const extractor = require('./services/extractor');
const exporter = require('./services/exporter');
const imaApi = require('./services/imaApi');
const plugins = require('./services/plugins');
const { Sniffer } = require('./services/sniffer');

/* ───────────────── 单实例 ───────────────── */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/* ───────────────── 全局状态 ───────────────── */
let mainWindow = null;
let tray = null;
let isQuitting = false;

let settingsStore = null;
let historyStore = null;
let taskQueue = null;
const sniffer = new Sniffer();

const CAPTURE_PARTITION = extractor.CAPTURE_PARTITION;

function userDataDir() {
  return app.getPath('userData');
}

function dataDir() {
  const d = path.join(userDataDir(), 'data');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function exportsDir() {
  const d = path.join(userDataDir(), 'exports-html');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function getSettings() {
  return settingsStore ? settingsStore.get() : Object.assign({}, DEFAULT_SETTINGS);
}

/* ───────────────── 主窗口 ───────────────── */
function createMainWindow() {
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1120,
    minHeight: 700,
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    title: APP_NAME,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (settingsStore.get('windowMaximized')) mainWindow.maximize();
  });

  const pushWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:state', {
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen()
    });
  };
  ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach((ev) =>
    mainWindow.on(ev, pushWindowState)
  );

  mainWindow.on('close', (e) => {
    if (settingsStore.get('windowMaximized') !== mainWindow.isMaximized()) {
      settingsStore.set('windowMaximized', mainWindow.isMaximized());
    }
    if (!isQuitting && getSettings().minimizeToTray && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // 外部链接一律用系统浏览器打开，避免应用内被导航走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const cur = mainWindow.webContents.getURL();
    if (url !== cur && !url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

/* ───────────────── 托盘 ───────────────── */
function createTray() {
  if (tray) return;
  const trayIconPath = path.join(__dirname, '..', '..', 'build', 'tray.png');
  const icoPath = path.join(__dirname, '..', '..', 'build', 'icon.ico');
  const p = fs.existsSync(trayIconPath) ? trayIconPath : (fs.existsSync(icoPath) ? icoPath : null);
  if (!p) return;
  try {
    tray = new Tray(nativeImage.createFromPath(p).resize({ width: 16, height: 16 }));
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主界面', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { type: 'separator' },
        { label: '退出 ' + APP_NAME, click: () => { isQuitting = true; app.quit(); } }
      ])
    );
    tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  } catch (e) { /* 托盘创建失败不影响主功能 */ }
}

/* ───────────────── 应用菜单（快捷键） ───────────────── */
function buildAppMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '链接导出任务', accelerator: 'CmdOrCtrl+N', click: () => sendToRenderer('menu:new-task') },
        { label: '打开内置浏览器', accelerator: 'CmdOrCtrl+T', click: () => sendToRenderer('menu:open-browser') },
        { type: 'separator' },
        { label: '打开导出目录', click: () => shell.openPath(getSettings().outDir || path.join(os.homedir(), 'Downloads', '特能导导出')) },
        { label: '打开数据目录', click: () => shell.openPath(userDataDir()) },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit(); } }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载界面' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '使用说明', click: () => sendToRenderer('menu:goto', 'help') },
        { label: '关于 ' + APP_NAME, click: () => sendToRenderer('menu:goto', 'about') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/**
 * 统一接管所有 webContents 的「新开窗口」行为。
 *
 * 内置浏览器里点搜索结果、target="_blank" 链接时，Electron 默认会弹出一个原生窗口
 * （带「文件 编辑 视图 帮助」菜单栏），体验很割裂。这里改为：把目标 URL 交回渲染进程，
 * 直接在当前内置浏览器中打开；抓取用的隐藏窗口则一律拒绝，防止隐藏窗口泄漏。
 */
function installWindowOpenGuard() {
  app.on('web-contents-created', (event, contents) => {
    const type = contents.getType();

    if (type === 'webview') {
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) sendToRenderer('browser:open-url', url);
        return { action: 'deny' };
      });
      // 兜底：某些站点的 _blank 链接走的是 will-navigate 之外的路径
      contents.on('will-navigate', (e, url) => {
        if (contents.isDestroyed()) return;
        // 内置浏览器自身导航保持默认行为，仅拦截非 http(s) 协议
        if (!/^https?:|^about:|^file:/i.test(url)) e.preventDefault();
      });
      return;
    }

    if (type === 'window') {
      contents.setWindowOpenHandler(({ url }) => {
        const isMain = mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents;
        if (isMain && /^https?:/i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
      });
    }
  });
}

/**
 * 解析内置浏览器中当前已渲染的页面。
 * 复用同一会话（登录态）与已加载 DOM，因此比重新抓取快得多。
 */
async function parseWebviewPage(webContentsId, platform, opts) {
  const o = opts || {};
  const wc = webContentsId ? webContents.fromId(Number(webContentsId)) : null;
  if (!wc || wc.isDestroyed()) throw new Error('内置浏览器页面不可用，请刷新后重试');

  const url = wc.getURL();
  const platformKey = (platform && platform !== 'auto') ? platform : detectPlatform(url).key;

  let rule = null;
  try { rule = plugins.matchRule(url); } catch (e) { rule = null; }

  const r = await extractor.runExtractionRetry(wc, platformKey, {
    scrollRounds: o.scrollRounds === undefined ? 2 : o.scrollRounds,
    expandAll: o.expandAll !== undefined ? o.expandAll : true,
    waitMs: o.waitMs || 8000,
    rule
  });

  if (r && r.ok) {
    r.platformKey = platformKey;
    r.platformName = (PLATFORM_MAP[platformKey] || {}).name || '通用网页';
    r.requestedUrl = url;
    r.fromWebview = true;
  }
  return r;
}

/* ───────────────── 通知 ───────────────── */
function notify(title, body, extra) {
  const s = getSettings();
  if (s.notifyBadge !== false) {
    sendToRenderer('notify:toast', Object.assign({ title, body, level: 'success' }, extra || {}));
  }
  if (s.notifySound === false) return;
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, silent: false, icon: path.join(__dirname, '..', '..', 'build', 'icon.ico') });
      n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
      n.show();
    }
  } catch (e) { /* ignore */ }
}

/* ───────────────── IPC ───────────────── */
function registerIpc() {
  /* 应用信息 */
  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    userData: userDataDir(),
    defaultOutDir: path.join(os.homedir(), 'Downloads', '特能导导出'),
    formats: EXPORT_FORMATS
  }));

  ipcMain.handle('app:platforms', () => Object.keys(PLATFORM_MAP).map((k) => {
    const p = PLATFORM_MAP[k];
    return { key: p.key, name: p.name, desc: p.desc, accent: p.accent, needsLogin: !!p.needsLogin };
  }));

  ipcMain.handle('app:detect', (e, urls) => {
    const list = Array.isArray(urls) ? urls : extractUrls(urls);
    return list.map((u) => {
      const p = detectPlatform(u);
      return { url: u, platform: p.key, platformName: p.name, accent: p.accent, needsLogin: !!p.needsLogin };
    });
  });

  ipcMain.handle('app:parseUrls', (e, text) => extractUrls(text));

  /* 设置 */
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:save', (e, patch) => {
    // 深合并：保留嵌套对象里未被 patch 覆盖的字段（如 imaOpenApi 的 clientId/apiKey 分两次填写）
    const cur = settingsStore.get();
    const merged = Object.assign({}, cur, patch || {});
    Object.keys(merged).forEach((k) => {
      if (patch && patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) &&
        cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k])) {
        merged[k] = Object.assign({}, cur[k], patch[k]);
      }
    });
    const s = settingsStore.merge(merged);
    if (patch && patch.theme) nativeTheme.themeSource = patch.theme;
    return s;
  });
  ipcMain.handle('settings:reset', () => {
    settingsStore.data = Object.assign({}, DEFAULT_SETTINGS);
    settingsStore.flush();
    return settingsStore.get();
  });

  /* 目录选择 */
  ipcMain.handle('dialog:chooseDir', async (e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择导出文件夹',
      defaultPath: defaultPath || getSettings().outDir || os.homedir(),
      properties: ['openDirectory', 'createDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:chooseFiles', async (e, opts) => {
    const o = opts || {};
    const r = await dialog.showOpenDialog(mainWindow, {
      title: o.title || '选择文件',
      properties: o.directory ? ['openDirectory'] : ['openFile'],
      filters: o.filters || [{ name: '所有文件', extensions: ['*'] }]
    });
    return r.canceled ? null : r.filePaths;
  });

  /* 系统外壳 */
  ipcMain.handle('shell:openPath', async (e, p) => {
    if (!p) return '路径为空';
    return shell.openPath(p);
  });
  ipcMain.handle('shell:openExternal', async (e, url) => {
    if (!/^https?:/i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('shell:showItem', (e, p) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    return true;
  });
  ipcMain.handle('fs:exists', (e, p) => {
    try { return p ? fs.existsSync(p) : false; } catch (err) { return false; }
  });

  /* 窗口控制 */
  ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close(); });
  ipcMain.handle('window:hide', () => { if (mainWindow) mainWindow.hide(); });

  /* 任务 */
  ipcMain.handle('task:submit', (e, payload) => {
    const t = taskQueue.submit(payload || {});
    notify('已加入任务队列', t.name + '（共 ' + t.total + ' 条链接）', { level: 'info' });
    return t;
  });
  ipcMain.handle('task:list', () => taskQueue.list());
  ipcMain.handle('task:stats', () => taskQueue.stats());
  ipcMain.handle('task:cancel', (e, id) => taskQueue.cancel(id));
  ipcMain.handle('task:retry', (e, id) => taskQueue.retry(id));
  ipcMain.handle('task:remove', (e, id) => { taskQueue.remove(id); return taskQueue.list(); });
  ipcMain.handle('task:clearFinished', () => { taskQueue.clearFinished(); return taskQueue.list(); });

  /* IMA 开放接口 */
  ipcMain.handle('ima:listKnowledgeBases', async (e, payload) => {
    const cfg = (getSettings().imaOpenApi) || {};
    const creds = (payload && payload.credentials) || cfg;
    return imaApi.listKnowledgeBases(creds);
  });
  ipcMain.handle('ima:scanToc', async (e, payload) => {
    const cfg = (getSettings().imaOpenApi) || {};
    const p = payload || {};
    return imaApi.scanToc({
      credentials: p.credentials || cfg,
      knowledgeBaseId: p.knowledgeBaseId,
      knowledgeBaseName: p.knowledgeBaseName,
      onLog: (m) => sendToRenderer('ima:progress', { phase: 'log', message: m })
    });
  });
  ipcMain.handle('ima:exportTree', async (e, payload) => {
    const cfg = (getSettings().imaOpenApi) || {};
    const p = payload || {};
    return imaApi.exportToTree({
      credentials: p.credentials || cfg,
      knowledgeBaseId: p.knowledgeBaseId,
      knowledgeBaseName: p.knowledgeBaseName,
      outputRoot: p.outputRoot,
      docIds: p.docIds,
      autoOutputFolder: p.autoOutputFolder !== false,
      onItem: (info) => sendToRenderer('ima:progress', info),
      onLog: (m) => sendToRenderer('ima:progress', { phase: 'log', message: m })
    });
  });

  /* 单次预览解析（不落盘） */
  ipcMain.handle('extract:preview', async (e, payload) => {
    const p = payload || {};
    const url = p.url;
    if (!/^https?:/i.test(url || '')) throw new Error('请提供有效的 http/https 链接');
    const s = getSettings();
    const r = await extractor.capture(url, {
      settings: s,
      deep: p.deep,
      retries: 0,
      scrollRounds: p.scrollRounds,
      expandAll: p.expandAll,
      waitMs: p.waitMs
    });
    return r;
  });

  /* 解析内置浏览器中已打开的页面（复用登录态与已渲染的 DOM，速度最快） */
  ipcMain.handle('extract:webview', async (e, payload) => {
    const p = payload || {};
    try {
      return await parseWebviewPage(p.webContentsId, p.platform, {
        scrollRounds: p.scrollRounds,
        expandAll: p.expandAll,
        waitMs: p.waitMs
      });
    } catch (err) {
      return { ok: false, reason: '页面解析失败：' + err.message };
    }
  });

  /* 导出（把预览结果落盘，支持重命名与目标目录） */
  ipcMain.handle('export:save', async (e, payload) => {
    const p = payload || {};
    const result = p.result;
    if (!result || !result.ok) throw new Error('没有可导出的内容');
    const s = getSettings();
    const outDir = p.outDir || s.outDir || path.join(os.homedir(), 'Downloads', '特能导导出');
    const fileName = exporter.safeFileName(p.fileName || result.title, '未命名');

    const exported = await exporter.exportResult(result, {
      outDir: s.groupByPlatform === false ? outDir : path.join(outDir, exporter.safeFileName(result.platformName || '通用网页')),
      formats: p.formats && p.formats.length ? p.formats : s.formats,
      fileName,
      pageSize: p.pageSize || s.pageSize,
      fileNameTemplate: s.fileNameTemplate
    });

    // 写入历史
    const rec = {
      id: newId('hist'),
      title: result.title || '未命名',
      url: result.requestedUrl || result.url || '',
      platform: result.platformKey || '',
      platformName: result.platformName || '',
      author: result.author || '',
      publishTime: result.publishTime || '',
      chars: (result.stats && result.stats.chars) || 0,
      images: (result.stats && result.stats.images) || 0,
      deepCount: result.deepCount || 0,
      exportedAt: nowIso(),
      outDir: exported.dir,
      files: exported.files,
      warnings: exported.warnings || []
    };
    historyStore.add(rec);
    sendToRenderer('history:changed', historyStore.list());

    notify('导出完成', rec.title, { level: 'success', files: exported.files, outDir: exported.dir });
    return { record: rec, warnings: exported.warnings || [] };
  });

  /* 历史 */
  ipcMain.handle('history:list', () => historyStore.list());
  ipcMain.handle('history:remove', (e, id) => { historyStore.remove(id); return historyStore.list(); });
  ipcMain.handle('history:clear', () => { historyStore.clear(); return historyStore.list(); });
  ipcMain.handle('history:export', async (e, payload) => {
    const p = payload || {};
    const list = p.ids && p.ids.length ? historyStore.list().filter((x) => p.ids.includes(x.id)) : historyStore.list();
    const file = await dialog.showSaveDialog(mainWindow, {
      title: '导出历史记录',
      defaultPath: path.join(os.homedir(), 'Desktop', '特能导-历史记录-' + exporter.dateStamp() + '.csv'),
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    });
    if (file.canceled || !file.filePath) return null;
    const rows = [['导出时间', '标题', '平台', '作者', '发布时间', '字数', '图片数', '原文链接', '文件']];
    list.forEach((r) => rows.push([
      r.exportedAt, r.title, r.platformName, r.author, r.publishTime,
      r.chars, r.images, r.url, (r.files || []).map((f) => f.path).join(' | ')
    ]));
    const csv = '\ufeff' + rows.map((r) => r.map((c) => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    fs.writeFileSync(file.filePath, csv, 'utf8');
    return file.filePath;
  });

  /* 插件 */
  ipcMain.handle('plugin:list', () => plugins.list());
  ipcMain.handle('plugin:install', async () => plugins.installInteractive(mainWindow));
  ipcMain.handle('plugin:remove', async (e, id) => plugins.remove(id));
  ipcMain.handle('plugin:toggle', async (e, payload) => plugins.toggle(payload.id, payload.enabled));
  ipcMain.handle('plugin:addRule', (e, rule) => plugins.addRule(rule));
  ipcMain.handle('plugin:removeRule', (e, id) => plugins.removeRule(id));
  ipcMain.handle('plugin:rules', () => plugins.listRules());
  ipcMain.handle('plugin:ready', () => plugins.describe());

  /* 登录态与缓存 */
  ipcMain.handle('session:clear', async (e, what) => {
    const ses = session.fromPartition(CAPTURE_PARTITION);
    if (what === 'cache') await ses.clearCache();
    else {
      await ses.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'websql', 'shadercache']
      });
      await ses.clearCache();
    }
    return true;
  });

  ipcMain.handle('session:info', async () => {
    const ses = session.fromPartition(CAPTURE_PARTITION);
    const cookies = await ses.cookies.get({});
    const byDomain = {};
    cookies.forEach((c) => { byDomain[c.domain] = (byDomain[c.domain] || 0) + 1; });
    return { cookieCount: cookies.length, domains: Object.keys(byDomain).slice(0, 40), ua: ses.getUserAgent() };
  });

  /* 内置浏览器 */
  ipcMain.handle('browser:meta', () => {
    const s = getSettings();
    return {
      engines: SEARCH_ENGINES,
      homePresets: BROWSER_HOME_PRESETS,
      sniffKinds: SNIFF_KINDS,
      home: s.browserHomeUrl || 'https://www.baidu.com/',
      engine: s.browserSearchEngine || 'baidu',
      engineCustom: s.browserSearchEngineCustom || '',
      sniffKindsEnabled: s.sniffKinds || ['image', 'doc', 'zip', 'file']
    };
  });

  /** 地址栏输入解析：是网址就补协议，是关键词就交给搜索引擎 */
  ipcMain.handle('browser:resolveUrl', (e, input) => {
    const t = String(input || '').trim();
    if (!t) return '';
    if (looksLikeUrl(t)) {
      return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : 'https://' + t.replace(/^\/+/, '');
    }
    return buildSearchUrl(t, getSettings());
  });

  /* 资源嗅探 */
  ipcMain.handle('sniff:start', async (e, id) => {
    const items = await sniffer.start(id);
    return { running: true, items };
  });
  ipcMain.handle('sniff:stop', (e, id) => ({ running: false, items: sniffer.stop(id) }));
  ipcMain.handle('sniff:list', (e, id) => sniffer.list(id));
  ipcMain.handle('sniff:clear', (e, id) => sniffer.clear(id));
  ipcMain.handle('sniff:scanDom', (e, id) => sniffer.scanDom(id));
  ipcMain.handle('sniff:isRunning', (e, id) => sniffer.isRunning(id));

  ipcMain.handle('sniff:chooseDir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择资源保存文件夹',
      defaultPath: getSettings().outDir || os.homedir(),
      properties: ['openDirectory', 'createDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('sniff:download', async (e, payload) => {
    const p = payload || {};
    const urls = p.urls || [];
    if (!urls.length) throw new Error('没有要下载的资源');

    const base = p.outDir || getSettings().outDir || path.join(os.homedir(), 'Downloads', '特能导导出');
    const outDir = path.join(base, '嗅探资源', exporter.dateStamp());

    let referer = '';
    try {
      const wc = webContents.fromId(Number(p.webContentsId));
      if (wc && !wc.isDestroyed()) referer = wc.getURL();
    } catch (err) { /* ignore */ }

    const r = await sniffer.download(p.webContentsId, urls, outDir, { referer });
    if (r.saved.length) {
      notify('资源下载完成', '成功 ' + r.saved.length + ' 个' + (r.failed.length ? '，失败 ' + r.failed.length + ' 个' : ''), {
        level: r.failed.length ? 'warning' : 'alert'
      });
    }
    return { outDir, saved: r.saved, failed: r.failed };
  });

  /* 剪贴板 */
  ipcMain.handle('clipboard:read', () => {
    try { return clipboard.readText() || ''; } catch (err) { return ''; }
  });
  ipcMain.handle('clipboard:write', (e, text) => {
    try { clipboard.writeText(String(text == null ? '' : text)); return true; } catch (err) { return false; }
  });

  /* 其它 */
  ipcMain.handle('notify:test', () => { notify('特能导通知测试', '这是一条右下角提醒示例'); return true; });
  ipcMain.handle('app:openDevTools', () => { if (mainWindow) mainWindow.webContents.openDevTools({ mode: 'detach' }); });
}

/* ───────────────── 应用生命周期 ───────────────── */
// 名称必须在任何 getPath('userData') 之前设置，保证数据目录为 %APPDATA%\特能导
app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);

app.whenReady().then(async () => {
  fs.mkdirSync(dataDir(), { recursive: true });

  settingsStore = new JsonStore(path.join(dataDir(), 'settings.json'), DEFAULT_SETTINGS);
  if (!settingsStore.get('outDir')) {
    settingsStore.set('outDir', path.join(os.homedir(), 'Downloads', '特能导导出'));
  }
  historyStore = new HistoryStore(path.join(dataDir(), 'history.json'), 3000);

  taskQueue = new TaskQueue({
    getSettings,
    maxHistory: 300,
    storageFile: path.join(dataDir(), 'tasks.json')
  });
  taskQueue.on('update', (t) => sendToRenderer('task:update', t));
  taskQueue.on('finished', (t) => {
    const label =
      t.status === 'done' ? '任务完成' :
      t.status === 'partial' ? '部分完成' :
      t.status === 'canceled' ? '任务已取消' : '任务失败';
    notify(label, t.name + '（成功 ' + t.items.filter((i) => i.status === 'done').length + '/' + t.total + '）', {
      level: t.status === 'failed' ? 'error' : 'alert',
      taskId: t.id
    });
    historyStore.flush();
  });

  // 嗅探结果节流推送，避免高频 IPC 拖慢界面
  const sniffPending = new Map();
  let sniffTimer = null;
  sniffer.on('update', (p) => {
    const cur = sniffPending.get(p.webContentsId) || { added: [], total: p.items.length };
    if (p.added) cur.added.push(p.added);
    cur.total = p.items.length;
    sniffPending.set(p.webContentsId, cur);
    if (sniffTimer) return;
    sniffTimer = setTimeout(() => {
      sniffTimer = null;
      sniffPending.forEach((v, k) => {
        sendToRenderer('sniff:update', { webContentsId: k, total: v.total, added: v.added });
      });
      sniffPending.clear();
    }, 260);
  });

  // 应用插件（Chrome 扩展 + 自定义解析规则）
  try {
    plugins.init({ userData: userDataDir(), getSettings, saveSettings: (patch) => settingsStore.merge(patch) });
    await plugins.applyAll();
  } catch (err) {
    console.warn('[plugins] 初始化失败:', err.message);
  }

  nativeTheme.themeSource = getSettings().theme === 'dark' ? 'dark' : 'light';

  installWindowOpenGuard();
  registerIpc();
  buildAppMenu();
  createMainWindow();
  if (getSettings().minimizeToTray) createTray();

  // 开发自检：--autotest=<场景> 自动跑一遍真实交互链路，用于构建期回归
  const autoTest = (process.argv.find((a) => a.startsWith('--autotest=')) || '').split('=')[1];
  if (autoTest) {
    setTimeout(async () => {
      const js = async (code) => mainWindow.webContents.executeJavaScript(code, true).catch((e) => ({ error: e.message }));
      try {
        if (autoTest === 'browser') {
          const nickname = 'https://mp.weixin.qq.com/s/miz-mUxe97oz2cA-DUW1Ww';
          const step1 = await js(`(async () => {
            window.__tndGo('browser');
            await new Promise(r => setTimeout(r, 400));
            window.__tndVisit(${JSON.stringify(nickname)});
            await new Promise(r => setTimeout(r, 9000));
            const wv = document.querySelector('webview');
            let id = null, url = '', title = '';
            try { id = wv ? wv.getWebContentsId() : null; } catch (e) {}
            try { url = wv ? wv.getURL() : ''; } catch (e) {}
            try { title = wv ? wv.getTitle() : ''; } catch (e) {}
            return { hasWebview: !!wv, webContentsId: id, url, title };
          })()`);
          console.log('[autotest] webview ' + JSON.stringify(step1));

          if (step1 && step1.webContentsId) {
            const r = await parseWebviewPage(step1.webContentsId);
            console.log('[autotest] parse ' + JSON.stringify({
              ok: r && r.ok,
              title: r && r.title,
              author: r && r.author,
              chars: r && r.stats && r.stats.chars,
              images: r && r.stats && r.stats.images,
              reason: r && r.reason
            }));
          }
        }

        if (autoTest === 'sniff') {
          const sniffUrl = (process.argv.find((a) => a.startsWith('--url=')) || '').slice('--url='.length) || 'https://www.ithome.com/';
          const step1 = await js(`(async () => {
            window.__tndGo('browser');
            await new Promise(r => setTimeout(r, 700));
            window.__tndVisit(${JSON.stringify(sniffUrl)});
            await new Promise(r => setTimeout(r, 10000));
            const btn = document.getElementById('bwSniff');
            btn.click();
            await new Promise(r => setTimeout(r, 1500));
            return { sniffing: btn.classList.contains('sniffing'), panelOpen: document.getElementById('sniffPanel').classList.contains('open') };
          })()`);
          console.log('[autotest] sniff-start ' + JSON.stringify(step1));

          // 滚动页面触发更多懒加载资源
          await js(`(async () => {
            const wv = document.querySelector('webview');
            for (let i = 0; i < 5; i++) {
              await wv.executeJavaScript('window.scrollBy(0, window.innerHeight * 0.8)', true).catch(() => {});
              await new Promise(r => setTimeout(r, 900));
            }
            return true;
          })()`);
          await new Promise((r) => setTimeout(r, 4000));

          const stat = await js(`(async () => {
            const wv = document.querySelector('webview');
            const id = wv.getWebContentsId();
            const items = await window.tnd.sniff.list(id);
            const byKind = {};
            items.forEach(i => { byKind[i.kind] = (byKind[i.kind] || 0) + 1; });
            const forbidden = items.filter(i => /\\.(mp4|m3u8|mp3|m4a|wav|flac|mov|avi|webm|aac|ogg|ts)(\\?|#|$)/i.test(i.url));
            return {
              total: items.length,
              byKind,
              forbiddenCount: forbidden.length,
              all: items.map(i => i.kind + ' | ' + i.name),
              rendered: document.querySelectorAll('.sniff-item').length
            };
          })()`);
          console.log('[autotest] sniff-stat ' + JSON.stringify(stat));
        }

        if (autoTest === 'download') {
          const base = process.argv.find((a) => a.startsWith('--base='));
          const b = base ? base.slice('--base='.length) : 'http://127.0.0.1:18766';
          const urls = [
            b + '/files/年度报告.pdf',
            b + '/dl/培训材料.zip',
            b + '/download/预算表.xlsx',
            b + '/dl/subtitle.srt'
          ];

          const finished = new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 120000);
            taskQueue.once('finished', (t) => { clearTimeout(timer); resolve(t); });
          });

          const submitted = await js(`(async () => {
            const t = await window.tnd.task.submit({
              urls: ${JSON.stringify(urls)},
              formats: ['markdown'],
              outDir: ${JSON.stringify(path.join(app.getPath('downloads'), '特能导导出', '_直下自检'))}
            });
            return { id: t.id, total: t.total };
          })()`);
          console.log('[autotest] download-submit ' + JSON.stringify(submitted));

          const task = await finished;
          const rows = task ? task.items.map((i) => ({
            status: i.status,
            name: i.title,
            kind: (i.files[0] || {}).format || '',
            size: (i.files[0] || {}).size || 0,
            path: (i.files[0] || {}).path || '',
            error: i.error || ''
          })) : [];
          console.log('[autotest] download-result ' + JSON.stringify({
            status: task ? task.status : 'timeout',
            finished: task ? task.finished : 0,
            total: task ? task.total : 0,
            rows
          }));
        }

        if (autoTest === 'persist') {
          // 先提交一个任务，然后立刻退出，模拟「应用中途被关掉」
          const before = taskQueue.list().length;
          await js(`(async () => {
            await window.tnd.task.submit({
              urls: ['https://www.ithome.com/0/823/017.htm'],
              formats: ['markdown'],
              outDir: ${JSON.stringify(path.join(app.getPath('downloads'), '特能导导出', '_持久化自检'))}
            });
            return true;
          })()`);
          taskQueue.flush();
          console.log('[autotest] persist-write ' + JSON.stringify({
            before,
            after: taskQueue.list().length,
            file: taskQueue.storageFile,
            exists: fs.existsSync(taskQueue.storageFile)
          }));
        }

        if (autoTest === 'persist-check') {
          const list = taskQueue.list();
          console.log('[autotest] persist-load ' + JSON.stringify({
            total: list.length,
            statuses: list.map((t) => t.status),
            firstItems: list.slice(0, 3).map((t) => ({
              name: t.name,
              status: t.status,
              itemStatuses: (t.items || []).map((i) => i.status),
              formats: t.formats
            }))
          }));
        }

        if (autoTest === 'deep') {
          const deepUrl = (process.argv.find((a) => a.startsWith('--url=')) || '').slice('--url='.length);
          if (!deepUrl) { console.log('[autotest] deep 缺少 --url'); }
          else {
            const r = await extractor.capture(deepUrl, {
              settings: getSettings(),
              flags: {},
              deep: true,
              retries: 0,
              scrollRounds: 1
            });
            console.log('[autotest] deep ' + JSON.stringify({
              ok: r.ok,
              platform: r.platformKey,
              tree: r.tree || null,
              directoryCount: (r.directory || []).length,
              folders: (r.directory || []).filter((d) => d.isFolder).length,
              fileNodes: (r.directory || []).filter((d) => !d.isFolder).length,
              deepCount: (r.sections || []).length,
              paths: (r.sections || []).map((s) => s.path),
              titles: (r.sections || []).map((s) => s.title),
              chars: (r.sections || []).map((s) => (s.text || '').replace(/\s+/g, '').length),
              reason: r.reason || ''
            }));
          }
        }

        if (autoTest === 'linkopen') {
          const winBefore = BrowserWindow.getAllWindows().length;
          const r = await js(`(async () => {
            window.__tndGo('browser');
            await new Promise(r => setTimeout(r, 600));
            window.__tndVisit('https://www.baidu.com/s?wd=%E7%A0%94%E8%B6%A3%E6%95%99%E8%82%B2');
            await new Promise(r => setTimeout(r, 8000));
            const wv = document.querySelector('webview');
            const before = wv.getURL();
            const clicked = await wv.executeJavaScript(
              '(() => { const a = document.querySelector("#content_left h3 a"); if (!a) return null; const u = a.href; a.click(); return u; })()',
              true
            ).catch((e) => 'ERR:' + e.message);
            return { before, clicked };
          })()`);
          await new Promise((r) => setTimeout(r, 7000));
          const winAfter = BrowserWindow.getAllWindows().length;
          const nowUrl = await js(`(() => { const wv = document.querySelector('webview'); return wv ? wv.getURL() : ''; })()`);
          // 判定标准：没有新增窗口 + webview 自身发生了导航 → 说明链接是在应用内打开的
          const navigated = !!nowUrl && nowUrl !== r.before;
          console.log('[autotest] linkopen ' + JSON.stringify({
            windowsBefore: winBefore,
            windowsAfter: winAfter,
            noPopupWindow: winAfter === winBefore,
            clickedUrl: (r.clicked || '').slice(0, 90),
            webviewUrlNow: (nowUrl || '').slice(0, 90),
            navigated,
            openedInside: winAfter === winBefore && navigated
          }));
        }

        if (autoTest === 'tasks') {
          const finished = new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 180000);
            taskQueue.once('finished', (task) => { clearTimeout(timer); resolve(task); });
          });

          const urls = [
            'https://www.ithome.com/0/823/017.htm',
            'https://www.thepaper.cn/newsDetail_forward_31872527'
          ];
          const r = await js(`(async () => {
            const t = await window.tnd.task.submit({
              urls: ${JSON.stringify(urls)},
              formats: ['markdown', 'pdf'],
              outDir: ${JSON.stringify(path.join(app.getPath('downloads'), '特能导导出'))}
            });
            return { id: t.id, total: t.total };
          })()`);
          console.log('[autotest] submit ' + JSON.stringify(r));

          const task = await finished;
          console.log('[autotest] finished ' + JSON.stringify(task ? {
            status: task.status,
            finished: task.finished,
            total: task.total,
            files: task.items.flatMap((i) => i.files || []).map((f) => f.path),
            errors: task.items.map((i) => i.error).filter(Boolean),
            titles: task.items.map((i) => i.title)
          } : null));
        }
      } catch (err) {
        console.log('[autotest] 失败 ' + err.message);
      }
      setTimeout(async () => {
        const shotArg = process.argv.find((a) => a.startsWith('--shot='));
        if (shotArg) {
          try {
            const img = await mainWindow.webContents.capturePage();
            const p = shotArg.slice('--shot='.length);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, img.toPNG());
            console.log('[shot] 已保存 ' + p);
          } catch (e) {
            console.log('[shot] 截图失败 ' + e.message);
          }
        }
        isQuitting = true;
        app.quit();
      }, 2500);
    }, 4000);
  }

  // 开发自检：--shot=<路径> 启动后自动截图并退出（供构建流程做界面回归）
  // 与 --autotest 同时使用时，截图交由 autotest 流程在场景跑完后执行
  const shotArg = process.argv.find((a) => a.startsWith('--shot='));
  if (shotArg && !autoTest) {
    const target = shotArg.slice('--shot='.length);
    const delay = Number((process.argv.find((a) => a.startsWith('--shot-delay=')) || '').split('=')[1]) || 4500;
    const pageArg = (process.argv.find((a) => a.startsWith('--page=')) || '').split('=')[1];
    setTimeout(async () => {
      try {
        if (pageArg) {
          await mainWindow.webContents
            .executeJavaScript(`(async () => { if (window.__tndGo) window.__tndGo(${JSON.stringify(pageArg)}); return true; })()`, true)
            .catch(() => {});
          await new Promise((r) => setTimeout(r, 1400));
        }
        const scrollArg = Number((process.argv.find((a) => a.startsWith('--scroll=')) || '').split('=')[1]) || 0;
        if (scrollArg) {
          await mainWindow.webContents
            .executeJavaScript(`(() => { const m = document.getElementById('main'); if (m) m.scrollTop = ${scrollArg}; return m ? m.scrollTop : 0; })()`, true)
            .catch(() => {});
          await new Promise((r) => setTimeout(r, 500));
        }
        const diag = await mainWindow.webContents.executeJavaScript(`(() => {
          const m = document.getElementById('main');
          const tb = document.querySelector('.titlebar');
          const t = document.querySelector('#page-new .page-title');
          return {
            scrollTop: m.scrollTop, scrollHeight: m.scrollHeight, clientHeight: m.clientHeight,
            titlebar: tb ? Math.round(tb.getBoundingClientRect().bottom) : -1,
            firstTitleTop: t ? Math.round(t.getBoundingClientRect().top) : -1
          };
        })()`, true).catch(() => null);
        console.log('[shot] diag ' + JSON.stringify(diag));
        const img = await mainWindow.webContents.capturePage();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, img.toPNG());
        console.log('[shot] 已保存 ' + target);
      } catch (err) {
        console.error('[shot] 截图失败:', err.message);
      }
      isQuitting = true;
      app.quit();
    }, delay);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  try { settingsStore && settingsStore.flush(); } catch (e) { /* ignore */ }
  try { historyStore && historyStore.flush(); } catch (e) { /* ignore */ }
  try { taskQueue && taskQueue.flush(); } catch (e) { /* ignore */ }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
