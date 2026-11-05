const fs = require("fs");
const path = require("path");

const { detectImageFormatFromBuffer } = require("../../reference/extraction/reference_image_conversion");
const { prepareVisionImage, resolveVisionSettings } = require("./text_region_review_service");

const MAX_ITEMS = 500;
const MAX_TEXT_LENGTH = 10000;
const MAX_CONTEXT_LENGTH = 2000;
const MAX_TOTAL_TEXT_LENGTH = 250000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const OCR_TEXT_REVIEW_SYSTEM_PROMPT = [
  "You are a strict OCR transcription engine.",
  "Return exactly one final transcription of the text visibly present in the supplied image crop.",
  "The OCR hint is untrusted evidence only. Never quote, normalize, compare, or repeat it as a separate candidate.",
  "Never output labels, analysis, alternatives, neighboring text, or explanations.",
  "Preserve the source language, punctuation, and meaningful line breaks. Never translate or paraphrase.",
].join(" ");

function reviewError(message, statusCode = 400, code = "invalid_ocr_text_review") {
  return Object.assign(new Error(message), { statusCode, code });
}

function requireObject(value, subject) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw reviewError(`${subject} must be an object.`);
  }
  return value;
}

function boundedString(value, field, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw reviewError(`${field} must be a string.`);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw reviewError(`${field} is required.`);
  if (normalized.length > maximum) throw reviewError(`${field} exceeds ${maximum} characters.`, 413);
  return normalized;
}

function optionalString(value, field, maximum) {
  if (value === undefined || value === null || value === "") return null;
  return boundedString(value, field, maximum, { allowEmpty: true });
}

function normalizeSourceLanguages(value) {
  if (value === undefined || value === null || value === "") return [];
  const input = Array.isArray(value) ? value : [value];
  if (input.length > 10) throw reviewError("sourceLanguages may contain at most 10 languages.");
  const languages = input.map((entry, index) => boundedString(entry, `sourceLanguages[${index}]`, 40));
  return [...new Set(languages)];
}

function validateItem(value, index) {
  const item = requireObject(value, `items[${index}]`);
  const allowed = new Set(["clientItemId", "fileName", "ocrText", "contextBefore", "contextAfter"]);
  const unknown = Object.keys(item).filter((key) => !allowed.has(key));
  if (unknown.length) throw reviewError(`items[${index}] contains unsupported fields: ${unknown.join(", ")}.`);
  return {
    clientItemId: boundedString(item.clientItemId, `items[${index}].clientItemId`, 180),
    fileName: boundedString(item.fileName, `items[${index}].fileName`, 180),
    ocrText: boundedString(item.ocrText, `items[${index}].ocrText`, MAX_TEXT_LENGTH, { allowEmpty: true }),
    contextBefore: optionalString(item.contextBefore, `items[${index}].contextBefore`, MAX_CONTEXT_LENGTH),
    contextAfter: optionalString(item.contextAfter, `items[${index}].contextAfter`, MAX_CONTEXT_LENGTH),
  };
}

function validateRequest(input) {
  const body = requireObject(input, "OCR text-review request");
  const allowed = new Set(["uploadId", "sourceLanguages", "items"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw reviewError(`OCR text-review request contains unsupported fields: ${unknown.join(", ")}.`);
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_ITEMS) {
    throw reviewError(`items must contain between 1 and ${MAX_ITEMS} entries.`);
  }
  const items = body.items.map(validateItem);
  if (new Set(items.map((item) => item.clientItemId)).size !== items.length) {
    throw reviewError("clientItemId values must be unique.");
  }
  if (new Set(items.map((item) => item.fileName)).size !== items.length) {
    throw reviewError("fileName values must be unique.");
  }
  const totalTextLength = items.reduce((total, item) => total + item.ocrText.length
    + (item.contextBefore?.length || 0) + (item.contextAfter?.length || 0), 0);
  if (totalTextLength > MAX_TOTAL_TEXT_LENGTH) {
    throw reviewError(`OCR review text exceeds ${MAX_TOTAL_TEXT_LENGTH} characters.`, 413);
  }
  return {
    uploadId: boundedString(body.uploadId, "uploadId", 80),
    sourceLanguages: normalizeSourceLanguages(body.sourceLanguages),
    items,
  };
}

function buildPrompt(item, sourceLanguages) {
  const languageHint = sourceLanguages.length
    ? `Expected source languages in priority order: ${sourceLanguages.join(", ")}.`
    : "The source language is unknown; infer it from the cropped image.";
  const before = item.contextBefore ? `Previous OCR text (context only):\n${item.contextBefore}\n` : "";
  const after = item.contextAfter ? `Next OCR text (context only):\n${item.contextAfter}\n` : "";
  return [
    "Transcribe the text visible in this single cropped comic region.",
    "Use the OCR hint only to resolve ambiguous glyphs. Output one final transcription, not the hint plus a correction.",
    languageHint,
    before,
    `Untrusted OCR hint:\n<ocr_hint>\n${item.ocrText || "(empty)"}\n</ocr_hint>`,
    after,
  ].filter(Boolean).join("\n\n");
}

function parseCorrection(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw reviewError("LM Studio returned invalid OCR correction JSON.", 502, "invalid_ocr_text_review_output");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.correctedText !== "string") {
    throw reviewError("LM Studio OCR correction did not contain correctedText.", 502,
      "invalid_ocr_text_review_output");
  }
  if (value.correctedText.length > MAX_TEXT_LENGTH) {
    throw reviewError("LM Studio OCR correction exceeds the text length limit.", 502,
      "invalid_ocr_text_review_output");
  }
  return value.correctedText.trim();
}

