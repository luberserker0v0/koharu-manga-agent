const MAX_SOURCE_TEXT_CHARS = 10000;
const REQUEST_FIELDS = new Set([
  "pages", "instructions", "translationTarget", "generationOptions", "targetLanguage", "sourceLanguage",
]);

function correctionError(message, statusCode, code, details = null) {
  return Object.assign(new Error(message), { statusCode, code, ...(details ? { details } : {}) });
}

function rejectUnknownFields(value, allowed, subject) {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (!unknown.length) return;
  throw correctionError(`Unsupported ${subject} fields: ${unknown.join(", ")}.`, 400, "invalid_text_region_correction");
}

function validateSourceText(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_SOURCE_TEXT_CHARS) {
    throw correctionError(
      `sourceText must contain 1-${MAX_SOURCE_TEXT_CHARS} characters.`, 422, "invalid_ocr_text",
    );
  }
  return value;
}

function validateGeometryShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw correctionError("geometry must be an object.", 422, "invalid_region_geometry");
  }
  rejectUnknownFields(value, new Set(["x", "y", "width", "height", "rotation"]), "geometry");
  for (const field of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(value[field])) {
      throw correctionError(`geometry.${field} must be finite.`, 422, "invalid_region_geometry");
    }
  }
}

function validateGeometryBounds(value, coordinateSpace) {
  validateGeometryShape(value);
  if (!Number.isFinite(coordinateSpace?.width) || coordinateSpace.width <= 0
    || !Number.isFinite(coordinateSpace?.height) || coordinateSpace.height <= 0) {
    throw correctionError(
      "The source-image coordinate space is unavailable.", 409, "text_region_coordinate_space_unavailable",
    );
  }
  const rotation = value.rotation == null ? 0 : value.rotation;
  const valid = Number.isFinite(rotation) && value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0
    && value.x + value.width <= coordinateSpace.width && value.y + value.height <= coordinateSpace.height;
  if (!valid) {
    throw correctionError("geometry must be positive and remain inside the source image.", 422, "invalid_region_geometry");
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height, rotation };
}

function validateRegionCorrection(input, snapshotRegion, coordinateSpace) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw correctionError("Every region correction must be an object.", 400, "invalid_text_region_correction");
  }
  rejectUnknownFields(input, new Set(["regionId", "sourceText", "geometry"]), "region correction");
  if (!snapshotRegion || input.regionId !== snapshotRegion.id) {
    throw correctionError(`Unknown text region: ${input.regionId}.`, 404, "unknown_text_region");
  }
  const hasText = Object.prototype.hasOwnProperty.call(input, "sourceText");
  const hasGeometry = Object.prototype.hasOwnProperty.call(input, "geometry");
  if (!hasText && !hasGeometry) {
    throw correctionError("A region correction requires sourceText and/or geometry.", 400, "invalid_text_region_correction");
  }
  return {
    regionId: input.regionId,
    ...(hasText ? { sourceText: validateSourceText(input.sourceText) } : {}),
    ...(hasGeometry ? { geometry: validateGeometryBounds(input.geometry, coordinateSpace) } : {}),
  };
}

function validatePageToken(input, snapshotPage) {
  if (input.baseRegionSetRevisionId === snapshotPage.regionSetRevisionId) return;
  throw correctionError(
    `The text-region snapshot for ${input.sourceImageId} is stale.`, 409, "stale_region_set_revision",
  );
}

function validatePageCorrections(input, snapshotPage) {
  validatePageToken(input, snapshotPage);
  if (!Array.isArray(input.regions) || input.regions.length === 0) {
    throw correctionError("Every corrected page requires at least one region.", 400, "invalid_text_region_correction");
  }
  const snapshotRegions = new Map(snapshotPage.regions.map((region) => [region.id, region]));
  const seen = new Set();
  return input.regions.map((region) => {
    if (seen.has(region?.regionId)) {
      throw correctionError(`Duplicate text region: ${region.regionId}.`, 400, "duplicate_text_region_correction");
    }
    seen.add(region?.regionId);
    return validateRegionCorrection(region, snapshotRegions.get(region?.regionId), snapshotPage.coordinateSpace);
  });
}

function validatePageInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw correctionError("Every page correction must be an object.", 400, "invalid_text_region_correction");
  }
  rejectUnknownFields(input, new Set(["sourceImageId", "baseRegionSetRevisionId", "regions"]), "page correction");
  if (typeof input.sourceImageId !== "string" || !input.sourceImageId.trim()) {
    throw correctionError("Every corrected page requires sourceImageId.", 400, "invalid_text_region_correction");
  }
}

function preparePages(request, snapshot) {
  if (!Array.isArray(request.pages) || request.pages.length === 0) {
    throw correctionError("pages must be a non-empty array.", 400, "invalid_text_region_correction");
  }
  const snapshotPages = new Map(snapshot.pages.map((page) => [page.sourceImageId, page]));
  const seen = new Set();
  return request.pages.map((input) => {
    validatePageInput(input);
    const sourceImageId = input.sourceImageId.trim();
    if (seen.has(sourceImageId)) {
      throw correctionError(`Duplicate sourceImageId: ${sourceImageId}.`, 400, "duplicate_source_image_selection");
    }
    seen.add(sourceImageId);
    const page = snapshotPages.get(sourceImageId);
    if (!page) throw correctionError(`Unknown source image: ${sourceImageId}.`, 404, "text_region_page_not_found");
    return { sourceImageId, baseRegionSetRevisionId: input.baseRegionSetRevisionId,
      regions: validatePageCorrections(input, page) };
  });
}

class TextRegionCorrectionService {
  constructor({ store, snapshotRepository }) {
    this.store = store;
    this.snapshotRepository = snapshotRepository;
  }

  prepare(sourceJob, request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw correctionError("Correction request must be an object.", 400, "invalid_text_region_correction");
    }
    rejectUnknownFields(request, REQUEST_FIELDS, "correction request");
    const snapshot = this.snapshotRepository.loadForJob(this.store, sourceJob);
    if (!snapshot) {
      throw correctionError("This Translation Job does not retain a text-region snapshot.", 409,
        "text_region_snapshot_unavailable");
    }
    const pages = preparePages(request, snapshot);
    return {
      reason: "text_region_correction",
      sourceImageIds: pages.map((page) => page.sourceImageId),
      revision: { baseRegionSetRevisionIds: pages.map((page) => page.baseRegionSetRevisionId) },
      payload: { regionCorrections: { sourceJobId: sourceJob.id, pages } },
    };
  }
}

module.exports = { TextRegionCorrectionService };
