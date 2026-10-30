/* 页面：设置 */

import { $, $$, escapeHtml, toast, confirmDialog } from '../ui.js';
import { state, api } from '../store.js';
import { reloadBrowserMeta } from './browser.js';

let bound = false;
let onChange = null;
let browserMeta = null;

const SNIFF_KIND_LABEL = { image: '图片', doc: '文档', zip: '压缩包', file: '其他文件' };

export function initSettings(ctx) {
  onChange = async (patch) => {
    state.settings = await api.settings.save(patch);
  };

  $('#btnSetOutDir').addEventListener('click', async () => {
    const dir = await api.fs.chooseDir(state.settings.outDir);
    if (!dir) return;
    await onChange({ outDir: dir });
    refreshSettings();
    toast({ title: '默认导出目录已更新', text: dir, level: 'info', duration: 3200 });
  });

  bind('#setFileNameTpl', 'fileNameTemplate', 'input');
  bind('#setPageSize', 'pageSize');
  bind('#setGroupPlatform', 'groupByPlatform', 'checkbox');
  bind('#setGroupDate', 'groupByDate', 'checkbox');
  bind('#setConcurrency', 'concurrency', 'number');
  bind('#setTimeout', 'timeout', 'number');
  bind('#setRetry', 'autoRetry', 'number');
  bind('#setUA', 'userAgentMode');
  bind('#setCustomUA', 'customUA', 'input');
  bind('#setProxyEnabled', 'proxyEnabled', 'checkbox');
  bind('#setProxyRules', 'proxyRules', 'input');
  bind('#setNotifyBadge', 'notifyBadge', 'checkbox');
  bind('#setNotifySound', 'notifySound', 'checkbox');
  bind('#setTray', 'minimizeToTray', 'checkbox');

  $('#setTheme').addEventListener('change', async (e) => {
    await onChange({ theme: e.target.value });
    document.documentElement.style.colorScheme = e.target.value === 'dark' ? 'dark' : 'light';
    toast({ title: '主题已切换', text: e.target.value === 'dark' ? '深色（跟随系统）' : '浅色', level: 'info', duration: 2600 });
  });

  $('#setProxyEnabled').addEventListener('change', () => refreshSettings());
  $('#setUA').addEventListener('change', () => refreshSettings());

  $('#btnTestNotify').addEventListener('click', async () => {
    await api.notify.test();
  });

  $('#btnOpenData').addEventListener('click', () => api.fs.openPath(state.info.userData));

  $('#btnClearCache').addEventListener('click', async () => {
    await api.session.clear('cache');
    toast({ title: '缓存已清除', level: 'success', duration: 2600 });
  });

  $('#btnClearLogin').addEventListener('click', async () => {
    const ok = await confirmDialog('清除所有平台的登录状态？', '内置浏览器与后台抓取共用的 Cookie 将被清空，之后需要重新登录各平台。', '清除');
    if (!ok) return;
    await api.session.clear('all');
    refreshSessionInfo();
    toast({ title: '登录状态已清除', level: 'success', duration: 3200 });
  });

  $('#btnResetSettings').addEventListener('click', async () => {
    const ok = await confirmDialog('恢复默认设置？', '不会影响历史记录和已导出的文件。', '恢复');
    if (!ok) return;
    state.settings = await api.settings.reset();
    refreshSettings();
    toast({ title: '已恢复默认设置', level: 'success' });
  });

  $('#btnDevTools').addEventListener('click', () => api.app.devTools());

  bound = true;
}

