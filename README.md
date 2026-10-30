# 特能导

> 链接一贴，内容到手。
> 全平台知识库与网页内容提取导出工具 · Windows 桌面应用

![特能导](build/icon.png)

---

## 这是什么

把网页链接复制进来，得到一份干净、完整、可存档的文档。

支持 **PDF / Markdown / Word / HTML** 四种格式，图片自动下载内嵌，排版尽量与原文一致。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 📚 **IMA 知识库** | **独立功能区**（左侧「IMA 知识库」入口）。通过官方开放接口整库导出：按 `知识库名/目录层级` 落盘，每篇笔记一个 Markdown，图片存到 `文档名_assets/image-001.png`，附件原样保存（与开源项目 wandao 一致） |
| 📦 **文件直下** | 链接本身是 zip/rar/pdf/docx/xlsx 时直接下载原文件，流式写入不占内存 |
| 💬 **微信公众号** | 标题、公众号名、发布时间、正文排版、图片（含动图）完整保留，无需登录 |
| 📕 **小红书** | 笔记正文 + 图集全部提取 |
| 🧠 **知乎** | 问答自动展开全部回答，专栏保留标题层级 |
| 📰 **新闻网站** | 澎湃、新华、人民、网易、腾讯、头条、36氪等 20+ 站点内置识别规则 |
| 🌐 **任意网站** | 智能正文识别；识别不理想时可用「自定义解析规则」指定选择器 |
| 🖥 **内置浏览器** | 应用内直接打开网页，登录一次长期有效；地址栏既能开网址也能搜索（搜索引擎可换）；点链接在应用内打开不弹窗；右上角一键解析当前页面 |
| 📥 **资源嗅探** | 按需开启，抓取页面上的图片 / 文档 / 压缩包 / 其他文件，**自动排除视频与音频**；分类筛选、批量下载 |
| ⚡ **多任务并行** | 提交任务后可以继续粘贴新链接，互不干扰 |
| 🔔 **完成提醒** | 任务结束在右下角弹出醒目提醒 |
| 🧩 **插件中心** | 安装 Chrome 扩展增强解析；管理自定义解析规则 |
| 📄 **7 种导出格式** | PDF / Markdown / Word / HTML / TXT / JSON（喂 AI）/ CSV 清单（带层级路径） |
| 🔗 **链接导出** | 独立功能区（左侧「链接导出」入口）：粘贴网页 / 文档 / 压缩包链接，合并导出为 PDF / Markdown / Word 等文档 |
| 🔑 **IMA 开放接口** | 在「IMA 知识库」页填入到 ima.qq.com/agent-interface 申请的 ClientID/APIKey，即可按知识库导出 |
| 🗂 **历史记录** | 每次导出留档，可搜索、筛选、回到原文、导出 CSV |
| 🕒 **任务持久化** | 任务按日期分组长期保存，关掉软件也不丢；未跑完的标为「已中断」可一键重试 |

## 快速开始

```bash
npm install          # 已配置国内镜像
unset ELECTRON_RUN_AS_NODE   # Windows 终端必需
npm start
```

打包安装包：

```bash
npx electron-builder --win nsis
# 产物：dist/特能导-1.4.0-安装包.exe
```

## 文档

| 文档 | 面向 |
| --- | --- |
| [docs/使用说明.md](docs/使用说明.md) | 使用者：安装、操作、常见问题、卸载 |
| [docs/技术文档.md](docs/技术文档.md) | 开发者：架构、模块、踩坑记录、构建发布 |
| [docs/GitHub上传说明.md](docs/GitHub上传说明.md) | 维护者：SSH 配置、推送到 GitHub、发布安装包 |

## 技术栈

Electron 45 · Chromium 142 · Node 24 · 原生 HTML/CSS/JS（无构建工具链）

关键依赖：`@mozilla/readability` · `turndown` · `html-to-docx` · `adm-zip` · `marked`

## 目录速览

```
src/main/        主进程：窗口、IPC、任务队列、抓取引擎、导出引擎
src/main/inject/ 注入到目标网页执行的提取脚本（含 6 类平台适配器）
src/renderer/    界面：白色科技风 UI + 内置浏览器
scripts/         图标生成、链路自测、界面回归截图
build/           图标资源与 NSIS 安装脚本
docs/            使用说明与技术文档
```

## 开发提示

改抓取逻辑前，**请先读 [技术文档第五章「踩过的坑」](docs/技术文档.md#五踩过的坑重要勿回退)** —— 那里记录的每个问题都曾让功能完全不可用。

自测一条链路：

```bash
unset ELECTRON_RUN_AS_NODE
./node_modules/electron/dist/electron.exe scripts/test-extract.js \
  --url=https://mp.weixin.qq.com/s/xxxx \
  --out=./logs/out --formats=pdf,markdown,docx,html
```

自测 IMA 开放接口通道（纯 Node，无需真实凭据，内置 mock 服务）：

```bash
node scripts/test-ima.js
```
