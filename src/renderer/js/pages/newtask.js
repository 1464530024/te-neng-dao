/* 页面：链接导出 */

import { $, $$, escapeHtml, toast, openDrawer, closeDrawer } from '../ui.js';
import { state, api } from '../store.js';
import { renderPreview } from './preview.js';

const FORMATS = [
  { key: 'pdf', name: 'PDF', desc: '版式与网页一致，适合存档与打印' },
  { key: 'markdown', name: 'Markdown', desc: '纯文本结构化，适合二次编辑与入库' },
  { key: 'docx', name: 'Word', desc: '可编辑文档，保留标题层级与表格' },
  { key: 'html', name: 'HTML', desc: '带样式单文件，图片已内嵌' },
  { key: 'txt', name: 'TXT', desc: '纯文本正文，体积最小、兼容性最好' },
  { key: 'json', name: 'JSON', desc: '结构化数据（标题/作者/大纲/正文），适合喂给 AI' },
  { key: 'csv', name: 'CSV 清单', desc: '多篇文档的标题、字数、目录层级汇总成一张表' }
];

/* 平台判定规则（与主进程 constants 保持一致，前端本地跑以获得零延迟反馈） */
const PLATFORM_RULES = [
  { key: 'ima', short: 'IMA', accent: '#2f7cf6', re: /ima\.qq\.com|ima\.copilot|imatool/i, login: true },
  { key: 'wechat', short: '公众号', accent: '#07c160', re: /mp\.weixin\.qq\.com/i },
  { key: 'zhihu', short: '知乎', accent: '#0084ff', re: /zhihu\.com/i },
  { key: 'xiaohongshu', short: '小红书', accent: '#ff2442', re: /xiaohongshu\.com|xhslink\.com/i, login: true },
  {
    key: 'news', short: '新闻', accent: '#e8453c',
    re: /thepaper|xinhuanet|news\.cn|people\.com|163\.com|sina|toutiao|jiemian|36kr|ifeng|cctv|chinanews|huanqiu|guancha|caixin|yicai|stcn|sohu|baijiahao|ithome|cnbeta|geekpark|qq\.com/i
  }
];

/* 指向文件的链接 */
const FILE_EXT_KIND = {
  archive: { short: '压缩包', accent: '#d98207', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'] },
  document: {
    short: '文档', accent: '#0b5bc4',
    exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'tsv', 'rtf', 'epub', 'mobi', 'json', 'xml', 'pages', 'numbers', 'key', 'wps', 'et', 'dps']
  },
  file: {
    short: '文件', accent: '#7b879a',
    exts: ['exe', 'msi', 'apk', 'ipa', 'dmg', 'pkg', 'deb', 'rpm', 'iso', 'psd', 'ai', 'sketch', 'fig', 'srt', 'ass', 'vtt', 'lrc', 'torrent', 'sql', 'db', 'bin', 'dat', 'ttf', 'otf']
  }
};

const FILE_EXT_INDEX = (() => {
  const m = {};
  Object.keys(FILE_EXT_KIND).forEach((k) => FILE_EXT_KIND[k].exts.forEach((e) => { m[e] = k; }));
  return m;
})();

let selectedFormats = new Set(['pdf', 'markdown', 'docx']);
let lastPreview = null;
let busy = false;

/* ───────── 初始化 ───────── */

export function initNewTask(ctx) {
  renderFormats();
  resetLinkList();

  $('#btnPaste').addEventListener('click', pasteFromClipboard);
  $('#btnClearUrls').addEventListener('click', () => { resetLinkList(); toast({ title: '已清空', level: 'info', duration: 1600 }); });
  $('#btnDemo').addEventListener('click', () => {
    setLinks([
      'https://mp.weixin.qq.com/s/xxxxxxxxxxxxxxxx',
      'https://www.zhihu.com/question/12345678/answer/87654321',
      'https://www.xiaohongshu.com/explore/xxxxxxxxxxxx'
    ]);
  });

  $('#btnFmtAll').addEventListener('click', () => {
    const all = selectedFormats.size === FORMATS.length;
    selectedFormats = new Set(all ? [] : FORMATS.map((f) => f.key));
    renderFormats();
  });

  $('#btnChooseDir').addEventListener('click', async () => {
    const dir = await api.fs.chooseDir($('#outDirInput').value);
    if (!dir) return;
    $('#outDirInput').value = dir;
    await api.settings.save({ outDir: dir });
    state.settings.outDir = dir;
    toast({ title: '导出目录已更新', text: dir, level: 'info', duration: 2600 });
  });

  $('#btnOpenDir').addEventListener('click', async () => {
    const dir = $('#outDirInput').value;
    if (!dir) return;
    const r = await api.fs.openPath(dir);
    if (r) toast({ title: '打开目录失败', text: r, level: 'error' });
  });

  $('#btnStart').addEventListener('click', startExport);
  $('#btnQuickParse').addEventListener('click', () => quickParse());

  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerMask').addEventListener('click', closeDrawer);
  $('#drawerSave').addEventListener('click', saveOne);
  $('#drawerCopyMd').addEventListener('click', copyText);

  $('#optGroupPlatform').addEventListener('change', (e) => api.settings.save({ groupByPlatform: e.target.checked }));
  $('#optPreview').addEventListener('change', (e) => api.settings.save({ previewBeforeExport: e.target.checked }));
}

