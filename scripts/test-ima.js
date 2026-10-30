/**
 * IMA OpenAPI 通道自检（对齐 wandao 的输出格式）。
 *
 * 启动本地 mock 服务模拟 ima 开放接口，验证：
 *   ① 纯函数：文件名清理 / 同名唯一化 / 扩展名推断 / 文件夹判定
 *   ② 知识库列表
 *   ③ 目录树读取（含嵌套文件夹与层级路径）
 *   ④ 整库导出：按 知识库名/目录层级 落盘，笔记 .md + {stem}_assets/image-001.ext，
 *      附件原名保存，同名自动 _2
 *
 * 用法：node scripts/test-ima.js
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');

/* ── mock 数据 ──
 * 目录结构：
 *   根
 *   ├─ 文件夹A
 *   │  ├─ 笔记1（note，含一张图片）
 *   │  ├─ 笔记1（同名，验证 _2 唯一化）
 *   │  └─ 子文件夹
 *   │     └─ 笔记2
 *   └─ 文件B.pdf（附件）
 */
const KB = { knowledge_base_id: 'kb_demo', name: '演示知识库' };

const FOLDERS = {
  '': [
    { media_id: 'folder_A', name: '文件夹A', is_top: true },
    { media_id: 'media_B', name: '文件B', file_name: '文件B.pdf', url: '/files/%E6%96%87%E4%BB%B6B.pdf' }
  ],
  folder_A: [
    { media_id: 'media_1', name: '笔记1', media_type: 11 },
    { media_id: 'media_1b', name: '笔记1', media_type: 11 },
    { media_id: 'folder_A2', name: '子文件夹', folder_number: 2 }
  ],
  folder_A2: [
    { media_id: 'media_2', name: '笔记2', media_type: 11 }
  ]
};

const MEDIA = {
  media_1: { media_type: 11, note_id: 'note_1' },
  media_1b: { media_type: 11, note_id: 'note_1b' },
  media_2: { media_type: 11, note_id: 'note_2' },
  media_B: { media_type: 3, file_name: '文件B.pdf', url: '/files/%E6%96%87%E4%BB%B6B.pdf' }
};

const NOTES = {
  note_1: { content: '# 笔记1\n\n正文一。\n\n![示意图]({ORIGIN}/img/a.png)' },
  note_1b: { content: '这篇正文没有井号标题。' },
  note_2: { content: '## 笔记2\n\n正文二内容。' }
};

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => resolve(d));
  });
}

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // 24 字节伪 PNG

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const origin = 'http://' + (req.headers.host || '127.0.0.1');
  const body = await readBody(req);
  let payload = {};
  try { payload = JSON.parse(body || '{}'); } catch (e) { /* ignore */ }

  // 图片 / 附件直链不带 openapi 凭据头（真实场景亦如此），须在认证校验前处理
  if (url.startsWith('/img/')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG);
    return;
  }
  if (url.startsWith('/files/')) {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(Buffer.from('%PDF-1.4 fake pdf content'));
    return;
  }

  // 校验认证头
  const cid = req.headers['ima-openapi-clientid'];
  const key = req.headers['ima-openapi-apikey'];
  if (!cid || !key) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 401, msg: 'missing credentials' }));
    return;
  }

  if (url.endsWith('/wiki/v1/search_knowledge_base')) {
    return json(res, { code: 0, data: { knowledge_base_list: [KB] } });
  }
  if (url.endsWith('/wiki/v1/get_knowledge_list')) {
    const fid = payload.folder_id || '';
    const list = (FOLDERS[fid] || []).map((n) => (n.url && n.url.startsWith('/')
      ? Object.assign({}, n, { url: origin + n.url }) : n));
    return json(res, { code: 0, data: { knowledge_list: list, is_end: true } });
  }
  if (url.endsWith('/wiki/v1/get_media_info')) {
    const info = Object.assign({}, MEDIA[payload.media_id] || {});
    if (info.url && info.url.startsWith('/')) info.url = origin + info.url;
    return json(res, { code: 0, data: info, ...info });
  }
  if (url.endsWith('/note/v1/get_doc_content')) {
    const note = NOTES[payload.note_id] || {};
    const content = String(note.content || '').replace('{ORIGIN}', origin);
    return json(res, { code: 0, data: { content }, content });
  }
  res.writeHead(404);
  res.end('not found');
});

