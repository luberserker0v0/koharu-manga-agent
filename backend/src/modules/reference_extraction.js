const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config } = require("../config");
const {
  ensureDir,
  loadReferenceManifest,
  normalizeSceneTexts,
  referenceSetPaths,
} = require("./reference_sets");
const { initializeExtractionReview } = require("./reference_extraction_review");
const legacyOneClick = require("../../../.opencode/skills/manga-translate-zhtw/scripts/one_click_translate.js");

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

function listReferenceImages(imagesDir) {
  if (!fs.existsSync(imagesDir)) {
    throw new Error(`Reference image directory not found: ${imagesDir}`);
  }

  return fs
    .readdirSync(imagesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => IMAGE_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .sort()
    .map((name) => path.join(imagesDir, name));
}

function createReferenceProjectName(referenceSetId) {
  const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  return `reference_${referenceSetId}_${timestamp}`;
}

function buildReferenceExtractionSteps(engines) {
  const steps = [
    engines.detect,
    engines.fontDetect,
    engines.segment,
    engines.bubbleSegment,
    engines.ocr,
  ].filter(Boolean);

  if (!steps.includes(engines.detect) || !steps.includes(engines.ocr)) {
    throw new Error("Reference extraction requires detect and ocr engines.");
  }

  return steps;
}

class ReferenceExtractionModule {
  constructor(client, pipelineMonitor) {
    this.client = client;
    this.pipelineMonitor = pipelineMonitor;
  }

  async run({ referenceSetId, baseUrl, targetLanguage = config.defaults.targetLanguage }) {
    const manifest = loadReferenceManifest(referenceSetId);
    const resolvedBaseUrl = baseUrl || config.api.baseUrl;
    const paths = referenceSetPaths(referenceSetId);
    const images = listReferenceImages(paths.imagesDir);

    if (images.length === 0) {
      throw new Error(`No reference images found in ${paths.imagesDir}`);
    }

    if (Number(manifest.pageCount) !== images.length) {
      throw new Error(
        `Reference manifest pageCount mismatch: expected ${manifest.pageCount}, found ${images.length}`
      );
    }

    const projectName = createReferenceProjectName(referenceSetId);
    const createdProject = await this.client.createProject(projectName, resolvedBaseUrl);
    await this.client.openProject(createdProject.id, resolvedBaseUrl);

    const upload = await legacyOneClick.uploadPages(images, resolvedBaseUrl);
    const steps = buildReferenceExtractionSteps(config.engines || {});
    const pipeline = await legacyOneClick.startPipeline(
      steps,
      targetLanguage,
      resolvedBaseUrl
    );

    const monitorResult = await this.pipelineMonitor.run({
      operationId: pipeline.operationId,
      baseUrl: resolvedBaseUrl,
    });

    const scene = await this.client.getScene(resolvedBaseUrl);
    const normalized = {
      referenceSetId,
      ...normalizeSceneTexts(scene, "other"),
    };

    ensureDir(paths.extractedDir);
    const review = initializeExtractionReview({
      referenceSetId,
      projectId: createdProject.id,
      projectName,
      scene,
      texts: normalized,
    });
    await this.client.closeCurrentProject(resolvedBaseUrl);

    return {
      referenceSetId,
      projectName,
      projectId: createdProject.id,
      operationId: pipeline.operationId,
      uploaded: upload.uploaded,
      skipped: upload.skipped,
      steps,
      pipeline: monitorResult,
      scenePath: review.rawScenePath,
      textsPath: review.rawTextsPath,
      review,
      closed: true,
    };
  }
}

module.exports = {
  ReferenceExtractionModule,
  buildReferenceExtractionSteps,
  createReferenceProjectName,
  listReferenceImages,
};
