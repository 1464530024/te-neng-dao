/* 页面：内置浏览器（地址栏搜索 / 页内打开链接 / 资源嗅探 / 解析当前页） */

import { $, $$, escapeHtml, toast, openDrawer, closeDrawer, bytes } from '../ui.js';
import { state, api } from '../store.js';
import { renderPreview } from './preview.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const FALLBACK_SITES = [
  { name: '百度', url: 'https://www.baidu.com/' },
  { name: 'IMA 知识库', url: 'https://ima.qq.com/' },
  { name: '微信公众号', url: 'https://mp.weixin.qq.com/' },
  { name: '知乎', url: 'https://www.zhihu.com/' },
  { name: '小红书', url: 'https://www.xiaohongshu.com/' }
];

const KIND_NAME = { image: '图片', doc: '文档', zip: '压缩包', file: '文件' };
const KIND_ICON = { image: 'IMG', doc: 'DOC', zip: 'ZIP', file: 'FILE' };
const ALL_KINDS = ['image', 'doc', 'zip', 'file'];

let wv = null;
let lastResult = null;
let meta = null;
let homeLoaded = false;

/* 嗅探状态 */
let sniffRunning = false;
let sniffItems = [];
const sniffSelected = new Set();
const sniffFilter = new Set(ALL_KINDS);
let sniffOutDir = '';

/* ───────── 初始化 ───────── */

export async function initBrowser(ctx) {
  try {
    meta = await api.browser.meta();
  } catch (e) {
    meta = { engines: [], homePresets: FALLBACK_SITES, home: 'https://www.baidu.com/' };
  }

  renderQuickSites();
  bindEvents();
  renderSniffList();

  api.on('browser:open-url', (url) => {
    if (!url) return;
    navigate(url, { raw: true, silent: true });
  });

  api.on('sniff:update', (payload) => {
    if (!wv) return;
    if (Number(payload.webContentsId) !== currentWcId()) return;
    if (Array.isArray(payload.added) && payload.added.length) {
      payload.added.forEach((it) => {
        if (!sniffItems.some((x) => x.url === it.url)) sniffItems.push(it);
      });
      renderSniffList();
    }
  });

  window.__tndVisit = (u) => navigate(u);
}

/** 每次进入该页面时调用 */
export function refreshBrowser() {
  const openHome = state.settings.browserOpenHomeOnStart !== false;
  if (!wv && openHome && !homeLoaded) {
    homeLoaded = true;
    const home = (meta && meta.home) || 'https://www.baidu.com/';
    navigate(home, { raw: true, silent: true });
  }
}

/** 设置页改动首页/搜索引擎后刷新 */
export async function reloadBrowserMeta() {
  try {
    meta = await api.browser.meta();
    renderQuickSites();
  } catch (e) { /* ignore */ }
}

function renderQuickSites() {
  const list = (meta && meta.homePresets && meta.homePresets.length) ? meta.homePresets : FALLBACK_SITES;
  const box = $('#quickSites');
  if (!box) return;
  box.innerHTML = list
    .map((s) => `<button class="quick-site" data-url="${escapeHtml(s.url)}">${escapeHtml(s.name)}</button>`)
    .join('');
}

/* ───────── 事件绑定 ───────── */

