const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let confirm = false;
let removedCuda = 0;
const removedFiles = [];
const prefs = {};
const ctx = vm.createContext({
  window: {},
  Services: { prompt: { confirm: () => confirm } },
  Zotero: { Profile: { dir: '/profile' }, Prefs: { set: (k, v) => { prefs[k] = v; } } },
  PathUtils: { join: (...parts) => parts.join('/') },
  CudaRuntime: { remove: async () => { removedCuda++; }, isReady: async () => false }
});
vm.runInContext(fs.readFileSync('plugin/chrome/content/preferences.js', 'utf8'), ctx);
const ui = ctx.EasyTransPreferences;
Object.assign(ui, { device: {}, status: {}, storageStatus: {}, downloadButton: {}, removeCudaButton: {}, removeModelButton: {}, modelDownloader: { downloadInProgress: false, deleteModel: async () => { removedFiles.push('model'); return true; } } });
(async () => {
  await ui.removeCuda();
  await ui.removeModel();
  assert.equal(removedCuda, 0);
  assert.deepEqual(removedFiles, []);
  confirm = true;
  await ui.removeCuda();
  assert.equal(removedCuda, 1);
  assert.equal(prefs['extensions.easytrans.computeDevice'], 'cpu');
  await ui.removeModel();
  assert.deepEqual(removedFiles, ['model']);
  console.log('Removal confirmation, CPU fallback and model path passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
