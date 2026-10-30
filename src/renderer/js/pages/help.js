/* 页面：使用说明 */

import { $ } from '../ui.js';

const HTML = `
<div class="card">
  <div class="card-title mb10">三步上手</div>
  <div style="font-size:12.8px;line-height:2;color:var(--fg)">
    <div><b>1. 复制链接</b>　在浏览器或微信里复制要导出的网页链接（一次可复制多条）。</div>
    <div><b>2. 粘贴并选择格式</b>　回到「链接导出」粘贴，软件会自动识别平台，勾选要导出的格式（PDF / Markdown / Word / HTML）。</div>
    <div><b>3. 开始导出</b>　任务进入后台队列，你可以继续粘贴新链接或用内置浏览器，完成后右下角会提醒。</div>
  </div>
</div>

<div class="card">
  <div class="card-title mb10">各平台使用要点</div>
  <div style="font-size:12.8px;line-height:2">
    <div><b>微信公众号</b>　直接粘贴 <span class="mono">mp.weixin.qq.com/s/…</span> 链接即可。图片、代码块、原始排版都会保留。</div>
    <div class="mt6"><b>IMA 知识库</b>　需要先在「内置浏览器」登录腾讯 IMA，再粘贴分享链接。勾选「知识库目录深度抓取」后，会自动遍历目录与子文件夹，合并导出为一份带目录的多章节文档。</div>
    <div class="mt6"><b>小红书</b>　先在内置浏览器登录，再解析。笔记正文与全部图片会被提取。</div>
    <div class="mt6"><b>知乎</b>　问答页会自动展开全部回答；专栏文章保留标题层级。</div>
    <div class="mt6"><b>新闻站点</b>　澎湃、新华、人民网、网易、腾讯、头条、36氪等已内置正文识别规则，通常无需登录。</div>
    <div class="mt6"><b>其它网站</b>　会启用智能正文识别。若识别不理想，到「插件中心 → 自定义解析规则」为该网站指定正文选择器。</div>
  </div>
</div>

<div class="card">
  <div class="card-title mb10">内置浏览器（推荐用法）</div>
  <div style="font-size:12.8px;line-height:2">
    <div>需要登录、或内容靠脚本异步渲染的站点，用内置浏览器最稳。进入时默认打开百度首页。</div>
    <div style="padding-left:14px;margin-top:6px">
      <div>· 左侧菜单进入「内置浏览器」，<b>地址栏可输入网址，也可直接输入关键词搜索</b></div>
      <div>· 完成登录（登录状态会长期保存，下次不用再登）</div>
      <div>· 打开目标文章，点右上角<b>「解析此页」</b></div>
      <div>· 预览确认无误后点「导出这份内容」</div>
    </div>
    <div class="mt10">
      <b>地址栏</b>：<span class="mono">baidu.com</span> 这类直接打开；<span class="mono">考研英语怎么复习</span> 这类走搜索。
      搜索引擎与默认首页可在「设置 → 内置浏览器」中修改。
    </div>
    <div class="mt6">
      <b>点链接不会弹窗</b>：页面里点搜索结果、外链，都会直接在这个内置浏览器里打开。
    </div>
  </div>
</div>

<div class="card">
  <div class="card-title mb10">资源嗅探（按需开启）</div>
  <div style="font-size:12.8px;line-height:2">
    <div>用来批量抓取页面上的图片、文档、压缩包等资源。<b>默认关闭，必须点「嗅探」按钮才开始。</b></div>
    <div style="padding-left:14px;margin-top:6px">
      <div>1. 打开目标网页</div>
      <div>2. 点工具栏「<b>嗅探</b>」按钮 → 按钮变红显示「嗅探中」，右侧滑出资源面板</div>
      <div>3. 滚动或浏览页面，新资源会实时加入列表</div>
      <div>4. 勾选需要的（或点「全选」）→ 点「下载选中」</div>
    </div>
    <div class="mt10">
      <b>收集范围</b>：图片、文档（pdf/word/excel/ppt/txt/md/csv/epub…）、压缩包（zip/rar/7z…）、其他文件（exe/apk/psd/字幕…）。
      <br><b style="color:var(--error)">不收集视频与音频</b>（mp4 / m3u8 / mp3 / m4a / flac 等一律跳过）。
    </div>
    <div class="mt6">
      <b>拿不全？</b>先开嗅探 → 把页面往下滚一遍触发懒加载 → 点面板右上角 <span class="mono">↻</span> 重新扫描当前页面已有资源。
    </div>
    <div class="mt6 muted">保存位置：&lt;导出目录&gt;\嗅探资源\&lt;日期&gt;\</div>
  </div>
</div>

<div class="card">
  <div class="card-title mb10">导出格式说明</div>
  <div style="font-size:12.8px;line-height:2">
    <div><b>PDF</b>　版式与网页一致，图片内嵌，适合存档、打印、转发给他人。</div>
    <div><b>Markdown</b>　结构化纯文本，图片会同时保存到同名的 <span class="mono">.assets</span> 文件夹，适合二次编辑或导入知识库系统。</div>
    <div><b>Word</b>　可编辑的 .docx，保留标题层级、表格与图片。</div>
    <div><b>HTML</b>　单文件网页，图片已内嵌，双击即可用浏览器打开，便于长期归档。</div>
  </div>
</div>

<div class="card">
  <div class="card-title mb10">常见问题</div>
  <div style="font-size:12.8px;line-height:2">
    <div><b>Q：提示解析失败怎么办？</b><br>A：依次尝试——① 到「内置浏览器」登录对应平台后再试；② 打开「知识库目录深度抓取」；③ 在插件中心为该网站添加自定义解析规则；④ 用内置浏览器打开该页后点「解析此页」。</div>
    <div class="mt10"><b>Q：为什么有些图片没下载成功？</b><br>A：图片可能受登录态或防盗链限制。导出结果里会给出提示，并保留原始链接。</div>
    <div class="mt10"><b>Q：能同时跑多个任务吗？</b><br>A：可以。任务之间并行执行，并发数可在「设置 → 性能与抓取」调整（默认 3，过高可能触发网站风控）。</div>
    <div class="mt10"><b>Q：Chrome 扩展怎么安装？</b><br>A：在「插件中心 → 安装扩展」选择扩展文件夹或 .crx/.zip 文件。若只有 Chrome 商店链接，请先用第三方工具下载 crx，或解压后选择文件夹。</div>
    <div class="mt10"><b>Q：数据存在哪里？</b><br>A：设置、历史记录、登录状态都在「设置 → 打开数据目录」指向的文件夹内，卸载软件时可一并删除。</div>
    <div class="mt10"><b>Q：嗅探会抓到视频或音频吗？</b><br>A：不会。程序在「网络类型」和「文件扩展名」两层都做了过滤，mp4 / m3u8 / mp3 / m4a / flac 等一律不收。</div>
    <div class="mt10"><b>Q：内置浏览器的默认首页能换成别的吗？</b><br>A：可以。「设置 → 内置浏览器 → 默认打开网址」填网址，或用右侧「常用站点」下拉一键选（IMA 知识库、公众号、知乎、小红书、澎湃新闻）。也能关掉「进入时自动打开默认网址」改为空白页。</div>
    <div class="mt10"><b>Q：地址栏输入中文会搜索还是当网址？</b><br>A：含空格或不像域名的内容会走搜索；像 <span class="mono">mp.weixin.qq.com</span> 这种会直接打开。</div>
  </div>
</div>

<div class="card">
  <div class="card-title mb10">快捷键</div>
  <div style="font-size:12.8px;line-height:2.2">
    <div><span class="kbd">Ctrl</span> + <span class="kbd">N</span>　新建链接导出任务</div>
    <div><span class="kbd">Ctrl</span> + <span class="kbd">T</span>　打开内置浏览器</div>
    <div><span class="kbd">Ctrl</span> + <span class="kbd">Enter</span>　在链接输入框中直接开始导出</div>
    <div><span class="kbd">Ctrl</span> + <span class="kbd">Q</span>　退出应用</div>
  </div>
</div>

<div class="card">
  <div class="card-title mb10">使用须知</div>
  <div class="tip warn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
    <div>本软件用于个人学习与资料归档。请仅对你有权访问的内容进行导出，并遵守目标网站的服务条款与著作权规定，不要用于批量抓取或商业转载。</div>
  </div>
</div>
`;

export function renderHelp() {
  const el = $('#helpBody');
  if (el && !el.dataset.done) {
    el.innerHTML = HTML;
    el.dataset.done = '1';
  }
}
