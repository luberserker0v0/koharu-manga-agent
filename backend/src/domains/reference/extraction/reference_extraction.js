const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config } = require("../../../config");
const { ensureDir, loadReferenceManifest, normalizeSceneTexts, referenceSetPaths } = require("../sets/reference_sets");
const { initializeExtractionReview } = require("../review/reference_extraction_review");
const projectOrchestrator = require("../../../integrations/koharu/pipeline/project_orchestrator");
const { resolvePipelineProfile } = require("../../translation/pipeline/pipeline_profiles");

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
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.]/g, "")
    .slice(0, 14);
  return `reference_${referenceSetId}_${timestamp}`;
}

function buildReferenceExtractionSteps(engines) {
  const steps = [engines.detect, engines.fontDetect, engines.segment, engines.bubbleSegment, engines.ocr].filter(
    Boolean,
  );

  if (!steps.includes(engines.detect) || !steps.includes(engines.ocr)) {
    throw new Error("Reference extraction requires detect and ocr engines.");
  }

  return steps;
}

function validateReferenceImages(manifest, images, paths) {
  if (images.length === 0) throw new Error(`No reference images found in ${paths.imagesDir}`);
  if (Number(manifest.pageCount) !== images.length) {
    throw new Error(`Reference manifest pageCount mismatch: expected ${manifest.pageCount}, found ${images.length}`);
  }
}

function finalizeReferenceExtraction({ referenceSetId, createdProject, projectName, scene, normalized, paths }) {
  ensureDir(paths.extractedDir);
  return initializeExtractionReview({
    referenceSetId,
    projectId: createdProject.id,
    projectName,
    scene,
    texts: normalized,
  });
}

function buildReferenceExtractionResult({
  referenceSetId,
  projectName,
  createdProject,
  pipeline,
  upload,
  steps,
  monitorResult,
  review,
}) {
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

async function createExtractionProject(client, referenceSetId, baseUrl) {
  const projectName = createReferenceProjectName(referenceSetId);
  const createdProject = await client.createProject(projectName, baseUrl);
  await client.openProject(createdProject.id, baseUrl);
  return { projectName, createdProject };
}

async function executeExtractionPipeline(pipelineMonitor, images, targetLanguage, baseUrl, isCanceled) {
  const upload = await projectOrchestrator.uploadPages(images, baseUrl);
  const profile = resolvePipelineProfile(config.pipeline);
  const engines = await projectOrchestrator.resolveEngines(baseUrl, profile.engines);
  const steps = buildReferenceExtractionSteps(engines);
  const pipeline = await projectOrchestrator.startPipeline(steps, targetLanguage, baseUrl);
  const monitorResult = await pipelineMonitor.run({ operationId: pipeline.operationId, baseUrl, isCanceled });
  return { upload, steps, pipeline, monitorResult };
}

async function createExtractionReview(client, referenceSetId, project, baseUrl, paths) {
  const scene = await client.getScene(baseUrl);
  const normalized = { referenceSetId, ...normalizeSceneTexts(scene, "other") };
  return finalizeReferenceExtraction({ referenceSetId, ...project, scene, normalized, paths });
}

class ReferenceExtractionModule {
  constructor(client, pipelineMonitor) {
    this.client = client;
    this.pipelineMonitor = pipelineMonitor;
  }

  async run({ referenceSetId, baseUrl, targetLanguage = config.defaults.targetLanguage, isCanceled }) {
    const manifest = loadReferenceManifest(referenceSetId);
    const resolvedBaseUrl = baseUrl || config.api.baseUrl;
    const paths = referenceSetPaths(referenceSetId);
    const images = listReferenceImages(paths.imagesDir);
    validateReferenceImages(manifest, images, paths);
    const project = await createExtractionProject(this.client, referenceSetId, resolvedBaseUrl);
    const execution = await executeExtractionPipeline(
      this.pipelineMonitor, images, targetLanguage, resolvedBaseUrl, isCanceled,
    );
    const review = await createExtractionReview(this.client, referenceSetId, project, resolvedBaseUrl, paths);
    await this.client.closeCurrentProject(resolvedBaseUrl);
    return buildReferenceExtractionResult({ referenceSetId, ...project, ...execution, review });
  }
}

module.exports = {
  ReferenceExtractionModule,
  buildReferenceExtractionSteps,
  createReferenceProjectName,
  listReferenceImages,
};