export function refreshNewTask() {
  renderFormats();
  $('#outDirInput').value = state.settings.outDir || state.info.defaultOutDir || '';
}

/* ───────── 链接分行输入 ───────── */

function getRows() {
  return $$('.link-row', $('#linkList'));
}

function getInputs() {
  return getRows().map((r) => r.querySelector('.link-input'));
}

/** 收集所有非空链接（去重保序） */
function collectLinks() {
  const seen = new Set();
  const out = [];
  getInputs().forEach((i) => {
    const v = i.value.trim();
    if (!v) return;
    const key = v.replace(/\/$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  });
  return out;
}

function resetLinkList() {
  const host = $('#linkList');
  host.innerHTML = '';
  host.appendChild(createRow(''));
  updateCount();
  focusLastEmpty();
}

function createRow(url) {
  const row = document.createElement('div');
  row.className = 'link-row';
  row.innerHTML = `
    <input class="link-input" placeholder="粘贴链接…（也可一次粘贴多条，会自动分行）" spellcheck="false">
    <span class="link-type">待识别</span>
    <button class="link-del" title="删除这一条">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  `;

  const input = row.querySelector('.link-input');
  const typeEl = row.querySelector('.link-type');
  const del = row.querySelector('.link-del');

  input.value = url || '';
  applyLabel(row, typeEl, input.value);

  input.addEventListener('input', () => {
    applyLabel(row, typeEl, input.value);
    ensureTrailingEmpty(row);
    updateCount();
  });

  input.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text') || '';
    const urls = parseUrls(text);
    if (urls.length > 1) {
      e.preventDefault();
      fillRowsFrom(row, urls);
      return;
    }
    // 单条也延迟一下，等默认粘贴完成后再判定类型
    setTimeout(() => {
      applyLabel(row, typeEl, input.value);
      ensureTrailingEmpty(row);
      updateCount();
    }, 30);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { startExport(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      ensureTrailingEmpty(row, true);
      focusNext(row);
    }
  });

  del.addEventListener('click', () => removeRow(row));

  return row;
}

function ensureTrailingEmpty(fromRow, force) {
  const rows = getRows();
  const last = rows[rows.length - 1];
  const lastInput = last.querySelector('.link-input');

  if (lastInput.value.trim() && (last === fromRow || force)) {
    if (!lastInput.value.trim()) return;
    const fresh = createRow('');
    $('#linkList').appendChild(fresh);
  } else if (!lastInput.value.trim() && last !== fromRow && getInputs().filter((i) => !i.value.trim()).length > 1) {
    // 中间行被清空后，若末尾还有多个空行，收敛到一个
    const empties = rows.filter((r) => !r.querySelector('.link-input').value.trim());
    if (empties.length > 1) empties.slice(0, empties.length - 1).forEach((r) => removeRow(r, true));
  }
}

function fillRowsFrom(row, urls) {
  const host = $('#linkList');
  const input = row.querySelector('.link-input');
  const typeEl = row.querySelector('.link-type');

  input.value = urls[0] || '';
  applyLabel(row, typeEl, input.value);

  let cursor = row;
  urls.slice(1).forEach((u) => {
    const fresh = createRow(u);
    cursor.after(fresh);
    cursor = fresh;
  });

  const tail = createRow('');
  cursor.after(tail);
  updateCount();
  focusLastEmpty();
}

