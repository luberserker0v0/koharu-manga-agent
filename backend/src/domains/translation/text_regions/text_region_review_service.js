const fs = require("fs");
const sharp = require("sharp");

const { detectImageFormatFromBuffer } = require("../../reference/extraction/reference_image_conversion");
const { assertCurrentRegionSets } = require("./text_region_concurrency");
const { parseReviewOutput, reviewError, validateReviewResult } = require("./text_region_review_contract");
const { buildReviewOperations } = require("./text_region_review_matching");
const { buildTextRegionReviewPrompt } = require("./text_region_review_prompt");

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

async function convertWebpToPng(imageBuffer) {
  try {
    return await sharp(imageBuffer, { failOn: "error", limitInputPixels: 100_000_000 })
      .png()
      .toBuffer();
  } catch (cause) {
    const error = reviewError("The source WebP image could not be prepared for LM Studio vision inference.",
      422, "vision_image_conversion_failed");
    error.cause = cause;
    throw error;
  }
}

async function prepareVisionImage(imageBuffer, format, convertWebp = convertWebpToPng) {
  if (format === "jpeg" || format === "png") {
    return { imageBuffer, mediaType: mediaTypeFor(format) };
  }
  if (format === "webp") {
    const converted = await convertWebp(imageBuffer);
    if (!Buffer.isBuffer(converted) || converted.length === 0 || converted.length > MAX_IMAGE_BYTES) {
      throw reviewError("The converted vision image is empty or exceeds the size limit.", 422,
        "vision_image_conversion_failed");
    }
    return { imageBuffer: converted, mediaType: "image/png" };
  }
  return { imageBuffer, mediaType: mediaTypeFor(format) };
}

function requireObject(value, subject) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw reviewError(`${subject} must be an object.`, 400);
  }
  return value;
}

function validateFields(value, allowed, subject) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw reviewError(`${subject} contains unsupported fields: ${unknown.join(", ")}.`, 400);
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw reviewError(`${field} is required.`, 400);
  return value.trim();
}

function validateReviewRequest(input) {
  requireObject(input, "Text-region review request");
  validateFields(input, new Set(["sourceImageId", "baseRegionSetRevisionId"]), "Text-region review request");
  return {
    sourceImageId: requireString(input.sourceImageId, "sourceImageId"),
    baseRegionSetRevisionId: requireString(input.baseRegionSetRevisionId, "baseRegionSetRevisionId"),
  };
}

function validateApplyRequest(input) {
  requireObject(input, "Text-region review application");
  validateFields(input, new Set(["sourceImageId", "baseRegionSetRevisionId", "count", "regions"]),
    "Text-region review application");
  return {
    sourceImageId: requireString(input.sourceImageId, "sourceImageId"),
    baseRegionSetRevisionId: requireString(input.baseRegionSetRevisionId, "baseRegionSetRevisionId"),
    count: input.count,
    regions: input.regions,
  };
}

function mediaTypeFor(format) {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  throw reviewError(`Unsupported vision image format: ${format}.`, 422, "unsupported_vision_image_format");
}

function resolveVisionSettings(config) {
  const translation = config?.translation || {};
  const modelId = translation.defaultTarget?.modelId;
  const baseUrl = translation.lmStudio?.baseUrl;
  if (!modelId || !baseUrl) throw reviewError("LM Studio vision settings are incomplete.", 503,
    "lmstudio_vision_unavailable");
  return {
    modelId, baseUrl,
    temperature: 0,
    reasoning: translation.generationOptions?.reasoning || "off",
    maxOutputTokens: 8192,
  };
}

function reviewOutputTokenLimit(page) {
  const sourceCharacters = page.regions.reduce((total, region) => total + region.sourceText.length, 0);
  return Math.min(4096, Math.max(512, (sourceCharacters * 2) + (page.regions.length * 32)));
}

class TextRegionReviewService {
  constructor({ store, snapshotRepository, sourcePreflightModule, reviewer, getConfig,
    convertWebp = convertWebpToPng }) {
    this.store = store;
    this.snapshotRepository = snapshotRepository;
    this.sourcePreflightModule = sourcePreflightModule;
    this.reviewer = reviewer;
    this.getConfig = getConfig;
    this.convertWebp = convertWebp;
  }

  resolveContext(jobId, request) {
    const job = this.store.getJob(jobId);
    if (!job || job.type !== "translation") {
      throw reviewError("Translation Job was not found.", 404, "translation_job_not_found");
    }
    const snapshot = this.snapshotRepository.loadForJob(this.store, job);
    if (!snapshot) throw reviewError("This Translation Job does not retain a text-region snapshot.", 409,
      "text_region_snapshot_unavailable");
    const page = snapshot.pages.find((entry) => entry.sourceImageId === request.sourceImageId);
    if (!page) throw reviewError("Source image was not found in this text-region snapshot.", 404,
      "text_region_page_not_found");
    if (page.regionSetRevisionId !== request.baseRegionSetRevisionId) {
      throw reviewError("The text-region snapshot is stale.", 409, "stale_region_set_revision");
    }
    this.assertCurrent(snapshot, request);
    return { job, snapshot, page };
  }

  assertCurrent(snapshot, request) {
    assertCurrentRegionSets({
      store: this.store,
      snapshotRepository: this.snapshotRepository,
      rootJobId: snapshot.rootJobId,
      pages: [request],
    });
  }

  async loadImage(context) {
    const resolved = this.sourcePreflightModule.resolvePreviewImage(
      context.snapshot.sourcePreflightId, context.page.sourceImageId,
    );
    const imageBuffer = fs.readFileSync(resolved.path);
    if (imageBuffer.length > MAX_IMAGE_BYTES) {
      throw reviewError("Source image exceeds the vision inference size limit.", 413, "vision_image_too_large");
    }
    return prepareVisionImage(imageBuffer, detectImageFormatFromBuffer(imageBuffer), this.convertWebp);
  }

  async review(jobId, input) {
    const request = validateReviewRequest(input);
    const context = this.resolveContext(jobId, request);
    if (context.page.regions.length === 0) return { count: 0, regions: [] };
    const image = await this.loadImage(context);
    const response = await this.reviewer.review({
      ...resolveVisionSettings(this.getConfig()), ...image,
      expectedRegionCount: context.page.regions.length,
      maxOutputTokens: reviewOutputTokenLimit(context.page),
      prompt: buildTextRegionReviewPrompt(context.page, context.job.payload?.sourceLanguage),
    });
    return parseReviewOutput(response.text, context.page);
  }

  prepareCorrection(jobId, input) {
    const request = validateApplyRequest(input);
    const context = this.resolveContext(jobId, request);
    const review = validateReviewResult({ count: request.count, regions: request.regions },
      context.page.coordinateSpace);
    const operations = buildReviewOperations(context.page, review);
    if (!operations.length) throw reviewError("The reviewed text regions contain no changes.", 409,
      "text_region_review_no_changes");
    return { pages: [{
      sourceImageId: request.sourceImageId,
      baseRegionSetRevisionId: request.baseRegionSetRevisionId,
      operations,
    }] };
  }
}

module.exports = {
  TextRegionReviewService,
  convertWebpToPng,
  mediaTypeFor,
  prepareVisionImage,
  reviewOutputTokenLimit,
  resolveVisionSettings,
  validateApplyRequest,
  validateReviewRequest,
};