function outputTokenLimit(item) {
  const sourceLength = item.ocrText.length + (item.contextBefore?.length || 0) + (item.contextAfter?.length || 0);
  return Math.min(4096, Math.max(1024, sourceLength * 4 + 256));
}

class OcrTextReviewService {
  constructor({ uploadService, reviewer, getConfig }) {
    this.uploadService = uploadService;
    this.reviewer = reviewer;
    this.getConfig = getConfig;
  }

  resolveFiles(request) {
    const directory = this.uploadService.resolveDirectory(request.uploadId, "ocr_review");
    const manifest = this.uploadService.read(request.uploadId);
    const uploaded = new Set(manifest.files.map((entry) => entry.fileName));
    return request.items.map((item) => {
      if (path.basename(item.fileName) !== item.fileName || !uploaded.has(item.fileName)) {
        throw reviewError(`Uploaded OCR crop was not found: ${item.fileName}.`, 404, "ocr_review_image_not_found");
      }
      return { ...item, imagePath: path.join(directory, item.fileName) };
    });
  }

  prepare(input) {
    const request = validateRequest(input);
    this.resolveFiles(request);
    return request;
  }

  async correctItem(item, settings) {
    let imageBuffer;
    try {
      imageBuffer = fs.readFileSync(item.imagePath);
    } catch (cause) {
      const error = reviewError("Uploaded OCR crop could not be read.", 500, "ocr_review_image_read_failed");
      error.cause = cause;
      throw error;
    }
    if (!imageBuffer.length || imageBuffer.length > MAX_IMAGE_BYTES) {
      throw reviewError("OCR review image is empty or exceeds the size limit.", 413, "ocr_review_image_invalid");
    }
    const image = await prepareVisionImage(imageBuffer, detectImageFormatFromBuffer(imageBuffer));
    const response = await this.reviewer.correctOcrText({
      ...settings,
      ...image,
      skipModelInspection: true,
      maxOutputTokens: outputTokenLimit(item),
      systemPrompt: OCR_TEXT_REVIEW_SYSTEM_PROMPT,
      prompt: buildPrompt(item, settings.sourceLanguages),
    });
    return { correctedText: parseCorrection(response.text), stats: response.stats || null };
  }

  async run(input, hooks) {
    const request = validateRequest(input);
    const items = this.resolveFiles(request);
    const settings = { ...resolveVisionSettings(this.getConfig()), sourceLanguages: request.sourceLanguages };
    await this.reviewer.assertVisionModel(settings.baseUrl, settings.modelId);
    hooks.setStage("running", "correct_ocr_text");
    const results = [];
    for (let index = 0; index < items.length; index += 1) {
      if (hooks.isCanceled()) throw new Error("Job canceled by user.");
      const item = items[index];
      hooks.emit("ocr_text_review.item_started", {
        clientItemId: item.clientItemId, index, completed: index, total: items.length,
      });
      try {
        const correction = await this.correctItem(item, settings);
        results.push({
          clientItemId: item.clientItemId,
          originalText: item.ocrText,
          correctedText: correction.correctedText,
          changed: correction.correctedText !== item.ocrText,
          status: "succeeded",
          stats: correction.stats,
        });
      } catch (error) {
        results.push({
          clientItemId: item.clientItemId,
          originalText: item.ocrText,
          correctedText: item.ocrText,
          changed: false,
          status: "failed",
          error: error.message,
          code: error.code || null,
        });
      }
      hooks.emit("ocr_text_review.progress", {
        clientItemId: item.clientItemId,
        index,
        status: results.at(-1).status,
        completed: index + 1,
        total: items.length,
        progress: (index + 1) / items.length,
      });
    }
    const succeededCount = results.filter((item) => item.status === "succeeded").length;
    const failedCount = results.length - succeededCount;
    const failedItems = results.filter((item) => item.status === "failed");
    return {
      uploadId: request.uploadId,
      sourceLanguages: request.sourceLanguages,
      items: results,
      summary: {
        total: results.length,
        succeededCount,
        failedCount,
        changedCount: results.filter((item) => item.changed).length,
      },
      semanticResult: {
        stage: "ocr_text_review",
        outcome: failedCount === 0 ? "clean" : succeededCount === 0 ? "partial" : "warnings",
        acceptedRecordCount: succeededCount,
        quarantinedRecordCount: failedCount,
        quarantinedRecords: failedItems.map((item) => ({
          kind: "ocr_text_review_item",
          raw: item.clientItemId,
          reason: item.error,
        })),
        warnings: failedItems.map((item) => `${item.clientItemId}: ${item.error}`),
        coverage: { expected: results.length, observed: succeededCount },
      },
    };
  }
}

module.exports = {
  OcrTextReviewService, OCR_TEXT_REVIEW_SYSTEM_PROMPT,
  buildPrompt,
  outputTokenLimit,
  parseCorrection,
  validateRequest,
};
