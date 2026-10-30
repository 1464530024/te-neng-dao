/* 页面：IMA 知识库导出（独立功能区，通过官方开放接口按目录结构导出） */

import { $, $$, escapeHtml, toast } from '../ui.js';
import { state, api } from '../store.js';

let tocEntries = [];
let exporting = false;
let lastOutput = '';

export function initIma(ctx) {
  syncCreds();

  $('#imaSaveCreds').addEventListener('click', saveCreds);
  $('#imaOpenAgent').addEventListener('click', () => api.fs.openExternal('https://ima.qq.com/agent-interface'));
  $('#imaLinkAgent').addEventListener('click', (e) => { e.preventDefault(); api.fs.openExternal('https://ima.qq.com/agent-interface'); });
  $('#imaTestConn').addEventListener('click', testConn);
  $('#imaReloadKb').addEventListener('click', loadKbList);
  $('#imaScanToc').addEventListener('click', scanToc);
  $('#imaTocAll').addEventListener('click', () => setAllChecks(true));
  $('#imaTocNone').addEventListener('click', () => setAllChecks(false));
  $('#imaChooseDir').addEventListener('click', chooseDir);
  $('#imaStart').addEventListener('click', startExport);
  $('#imaOpenOut').addEventListener('click', openOut);

  api.on('ima:progress', onProgress);
}

export function refreshIma() {
  $('#imaOutDir').value = state.settings.outDir || state.info.defaultOutDir || '';
  syncCreds();
}

/* ───────── 凭据 ───────── */

function getCred(k) {
  const cfg = (state.settings && state.settings.imaOpenApi) || {};
  return cfg[k] || '';
}

function syncCreds() {
  $('#imaClientId').value = getCred('clientId');
  $('#imaApiKey').value = getCred('apiKey');
  const ok = getCred('clientId') && getCred('apiKey');
  $('#imaCredStatus').textContent = ok ? '已配置' : '';
  $('#imaCredStatus').className = 'hint' + (ok ? ' ok' : '');
}

async function saveCreds() {
  const ok = await persistCreds();
  $('#imaCredStatus').textContent = ok ? '已保存' : '请填写完整';
  $('#imaCredStatus').className = 'hint ' + (ok ? 'ok' : 'warn');
  toast({ title: '凭据已保存', level: 'success', duration: 2000 });
  return ok;
}

/** 静默保存当前输入的凭据（供各动作执行前调用，确保用的是最新值） */
async function persistCreds() {
  const clientId = $('#imaClientId').value.trim();
  const apiKey = $('#imaApiKey').value.trim();
  state.settings = await api.settings.save({ imaOpenApi: { clientId, apiKey } });
  return !!(clientId && apiKey);
}

async function testConn() {
  await saveCreds();
  $('#imaCredStatus').textContent = '测试中…';
  $('#imaCredStatus').className = 'hint';
  const r = await api.ima.listKnowledgeBases({});
  if (r.ok && r.list && r.list.length) {
    $('#imaCredStatus').textContent = '连接成功，发现 ' + r.list.length + ' 个知识库';
    $('#imaCredStatus').className = 'hint ok';
  } else {
    $('#imaCredStatus').textContent = '连接失败：' + (r.reason || '未发现知识库');
    $('#imaCredStatus').className = 'hint warn';
  }
}

/* ───────── 知识库列表 ───────── */

async function loadKbList() {
  const sel = $('#imaKbSelect');
  sel.innerHTML = '<option value="">正在读取…</option>';
  await persistCreds();
  const r = await api.ima.listKnowledgeBases({});
  if (r.ok && r.list && r.list.length) {
    sel.innerHTML = r.list.map((k) => '<option value="' + escapeHtml(k.id) + '">' + escapeHtml(k.name || k.id) + '</option>').join('');
    toast({ title: '已读取 ' + r.list.length + ' 个知识库', level: 'info', duration: 2200 });
  } else {
    sel.innerHTML = '<option value="">读取失败：' + escapeHtml(r.reason || '未知错误') + '</option>';
    toast({ title: '读取知识库失败', text: r.reason || '', level: 'error' });
  }
}

/* ───────── 目录树 ───────── */

async function scanToc() {
  const sel = $('#imaKbSelect');
  const kbId = sel.value;
  if (!kbId) { toast({ title: '请先选择知识库', level: 'warning' }); return; }
  await persistCreds();
  const kbName = (sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].textContent) || '';

  const list = $('#imaTocList');
  list.innerHTML = '<div class="small muted" style="padding:14px 4px">正在读取目录…</div>';
  $('#imaTocCount').textContent = '';

  const r = await api.ima.scanToc({ knowledgeBaseId: kbId, knowledgeBaseName: kbName });
  if (!r.ok) {
    list.innerHTML = '<div class="small muted" style="padding:14px 4px">读取失败：' + escapeHtml(r.reason || '未知错误') + '</div>';
    toast({ title: '读取目录失败', text: r.reason || '', level: 'error' });
    return;
  }
  tocEntries = r.entries || [];
  renderToc();
  const st = r.stats || {};
  toast({ title: '已读取目录', text: (st.files || 0) + ' 篇文档 / ' + (st.folders || 0) + ' 个文件夹', level: 'info', duration: 2600 });
}

