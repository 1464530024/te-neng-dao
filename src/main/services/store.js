'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 极简 JSON 持久化。原子写入（先写 .tmp 再 rename），避免断电/崩溃损坏数据。
 */
class JsonStore {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.data = this._load();
    this._timer = null;
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        if (!raw.trim()) return { ...this.defaults };
        const parsed = JSON.parse(raw);
        return { ...this.defaults, ...parsed };
      }
    } catch (err) {
      // 数据损坏时备份后回退默认值，不让应用起不来
      try {
        fs.copyFileSync(this.filePath, this.filePath + '.broken-' + Date.now());
      } catch (_) { /* ignore */ }
      console.error('[store] 读取失败，已回退默认值:', err.message);
    }
    return { ...this.defaults };
  }

  get(key) {
    return key === undefined ? this.data : this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return this.data;
  }

  merge(patch) {
    Object.assign(this.data, patch);
    this.save();
    return this.data;
  }

  /** 防抖保存，200ms 内的多次写入合并成一次 */
  save() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[store] 写入失败:', err.message);
    }
  }
}

/** 历史记录：数组型 JSON，带容量上限 */
class HistoryStore {
  constructor(filePath, limit = 2000) {
    this.filePath = filePath;
    this.limit = limit;
    this.items = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (err) {
      console.error('[history] 读取失败:', err.message);
    }
    return [];
  }

  add(item) {
    this.items.unshift(item);
    if (this.items.length > this.limit) this.items.length = this.limit;
    this.flush();
    return item;
  }

  list() {
    return this.items;
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i >= 0) {
      this.items.splice(i, 1);
      this.flush();
      return true;
    }
    return false;
  }

  clear() {
    this.items = [];
    this.flush();
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[history] 写入失败:', err.message);
    }
  }
}

module.exports = { JsonStore, HistoryStore };
