const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { paths } = require("../config");
const {
  convertImageWithFfmpeg,
  detectImageFormat,
  isKoharuSupportedFormat,
} = require("./reference_image_conversion");

const KNOWN_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".bmp",
  ".gif",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
]);

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function naturalCompare(left, right) {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function normalizeExtension(format, fallback = ".png") {
  switch (String(format || "").toLowerCase()) {
    case "jpeg":
      return ".jpg";
    case "png":
      return ".png";
    case "webp":
      return ".webp";
    default:
      return fallback;
  }
}

function zeroPad(index, total) {
  const width = Math.max(3, String(total).length);
  return String(index).padStart(width, "0");
}

function buildOrderFingerprint(imageIds) {
  return imageIds.join("|");
}

function isRecognizedImageCandidate(filePath, detectedFormat) {
  const extension = path.extname(filePath).toLowerCase();
  return KNOWN_IMAGE_EXTENSIONS.has(extension) || detectedFormat !== "unknown";
}

function listSourceFiles(sourceFolder) {
  return fs
    .readdirSync(sourceFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort(naturalCompare)
    .map((name) => path.join(sourceFolder, name));
}

function copyOrConvertFile({ sourcePath, destinationDir, imageId, ffmpegPath = "ffmpeg" }) {
  const actualFormat = detectImageFormat(sourcePath);
  if (isKoharuSupportedFormat(actualFormat)) {
    const outputPath = path.join(destinationDir, `${imageId}${normalizeExtension(actualFormat)}`);
    fs.copyFileSync(sourcePath, outputPath);
    return {
      accepted: true,
      normalizedPath: outputPath,
      actualFormat,
      converted: false,
      convertedFrom: null,
    };
  }

  if (!isRecognizedImageCandidate(sourcePath, actualFormat)) {
    return {
      accepted: false,
      reason: "File is not a recognized image.",
    };
  }

  try {
    const outputPath = path.join(destinationDir, `${imageId}.png`);
    convertImageWithFfmpeg(sourcePath, outputPath, "png", ffmpegPath);
    return {
      accepted: true,
      normalizedPath: outputPath,
      actualFormat,
      converted: true,
      convertedFrom: actualFormat,
    };
  } catch (error) {
    return {
      accepted: false,
      reason: `Image conversion failed: ${error.message}`,
    };
  }
}

function validateFolderReadable(sourceFolder) {
  if (!sourceFolder || !sourceFolder.trim()) {
    throw new Error("sourceFolder is required.");
  }
  if (!fs.existsSync(sourceFolder)) {
    throw new Error(`Source folder not found: ${sourceFolder}`);
  }
  const stat = fs.statSync(sourceFolder);
  if (!stat.isDirectory()) {
    throw new Error(`Source folder is not a directory: ${sourceFolder}`);
  }
  fs.accessSync(sourceFolder, fs.constants.R_OK);
}

function writeOrderedImages({ orderedDir, images, orderedImageIds }) {
  fs.rmSync(orderedDir, { recursive: true, force: true });
  ensureDir(orderedDir);

  const imageById = new Map(images.map((image) => [image.id, image]));
  const total = orderedImageIds.length;

  return orderedImageIds.map((imageId, index) => {
    const image = imageById.get(imageId);
    if (!image) {
      throw new Error(`Unknown image id in ordering: ${imageId}`);
    }

    const orderedName = `${zeroPad(index + 1, total)}${path.extname(image.normalizedPath)}`;
    const orderedPath = path.join(orderedDir, orderedName);
    fs.copyFileSync(image.normalizedPath, orderedPath);

    return {
      ...image,
      orderedName,
      orderedPath,
      orderIndex: index,
      previewPath: orderedPath,
    };
  });
}

function persistManifest(manifestPath, payload) {
  ensureDir(path.dirname(manifestPath));
  fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2), "utf-8");
}

class SourcePreflightModule {
  constructor({ root = paths.sourcePreflight, ffmpegPath = "ffmpeg" } = {}) {
    this.root = root;
    this.ffmpegPath = ffmpegPath;
    ensureDir(this.root);
  }

