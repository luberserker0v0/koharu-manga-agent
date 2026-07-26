const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { paths } = require("../config");
const {
  ensureDir,
  loadReferenceManifest,
  referenceSetPaths,
} = require("./reference_sets");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
const KOHARU_SUPPORTED_FORMATS = new Set(["jpeg", "png", "webp"]);

function detectImageFormatFromBuffer(buffer) {
  if (!buffer || buffer.length < 12) {
    return "unknown";
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }

  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }

  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12);
    if (/avif|avis/i.test(brand)) {
      return "avif";
    }
    return `isobmff:${brand}`;
  }

  return "unknown";
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
    imageDir: `references/other_images/${outputReferenceSetId}`,
    extractedDir: `references/extracted/${outputReferenceSetId}`,
    notes: `${sourceManifest.notes || ""} Converted to ${format.toUpperCase()} from ${sourceManifest.id}.`.trim(),
    enabled: true,
  };

  if (typeof sourceManifest.comparisonDir === "string" && sourceManifest.comparisonDir.length > 0) {
    manifest.comparisonDir = `references/comparisons/${outputReferenceSetId}`;
  }

  return manifest;
}

function convertImageWithFfmpeg(inputPath, outputPath, format, ffmpegPath = "ffmpeg") {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
  ];

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

function preflightImagesForKoharuUpload(
  imagePaths,
  { ffmpegPath = "ffmpeg", preferredFormat = "jpg" } = {}
) {
  const uploadPaths = [];
  const converted = [];
  let tempDir = null;

  for (const inputPath of imagePaths) {
    const actualFormat = detectImageFormat(inputPath);
    if (isKoharuSupportedFormat(actualFormat)) {
      uploadPaths.push(inputPath);
      continue;
    }

    if (!tempDir) {
      tempDir = fs.mkdtempSync(
        path.join(ensureUploadCacheDir(), `${Date.now()}-`)
      );
    }

    const outputExt = pickSupportedOutputExtension(inputPath, preferredFormat);
    const outputPath = path.join(
      tempDir,
      `${path.parse(inputPath).name}.${outputExt}`
    );
    convertImageWithFfmpeg(inputPath, outputPath, outputExt, ffmpegPath);
    uploadPaths.push(outputPath);
    converted.push({
      inputPath,
      outputPath,
      actualFormat,
      convertedFormat: outputExt === "jpg" ? "jpeg" : outputExt,
    });
  }

  return {
    uploadPaths,
    converted,
    tempDir,
  };
}

function convertReferenceSet({
  referenceSetId,
  outputReferenceSetId = createConvertedReferenceSetId(referenceSetId),
  format = "png",
  ffmpegPath = "ffmpeg",
  overwrite = false,
}) {
  const normalizedFormat = String(format).toLowerCase();
  if (!["png", "jpg", "jpeg"].includes(normalizedFormat)) {
    throw new Error(`Unsupported output format: ${format}`);
  }

  const sourceManifest = loadReferenceManifest(referenceSetId);
  const sourceImages = listReferenceSourceImages(referenceSetId);
  if (sourceImages.length === 0) {
    throw new Error(`No images found for reference set ${referenceSetId}`);
  }

  const outputImagesDir = path.join(paths.referenceImages, outputReferenceSetId);
  const outputManifestPath = path.join(
    paths.referenceManifests,
    `${outputReferenceSetId}.json`
  );

  if (!overwrite && (fs.existsSync(outputImagesDir) || fs.existsSync(outputManifestPath))) {
    throw new Error(
      `Output reference set ${outputReferenceSetId} already exists. Use overwrite to replace it.`
    );
  }

  ensureDir(outputImagesDir);

  const conversions = [];
  for (const inputPath of sourceImages) {
    const outputName = `${path.parse(inputPath).name}.${normalizedFormat === "jpeg" ? "jpg" : normalizedFormat}`;
    const outputPath = path.join(outputImagesDir, outputName);
    const actualFormat = detectImageFormat(inputPath);
    convertImageWithFfmpeg(inputPath, outputPath, normalizedFormat, ffmpegPath);
    conversions.push({
      inputPath,
      outputPath,
      actualFormat,
    });
  }

  const manifest = buildConvertedManifest(
    sourceManifest,
    outputReferenceSetId,
    normalizedFormat === "jpeg" ? "jpg" : normalizedFormat
  );
  fs.writeFileSync(outputManifestPath, JSON.stringify(manifest, null, 2));

  return {
    sourceReferenceSetId: referenceSetId,
    outputReferenceSetId,
    format: normalizedFormat === "jpeg" ? "jpg" : normalizedFormat,
    imageCount: conversions.length,
    outputImagesDir,
    outputManifestPath,
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
