/* 页面：插件中心 */

import { $, $$, escapeHtml, toast, modal, emptyState, confirmDialog } from '../ui.js';
import { state, api } from '../store.js';

export function initPlugins(ctx) {
  $('#btnInstallExt').addEventListener('click', installExtension);

  $('#btnAddRule').addEventListener('click', () => ruleDialog());

  $('#extList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;

    if (act === 'toggle') {
      state.extensions = await api.plugin.toggle(id, btn.dataset.on !== '1');
      renderExtensions();
      toast({
        title: '已' + (btn.dataset.on !== '1' ? '启用' : '禁用') + '扩展',
        text: '启用状态变更需要重启应用后生效',
        level: 'info',
        duration: 4800
      });
    }
    if (act === 'remove') {
      const ok = await confirmDialog('卸载该扩展？', '只会删除应用内的副本，你原始目录中的文件不会被改动。', '卸载');
      if (!ok) return;
      state.extensions = await api.plugin.remove(id);
      renderExtensions();
      toast({ title: '扩展已卸载', level: 'info' });
    }
    if (act === 'openDir') api.fs.openPath(btn.dataset.dir);
  });

  $('#ruleList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === 'removeRule') {
      state.rules = await api.plugin.removeRule(id);
      renderRules();
      toast({ title: '规则已删除', level: 'info' });
    }
    if (btn.dataset.act === 'editRule') {
      const r = state.rules.find((x) => x.id === id);
      ruleDialog(r);
    }
  });
}

async function installExtension() {
  try {
    const r = await api.plugin.install();
    if (!r || r.canceled) return;
    state.extensions = await api.plugin.list();
    renderExtensions();
    if (r.extension && r.extension.loaded) {
      toast({ title: '扩展安装成功', text: r.extension.name + ' v' + r.extension.version, level: 'success', duration: 5200 });
    } else {
      toast({
        title: '扩展已记录，但加载失败',
        text: (r.extension && r.extension.loadError) || '可能是该扩展使用了不受支持的能力',
        level: 'warning',
        duration: 8000
      });
    }
  } catch (err) {
    toast({ title: '安装失败', text: err.message, level: 'error', duration: 7000 });
  }
}

export async function refreshPlugins() {
  const [ext, rules] = await Promise.all([api.plugin.list(), api.plugin.rules()]);
  state.extensions = ext;
  state.rules = rules;
  renderExtensions();
  renderRules();
}

function renderExtensions() {
  const host = $('#extList');
  const list = state.extensions || [];
  if (!list.length) {
    host.innerHTML = emptyState(
      '还没有安装扩展',
      '可以安装 Chrome 扩展来增强解析能力（例如阅读模式、内容增强、翻译等）。支持文件夹 / .crx / .zip 三种来源。'
    );
    return;
  }
  host.innerHTML = list.map((x) => `
    <div class="plugin-row">
      <div class="plugin-icon">🧩</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13.2px;font-weight:650">${escapeHtml(x.name)}
          <span class="muted small" style="font-weight:400">v${escapeHtml(x.version)}</span>
          ${x.manifestVersion ? `<span class="plt-tag" style="margin-left:6px">MV${x.manifestVersion}</span>` : ''}
        </div>
        <div class="small muted mt6 truncate">${escapeHtml(x.description || '无描述')}</div>
        <div class="small" style="margin-top:3px;color:${x.loaded ? 'var(--success)' : (x.enabled ? 'var(--warn)' : 'var(--fg-3)')}">
          ${x.loaded ? '● 运行中' : (x.enabled ? '● 已启用（重启后加载）' : '○ 已禁用')}
          ${x.loadError ? '　' + escapeHtml(x.loadError) : ''}
        </div>
        <div class="code-line mt6" style="font-size:10.5px">${escapeHtml(x.path)}</div>
      </div>
      <div class="row gap6">
        <button class="btn sm" data-act="toggle" data-id="${x.id}" data-on="${x.enabled ? '1' : '0'}">${x.enabled ? '禁用' : '启用'}</button>
        <button class="btn sm btn-ghost" data-act="openDir" data-dir="${escapeHtml(x.path)}">目录</button>
        <button class="btn sm btn-danger" data-act="remove" data-id="${x.id}">卸载</button>
      </div>
    </div>
  `).join('');
}

