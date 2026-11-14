#!/usr/bin/env node
/** Update local version metadata and build an XPI for one platform. */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PLATFORMS = { windows: 'win32', macos: 'darwin', linux: 'linux' };

function parsePlatform(args, host = process.platform) {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return null;
    if (args.length === 0) {
        const platform = Object.keys(PLATFORMS).find(key => PLATFORMS[key] === host);
        if (!platform) throw new Error(`Unsupported host platform: ${host}; use --platform.`);
        return platform;
    }
    if (args.length !== 2 || args[0] !== '--platform' || !Object.hasOwn(PLATFORMS, args[1])) {
        throw new Error('Usage: node scripts/build-versioned.js [--platform windows|macos|linux]');
    }
    return args[1];
}

function formatShanghai(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai', year: '2-digit', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}.${values.month}${values.day}.${values.hour}${values.minute}`;
}

function chinaVersion() {
    let bash = 'bash';
    if (process.platform === 'win32') {
        const gitExecPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
        bash = path.resolve(gitExecPath, '..', '..', '..', 'bin', 'bash.exe');
        if (!fs.existsSync(bash)) throw new Error(`Git Bash not found: ${bash}`);
    }
    const before = formatShanghai(new Date());
    const version = execFileSync(bash, ['-c', "TZ=Asia/Shanghai date '+%y.%m%d.%H%M'"], { encoding: 'utf8' }).trim();
    const after = formatShanghai(new Date());
    if (!/^\d{2}\.\d{4}\.\d{4}$/.test(version)) throw new Error(`Invalid version from date: ${version}`);
    // Some Git for Windows installations lack IANA timezone data and silently use UTC.
    if (version !== before && version !== after) {
        console.warn('Git Bash date did not resolve Asia/Shanghai; using Node’s Asia/Shanghai timezone data.');
        return after;
    }
    return version;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
    const original = fs.readFileSync(file, 'utf8');
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    fs.writeFileSync(file, JSON.stringify(data, null, 2).replace(/\n/g, newline) + newline);
}

function checkNative(root, platform) {
    const dir = PLATFORMS[platform];
    const content = path.join(root, 'plugin', 'chrome', 'content');
    const helper = path.join(content, 'bin', dir, dir === 'win32' ? 'llama-helper.exe' : 'llama-helper');
    const manifestPath = path.join(content, 'lib', 'manifest.json');
    if (!fs.existsSync(helper)) throw new Error(`Native helper missing: ${helper}. Bundle libraries and build the helper first.`);
    if (!fs.existsSync(manifestPath)) throw new Error(`Native library manifest missing: ${manifestPath}. Run scripts/bundle-native.js first.`);
    const libraries = readJson(manifestPath)[dir];
    if (!Array.isArray(libraries) || !libraries.length || libraries.some(name => typeof name !== 'string' || path.basename(name) !== name)) {
        throw new Error(`Native library manifest has no valid ${dir} library list.`);
    }
    const required = dir === 'win32'
        ? ['llama.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-x64.dll']
        : [dir === 'darwin' ? 'libllama.dylib' : 'libllama.so'];
    for (const name of required) {
        if (!libraries.includes(name)) throw new Error(`Native library manifest is missing ${name}.`);
    }
    for (const name of libraries) {
        const file = path.join(content, 'lib', dir, name);
        if (!fs.existsSync(file)) throw new Error(`Native library missing: ${file}`);
    }
    const source = path.join(root, 'scripts', 'llama-helper', 'llama_helper.c');
    if (fs.statSync(source).mtimeMs > fs.statSync(helper).mtimeMs) {
        throw new Error('Native helper is older than llama_helper.c. Rebuild it with scripts/build-llama-helper.js before packaging.');
    }
}

function run(script, args = []) {
    const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { cwd: ROOT, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${script} failed (exit ${result.status ?? result.signal}).`);
}

function main() {
    const platform = parsePlatform(process.argv.slice(2));
    if (!platform) {
        console.log('Usage: node scripts/build-versioned.js [--platform windows|macos|linux]');
        console.log('Native libraries and an up-to-date llama-helper must already be prepared.');
        return;
    }
    const manifestPath = path.join(ROOT, 'plugin', 'manifest.json');
    const packagePath = path.join(ROOT, 'package.json');
    const lockPath = path.join(ROOT, 'package-lock.json');
    const manifest = readJson(manifestPath);
    const pkg = readJson(packagePath);
    const lock = readJson(lockPath);
    if (!lock.packages?.['']) throw new Error('package-lock.json is missing its root package.');
    checkNative(ROOT, platform);
    const version = chinaVersion();
    if (version < manifest.version) throw new Error(`China-time version ${version} is older than manifest version ${manifest.version}; check the system clock.`);
    if (version === manifest.version) console.warn(`Version ${version} is unchanged: another build was made in the same minute.`);
    manifest.version = version;
    pkg.version = version;
    lock.version = version;
    lock.packages[''].version = version;
    writeJson(manifestPath, manifest);
    writeJson(packagePath, pkg);
    writeJson(lockPath, lock);
    console.log(`Version: ${version} (Asia/Shanghai); platform: ${platform}`);
    run('generate-update-json.js');
    run('build.js', ['--platform', platform]);
}

if (require.main === module) {
    try { main(); }
    catch (error) { console.error(`Build failed: ${error.message}`); process.exitCode = 1; }
}
module.exports = { parsePlatform, formatShanghai, chinaVersion, checkNative, writeJson };
