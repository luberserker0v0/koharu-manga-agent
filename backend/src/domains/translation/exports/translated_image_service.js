const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const { DATA_ROOT, paths } = require("../../../config");

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
]);

function apiError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function imageMediaType(fileName) {
  return IMAGE_TYPES.get(path.extname(fileName).toLowerCase()) || null;
}

function assertRegularFileWithinDataRoot(filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw apiError("Translation export file is unavailable.", 409);
  }
  const resolvedRoot = fs.realpathSync(DATA_ROOT);
  const resolvedFile = fs.realpathSync(filePath);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw apiError("Translation export is outside the backend data root.", 409);
  }
  return resolvedFile;
}

function safeArchiveName(rawName) {
  if (!rawName || rawName.includes("\0")) throw apiError("ZIP contains an invalid entry name.", 422);
  const slashName = rawName.replace(/\\/g, "/");
  if (slashName.startsWith("/") || /^[a-zA-Z]:/.test(slashName)) {
    throw apiError("ZIP contains an absolute entry path.", 422);
  }
  const segments = slashName.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw apiError("ZIP contains a path traversal entry.", 422);
  }
  return path.posix.normalize(slashName);
}

function findEocd(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function readZipEntries(zipPath, { maxEntries = 2000 } = {}) {
  const stat = fs.statSync(zipPath);
  const tailSize = Math.min(stat.size, 65557);
  const tail = Buffer.alloc(tailSize);
  const fd = fs.openSync(zipPath, "r");
  try {
    fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);
    const eocdOffset = findEocd(tail);
    if (eocdOffset < 0) throw apiError("Export ZIP is missing its central directory.", 422);
    const diskNumber = tail.readUInt16LE(eocdOffset + 4);
    const centralDisk = tail.readUInt16LE(eocdOffset + 6);
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const centralSize = tail.readUInt32LE(eocdOffset + 12);
    const centralOffset = tail.readUInt32LE(eocdOffset + 16);
    if (diskNumber !== 0 || centralDisk !== 0) throw apiError("Multi-disk ZIP exports are not supported.", 422);
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw apiError("ZIP64 exports are not supported.", 422);
    }
    if (entryCount > maxEntries) throw apiError(`ZIP contains more than ${maxEntries} entries.`, 413);
    if (centralSize > 16 * 1024 * 1024 || centralOffset + centralSize > stat.size) {
      throw apiError("Export ZIP central directory is invalid or too large.", 422);
    }
    const central = Buffer.alloc(centralSize);
    fs.readSync(fd, central, 0, centralSize, centralOffset);
    const entries = [];
    let offset = 0;
    while (offset < central.length && entries.length < entryCount) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) {
        throw apiError("Export ZIP central directory entry is invalid.", 422);
      }
      const flags = central.readUInt16LE(offset + 8);
      const compression = central.readUInt16LE(offset + 10);
      const crc32 = central.readUInt32LE(offset + 16);
      const compressedSize = central.readUInt32LE(offset + 20);
      const uncompressedSize = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const localHeaderOffset = central.readUInt32LE(offset + 42);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > central.length) throw apiError("Export ZIP entry exceeds the central directory.", 422);
      const rawName = central.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      entries.push({
        name: safeArchiveName(rawName),
        isDirectory: rawName.endsWith("/") || rawName.endsWith("\\"),
        flags,
        compression,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      offset = end;
    }
    if (entries.length !== entryCount) throw apiError("Export ZIP entry count is invalid.", 422);
    return { entries, stat };
  } finally {
    fs.closeSync(fd);
  }
}

function readEntryDataRange(zipPath, entry, archiveSize) {
  const header = Buffer.alloc(30);
  const fd = fs.openSync(zipPath, "r");
  try {
    fs.readSync(fd, header, 0, header.length, entry.localHeaderOffset);
  } finally {
    fs.closeSync(fd);
  }
  if (header.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) throw apiError("Export ZIP local entry is invalid.", 422);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize - 1;
  if (start < 0 || end >= archiveSize || end < start - 1) throw apiError("Export ZIP entry data range is invalid.", 422);
  return { start, end };
}

class ByteLimitTransform extends Transform {
  constructor(limit) {
    super();
    this.limit = limit;
    this.total = 0;
  }

  _transform(chunk, encoding, callback) {
    this.total += chunk.length;
    if (this.total > this.limit) {
      callback(apiError(`Extracted image exceeds the ${this.limit} byte limit.`, 413));
      return;
    }
    callback(null, chunk);
  }
}

