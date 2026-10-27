const crypto = require("crypto");
const path = require("path");

const { readJson, writeJsonAtomic } = require("../../../infrastructure/filesystem/json_file");
const { collectSceneTextRegionPages } = require("../../../integrations/koharu/scene/scene_text_regions");

function digest(prefix, value) {
  const hash = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
  return `${prefix}_${hash}`;
}

function snapshotError(message, code) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

function orderedSourceImages(sourceImages) {
  return [...(sourceImages || [])].sort((left, right) => left.orderIndex - right.orderIndex);
}

function regionSnapshotPathForJob(store, job) {
  if (job.result?.regionSnapshotPath) return job.result.regionSnapshotPath;
  const artifacts = store.getArtifacts(job.id).filter((entry) => entry.kind === "text_region_snapshot");
  return artifacts.at(-1)?.path || null;
}

function assertPageMapping(scenePages, sourceImages) {
  if (scenePages.length === sourceImages.length) return;
  throw snapshotError(
    `Koharu scene page count ${scenePages.length} does not match source image count ${sourceImages.length}.`,
    "text_region_page_mapping_mismatch",
  );
}

function sourceUploadName(sourceImage) {
  if (sourceImage.orderedName) return sourceImage.orderedName;
  return sourceImage.orderedPath ? path.basename(sourceImage.orderedPath) : null;
}

function pairScenePagesWithSources(scenePages, sourceImages) {
  assertPageMapping(scenePages, sourceImages);
  const uploadNames = sourceImages.map(sourceUploadName);
  if (uploadNames.some((name) => !name)) {
    return sourceImages.map((sourceImage, index) => ({ sourceImage, page: scenePages[index] }));
  }
  const pagesByName = new Map(scenePages.map((page) => [page.pageName, page]));
  if (pagesByName.size !== scenePages.length || uploadNames.some((name) => !pagesByName.has(name))) {
    throw snapshotError("Koharu scene page names do not match the uploaded source images.",
      "text_region_page_mapping_mismatch");
  }
  return sourceImages.map((sourceImage, index) => ({
    sourceImage, page: pagesByName.get(uploadNames[index]),
  }));
}

function snapshotRegion(jobId, page, region) {
  return {
    id: digest("text_region", [jobId, page.internalPageId, region.internalNodeId]),
    internalNodeId: region.internalNodeId,
    readingOrder: region.readingOrder,
    geometry: region.geometry,
    sourceText: region.sourceText,
    translatedText: region.translatedText,
    ocrConfidence: region.ocrConfidence,
    sourceDirection: region.sourceDirection,
  };
}

function coordinateSpace(page) {
  return {
    kind: "source_image_pixels",
    origin: "top_left",
    width: page.width,
    height: page.height,
    rotationUnit: "degrees_clockwise",
  };
}

function snapshotPage(jobId, page, sourceImage) {
  const regions = page.regions.map((region) => snapshotRegion(jobId, page, region));
  const identity = { jobId, sourceImageId: sourceImage.id, pageName: page.pageName, regions };
  return {
    sourceImageId: sourceImage.id,
    sourceOrderIndex: sourceImage.orderIndex,
    sourceFileName: sourceImage.fileName,
    internalPageId: page.internalPageId,
    pageName: page.pageName,
    regionSetRevisionId: digest("region_set", identity),
    coordinateSpace: coordinateSpace(page),
    regions,
  };
}

function buildRegionSnapshot(input) {
  const scenePages = collectSceneTextRegionPages(input.scene);
  const sourceImages = orderedSourceImages(input.sourceImages);
  const pairs = pairScenePagesWithSources(scenePages, sourceImages);
  const pages = pairs.map(({ page, sourceImage }) => snapshotPage(input.jobId, page, sourceImage));
  const snapshot = {
    schemaVersion: 1,
    jobId: input.jobId,
    rootJobId: input.rootJobId,
    sourcePreflightId: input.sourcePreflightId,
    createdAt: new Date().toISOString(),
    pages,
  };
  return { ...snapshot, fingerprint: digest("region_snapshot", snapshot) };
}

class RegionSnapshotRepository {
  persist(filePath, input) {
    const snapshot = buildRegionSnapshot(input);
    writeJsonAtomic(filePath, snapshot);
    return snapshot;
  }

  load(filePath) {
    return readJson(filePath);
  }

  loadForJob(store, job) {
    const filePath = regionSnapshotPathForJob(store, job);
    return filePath ? this.load(filePath) : null;
  }
}

module.exports = {
  RegionSnapshotRepository,
  buildRegionSnapshot,
  regionSnapshotPathForJob,
};
