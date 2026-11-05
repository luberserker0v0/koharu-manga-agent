const {
  operationError,
  rejectUnknownFields,
  validateOperations,
} = require("./text_region_operation_validation");
const { assertCurrentRegionSets } = require("./text_region_concurrency");

const REQUEST_FIELDS = new Set([
  "pages", "instructions", "translationTarget", "generationOptions", "targetLanguage", "sourceLanguage",
]);
const CORRECTION_BOOTSTRAP_ENGINE_KEYS = Object.freeze([
  "detect", "fontDetect", "segment", "bubbleSegment", "ocr",
]);

function correctionEngineBaselineJob(store, sourceJob) {
  let current = sourceJob;
  const visited = new Set();
  while (current?.payload?.revision?.reason === "text_region_correction") {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    const parentJobId = current.payload.revision.parentJobId || current.parentJobId;
    const parent = parentJobId && store?.getJob?.(parentJobId);
    if (!parent || parent.type !== "translation") break;
    current = parent;
  }
  return current || sourceJob;
}

function correctionBootstrapEngines(store, sourceJob) {
  const engines = correctionEngineBaselineJob(store, sourceJob)?.result?.engines;
  if (!engines || typeof engines !== "object" || Array.isArray(engines)) return null;
  const inherited = Object.fromEntries(CORRECTION_BOOTSTRAP_ENGINE_KEYS
    .filter((key) => typeof engines[key] === "string" && engines[key])
    .map((key) => [key, engines[key]]));
  return Object.keys(inherited).length ? inherited : null;
}

function validatePageToken(input, snapshotPage) {
  if (input.baseRegionSetRevisionId === snapshotPage.regionSetRevisionId) return;
  throw operationError(
    `The text-region snapshot for ${input.sourceImageId} is stale.`, 409, "stale_region_set_revision",
  );
}

function validatePageInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw operationError("Every page correction must be an object.", 400, "invalid_text_region_correction");
  }
  rejectUnknownFields(input,
    new Set(["sourceImageId", "baseRegionSetRevisionId", "regions", "operations"]), "page correction");
  if (typeof input.sourceImageId !== "string" || !input.sourceImageId.trim()) {
    throw operationError("Every corrected page requires sourceImageId.", 400, "invalid_text_region_correction");
  }
}

function preparePages(request, snapshot) {
  if (!Array.isArray(request.pages) || request.pages.length === 0) {
    throw operationError("pages must be a non-empty array.", 400, "invalid_text_region_correction");
  }
  const snapshotPages = new Map(snapshot.pages.map((page) => [page.sourceImageId, page]));
  const seen = new Set();
  return request.pages.map((input) => {
    validatePageInput(input);
    const sourceImageId = input.sourceImageId.trim();
    if (seen.has(sourceImageId)) {
      throw operationError(`Duplicate sourceImageId: ${sourceImageId}.`, 400, "duplicate_source_image_selection");
    }
    seen.add(sourceImageId);
    const page = snapshotPages.get(sourceImageId);
    if (!page) throw operationError(`Unknown source image: ${sourceImageId}.`, 404, "text_region_page_not_found");
    validatePageToken(input, page);
    return { sourceImageId, baseRegionSetRevisionId: input.baseRegionSetRevisionId,
      operations: validateOperations(input, page) };
  });
}

class TextRegionCorrectionService {
  constructor({ store, snapshotRepository }) {
    this.store = store;
    this.snapshotRepository = snapshotRepository;
  }

  prepare(sourceJob, request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw operationError("Correction request must be an object.", 400, "invalid_text_region_correction");
    }
    rejectUnknownFields(request, REQUEST_FIELDS, "correction request");
    const snapshot = this.snapshotRepository.loadForJob(this.store, sourceJob);
    if (!snapshot) {
      throw operationError("This Translation Job does not retain a text-region snapshot.", 409,
        "text_region_snapshot_unavailable");
    }
    const pages = preparePages(request, snapshot);
    const rootJobId = sourceJob.payload?.revision?.rootJobId || sourceJob.id;
    assertCurrentRegionSets({
      store: this.store,
      snapshotRepository: this.snapshotRepository,
      rootJobId,
      pages,
    });
    const bootstrapEngines = correctionBootstrapEngines(this.store, sourceJob);
    return {
      reason: "text_region_correction",
      sourceImageIds: pages.map((page) => page.sourceImageId),
      revision: { baseRegionSetRevisionIds: pages.map((page) => page.baseRegionSetRevisionId) },
      payload: {
        regionCorrections: { sourceJobId: sourceJob.id, pages },
        ...(bootstrapEngines ? { correctionBootstrapEngines: bootstrapEngines } : {}),
      },
    };
  }
}

module.exports = { TextRegionCorrectionService, correctionBootstrapEngines, correctionEngineBaselineJob };
