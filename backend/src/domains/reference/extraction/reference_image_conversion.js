const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { paths } = require("../../../config");
const { ensureDir, loadReferenceManifest, referenceSetPaths } = require("../sets/reference_sets");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
const KOHARU_SUPPORTED_FORMATS = new Set(["jpeg", "png", "webp"]);

function detectImageFormatFromBuffer(buffer) {
  if (!buffer || buffer.length < 12) return "unknown";
  if (isJpegBuffer(buffer)) return "jpeg";
  if (isPngBuffer(buffer)) return "png";
  if (isWebpBuffer(buffer)) return "webp";
  return detectIsobmffFormat(buffer);
}

function isJpegBuffer(buffer) {
  return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isPngBuffer(buffer) {
  return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}

function isWebpBuffer(buffer) {
  return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
}

function detectIsobmffFormat(buffer) {
  if (buffer.toString("ascii", 4, 8) !== "ftyp") return "unknown";
  const brand = buffer.toString("ascii", 8, 12);
  if (/avif|avis/i.test(brand)) return "avif";
  return `isobmff:${brand}`;
}

function detectImageFormat(filePath) {
  const bytes = fs.readFileSync(filePath);
  return detectImageFormatFromBuffer(bytes);
}

function isKoharuSupportedFormat(format) {
  return KOHARU_SUPPORTED_FORMATS.has(String(format || "").toLowerCase());
}

function listReferenceSourceImages(referenceSetId) {
  const { imagesDir } = referenceSetPaths(referenceSetId);
  if (!fs.existsSync(imagesDir)) {
    throw new Error(`Reference image directory not found: ${imagesDir}`);
  }

  return fs
    .readdirSync(imagesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(imagesDir, name));
}

function createConvertedReferenceSetId(referenceSetId) {
  return `${referenceSetId}_converted`;
}

function buildConvertedManifest(sourceManifest, outputReferenceSetId, format) {
  const manifest = {
    ...sourceManifest,
    id: outputReferenceSetId,
    label: `${sourceManifest.label}_converted_${format}`,
    imageDir: `domains/reference/images/${outputReferenceSetId}`,
    extractedDir: `domains/reference/extraction/${outputReferenceSetId}`,
    notes: `${sourceManifest.notes || ""} Converted to ${format.toUpperCase()} from ${sourceManifest.id}.`.trim(),
    enabled: true,
  };

  if (typeof sourceManifest.comparisonDir === "string" && sourceManifest.comparisonDir.length > 0) {
    manifest.comparisonDir = `domains/reference/comparisons/${outputReferenceSetId}`;
  }

  return manifest;
}

function convertImageWithFfmpeg(inputPath, outputPath, format, ffmpegPath = "ffmpeg") {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath];

  if (format === "jpg" || format === "jpeg") {
    args.push("-q:v", "2");
  }

  args.push(outputPath);
  execFileSync(ffmpegPath, args, { stdio: "pipe" });
}

function pickSupportedOutputExtension(inputPath, preferredFormat = "jpg") {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return "jpg";
  }
  if (ext === ".png") {
    return "png";
  }
  if (ext === ".webp") {
    return "webp";
  }
  return preferredFormat === "png" ? "png" : "jpg";
}

function ensureUploadCacheDir(subdir = "koharu-upload-preflight") {
  const cacheRoot = path.dirname(paths.database);
  const dirPath = path.join(cacheRoot, subdir);
  ensureDir(dirPath);
  return dirPath;
}

function preflightImagesForKoharuUpload(imagePaths, { ffmpegPath = "ffmpeg", preferredFormat = "jpg" } = {}) {
  const uploadPaths = [];
  const converted = [];
  let tempDir = null;

  for (const inputPath of imagePaths) {
    const actualFormat = detectImageFormat(inputPath);
    if (isKoharuSupportedFormat(actualFormat)) {
      uploadPaths.push(inputPath);
      continue;
    }
    tempDir = ensureTempDir(tempDir);
    const convertedEntry = convertUnsupportedPreflightImage(inputPath, tempDir, preferredFormat, ffmpegPath);
    uploadPaths.push(convertedEntry.outputPath);
    converted.push(convertedEntry);
  }

  return { uploadPaths, converted, tempDir };
}

function ensureTempDir(tempDir) {
  if (tempDir) return tempDir;
  return fs.mkdtempSync(path.join(ensureUploadCacheDir(), `${Date.now()}-`));
}

