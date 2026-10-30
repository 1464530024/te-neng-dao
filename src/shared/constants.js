'use strict';

/** 应用元信息 */
const APP_NAME = '特能导';
const APP_ID = 'com.yanqu.tenengdao';
const APP_SLOGAN = '链接一贴，内容到手';

/**
 * 平台定义。match 为域名/URL 正则，按数组顺序优先匹配，generic 必须放最后。
 * needsLogin 表示该平台通常需要登录态，缺失时给出提示。
 * scrollRounds / extraAction 由注入脚本执行，用于触发懒加载。
 */
const PLATFORM_DEFS = [
  {
    key: 'ima',
    name: 'IMA 知识库',
    desc: '腾讯 IMA 知识库分享链接，可读取目录与子文件夹下的全部文档',
    match: [/ima\.qq\.com/i, /ima\.copilot/i, /imatool\.qq\.com/i],
    accent: '#2f7cf6',
    needsLogin: true,
    scrollRounds: 6,
    expandAll: true
  },
  {
    key: 'wechat',
    name: '微信公众号',
    desc: '公众号图文，保留原始排版、图片与代码块',
    match: [/mp\.weixin\.qq\.com/i],
    accent: '#07c160',
    needsLogin: false,
    scrollRounds: 3
  },
  {
    key: 'zhihu',
    name: '知乎',
    desc: '知乎问答、专栏文章、想法',
    match: [/zhihu\.com/i],
    accent: '#0084ff',
    needsLogin: false,
    scrollRounds: 4,
    expandAll: true
  },
  {
    key: 'xiaohongshu',
    name: '小红书',
    desc: '小红书笔记图文',
    match: [/xiaohongshu\.com/i, /xhslink\.com/i],
    accent: '#ff2442',
    needsLogin: true,
    scrollRounds: 3
  },
  {
    key: 'news',
    name: '新闻资讯站',
    desc: '澎湃、新华、人民、网易、腾讯、头条等新闻正文',
    match: [
      /thepaper\.cn/i, /xinhuanet\.com/i, /news\.cn/i, /people\.com\.cn/i,
      /163\.com/i, /qq\.com/i, /sina\.com\.cn/i, /sina\.cn/i, /toutiao\.com/i,
      /jiemian\.com/i, /36kr\.com/i, /ifeng\.com/i, /cctv\.com/i, /chinanews\.com\.cn/i,
      /huanqiu\.com/i, /guancha\.cn/i, /caixin\.com/i, /yicai\.com/i, /stcn\.com/i,
      /eastday\.com/i, /sohu\.com/i, /baijiahao\.baidu\.com/i, /baidu\.com/i,
      /zhihu\.com\/question/i, /cnbeta\.com/i, /ithome\.com/i, /geekpark\.net/i
    ],
    accent: '#e8453c',
    needsLogin: false,
    scrollRounds: 3
  },
  {
    key: 'generic',
    name: '通用网页',
    desc: '未指定平台的任意网站，自动识别正文区域',
    match: [/[\s\S]*/],
    accent: '#5b6472',
    needsLogin: false,
    scrollRounds: 3
  }
];

/** 平台简称：用于链接输入行右侧的类型标签 */
const PLATFORM_SHORT = {
  ima: 'IMA',
  wechat: '公众号',
  zhihu: '知乎',
  xiaohongshu: '小红书',
  news: '新闻',
  generic: '网页'
};
PLATFORM_DEFS.forEach((p) => { p.short = p.short || PLATFORM_SHORT[p.key] || p.name; });

const PLATFORM_MAP = PLATFORM_DEFS.reduce((acc, p) => {
  acc[p.key] = p;
  return acc;
}, {});

/* ───────── 直接指向文件的链接识别 ───────── */

/** 这些后缀说明 URL 本身就是一份文件，应当「直接下载」而不是当网页解析 */
const FILE_URL_TYPES = {
  archive: {
    short: '压缩包', accent: '#d98207',
    exts: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst']
  },
  document: {
    short: '文档', accent: '#0b5bc4',
    exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'tsv',
      'rtf', 'epub', 'mobi', 'json', 'xml', 'pages', 'numbers', 'key', 'wps', 'et', 'dps']
  },
  file: {
    short: '文件', accent: '#7b879a',
    exts: ['exe', 'msi', 'apk', 'ipa', 'dmg', 'pkg', 'deb', 'rpm', 'iso', 'psd', 'ai',
      'sketch', 'fig', 'srt', 'ass', 'vtt', 'lrc', 'torrent', 'sql', 'db', 'bin', 'dat', 'ttf', 'otf']
  }
};

