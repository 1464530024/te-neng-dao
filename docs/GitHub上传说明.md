# 上传到 GitHub 操作说明

> 适用：把本项目（特能导）上传到 GitHub，使用 **SSH 公钥**认证。
> 本文档命令均为 **Git Bash** 语法（Windows）。

---

## 一、当前环境状态（已替你确认）

| 项目 | 状态 |
| --- | --- |
| Git | 已安装（2.55.0） |
| SSH 密钥 | 已存在 `~/.ssh/id_ed25519`（ed25519） |
| **SSH 认证** | **已通过**：`Hi 1464530024! You've successfully authenticated` |
| GitHub 用户名 | `1464530024` |
| 公钥是否已添加到 GitHub | **已添加**（无需再操作） |
| Git 提交身份 | `1464530024` / `1464530024@users.noreply.github.com` |
| 本地仓库 | **已初始化**（分支 `main`，首次提交 `11f575b`） |
| `.gitignore` | **已创建**（排除依赖/安装包/日志/缓存/密钥） |

你的公钥内容（备查，无需重复添加）：

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK8ffYHX4stG+5aNcbfH7xot682861EIGblFlvdffuMX 1464530024@users.noreply.github.com
```

> 如果将来换电脑或重装系统，需重新执行「附录 A：生成并添加 SSH 公钥」。

---

## 二、本次已为你完成的本地准备

1. 创建 `.gitignore`，确保以下内容**不会**被上传：
   - `node_modules/`（510MB 依赖）
   - `dist/`、`*.exe`、`*.blockmap`（安装包，改用 Releases 分发）
   - `logs/`、`.cache/`（运行日志与构建缓存）
   - `.env`、`*.pem`、`*.key`、`ima_config.json` 等**敏感凭据**
2. 执行 `git init -b main` 初始化仓库。
3. 首次提交 `11f575b`，共 **49 个文件**（仅源码、图标资源、文档、脚本、配置）。
4. 校验：暂存区**无** `node_modules` / `dist` / `logs` / `.cache`，仓库压缩后仅约 8MB。

---

## 三、在 GitHub 创建仓库

1. 打开 <https://github.com/new>
2. 填写：
   - **Repository name**：`tenengdao`（可自定义，下文命令请同步替换）
   - **Description**：特能导 — 全平台知识库与网页内容提取导出工具
   - **Visibility**：**Public**
   - **不要**勾选 *Add a README / .gitignore / license*（本地已有文件，勾选会造成冲突）
3. 点 **Create repository**。

创建后会显示使用 SSH 的初始化命令，我们只需其中的**关联远程**与**推送**两步（本地已初始化）。

---

## 四、关联远程并推送

在项目目录执行（把仓库名换成你实际创建的）：

```bash
cd "C:/Users/gzh17/WorkBuddy/知识库导出工具/tenengdao"

# 关联远程仓库（SSH 方式）
git remote add origin git@github.com:1464530024/tenengdao.git

# 首次推送并建立跟踪关系
git push -u origin main
```

成功后刷新 GitHub 页面即可看到全部文件。

查看当前远程配置：

```bash
git remote -v
```

---

## 五、日常更新流程

以后每次改完代码，三步推送：

```bash
git add -A
git commit -m "描述本次改动"
git push
```

常用辅助命令：

```bash
git status            # 查看有哪些改动
git log --oneline -5  # 查看最近 5 次提交
git diff              # 查看尚未暂存的具体改动
```

---

## 六、发布安装包（GitHub Releases）

> **为什么要用 Releases？**
> GitHub 普通仓库**单文件上限 100MB**，本项目安装包约 **124MB**，直接 `git push` 会被拒绝。
> Releases 单文件上限 **2GB**，且不占仓库体积，还能附更新说明。

### 方式一：网页上传（推荐，零配置）

1. 打开仓库 → 右侧 **Releases** → **Draft a new release**
2. **Choose a tag**：输入 `v1.4.0` → 点 *Create new tag*
3. **Release title**：`特能导 v1.4.0`
4. **Describe this release**：填写更新说明（可参考下节模板）
5. **Attach binaries**：把 `dist/特能导-1.4.0-安装包.exe` 拖进去
6. 点 **Publish release**

### 方式二：命令行上传（需先安装 gh CLI）

下载安装 <https://cli.github.com/> 后：

```bash
gh auth login                       # 首次需登录一次
gh release create v1.4.0 "dist/特能导-1.4.0-安装包.exe" \
  --title "特能导 v1.4.0" \
  --notes "新增 IMA 知识库独立导出功能区；应用图标更新。"
```

### 更新说明模板

```markdown
## 新增
- IMA 知识库导出独立功能区（官方开放接口，按目录结构落盘）

## 优化
- 应用图标更新

## 安装
下载下方 `特能导-x.y.z-安装包.exe`，双击安装即可。仅支持 Windows 10 / 11（64 位）。
```

---

## 七、常见问题

**Q1：`git push` 报 `GH001: Large files detected`**
说明把大文件加入了提交。执行以下命令移出并重新提交：

```bash
git rm --cached "dist/特能导-1.4.0-安装包.exe"   # 移出暂存（保留本地文件）
git commit -m "移除误纳入的安装包"
git push
```
若大文件已进入**历史提交**，需用 `git filter-repo` 清理（较复杂，可另行协助）。

**Q2：提示 `Permission denied (publickey)`**
先验证：`ssh -T git@github.com`
- 若失败，参见「附录 A」重新生成并添加公钥。
- 或临时改用 HTTPS：`git remote set-url origin https://github.com/1464530024/tenengdao.git`

**Q3：想改分支名（master → main）**

```bash
git branch -M main
git push -u origin main
```

**Q4：提交后发现有敏感信息（如密钥）被上传**
立即在 GitHub 上删除该仓库或使其私有，并**更换泄露的密钥**；然后修正 `.gitignore` 并清理历史。

**Q5：公开仓库要不要加开源许可证？**
建议加。可在仓库根目录点 *Add file → Create new file*，文件名填 `LICENSE`，GitHub 会提供模板选择（如 MIT）。注意：本项目参考了 AGPL-3.0 的 wandao 的部分实现思路，若直接使用了其代码，需遵守其许可证要求。

---

## 附录 A：生成并添加 SSH 公钥（换电脑时使用）

```bash
# 1) 生成密钥（邮箱可换成你的 GitHub 邮箱）
ssh-keygen -t ed25519 -C "1464530024@users.noreply.github.com" -f ~/.ssh/id_ed25519

# 2) 复制公钥内容
cat ~/.ssh/id_ed25519.pub
```

然后：GitHub → 右上角头像 → **Settings** → **SSH and GPG keys** → **New SSH key** → 粘贴公钥 → 保存。

验证：

```bash
ssh -T git@github.com
# 期望输出：Hi 1464530024! You've successfully authenticated ...
```

---

## 附录 B：一键速查

```bash
# 关联远程（仅首次）
git remote add origin git@github.com:1464530024/tenengdao.git
git push -u origin main

# 日常更新
git add -A && git commit -m "改动说明" && git push

# 验证 SSH
ssh -T git@github.com
```
