/* eslint-disable no-undef */
// The archives are the official llama.cpp b8252 Windows CUDA 13.1 releases.
var CudaRuntime = {
    archives: [
        {
            name: "llama-b8252-bin-win-cuda-13.1-x64.zip",
            sha256: "5bfd7390362b5b66c7e21b41f24d4df69a97133e2c8c455e5ee41388fb24242e",
            size: 152793595,
            files: { "ggml-cuda.dll": 128248320 }
        },
        {
            name: "cudart-llama-bin-win-cuda-13.1-x64.zip",
            sha256: "f96935e7e385e3b2d0189239077c10fe8fd7e95690fea4afec455b1b6c7e3f18",
            size: 402582216,
            files: { "cublas64_13.dll": 51569776, "cublasLt64_13.dll": 480693360, "cudart64_13.dll": 540784 }
        }
    ],
    get directory() {
        return PathUtils.join(Zotero.Profile.dir, "easytrans", "runtimes", "llama-b8252-cuda-13.1");
    },
    async isReady() {
        try {
            if (!await IOUtils.exists(PathUtils.join(this.directory, "verified.json"))) return false;
            for (const archive of this.archives) {
                for (const [name, size] of Object.entries(archive.files)) {
                    if ((await IOUtils.stat(PathUtils.join(this.directory, name))).size !== size) return false;
                }
            }
            return true;
        } catch { return false; }
    },
    async prepare(nativeDir) {
        if (!await this.isReady()) throw new Error("CUDA components are not installed. Open Zotero Settings > EasyTrans.");
        for (const archive of this.archives) {
            for (const [name, size] of Object.entries(archive.files)) {
                const target = PathUtils.join(nativeDir, name);
                let valid = false;
                try { valid = (await IOUtils.stat(target)).size === size; } catch {}
                if (!valid) await IOUtils.copy(PathUtils.join(this.directory, name), target);
            }
        }
    },
    async remove() {
        const nativeRoot = PathUtils.join(Zotero.Profile.dir, "easytrans", "native");
        const versions = await IOUtils.exists(nativeRoot) ? await IOUtils.getChildren(nativeRoot) : [];
        for (const archive of this.archives) {
            for (const name of Object.keys(archive.files)) {
                for (const version of versions) {
                    await IOUtils.remove(PathUtils.join(version, "win32", name), { ignoreAbsent: true });
                }
                await IOUtils.remove(PathUtils.join(this.directory, name), { ignoreAbsent: true });
            }
        }
        await IOUtils.remove(PathUtils.join(this.directory, "verified.json"), { ignoreAbsent: true });
        await IOUtils.remove(this.directory, { ignoreAbsent: true });
    },
    hashFile(path) {
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(path);
        const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
        stream.init(file, 0x01, 0, 0);
        try {
            const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
            hash.init(hash.SHA256);
            hash.updateFromStream(stream, 0xffffffff);
            return Array.from(hash.finish(false), c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
        } finally { stream.close(); }
    },
    async download(onProgress, setCancel) {
        const parent = PathUtils.parent(this.directory);
        await IOUtils.makeDirectory(parent, { createAncestors: true, ignoreExisting: true });
        if (await this.isReady()) return;
        // Never overwrite a previous installation; an incomplete directory needs manual attention.
        if (await IOUtils.exists(this.directory)) throw new Error("Incomplete CUDA installation exists; remove it before retrying: " + this.directory);
        const staging = PathUtils.join(parent, "cuda-download-" + Date.now() + "-" + Math.random().toString(36).slice(2));
        await IOUtils.makeDirectory(staging, { createAncestors: true });
        const total = this.archives.reduce((sum, archive) => sum + archive.size, 0);
        let done = 0;
        try {
            for (const archive of this.archives) {
                const archivePath = PathUtils.join(staging, archive.name);
                await Zotero.HTTP.download(`https://github.com/ggml-org/llama.cpp/releases/download/b8252/${archive.name}`, archivePath, {
                    timeout: 0,
                    onProgress: (bytes) => onProgress?.(done + bytes, total),
                    cancellerReceiver: cancel => setCancel?.(cancel)
                });
                setCancel?.(null);
                if ((await IOUtils.stat(archivePath)).size !== archive.size || this.hashFile(archivePath) !== archive.sha256) {
                    throw new Error("CUDA archive checksum mismatch: " + archive.name);
                }
                const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
                file.initWithPath(archivePath);
                const zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
                zip.open(file);
                try {
                    for (const [name, size] of Object.entries(archive.files)) {
                        if (!zip.hasEntry(name) || zip.getEntry(name).realSize !== size) throw new Error("Invalid CUDA archive entry: " + name);
                        const dest = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
                        dest.initWithPath(PathUtils.join(staging, name));
                        zip.extract(name, dest);
                    }
                } finally { zip.close(); }
                await IOUtils.remove(archivePath);
                done += archive.size;
                onProgress?.(done, total);
            }
            await IOUtils.writeUTF8(PathUtils.join(staging, "verified.json"), JSON.stringify({ version: "b8252", cuda: "13.1" }));
            await IOUtils.move(staging, this.directory, { noOverwrite: true });
        } finally {
            setCancel?.(null);
            if (await IOUtils.exists(staging)) await IOUtils.remove(staging, { recursive: true });
        }
    }
};
