# Scripts and tests

Run commands from the repository root. Node.js 18 or newer is used by the existing CI workflow. Windows builds also need Git Bash, `unzip`, and a C compiler; MSVC requires a Visual Studio developer shell.

## Scripts

| Command | Purpose |
| --- | --- |
| `node scripts/bundle-native.js win32-x64` | Download the pinned llama.cpp b8252 Windows CPU libraries and write their manifest. `--current` selects the host platform. |
| `node scripts/build-llama-helper.js --include "$env:LLAMA_INCLUDE"` | Compile the helper using the provided llama.cpp and ggml header directories. The shown command is for PowerShell. |
| `node scripts/build.js --platform windows` | Package existing files as an XPI with the Windows update URL; does not change the version or build native code. |
| `node scripts/build-versioned.js --platform windows` | Check native files, update the version and local update JSON files, then build the XPI. The platform defaults to the host; `macos` and `linux` are also accepted. |
| `node scripts/generate-update-json.js` | Regenerate the four local update JSON files from `plugin/manifest.json`. |

For the npm aliases, see `package.json`. For example, `npm run build:versioned -- --platform windows` runs the versioned build. `npm run bundle-all` bundles libraries and packages the XPI, but does **not** compile the helper.

### Preparing Windows native files

Download the llama.cpp **b8252** source headers separately, outside the repository's `.build-temp` directory. In a PowerShell session with MSVC and `unzip` on `PATH`:

```powershell
node scripts/bundle-native.js win32-x64
$env:LLAMA_INCLUDE = 'C:\path\llama.cpp-b8252\include;C:\path\llama.cpp-b8252\ggml\include'
node scripts/build-llama-helper.js --include "$env:LLAMA_INCLUDE"
node scripts/build-versioned.js --platform windows
```

Replace the example paths. The bundler removes `.build-temp` by default; `--keep-temp` retains it. The versioned build stops if native files are missing or the helper is older than its C source. It does not download or rebuild them. CUDA components are downloaded separately by the plugin at runtime.

## Automated tests

Run all tracked tests explicitly, including on Windows where shell glob expansion may differ:

```powershell
node --test tests/cuda-runtime.test.cjs tests/helper-progress.test.cjs tests/preferences-removal.test.cjs tests/preferences-selection.test.cjs tests/translation-cancel.test.cjs tests/versioned-build.test.cjs
```

The tests cover mocked CUDA installation/removal, helper progress messages, settings and removal confirmation, translation cancellation, and version/build preflight. The version test invokes Git Bash on Windows. These tests do not download the model or CUDA libraries, open Zotero, or test GPU inference.

## Manual Zotero 10 check

Install the generated XPI and restart Zotero. Open a PDF, choose the target language and device, translate a new selection, and verify the result and annotation after restarting Zotero. Also check progress, cancellation, duplicate-request handling, settings, and CPU/GPU switching. For GPU, install the CUDA components from EasyTrans settings and verify actual GPU use; use different selections when comparing speed to avoid cache hits.