function removeRow(row, silent) {
  const host = $('#linkList');
  const rows = getRows();
  if (rows.length <= 1) {
    row.querySelector('.link-input').value = '';
    applyLabel(row, row.querySelector('.link-type'), '');
    updateCount();
    return;
  }
  row.style.transition = 'opacity .18s, transform .18s';
  row.style.opacity = '0';
  row.style.transform = 'translateX(-8px)';
  setTimeout(() => {
    row.remove();
    const left = getRows();
    if (!left.length) { host.appendChild(createRow('')); }
    else if (!left[left.length - 1].querySelector('.link-input').value.trim()
             && left.filter((r) => !r.querySelector('.link-input').value.trim()).length > 1) {
      // 收敛多余空行
      left.filter((r) => !r.querySelector('.link-input').value.trim()).slice(0, -1).forEach((r) => r.remove());
    }
    updateCount();
    if (!silent) focusLastEmpty();
  }, 180);
}

function focusLastEmpty() {
  const inputs = getInputs();
  for (let i = inputs.length - 1; i >= 0; i -= 1) {
    if (!inputs[i].value.trim()) { inputs[i].focus(); return; }
  }
}

function focusNext(row) {
  const rows = getRows();
  const i = rows.indexOf(row);
  const next = rows[i + 1] || rows[rows.length - 1];
  const inp = next.querySelector('.link-input');
  inp.focus();
}

function updateCount() {
  const n = collectLinks().length;
  $('#urlCount').textContent = n ? `已识别 ${n} 条` : '已识别 0 条';
}

/** 判断一个链接的类型（本地零延迟） */
function labelOf(url) {
  const v = String(url || '').trim();
  if (!v || !/^https?:/i.test(v)) return null;

  const clean = v.split('#')[0].split('?')[0];
  const m = clean.match(/\.([a-z0-9]{1,6})$/i);
  if (m) {
    const kind = FILE_EXT_INDEX[m[1].toLowerCase()];
    if (kind) {
      const t = FILE_EXT_KIND[kind];
      return { text: t.short + ' · ' + m[1].toUpperCase(), accent: t.accent, isFile: true };
    }
  }

  for (const p of PLATFORM_RULES) {
    if (p.re.test(v)) return { text: p.short, accent: p.accent, isFile: false, login: !!p.login };
  }
  return { text: '网页', accent: '#5b6472', isFile: false };
}

function applyLabel(row, typeEl, value) {
  const v = String(value || '').trim();
  const info = labelOf(v);

  row.classList.toggle('filled', !!v);
  row.classList.remove('bad');

  if (!v) {
    typeEl.textContent = '待识别';
    typeEl.className = 'link-type';
    typeEl.style.background = '';
    typeEl.style.color = '';
    return;
  }

  if (!info) {
    typeEl.textContent = '非链接';
    typeEl.className = 'link-type err';
    typeEl.style.background = '';
    typeEl.style.color = '';
    row.classList.add('bad');
    return;
  }

  typeEl.textContent = info.text + (info.login ? ' *' : '');
  typeEl.title = info.login ? '该平台通常需要先在内置浏览器登录' : info.text;
  typeEl.className = 'link-type on';
  typeEl.style.background = info.accent;
  typeEl.style.color = '#fff';
}

