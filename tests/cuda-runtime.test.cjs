const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').posix;

const files = new Map();
const dirs = new Set(['/profile/easytrans/runtimes']);
const IOUtils = {
  async exists(p) { return files.has(p) || dirs.has(p); },
  async stat(p) { if (!files.has(p)) throw Error('missing'); return { size: files.get(p).size }; },
  async makeDirectory(p) { dirs.add(p); },
  async getChildren(p) { return [...dirs].filter(d => path.dirname(d) === p); },
  async copy(a, b) { if (!files.has(a)) throw Error('missing'); files.set(b, { ...files.get(a) }); },
  async remove(p, options) {
    files.delete(p);
    dirs.delete(p);
    if (options?.recursive) {
      for (const key of files.keys()) if (key.startsWith(p + '/')) files.delete(key);
    }
  },
  async writeUTF8(p, data) { files.set(p, { size: data.length }); },
  async move(a, b) {
    if (dirs.has(b)) throw Error('exists');
    dirs.delete(a); dirs.add(b);
    for (const [key, value] of [...files]) if (key.startsWith(a + '/')) { files.delete(key); files.set(b + key.slice(a.length), value); }
  }
};
let runtime;
let wrongHash = false;
const context = vm.createContext({
  IOUtils,
  PathUtils: { join: path.join, parent: path.dirname },
  Zotero: { Profile: { dir: '/profile' }, HTTP: { async download(url, dest, opts) {
    const archive = runtime.archives.find(a => url.endsWith(a.name));
    files.set(dest, { size: archive.size, archive });
    opts.onProgress(archive.size);
  } } },
  Ci: { nsIFile: {}, nsIZipReader: {} },
  Cc: {
    '@mozilla.org/file/local;1': { createInstance: () => ({ initWithPath(p) { this.path = p; } }) },
    '@mozilla.org/libjar/zip-reader;1': { createInstance: () => ({
      open(file) { this.archive = files.get(file.path).archive; },
      hasEntry(name) { return Object.hasOwn(this.archive.files, name); },
      getEntry(name) { return { realSize: this.archive.files[name] }; },
      extract(name, dest) { files.set(dest.path, { size: this.archive.files[name] }); },
      close() {}
    }) }
  }
});
vm.runInContext(fs.readFileSync('plugin/chrome/content/cudaRuntime.js', 'utf8'), context);
runtime = context.CudaRuntime;
runtime.hashFile = p => wrongHash ? 'incorrect' : files.get(p).archive.sha256;

(async () => {
  assert.equal(await runtime.isReady(), false);
  await assert.rejects(runtime.prepare('/native'), /not installed/);
  wrongHash = true;
  await assert.rejects(runtime.download(), /checksum mismatch/);
  assert.equal(await runtime.isReady(), false);
  assert.equal([...files.keys()].filter(p => p.includes('cuda-download-')).length, 0);
  wrongHash = false;
  const progress = [];
  await runtime.download((n, total) => progress.push([n, total]));
  assert.equal(await runtime.isReady(), true);
  assert.equal(progress.at(-1)[0], progress.at(-1)[1]);
  await runtime.prepare('/native');
  for (const archive of runtime.archives) for (const name of Object.keys(archive.files)) assert.ok(files.has('/native/' + name));
  const cachedVersion = '/profile/easytrans/native/revision-a';
  dirs.add('/profile/easytrans/native');
  dirs.add(cachedVersion);
  files.set(cachedVersion + '/win32/ggml-cuda.dll', { size: 1 });
  files.set(cachedVersion + '/win32/llama.dll', { size: 1 });
  await runtime.remove();
  assert.equal(await runtime.isReady(), false);
  assert.equal(files.has(cachedVersion + '/win32/ggml-cuda.dll'), false);
  assert.equal(files.has(cachedVersion + '/win32/llama.dll'), true);
  console.log('CUDA runtime: missing, checksum failure, install, prepare and removal passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