function bindEvents() {
  $('#quickSites').addEventListener('click', (e) => {
    const b = e.target.closest('[data-url]');
    if (b) navigate(b.dataset.url, { raw: true });
  });

  const urlInput = $('#bwUrl');
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigate(urlInput.value);
  });
  urlInput.addEventListener('focus', () => urlInput.select());

  $('#bwBack').addEventListener('click', () => { if (wv && wv.canGoBack()) wv.goBack(); });
  $('#bwFwd').addEventListener('click', () => { if (wv && wv.canGoForward()) wv.goForward(); });
  $('#bwReload').addEventListener('click', () => {
    if (!wv) return navigate($('#bwUrl').value);
    if (wv.getURL()) wv.reload();
    else navigate($('#bwUrl').value);
  });

  $('#bwSniff').addEventListener('click', toggleSniff);
  $('#bwParse').addEventListener('click', parseCurrent);

  $('#sniffClose').addEventListener('click', () => $('#sniffPanel').classList.remove('open'));
  $('#sniffRescan').addEventListener('click', rescanDom);
  $('#sniffClear').addEventListener('click', async () => {
    const id = currentWcId();
    if (id) await api.sniff.clear(id);
    sniffItems = [];
    sniffSelected.clear();
    renderSniffList();
  });
  $('#sniffAll').addEventListener('change', (e) => {
    const list = visibleItems();
    if (e.target.checked) list.forEach((i) => sniffSelected.add(i.url));
    else list.forEach((i) => sniffSelected.delete(i.url));
    renderSniffList();
  });
  $('#sniffDownload').addEventListener('click', downloadSelected);
  $('#sniffDir').addEventListener('click', async () => {
    const d = await api.sniff.chooseDir();
    if (d) { sniffOutDir = d; toast({ title: '资源将保存到', text: d, level: 'info', duration: 3200 }); }
  });

  $('#sniffFilters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    const k = b.dataset.kind;
    if (sniffFilter.has(k)) sniffFilter.delete(k);
    else sniffFilter.add(k);
    renderSniffList();
  });

  $('#sniffList').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const url = act.dataset.url;
      if (act.dataset.act === 'copy') {
        await api.clipboard.write(url);
        toast({ title: '已复制链接', level: 'info', duration: 2000 });
      }
      if (act.dataset.act === 'open') api.fs.openExternal(url);
      return;
    }
    const row = e.target.closest('[data-url]');
    if (!row) return;
    const cb = row.querySelector('input[type=checkbox]');
    if (e.target !== cb) cb.checked = !cb.checked;
    if (cb.checked) sniffSelected.add(row.dataset.url);
    else sniffSelected.delete(row.dataset.url);
    row.classList.toggle('on', cb.checked);
    updateSelInfo();
  });
}

/* ───────── 导航 ───────── */

async function navigate(input, opts) {
  const o = opts || {};
  let url = String(input || '').trim();
  if (!url) return;

  if (!o.raw) {
    try {
      url = await api.browser.resolveUrl(url);
    } catch (e) {
      url = /^https?:/i.test(url) ? url : 'https://' + url;
    }
  }
  if (!url) return;

  $('#bwUrl').value = url;
  ensureWebview(url);
}

function ensureWebview(url) {
  const frame = $('#browserFrame');
  const empty = $('#browserEmpty');

  if (!wv) {
    wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:tnd-capture');
    wv.setAttribute('allowpopups', 'false');
    wv.style.flex = '1';
    wv.style.minWidth = '0';
    wv.style.height = '100%';
    wv.style.display = 'flex';
    frame.insertBefore(wv, $('#sniffPanel'));
    bindWebviewEvents();
  }
  if (empty) empty.classList.add('hidden');
  try { wv.setUserAgent(UA); } catch (e) { /* ignore */ }
  wv.src = url;
}

function bindWebviewEvents() {
  const sync = () => {
    try {
      const u = wv.getURL();
      if (u) $('#bwUrl').value = u;
    } catch (e) { /* ignore */ }
  };

  wv.addEventListener('dom-ready', () => {
    sync();
    try { wv.setZoomLevel(0); } catch (e) { /* ignore */ }
  });
  wv.addEventListener('did-navigate', sync);
  wv.addEventListener('did-navigate-in-page', sync);

  wv.addEventListener('page-title-updated', (e) => {
    $('#bwUrl').title = e.title || '';
  });

  wv.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3 || !e.isMainFrame) return;
    toast({ title: '页面加载失败', text: e.errorDescription || String(e.errorCode), level: 'error', duration: 5200 });
  });

  // 兜底：主进程的 setWindowOpenHandler 之外，仍可能走到这里
  wv.addEventListener('new-window', (e) => {
    e.preventDefault();
    if (e.url) navigate(e.url, { raw: true, silent: true });
  });

  wv.addEventListener('did-start-loading', () => $('#bwReload').classList.add('spin'));
  wv.addEventListener('did-stop-loading', () => $('#bwReload').classList.remove('spin'));
}

function currentWcId() {
  if (!wv) return null;
  try {
    return wv.getWebContentsId();
  } catch (e) {
    return null;
  }
}

/* ───────── 嗅探 ───────── */

