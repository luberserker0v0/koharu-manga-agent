const MAX_SOURCE_TEXT_CHARS = 10000;
const MAX_CLIENT_OPERATION_ID_CHARS = 128;

function operationError(message, statusCode, code, details = null) {
  return Object.assign(new Error(message), { statusCode, code, ...(details ? { details } : {}) });
}

function rejectUnknownFields(value, allowed, subject) {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (!unknown.length) return;
  throw operationError(`Unsupported ${subject} fields: ${unknown.join(", ")}.`, 400,
    "invalid_text_region_correction");
}

function validateSourceText(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_SOURCE_TEXT_CHARS) {
    throw operationError(`sourceText must contain 1-${MAX_SOURCE_TEXT_CHARS} characters.`, 422,
      "invalid_ocr_text");
  }
  return value;
}

function validateGeometryShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw operationError("geometry must be an object.", 422, "invalid_region_geometry");
  }
  rejectUnknownFields(value, new Set(["x", "y", "width", "height", "rotation"]), "geometry");
  for (const field of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(value[field])) {
      throw operationError(`geometry.${field} must be finite.`, 422, "invalid_region_geometry");
    }
  }
}

function validateGeometryBounds(value, coordinateSpace) {
  validateGeometryShape(value);
  if (!Number.isFinite(coordinateSpace?.width) || coordinateSpace.width <= 0
    || !Number.isFinite(coordinateSpace?.height) || coordinateSpace.height <= 0) {
    throw operationError("The source-image coordinate space is unavailable.", 409,
      "text_region_coordinate_space_unavailable");
  }
  const rotation = value.rotation == null ? 0 : value.rotation;
  const valid = Number.isFinite(rotation) && value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0
    && value.x + value.width <= coordinateSpace.width && value.y + value.height <= coordinateSpace.height;
  if (!valid) {
    throw operationError("geometry must be positive and remain inside the source image.", 422,
      "invalid_region_geometry");
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height, rotation };
}

function requireSnapshotRegion(input, snapshotRegions) {
  const region = snapshotRegions.get(input.regionId);
  if (region) return region;
  throw operationError(`Unknown text region: ${input.regionId}.`, 404, "unknown_text_region");
}

function validateUpdate(input, snapshotRegions, coordinateSpace) {
  rejectUnknownFields(input, new Set(["type", "regionId", "sourceText", "geometry"]), "update operation");
  requireSnapshotRegion(input, snapshotRegions);
  const hasText = Object.prototype.hasOwnProperty.call(input, "sourceText");
  const hasGeometry = Object.prototype.hasOwnProperty.call(input, "geometry");
  if (!hasText && !hasGeometry) {
    throw operationError("An update operation requires sourceText and/or geometry.", 400,
      "invalid_text_region_correction");
  }
  return { type: "update", regionId: input.regionId,
    ...(hasText ? { sourceText: validateSourceText(input.sourceText) } : {}),
    ...(hasGeometry ? { geometry: validateGeometryBounds(input.geometry, coordinateSpace) } : {}) };
}

function validateDelete(input, snapshotRegions) {
  rejectUnknownFields(input, new Set(["type", "regionId"]), "delete operation");
  requireSnapshotRegion(input, snapshotRegions);
  return { type: "delete", regionId: input.regionId };
}

function validateClientOperationId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_CLIENT_OPERATION_ID_CHARS) {
    throw operationError(`clientOperationId must contain 1-${MAX_CLIENT_OPERATION_ID_CHARS} characters.`, 422,
      "invalid_client_operation_id");
  }
  return value.trim();
}

function validateCreate(input, coordinateSpace) {
  rejectUnknownFields(input, new Set(["type", "clientOperationId", "sourceText", "geometry"]),
    "create operation");
  return {
    type: "create",
    clientOperationId: validateClientOperationId(input.clientOperationId),
    sourceText: validateSourceText(input.sourceText),
    geometry: validateGeometryBounds(input.geometry, coordinateSpace),
  };
}

function normalizePageOperations(input) {
  const hasRegions = Object.prototype.hasOwnProperty.call(input, "regions");
  const hasOperations = Object.prototype.hasOwnProperty.call(input, "operations");
  if (hasRegions === hasOperations) {
    throw operationError("Every corrected page requires exactly one of regions or operations.", 400,
      "invalid_text_region_correction");
  }
  const values = hasOperations ? input.operations : input.regions;
  if (!Array.isArray(values) || values.length === 0) {
    throw operationError("Every corrected page requires at least one operation.", 400,
      "invalid_text_region_correction");
  }
  return hasOperations ? values : values.map((region) => ({ ...region, type: "update" }));
}

function validateOperation(input, snapshotRegions, coordinateSpace) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw operationError("Every text-region operation must be an object.", 400,
      "invalid_text_region_correction");
  }
  if (input.type === "update") return validateUpdate(input, snapshotRegions, coordinateSpace);
  if (input.type === "delete") return validateDelete(input, snapshotRegions);
  if (input.type === "create") return validateCreate(input, coordinateSpace);
  throw operationError(`Unsupported text-region operation: ${input.type}.`, 422,
    "unsupported_text_region_operation");
}

function conflictKey(operation) {
  return operation.type === "create" ? `create:${operation.clientOperationId}` : `region:${operation.regionId}`;
}

function validateOperations(input, snapshotPage) {
  const snapshotRegions = new Map(snapshotPage.regions.map((region) => [region.id, region]));
  const operations = normalizePageOperations(input)
    .map((entry) => validateOperation(entry, snapshotRegions, snapshotPage.coordinateSpace));
  const seen = new Set();
  for (const operation of operations) {
    const key = conflictKey(operation);
    if (seen.has(key)) {
      throw operationError(`Duplicate or conflicting text-region operation: ${key}.`, 400,
        "conflicting_text_region_operation");
    }
    seen.add(key);
  }
  return operations;
}

module.exports = {
  operationError,
  rejectUnknownFields,
  validateOperations,
};
