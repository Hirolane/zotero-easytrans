const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    value: '', disabled: false, hidden: false,
    addEventListener(type, listener) { this[type] = listener; },
    setAttribute(name, value) { this[name] = value; }
  });
  return elements.get(id);
}
const saved = {};
const model = {
  subscribe(cb) { cb({ buttonMode: 'download', isDownloaded: false }); return () => {}; },
  async refreshState() {},
  async showDownloadDialog() { this.started = true; }
};
const ctx = vm.createContext({
  document: { getElementById: element },
  window: { addEventListener() {} },
  Zotero: { locale: 'en-US', EasyTransModelDownloader: model, Prefs: {
    get: k => saved[k], set: (k, v) => { saved[k] = v; },
    registerObserver: () => Symbol(), unregisterObserver: () => {}
  } },
  CudaRuntime: { isReady: async () => false }
});
vm.runInContext(fs.readFileSync('plugin/chrome/content/preferences.js', 'utf8'), ctx);
(async () => {
  await ctx.EasyTransPreferences.init();
  const device = element('easytrans-pref-device');
  device.value = 'gpu';
  await device.command();
  assert.equal(device.value, 'gpu');
  assert.equal(saved['extensions.easytrans.computeDevice'], 'gpu');
  assert.match(element('easytrans-pref-cuda-status').textContent, /Download/);
  await ctx.EasyTransPreferences.downloadModel();
  assert.equal(model.started, true);
  console.log('GPU selection without CUDA and model download action passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