function updateSniffButton() {
  const btn = $('#bwSniff');
  if (!btn) return;
  const txt = $('#bwSniffText');
  btn.classList.toggle('sniffing', sniffRunning);
  txt.textContent = sniffRunning ? '嗅探中' : '嗅探';
  btn.title = sniffRunning
    ? '正在嗅探，点击停止'
    : '开始嗅探页面中的图片、文档、压缩包等资源（不含视频与音频）';

  const dot = btn.querySelector('.live-dot');
  if (sniffRunning && !dot) {
    const s = document.createElement('span');
    s.className = 'live-dot';
    btn.insertBefore(s, btn.firstChild);
  } else if (!sniffRunning && dot) {
    dot.remove();
  }
  $('#sniffPanel').classList.toggle('live', sniffRunning);
}

async function toggleSniff() {
  if (!wv) {
    toast({ title: '还没有打开网页', text: '先在上方地址栏访问一个网址', level: 'warning' });
    return;
  }
  const id = currentWcId();
  if (!id) {
    toast({ title: '页面尚未就绪', text: '等页面加载完成后再试', level: 'warning' });
    return;
  }

  $('#sniffPanel').classList.add('open');

  if (sniffRunning) {
    await api.sniff.stop(id);
    sniffRunning = false;
    updateSniffButton();
    toast({ title: '已停止嗅探', text: '共收集 ' + sniffItems.length + ' 个资源', level: 'info', duration: 3200 });
    return;
  }

  const btn = $('#bwSniff');
  btn.disabled = true;
  try {
    const r = await api.sniff.start(id);
    sniffRunning = true;
    sniffItems = (r && r.items) || [];
    renderSniffList();
    updateSniffButton();
    toast({
      title: '开始嗅探',
      text: '正在收集图片、文档、压缩包等资源（已排除视频与音频）',
      level: 'info',
      duration: 4600
    });
  } catch (err) {
    toast({ title: '嗅探启动失败', text: err.message, level: 'error', duration: 6000 });
  } finally {
    btn.disabled = false;
  }
}

async function rescanDom() {
  const id = currentWcId();
  if (!id) return;
  try {
    await api.sniff.scanDom(id);
    sniffItems = (await api.sniff.list(id)) || [];
    renderSniffList();
    toast({ title: '已重新扫描页面资源', text: '当前共 ' + sniffItems.length + ' 个', level: 'info', duration: 3000 });
  } catch (err) {
    toast({ title: '扫描失败', text: err.message, level: 'error' });
  }
}

function visibleItems() {
  return sniffItems.filter((i) => sniffFilter.has(i.kind));
}

function renderSniffFilters() {
  const box = $('#sniffFilters');
  if (!box) return;
  box.innerHTML = ALL_KINDS.map((k) => {
    const n = sniffItems.filter((i) => i.kind === k).length;
    return `<button class="sniff-filter ${sniffFilter.has(k) ? 'on' : ''}" data-kind="${k}">
      ${KIND_NAME[k]}<span class="n">${n}</span>
    </button>`;
  }).join('');
}

