/* eslint-disable no-undef */
/**
 * Zotero EasyTrans - Main Logic
 * Uses Zotero 8 Plugin APIs
 */

var EasyTrans = {
    id: null,
    version: null,
    rootURI: null,
    initialized: false,
    componentsInitialized: false,
    modelDownloader: null,
    llamaHelper: null,
    translationCache: null,
    _readerIntegrationRegistered: false,
    translationRecords: new Map(),
    _summaryRefreshPending: false,
    _paneBodies: new Set(),
    _downloadStateUnsubscribe: null,
    _devicePrefObserver: null,
    _activeTranslation: null,
    SUCCESS_PAUSE_MS: 500,
    ESTIMATED_OUTPUT_TOKEN_MULTIPLIER: 3,

    // Supported languages
    LANGUAGES: {
        "en": "English",
        "zh-CN": "简体中文",
        "zh-TW": "繁體中文",
        "hi": "हिन्दी",
        "es": "Español",
        "ar": "العربية",
        "fr": "Français",
        "pt": "Português",
        "ru": "Русский",
        "de": "Deutsch",
        "ja": "日本語",
        "ko": "한국어",
        "it": "Italiano",
        "nl": "Nederlands"
    },

    /**
     * Initialize the plugin
     */
    async init() {
        if (this.initialized) return;

        Zotero.debug("EasyTrans: Initializing...");

        try {
            Services.scriptloader.loadSubScript(this.rootURI + "chrome/content/cudaRuntime.js");
            // Load model downloader module
            Services.scriptloader.loadSubScript(
                this.rootURI + "chrome/content/modelDownloader.js"
            );
            this.modelDownloader = new ModelDownloader();
            Zotero.EasyTransModelDownloader = this.modelDownloader;
            this._devicePrefObserver = Zotero.Prefs.registerObserver("extensions.easytrans.computeDevice", value => {
                for (const body of this._paneBodies) {
                    const select = body.querySelector("#easytrans-device");
                    if (select) select.value = value === "gpu" ? "gpu" : "cpu";
                }
            });
            this._downloadStateUnsubscribe = this.modelDownloader.subscribe(() => {
                this.updateDownloadUI();
            });
            await this.modelDownloader.refreshState();
            Zotero.debug("EasyTrans: ModelDownloader loaded");

            // Load translation pane UI
            Services.scriptloader.loadSubScript(
                this.rootURI + "chrome/content/translationPane.js"
            );

            // Register UI components
            this.registerUI();

            // Register reader integration for selection translation
            this.registerReaderIntegration();

            this.initialized = true;
            Zotero.debug("EasyTrans: Initialization complete");

        } catch (error) {
            Zotero.debug("EasyTrans: Initialization failed - " + error.message);
            Zotero.logError(error);
        }
    },

    /**
     * Request a safe pane refresh (avoid refresh loops)
     */
    requestSummaryRefresh() {
        if (this._summaryRefreshPending || !this._refreshPane) return;
        this._summaryRefreshPending = true;
        setTimeout(() => {
            try {
                this._refreshPane?.();
            } finally {
                this._summaryRefreshPending = false;
            }
        }, 0);
    },

    /**
     * Shutdown the plugin
     */
    async shutdown() {
        Zotero.debug("EasyTrans: Shutting down...");

        // Cleanup inference engine
        if (this.llamaHelper) {
            await this.llamaHelper.dispose();
            this.llamaHelper = null;
        }

        // Cleanup cache
        if (this.translationCache) {
            await this.translationCache.close();
            this.translationCache = null;
        }

        this._downloadStateUnsubscribe?.();
        this._downloadStateUnsubscribe = null;
        if (this._devicePrefObserver) Zotero.Prefs.unregisterObserver(this._devicePrefObserver);
        this._devicePrefObserver = null;
        if (Zotero.EasyTransModelDownloader === this.modelDownloader) {
            delete Zotero.EasyTransModelDownloader;
        }
        this._paneBodies.clear();

        this.initialized = false;
        Zotero.debug("EasyTrans: Shutdown complete");
    },

    /**
     * Initialize translation components (lazy loading)
     */
    async initializeComponents() {
        if (this.componentsInitialized) {
            Zotero.debug("EasyTrans: Components already initialized");
            return;
        }

        Zotero.debug("EasyTrans: Initializing translation components...");

        // Load additional scripts only once
        Services.scriptloader.loadSubScript(
            this.rootURI + "chrome/content/llamaHelper.js"
        );
        Services.scriptloader.loadSubScript(
            this.rootURI + "chrome/content/translationCache.js"
        );

        // Initialize cache
        this.translationCache = new TranslationCache();
        await this.translationCache.init();

        this.componentsInitialized = true;
        Zotero.debug("EasyTrans: Translation components initialized");
    },

    /**
     * Initialize the LLM inference engine
     */
    async initializeInference() {
        if (this.llamaHelper?.isLoaded()) {
            return;
        }

        Zotero.debug("EasyTrans: Initializing inference engine...");

        const modelPath = await this.modelDownloader.getModelPath();

        if (!await this.modelDownloader.isModelDownloaded()) {
            throw new Error("Model not downloaded");
        }

        this.llamaHelper = new LlamaHelper();
        // Use maximum context size in helper (0 = auto/max by model)
        const contextSize = 0;
        const maxTokens = Zotero.Prefs.get("extensions.easytrans.maxTokens") || 2048;
        await this.llamaHelper.initialize(modelPath, contextSize, maxTokens);

        Zotero.debug("EasyTrans: Inference engine ready");
    },

    /**
     * Translate text using the LLM
     */
    async translateText(text, sourceLang, targetLang, onProgress, job) {
        // Check cache first
        const cached = await this.translationCache?.get(text, sourceLang, targetLang);
        job?.check();
        if (cached) {
            Zotero.debug("EasyTrans: Cache hit for translation");
            return cached;
        }

        // Ensure model is loaded
        if (!this.llamaHelper?.isLoaded()) {
            await this.initializeInference();
        }
        job?.check();

        // Translate
        return await this.llamaHelper.translate(text, sourceLang, targetLang, onProgress, job);
    },

    /**
     * Download the translation model
     */
    async downloadModel(window, options = {}) {
        if (!this.modelDownloader) {
            Zotero.debug("EasyTrans: ModelDownloader not initialized");
            return false;
        }

        try {
            return await this.modelDownloader.showDownloadDialog(options);
        } catch (e) {
            Zotero.debug("EasyTrans: Download failed - " + e.message);
            return false;
        }
    },

    cancelModelDownload() {
        this.modelDownloader?.cancelDownload?.();
    },

    async armModelRedownload() {
        return await this.modelDownloader?.armRedownload?.();
    },

    getDownloadState() {
        return this.modelDownloader?.getState?.() || null;
    },

    async refreshDownloadState() {
        return await this.modelDownloader?.refreshState?.();
    },

    registerPaneBody(body) {
        if (!body) return;
        this._paneBodies.add(body);
        this.updateDownloadUI();
    },

    unregisterPaneBody(body) {
        if (!body) return;
        this._paneBodies.delete(body);
    },

    updateDownloadUI() {
        if (typeof TranslationPane?.updateDownloadUI !== "function") {
            return;
        }

        const state = this.getDownloadState();
        for (const body of [...this._paneBodies]) {
            if (!body?.isConnected) {
                this._paneBodies.delete(body);
                continue;
            }

            try {
                TranslationPane.updateDownloadUI(body, state);
            } catch (e) {
                Zotero.debug("EasyTrans: Failed to update download UI - " + e.message);
            }
        }
    },

    /**
     * Check if model is downloaded
     */
    async isModelReady() {
        if (!this.modelDownloader) return false;
        try {
            return await this.modelDownloader.isModelDownloaded();
        } catch (e) {
            return false;
        }
    },

    /**
     * Get model info
     */
    async getModelInfo() {
        if (!this.modelDownloader) {
            return { downloaded: false, sizeFormatted: "Not available" };
        }
        try {
            return await this.modelDownloader.getModelInfo();
        } catch (e) {
            return { downloaded: false, sizeFormatted: "Error" };
        }
    },

    /**
     * Store a translated selection record for the current reader item
     */
    addTranslationRecord(itemID, record) {
        if (!itemID || !record) return;
        const list = this.translationRecords.get(itemID) || [];
        list.unshift(record);
        if (list.length > 200) {
            list.length = 200;
        }
        this.translationRecords.set(itemID, list);
    },

    /**
     * Get translated selection records for a reader item
     */
    getTranslationRecords(itemID) {
        if (!itemID) return [];
        return this.translationRecords.get(itemID) || [];
    },

    /**
     * Navigate to an annotation by key in the active reader
     */
    async navigateToAnnotation(annotationID) {
        const reader = this.getActiveReader();
        if (!reader || !annotationID) return;
        try {
            await reader.navigate({ annotationID });
            reader.selectAnnotations([annotationID]);
        } catch (e) {
            Zotero.debug("EasyTrans: Failed to navigate to annotation - " + e.message);
        }
    },

    /**
     * Get the active reader instance from the current Zotero window
     */
    getActiveReader() {
        const win = Zotero.getMainWindow();
        const tabs = win?.Zotero_Tabs;
        if (!tabs || tabs.selectedType !== "reader") return null;
        const tabID = tabs.selectedID;
        if (!tabID) return null;
        return Zotero.Reader.getByTabID(tabID) || null;
    },

    /**
     * Normalize translation output for display and annotations
     */
    normalizeTranslation(text) {
        if (!text) return "";
        let normalized = text;
        normalized = normalized.replace(/(?:\\n|\\r|[\\\s])*\\?<\\?\/?end_of_turn\s*>[\s\S]*$/i, "");
        normalized = normalized.replace(/^\s*(auto[- ]detected:.*|auto[- ]detected language:.*|detected language:.*)\s*$/gim, "");
        normalized = normalized.replace(/(^|\n)\s*(auto[- ]detected:.*|auto[- ]detected language:.*|detected language:.*)\s*(\n|$)/gim, "\n");
        normalized = normalized.replace(/\r\n/g, "\n");
        normalized = normalized.replace(/\\n/g, "\n");
        normalized = normalized.replace(/[ \t]+\n/g, "\n");
        normalized = normalized.replace(/\n{3,}/g, "\n\n");
        return normalized.trim();
    },

    /**
     * Ensure EasyTrans styles are loaded in a document
     */
    ensureStyles(doc) {
        if (!doc) return;
        const linkExisting = doc.querySelector('link[data-easytrans-style="true"]');
        if (!linkExisting) {
            const link = doc.createElement("link");
            link.rel = "stylesheet";
            link.href = this.rootURI + "chrome/skin/easytrans.css";
            link.setAttribute("data-easytrans-style", "true");

            if (doc.head) {
                doc.head.appendChild(link);
            } else if (doc.documentElement) {
                doc.documentElement.appendChild(link);
            }
        }

        const inlineExisting = doc.querySelector('style[data-easytrans-inline="true"]');
        if (inlineExisting) return;

        const style = doc.createElement("style");
        style.setAttribute("data-easytrans-inline", "true");
        style.textContent = `
            .selection-popup .easytrans-selection-popup {
                background: var(--material-toolbar, #f9f9f9) !important;
                box-shadow: none !important;
            }
            .easytrans-selection-popup button.easytrans-translate-selection {
                display: flex; align-items: center; box-sizing: border-box;
                width: 100%; min-height: 24px; padding: 1px 4px;
                font-size: 12px; text-align: start;
            }
            .easytrans-selection-popup .easytrans-translate-selection[hidden] { display: none !important; }
            .easytrans-selection-popup .easytrans-translation-progress {
                box-sizing: border-box; width: 100%; min-width: 0;
                background: transparent !important;
                color: var(--fill-primary, #263344); font-size: 12px;
            }
            .easytrans-selection-popup .easytrans-translation-progress[hidden] { display: none !important; }
            .easytrans-selection-popup .easytrans-progress-row {
                display: flex !important; flex-wrap: nowrap !important; align-items: center;
                box-sizing: border-box; min-height: 24px; gap: 6px; padding: 1px 4px;
                background: transparent !important; box-shadow: none !important;
            }
            .easytrans-selection-popup .easytrans-progress-label {
                flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
                background: transparent !important;
            }
            .easytrans-selection-popup button.easytrans-progress-cancel {
                display: inline-flex !important; flex: 0 0 22px !important; align-items: center;
                justify-content: center; box-sizing: border-box; width: 22px !important;
                min-width: 22px !important; height: 22px !important; padding: 0 !important;
                margin: 0 !important; border: 0 !important; border-radius: 7px;
                background: #fff0f0 !important; color: #d32030 !important;
                font-size: 18px !important; font-weight: 600; line-height: 1; cursor: pointer;
            }
            .easytrans-selection-popup button.easytrans-progress-cancel:hover { background: #ffdddd !important; }
            .easytrans-selection-popup button.easytrans-progress-cancel:disabled { opacity: .4; cursor: default; }
            .easytrans-selection-popup button.easytrans-progress-cancel[hidden] { display: none !important; }
            .easytrans-selection-popup .easytrans-progress-track { width: 100%; height: 5px; background: #e7ecf4; border-radius: 0; overflow: hidden; }
            .easytrans-selection-popup .easytrans-progress-bar { height: 100%; background: #3068eb; transition: width .2s ease; }
            .easytrans-selection-popup .easytrans-translation-progress[data-indeterminate="true"] .easytrans-progress-bar {
                width: 35% !important; animation: easytrans-progress 1.2s ease-in-out infinite;
            }
            .easytrans-selection-popup .easytrans-translation-progress[data-state="done"] .easytrans-progress-bar { background: #0bb57c; }
            @keyframes easytrans-progress { from { transform: translateX(-110%); } to { transform: translateX(300%); } }
            @media (prefers-reduced-motion: reduce) { .easytrans-progress-bar { animation: none !important; transition: none; } }
            .easytrans-translation-popup {
                position: fixed;
                width: min(520px, calc(100vw - 40px));
                min-width: min(320px, calc(100vw - 40px));
                max-height: 65vh;
                background: var(--material-background);
                border: 1px solid var(--fill-quinary);
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                z-index: 9999;
                overflow: hidden;
                cursor: pointer;
            }
            .easytrans-popup-content {
                padding: 14px;
                max-height: 65vh;
                overflow-y: auto;
                font-size: 16px;
                line-height: 1.7;
                white-space: pre-wrap;
            }
            .annotation-popup,
            .preview {
                --note-font-size: 1rem;
            }
            .annotation-popup .editor,
            .preview .editor,
            .annotation-popup .content {
                font-size: 16px;
                line-height: 1.7;
            }
            .annotation-popup {
                width: min(900px, 80vw);
                min-width: min(540px, calc(100vw - 40px));
                max-width: min(900px, 80vw);
            }
            .annotation-popup .content {
                max-height: 40vh;
            }
            .easytrans-toast {
                position: fixed;
                right: 16px;
                bottom: 16px;
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 10px;
                background: var(--material-background);
                border: 1px solid var(--fill-quinary);
                border-radius: 6px;
                box-shadow: 0 6px 18px rgba(0, 0, 0, 0.15);
                z-index: 10000;
                font-size: 12px;
                color: var(--fill-primary);
            }
            .easytrans-toast button {
                border: none;
                background: var(--accent-blue, #2d74ff);
                color: #fff;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 12px;
                cursor: pointer;
            }
            .easytrans-toast button:hover {
                background: var(--accent-blue-darker, #2258c7);
            }
            .easytrans-toast-close {
                border: none;
                background: transparent;
                color: var(--fill-secondary);
                cursor: pointer;
                font-size: 14px;
                line-height: 1;
            }
        `;
        if (doc.head) {
            doc.head.appendChild(style);
        } else if (doc.documentElement) {
            doc.documentElement.appendChild(style);
        }
    },

    /**
     * Show translation popup in reader UI
     */
    showTranslationPopup(doc, translatedText, targetLang, isError = false) {
        if (!doc?.body) return;

        this.ensureStyles(doc);

        const existing = doc.querySelector(".easytrans-translation-popup");
        if (existing) {
            existing.remove();
        }

        const normalizedText = this.normalizeTranslation(translatedText);

        const popup = doc.createElement("div");
        popup.className = "easytrans-translation-popup";

        const content = doc.createElement("div");
        content.className = "easytrans-popup-content";
        content.textContent = normalizedText || translatedText;

        popup.appendChild(content);
        doc.body.appendChild(popup);
        popup.addEventListener("click", () => popup.remove());

        const win = doc.defaultView;
        if (win) {
            popup.style.left = "auto";
            popup.style.top = "auto";
            popup.style.right = "20px";
            popup.style.bottom = "20px";
        }
    },

    /**
     * Cache selection rect for popup positioning
     */
    captureSelectionRect(doc, rectLike, reader, position) {
        try {
            if (rectLike) {
                // rectLike can be [left, top, right, bottom] or DOMRect-like
                if (Array.isArray(rectLike) && rectLike.length >= 4) {
                    this._lastSelectionRect = {
                        left: rectLike[0],
                        top: rectLike[1],
                        right: rectLike[2],
                        bottom: rectLike[3]
                    };
                    return;
                }
                if (typeof rectLike.left === "number") {
                    this._lastSelectionRect = rectLike;
                    return;
                }
            }
            if (reader && position) {
                const view = reader._view || reader._primaryView || reader._lastView || reader._internalReader?._primaryView;
                if (view && typeof view.getClientRectForPopup === "function") {
                    let rectArr = null;
                    try {
                        rectArr = view.getClientRectForPopup(position);
                        if ((!rectArr || rectArr.length < 4) && view._iframeWindow) {
                            const node = view._iframeWindow.document.getElementById("viewerContainer");
                            rectArr = view.getClientRectForPopup(position, node?.scrollLeft || 0, node?.scrollTop || 0);
                        }
                    } catch (e) { }
                    if (Array.isArray(rectArr) && rectArr.length >= 4) {
                        this._lastSelectionRect = {
                            left: rectArr[0],
                            top: rectArr[1],
                            right: rectArr[2],
                            bottom: rectArr[3],
                            width: rectArr[2] - rectArr[0],
                            height: rectArr[3] - rectArr[1]
                        };
                        return;
                    }
                }
            }
            const sel = doc.getSelection?.();
            if (!sel || sel.rangeCount === 0) {
                this._lastSelectionRect = null;
                return;
            }
            const range = sel.getRangeAt(0);
            let rect = range.getBoundingClientRect();
            if ((!rect || (!rect.width && !rect.height)) && range.getClientRects) {
                const rects = range.getClientRects();
                rect = rects?.length ? rects[0] : rect;
            }
            this._lastSelectionRect = rect || null;
        } catch (e) {
            this._lastSelectionRect = null;
        }
    },

    /**
     * Show a non-blocking toast after translation
     */
    showTranslationToast(doc, reader, annotationItem) {
        if (!doc?.body) return;
        this.ensureStyles(doc);

        const existing = doc.querySelector(".easytrans-toast");
        if (existing) {
            existing.remove();
        }

        const locale = (Zotero?.locale || "").toLowerCase();
        const message = locale.startsWith("zh")
            ? "翻译完成"
            : "Translation saved";
        const actionLabel = locale.startsWith("zh")
            ? "定位注释"
            : "Locate highlight";

        const toast = doc.createElement("div");
        toast.className = "easytrans-toast";

        const text = doc.createElement("span");
        text.textContent = message;

        const action = doc.createElement("button");
        action.type = "button";
        action.textContent = actionLabel;
        action.addEventListener("click", () => {
            this.focusAnnotation(reader, annotationItem);
            toast.remove();
        });

        const close = doc.createElement("button");
        close.type = "button";
        close.className = "easytrans-toast-close";
        close.textContent = "×";
        close.addEventListener("click", () => toast.remove());

        toast.appendChild(text);
        toast.appendChild(action);
        toast.appendChild(close);
        doc.body.appendChild(toast);

        const win = doc.defaultView;
        if (win) {
            win.setTimeout(() => {
                if (toast.isConnected) toast.remove();
            }, 10000);
        }
    },

    /**
     * Focus annotation in the reader safely (no popup)
     */
    focusAnnotation(reader, annotationItem) {
        if (!reader || !annotationItem) return;
        const annotationID = annotationItem.key || annotationItem.id;
        if (!annotationID) return;

        try {
            if (typeof reader.toggleSidebar === "function") {
                reader.toggleSidebar(true);
            }
            if (typeof reader.setSidebarView === "function") {
                reader.setSidebarView("annotations");
            }
            if (typeof reader.navigate === "function") {
                reader.navigate({ annotationID });
            }
        } catch (e) {
            Zotero.debug("EasyTrans: Failed to focus annotation - " + e.message);
        }
    },

    /**
     * Create a translated annotation from a selection
     */
    async createTranslationAnnotation(reader, baseAnnotation, translatedText, targetLang) {
        if (!reader?.itemID) return null;
        const attachment = await Zotero.Items.getAsync(reader.itemID);
        if (!attachment) return null;

        const position = baseAnnotation?.position;
        if (!position) {
            throw new Error("Selection position not available");
        }

        const normalizedText = this.normalizeTranslation(translatedText);
        const comment = `EasyTrans (${targetLang}): ${normalizedText || translatedText}`;
        const json = {
            key: Zotero.Utilities.generateObjectKey(),
            type: baseAnnotation?.type || "highlight",
            authorName: "EasyTrans",
            text: baseAnnotation?.text || "",
            comment,
            color: baseAnnotation?.color || "#ffd400",
            pageLabel: baseAnnotation?.pageLabel,
            sortIndex: baseAnnotation?.sortIndex,
            position,
            isExternal: false
        };

        const item = await Zotero.Annotations.saveFromJSON(attachment, json);
        if (item) {
            await reader.setAnnotations([item]);
            this.addTranslationRecord(reader.itemID, {
                annotationID: item.key,
                pageLabel: baseAnnotation?.pageLabel || "",
                text: (baseAnnotation?.text || "").trim(),
                translation: normalizedText || translatedText,
                createdAt: Date.now()
            });
        }
        return item;
    },

    /**
     * Load translated selection records from annotations for an attachment
     */
    async getTranslationRecordsFromAnnotations(itemID) {
        if (!itemID) return [];
        const attachment = await Zotero.Items.getAsync(itemID);
        if (!attachment || !attachment.isFileAttachment?.()) return [];

        let records = [];
        let annotations = [];
        try {
            annotations = attachment.getAnnotations(false) || [];
        } catch (e) {
            Zotero.debug("EasyTrans: Failed to load annotations - " + e.message);
            return [];
        }

        for (const annotation of annotations) {
            if (!annotation?.isAnnotation?.()) continue;
            const comment = annotation.annotationComment || "";
            const author = annotation.annotationAuthorName || "";
            const isEasyTrans = author === "EasyTrans" || comment.startsWith("EasyTrans");
            if (!isEasyTrans) continue;

            let translation = comment;
            const colonIndex = comment.indexOf(":");
            if (colonIndex !== -1) {
                translation = comment.slice(colonIndex + 1).trim();
            }

            const sortIndex = annotation.annotationSortIndex || annotation.sortIndex || "";
            let pageNumber = null;
            const pageLabel = annotation.annotationPageLabel || "";
            if (pageLabel) {
                const parsed = parseInt(pageLabel, 10);
                if (!Number.isNaN(parsed)) pageNumber = parsed;
            }

            records.push({
                annotationID: annotation.key,
                pageLabel,
                text: (annotation.annotationText || "").trim(),
                translation: translation.trim(),
                createdAt: Date.parse(annotation.dateAdded) || 0,
                sortIndex,
                pageNumber
            });
        }

        records.sort((a, b) => {
            if (a.sortIndex && b.sortIndex) {
                const cmp = String(a.sortIndex).localeCompare(String(b.sortIndex));
                if (cmp !== 0) return cmp;
            } else if (a.sortIndex && !b.sortIndex) {
                return -1;
            } else if (!a.sortIndex && b.sortIndex) {
                return 1;
            }

            if (a.pageNumber != null && b.pageNumber != null) {
                if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
            } else if (a.pageNumber != null && b.pageNumber == null) {
                return -1;
            } else if (a.pageNumber == null && b.pageNumber != null) {
                return 1;
            }

            return (a.createdAt || 0) - (b.createdAt || 0);
        });
        return records;
    },

    /**
     * Register reader integration for selection translation
     */
    registerReaderIntegration() {
        if (this._readerIntegrationRegistered) return;
        this._readerIntegrationRegistered = true;

        const self = this;

        try {
            Zotero.Reader.registerEventListener("renderToolbar", (event) => {
                self.ensureStyles(event.doc);
            }, this.id);

            Zotero.Reader.registerEventListener("renderSidebarAnnotationHeader", (event) => {
                self.ensureStyles(event.doc);
            }, this.id);

            Zotero.Reader.registerEventListener("renderTextSelectionPopup", (event) => {
                const { reader, doc, params, append } = event;
                self.ensureStyles(doc);
                const selectionText = params?.annotation?.text || "";
                if (!selectionText.trim()) return;

                const container = doc.createElement("div");
                container.className = "easytrans-selection-popup";
                container.setAttribute("role", "button");
                container.tabIndex = 0;

                const button = doc.createElement("button");
                button.className = "easytrans-translate-selection";
                button.textContent = "Translate selected text";

                const progressBox = doc.createElement("div");
                progressBox.className = "easytrans-translation-progress";
                progressBox.hidden = true;
                progressBox.setAttribute("role", "status");
                progressBox.setAttribute("aria-live", "polite");

                const progressText = doc.createElement("div");
                progressText.className = "easytrans-progress-row";

                const statusText = doc.createElement("span");
                statusText.className = "easytrans-progress-label";
                const cancelButton = doc.createElement("button");

                cancelButton.type = "button";
                cancelButton.className = "easytrans-progress-cancel";
                cancelButton.textContent = "×";
                cancelButton.title = Zotero.locale?.startsWith("ru") ? "Отменить перевод" : "Cancel translation";
                cancelButton.setAttribute("aria-label", cancelButton.title);

                progressText.appendChild(statusText);
                progressText.appendChild(cancelButton);

                const track = doc.createElement("div");
                track.className = "easytrans-progress-track";

                const bar = doc.createElement("div");
                bar.className = "easytrans-progress-bar";

                track.appendChild(bar);
                progressBox.appendChild(progressText);
                progressBox.appendChild(track);

                const ru = Zotero.locale?.startsWith("ru");
                let inputTokens = 0;
                let estimate = 0;
                const updateProgress = progress => {
                    if (self._activeTranslation?.cancelled && progress.event !== "cancelled") return;
                    progressBox.dataset.state = progress.event === "done" ? "done" : progress.event === "cancelled" ? "cancelled" : "working";
                    if (progress.event === "loading") {
                        const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
                        statusText.textContent = ru ? "Загрузка модели…" : "Loading model…";
                        progressBox.dataset.indeterminate = "false";
                        bar.style.width = `${percent}%`;
                    } else if (progress.event === "processing") {
                        inputTokens = Math.max(0, Math.floor(progress.input_tokens || 0));
                        statusText.textContent = ru ? "Обработка текста…" : "Processing text…";
                        progressBox.dataset.indeterminate = "true";
                    } else if (progress.event === "generating") {
                        const tokens = Math.max(0, Math.floor(progress.tokens || 0));
                        statusText.textContent = ru ? `Перевод: ${tokens} токенов` : `Translating: ${tokens} tokens`;
                        progressBox.dataset.indeterminate = inputTokens ? "false" : "true";
                        if (inputTokens) {
                            estimate = Math.max(estimate, Math.min(95, Math.floor(tokens / (inputTokens * self.ESTIMATED_OUTPUT_TOKEN_MULTIPLIER) * 95)));
                            bar.style.width = `${estimate}%`;
                        }
                    } else if (progress.event === "saving") {
                        statusText.textContent = ru ? "Сохранение аннотации…" : "Saving annotation…";
                        cancelButton.disabled = true;
                    } else if (progress.event === "done") {
                        statusText.textContent = ru ? "Переведено" : "Translated";
                        progressBox.dataset.indeterminate = "false";
                        bar.style.width = "100%";
                        cancelButton.hidden = true;
                    } else if (progress.event === "cancelled") {
                        statusText.textContent = ru ? "Перевод отменён" : "Translation cancelled";
                        progressBox.dataset.indeterminate = "false";
                        bar.style.width = "0%";
                        cancelButton.disabled = true;
                    } else {
                        statusText.textContent = ru ? "Запуск переводчика…" : "Starting translator…";
                        progressBox.dataset.indeterminate = "true";
                    }
                };

                container.addEventListener("click", (event) => {
                    if (event.target === button || button.contains(event.target)) return;
                    button.click();
                });
                container.addEventListener("keydown", (event) => {
                    if (event.target === cancelButton || cancelButton.contains(event.target)) return;
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        button.click();
                    }
                });

                button.addEventListener("click", async (event) => {
                    event.stopPropagation();
                    if (self._activeTranslation) {
                        const active = self._activeTranslation;
                        if (active.phase === "saving" || active.phase === "done") {
                            Services.prompt.alert(doc.defaultView, "EasyTrans", ru ? "Перевод уже завершается." : "A translation is finishing.");
                        } else if (active.cancelled) {
                            Services.prompt.alert(doc.defaultView, "EasyTrans", ru ? "Отмена перевода выполняется. Подождите немного." : "Translation cancellation is in progress. Please wait.");
                        } else if (Services.prompt.confirm(doc.defaultView, "EasyTrans", ru ? "Уже выполняется перевод. Отменить его?" : "A translation is already running. Cancel it?")) {
                            active.cancel();
                        }
                        return;
                    }
                    const job = {
                        cancelled: false,
                        phase: "translating",
                        check() {
                            if (this.cancelled) {
                                const error = new Error("Translation cancelled");
                                error.name = "AbortError";
                                throw error;
                            }
                        },
                        cancel() {
                            if (this.cancelled || this.phase !== "translating") return;
                            this.cancelled = true;
                            updateProgress({ event: "cancelled" });
                            self.llamaHelper?.cancelCurrent();
                        }
                    };
                    self._activeTranslation = job;
                    cancelButton.disabled = false;
                    cancelButton.hidden = false;
                    cancelButton.onclick = cancelEvent => {
                        cancelEvent.preventDefault();
                        cancelEvent.stopPropagation();
                        job.cancel();
                    };
                    inputTokens = 0;
                    estimate = 0;
                    bar.style.width = "0%";
                    button.disabled = true;
                    button.hidden = true;
                    progressBox.hidden = false;
                    updateProgress({ event: "starting" });
                    let stage = "initializing translation components";
                    try {
                        await self.initializeComponents();
                        job.check();
                        const targetLang = Zotero.Prefs.get("extensions.easytrans.targetLanguage") || "zh-CN";
                        stage = "translating text";
                        const translated = await self.translateText(selectionText, "auto", targetLang, updateProgress, job);
                        job.check();
                        const normalized = self.normalizeTranslation(translated);

                        stage = "saving annotation";
                        job.phase = "saving";
                        updateProgress({ event: "saving" });
                        const annotation = await self.createTranslationAnnotation(reader, params.annotation, normalized || translated, targetLang);
                        if (!annotation) throw new Error("Failed to save translation annotation");
                        try { await self.translationCache?.set(selectionText, "auto", targetLang, translated); }
                        catch (cacheError) { Zotero.logError(cacheError); }
                        job.phase = "done";
                        updateProgress({ event: "done" });
                        await new Promise(resolve => setTimeout(resolve, self.SUCCESS_PAUSE_MS));
                        self.showTranslationPopup(doc, normalized || translated, targetLang);
                        if (self._refreshPane) {
                            self._refreshPane();
                        }
                    } catch (e) {
                        if (job.cancelled || e?.name === "AbortError") {
                            updateProgress({ event: "cancelled" });
                            await new Promise(resolve => setTimeout(resolve, self.SUCCESS_PAUSE_MS));
                        } else {
                            const detail = e?.message || String(e);
                            const message = `Translation failed while ${stage}: ${detail}`;
                            Zotero.debug("EasyTrans: " + message);
                            Zotero.logError(e);
                            try {
                                Services.prompt.alert(doc.defaultView, "EasyTrans Error", message);
                            } catch (alertError) {
                                self.showTranslationPopup(doc, message, "error", true);
                            }
                        }
                    } finally {
                        if (self._activeTranslation === job) self._activeTranslation = null;
                        button.disabled = false;
                        button.hidden = false;
                        progressBox.hidden = true;
                    }
                });

                container.appendChild(button);
                container.appendChild(progressBox);
                append(container);
            }, this.id);

            Zotero.debug("EasyTrans: Reader integration registered");
        } catch (e) {
            Zotero.debug("EasyTrans: Failed to register reader integration - " + e.message);
            Zotero.logError(e);
        }
    },

    /**
     * Register UI components using Zotero's Plugin APIs
     */
    registerUI() {
        Zotero.debug("EasyTrans: Registering UI components...");

        const iconPath = this.rootURI + "chrome/content/icons/easytrans.svg";
        const iconPath20 = this.rootURI + "chrome/content/icons/easytrans-20.svg";

        // Store reference to this for callbacks
        const self = this;
        const ensureSectionLabel = (body) => {
            try {
                const section = body?.closest?.("collapsible-section");
                if (!section) return;
                const desired = "EasyTrans";
                if (!section.label || section.label !== desired) {
                    section.label = desired;
                    section.setAttribute("label", desired);
                }
            } catch (e) { }
        };

        // Register Item Pane Section
        try {
            const paneID = Zotero.ItemPaneManager.registerSection({
                paneID: "easytrans-section",
                pluginID: this.id,
                header: {
                    l10nID: "easytrans-pane-header",
                    label: "EasyTrans",
                    icon: iconPath
                },
                sidenav: {
                    l10nID: "easytrans-sidenav",
                    label: "EasyTrans",
                    icon: iconPath20
                },
                onInit: ({ paneID, doc, body, refresh }) => {
                    Zotero.debug("EasyTrans: Section onInit called");
                    // Store refresh function
                    self._refreshPane = refresh;
                    self.registerPaneBody(body);
                },
                onDestroy: ({ paneID, doc, body }) => {
                    Zotero.debug("EasyTrans: Section onDestroy called");
                    self._refreshPane = null;
                    self.unregisterPaneBody(body);
                },
                onItemChange: ({ paneID, doc, body, item, tabType, editable, setEnabled, setSectionSummary }) => {
                    // Always enable for testing
                    setEnabled(true);
                    const currentItemID = item?.id || null;
                    if (self._lastSummaryItemID !== currentItemID) {
                        self._lastSummaryItemID = currentItemID;
                        self._lastTranslationCount = 0;
                    }
                    const count = self._lastTranslationCount || 0;
                    const summary = count > 0 ? `· ${count}` : "";
                    setSectionSummary(summary);
                    return true;
                },
                // onRender MUST be synchronous
                onRender: ({ doc, body, item }) => {
                    Zotero.debug("EasyTrans: Section onRender called");

                    // Clear existing content
                    while (body.firstChild) {
                        body.removeChild(body.firstChild);
                    }

                    try {
                        self.ensureStyles(doc);
                        if (typeof TranslationPane?.render !== "function") {
                            throw new Error("TranslationPane not loaded");
                        }
                        TranslationPane.render(body, item);
                        self.registerPaneBody(body);
                        ensureSectionLabel(body);
                    } catch (e) {
                        Zotero.logError(e);
                        const fallback = doc.createElement("div");
                        fallback.textContent = "EasyTrans UI failed to load: " + e.message;
                        fallback.style.cssText = "padding: 8px; color: #c62828; font-size: 12px;";
                        body.appendChild(fallback);
                    }

                    Zotero.debug("EasyTrans: Section rendered");
                },
                // Async render to update model status
                onAsyncRender: async ({ doc, body, item }) => {
                    Zotero.debug("EasyTrans: Section onAsyncRender called");

                    try {
                        await self.initializeComponents();
                        await self.refreshDownloadState();
                        await TranslationPane.asyncRender(body, item);
                        self.updateDownloadUI();
                        ensureSectionLabel(body);
                    } catch (e) {
                        Zotero.debug("EasyTrans: Async render failed - " + e.message);
                    }
                }
            });

            Zotero.debug("EasyTrans: Section registered with paneID=" + paneID);

        } catch (e) {
            Zotero.debug("EasyTrans: Failed to register section - " + e.message);
            Zotero.logError(e);
        }

        Zotero.debug("EasyTrans: UI registration complete");
    }
};
