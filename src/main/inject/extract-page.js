/* eslint-disable */
/**
 * 页面注入提取脚本。
 * 运行环境：目标网页的主世界（main world），由 executeJavaScript 注入。
 * 约束：必须自包含、不得依赖 Node/Electron API、返回值必须可 JSON 序列化。
 * 由主进程拼接 Readability 源码后整体注入，最终执行 window.__TND_EXTRACT__()。
 */
/* ═══════════════════════════════════════════════════════════════════════
   目录树 API —— 顶层注册，不依赖 __TND_EXTRACT__ 是否被调用过。

   知识库、网盘、文档中心这类页面左侧通常是一棵目录树。不同产品的 DOM
   千差万别，这里用一组启发式规则识别：
     · 先从「像目录容器」的元素里选定树根（并要求它位于页面左侧）
     · 再从中收集节点；层级优先用 DOM 嵌套推导，退化时用左缩进像素估算
   这是有意为之的宽松实现 —— 抓不全比抓错更麻烦，所以宁可多列候选，
   由上层通过「点击后内容是否变化」来最终判定。
   ═══════════════════════════════════════════════════════════════════════ */
(function initTreeApi() {
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const txt = (el) => (el ? (el.innerText || el.textContent || '') : '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const H = window.__TND_TREE_HOOKS__ || {};

  const TREE_ITEM_SEL = 'li,[role="treeitem"],[class*="tree-item"],[class*="treeItem"],[class*="tree-node"],[class*="catalog-item"],[class*="file-item"],[class*="doc-item"],[class*="list-item"],[class*="node"]';
  const TREE_ROOT_SELS = [
    '[class*="catalog"]', '[class*="directory"]', '[class*="tree"]', '[class*="file-list"]',
    '[class*="fileList"]', '[class*="doc-list"]', '[class*="knowledge"]', '[role="tree"]',
    '[class*="sidebar"]', 'aside'
  ];

  function findTreeRoot() {
    const vw = window.innerWidth || 1200;
    for (const sel of TREE_ROOT_SELS) {
      let nodes = [];
      try { nodes = $$(sel); } catch (e) { continue; }
      for (const n of nodes) {
        if (n.offsetParent === null) continue;

        // 目录树几乎总在页面左侧。这条约束能有效排除正文里的列表，
        // 避免在普通文章页上误判出「目录」并触发无意义的深抓。
        let rect = null;
        try { rect = n.getBoundingClientRect(); } catch (e) { rect = null; }
        if (rect && rect.left > vw * 0.55) continue;

        let items = [];
        try { items = $$(TREE_ITEM_SEL, n); } catch (e) { continue; }
        if (items.length >= 2) return n;
      }
    }
    return null;
  }

  function isFolderEl(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    const aria = el.getAttribute && el.getAttribute('aria-expanded');
    if (aria === 'true' || aria === 'false') return true;
    if (/folder|dir(ectory)?[-_ ]|catalog[-_]?group|isFolder/i.test(cls)) return true;
    if (el.querySelector && el.querySelector('[class*="folder"],[class*="arrow"],[class*="caret"],[class*="expand"]')) return true;
    return false;
  }

  function indentOf(el) {
    try {
      const cs = getComputedStyle(el);
      return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.marginLeft) || 0);
    } catch (e) {
      return 0;
    }
  }

  /**
   * 节点层级。
   * 优先用 DOM 嵌套推导；遇到「扁平 DOM + 缩进表示层级」的树时退化到缩进，
   * 并且必须**减去容器内最小缩进作为基准** —— 否则最外层节点会因为
   * 自身普通的 padding（比如 10px）被误算成第 1 层，导致路径前面多出一段空层级。
   */
  function treeDepth(el, root, baseIndent) {
    let d = 0;
    let p = el.parentElement;
    let nested = false;
    while (p && p !== root) {
      if (p.matches && p.matches(TREE_ITEM_SEL)) { d += 1; nested = true; }
      p = p.parentElement;
    }
    if (nested) return d;

    const base = baseIndent || 0;
    return Math.max(0, Math.round((indentOf(el) - base) / 16));
  }

  function collectTreeItems() {
    const root = findTreeRoot();
    if (!root) return { root: null, items: [] };

    let els = [];
    try { els = $$(TREE_ITEM_SEL, root); } catch (e) { els = []; }

    let baseIndent = Infinity;
    els.forEach((el) => { const px = indentOf(el); if (px < baseIndent) baseIndent = px; });
    if (!isFinite(baseIndent)) baseIndent = 0;

    const raw = els
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        // 只取该节点自身的标题，绝不能把整棵子树的文字算进来。
        // 先找明确的标题子元素；找不到就只拼接**直接文本节点**（跳过子元素）。
        const own = (() => {
          let t = null;
          try {
            t = el.querySelector(':scope > [class*="title"], :scope > [class*="name"], :scope > a, :scope > span');
          } catch (e) { t = null; }
          if (t && txt(t).trim()) return txt(t);

          let s = '';
          el.childNodes.forEach((node) => {
            if (node.nodeType === 3) s += node.textContent;
          });
          if (s.trim()) return s;

          const first = el.firstElementChild;
          return first ? txt(first) : txt(el);
        })();
        return {
          el,
          title: own.replace(/\s+/g, ' ').trim(),
          depth: treeDepth(el, root, baseIndent),
          isFolder: isFolderEl(el),
          expanded: el.getAttribute('aria-expanded')
        };
      })
      .filter((n) => n.title && n.title.length >= 1 && n.title.length <= 110);

    // 去掉「同样的标题、同样的层级、且被另一个节点包含」的冗余项
    const items = [];
    raw.forEach((n) => {
      const dup = raw.some((m) => m !== n && m.title === n.title && m.depth === n.depth && m.el.contains(n.el));
      if (dup) return;
      items.push({
        title: n.title,
        depth: n.depth,
        isFolder: n.isFolder,
        expanded: n.expanded,
        el: n.el
      });
    });

    // 由 depth 推导路径（栈式回溯）
    const stack = [];
    items.forEach((it) => {
      stack.length = Math.min(stack.length, it.depth);
      stack[it.depth] = it.title;
      it.path = stack.slice(0, it.depth + 1).join('/');
    });

    return { root, items };
  }

  window.__TND_TREE__ = {
    collect: collectTreeItems,

    /** 可序列化的节点列表 */
    list() {
      return collectTreeItems().items.map((it) => ({
        title: it.title,
        depth: it.depth,
        path: it.path,
        isFolder: it.isFolder,
        expanded: it.expanded
      }));
    },

    /** 点击节点：按完整路径精确定位，退化到标题匹配 */
    click(path, title) {
      const { items } = collectTreeItems();
      let target = items.find((it) => it.path === path);
      if (!target) {
        const same = items.filter((it) => it.title === title);
        target = same.find((it) => !it.isFolder) || same[0];
      }
      if (!target) return false;
      try {
        target.el.scrollIntoView({ block: 'center' });
        target.el.click();
        return true;
      } catch (e) {
        return false;
      }
    },

    /**
     * 递归展开所有折叠的文件夹。
     * 每一轮都重新扫描 —— 展开上层会带出下层的新节点，
     * 必须反复扫到节点数不再增长为止（只扫一次只能拿到第一层）。
     */
    async expand(maxRounds) {
      const rounds = Math.max(1, Math.min(20, maxRounds || 12));
      let prevCount = -1;
      let lastCount = 0;
      const trace = [];

      for (let r = 0; r < rounds; r++) {
        const { items } = collectTreeItems();
        lastCount = items.length;

        const collapsed = items.filter((it) => it.isFolder && it.expanded !== 'true');
        trace.push({ r: r, items: lastCount, collapsed: collapsed.length });

        if (!collapsed.length) break;
        if (lastCount === prevCount) break;
        prevCount = lastCount;

        let clicked = 0;
        for (const it of collapsed) {
          try {
            it.el.click();
            // 标记为已展开：有些树不通过 aria 表达状态，
            // 不标记的话下一轮还会重复点它，来回折叠导致节点数永远不变。
            it.el.setAttribute('aria-expanded', 'true');
            clicked += 1;
            await sleep(150);
          } catch (e) { /* ignore */ }
        }
        trace[trace.length - 1].clicked = clicked;
        await sleep(400);
        if (H.onRound) { try { H.onRound(r, lastCount); } catch (e) { /* ignore */ } }
      }

      const finalItems = collectTreeItems().items;
      return {
        rounds: rounds,
        nodes: finalItems.length,
        folders: finalItems.filter((i) => i.isFolder).length,
        files: finalItems.filter((i) => !i.isFolder).length,
        trace: trace
      };
    }
  };

  // 兼容按函数名直接调用的写法
  window.__TND_TREE_LIST__ = () => window.__TND_TREE__.list();
  window.__TND_TREE_CLICK__ = (p, t) => window.__TND_TREE__.click(p, t);
  window.__TND_TREE_EXPAND__ = (n) => window.__TND_TREE__.expand(n);
})();