const FILE_URL_INDEX = (() => {
  const m = {};
  Object.keys(FILE_URL_TYPES).forEach((kind) => {
    FILE_URL_TYPES[kind].exts.forEach((e) => { m[e] = kind; });
  });
  return m;
})();

/**
 * 判断链接是否直接指向一份可下载的文件。
 * @returns {{kind:string, short:string, accent:string, ext:string}|null}
 */
function detectFileUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const clean = url.split('#')[0].split('?')[0].trim();
  const m = clean.match(/\.([a-z0-9]{1,6})$/i);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  const kind = FILE_URL_INDEX[ext];
  if (!kind) return null;
  const t = FILE_URL_TYPES[kind];
  return { kind, short: t.short + ' · ' + ext.toUpperCase(), accent: t.accent, ext };
}

/** 统一给出一个链接的展示标签（平台简称 或 文件类型） */
function linkLabel(url) {
  const f = detectFileUrl(url);
  if (f) return { text: f.short, accent: f.accent, isFile: true, fileKind: f.kind, ext: f.ext };
  const p = detectPlatform(url);
  return { text: p.short || p.name, accent: p.accent, isFile: false, platform: p.key };
}

/** 依据 URL 判定平台 */
function detectPlatform(url) {
  if (!url || typeof url !== 'string') return PLATFORM_MAP.generic;
  for (const p of PLATFORM_DEFS) {
    if (p.match.some((re) => re.test(url))) return p;
  }
  return PLATFORM_MAP.generic;
}

/** 从任意文本中提取所有 http(s) 链接，去重保序 */
function extractUrls(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s"'<>）)】\]，,、；;]+/gi;
  const found = String(text).match(re) || [];
  const cleaned = found.map((u) => u.replace(/[.,;:!?。，、；：！？]+$/, ''));
  const seen = new Set();
  const out = [];
  for (const u of cleaned) {
    const key = u.replace(/\/$/, '');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(u);
    }
  }
  return out;
}

const EXPORT_FORMATS = [
  { key: 'pdf', name: 'PDF', desc: '版式与网页完全一致，适合存档与打印', ext: '.pdf' },
  { key: 'markdown', name: 'Markdown', desc: '纯文本结构化，适合二次编辑与入库', ext: '.md' },
  { key: 'docx', name: 'Word', desc: '可编辑文档，保留标题层级与表格', ext: '.docx' },
  { key: 'html', name: 'HTML', desc: '带样式的单文件网页，图片已内嵌', ext: '.html' },
  { key: 'txt', name: 'TXT', desc: '纯文本正文，体积最小、兼容性最好', ext: '.txt' },
  { key: 'json', name: 'JSON', desc: '结构化数据（标题/作者/大纲/正文），适合喂给 AI', ext: '.json' },
  { key: 'csv', name: 'CSV 清单', desc: '多篇文档的标题、字数、来源汇总成一张表', ext: '.csv' }
];

