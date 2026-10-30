/* 页面：历史记录 */

import { $, $$, escapeHtml, toast, formatTime, emptyState, fileBaseName, confirmDialog } from '../ui.js';
import { state, api, platformAccent } from '../store.js';

export function initHistory(ctx) {
  $('#histSearch').addEventListener('input', () => renderHistory());
  $('#histFilter').addEventListener('change', () => renderHistory());

  $('#btnHistCsv').addEventListener('click', async () => {
    const p = await api.history.exportCsv(null);
    if (p) toast({ title: '历史记录已导出', text: p, level: 'success', duration: 5000, onClick: () => api.fs.showItem(p) });
  });

  $('#btnHistClear').addEventListener('click', async () => {
    const ok = await confirmDialog('清空全部历史记录？', '只删除记录列表，已经导出到磁盘的文件不会被删除。', '清空');
    if (!ok) return;
    state.history = await api.history.clear();
    $('#sideCount').textContent = '0';
    renderHistory();
    toast({ title: '历史记录已清空', level: 'info' });
  });

  $('#histList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;

    if (act === 'open') api.fs.openPath(btn.dataset.path);
    if (act === 'show') api.fs.showItem(btn.dataset.path);
    if (act === 'dir') api.fs.openPath(btn.dataset.dir);
    if (act === 'url') api.fs.openExternal(btn.dataset.url);
    if (act === 'del') {
      state.history = await api.history.remove(id);
      $('#sideCount').textContent = String(state.history.length);
      renderHistory();
    }
  });
}

function fmtLabel(f) {
  const map = { pdf: 'PDF', markdown: 'MD', docx: 'Word', word: 'Word', html: 'HTML' };
  return map[f] || (f || '').toUpperCase();
}

export function renderHistory() {
  const host = $('#histList');
  if (!host) return;

  // 平台筛选项
  const sel = $('#histFilter');
  const cur = sel.value;
  const names = Array.from(new Set((state.history || []).map((h) => h.platformName).filter(Boolean)));
  sel.innerHTML = '<option value="">全部平台</option>' + names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  sel.value = names.includes(cur) ? cur : '';

  const kw = ($('#histSearch').value || '').trim().toLowerCase();
  const list = (state.history || []).filter((h) => {
    if (sel.value && h.platformName !== sel.value) return false;
    if (!kw) return true;
    return [h.title, h.author, h.platformName, h.url].some((v) => String(v || '').toLowerCase().includes(kw));
  });

  if (!list.length) {
    host.innerHTML = emptyState(
      (state.history || []).length ? '没有匹配的记录' : '还没有导出记录',
      (state.history || []).length ? '换个关键词或平台试试。' : '每完成一次导出，记录都会保存在这里。'
    );
    return;
  }

  host.innerHTML = list.map((h) => {
    const accent = platformAccent(h.platform);
    const files = (h.files || []).map((f) => `
      <button class="btn sm" data-act="open" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">${escapeHtml(fmtLabel(f.format))}</button>
    `).join('');

    return `
      <div class="hist-row">
        <span class="plt-tag" style="background:${escapeHtml(accent)}14;color:${escapeHtml(accent)}">
          ${escapeHtml(h.platformName || '网页')}
        </span>
        <div class="hist-main">
          <div class="hist-title" title="${escapeHtml(h.title)}">${escapeHtml(h.title)}</div>
          <div class="hist-sub">
            <span>${escapeHtml(formatTime(h.exportedAt))}</span>
            ${h.author ? `<span>${escapeHtml(h.author)}</span>` : ''}
            ${h.chars ? `<span>${Number(h.chars).toLocaleString()} 字</span>` : ''}
            ${h.images ? `<span>${h.images} 图</span>` : ''}
            ${h.deepCount ? `<span>${h.deepCount} 篇子文档</span>` : ''}
            <span class="truncate" style="max-width:280px">${escapeHtml(h.url)}</span>
          </div>
        </div>
        <div class="hist-actions">
          ${files}
          <button class="btn sm btn-ghost" data-act="dir" data-dir="${escapeHtml(h.outDir)}" title="打开所在文件夹">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" width="13" height="13"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.6 2H19.5A1.5 1.5 0 0 1 21 9.5v7A1.5 1.5 0 0 1 19.5 18h-15A1.5 1.5 0 0 1 3 16.5v-9z"/></svg>
          </button>
          <button class="btn sm btn-ghost" data-act="url" data-url="${escapeHtml(h.url)}" title="打开原文">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" width="13" height="13"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4L11.4 6.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0L5 12.6a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/></svg>
          </button>
          <button class="btn sm btn-ghost" data-act="del" data-id="${h.id}" title="删除记录">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" width="13" height="13"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');
}