window.__TND_EXTRACT__ = async function TND_EXTRACT() {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // 目录树 API 由顶层 IIFE 注册；这里做一次安全包装，避免因加载顺序问题抛错
  const treeApi = () => window.__TND_TREE__ || {
    collect: () => ({ root: null, items: [] }),
    list: () => [],
    click: () => false,
    expand: async () => null
  };

  const abs = (u) => {
    try { return new URL(u, location.href).href; } catch (e) { return u || ''; }
  };
  const clean = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/[\t\r]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const textOf = (el) => (el ? clean(el.innerText || el.textContent || '') : '');

  /**
   * 轻量取文本：innerText 会强制同步重排，在超大页面上反复调用会拖垮整个提取
   * （实测让单页提取从 3 秒劣化到 100 秒以上）。凡是「判断有没有内容」的场景一律用这个。
   */
  const leanText = (el) => (el ? (el.textContent || '') : '');
  const leanLen = (el) => leanText(el).replace(/\s+/g, ' ').trim().length;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PHASES = {};

  /** 选择第一个「有实质内容」的候选容器（用 leanLen，避免重排） */
  function pickFirst(selectors, minLen) {
    const floor = minLen || 60;
    for (const sel of selectors) {
      let nodes = [];
      try { nodes = $$(sel); } catch (e) { continue; }
      // 同一选择器命中多个时只考察前 6 个，避免在列表页上做无谓遍历
      const limited = nodes.length > 6 ? nodes.slice(0, 6) : nodes;
      for (const el of limited) {
        if (leanLen(el) >= floor) return el;
      }
    }
    return null;
  }

  function hostKey() {
    return location.hostname.replace(/^www\./, '');
  }

  /** 依据当前 URL 猜测平台 */
  function guessPlatform() {
    const h = location.href;
    if (/ima\.qq\.com|ima\.copilot|imatool/i.test(h)) return 'ima';
    if (/mp\.weixin\.qq\.com/i.test(h)) return 'wechat';
    if (/zhihu\.com/i.test(h)) return 'zhihu';
    if (/xiaohongshu\.com|xhslink\.com/i.test(h)) return 'xiaohongshu';
    if (/thepaper\.cn|xinhuanet|news\.cn|people\.com\.cn|163\.com|sina\.|toutiao|jiemian|36kr|ifeng|cctv|chinanews|huanqiu|guancha|caixin|yicai|stcn|sohu\.com|baijiahao|ithome|cnbeta|geekpark/i.test(h)) return 'news';
    return 'generic';
  }

  /** 轮询等待 body 出现实质文本（用 textContent，避免 innerText 反复触发布局） */
  async function waitForContent(maxMs) {
    const deadline = Date.now() + (maxMs || 12000);
    let last = 0, stable = 0;
    while (Date.now() < deadline) {
      let len = 0;
      try {
        len = document.body ? (document.body.textContent || '').length : 0;
      } catch (e) { len = 0; }
      if (len > 400) {
        if (Math.abs(len - last) < 40) { stable++; if (stable >= 2) return len; }
        else { stable = 0; }
      }
      last = len;
      await sleep(320);
    }
    return last;
  }

  /**
   * 自动滚动，触发懒加载与无限列表。
   * 关键：高度必须一次性快照，否则无限滚动页面会让循环永不结束（历史 bug）。
   */
  async function autoScroll(rounds) {
    const n = Math.max(0, Math.min(12, rounds | 0));
    let lastH = 0;
    for (let i = 0; i < n; i++) {
      const h = document.documentElement.scrollHeight;
      window.scrollTo(0, h);
      await sleep(420);
      if (h === lastH && i >= 1) break;
      lastH = h;
    }

    // 小步扫描：上限 24 步，且高度取当前快照，避免无限增长导致死循环
    const step = Math.max(400, Math.round(window.innerHeight * 0.9));
    const snapshot = Math.min(document.documentElement.scrollHeight, step * 24);
    for (let y = 0; y < snapshot; y += step) {
      window.scrollTo(0, y);
      await sleep(90);
    }
    window.scrollTo(0, 0);
    await sleep(200);
  }

  /** 展开所有「展开/更多/查看全部」按钮（限定扫描量，避免超大页面卡顿） */
  async function expandAll(maxClicks) {
    const limit = maxClicks || 14;
    const kw = /展开|查看更多|显示全部|阅读全文|点击查看|全部回复|查看全部|更多内容|展开全文/;
    const pool = $$('button, a, [role="button"]').slice(0, 500);
    const cands = pool.filter((el) => {
      if (el.children.length > 2) return false;
      if (el.offsetParent === null) return false;
      const t = leanText(el).trim();
      return t.length > 0 && t.length <= 14 && kw.test(t);
    }).slice(0, limit);
    for (const el of cands) {
      try { el.click(); await sleep(200); } catch (e) { /* ignore */ }
    }
  }

  /** 图片懒加载属性归一化 */
  function normalizeImages(root) {
    const attrs = ['data-src', 'data-original', 'data-actualsrc', 'data-lazy-src', 'data-lazyload', 'data-echo', 'data-url', 'data-original-src'];
    $$('img', root).forEach((img) => {
      let src = img.getAttribute('src') || '';
      if (!src || /^data:image\/gif|^data:image\/svg|placeholder|blank\.gif|spacer/i.test(src)) {
        for (const a of attrs) {
          const v = img.getAttribute(a);
          if (v) { src = v; break; }
        }
      }
      for (const a of attrs) {
        const v = img.getAttribute(a);
        if (v && (!src || /^data:image\/gif/i.test(src))) src = v;
        img.removeAttribute(a);
      }
      if (src) img.setAttribute('src', abs(src));
      img.removeAttribute('srcset');
      img.removeAttribute('loading');
      img.removeAttribute('decoding');
      const wh = img.getAttribute('data-w') || img.getAttribute('width');
      if (wh && !img.getAttribute('width')) img.setAttribute('width', wh);
    });
    // picture > source 全部删除，避免导出时选错源
    $$('picture source', root).forEach((s) => s.remove());
    return root;
  }

  /** 移除脚本、样式、广告、推荐位等噪音 */
  function sanitize(root, opts) {
    const o = opts || {};
    const kill = 'script,noscript,style,link,meta,iframe,video[autoplay],.adsbygoogle,[class*="advert"],[id*="advert"],[class*="google-ad"],[class*="-ad-"],[class*="recommend"],[class*="related"],[class*="hot-list"],[class*="comment"],[id*="comment"],[class*="share-bar"],[class*="toolbar"],[class*="qrcode"],[class*="footer"],[class*="sidebar"],[class*="app-download"],[class*="guide-download"]';
    try { $$(kill, root).forEach((el) => el.remove()); } catch (e) { /* ignore */ }
    if (!o.keepEmpty) {
      $$('p,div,section', root).forEach((el) => {
        if (!el.children.length && !textOf(el) && !el.querySelector('img,video')) el.remove();
      });
    }
    $$('*', root).forEach((el) => {
      ['onclick', 'onload', 'onerror', 'data-callback'].forEach((a) => el.removeAttribute && el.removeAttribute(a));
    });
    return root;
  }

  /** Readability 兜底提取 */
  function readable() {
    try {
      if (typeof Readability !== 'function' && typeof window.Readability !== 'function') return null;
      const Ctor = typeof Readability === 'function' ? Readability : window.Readability;
      const doc = document.cloneNode(true);
      const art = new Ctor(doc, { charThreshold: 120, keepClasses: true, disableJSONLD: false }).parse();
      if (art && art.content && clean(art.textContent || '').length > 120) return art;
    } catch (e) { /* ignore */ }
    return null;
  }

  function meta() {
    const m = (n) => {
      const el = $('meta[property="' + n + '"]') || $('meta[name="' + n + '"]');
      return el ? el.getAttribute('content') || '' : '';
    };
    const ld = $$('script[type="application/ld+json"]').map((s) => {
      try { return JSON.parse(s.textContent); } catch (e) { return null; }
    }).filter(Boolean);
    let ldTitle = '', ldAuthor = '', ldDate = '';
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o.headline && !ldTitle) ldTitle = String(o.headline);
      if (o.datePublished && !ldDate) ldDate = String(o.datePublished);
      if (o.author) {
        const a = Array.isArray(o.author) ? o.author[0] : o.author;
        if (a && !ldAuthor) ldAuthor = typeof a === 'string' ? a : (a.name || '');
      }
      ['@graph', 'mainEntity', 'articleBody'].forEach((k) => o[k] && walk(o[k]));
    };
    ld.forEach(walk);
    return {
      ogTitle: m('og:title') || ldTitle,
      ogDescription: m('og:description') || m('description'),
      ogImage: m('og:image') || m('twitter:image'),
      ogSite: m('og:site_name'),
      ogType: m('og:type'),
      author: m('author') || ldAuthor,
      publishTime: m('article:published_time') || m('og:release_date') || ldDate || m('pubdate'),
      keywords: m('keywords')
    };
  }

  /** 从页面文本中猜测作者与时间（只取前若干字符，避免整页取样） */
  function guessAuthorTime(scope) {
    const t = leanText(scope).replace(/\s+/g, ' ').slice(0, 1600);
    let author = '';
    let time = '';
    const dateRe = /(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})日?\s*(\d{1,2}:\d{2})?/;
    const dm = t.match(dateRe);
    if (dm) time = dm[0].replace(/[/.]/g, '-').replace(/[年月]/g, '-').replace('日', '');
    const am = t.match(/(?:作者|文\s*\/|撰文|来源|编辑|发布于)\s*[:：]?\s*([^\s，。；,;]{2,16})/);
    if (am) author = am[1];
    return { author, time };
  }

  /**
   * 识别「登录墙 / 空页面 / 已删除」等无法提取的情形，给出可执行的中文提示。
   * 比笼统的“未能识别正文”有用得多 —— 用户知道下一步该做什么。
   */
  function detectBlockReason() {
    try {
      const raw = leanText(document.body);
      const compact = raw.replace(/\s+/g, '');
      const sample = compact.slice(0, 6000);

      if (/登录后(可|才能|继续|查看)|扫码登录|请先登录|立即登录|登录知乎|登录小红书|登录微博|打开APP查看|去APP查看|打开app查看|APP内打开|请登录后查看|需要登录/.test(sample)) {
        return '该页面需要登录后才能查看内容。请到「内置浏览器」打开同一网址完成登录，再回到这里重试。';
      }
      if (/该内容已被删除|内容不存在|页面不存在|文章已删除|404|访问的页面未找到/.test(sample) && compact.length < 1200) {
        return '页面提示内容不存在或已被删除，无法提取。';
      }
      if (/环境异常|请完成验证|安全验证|人机验证|滑动验证|访问过于频繁/.test(sample)) {
        return '站点触发了风控验证。请稍后再试，或到「内置浏览器」打开该页人工完成验证后，用右上角「解析此页」提取。';
      }
      if (compact.length < 120) {
        return '页面没有返回可提取的内容（可能是空页面、加载尚未完成，或该站点有反爬限制）。';
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  /** 收集页面内可继续抓取的关联链接（同域优先） */
  function collectLinks(scope, limit) {
    const seen = new Set();
    const host = location.hostname;
    const out = [];
    $$('a[href]', scope || document).forEach((a) => {
      const href = abs(a.getAttribute('href') || '');
      if (!/^https?:/i.test(href)) return;
      if (href.split('#')[0] === location.href.split('#')[0]) return;
      const title = textOf(a) || a.getAttribute('title') || '';
      if (title.length < 6 || title.length > 90) return;
      const same = (() => { try { return new URL(href).hostname === host; } catch (e) { return false; } })();
      if (!same) return;
      const key = href.split('#')[0];
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ title, href: key });
    });
    return out.slice(0, limit || 40);
  }

  // ─────────────────────────── 各平台提取器 ───────────────────────────

  const EXTRACTORS = {
    wechat() {
      const root = $('#js_content') || pickFirst(['.rich_media_content', '#js_content, .rich_media_content']);
      if (!root) return null;
      const title = textOf($('#activity-name')) || textOf($('h1.rich_media_title')) || meta().ogTitle;
      const author = textOf($('#js_name')) || textOf($('.rich_media_meta_nickname')) || meta().author;
      const time = textOf($('#publish_time')) || textOf($('#meta_content .rich_media_meta_text')) || meta().publishTime;
      const clone = root.cloneNode(true);
      normalizeImages(clone);
      sanitize(clone);
      return {
        contentEl: clone,
        title: clean(title) || document.title,
        author: clean(author),
        publishTime: clean(time),
        cover: meta().ogImage
      };
    },

    zhihu() {
      let root =
        pickFirst(['.Post-RichTextContainer .RichText', '.Post-RichTextContainer', '.AnswerItem .RichContent-inner .RichText', '.RichContent-inner', '.QuestionRichText', '.RichText.ztext']) ||
        pickFirst(['article .RichText', 'article']);
      if (!root) return null;
      const title = textOf($('h1.Post-Title')) || textOf($('.QuestionHeader-title')) || meta().ogTitle || document.title;
      const author = textOf($('.AuthorInfo-name')) || textOf($('.Post-Author .AuthorInfo-name a')) || meta().author;
      const time = ($('.ContentItem-time') && textOf($('.ContentItem-time'))) || meta().publishTime || '';
      const clone = root.cloneNode(true);
      normalizeImages(clone);
      sanitize(clone);
      return { contentEl: clone, title: clean(title), author: clean(author), publishTime: clean(time).replace(/^编辑于|^发布于\s*/, ''), cover: meta().ogImage };
    },

    xiaohongshu() {
      const descEl = pickFirst(['#detail-desc .note-text', '#detail-desc', '.note-content', '.desc', '.note-detail-mask .desc']);
      const title = textOf($('#detail-title')) || textOf($('.title')) || meta().ogTitle || document.title;
      const author = textOf($('.author-wrapper .username')) || textOf($('.username')) || meta().author;
      const time = textOf($('.date')) || meta().publishTime || '';
      const imgs = $$('.swiper-slide img, .note-slider img, .media-container img, .swiper img')
        .map((i) => abs(i.getAttribute('src') || i.getAttribute('data-src') || ''))
        .filter((u) => /^https?:/.test(u) && !/avatar|emoji/i.test(u));
      if (!descEl && !imgs.length && !title) return null;
      const wrap = document.createElement('div');
      wrap.className = 'xhs-note';
      const h = document.createElement('h1');
      h.textContent = clean(title);
      wrap.appendChild(h);
      if (descEl) {
        const clone = descEl.cloneNode(true);
        normalizeImages(clone);
        wrap.appendChild(clone);
      }
      const uniq = Array.from(new Set(imgs));
      if (uniq.length) {
        const gallery = document.createElement('div');
        gallery.className = 'xhs-gallery';
        uniq.forEach((u) => {
          const img = document.createElement('img');
          img.setAttribute('src', u);
          gallery.appendChild(img);
        });
        wrap.appendChild(gallery);
      }
      sanitize(wrap);
      return { contentEl: wrap, title: clean(title), author: clean(author), publishTime: clean(time), cover: meta().ogImage || uniq[0] || '' };
    },

    /**
     * IMA 知识库：DOM 结构随版本变化，这里做「结构化探测」——
     * 优先读取页面内被拦截到的接口数据，其次遍历目录树节点。
     */
    ima() {
      const api = window.__TND_API__ || [];
      const nodes = [];

      // 1) 从拦截到的 JSON 中抽取 文件/目录 结构
      const walkJson = (o, depth) => {
        if (!o || depth > 7) return;
        if (Array.isArray(o)) { o.forEach((x) => walkJson(x, depth + 1)); return; }
        if (typeof o !== 'object') return;
        const name = o.name || o.title || o.file_name || o.doc_name || o.fileName;
        const isDir = !!(o.children || o.is_folder || o.isFolder || o.type === 'folder' || o.type === 'directory');
        if (name && typeof name === 'string' && name.length < 120) {
          nodes.push({
            title: name.trim(),
            isFolder: isDir,
            id: String(o.id || o.file_id || o.doc_id || o.share_id || ''),
            url: o.url || o.share_url || o.link || '',
            children: o.children ? undefined : undefined
          });
        }
        Object.keys(o).forEach((k) => {
          const v = o[k];
          if (v && typeof v === 'object') walkJson(v, depth + 1);
        });
      };
      api.forEach((entry) => { try { walkJson(JSON.parse(entry.body), 0); } catch (e) { /* ignore */ } });

      // 2) DOM 目录树（带完整层级路径，供深抓时逐层定位）
      const tree = treeApi().collect();
      const domNodes = tree.items.map((it) => ({
        title: it.title,
        isFolder: it.isFolder,
        depth: it.depth,
        path: it.path,
        url: ''
      }));

      // 3) 正文（若当前已打开某篇文档）
      const bodyEl = pickFirst(['[class*="doc-content"]', '[class*="content-editor"]', '[class*="markdown-body"]', '[class*="article"]', 'article', 'main'], 120);
      let contentEl = null;
      if (bodyEl) {
        contentEl = bodyEl.cloneNode(true);
        normalizeImages(contentEl);
        sanitize(contentEl);
      } else {
        const art = readable();
        if (art) {
          const d = document.createElement('div');
          d.innerHTML = art.content;
          normalizeImages(d);
          sanitize(d);
          contentEl = d;
        }
      }

      const dedup = [];
      const seen = new Set();
      nodes.concat(domNodes).forEach((n) => {
        const k = n.title + '|' + (n.path || n.url || '');
        if (n.title && !seen.has(k)) { seen.add(k); dedup.push(n); }
      });

      return {
        contentEl,
        title: textOf($('h1')) || meta().ogTitle || document.title,
        author: textOf($('[class*="user-name"]')) || meta().author || '',
        publishTime: meta().publishTime || '',
        cover: meta().ogImage,
        directory: dedup,
        tree: {
          found: !!tree.root,
          nodes: tree.items.length,
          folders: tree.items.filter((i) => i.isFolder).length,
          files: tree.items.filter((i) => !i.isFolder).length
        },
        apiCount: api.length
      };
    },

    news() {
      const root = pickFirst([
        '.article-content', '.article_content', '.post_content', '.post_body', '.content_main',
        '#content', '#article', '#artibody', '.article-body', '.rich_media_content',
        '.article', 'article', '.main-content', '.detail-content', '.text', '.story'
      ]);
      const title = ($('h1') && textOf($('h1'))) || meta().ogTitle || document.title;
      const guessed = guessAuthorTime(root || document.body);
      const cleanTitle = clean(title);
      const clone = root
        ? (() => { const c = root.cloneNode(true); normalizeImages(c); sanitize(c); return c; })()
        : null;
      const contentText = clone ? textOf(clone) : '';
      const useReadability = !clone || contentText.length < 200;
      let finalEl = clone;
      let usedReadability = false;
      if (useReadability) {
        const art = readable();
        if (art) {
          const d = document.createElement('div');
          d.innerHTML = art.content;
          normalizeImages(d);
          sanitize(d);
          finalEl = d;
          usedReadability = true;
        }
      }
      if (!finalEl || textOf(finalEl).length < 60) return null;
      return {
        contentEl: finalEl,
        title: cleanTitle,
        author: meta().author || guessed.author,
        publishTime: meta().publishTime || guessed.time,
        cover: meta().ogImage,
        usedReadability
      };
    },

    generic() {
      // 优先套用用户为该域名配置的自定义解析规则
      const rule = (window.__TND_OPTS__ || {}).rule;
      if (rule && Array.isArray(rule.contentSelectors) && rule.contentSelectors.length) {
        const target = pickFirst(rule.contentSelectors, 40);
        if (target) {
          const clone = target.cloneNode(true);
          (rule.removeSelectors || []).forEach((sel) => {
            try { $$(sel, clone).forEach((n) => n.remove()); } catch (e) { /* ignore */ }
          });
          normalizeImages(clone);
          sanitize(clone);
          if (textOf(clone).length >= 40) {
            const guessed = guessAuthorTime(document.body);
            return {
              contentEl: clone,
              title: (rule.titleSelector && textOf($(rule.titleSelector))) || textOf($('h1')) || meta().ogTitle || document.title,
              author: (rule.authorSelector && textOf($(rule.authorSelector))) || meta().author || guessed.author,
              publishTime: (rule.timeSelector && textOf($(rule.timeSelector))) || meta().publishTime || guessed.time,
              cover: meta().ogImage,
              usedRule: true
            };
          }
        }
      }

      const art = readable();
      if (art) {
        const d = document.createElement('div');
        d.innerHTML = art.content;
        d.setAttribute('data-src-engine', 'readability');
        normalizeImages(d);
        sanitize(d);
        if (textOf(d).length >= 80) {
          const guessed = guessAuthorTime(document.body);
          return {
            contentEl: d,
            title: clean(art.title) || meta().ogTitle || document.title,
            author: meta().author || art.byline || guessed.author,
            publishTime: meta().publishTime || art.publishedTime || guessed.time,
            cover: meta().ogImage,
            usedReadability: true
          };
        }
      }
      const sel = pickFirst(['article', 'main', '#content', '.content', '.post', '.entry-content', '.markdown-body', '.article-body', '.story-body', '[class*="article-content"]', '[class*="post-content"]', '[class*="detail"]']);
      if (!sel) return null;
      const clone = sel.cloneNode(true);
      normalizeImages(clone);
      sanitize(clone);
      if (textOf(clone).length < 60) return null;
      const guessed = guessAuthorTime(document.body);
      return {
        contentEl: clone,
        title: textOf($('h1')) || meta().ogTitle || document.title,
        author: meta().author || guessed.author,
        publishTime: meta().publishTime || guessed.time,
        cover: meta().ogImage,
        usedReadability: false
      };
    }
  };

  // ─────────────────────────── 主流程 ───────────────────────────

  const started = Date.now();
  const platform = window.__TND_PLATFORM__ || guessPlatform();
  const opts = window.__TND_OPTS__ || {};

  const tick = (key, t0) => { PHASES[key] = Date.now() - t0; };

  try {
    let t0 = Date.now();
    // 深抓时每篇文档都已经在页面上渲染完毕，可跳过等待与滚动，显著提速
    if (!opts.skipWait) await waitForContent(opts.waitMs || 12000);
    tick('wait', t0);

    t0 = Date.now();
    if (!opts.skipScroll) await autoScroll(opts.scrollRounds === undefined ? 3 : opts.scrollRounds);
    tick('scroll', t0);

    t0 = Date.now();
    if (opts.expandAll) await expandAll();
    tick('expand', t0);

    if (opts.extraWait) await sleep(opts.extraWait);

    t0 = Date.now();
    let result = EXTRACTORS[platform] ? EXTRACTORS[platform]() : EXTRACTORS.generic();
    tick('extract', t0);

    if ((!result || !result.contentEl || leanLen(result.contentEl) < 60) && platform !== 'generic') {
      // 平台专用提取失败时回退到通用提取
      t0 = Date.now();
      const fb = EXTRACTORS.generic();
      tick('fallback', t0);
      if (fb && fb.contentEl) {
        result = Object.assign({}, fb, {
          title: (result && result.title) || fb.title,
          directory: result && result.directory,
          fallback: true
        });
      }
    }
    if (!result || !result.contentEl) {
      return {
        ok: false,
        platform,
        url: location.href,
        reason: detectBlockReason() || '未能识别正文内容，可能是页面结构特殊或内容由脚本异步渲染。',
        pageTitle: document.title,
        phases: PHASES
      };
    }

    const el = result.contentEl;
    t0 = Date.now();
    const contentHtml = el.innerHTML || '';
    const contentText = textOf(el);
    tick('serialize', t0);

    // 图片清单（去重、保持顺序）
    const imgUrls = [];
    $$('img[src]', el).forEach((i) => {
      const s = i.getAttribute('src');
      if (s && /^https?:/i.test(s) && !imgUrls.includes(s)) imgUrls.push(s);
    });

    // 标题层级大纲
    const outline = $$('h1,h2,h3,h4', el).map((h) => ({ level: Number(h.tagName[1]), text: textOf(h) })).filter((x) => x.text);

    // 目录树探测：不只在 IMA 适配器里做 —— 任何页面只要左侧存在文档树，
    // 都应该能被识别出来并支持深抓（企业内部知识库、网盘、文档中心等）。
    let directory = result.directory || null;
    let treeStat = result.tree || null;
    if (!directory) {
      const t = treeApi().collect();
      const files = t.items.filter((i) => !i.isFolder);
      const collapsed = t.items.filter((i) => i.isFolder && i.expanded !== 'true');

      // 触发深抓的信号有两个，满足其一即可：
      //   ① 存在「折叠着的文件夹」—— 这是最可靠的信号，展开后条目数量还会增长；
      //   ② 条目本身已经足够多（>=5 且其中至少 3 个是文件），
      //      用于应对「进入时目录就已经全部展开」的知识库。
      // 早期版本要求「节点数 >= 3」，结果未展开的知识库只有两三个顶层文件夹，
      // 直接被挡在门外，深抓永远不触发 —— 这是「抓不到更深一层」的直接原因。
      const looksLikeTree = t.root && (collapsed.length > 0 || (t.items.length >= 5 && files.length >= 3));

      if (looksLikeTree) {
        directory = t.items.map((it) => ({
          title: it.title,
          isFolder: it.isFolder,
          depth: it.depth,
          path: it.path,
          url: ''
        }));
        treeStat = {
          found: true,
          nodes: t.items.length,
          folders: t.items.filter((i) => i.isFolder).length,
          files: files.length
        };
      }
    }

    return {
      ok: true,
      platform,
      url: location.href,
      finalUrl: location.href,
      host: location.hostname,
      pageTitle: document.title,
      title: clean(result.title) || clean(document.title) || hostKey(),
      author: clean(result.author) || '',
      publishTime: clean(result.publishTime) || '',
      cover: result.cover || '',
      description: meta().ogDescription || '',
      keywords: meta().keywords || '',
      siteName: meta().ogSite || hostKey(),
      contentHtml,
      contentText,
      outline,
      images: imgUrls,
      directory,
      tree: treeStat,
      relatedLinks: collectLinks(el, 30),
      stats: {
        chars: contentText.length,
        images: imgUrls.length,
        usedReadability: !!result.usedReadability,
        fallback: !!result.fallback,
        elapsed: Date.now() - started,
        apiCaptured: (window.__TND_API__ || []).length,
        phases: PHASES
      }
    };
  } catch (err) {
    return {
      ok: false,
      platform,
      url: location.href,
      reason: '提取过程异常：' + (err && err.message ? err.message : String(err)),
      pageTitle: document.title
    };
  }
};

/** 供主进程查询页面可滚动高度等状态 */
window.__TND_PING__ = function () {
  return { title: document.title, url: location.href, ready: document.readyState };
};