function setNested(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function bind(sel, key, kind) {
  const el = $(sel);
  if (!el) return;
  const ev = kind === 'input' ? 'input' : 'change';
  el.addEventListener(ev, async () => {
    let v;
    if (kind === 'checkbox') v = el.checked;
    else if (kind === 'number') v = Number(el.value);
    else v = el.value;
    const patch = {};
    setNested(patch, key, v);
    await onChange(patch);
  });
}

export async function refreshSettings() {
  const s = state.settings;
  $('#setOutDir').value = s.outDir || state.info.defaultOutDir || '';
  $('#setFileNameTpl').value = s.fileNameTemplate || '{title}';
  $('#setPageSize').value = s.pageSize || 'A4';
  $('#setGroupPlatform').checked = s.groupByPlatform !== false;
  $('#setGroupDate').checked = !!s.groupByDate;
  $('#setConcurrency').value = String(s.concurrency || 3);
  $('#setTimeout').value = String(s.timeout || 60000);
  $('#setRetry').value = String(s.autoRetry === undefined ? 1 : s.autoRetry);
  $('#setUA').value = s.userAgentMode || 'auto';
  $('#setCustomUA').value = s.customUA || '';
  $('#setProxyEnabled').checked = !!s.proxyEnabled;
  $('#setProxyRules').value = s.proxyRules || '';
  $('#setNotifyBadge').checked = s.notifyBadge !== false;
  $('#setNotifySound').checked = s.notifySound !== false;
  $('#setTray').checked = !!s.minimizeToTray;
  $('#setTheme').value = s.theme || 'light';

  $('#customUAField').classList.toggle('hidden', $('#setUA').value !== 'custom');
  $('#proxyField').classList.toggle('hidden', !$('#setProxyEnabled').checked);

  // 同步到链接导出页
  $('#outDirInput').value = s.outDir || state.info.defaultOutDir || '';
  $('#optGroupPlatform').checked = s.groupByPlatform !== false;
  $('#optPreview').checked = s.previewBeforeExport !== false;

  refreshSessionInfo();
}

async function refreshSessionInfo() {
  try {
    const i = await api.session.info();
    $('#cookieInfo').innerHTML = i.cookieCount
      ? `　当前已保存 <b>${i.cookieCount}</b> 条登录凭证。`
      : '　当前没有保存任何登录凭证。';
  } catch (e) { /* ignore */ }
}

/* ───────────────── 内置浏览器设置 ───────────────── */

export async function initBrowserSettings(ctx) {
  const save = async (patch) => {
    state.settings = await api.settings.save(patch);
    await reloadBrowserMeta();
  };

  try {
    browserMeta = await api.browser.meta();
  } catch (e) {
    browserMeta = { engines: [], homePresets: [] };
  }

  // 搜索引擎下拉
  const engineSel = $('#setSearchEngine');
  engineSel.innerHTML = (browserMeta.engines || [])
    .map((e) => `<option value="${escapeHtml(e.key)}">${escapeHtml(e.name)}${e.overseas ? '（需可访问）' : ''}</option>`)
    .join('');

  // 首页预设下拉
  const presetSel = $('#setBrowserHomePreset');
  presetSel.innerHTML = '<option value="">常用站点…</option>' +
    (browserMeta.homePresets || [])
      .map((p) => `<option value="${escapeHtml(p.url)}">${escapeHtml(p.name)}</option>`)
      .join('');

  presetSel.addEventListener('change', async () => {
    const url = presetSel.value;
    if (!url) return;
    $('#setBrowserHome').value = url;
    await save({ browserHomeUrl: url });
    toast({ title: '默认首页已设为', text: url, level: 'info', duration: 2600 });
    presetSel.value = '';
  });

  $('#setBrowserHome').addEventListener('change', async () => {
    const v = $('#setBrowserHome').value.trim();
    await save({ browserHomeUrl: v });
    toast({ title: '默认首页已更新', text: v || '（空白页）', level: 'info', duration: 2600 });
  });

  $('#setBrowserOpenHome').addEventListener('change', (e) => save({ browserOpenHomeOnStart: e.target.checked }));

  engineSel.addEventListener('change', async () => {
    await save({ browserSearchEngine: engineSel.value });
    refreshBrowserSettings();
  });

  $('#setSearchEngineCustom').addEventListener('change', () =>
    save({ browserSearchEngineCustom: $('#setSearchEngineCustom').value.trim() })
  );

  // 搜索测试
  $('#testSearchInput').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const kw = $('#testSearchInput').value.trim();
    if (!kw) return;
    const url = await api.browser.resolveUrl(kw);
    $('#testSearchResult').textContent = '将打开：' + url;
  });

  // 嗅探类型
  renderSniffKinds();
  $('#sniffKindBox').addEventListener('change', async () => {
    const kinds = $$('#sniffKindBox input:checked').map((el) => el.value);
    await save({ sniffKinds: kinds });
  });
}

function renderSniffKinds() {
  const box = $('#sniffKindBox');
  if (!box) return;
  const enabled = new Set(state.settings.sniffKinds || ['image', 'doc', 'zip', 'file']);
  box.innerHTML = Object.keys(SNIFF_KIND_LABEL)
    .map((k) => `<label class="check"><input type="checkbox" value="${k}" ${enabled.has(k) ? 'checked' : ''}><span>${SNIFF_KIND_LABEL[k]}</span></label>`)
    .join('');
}

export function refreshBrowserSettings() {
  const s = state.settings;
  $('#setBrowserHome').value = s.browserHomeUrl || 'https://www.baidu.com/';
  $('#setBrowserOpenHome').checked = s.browserOpenHomeOnStart !== false;
  $('#setSearchEngine').value = s.browserSearchEngine || 'baidu';
  $('#setSearchEngineCustom').value = s.browserSearchEngineCustom || '';
  $('#customEngineField').classList.toggle('hidden', $('#setSearchEngine').value !== 'custom');
  renderSniffKinds();
  $('#testSearchResult').textContent = '';
}
