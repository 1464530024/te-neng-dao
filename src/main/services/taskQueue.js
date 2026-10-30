'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { detectPlatform, detectFileUrl, TASK_STATUS } = require('../../shared/constants');
const { capture } = require('./extractor');
const { exportResult, safeFileName } = require('./exporter');
const { ensureDir } = require('./exporter');
const { downloadFile } = require('./downloader');

/** 组装某一项的输出子目录（按平台 / 日期分组） */
function buildSubDir(outRoot, settings, groupName) {
  const segs = [];
  if (settings.groupByPlatform !== false) segs.push(safeFileName(groupName || '通用网页'));
  if (settings.groupByDate) segs.push(new Date().toISOString().slice(0, 10));
  return path.join.apply(path, [outRoot].concat(segs.filter(Boolean)));
}

let seq = 0;
function newId(prefix) {
  seq += 1;
  return (prefix || 't') + '-' + Date.now().toString(36) + '-' + seq.toString(36) + '-' + crypto.randomBytes(2).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 多任务队列。任务之间按 concurrency 并行；单个任务内部的多个链接串行处理，
 * 这样任何一个任务都不会占满全部并发槽，用户可随时提交新任务。
 */
class TaskQueue extends EventEmitter {
  constructor(options) {
    super();
    const o = options || {};
    this.getSettings = o.getSettings || (() => ({}));
    this.storageFile = o.storageFile || '';
    this.pending = [];
    this.runningCount = 0;
    this.maxHistory = o.maxHistory || 200;
    this._saveTimer = null;
    this.tasks = this._load();
  }

  /* ── 持久化 ── */

  _load() {
    if (!this.storageFile || !fs.existsSync(this.storageFile)) return [];
    try {
      const arr = JSON.parse(fs.readFileSync(this.storageFile, 'utf8'));
      if (!Array.isArray(arr)) return [];
      // 上次退出时还在跑的任务，恢复时标记为「已中断」，避免列表里永远显示「进行中」
      return arr.map((t) => {
        const items = (t.items || []).map((i) => {
          if (i.status === 'running' || i.status === 'queued') {
            return Object.assign({}, i, { status: 'failed', error: '应用退出时任务被中断' });
          }
          return i;
        });
        const status = (t.status === 'running' || t.status === 'queued') ? 'interrupted' : t.status;
        return Object.assign({}, t, {
          status,
          items,
          flags: { canceled: false },
          currentLabel: ''
        });
      });
    } catch (err) {
      console.error('[taskQueue] 任务记录读取失败:', err.message);
      return [];
    }
  }

  /** 防抖落盘 */
  persist() {
    if (!this.storageFile) return;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 800);
  }

  flush() {
    if (!this.storageFile) return;
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      const dir = path.dirname(this.storageFile);
      fs.mkdirSync(dir, { recursive: true });
      const plain = this.tasks.slice(0, this.maxHistory).map((t) => ({
        id: t.id,
        name: t.name,
        platform: t.platform,
        platformName: t.platformName,
        status: t.status,
        items: t.items,
        outDir: t.outDir,
        formats: t.formats,
        pageSize: t.pageSize,
        deep: t.deep,
        options: t.options,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        error: t.error || ''
      }));
      const tmp = this.storageFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(plain, null, 1), 'utf8');
      fs.renameSync(tmp, this.storageFile);
    } catch (err) {
      console.error('[taskQueue] 任务记录写入失败:', err.message);
    }
  }

  list() {
    return this.tasks.map((t) => this.serialize(t));
  }

  get(id) {
    return this.tasks.find((t) => t.id === id);
  }

  serialize(t) {
    const done = t.items.filter((i) => i.status === 'done' || i.status === 'failed' || i.status === 'canceled').length;
    return {
      id: t.id,
      name: t.name,
      platform: t.platform,
      platformName: t.platformName,
      status: t.status,
      progress: t.items.length ? Math.round((done / t.items.length) * 100) : 0,
      total: t.items.length,
      finished: done,
      outDir: t.outDir,
      formats: t.formats,
      pageSize: t.pageSize,
      deep: t.deep,
      options: t.options,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      error: t.error || '',
      currentLabel: t.currentLabel || '',
      items: t.items.map((i) => ({
        url: i.url,
        status: i.status,
        title: i.title || '',
        error: i.error || '',
        files: i.files || [],
        warnings: i.warnings || [],
        stats: i.stats || null,
        platformName: i.platformName || ''
      }))
    };
  }

  emitUpdate(task) {
    this.emit('update', this.serialize(task));
    this.persist();
  }

  /**
   * 提交一个任务。
   * @param {object} payload { urls: string[], name, formats[], outDir, pageSize, deep, options }
   */
  submit(payload) {
    const p = payload || {};
    const settings = this.getSettings();
    const urls = (p.urls || []).filter((u) => /^https?:/i.test(u));
    if (!urls.length) throw new Error('未提供有效链接');

    const first = detectPlatform(urls[0]);
    const allSame = urls.every((u) => detectPlatform(u).key === first.key);

    const task = {
      id: newId('task'),
      name: p.name || ((allSame ? first.name : '混合平台') + ' · ' + urls.length + ' 条'),
      platform: p.platform || (allSame ? first.key : 'mixed'),
      platformName: p.platformName || (allSame ? first.name : '混合平台'),
      status: TASK_STATUS.QUEUED,
      items: urls.map((u) => ({ url: u, status: 'queued', title: '', error: '', files: [], warnings: [] })),
      outDir: p.outDir || this.defaultOutDir(settings),
      formats: p.formats && p.formats.length ? p.formats : (settings.formats || ['pdf', 'markdown', 'docx']),
      pageSize: p.pageSize || settings.pageSize || 'A4',
      deep: p.deep,
      options: p.options || {},
      flags: { canceled: false },
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      currentLabel: '',
      error: ''
    };

    this.tasks.unshift(task);
    if (this.tasks.length > this.maxHistory) this.tasks.length = this.maxHistory;
    this.pending.push(task.id);
    this.emitUpdate(task);
    this.pump();
    return this.serialize(task);
  }

  defaultOutDir(settings) {
    const s = settings || {};
    if (s.outDir) return s.outDir;
    const os = require('os');
    return path.join(os.homedir(), 'Downloads', '特能导导出');
  }

  pump() {
    const settings = this.getSettings();
    const limit = Math.max(1, Math.min(8, settings.concurrency || 3));
    while (this.runningCount < limit && this.pending.length) {
      const id = this.pending.shift();
      const task = this.get(id);
      if (!task || task.flags.canceled) continue;
      this.runningCount += 1;
      this.runTask(task)
        .catch((err) => {
          task.status = TASK_STATUS.FAILED;
          task.error = err && err.message ? err.message : String(err);
        })
        .finally(() => {
          this.runningCount -= 1;
          this.emitUpdate(task);
          this.pump();
        });
    }
  }

  async runTask(task) {
    const settings = this.getSettings();
    task.status = TASK_STATUS.RUNNING;
    task.startedAt = nowIso();
    this.emitUpdate(task);

    const outRoot = ensureDir(task.outDir);

    for (const item of task.items) {
      if (task.flags.canceled) {
        if (item.status === 'queued') item.status = 'canceled';
        continue;
      }
      item.status = 'running';
      task.currentLabel = item.url;
      this.emitUpdate(task);

      try {
        // ① 链接本身就指向一份文件（zip / pdf / docx / xlsx …）→ 直接下载，
        //    不要拿它当网页去解析正文，那样只会得到一堆乱码或失败。
        const fileInfo = detectFileUrl(item.url);
        if (fileInfo && !task.options.forceExtract) {
          item.platformName = '直接下载';
          task.currentLabel = '下载 ' + item.url;
          this.emitUpdate(task);

          const dlDir = buildSubDir(outRoot, settings, '直接下载');
          const r = await downloadFile(item.url, dlDir, {
            timeout: Math.max(120000, settings.timeout || 60000),
            maxBytes: settings.maxFileSize || 2 * 1024 * 1024 * 1024
          });

          if (!r.ok) throw new Error(r.error || '下载失败');

          item.title = r.name;
          item.files = [{ format: fileInfo.kind, path: r.path, size: r.size }];
          item.stats = { chars: 0, images: 0, bytes: r.size };
          item.warnings = r.size > 200 * 1024 * 1024 ? ['文件较大（' + (r.size / 1048576).toFixed(0) + 'MB），下载耗时较长'] : [];
          item.status = 'done';

          this.emit('item-done', {
            taskId: task.id,
            title: r.name,
            platformName: '直接下载',
            files: item.files,
            warnings: item.warnings,
            url: item.url,
            deepCount: 0
          });
          this.emitUpdate(task);
          continue;
        }

        const platformDef = detectPlatform(item.url);
        item.platformName = platformDef.name;

        const result = await capture(item.url, {
          settings,
          flags: task.flags,
          deep: task.deep,
          retries: settings.autoRetry,
          scrollRounds: task.options.scrollRounds,
          expandAll: task.options.expandAll,
          waitMs: task.options.waitMs,
          // 深抓知识库时逐篇回报进度，让任务中心能看到「第 N/M 篇」
          onItem: (info) => {
            task.currentLabel = '深抓 ' + info.index + '/' + info.total + '　' + (info.title || '');
            this.emitUpdate(task);
          }
        });

        if (!result.ok) {
          item.status = result.canceled ? 'canceled' : 'failed';
          item.error = result.reason || '提取失败';
          this.emitUpdate(task);
          continue;
        }

        item.title = result.title || item.url;
        item.stats = result.stats || null;

        const subDir = buildSubDir(outRoot, settings, result.platformName);

        const fileName = safeFileName(result.title, '未命名');
        const exported = await exportResult(result, {
          outDir: subDir,
          formats: task.formats,
          fileName,
          pageSize: task.pageSize,
          fileNameTemplate: settings.fileNameTemplate,
          flags: task.flags
        });

        item.files = exported.files;
        item.warnings = exported.warnings || [];
        item.status = 'done';

        this.emit('item-done', {
          taskId: task.id,
          title: item.title,
          platformName: result.platformName,
          files: exported.files,
          warnings: item.warnings,
          url: item.url,
          deepCount: result.deepCount || 0
        });
      } catch (err) {
        item.status = 'failed';
        item.error = err && err.message ? err.message : String(err);
      }
      this.emitUpdate(task);
    }

    const okCount = task.items.filter((i) => i.status === 'done').length;
    const failCount = task.items.filter((i) => i.status === 'failed').length;
    task.finishedAt = nowIso();
    task.currentLabel = '';
    if (task.flags.canceled) task.status = TASK_STATUS.CANCELED;
    else if (failCount === 0) task.status = TASK_STATUS.DONE;
    else if (okCount === 0) task.status = TASK_STATUS.FAILED;
    else task.status = TASK_STATUS.PARTIAL;

    this.emitUpdate(task);
    this.emit('finished', this.serialize(task));
  }

  cancel(id) {
    const task = this.get(id);
    if (!task) return false;
    task.flags.canceled = true;
    const idx = this.pending.indexOf(id);
    if (idx >= 0) this.pending.splice(idx, 1);
    if (task.status === TASK_STATUS.QUEUED) {
      task.status = TASK_STATUS.CANCELED;
      task.items.forEach((i) => { if (i.status === 'queued') i.status = 'canceled'; });
      this.emitUpdate(task);
      this.emit('finished', this.serialize(task));
    }
    return true;
  }

  /** 重试失败项（保留成功项，只重跑 failed） */
  retry(id) {
    const task = this.get(id);
    if (!task) return false;
    const failed = task.items.filter((i) => i.status === 'failed' || i.status === 'canceled');
    if (!failed.length) return false;
    failed.forEach((i) => {
      i.status = 'queued';
      i.error = '';
      i.files = [];
    });
    task.flags.canceled = false;
    task.status = TASK_STATUS.QUEUED;
    task.finishedAt = null;
    this.pending.push(task.id);
    this.emitUpdate(task);
    this.pump();
    return true;
  }

  remove(id) {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i < 0) return false;
    this.cancel(id);
    this.tasks.splice(i, 1);
    return true;
  }

  clearFinished() {
    this.tasks = this.tasks.filter((t) => t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.QUEUED);
    return true;
  }

  stats() {
    const running = this.tasks.filter((t) => t.status === TASK_STATUS.RUNNING).length;
    const queued = this.tasks.filter((t) => t.status === TASK_STATUS.QUEUED).length;
    return { running, queued, total: this.tasks.length, slots: this.runningCount };
  }
}

module.exports = { TaskQueue, newId, nowIso };