let pass = 0;
let fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  process.env.TND_IMA_OPENAPI_BASE = 'http://127.0.0.1:' + port + '/openapi';

  // 必须在设置环境变量之后再 require，确保 BASE 生效
  const imaApi = require('../src/main/services/imaApi');
  const { _internals } = imaApi;
  const CRED = { clientId: 'cid', apiKey: 'key' };

  console.log('\n【1】纯函数：文件名清理（对齐 wandao sanitize_filename）');
  assert('非法字符 → _', _internals.sanitizeFilename('a/b:c*d?e"f<g>h|i') === 'a_b_c_d_e_f_g_h_i', _internals.sanitizeFilename('a/b:c*d?e"f<g>h|i'));
  assert('去首尾点与空格', _internals.sanitizeFilename('  ..名字.. ') === '名字', _internals.sanitizeFilename('  ..名字.. '));
  assert('空值回退', _internals.sanitizeFilename('', 'untitled') === 'untitled');

  console.log('\n【2】纯函数：同名唯一化 uniquePath');
  const tmp = path.join(__dirname, '..', 'logs', 'test-ima-uni');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const p1 = path.join(tmp, 'a.md');
  fs.writeFileSync(p1, 'x');
  const p2 = _internals.uniquePath(p1);
  assert('同名 → _2', path.basename(p2) === 'a_2.md', path.basename(p2));
  fs.writeFileSync(p2, 'y');
  assert('再次同名 → _3', path.basename(_internals.uniquePath(p1)) === 'a_3.md');

  console.log('\n【3】纯函数：扩展名推断 extensionForDownload');
  assert('优先取标题后缀', _internals.extensionForDownload('报告.pdf', 3, '') === '.pdf');
  assert('按 content-type 补后缀', _internals.extensionForDownload('报告', 3, 'application/pdf; charset=x') === '.pdf');
  assert('未知类型 → .bin', _internals.extensionForDownload('未知', 99, 'application/x-unknown') === '.bin');

  console.log('\n【4】纯函数：文件夹判定');
  assert('folder_ 前缀', imaApi.isFolderNode({ media_id: 'folder_x' }));
  assert('普通文档不是文件夹', !imaApi.isFolderNode({ media_id: 'media_x', name: 'x' }));
  assert('含 is_top 无 url → 文件夹', imaApi.isFolderNode({ is_top: true, name: 'f' }));
  assert('有 url 的节点不是文件夹', !imaApi.isFolderNode({ is_top: true, name: 'f', url: 'http://x' }));

  console.log('\n【5】纯函数：正文 / 图片提取');
  assert('content 字段', _internals.extractContentText({ content: 'hello' }) === 'hello');
  assert('data.doc_content 字段', _internals.extractContentText({ data: { doc_content: 'world' } }) === 'world');
  assert('md 图片提取', _internals.extractMdImageUrls('![a](http://x/1.png) 文本 ![b](http://y/2.jpg)').length === 2);
  assert('非 http 图片忽略', _internals.extractMdImageUrls('![a](./local.png)').length === 0);

  console.log('\n【6】知识库列表');
  const kbList = await imaApi.listKnowledgeBases(CRED);
  assert('拉取成功', kbList.ok, kbList.reason);
  assert('含 1 个知识库且名称正确', kbList.list && kbList.list[0] && kbList.list[0].name === '演示知识库');

  console.log('\n【7】读取目录树 scanToc');
  const toc = await imaApi.scanToc({ credentials: CRED, knowledgeBaseId: 'kb_demo', knowledgeBaseName: '演示知识库' });
  assert('读取成功', toc.ok, toc.reason);
  assert('含 4 个文件节点', toc.stats && toc.stats.files === 4, JSON.stringify(toc.stats));
  const nested = (toc.entries || []).find((e) => e.title === '笔记2');
  assert('深层路径为 文件夹A/子文件夹/笔记2', nested && nested.path === '文件夹A/子文件夹/笔记2', nested && nested.path);
  assert('relativeParts 含两层', nested && nested.relativeParts.length === 2, nested && JSON.stringify(nested.relativeParts));

  console.log('\n【8】整库导出 exportToTree（wandao 输出格式）');
  const outDir = path.join(__dirname, '..', 'logs', 'test-ima-out');
  fs.rmSync(outDir, { recursive: true, force: true });

  const r = await imaApi.exportToTree({
    credentials: CRED,
    knowledgeBaseId: 'kb_demo',
    knowledgeBaseName: '演示知识库',
    outputRoot: outDir,
    autoOutputFolder: true
  });

  assert('导出成功', r.ok, r.reason);
  assert('导出 4 篇', r.exportedDocs === 4, JSON.stringify({ exported: r.exportedDocs, skipped: r.skippedDocs, failures: r.failures }));
  assert('无失败', r.failureCount === 0, JSON.stringify(r.failures));

  const kbRoot = path.join(outDir, '演示知识库');
  const f = (p) => path.join(kbRoot, p);
  const exists = (p) => fs.existsSync(f(p));

  assert('按知识库名建顶层目录', fs.existsSync(kbRoot));
  assert('文件夹A/笔记1.md 存在', exists('文件夹A/笔记1.md'));
  assert('同名笔记生成 笔记1_2.md', exists('文件夹A/笔记1_2.md'));
  assert('深层 文件夹A/子文件夹/笔记2.md 存在', exists('文件夹A/子文件夹/笔记2.md'));
  assert('附件 文件B.pdf 存在', exists('文件B.pdf'));

  const n1 = fs.readFileSync(f('文件夹A/笔记1.md'), 'utf8');
  assert('笔记1 以 # 标题开头', /^# 笔记1/.test(n1), n1.slice(0, 30));
  assert('笔记1 图片已本地化为 笔记1_assets/image-001.png', n1.indexOf('笔记1_assets/image-001.png') >= 0, n1);
  assert('图片文件已落盘', exists('文件夹A/笔记1_assets/image-001.png'));

  const n1b = fs.readFileSync(f('文件夹A/笔记1_2.md'), 'utf8');
  assert('无标题笔记自动补 # 标题', /^# 笔记1/.test(n1b), n1b.slice(0, 30));

  const all = fs.readdirSync(outDir, { recursive: true }).map(String);
  assert('无临时目录残留', !all.some((x) => x.indexOf('tnd-ima-tmp') >= 0), JSON.stringify(all.filter((x) => x.indexOf('tnd-ima-tmp') >= 0)));

  console.log('\n【9】凭据缺失');
  const noCfg = await imaApi.listKnowledgeBases({ clientId: '', apiKey: '' });
  assert('无凭据返回失败', !noCfg.ok && /凭据/.test(noCfg.reason || ''), noCfg.reason);

  console.log('\n────────────────────────────');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  server.close();
  process.exit(fail ? 1 : 0);
});