function renderSniffList() {
  const host = $('#sniffList');
  if (!host) return;

  $('#sniffCount').textContent = String(sniffItems.length);
  renderSniffFilters();

  const list = visibleItems();
  if (!list.length) {
    host.innerHTML = `
      <div class="empty" style="padding:34px 16px">
        <div class="ico" style="width:50px;height:50px;border-radius:15px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12h3l2.5-6 3 12 2.5-7 2 4h5"/></svg>
        </div>
        <h3 style="font-size:13px">${sniffRunning ? '正在等待资源…' : '暂无资源'}</h3>
        <p class="small">${sniffRunning
          ? '页面新加载的图片、文档、压缩包会实时出现在这里。<br>也可以点右上角 ↻ 重新扫描当前页面。'
          : '点上方「嗅探」按钮开始收集。<br>只收集图片、文档、压缩包等文件，不包含视频和音频。'}</p>
      </div>`;
    updateSelInfo();
    return;
  }

  host.innerHTML = list.map((it) => {
    const on = sniffSelected.has(it.url);
    const thumb = it.kind === 'image'
      ? `<img src="${escapeHtml(it.url)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.parentNode.innerHTML='<span class=\\'ficon\\'>IMG</span>'">`
      : `<span class="ficon k-${it.kind}">${KIND_ICON[it.kind] || 'FILE'}</span>`;
    return `
      <div class="sniff-item ${on ? 'on' : ''}" data-url="${escapeHtml(it.url)}">
        <label class="check" style="padding:0"><input type="checkbox" ${on ? 'checked' : ''}></label>
        <div class="sniff-thumb">${thumb}</div>
        <div class="sniff-main">
          <div class="sniff-name" title="${escapeHtml(it.url)}">${escapeHtml(it.name || it.url)}</div>
          <div class="sniff-sub">
            <span class="sniff-kind k-${it.kind}">${KIND_NAME[it.kind] || '文件'}</span>
            ${it.size ? `<span>${bytes(it.size)}</span>` : ''}
          </div>
        </div>
        <div class="sniff-acts">
          <button class="btn btn-icon sm btn-ghost" data-act="copy" data-url="${escapeHtml(it.url)}" title="复制链接">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" width="13" height="13"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>
          </button>
          <button class="btn btn-icon sm btn-ghost" data-act="open" data-url="${escapeHtml(it.url)}" title="用系统浏览器打开">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" width="13" height="13"><path d="M14 4h6v6M20 4l-8 8"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');

  updateSelInfo();
}

function updateSelInfo() {
  const n = sniffSelected.size;
  const info = $('#sniffSelInfo');
  if (info) info.textContent = '已选 ' + n;
  const dl = $('#sniffDownload');
  if (dl) dl.disabled = n === 0;
  const all = $('#sniffAll');
  const vis = visibleItems();
  if (all) all.checked = vis.length > 0 && vis.every((i) => sniffSelected.has(i.url));
}

async function downloadSelected() {
  const urls = Array.from(sniffSelected);
  if (!urls.length) return;

  const btn = $('#sniffDownload');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '下载中…';

  try {
    const r = await api.sniff.download({
      webContentsId: currentWcId(),
      urls,
      outDir: sniffOutDir || undefined
    });
    const okN = r.saved.length;
    const failN = r.failed.length;
    toast({
      title: '资源下载完成',
      text: `成功 ${okN} 个${failN ? '，失败 ' + failN + ' 个' : ''}　保存到 ${r.outDir}`,
      level: failN ? 'warning' : 'success',
      duration: 8000,
      onClick: () => api.fs.openPath(r.outDir)
    });
    if (failN) console.warn('未下载成功：', r.failed);
  } catch (err) {
    toast({ title: '下载失败', text: err.message, level: 'error', duration: 6000 });
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ───────── 解析当前页 ───────── */

async function parseCurrent() {
  if (!wv) {
    toast({ title: '还没有打开网页', text: '先在上方地址栏输入网址并回车', level: 'warning' });
    return;
  }
  const id = currentWcId();
  if (!id) {
    toast({ title: '页面尚未就绪', text: '等页面加载完成后再试', level: 'warning' });
    return;
  }

  const btn = $('#bwParse');
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.textContent = '解析中…';

  try {
    const result = await api.extract.webview({
      webContentsId: id,
      platform: 'auto',
      scrollRounds: 2,
      expandAll: true
    });
    lastResult = result;

    if (!result || !result.ok) {
      toast({ title: '解析失败', text: (result && result.reason) || '未知错误', level: 'error', duration: 8000 });
      return;
    }

    renderPreview(result, { others: 0 });
    $('#drawerSave').onclick = saveCurrent;
    openDrawer();
    toast({
      title: '解析成功',
      text: result.title + '（' + ((result.stats && result.stats.chars) || 0) + ' 字）',
      level: 'success',
      duration: 3600
    });
  } catch (err) {
    toast({ title: '解析失败', text: err.message, level: 'error', duration: 6000 });
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

async function saveCurrent() {
  if (!lastResult || !lastResult.ok) return;
  const btn = $('#drawerSave');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '正在导出…';
  try {
    const r = await api.extract.save({
      result: lastResult,
      formats: state.settings.formats,
      outDir: state.settings.outDir,
      pageSize: state.settings.pageSize
    });
    toast({
      title: '导出完成',
      text: r.record.files.length + ' 个文件已保存',
      level: 'success',
      duration: 5600,
      onClick: () => r.record.files[0] && api.fs.showItem(r.record.files[0].path)
    });
    closeDrawer();
  } catch (err) {
    toast({ title: '导出失败', text: err.message, level: 'error' });
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}
