const MAX_REGIONS = 1000;
const MAX_TEXT_CHARS = 10000;

function reviewError(message, statusCode = 422, code = "invalid_text_region_review") {
  return Object.assign(new Error(message), { statusCode, code });
}

function rejectUnknownFields(value, allowed, subject) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw reviewError(`${subject} contains unsupported fields: ${unknown.join(", ")}.`);
}

function parseJsonObject(text) {
  if (typeof text !== "string") throw reviewError("Vision model output must be text.");
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw reviewError("Vision model output does not contain a JSON object.");
  return JSON.parse(unfenced.slice(start, end + 1));
}

function validateBox(box, coordinateSpace) {
  if (!Array.isArray(box) || box.length !== 4 || box.some((value) => !Number.isFinite(value))) {
    throw reviewError("Every text-region box must be [x, y, width, height].");
  }
  const [x, y, width, height] = box;
  const bounded = x >= 0 && y >= 0 && width > 0 && height > 0 &&
    x + width <= coordinateSpace.width && y + height <= coordinateSpace.height;
  if (!bounded) throw reviewError("Every text-region box must remain inside the source image.");
  return [x, y, width, height];
}

function validateRegion(region, coordinateSpace) {
  if (!region || typeof region !== "object" || Array.isArray(region)) {
    throw reviewError("Every reviewed text region must be an object.");
  }
  rejectUnknownFields(region, new Set(["box", "text"]), "Reviewed text region");
  if (typeof region.text !== "string" || !region.text.trim() || region.text.length > MAX_TEXT_CHARS) {
    throw reviewError(`Every reviewed text must contain 1-${MAX_TEXT_CHARS} characters.`);
  }
  return { box: validateBox(region.box, coordinateSpace), text: region.text };
}

function validateReviewResult(input, coordinateSpace) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw reviewError("Text-region review must be an object.");
  }
  rejectUnknownFields(input, new Set(["count", "regions"]), "Text-region review");
  if (!Number.isInteger(input.count) || input.count < 0 || input.count > MAX_REGIONS) {
    throw reviewError(`count must be an integer between 0 and ${MAX_REGIONS}.`);
  }
  if (!Array.isArray(input.regions) || input.regions.length > MAX_REGIONS) {
    throw reviewError(`regions must contain at most ${MAX_REGIONS} items.`);
  }
  const regions = input.regions.map((region) => validateRegion(region, coordinateSpace));
  return { count: regions.length, regions };
}

function authoritativeRegion(region) {
  const geometry = region.geometry;
  return { box: [geometry.x, geometry.y, geometry.width, geometry.height], text: region.sourceText };
}

function validateModelTextReview(input, page) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw reviewError("Text-region review must be an object.");
  }
  rejectUnknownFields(input, new Set(["count", "texts"]), "Text-region review");
  const expected = page.regions.length;
  if (input.count !== expected || !Array.isArray(input.texts) || input.texts.length !== expected) {
    throw reviewError(`Vision review must return exactly ${expected} OCR text values.`);
  }
  const regions = page.regions.map((region, index) => {
    const text = input.texts[index];
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_CHARS) {
      throw reviewError(`Every reviewed text must contain 1-${MAX_TEXT_CHARS} characters.`);
    }
    return { ...authoritativeRegion(region), text };
  });
  return { count: regions.length, regions };
}

function parseReviewOutput(text, page) {
  try {
    return validateModelTextReview(parseJsonObject(text), page);
  } catch (cause) {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : ".";
    const error = reviewError(`LM Studio returned an invalid text-region review${detail}`, 502,
      "invalid_text_region_review_output");
    error.cause = cause;
    throw error;
  }
}

module.exports = {
  parseJsonObject, parseReviewOutput, reviewError, validateModelTextReview, validateReviewResult,
};