async function extractEntry(zipPath, entry, targetPath, archiveSize, maxBytes) {
  if ((entry.flags & 0x1) !== 0) throw apiError("Encrypted ZIP entries are not supported.", 422);
  if (![0, 8].includes(entry.compression)) throw apiError(`Unsupported ZIP compression method: ${entry.compression}.`, 422);
  const { start, end } = readEntryDataRange(zipPath, entry, archiveSize);
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const limiter = new ByteLimitTransform(maxBytes);
  try {
    const streams = [fs.createReadStream(zipPath, { start, end })];
    if (entry.compression === 8) streams.push(zlib.createInflateRaw());
    streams.push(limiter, fs.createWriteStream(temporaryPath, { flags: "wx" }));
    await pipeline(...streams);
    if (limiter.total !== entry.uncompressedSize) throw apiError("Extracted image size does not match the ZIP directory.", 422);
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function imageId(index, sourceName) {
  return crypto.createHash("sha256").update(`${index}\0${sourceName}`).digest("hex").slice(0, 16);
}

function naturalCompare(left, right) {
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

class TranslatedImageService {
  constructor({
    root = paths.translatedImages,
    maxFileBytes = 104857600,
    maxFiles = 500,
    maxTotalBytes = 1073741824,
  } = {}) {
    this.root = root;
    this.maxFileBytes = Number(maxFileBytes);
    this.maxFiles = Number(maxFiles);
    this.maxTotalBytes = Number(maxTotalBytes);
    fs.mkdirSync(this.root, { recursive: true });
  }

  selectExportArtifact(artifacts) {
    const artifact = [...(artifacts || [])].reverse().find((entry) => entry.kind === "export");
    if (!artifact) throw apiError("Job does not have a translation export artifact.", 409);
    return { ...artifact, path: assertRegularFileWithinDataRoot(artifact.path) };
  }

  jobCacheRoot(jobId) {
    const key = crypto.createHash("sha256").update(String(jobId)).digest("hex").slice(0, 24);
    return path.join(this.root, key);
  }

  publicImage(jobId, image) {
    const base = `/api/v1/jobs/${encodeURIComponent(jobId)}/translated-images/${encodeURIComponent(image.id)}`;
    return {
      id: image.id,
      index: image.index,
      fileName: image.fileName,
      mediaType: image.mediaType,
      size: image.size,
      encodedUrl: base,
      contentUrl: `${base}/content`,
    };
  }

  async prepare({ jobId, artifacts }) {
    const artifact = this.selectExportArtifact(artifacts);
    const extension = path.extname(artifact.path).toLowerCase();
    const directMediaType = imageMediaType(artifact.path);
    if (directMediaType) {
      const stat = fs.statSync(artifact.path);
      return {
        artifactId: artifact.id,
        sourceFormat: "image",
        images: [{ id: imageId(0, path.basename(artifact.path)), index: 0, fileName: path.basename(artifact.path), mediaType: directMediaType, size: stat.size, path: artifact.path }],
      };
    }
    if (extension !== ".zip") throw apiError("Translation export is not a supported image or ZIP file.", 415);

    const { entries, stat } = readZipEntries(artifact.path, { maxEntries: Math.max(this.maxFiles * 4, 2000) });
    const imageEntries = entries
      .filter((entry) => !entry.isDirectory && imageMediaType(entry.name))
      .sort(naturalCompare);
    if (imageEntries.length === 0) throw apiError("Translation export ZIP contains no supported images.", 422);
    if (imageEntries.length > this.maxFiles) throw apiError(`Translation export exceeds the ${this.maxFiles} image limit.`, 413);
    let totalBytes = 0;
    for (const entry of imageEntries) {
      if (entry.uncompressedSize > this.maxFileBytes) throw apiError(`Translated image exceeds the ${this.maxFileBytes} byte limit.`, 413);
      totalBytes += entry.uncompressedSize;
      if (totalBytes > this.maxTotalBytes) throw apiError(`Translated images exceed the ${this.maxTotalBytes} byte total limit.`, 413);
    }

    const cacheRoot = this.jobCacheRoot(jobId);
    const cacheKey = `${artifact.id}-${stat.size}-${Math.trunc(stat.mtimeMs)}`;
    const manifestPath = path.join(cacheRoot, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.cacheKey === cacheKey && manifest.images.every((image) => fs.existsSync(image.path))) return manifest;
    }
    const resolvedServiceRoot = path.resolve(this.root);
    const resolvedCacheRoot = path.resolve(cacheRoot);
    const relative = path.relative(resolvedServiceRoot, resolvedCacheRoot);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw apiError("Translated-image cache path is invalid.", 500);
    fs.rmSync(resolvedCacheRoot, { recursive: true, force: true });
    fs.mkdirSync(resolvedCacheRoot, { recursive: true });

    const images = [];
    for (let index = 0; index < imageEntries.length; index += 1) {
      const entry = imageEntries[index];
      const id = imageId(index, entry.name);
      const originalName = path.posix.basename(entry.name);
      const targetName = `${String(index + 1).padStart(4, "0")}-${id}${path.extname(originalName).toLowerCase()}`;
      const targetPath = path.join(resolvedCacheRoot, targetName);
      await extractEntry(artifact.path, entry, targetPath, stat.size, this.maxFileBytes);
      images.push({ id, index, fileName: originalName, sourceName: entry.name, mediaType: imageMediaType(originalName), size: entry.uncompressedSize, path: targetPath });
    }
    const manifest = { jobId, artifactId: artifact.id, sourceFormat: "zip", cacheKey, images };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  async list({ jobId, artifacts }) {
    const prepared = await this.prepare({ jobId, artifacts });
    return {
      jobId,
      artifactId: prepared.artifactId,
      sourceFormat: prepared.sourceFormat,
      count: prepared.images.length,
      images: prepared.images.map((image) => this.publicImage(jobId, image)),
    };
  }

  async find({ jobId, artifacts, imageId: requestedId }) {
    const prepared = await this.prepare({ jobId, artifacts });
    const image = prepared.images.find((entry) => entry.id === requestedId);
    if (!image) throw apiError("Translated image not found.", 404);
    return { prepared, image };
  }

  async encoded(options) {
    const { prepared, image } = await this.find(options);
    if (image.size > this.maxFileBytes) throw apiError("Translated image is too large to encode.", 413);
    return {
      jobId: options.jobId,
      artifactId: prepared.artifactId,
      id: image.id,
      index: image.index,
      fileName: image.fileName,
      mediaType: image.mediaType,
      size: image.size,
      encoding: "base64",
      data: fs.readFileSync(image.path).toString("base64"),
    };
  }
}

module.exports = {
  TranslatedImageService,
  imageMediaType,
  readZipEntries,
  safeArchiveName,
};
