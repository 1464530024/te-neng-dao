/* 通用 UI 工具：选择器、提示条、弹窗、格式化 */

export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function relTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 86400000 * 7) return Math.floor(diff / 86400000) + ' 天前';
  return formatTime(iso).slice(0, 10);
}

export function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  if (parts.length <= 3) return p;
  return '…\\' + parts.slice(-2).join('\\');
}

export function fileBaseName(p) {
  if (!p) return '';
  return String(p).split(/[\\/]/).pop();
}

export function bytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

/* ───────── 状态提示条（右下角） ───────── */
const TOAST_ICONS = {
  info: 'i',
  success: '✓',
  warning: '!',
  error: '×',
  alert: '!'
};

export function toast(opts) {
  const o = typeof opts === 'string' ? { title: opts } : (opts || {});
  const host = $('#toasts');
  if (!host) return null;

  const el = document.createElement('div');
  const level = o.level || 'alert';
  el.className = 'toast ' + level;

  const duration = o.duration === undefined ? 5200 : o.duration;
  const mark = o.mark || TOAST_ICONS[level] || '!';

  el.innerHTML = `
    <div class="toast-mark">${escapeHtml(mark)}</div>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(o.title || '')}</div>
      ${o.text ? `<div class="toast-text">${escapeHtml(o.text)}</div>` : ''}
    </div>
    ${duration > 0 ? `<div class="toast-bar" style="animation-duration:${duration}ms"></div>` : ''}
  `;

  el.addEventListener('click', () => {
    if (typeof o.onClick === 'function') o.onClick();
    close();
  });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }

  host.appendChild(el);
  if (duration > 0) setTimeout(close, duration);

  // 最多同时显示 4 条
  const all = $$('.toast', host);
  if (all.length > 4) all.slice(0, all.length - 4).forEach((x) => x.remove());

  return { close, el };
}

/* ───────── 弹窗 ───────── */
export function modal(opts) {
  const o = opts || {};
  const mask = $('#modalMask');
  $('#modalTitle').textContent = o.title || '';
  const desc = $('#modalDesc');
  desc.innerHTML = o.desc || '';
  desc.classList.toggle('hidden', !o.desc);

  const body = $('#modalBody');
  if (typeof o.body === 'string') body.innerHTML = o.body;
  else if (o.body instanceof Node) { body.innerHTML = ''; body.appendChild(o.body); }
  else body.innerHTML = '';

  const foot = $('#modalFoot');
  foot.innerHTML = '';
  const buttons = o.buttons || [{ label: '知道了', primary: true }];
  buttons.forEach((b) => {
    const btn = document.createElement('button');
    btn.className = 'btn' + (b.primary ? ' btn-primary' : '') + (b.danger ? ' btn-danger' : '');
    btn.textContent = b.label;
    btn.addEventListener('click', async () => {
      if (b.onClick) {
        const r = await b.onClick();
        if (r === false) return;
      }
      if (b.keepOpen !== true) close();
    });
    foot.appendChild(btn);
  });

  function close() {
    mask.classList.remove('open');
    setTimeout(() => { if (!mask.classList.contains('open')) { body.innerHTML = ''; } }, 240);
  }

  mask.classList.add('open');
  mask.onclick = (e) => { if (e.target === mask) close(); };
  return { close, body, foot };
}

export function confirmDialog(title, desc, okLabel) {
  return new Promise((resolve) => {
    modal({
      title,
      desc,
      buttons: [
        { label: '取消', onClick: () => resolve(false) },
        { label: okLabel || '确定', primary: true, onClick: () => resolve(true) }
      ]
    });
  });
}

/* ───────── 抽屉 ───────── */
export function openDrawer() {
  $('#drawerMask').classList.add('open');
  $('#drawer').classList.add('open');
}
export function closeDrawer() {
  $('#drawerMask').classList.remove('open');
  $('#drawer').classList.remove('open');
}

/* ───────── 其它 ───────── */
export function setStatusChip(text, busy) {
  const chip = $('#statusChip');
  $('#statusChipText').textContent = text;
  chip.classList.toggle('busy', !!busy);
}

export function statusMeta(status) {
  const map = {
    queued: { cls: 's-queued', text: '排队中' },
    running: { cls: 's-running', text: '进行中' },
    done: { cls: 's-done', text: '已完成' },
    partial: { cls: 's-partial', text: '部分完成' },
    failed: { cls: 's-failed', text: '失败' },
    canceled: { cls: 's-canceled', text: '已取消' },
    interrupted: { cls: 's-interrupted', text: '已中断' }
  };
  return map[status] || { cls: 's-queued', text: status || '未知' };
}

export function emptyState(title, desc, iconSvg) {
  return `
    <div class="empty">
      <div class="ico">${iconSvg || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M4 12h10M4 17h7"/></svg>'}</div>
      <h3>${escapeHtml(title)}</h3>
      <p>${desc || ''}</p>
    </div>`;
}
