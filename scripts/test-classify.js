/**
 * 嗅探类型过滤器单元测试。
 * 重点验证「只收图片/文档/压缩包/其他文件，绝不收视频音频」这条硬规则。
 * 用法：node scripts/test-classify.js
 */
'use strict';

const { classify } = require('../src/main/services/sniffer');

const C = (type, url, mime, size) =>
  classify(type, url, mime, size ? { 'content-length': String(size) } : null);

const cases = [
  /* ── 应当收录：图片 ── */
  ['image', C('Image', 'https://a.com/pic/1.jpg', 'image/jpeg', 40000), 'jpg 图片'],
  ['image', C('Image', 'https://a.com/p/a.webp?x=1', 'image/webp', 20000), 'webp 带参数'],
  ['image', C('Other', 'https://a.com/logo.svg', '', 3000), 'svg（DOM 扫描无 mime）'],
  ['image', C('Image', 'https://a.com/i.png#id=1', 'image/png', 9000), '带 hash 的图片'],

  /* ── 应当收录：文档 ── */
  ['doc', C('Other', 'https://a.com/x/report.pdf', 'application/pdf', 900000), 'pdf'],
  ['doc', C('Other', 'https://a.com/x/表格.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 50000), 'docx'],
  ['doc', C('Other', 'https://a.com/notes.txt', 'text/plain', 800), 'txt'],
  ['doc', C('Other', 'https://a.com/readme.md', '', 1200), 'md（仅扩展名）'],
  ['doc', C('Other', 'https://a.com/export.csv', '', 3000), 'csv'],
  ['doc', C('Other', 'https://a.com/api/list.json', 'application/json', 2000), 'json 文件'],

  /* ── 点击下载链接：CDP 会把这些上报为 Document 类型（早期版本在此全部漏抓） ── */
  ['doc', C('Document', 'https://a.com/files/report.pdf', 'application/pdf', 900000), '点击 PDF（type=Document）'],
  ['doc', C('Document', 'https://cdn.a.com/x/合同.docx', 'application/octet-stream', 50000), '点击 Word（octet-stream 兜底）'],
  ['zip', C('Document', 'https://a.com/dl/pkg.zip', 'application/octet-stream', 5000000), '点击压缩包（octet-stream 兜底）'],
  ['file', C('Document', 'https://a.com/dl/setup.exe', 'application/octet-stream', 8000000), '点击 exe（不能因 octet-stream 误判为压缩包）'],
  ['doc', C('XHR', 'https://a.com/export/data.xlsx', 'application/octet-stream', 30000), 'XHR 拉取的 xlsx'],

  /* ── 应当收录：压缩包 ── */
  ['zip', C('Other', 'https://a.com/pkg.zip', 'application/zip', 5000000), 'zip'],
  ['zip', C('Other', 'https://a.com/a.rar', '', 900000), 'rar（仅扩展名）'],
  ['zip', C('Other', 'https://a.com/b.tar.gz', '', 700000), 'tar.gz'],

  /* ── 应当收录：其他文件 ── */
  ['file', C('Other', 'https://a.com/setup.exe', '', 999), 'exe'],
  ['file', C('Other', 'https://a.com/app.apk', 'application/vnd.android.package-archive', 999), 'apk'],
  ['file', C('Other', 'https://a.com/design.psd', '', 999), 'psd'],
  ['file', C('Other', 'https://a.com/sub.srt', '', 999), 'srt 字幕'],

  /* ── 必须排除：视频 ── */
  [null, C('Media', 'https://a.com/v/movie.mp4', 'video/mp4', 999), 'mp4'],
  [null, C('Other', 'https://a.com/hls/index.m3u8', 'application/vnd.apple.mpegurl', 999), 'm3u8'],
  [null, C('Media', 'https://a.com/seg/1.ts', 'video/mp2t', 999), 'ts 分片'],
  [null, C('Media', 'https://a.com/clip.webm', 'video/webm', 999), 'webm'],
  [null, C('Other', 'https://a.com/stream', 'video/mp4', 999), '无扩展名但 MIME 是 video'],

  /* ── 必须排除：音频 ── */
  [null, C('Media', 'https://a.com/m/song.mp3', 'audio/mpeg', 999), 'mp3'],
  [null, C('Other', 'https://a.com/voice.m4a', 'audio/mp4', 999), 'm4a'],
  [null, C('Media', 'https://a.com/bgm.flac', 'audio/flac', 999), 'flac'],
  [null, C('Other', 'https://a.com/audio', 'audio/mpeg', 999), '无扩展名但 MIME 是 audio'],

  /* ── 必须排除：网页自身资源与噪音 ── */
  [null, C('Document', 'https://a.com/index.html', 'text/html', 999), 'html 页面'],
  [null, C('Script', 'https://a.com/app.js', 'application/javascript', 999), 'js'],
  [null, C('Stylesheet', 'https://a.com/style.css', 'text/css', 999), 'css'],
  [null, C('Font', 'https://a.com/f.woff2', 'font/woff2', 999), 'woff2 字体'],
  [null, C('XHR', 'https://a.com/api/feed', 'application/json', 999), '接口请求（无扩展名）'],
  [null, C('Image', 'https://a.com/1x1.gif', 'image/gif', 500), '1×1 统计像素（体积过小）'],
  [null, C('Other', 'data:image/png;base64,AAA', 'image/png', 100), 'data URI'],
  [null, C('Other', '', 'image/png', 100), '空 URL']
];

let pass = 0;
const fails = [];

cases.forEach(([expect, got, label]) => {
  const gotKind = got ? got.kind : null;
  if (gotKind === expect) {
    pass += 1;
  } else {
    fails.push(`${label}  期望=${expect}  实际=${gotKind}`);
  }
});

const excluded = cases.filter((c) => c[0] === null).length;
const mediaCases = cases.filter((c) => /mp4|m3u8|ts 分片|webm|video|mp3|m4a|flac|audio/.test(c[2])).length;

console.log(`用例总数: ${cases.length}　通过: ${pass}　失败: ${fails.length}`);
console.log(`其中「必须排除」用例: ${excluded}（含音视频 ${mediaCases} 条）`);

if (fails.length) {
  console.log('\n失败明细：');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('\n✓ 全部通过：图片/文档/压缩包/其他文件正常收录，视频与音频均被正确排除。');
