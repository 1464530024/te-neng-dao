/* 页面：任务中心（按日期分组展示全部任务） */

import { $, $$, escapeHtml, toast, statusMeta, emptyState, relTime } from '../ui.js';
import { state, api } from '../store.js';

let ctxRef = null;
let busyIds = new Set();

export function initTasks(ctx) {
  ctxRef = ctx;

  $('#btnClearTasks').addEventListener('click', async () => {
    await api.task.clearFinished();
    state.tasks = await api.task.list();
    renderTasks();
    toast({ title: '已清理已完成的任务', level: 'info', duration: 2200 });
  });

  $('#taskList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;

    if (act === 'expand') {
      const box = $('#items-' + id);
      if (box) box.classList.toggle('open');
      return;
    }

    if (busyIds.has(id)) return;

    if (act === 'cancel') {
      busyIds.add(id);
      await api.task.cancel(id);
      busyIds.delete(id);
      return;
    }

    if (act === 'retry') {
      busyIds.add(id);
      const ok = await api.task.retry(id);
      busyIds.delete(id);
      toast({
        title: ok ? '已重新加入队列' : '没有可重试的条目',
        level: ok ? 'info' : 'warning',
        duration: 2400
      });
      return;
    }

    if (act === 'remove') {
      await api.task.remove(id);
      state.tasks = await api.task.list();
      renderTasks();
      return;
    }

    if (act === 'openDir') { api.fs.openPath(btn.dataset.dir); return; }
    if (act === 'openFile') { api.fs.openPath(btn.dataset.path); return; }
    if (act === 'showFile') { api.fs.showItem(btn.dataset.path); return; }
  });
}

export function refreshTasks() {
  renderTasks();
}

/* ───────── 渲染 ───────── */

function fmtLabel(f) {
  const map = { pdf: 'PDF', markdown: 'MD', docx: 'Word', word: 'Word', html: 'HTML', txt: 'TXT', json: 'JSON', csv: 'CSV', archive: '压缩包', document: '文档', file: '文件' };
  return map[f] || (f || '').toUpperCase();
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** 把任务按「今天 / 昨天 / N 天前 / 具体日期」分组，顺序即时间倒序 */
function groupByDate(tasks) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const map = new Map();
  tasks.forEach((t) => {
    const d = new Date(t.createdAt);
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((today - day) / 86400000);

    let label;
    if (!(day instanceof Date) || Number.isNaN(day.getTime())) label = '更早';
    else if (diff === 0) label = '今天';
    else if (diff === 1) label = '昨天';
    else if (diff > 1 && diff < 8) label = diff + ' 天前';
    else label = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

    if (!map.has(label)) map.set(label, []);
    map.get(label).push(t);
  });

  return Array.from(map, ([label, items]) => ({ label, items }));
}

export function renderTasks() {
  const host = $('#taskList');
  if (!host) return;

  const tasks = state.tasks || [];
  const active = tasks.filter((t) => t.status === 'running' || t.status === 'queued');

  $('#statRunning').textContent = String(tasks.filter((t) => t.status === 'running').length);
  $('#statQueued').textContent = String(tasks.filter((t) => t.status === 'queued').length);
  $('#statTotal').textContent = String(tasks.length);
  $('#statSlots').textContent = String(active.length);

  if (!tasks.length) {
    host.innerHTML = emptyState(
      '还没有任务',
      '到「链接导出」粘贴链接，任务会自动出现在这里并后台执行。<br>所有任务（进行中与已完成）都会按日期归档在这里。'
    );
    return;
  }

  const groups = groupByDate(tasks);
  host.innerHTML = groups.map((g) => `
    <div class="task-group">
      <div class="task-group-head">
        <span class="task-group-title">${escapeHtml(g.label)}</span>
        <span class="task-group-count">${g.items.length}</span>
        <span class="task-group-line"></span>
      </div>
      ${g.items.map(renderTaskCard).join('')}
    </div>
  `).join('');
}

