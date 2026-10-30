/* 特能导 · 渲染进程入口 */

import { $, $$, toast, escapeHtml, formatTime, setStatusChip, statusMeta } from './ui.js';
import { state, api, bootstrap, platformName } from './store.js';

import { initNewTask, refreshNewTask } from './pages/newtask.js';
import { initIma, refreshIma } from './pages/ima.js';
import { initTasks, refreshTasks, renderTasks } from './pages/tasks.js';
import { initHistory, renderHistory } from './pages/history.js';
import { initBrowser, refreshBrowser, reloadBrowserMeta } from './pages/browser.js';
import { initPlugins, refreshPlugins } from './pages/plugins.js';
import { initSettings, refreshSettings, initBrowserSettings, refreshBrowserSettings } from './pages/settings.js';
import { renderHelp } from './pages/help.js';

export const ctx = {
  go,
  state,
  api,
  toast,
  platformName
};

let currentPage = 'new';

export function go(page) {
  if (!page) return;
  currentPage = page;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
  $('#main').classList.toggle('no-pad', page === 'browser');
  $('#main').scrollTop = 0;

  if (page === 'new') refreshNewTask();
  if (page === 'ima') refreshIma();
  if (page === 'tasks') renderTasks();
  if (page === 'history') renderHistory();
  if (page === 'browser') refreshBrowser();
  if (page === 'plugins') refreshPlugins();
  if (page === 'settings') { refreshSettings(); refreshBrowserSettings(); }
  if (page === 'help') renderHelp();
  if (page === 'about') renderAbout();
}

function renderAbout() {
  const i = state.info || {};
  $('#aboutVersion').textContent = '版本 ' + (i.version || '1.0.0');
  $('#aboutInfo').innerHTML = `
    <div><span class="muted">内核</span>　Electron ${escapeHtml(i.electron || '')} · Chromium ${escapeHtml(i.chrome || '')} · Node ${escapeHtml(i.node || '')}</div>
    <div><span class="muted">平台</span>　${escapeHtml(i.platform || '')}</div>
    <div><span class="muted">数据目录</span>　<span class="mono small">${escapeHtml(i.userData || '')}</span></div>
    <div style="margin-top:10px" class="muted small">本软件用于将公开或已获授权访问的网页内容整理归档为个人可读文档，请在使用时遵守目标网站的服务条款与著作权规定。</div>
  `;
}

/* ───────── 导航与窗口控制 ───────── */
function bindChrome() {
  $$('.nav-item').forEach((item) => {
    item.addEventListener('click', () => go(item.dataset.page));
  });

  $('#winMin').addEventListener('click', () => api.win.minimize());
  $('#winMax').addEventListener('click', () => api.win.maximize());
  $('#winClose').addEventListener('click', () => api.win.close());

  api.on('window:state', (s) => {
    $('#winMax').title = s.maximized ? '还原' : '最大化';
  });

  api.on('menu:goto', (p) => go(p));
  api.on('menu:new-task', () => {
    go('new');
    setTimeout(() => {
      const inputs = $$('#linkList .link-input');
      const empty = inputs.slice().reverse().find((i) => !i.value.trim());
      (empty || inputs[inputs.length - 1] || { focus() {} }).focus();
    }, 140);
  });
  api.on('menu:open-browser', () => go('browser'));
}

/* ───────── 任务角标与提醒 ───────── */
function updateTaskBadge() {
  const active = state.tasks.filter((t) => t.status === 'running' || t.status === 'queued');
  const badge = $('#taskBadge');
  badge.textContent = String(state.tasks.length);
  badge.classList.toggle('hidden', state.tasks.length === 0);
  badge.style.background = active.length
    ? 'linear-gradient(180deg,#4a96f8,#0a6cf1)'
    : 'linear-gradient(180deg,#ff6b6b,#e5484d)';
  $('#statRunning').textContent = state.tasks.filter((t) => t.status === 'running').length;
  $('#statQueued').textContent = state.tasks.filter((t) => t.status === 'queued').length;
  $('#statTotal').textContent = String(state.tasks.length);

  if (active.length) {
    const t = active[0];
    setStatusChip(`正在处理 ${t.finished || 0}/${t.total}`, true);
    $('#statSlots').textContent = String(active.length);
  } else {
    setStatusChip('就绪', false);
    $('#statSlots').textContent = '0';
  }
}

function bindGlobalEvents() {
  api.on('task:update', (task) => {
    const i = state.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) state.tasks[i] = task;
    else state.tasks.unshift(task);
    updateTaskBadge();
    if (currentPage === 'tasks') renderTasks();
    if (currentPage === 'new') refreshNewTask();
  });

  api.on('notify:toast', (payload) => {
    if (state.settings.notifyBadge === false) return;
    toast({
      title: payload.title,
      text: payload.body,
      level: payload.level || 'alert',
      duration: 6200,
      onClick: () => {
        if (payload.taskId) go('tasks');
        else if (payload.files && payload.files.length) api.fs.showItem(payload.files[0].path);
      }
    });
  });

  api.on('history:changed', (list) => {
    state.history = list;
    $('#sideCount').textContent = String(list.length);
    if (currentPage === 'history') renderHistory();
  });
}

/* ───────── 启动 ───────── */
async function boot() {
  await bootstrap();

  const s = state.settings;
  $('#sideVersion').textContent = 'v' + (state.info.version || '1.0.0');
  $('#sideCount').textContent = String(state.history.length);
  $('#outDirInput').value = s.outDir || state.info.defaultOutDir || '';

  bindChrome();
  bindGlobalEvents();

  initNewTask(ctx);
  initIma(ctx);
  initTasks(ctx);
  initHistory(ctx);
  initBrowser(ctx);
  initPlugins(ctx);
  initSettings(ctx);
  initBrowserSettings(ctx);
  await reloadBrowserMeta();

  updateTaskBadge();
  go('new');

  // 供构建期界面回归脚本切换页面
  window.__tndGo = go;

  document.body.classList.add('ready');
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML =
    '<div style="padding:40px;font-family:system-ui">' +
    '<h2>界面启动失败</h2><pre style="white-space:pre-wrap;color:#c00">' +
    String(err && err.stack ? err.stack : err) +
    '</pre></div>';
});
