/* 解析结果预览（抽屉内容） */

import { $, escapeHtml } from '../ui.js';
import { state } from '../store.js';

export function renderPreview(result, opts) {
  const o = opts || {};
  const body = $('#drawerBody');
  const stat = $('#drawerStat');
  const saveBtn = $('#drawerSave');

  const s = result.stats || {};
  const sections = Array.isArray(result.sections) ? result.sections : null;

  $('#drawerTitle').textContent = result.title || '解析预览';

  const meta = [];
  if (result.platformName) meta.push(result.platformName);
  if (result.author) meta.push('作者 ' + result.author);
  if (result.publishTime) meta.push(result.publishTime);
  if (s.chars) meta.push(s.chars.toLocaleString() + ' 字');
  if (s.images) meta.push(s.images + ' 张图');
  if (sections) meta.push('含 ' + sections.length + ' 篇子文档');
  if (s.usedReadability) meta.push('智能正文识别');
  if (result.fromWebview) meta.push('来自内置浏览器');

  const dirBlock = (result.directory && result.directory.length)
    ? `<div class="card tight" style="margin-bottom:16px">
        <div class="card-title-sm mb10">识别到目录 ${result.directory.length} 项${result.deepCount ? '，已抓取 ' + result.deepCount + ' 篇' : ''}</div>
        <div class="scroll-y" style="max-height:190px;font-size:12.2px;line-height:2">
          ${result.directory.slice(0, 80).map((d) => `<div class="truncate">${d.isFolder ? '▸ ' : '· '}${escapeHtml(d.title)}</div>`).join('')}
        </div>
      </div>`
    : '';

  const bodyHtml = sections
    ? sections.map((sec, i) => `
        <div style="margin-top:22px;padding-top:18px;border-top:1px solid var(--line)">
          <div style="font-size:15px;font-weight:700;margin-bottom:10px">${i + 1}. ${escapeHtml(sec.title || '')}</div>
          <div class="preview-content">${sec.html || ''}</div>
        </div>`).join('')
    : `<div class="preview-content">${result.contentHtml || ''}</div>`;

  body.innerHTML = `
    <div class="small muted mb10" style="line-height:1.9">${escapeHtml(meta.join('　·　'))}</div>
    <div class="code-line mb16">${escapeHtml(result.requestedUrl || result.url || '')}</div>
    ${dirBlock}
    ${bodyHtml}
  `;

  stat.textContent = o.others > 0
    ? `另有 ${o.others} 条链接待处理`
    : '确认无误后即可导出';

  saveBtn.textContent = o.others > 0 ? '导出这一条' : '导出这份内容';
  saveBtn.dataset.mode = o.others > 0 ? 'one' : 'all';

  // 若还有其它链接，追加一个「全部导出」按钮
  const foot = $('#drawer .drawer-foot');
  const old = $('#drawerAll');
  if (old) old.remove();
  if (o.others > 0) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.id = 'drawerAll';
    btn.textContent = '全部导出（' + (o.others + 1) + ' 条）';
    btn.addEventListener('click', () => {
      const fn = o.onSaveAll || window.__tndSubmitAll;
      if (typeof fn === 'function') fn();
    });
    foot.appendChild(btn);
  }
}
