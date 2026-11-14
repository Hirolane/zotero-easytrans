/* eslint-disable no-undef */
var EasyTransPreferences = {
    cancel: null,
    cancelled: false,
    busy: false,
    ru: false,
    tr(en, ru) { return this.ru ? ru : en; },
    async init() {
        this.ru = Zotero.locale?.startsWith("ru");
        this.device = document.getElementById("easytrans-pref-device");
        this.status = document.getElementById("easytrans-pref-cuda-status");
        this.progress = document.getElementById("easytrans-pref-progress");
        this.downloadButton = document.getElementById("easytrans-pref-download");
        this.cancelButton = document.getElementById("easytrans-pref-cancel");
        this.removeCudaButton = document.getElementById("easytrans-pref-remove-cuda");
        this.removeModelButton = document.getElementById("easytrans-pref-remove-model");
        this.modelDownloadButton = document.getElementById("easytrans-pref-model-download");
        this.modelStatus = document.getElementById("easytrans-pref-model-status");
        this.modelProgress = document.getElementById("easytrans-pref-model-progress");
        this.storageStatus = document.getElementById("easytrans-pref-storage-status");
        document.getElementById("easytrans-pref-device-label").setAttribute("value", this.tr("Compute device", "Устройство перевода"));
        this.downloadButton.textContent = this.tr("Download CUDA components", "Скачать компоненты CUDA");
        this.cancelButton.textContent = this.tr("Cancel", "Отмена");
        this.removeCudaButton.textContent = this.tr("Remove CUDA components", "Удалить компоненты CUDA");
        this.removeModelButton.textContent = this.tr("Remove translation model", "Удалить модель перевода");
        document.getElementById("easytrans-pref-storage-label").textContent = this.tr("Storage", "Хранилище");
        this.device.value = Zotero.Prefs.get("extensions.easytrans.computeDevice") === "gpu" ? "gpu" : "cpu";
        this.deviceObserver = Zotero.Prefs.registerObserver("extensions.easytrans.computeDevice", value => {
            this.device.value = value === "gpu" ? "gpu" : "cpu";
        });
        window.addEventListener("unload", () => Zotero.Prefs.unregisterObserver(this.deviceObserver), { once: true });
        this.device.addEventListener("command", async () => {
            Zotero.Prefs.set("extensions.easytrans.computeDevice", this.device.value);
            if (this.device.value === "gpu" && !await CudaRuntime.isReady()) {
                this.status.textContent = this.tr("GPU selected. Download the CUDA components before translating.", "Выбран GPU. Для перевода скачайте компоненты CUDA.");
            }
        });
        this.downloadButton.addEventListener("click", () => this.download());
        this.cancelButton.addEventListener("click", () => { this.cancelled = true; this.cancel?.(); });
        this.removeCudaButton.addEventListener("click", () => this.removeCuda());
        this.removeModelButton.addEventListener("click", () => this.removeModel());
        this.modelDownloader = Zotero.EasyTransModelDownloader;
        if (this.modelDownloader) {
            this.unsubscribeModel = this.modelDownloader.subscribe(state => this.updateModel(state));
            window.addEventListener("unload", () => this.unsubscribeModel?.(), { once: true });
            this.modelDownloadButton.addEventListener("click", () => this.downloadModel());
            await this.modelDownloader.refreshState();
        } else {
            this.modelDownloadButton.disabled = true;
            this.modelStatus.textContent = this.tr("Model manager unavailable. Restart Zotero.", "Управление моделью недоступно. Перезапустите Zotero.");
        }
        await this.refresh();
    },
    updateModel(state) {
        const downloading = state.buttonMode === "cancel";
        this.modelStatus.textContent = [state.statusText, state.detailText].filter(Boolean).join(" ") || this.tr("Model ready.", "Модель готова.");
        this.modelDownloadButton.textContent = downloading
            ? this.tr("Cancel model download", "Отменить загрузку модели")
            : state.isDownloaded ? this.tr("Model installed", "Модель установлена") : this.tr("Download / resume model", "Скачать / продолжить загрузку модели");
        this.modelDownloadButton.disabled = !downloading && !!state.isDownloaded;
        this.modelProgress.hidden = !downloading;
        this.modelProgress.value = Math.max(0, Math.min(100, state.progressPercent || 0));
        this.removeModelButton.disabled = downloading;
    },
    async downloadModel() {
        if (this.modelDownloader.downloadInProgress) {
            this.modelDownloader.cancelDownload();
            return;
        }
        try { await this.modelDownloader.showDownloadDialog(); }
        catch (e) { this.modelStatus.textContent = e?.message || String(e); }
    },
    async removeCuda() {
        if (this.busy || !Services.prompt.confirm(window, "EasyTrans", this.tr(
            "Remove downloaded CUDA components? GPU translation will be disabled until they are downloaded again.",
            "Удалить скачанные компоненты CUDA? Перевод на GPU будет недоступен до повторной загрузки."
        ))) return;
        this.busy = true;
        this.removeCudaButton.disabled = true;
        this.downloadButton.disabled = true;
        this.device.disabled = true;
        Zotero.Prefs.set("extensions.easytrans.computeDevice", "cpu");
        this.device.value = "cpu";
        try {
            await CudaRuntime.remove();
            await this.refresh();
        } catch (e) {
            this.status.textContent = this.tr("Could not remove CUDA components: ", "Не удалось удалить компоненты CUDA: ") + (e?.message || String(e));
        } finally {
            this.busy = false;
            this.device.disabled = false;
            this.removeCudaButton.disabled = false;
            this.downloadButton.disabled = await CudaRuntime.isReady();
        }
    },
    async removeModel() {
        if (this.busy || !Services.prompt.confirm(window, "EasyTrans", this.tr(
            "Remove the downloaded TranslateGemma model? It must be downloaded again to translate.",
            "Удалить скачанную модель TranslateGemma? Для перевода её потребуется скачать снова."
        ))) return;
        this.busy = true;
        this.removeModelButton.disabled = true;
        this.downloadButton.disabled = true;
        this.removeCudaButton.disabled = true;
        try {
            if (!this.modelDownloader || this.modelDownloader.downloadInProgress) throw new Error(this.tr("Model manager is busy or unavailable.", "Загрузка модели выполняется или недоступна."));
            if (!await this.modelDownloader.deleteModel()) throw new Error(this.tr("Could not remove model files.", "Не удалось удалить файлы модели."));
            this.storageStatus.textContent = this.tr("Model removed. Download it again to translate.", "Модель удалена. Для перевода скачайте её снова.");
        } catch (e) {
            this.storageStatus.textContent = this.tr("Could not remove the model: ", "Не удалось удалить модель: ") + (e?.message || String(e));
        } finally {
            this.busy = false;
            this.removeModelButton.disabled = false;
            this.removeCudaButton.disabled = false;
            this.downloadButton.disabled = await CudaRuntime.isReady();
        }
    },
    async refresh() {
        const ready = await CudaRuntime.isReady();
        this.downloadButton.disabled = ready || this.busy;
        this.status.textContent = ready
            ? this.tr("CUDA components installed (llama.cpp b8252, CUDA 13.1).", "Компоненты CUDA установлены (llama.cpp b8252, CUDA 13.1).")
            : this.tr("CUDA not installed. Download: about 530 MiB; installed: about 630 MiB. NVIDIA driver required.", "CUDA не установлена. Загрузка: около 530 МиБ; на диске: около 630 МиБ. Нужен драйвер NVIDIA.");
    },
    async download() {
        if (this.busy) return;
        this.busy = true;
        this.cancelled = false;
        this.downloadButton.disabled = true;
        this.removeCudaButton.disabled = true;
        this.removeModelButton.disabled = true;
        this.progress.hidden = false;
        this.cancelButton.hidden = false;
        this.device.disabled = true;
        try {
            await CudaRuntime.download((bytes, total) => {
                this.progress.value = Math.min(100, Math.floor(bytes * 100 / total));
                this.status.textContent = this.tr("Downloading CUDA: ", "Загрузка CUDA: ") + this.progress.value + "%";
            }, cancel => {
                this.cancel = cancel;
                if (cancel && this.cancelled) cancel();
            });
            await this.refresh();
        } catch (e) {
            this.status.textContent = this.cancelled
                ? this.tr("Download cancelled. CPU remains available.", "Загрузка отменена. CPU доступен.")
                : this.tr("CUDA installation failed: ", "Не удалось установить CUDA: ") + (e?.message || String(e));
        } finally {
            this.busy = false;
            this.cancel = null;
            this.cancelButton.hidden = true;
            this.progress.hidden = true;
            this.device.disabled = false;
            this.removeCudaButton.disabled = false;
            this.removeModelButton.disabled = false;
            this.downloadButton.disabled = await CudaRuntime.isReady();
        }
    }
};
