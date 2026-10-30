/* 全局状态与主进程桥接封装 */

export const state = {
  info: {},
  settings: {},
  platforms: [],
  tasks: [],
  history: [],
  extensions: [],
  rules: []
};

export const api = window.tnd;

export async function bootstrap() {
  const [info, settings, platforms, tasks, history] = await Promise.all([
    api.app.info(),
    api.settings.get(),
    api.app.platforms(),
    api.task.list(),
    api.history.list()
  ]);
  state.info = info;
  state.settings = settings;
  state.platforms = platforms;
  state.tasks = tasks;
  state.history = history;
  return state;
}

export function platformByKey(key) {
  return state.platforms.find((p) => p.key === key) || null;
}

export function platformAccent(key) {
  const p = platformByKey(key);
  return (p && p.accent) || '#5b6472';
}

export function platformName(key) {
  const p = platformByKey(key);
  return (p && p.name) || '通用网页';
}
