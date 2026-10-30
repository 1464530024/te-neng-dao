/**
 * 嗅探自检用的本地测试站点。
 * 重点覆盖：相对路径链接、各种文档类型、普通页面链接、音视频链接（应被排除）。
 * 用法：node scripts/mock-server.js [端口]
 */
'use strict';

const http = require('http');

const PORT = Number(process.argv[2]) || 18765;

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>资料下载中心（嗅探自检页）</title></head>
<body>
  <h1>资料下载中心</h1>

  <h2>相对路径文档（关键用例）</h2>
  <a href="/files/年度报告.pdf">年度报告.pdf</a>
  <a href="docs/合同模板.docx">合同模板.docx</a>
  <a href="./download/预算表.xlsx">预算表.xlsx</a>
  <a href="/dl/培训材料.zip">培训材料.zip</a>

  <h2>绝对路径与跨域</h2>
  <a href="http://127.0.0.1:${PORT}/files/白皮书.pdf">白皮书.pdf（绝对）</a>
  <a href="https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf">远程 PDF（w3.org）</a>

  <h2>其他文件</h2>
  <a href="/dl/setup.exe">安装程序.exe</a>
  <a href="/dl/subtitle.srt">字幕.srt</a>
  <a href="/dl/pack.tar.gz">打包 tar.gz</a>

  <h2>图片</h2>
  <img src="/img/logo.png" width="120" alt="logo">
  <img src="./img/banner.jpg" width="200" alt="banner">

  <h2>应当被排除</h2>
  <a href="/about.html">关于我们（普通页面）</a>
  <a href="/assets/app.js">脚本</a>
  <a href="/assets/style.css">样式</a>
  <a href="javascript:void(0)">JS 伪链接</a>
  <a href="#top">锚点</a>

  <h2>音视频（必须排除）</h2>
  <a href="/media/demo.mp4">演示视频.mp4</a>
  <a href="/media/song.mp3">背景音乐.mp3</a>
  <a href="/media/lecture.m3u8">直播流.m3u8</a>
</body></html>`;

/** 模拟知识库页面：三层嵌套目录（含子文件夹），用于验证递归深抓 */
const KB_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>模拟知识库</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; display: flex; }
  .catalog { width: 280px; border-right: 1px solid #e5e8ee; padding: 12px; min-height: 100vh; }
  .tree-node { padding: 6px 10px; border-radius: 6px; font-size: 14px; cursor: pointer; }
  .tree-node:hover { background: #f0f3f8; }
  .tree-node.folder { font-weight: 600; }
  .tree-node.file { padding-left: 26px; color: #444; }
  .children { display: none; }
  .tree-node.open > .children { display: block; }
  main { flex: 1; padding: 28px; max-width: 720px; }
</style></head>
<body>
  <div class="catalog">
    <div class="tree-node folder" aria-expanded="false">产品资料
      <div class="children">
        <div class="tree-node folder" aria-expanded="false">产品需求
          <div class="children">
            <div class="tree-node file" data-doc="需求文档v1">需求文档v1</div>
            <div class="tree-node file" data-doc="需求文档v2">需求文档v2</div>
          </div>
        </div>
        <div class="tree-node file" data-doc="产品白皮书">产品白皮书</div>
      </div>
    </div>
    <div class="tree-node folder" aria-expanded="false">技术文档
      <div class="children">
        <div class="tree-node file" data-doc="接口说明">接口说明</div>
        <div class="tree-node file" data-doc="部署手册">部署手册</div>
      </div>
    </div>
  </div>
  <main id="doc-content"><h1>请选择左侧文档</h1><p>这是模拟知识库，用于验证递归深抓。</p></main>
  <script>
    document.querySelectorAll('.tree-node.folder').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        el.classList.toggle('open');
        el.setAttribute('aria-expanded', el.classList.contains('open') ? 'true' : 'false');
      });
    });
    document.querySelectorAll('.tree-node.file').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var name = el.getAttribute('data-doc');
        document.getElementById('doc-content').innerHTML =
          '<h1>' + name + '</h1>' +
          '<p>' + name + ' 的正文内容。这是一段用于验证深抓逻辑的文本，长度经过设计，确保能够通过正文识别阈值。' +
          '内容涵盖产品设计、技术实现与运营推广等方面的说明，用来模拟真实知识库文档的段落结构。</p>' +
          '<p>第二段补充说明：本文档隶属于「' + name + '」这一条目，导出后应当保留其在目录树中的层级路径。</p>';
      });
    });
  </script>
</body></html>`;

const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
  gz: 'application/gzip',
  exe: 'application/octet-stream',
  srt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  m3u8: 'application/vnd.apple.mpegurl'
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url === '/kb') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(KB_PAGE);
    return;
  }

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  const ext = (url.split('.').pop() || '').toLowerCase();
  const type = MIME[ext];

  if (type) {
    const size = ext === 'png' ? 4096 : 2048;
    const body = Buffer.alloc(size, 65);
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(body.length),
      'content-disposition': 'inline'
    });
    res.end(body);
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><body>普通页面</body></html>');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('MOCK_SERVER_READY http://127.0.0.1:' + PORT + '/');
});