/** 从任意文本里抽出 http(s) 链接 */
function parseUrls(text) {
  const re = /https?:\/\/[^\s"'<>）)】\]，,、；;]+/gi;
  const found = String(text || '').match(re) || [];
  const seen = new Set();
  const out = [];
  found.forEach((u) => {
    const c = u.replace(/[.,;:!?。，、；：！？]+$/, '');
    const k = c.replace(/\/$/, '');
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  });
  return out;
}

/** 批量写入（示例数据 / 剪贴板） */
function setLinks(urls) {
  const host = $('#linkList');
  host.innerHTML = '';
  urls.forEach((u) => host.appendChild(createRow(u)));
  host.appendChild(createRow(''));
  updateCount();
}

async function pasteFromClipboard() {
  try {
    const text = await api.clipboard.read();
    if (!text) return toast({ title: '剪贴板是空的', level: 'warning' });

    const urls = parseUrls(text);
    if (!urls.length) return toast({ title: '剪贴板里没有找到链接', level: 'warning' });

    const existing = collectLinks();
    const merged = existing.concat(urls.filter((u) => !existing.includes(u)));
    setLinks(merged);
    toast({ title: '已读取剪贴板', text: '新增 ' + (merged.length - existing.length) + ' 条链接', level: 'info', duration: 2800 });
  } catch (err) {
    toast({ title: '读取剪贴板失败', text: err.message, level: 'error' });
  }
}

/* ───────── 格式 ───────── */

function renderFormats() {
  const grid = $('#fmtGrid');
  if (!grid) return;
  grid.innerHTML = FORMATS.map((f) => `
    <button class="fmt-card ${selectedFormats.has(f.key) ? 'on' : ''}" data-fmt="${f.key}">
      <div class="fmt-name"><span class="tick"></span>${escapeHtml(f.name)}</div>
      <div class="fmt-desc">${escapeHtml(f.desc)}</div>
    </button>
  `).join('');

  $$('.fmt-card', grid).forEach((card) => {
    card.addEventListener('click', () => {
      const k = card.dataset.fmt;
      if (selectedFormats.has(k)) selectedFormats.delete(k);
      else selectedFormats.add(k);
      renderFormats();
    });
  });
}

/* ───────── 导出 ───────── */

async function startExport() {
  if (busy) return;
  const links = collectLinks();

  if (!links.length) {
    toast({ title: '还没有链接', text: '先粘贴至少一条链接', level: 'warning' });
    focusLastEmpty();
    return;
  }
  if (!selectedFormats.size) {
    toast({ title: '至少选择一种导出格式', level: 'warning' });
    return;
  }

  if ($('#optPreview').checked) {
    await quickParse(true);
    return;
  }
  await submitAll(links);
}

async function submitAll(links) {
  const list = links || collectLinks();
  if (!list.length) return;

  busy = true;
  $('#btnStart').disabled = true;
  try {
    const task = await api.task.submit({
      urls: list,
      formats: Array.from(selectedFormats),
      outDir: $('#outDirInput').value,
      options: {
        scrollRounds: $('#optScroll').checked ? undefined : 0,
        expandAll: $('#optScroll').checked
      },
      deep: $('#optDeep').checked
    });
    toast({ title: '已加入任务队列', text: task.name, level: 'info', duration: 3600 });
    resetLinkList();
    // 提交后自动切到任务中心，让用户立刻看到进度
    window.__tndGo && window.__tndGo('tasks');
  } catch (err) {
    toast({ title: '提交失败', text: err.message, level: 'error' });
  } finally {
    busy = false;
    $('#btnStart').disabled = false;
  }
}

/* ───────── 预览 ───────── */

async function quickParse() {
  const links = collectLinks();
  if (!links.length) {
    toast({ title: '还没有链接', level: 'warning' });
    return;
  }
  const target = links[0];
  const d = toast({ title: '正在解析…', text: target, level: 'info', duration: 0 });

  try {
    const result = await api.extract.preview({
      url: target,
      deep: $('#optDeep').checked,
      scrollRounds: $('#optScroll').checked ? 3 : 0,
      expandAll: $('#optScroll').checked
    });
    d.close();
    lastPreview = result;

    if (!result || !result.ok) {
      toast({ title: '解析失败', text: (result && result.reason) || '未知错误', level: 'error', duration: 8000 });
      return;
    }

    renderPreview(result, {
      others: links.length - 1,
      onSaveAll: () => { closeDrawer(); submitAll(links); }
    });
    openDrawer();
  } catch (err) {
    d.close();
    toast({ title: '解析失败', text: err.message, level: 'error', duration: 7000 });
  }
}

async function saveOne() {
  if (!lastPreview || !lastPreview.ok) return;
  const btn = $('#drawerSave');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '正在导出…';
  try {
    const r = await api.extract.save({
      result: lastPreview,
      formats: Array.from(selectedFormats),
      outDir: $('#outDirInput').value,
      pageSize: state.settings.pageSize
    });
    toast({
      title: '导出完成',
      text: r.record.title + '　共 ' + r.record.files.length + ' 个文件',
      level: 'success',
      duration: 6000,
      onClick: () => r.record.files[0] && api.fs.showItem(r.record.files[0].path)
    });
    closeDrawer();
  } catch (err) {
    toast({ title: '导出失败', text: err.message, level: 'error', duration: 6000 });
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function copyText() {
  const text = $('#drawerBody').innerText || '';
  if (!text.trim()) return;
  await api.clipboard.write(text);
  toast({ title: '已复制预览内容', level: 'success', duration: 2400 });
}
