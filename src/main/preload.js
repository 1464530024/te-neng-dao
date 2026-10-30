'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const EVENT_CHANNELS = [
  'task:update',
  'notify:toast',
  'history:changed',
  'window:state',
  'menu:new-task',
  'menu:open-browser',
  'menu:goto',
  'browser:open-url',
  'sniff:update',
  'ima:progress'
];

const listeners = new Map();

contextBridge.exposeInMainWorld('tnd', {
  app: {
    info: () => invoke('app:info'),
    platforms: () => invoke('app:platforms'),
    detect: (urls) => invoke('app:detect', urls),
    parseUrls: (text) => invoke('app:parseUrls', text),
    devTools: () => invoke('app:openDevTools')
  },
  settings: {
    get: () => invoke('settings:get'),
    save: (patch) => invoke('settings:save', patch),
    reset: () => invoke('settings:reset')
  },
  task: {
    submit: (payload) => invoke('task:submit', payload),
    list: () => invoke('task:list'),
    stats: () => invoke('task:stats'),
    cancel: (id) => invoke('task:cancel', id),
    retry: (id) => invoke('task:retry', id),
    remove: (id) => invoke('task:remove', id),
    clearFinished: () => invoke('task:clearFinished')
  },
  history: {
    list: () => invoke('history:list'),
    remove: (id) => invoke('history:remove', id),
    clear: () => invoke('history:clear'),
    exportCsv: (ids) => invoke('history:export', { ids })
  },
  extract: {
    preview: (payload) => invoke('extract:preview', payload),
    webview: (payload) => invoke('extract:webview', payload),
    save: (payload) => invoke('export:save', payload)
  },
  browser: {
    meta: () => invoke('browser:meta'),
    resolveUrl: (input) => invoke('browser:resolveUrl', input)
  },
  sniff: {
    start: (webContentsId) => invoke('sniff:start', webContentsId),
    stop: (webContentsId) => invoke('sniff:stop', webContentsId),
    list: (webContentsId) => invoke('sniff:list', webContentsId),
    clear: (webContentsId) => invoke('sniff:clear', webContentsId),
    scanDom: (webContentsId) => invoke('sniff:scanDom', webContentsId),
    isRunning: (webContentsId) => invoke('sniff:isRunning', webContentsId),
    chooseDir: () => invoke('sniff:chooseDir'),
    download: (payload) => invoke('sniff:download', payload)
  },
  plugin: {
    list: () => invoke('plugin:list'),
    install: () => invoke('plugin:install'),
    remove: (id) => invoke('plugin:remove', id),
    toggle: (id, enabled) => invoke('plugin:toggle', { id, enabled }),
    rules: () => invoke('plugin:rules'),
    addRule: (rule) => invoke('plugin:addRule', rule),
    removeRule: (id) => invoke('plugin:removeRule', id),
    ready: () => invoke('plugin:ready')
  },
  session: {
    clear: (what) => invoke('session:clear', what),
    info: () => invoke('session:info')
  },
  fs: {
    exists: (p) => invoke('fs:exists', p),
    chooseDir: (defaultPath) => invoke('dialog:chooseDir', defaultPath),
    chooseFiles: (opts) => invoke('dialog:chooseFiles', opts),
    openPath: (p) => invoke('shell:openPath', p),
    showItem: (p) => invoke('shell:showItem', p),
    openExternal: (url) => invoke('shell:openExternal', url)
  },
  win: {
    minimize: () => invoke('window:minimize'),
    maximize: () => invoke('window:maximize'),
    close: () => invoke('window:close'),
    hide: () => invoke('window:hide')
  },
  notify: {
    test: () => invoke('notify:test')
  },
  ima: {
    listKnowledgeBases: (payload) => invoke('ima:listKnowledgeBases', payload),
    scanToc: (payload) => invoke('ima:scanToc', payload),
    exportTree: (payload) => invoke('ima:exportTree', payload)
  },
  clipboard: {
    read: () => invoke('clipboard:read'),
    write: (text) => invoke('clipboard:write', text)
  },
  /** 订阅主进程事件，返回取消订阅函数 */
  on: (channel, callback) => {
    if (!EVENT_CHANNELS.includes(channel)) {
      throw new Error('不支持的事件通道: ' + channel);
    }
    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, wrapped);
    if (!listeners.has(channel)) listeners.set(channel, []);
    listeners.get(channel).push(wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
      const arr = listeners.get(channel) || [];
      const i = arr.indexOf(wrapped);
      if (i >= 0) arr.splice(i, 1);
    };
  }
});