function renderTaskCard(t) {
  const st = statusMeta(t.status);
  const items = t.items || [];
  const filesAll = items.flatMap((i) => i.files || []);

  const itemRows = items.map((i) => {
    const s2 = statusMeta(i.status);
    const files = (i.files || []).map((f) => `
      <button class="btn sm" data-act="openFile" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
        ${escapeHtml(fmtLabel(f.format))}
      </button>`).join('');

    return `
      <div class="task-item">
        <span class="status-pill ${s2.cls}" style="height:18px;padding:0 7px;font-size:10px"><span class="dot"></span>${s2.text}</span>
        <div style="flex:1;min-width:0">
          <div class="ti-title" title="${escapeHtml(i.url)}">${escapeHtml(i.title || i.url)}</div>
          ${i.error ? `<div class="ti-err">${escapeHtml(i.error)}</div>` : ''}
          ${(i.warnings && i.warnings.length) ? `<div class="ti-err" style="color:var(--warn)">${escapeHtml(i.warnings.join('；'))}</div>` : ''}
          ${files ? `<div class="ti-files">${files}</div>` : ''}
        </div>
        ${files ? `<button class="btn sm btn-ghost" data-act="showFile" data-path="${escapeHtml((i.files[0] || {}).path || '')}" title="在文件夹中显示">定位</button>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="task ${t.status === 'running' ? 'running' : ''} ${t.status === 'done' ? 'done' : ''} ${t.status === 'failed' ? 'failed' : ''}">
      <div class="task-top">
        <span class="status-pill ${st.cls}"><span class="dot"></span>${st.text}</span>
        <div class="task-name">${escapeHtml(t.name)}</div>
        <span class="small muted nowrap" title="${escapeHtml(t.createdAt || '')}">${escapeHtml(relTime(t.createdAt))}</span>
      </div>
      <div class="progress"><i style="width:${t.progress}%"></i></div>
      <div class="task-meta">
        <span>进度 <b>${t.finished}/${t.total}</b></span>
        <span>格式 <b>${(t.formats || []).map(fmtLabel).join(' / ')}</b></span>
        ${t.platformName ? `<span>来源 <b>${escapeHtml(t.platformName)}</b></span>` : ''}
        ${t.status === 'running' ? `<span class="truncate" style="max-width:240px">正在 <b>${escapeHtml(t.currentLabel || '')}</b></span>` : ''}
        ${t.finishedAt ? `<span>耗时 <b>${dur(t.startedAt, t.finishedAt)}</b></span>` : ''}
      </div>
      <div class="task-actions">
        <button class="btn sm" data-act="expand" data-id="${t.id}">详情</button>
        ${(t.status === 'running' || t.status === 'queued') ? `<button class="btn sm btn-danger" data-act="cancel" data-id="${t.id}">取消</button>` : ''}
        ${(t.status === 'failed' || t.status === 'partial' || t.status === 'canceled' || t.status === 'interrupted')
          ? `<button class="btn sm" data-act="retry" data-id="${t.id}">重试失败项</button>` : ''}
        ${t.outDir ? `<button class="btn sm" data-act="openDir" data-dir="${escapeHtml(t.outDir)}">打开目录</button>` : ''}
        ${filesAll.length ? `<button class="btn sm btn-ghost" data-act="showFile" data-path="${escapeHtml(filesAll[0].path)}">定位文件</button>` : ''}
        <div class="grow"></div>
        <button class="btn sm btn-ghost" data-act="remove" data-id="${t.id}" title="从列表移除">移除</button>
      </div>
      <div class="task-items" id="items-${t.id}">${itemRows || '<div class="small muted" style="padding:8px">等待开始…</div>'}</div>
    </div>`;
}

function dur(a, b) {
  if (!a || !b) return '—';
  const ms = new Date(b) - new Date(a);
  if (Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return ms + ' ms';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
}
