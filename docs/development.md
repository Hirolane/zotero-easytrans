# Development guide

Zotero EasyTrans translates selected PDF text offline with TranslateGemma 4B and saves the result as a Zotero annotation. The current development target is Zotero 10 on Windows x64; the manifest also declares compatibility with earlier versions and the project includes macOS/Linux build paths.

## Project structure

```text
zotero-easytrans/
├── plugin/                              # Zotero plugin
│   ├── manifest.json                    # Plugin metadata and version
│   ├── bootstrap.js                     # Plugin lifecycle and settings registration
│   ├── prefs.js                         # Default preferences
│   └── chrome/
│       ├── content/
│       │   ├── easytrans.js             # Reader integration and annotations
│       │   ├── translationPane.js       # Item-pane UI
│       │   ├── modelDownloader.js       # Model download
│       │   ├── cudaRuntime.js           # Optional Windows CUDA runtime
│       │   ├── llamaHelper.js           # Native helper process and progress
│       │   ├── translationCache.js      # Translation cache
│       │   ├── preferences.xhtml        # Settings layout
│       │   ├── preferences.js           # Settings behavior
│       │   ├── icons/                   # SVG icons
│       │   ├── bin/                     # Generated helper executables
│       │   └── lib/                     # Generated native libraries
│       ├── locale/                      # English and Chinese FTL files
│       └── skin/                        # Plugin styles
├── scripts/
│   ├── llama-helper/llama_helper.c      # Native inference helper
│   └── *.js                             # Build, bundle and update scripts
├── tests/                               # Node.js tests
├── docs/                                # Development guides and screenshots
└── package.json, package-lock.json      # Commands and package metadata
```

Generated libraries and helpers under `plugin/chrome/content/lib/` and `bin/` are ignored by Git. The model and downloaded CUDA runtime live in the Zotero profile under `easytrans/models/` and `easytrans/runtimes/`; translation annotations stay in the Zotero library.

## Build and test

Prepare the native libraries and helper, then use the project's build script; do not zip the `plugin` directory manually. The [scripts and tests reference](scripts-and-tests.md) lists prerequisites, commands and test coverage. A Windows build with automatic versioning is:

```powershell
node scripts/build-versioned.js --platform windows
```

The output is `zotero-easytrans.xpi`. Install it in Zotero through **Tools → Add-ons → Install Add-on From File**, restart Zotero, and manually test translation and annotation persistence. Automated Node tests use mocks and do not replace a Zotero or GPU integration test.

## Versioning and updates

Follow [AGENTS.md](../AGENTS.md): the manifest is the version source of truth, with `YY.MMDD.HHMM` in China Standard Time. Keep `package.json` and `package-lock.json` synchronized and regenerate all four local update JSON files after a version change. `build-versioned.js` performs these steps and checks its timestamp against Node's Asia/Shanghai timezone data.

Local builds do not publish. The update URL map and update generator currently reference `hirolane/zotero-easytrans`; inspect them before distribution. The GitHub Actions workflow can create a release and push update files on a push to `main`, so review it before pushing.

## Zotero APIs

The plugin uses `Zotero.ItemPaneManager` for its item-pane section, `Zotero.Reader.registerEventListener` for the selection popup, `Zotero.Annotations.saveFromJSON` for annotations, and `Zotero.PreferencePanes` for Windows settings. `onRender` is synchronous; asynchronous updates use `onAsyncRender`. See the official [Zotero 9](https://www.zotero.org/support/dev/zotero_9_for_developers) and [Zotero 10](https://www.zotero.org/support/dev/zotero_10_for_developers) developer notes when changing compatibility.
