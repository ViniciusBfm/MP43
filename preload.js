const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('api', {
  detectTools: invoke('tools:detect'),
  updateTools: invoke('tools:update'),
  openLicenses: invoke('licenses:open'),
  onToolsLog: on('tools:log'),
  info: invoke('info'),
  listJobs: invoke('jobs:list'),
  addJob: invoke('jobs:add'),
  addJobs: invoke('jobs:add-many'),
  cancelJob: invoke('jobs:cancel'),
  retryJob: invoke('jobs:retry'),
  removeJob: invoke('jobs:remove'),
  clearJobs: invoke('jobs:clear'),
  onJob: on('job:update'),
  onJobRemoved: on('job:removed'),
  onFocus: on('app:focus'),
  openFile: invoke('file:open'),
  showFile: invoke('file:show'),
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  chooseFolder: invoke('settings:choose-folder'),
  readClipboard: invoke('clipboard:read'),
  openExternal: invoke('open:external'),
});