function renderToc() {
  const list = $('#imaTocList');
  if (!tocEntries.length) {
    list.innerHTML = '<div class="small muted" style="padding:14px 4px">目录为空。</div>';
    $('#imaTocCount').textContent = '';
    return;
  }
  list.innerHTML = tocEntries.map((e) => {
    const indent = Math.min(e.depth || 0, 12) * 18;
    if (e.isFolder) {
      return '<div class="ima-node folder" style="padding-left:' + indent + 'px">' +
        '<span class="ima-folder-mark"></span>' +
        '<span class="ima-node-title">' + escapeHtml(e.title) + '</span></div>';
    }
    return '<label class="ima-node file" style="padding-left:' + indent + 'px">' +
      '<input type="checkbox" class="ima-doc" value="' + escapeHtml(e.exportId) + '" checked>' +
      '<span class="ima-node-title">' + escapeHtml(e.title) + '</span></label>';
  }).join('');

  $$('#imaTocList .ima-doc').forEach((cb) => cb.addEventListener('change', updateTocCount));
  updateTocCount();
}

function setAllChecks(on) {
  $$('#imaTocList .ima-doc').forEach((cb) => { cb.checked = on; });
  updateTocCount();
}

function updateTocCount() {
  const all = $$('#imaTocList .ima-doc');
  const sel = all.filter((cb) => cb.checked).length;
  $('#imaTocCount').textContent = all.length ? ('已选 ' + sel + '/' + all.length + ' 篇') : '';
}

/* ───────── 导出 ───────── */

async function chooseDir() {
  const dir = await api.fs.chooseDir($('#imaOutDir').value || state.settings.outDir);
  if (!dir) return;
  $('#imaOutDir').value = dir;
  state.settings = await api.settings.save({ outDir: dir });
}

async function startExport() {
  if (exporting) return;
  const sel = $('#imaKbSelect');
  const kbId = sel.value;
  if (!kbId) { toast({ title: '请先选择知识库', level: 'warning' }); return; }

  const docIds = $$('#imaTocList .ima-doc').filter((cb) => cb.checked).map((cb) => cb.value);
  if (tocEntries.length && !docIds.length) { toast({ title: '请至少勾选一篇文档', level: 'warning' }); return; }

  const kbName = (sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].textContent) || '';
  const outDir = $('#imaOutDir').value || state.settings.outDir || state.info.defaultOutDir;
  await persistCreds();

  exporting = true;
  $('#imaStart').disabled = true;
  $('#imaResult').classList.add('hidden');
  $('#imaProgressBox').classList.remove('hidden');
  setBar(2, '准备中…');

  try {
    const r = await api.ima.exportTree({
      knowledgeBaseId: kbId,
      knowledgeBaseName: kbName,
      outputRoot: outDir,
      docIds: tocEntries.length ? docIds : undefined,
      autoOutputFolder: $('#imaAutoFolder').checked
    });
    if (!r.ok) {
      setBar(100, '导出失败');
      showResult('导出失败：' + escapeHtml(r.reason || '未知错误'));
    } else {
      lastOutput = r.output || '';
      setBar(100, '完成');
      const lines = [
        '导出完成：成功 <b>' + r.exportedDocs + '</b> 篇，跳过 ' + r.skippedDocs + ' 篇，失败 ' + r.failureCount + ' 篇（用时 ' + r.elapsedSeconds + 's）。',
        '输出目录：' + escapeHtml(r.output || '')
      ];
      if (r.failureCount) {
        const first = (r.failures || [])[0];
        if (first) lines.push('首个失败项：' + escapeHtml(first.title) + '（' + escapeHtml(first.reason) + '）');
      }
      showResult(lines.join('<br>'));
      toast({ title: 'IMA 导出完成', text: '成功 ' + r.exportedDocs + ' / 共 ' + r.selectedDocs, level: 'success', duration: 6000 });
    }
  } catch (err) {
    setBar(100, '导出异常');
    showResult('导出异常：' + escapeHtml((err && err.message) || String(err)));
  } finally {
    exporting = false;
    $('#imaStart').disabled = false;
  }
}

function openOut() {
  const dir = lastOutput || $('#imaOutDir').value || state.settings.outDir;
  if (!dir) { toast({ title: '还没有可打开的目录', level: 'warning' }); return; }
  api.fs.openPath(dir);
}

function onProgress(info) {
  if (!exporting || !info) return;
  if (info.phase === 'log') {
    $('#imaProgressText').textContent = info.message || '';
    return;
  }
  if (info.index && info.total) {
    const pct = Math.round((info.index / info.total) * 100);
    setBar(pct, (info.title || '') + '　' + info.index + '/' + info.total);
  }
}

function setBar(pct, text) {
  $('#imaBarFill').style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (text !== undefined) $('#imaProgressText').textContent = text;
}

function showResult(html) {
  const el = $('#imaResult');
  el.classList.remove('hidden');
  el.innerHTML = html;
}