function renderRules() {
  const host = $('#ruleList');
  const list = state.rules || [];
  if (!list.length) {
    host.innerHTML = emptyState(
      '还没有自定义规则',
      '当遇到解析效果不理想的小众网站时，为它指定正文容器选择器即可。'
    );
    return;
  }
  host.innerHTML = list.map((r) => `
    <div class="plugin-row">
      <div class="plugin-icon">🎯</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13.2px;font-weight:650">${escapeHtml(r.name || r.hostPattern)}</div>
        <div class="small muted mt6">域名：<span class="mono">${escapeHtml(r.hostPattern)}</span></div>
        <div class="small muted mt6 truncate">正文选择器：<span class="mono">${escapeHtml((r.contentSelectors || []).join(' , '))}</span></div>
      </div>
      <div class="row gap6">
        <button class="btn sm" data-act="editRule" data-id="${r.id}">编辑</button>
        <button class="btn sm btn-danger" data-act="removeRule" data-id="${r.id}">删除</button>
      </div>
    </div>
  `).join('');
}

function ruleDialog(existing) {
  const r = existing || {};
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="field">
      <label class="label">规则名称</label>
      <input class="input" id="rName" value="${escapeHtml(r.name || '')}" placeholder="例如：公司内部知识库">
    </div>
    <div class="field">
      <label class="label">域名匹配 <span class="hint">支持 example.com 或 *.example.com</span></label>
      <input class="input" id="rHost" value="${escapeHtml(r.hostPattern || '')}" placeholder="kb.example.com">
    </div>
    <div class="field">
      <label class="label">正文容器选择器 <span class="hint">每行一个，按顺序尝试</span></label>
      <textarea class="textarea" id="rContent" style="min-height:76px;font-family:var(--mono)">${escapeHtml((r.contentSelectors || []).join('\n'))}</textarea>
    </div>
    <div class="field">
      <label class="label">需要删除的元素 <span class="hint">可选，每行一个</span></label>
      <textarea class="textarea" id="rRemove" style="min-height:60px;font-family:var(--mono)">${escapeHtml((r.removeSelectors || []).join('\n'))}</textarea>
    </div>
    <div class="row gap10">
      <div class="field grow"><label class="label">标题选择器</label><input class="input" id="rTitle" value="${escapeHtml(r.titleSelector || '')}" placeholder="h1.article-title"></div>
      <div class="field grow"><label class="label">作者选择器</label><input class="input" id="rAuthor" value="${escapeHtml(r.authorSelector || '')}" placeholder=".author-name"></div>
    </div>
    <div class="field"><label class="label">时间选择器</label><input class="input" id="rTime" value="${escapeHtml(r.timeSelector || '')}" placeholder=".publish-time"></div>
  `;

  modal({
    title: existing ? '编辑解析规则' : '新建解析规则',
    desc: '规则只对匹配的域名生效。选择器获取方法：在网页上右键目标元素 → 检查 → 右键 DOM 节点 → Copy → Copy selector。',
    body: wrap,
    buttons: [
      { label: '取消' },
      {
        label: '保存',
        primary: true,
        keepOpen: true,
        onClick: async () => {
          const payload = {
            id: r.id,
            name: $('#rName', wrap).value.trim(),
            hostPattern: $('#rHost', wrap).value.trim(),
            contentSelectors: $('#rContent', wrap).value.split('\n').map((s) => s.trim()).filter(Boolean),
            removeSelectors: $('#rRemove', wrap).value.split('\n').map((s) => s.trim()).filter(Boolean),
            titleSelector: $('#rTitle', wrap).value.trim(),
            authorSelector: $('#rAuthor', wrap).value.trim(),
            timeSelector: $('#rTime', wrap).value.trim()
          };
          if (!payload.hostPattern) {
            toast({ title: '请填写域名匹配规则', level: 'warning' });
            return false;
          }
          if (!payload.contentSelectors.length) {
            toast({ title: '请至少填写一个正文选择器', level: 'warning' });
            return false;
          }
          state.rules = await api.plugin.addRule(payload);
          renderRules();
          toast({ title: '规则已保存', level: 'success', duration: 2600 });
          return true;
        }
      }
    ]
  });
}