/** 内置浏览器可选的搜索引擎（%s 为关键词占位符） */
const SEARCH_ENGINES = [
  { key: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=%s' },
  { key: 'bing', name: '必应', url: 'https://cn.bing.com/search?q=%s' },
  { key: 'sogou', name: '搜狗', url: 'https://www.sogou.com/web?query=%s' },
  { key: 'so360', name: '360 搜索', url: 'https://www.so.com/s?q=%s' },
  { key: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s', overseas: true },
  { key: 'zhihu', name: '知乎', url: 'https://www.zhihu.com/search?type=content&q=%s' },
  { key: 'bilibili', name: '哔哩哔哩', url: 'https://search.bilibili.com/all?keyword=%s' },
  { key: 'weixin', name: '微信搜索', url: 'https://weixin.sogou.com/weixin?type=2&query=%s' },
  { key: 'custom', name: '自定义', url: '' }
];

/** 内置浏览器首页预设 */
const BROWSER_HOME_PRESETS = [
  { name: '百度', url: 'https://www.baidu.com/' },
  { name: '必应', url: 'https://cn.bing.com/' },
  { name: 'IMA 知识库', url: 'https://ima.qq.com/' },
  { name: '微信公众号', url: 'https://mp.weixin.qq.com/' },
  { name: '知乎', url: 'https://www.zhihu.com/' },
  { name: '小红书', url: 'https://www.xiaohongshu.com/' },
  { name: '澎湃新闻', url: 'https://www.thepaper.cn/' }
];

/**
 * 嗅探资源分类。
 * 明确排除视频与音频（用户需求），并过滤掉网页自身的 html/css/js 与字体，
 * 只保留真正值得下载的文件。
 */
const SNIFF_KINDS = [
  { key: 'image', name: '图片' },
  { key: 'doc', name: '文档' },
  { key: 'zip', name: '压缩包' },
  { key: 'file', name: '其他文件' }
];

const DEFAULT_SETTINGS = {
  outDir: '',
  groupByPlatform: true,
  groupByDate: false,
  formats: ['pdf', 'markdown', 'docx'],
  concurrency: 3,
  timeout: 60000,
  autoRetry: 1,
  imageMode: 'embed',
  pageSize: 'A4',
  previewBeforeExport: true,
  keepOriginalStyle: true,
  theme: 'light',
  notifySound: true,
  notifyBadge: true,
  minimizeToTray: false,
  userAgentMode: 'auto',
  customUA: '',
  proxyEnabled: false,
  proxyRules: '',
  fileNameTemplate: '{title}',
  plugins: [],

  /* 内置浏览器 */
  browserHomeUrl: 'https://www.baidu.com/',
  browserSearchEngine: 'baidu',
  browserSearchEngineCustom: '',
  browserOpenHomeOnStart: true,

  /* 资源嗅探 */
  sniffKinds: ['image', 'doc', 'zip', 'file'],
  sniffAutoScanDom: true,

  /* IMA 开放接口（到 ima.qq.com/agent-interface 申请） */
  imaOpenApi: {
    clientId: '',
    apiKey: ''
  }
};

const TASK_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELED: 'canceled',
  PARTIAL: 'partial',
  /** 应用退出时尚未跑完的任务，下次启动恢复为这个状态 */
  INTERRUPTED: 'interrupted'
};

/** 依据设置组装搜索 URL */
function buildSearchUrl(keyword, settings) {
  const s = settings || {};
  const kw = encodeURIComponent(String(keyword || '').trim());
  const key = s.browserSearchEngine || 'baidu';
  const engine = SEARCH_ENGINES.find((e) => e.key === key);
  let tpl = engine ? engine.url : '';
  if (key === 'custom') tpl = s.browserSearchEngineCustom || 'https://www.baidu.com/s?wd=%s';
  if (!tpl) tpl = 'https://www.baidu.com/s?wd=%s';
  return tpl.includes('%s') ? tpl.replace('%s', kw) : tpl + kw;
}

/** 判断输入是网址还是搜索词 */
function looksLikeUrl(input) {
  const t = String(input || '').trim();
  if (!t) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;   // 带协议
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return true;
  if (/\s/.test(t)) return false;                        // 含空格视为搜索词
  // 域名形态：xxx.yyy（含至少一个点，且点两侧有内容，顶级域 2-24 位字母）
  if (/^[\w-]+(\.[\w-]+)*\.[a-z]{2,24}(:\d+)?(\/.*)?$/i.test(t)) return true;
  return false;
}

module.exports = {
  APP_NAME,
  APP_ID,
  APP_SLOGAN,
  PLATFORM_DEFS,
  PLATFORM_MAP,
  detectPlatform,
  extractUrls,
  EXPORT_FORMATS,
  DEFAULT_SETTINGS,
  TASK_STATUS,
  SEARCH_ENGINES,
  BROWSER_HOME_PRESETS,
  SNIFF_KINDS,
  buildSearchUrl,
  looksLikeUrl,
  detectFileUrl,
  linkLabel,
  FILE_URL_TYPES
};