function convertUnsupportedPreflightImage(inputPath, tempDir, preferredFormat, ffmpegPath) {
  const outputExt = pickSupportedOutputExtension(inputPath, preferredFormat);
  const outputPath = path.join(tempDir, `${path.parse(inputPath).name}.${outputExt}`);
  const actualFormat = detectImageFormat(inputPath);
  convertImageWithFfmpeg(inputPath, outputPath, outputExt, ffmpegPath);
  return {
    inputPath,
    outputPath,
    actualFormat,
    convertedFormat: outputExt === "jpg" ? "jpeg" : outputExt,
  };
}

function convertReferenceSet({
  referenceSetId,
  outputReferenceSetId = createConvertedReferenceSetId(referenceSetId),
  format = "png",
  ffmpegPath = "ffmpeg",
  overwrite = false,
}) {
  const normalizedFormat = validateConversionFormat(format);
  const sourceManifest = loadReferenceManifest(referenceSetId);
  const sourceImages = listReferenceSourceImages(referenceSetId);
  if (sourceImages.length === 0) {
    throw new Error(`No images found for reference set ${referenceSetId}`);
  }
  const outputPaths = resolveConversionOutputPaths(outputReferenceSetId);
  ensureConversionOutputAvailable(outputPaths, overwrite);
  ensureDir(outputPaths.outputImagesDir);
  const conversions = convertReferenceImages(sourceImages, outputPaths.outputImagesDir, normalizedFormat, ffmpegPath);
  const manifest = buildConvertedManifest(
    sourceManifest,
    outputReferenceSetId,
    normalizedFormat === "jpeg" ? "jpg" : normalizedFormat,
  );
  fs.writeFileSync(outputPaths.outputManifestPath, JSON.stringify(manifest, null, 2));
  return buildConversionResult(referenceSetId, outputReferenceSetId, normalizedFormat, conversions, outputPaths);
}

function validateConversionFormat(format) {
  const normalizedFormat = String(format).toLowerCase();
  if (!["png", "jpg", "jpeg"].includes(normalizedFormat)) {
    throw new Error(`Unsupported output format: ${format}`);
  }
  return normalizedFormat;
}

function resolveConversionOutputPaths(outputReferenceSetId) {
  return {
    outputImagesDir: path.join(paths.referenceImages, outputReferenceSetId),
    outputManifestPath: path.join(paths.referenceManifests, `${outputReferenceSetId}.json`),
  };
}

function ensureConversionOutputAvailable(outputPaths, overwrite) {
  if (!overwrite && (fs.existsSync(outputPaths.outputImagesDir) || fs.existsSync(outputPaths.outputManifestPath))) {
    throw new Error(`Output reference set ${outputPaths.outputImagesDir} already exists. Use overwrite to replace it.`);
  }
}

function convertReferenceImages(sourceImages, outputImagesDir, normalizedFormat, ffmpegPath) {
  const conversions = [];
  for (const inputPath of sourceImages) {
    const outputName = `${path.parse(inputPath).name}.${normalizedFormat === "jpeg" ? "jpg" : normalizedFormat}`;
    const outputPath = path.join(outputImagesDir, outputName);
    const actualFormat = detectImageFormat(inputPath);
    convertImageWithFfmpeg(inputPath, outputPath, normalizedFormat, ffmpegPath);
    conversions.push({ inputPath, outputPath, actualFormat });
  }
  return conversions;
}

function buildConversionResult(referenceSetId, outputReferenceSetId, normalizedFormat, conversions, outputPaths) {
  return {
    sourceReferenceSetId: referenceSetId,
    outputReferenceSetId,
    format: normalizedFormat === "jpeg" ? "jpg" : normalizedFormat,
    imageCount: conversions.length,
    outputImagesDir: outputPaths.outputImagesDir,
    outputManifestPath: outputPaths.outputManifestPath,
    conversions,
  };
}

module.exports = {
  buildConvertedManifest,
  convertImageWithFfmpeg,
  convertReferenceSet,
  createConvertedReferenceSetId,
  detectImageFormat,
  detectImageFormatFromBuffer,
  ensureUploadCacheDir,
  isKoharuSupportedFormat,
  listReferenceSourceImages,
  preflightImagesForKoharuUpload,
};