  preflight({ sourceFolder }) {
    validateFolderReadable(sourceFolder);

    const preflightId = crypto.randomUUID();
    const preflightRoot = path.join(this.root, preflightId);
    const normalizedDir = path.join(preflightRoot, "normalized");
    const orderedDir = path.join(preflightRoot, "ordered");
    const manifestPath = path.join(preflightRoot, "manifest.json");

    ensureDir(normalizedDir);
    ensureDir(orderedDir);

    const discoveredFiles = [];
    const rejectedFiles = [];
    const acceptedImages = [];

    for (const filePath of listSourceFiles(sourceFolder)) {
      const fileName = path.basename(filePath);
      const imageId = crypto.randomUUID();
      const copyResult = copyOrConvertFile({
        sourcePath: filePath,
        destinationDir: normalizedDir,
        imageId,
        ffmpegPath: this.ffmpegPath,
      });

      if (!copyResult.accepted) {
        rejectedFiles.push({
          fileName,
          path: filePath,
          reason: copyResult.reason,
        });
        discoveredFiles.push({
          fileName,
          path: filePath,
          accepted: false,
          converted: false,
          reason: copyResult.reason,
        });
        continue;
      }

      const acceptedImage = {
        id: imageId,
        fileName,
        sourcePath: filePath,
        normalizedPath: copyResult.normalizedPath,
        actualFormat: copyResult.actualFormat,
        converted: copyResult.converted,
        convertedFrom: copyResult.convertedFrom,
      };

      acceptedImages.push(acceptedImage);
      discoveredFiles.push({
        fileName,
        path: filePath,
        accepted: true,
        converted: copyResult.converted,
        reason: "",
      });
    }

    const orderedImageIds = acceptedImages.map((image) => image.id);
    const orderedImages = writeOrderedImages({
      orderedDir,
      images: acceptedImages,
      orderedImageIds,
    });

    const manifest = {
      preflightId,
      sourceFolder,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      preflightRoot,
      normalizedDir,
      orderedDir,
      manifestPath,
      ready: orderedImages.length > 0,
      orderChanged: false,
      originalFingerprint: buildOrderFingerprint(orderedImageIds),
      currentFingerprint: buildOrderFingerprint(orderedImageIds),
      summary: {
        discoveredCount: discoveredFiles.length,
        acceptedCount: orderedImages.length,
        convertedCount: orderedImages.filter((image) => image.converted).length,
        rejectedCount: rejectedFiles.length,
      },
      discoveredFiles,
      rejectedFiles,
      images: orderedImages,
    };

    persistManifest(manifestPath, manifest);
    return manifest;
  }

  get(preflightId) {
    const manifestPath = path.join(this.root, preflightId, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Source preflight not found: ${preflightId}`);
    }
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  }

  reorder({ preflightId, orderedImageIds }) {
    const current = this.get(preflightId);
    const currentIds = current.images.map((image) => image.id);
    if (!Array.isArray(orderedImageIds) || orderedImageIds.length !== currentIds.length) {
      throw new Error("orderedImageIds must include every image exactly once.");
    }

    const expected = [...currentIds].sort();
    const actual = [...orderedImageIds].sort();
    if (expected.join("|") !== actual.join("|")) {
      throw new Error("orderedImageIds does not match the current source-image set.");
    }

    const reorderedImages = writeOrderedImages({
      orderedDir: current.orderedDir,
      images: current.images,
      orderedImageIds,
    });

    const nextFingerprint = buildOrderFingerprint(orderedImageIds);
    const nextManifest = {
      ...current,
      updatedAt: new Date().toISOString(),
      orderChanged: nextFingerprint !== current.originalFingerprint,
      currentFingerprint: nextFingerprint,
      images: reorderedImages,
    };

    persistManifest(current.manifestPath, nextManifest);
    return nextManifest;
  }

  resolveSourceImages(preflightId) {
    const manifest = this.get(preflightId);
    if (!manifest.ready) {
      throw new Error(`Source preflight is not ready: ${preflightId}`);
    }
    return manifest.images
      .slice()
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((image) => image.orderedPath);
  }
}

module.exports = {
  SourcePreflightModule,
  buildOrderFingerprint,
  copyOrConvertFile,
  listSourceFiles,
  normalizeExtension,
  validateFolderReadable,
  writeOrderedImages,
};
