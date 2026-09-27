const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { paths } = require("../../config");

const ALLOWED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".avif", ".bmp", ".gif",
  ".tif", ".tiff", ".heic", ".heif",
]);

function apiError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function assertUploadId(uploadId) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(uploadId || ""))) {
    throw apiError("Invalid uploadId.", 400);
  }
}

function normalizeFileName(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(value || ""));
  } catch {
    throw apiError("Invalid upload filename encoding.", 400);
  }
  const fileName = path.basename(decoded);
  if (!fileName || fileName !== decoded || !/^[^<>:"/\\|?*\x00-\x1f]{1,180}$/.test(fileName)) {
    throw apiError("Invalid upload filename.", 400);
  }
  if (!ALLOWED_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
    throw apiError("Unsupported image extension.", 415);
  }
  return fileName;
}

class UploadService {
  constructor({ root = paths.uploads, maxFileBytes = 52428800, maxFiles = 500 } = {}) {
    this.root = root;
    this.maxFileBytes = Number(maxFileBytes);
    this.maxFiles = Number(maxFiles);
    this.locks = new Map();
    fs.mkdirSync(this.root, { recursive: true });
  }

  sessionRoot(uploadId) {
    assertUploadId(uploadId);
    return path.join(this.root, uploadId);
  }

  manifestPath(uploadId) {
    return path.join(this.sessionRoot(uploadId), "manifest.json");
  }

  create({ kind = "source" } = {}) {
    if (!["source", "reference"].includes(kind)) throw apiError("Upload kind must be source or reference.", 400);
    const uploadId = crypto.randomUUID();
    const root = this.sessionRoot(uploadId);
    fs.mkdirSync(path.join(root, "files"), { recursive: true });
    const manifest = {
      uploadId,
      kind,
      status: "uploading",
      files: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.write(manifest);
    return manifest;
  }

  read(uploadId) {
    const manifestPath = this.manifestPath(uploadId);
    if (!fs.existsSync(manifestPath)) throw apiError("Upload session not found.", 404);
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  }

  write(manifest) {
    const manifestPath = this.manifestPath(manifest.uploadId);
    const temporaryPath = `${manifestPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, manifestPath);
  }

  async withLock(uploadId, task) {
    const previous = this.locks.get(uploadId) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.locks.set(uploadId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(uploadId) === current) this.locks.delete(uploadId);
    }
  }

  async putFile(uploadId, rawFileName, input) {
    const manifest = this.read(uploadId);
    if (manifest.status !== "uploading") throw apiError("Upload session is already complete.", 409);
    const fileName = normalizeFileName(rawFileName);
    const existing = manifest.files.find((entry) => entry.fileName === fileName);
    if (!existing && manifest.files.length >= this.maxFiles) throw apiError("Upload file-count limit exceeded.", 413);

    const targetPath = path.join(this.sessionRoot(uploadId), "files", fileName);
    const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
    let size = 0;
    let rejected = false;
    const output = fs.createWriteStream(temporaryPath, { flags: "wx" });

    try {
      await new Promise((resolve, reject) => {
        input.on("data", (chunk) => {
          if (rejected) return;
          size += chunk.length;
          if (size > this.maxFileBytes) {
            rejected = true;
            output.destroy();
            input.resume();
            reject(apiError(`Upload file exceeds the ${this.maxFileBytes} byte limit.`, 413));
            return;
          }
          if (!output.write(chunk)) input.pause();
        });
        output.on("drain", () => input.resume());
        input.on("end", () => {
          if (!rejected) output.end();
        });
        input.on("error", reject);
        output.on("error", reject);
        output.on("finish", resolve);
      });
      if (size === 0) throw apiError("Upload file is empty.", 400);
      fs.renameSync(temporaryPath, targetPath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }

    const record = { fileName, size, uploadedAt: new Date().toISOString() };
    await this.withLock(uploadId, async () => {
      const latest = this.read(uploadId);
      const latestExisting = latest.files.find((entry) => entry.fileName === fileName);
      if (!latestExisting && latest.files.length >= this.maxFiles) {
        fs.rmSync(targetPath, { force: true });
        throw apiError("Upload file-count limit exceeded.", 413);
      }
      latest.files = latest.files.filter((entry) => entry.fileName !== fileName).concat(record);
      latest.updatedAt = new Date().toISOString();
      this.write(latest);
    });
    return record;
  }

  complete(uploadId) {
    const manifest = this.read(uploadId);
    if (manifest.files.length === 0) throw apiError("Upload session has no files.", 400);
    manifest.status = "ready";
    manifest.updatedAt = new Date().toISOString();
    this.write(manifest);
    return manifest;
  }

  resolveDirectory(uploadId, expectedKind = null) {
    const manifest = this.read(uploadId);
    if (manifest.status !== "ready") throw apiError("Upload session is not ready.", 409);
    if (expectedKind && manifest.kind !== expectedKind) throw apiError(`Upload kind must be ${expectedKind}.`, 409);
    return path.join(this.sessionRoot(uploadId), "files");
  }

  remove(uploadId) {
    const manifest = this.read(uploadId);
    fs.rmSync(this.sessionRoot(uploadId), { recursive: true, force: true });
    return { uploadId: manifest.uploadId, deleted: true };
  }
}

module.exports = { UploadService, normalizeFileName };
