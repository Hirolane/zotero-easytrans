const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let listener, confirmed = 0, alerts = 0, kills = 0, saves = 0, cacheWrites = 0, resolveTranslation, progressHandler;
const waitTranslation = () => new Promise(resolve => { resolveTranslation = resolve; });
let pending = waitTranslation();
function el() {
  return { children: [], dataset: {}, style: {}, hidden: false, disabled: false,
    setAttribute() {}, removeAttribute() {}, contains(x) { return this.children.includes(x); },
    appendChild(x) { this.children.push(x); }, addEventListener(k, fn) { this['on' + k] = fn; },
    click() { if (!this.disabled) return this.onclick?.({ stopPropagation() {}, preventDefault() {} }); }
  };
}
const ctx = vm.createContext({
  setTimeout: f => { f(); return 0; },
  Zotero: { locale: 'en-US', isWin: true, debug() {}, logError() {}, Prefs: { get: () => 'ru' },
    Reader: { registerEventListener(name, fn) { if (name === 'renderTextSelectionPopup') listener = fn; } } },
  Services: { prompt: { confirm() { confirmed++; return true; }, alert() { alerts++; } } }
});
vm.runInContext(fs.readFileSync('plugin/chrome/content/easytrans.js', 'utf8'), ctx);
const plugin = ctx.EasyTrans;
plugin.SUCCESS_PAUSE_MS = 0;
plugin.ensureStyles = () => {};
plugin.initializeComponents = async () => {};
plugin.translateText = async (text, source, target, onProgress) => { progressHandler = onProgress; return pending; };
plugin.createTranslationAnnotation = async () => { saves++; return { key: 'a' }; };
plugin.showTranslationPopup = () => {};
plugin.translationCache = { set: async () => { cacheWrites++; } };
plugin.llamaHelper = { cancelCurrent: () => { kills++; } };
plugin.registerReaderIntegration();
const doc = { createElement: () => el(), defaultView: {} };
function popup() {
  let container;
  listener({ reader: {}, doc, params: { annotation: { text: 'A test' } }, append: c => { container = c; } });
  return container;
}
(async () => {
  const first = popup();
  const firstRun = first.children[0].click();
  while (!progressHandler) await Promise.resolve();
  assert.equal(first.children[0].hidden, true);
  progressHandler({ event: 'processing', input_tokens: 700 });
  progressHandler({ event: 'generating', tokens: 700 });
  assert.equal(first.children[1].children[1].children[0].style.width, '31%');
  assert.equal(first.children[1].children[0].children[0].textContent, 'Translating: 700 tokens');
  progressHandler({ event: 'generating', tokens: 2000 });
  assert.equal(first.children[1].children[1].children[0].style.width, '90%');
  const second = popup();
  await second.children[0].click();
  assert.equal(confirmed, 1);
  assert.equal(kills, 1);
  resolveTranslation('translation');
  await firstRun;
  assert.equal(saves, 0);
  assert.equal(cacheWrites, 0);
  assert.equal(plugin._activeTranslation, null);

  pending = waitTranslation();
  const viaButton = popup();
  const buttonRun = viaButton.children[0].click();
  await Promise.resolve();
  viaButton.children[1].children[0].children[1].click();
  assert.equal(kills, 2);
  resolveTranslation('discarded');
  await buttonRun;
  assert.equal(saves, 0);
  assert.equal(cacheWrites, 0);

  pending = Promise.resolve('translation');
  const third = popup();
  await third.children[0].click();
  assert.equal(saves, 1);
  assert.equal(cacheWrites, 1);
  assert.equal(alerts, 0);

  let finishSaving;
  plugin.createTranslationAnnotation = () => new Promise(resolve => { finishSaving = () => resolve({ key: 'b' }); });
  const duringSave = popup();
  const saveRun = duringSave.children[0].click();
  while (!finishSaving) await Promise.resolve();
  const another = popup();
  await another.children[0].click();
  assert.equal(alerts, 1);
  assert.equal(kills, 2);
  assert.equal(duringSave.children[1].children[0].children[1].disabled, true);
  finishSaving();
  await saveRun;
  assert.equal(cacheWrites, 2);
  console.log('Second request, cancellation without save/cache and subsequent success passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
