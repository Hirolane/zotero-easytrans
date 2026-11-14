const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parsePlatform, formatShanghai, chinaVersion, checkNative, writeJson } = require('../scripts/build-versioned');

assert.equal(parsePlatform([], 'win32'), 'windows');
assert.equal(parsePlatform(['--platform', 'linux'], 'win32'), 'linux');
assert.equal(parsePlatform(['--help']), null);
assert.throws(() => parsePlatform(['--platform', 'invalid']), /Usage/);
assert.throws(() => parsePlatform(['--platform']), /Usage/);
assert.equal(formatShanghai(new Date('2026-11-14T16:05:00Z')), '26.1115.0005');
assert.equal(formatShanghai(new Date('2026-12-31T16:00:00Z')), '27.0101.0000');
assert.match(chinaVersion(), /^\d{2}\.\d{4}\.\d{4}$/);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easytrans-versioned-build-'));
try {
    const content = path.join(tmpRoot, 'plugin', 'chrome', 'content');
    const lib = path.join(content, 'lib', 'win32');
    const bin = path.join(content, 'bin', 'win32');
    const source = path.join(tmpRoot, 'scripts', 'llama-helper', 'llama_helper.c');
    fs.mkdirSync(lib, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'source');
    fs.writeFileSync(path.join(bin, 'llama-helper.exe'), 'helper');
    const libraries = ['llama.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-x64.dll'];
    for (const name of libraries) fs.writeFileSync(path.join(lib, name), 'dll');
    fs.writeFileSync(path.join(content, 'lib', 'manifest.json'), JSON.stringify({ win32: libraries }));
    fs.utimesSync(source, new Date(0), new Date(0));
    assert.doesNotThrow(() => checkNative(tmpRoot, 'windows'));
    fs.unlinkSync(path.join(lib, 'llama.dll'));
    assert.throws(() => checkNative(tmpRoot, 'windows'), /Native library missing/);
    fs.writeFileSync(path.join(lib, 'llama.dll'), 'dll');
    const future = new Date(Date.now() + 60000);
    fs.utimesSync(source, future, future);
    assert.throws(() => checkNative(tmpRoot, 'windows'), /older than/);
    const jsonFile = path.join(tmpRoot, 'version.json');
    fs.writeFileSync(jsonFile, '{\r\n  "version": "old"\r\n}\r\n');
    writeJson(jsonFile, { version: 'new' });
    assert.equal(fs.readFileSync(jsonFile, 'utf8'), '{\r\n  "version": "new"\r\n}\r\n');
    console.log('Versioned build: arguments, China timestamp, native checks and JSON formatting passed');
} finally {
    const relative = path.relative(os.tmpdir(), tmpRoot);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(tmpRoot, { recursive: true, force: true });
}
