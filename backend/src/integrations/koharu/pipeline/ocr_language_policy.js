const { sourceLanguageContext } = require("../../../domains/manga_processing/source_languages");

const MULTILINGUAL_OCR_ENGINES = Object.freeze([
  "paddle-ocr-vl-1.6",
  "paddle-ocr-vl-1.5",
]);
const JAPANESE_OCR_ENGINES = Object.freeze(["manga-ocr"]);

function ocrPolicyError(message, details) {
  return Object.assign(new Error(message), {
    statusCode: 422,
    code: "unsupported_ocr_language_combination",
    details,
  });
}

function baseLanguage(language) {
  return language.split("-")[0].toLowerCase();
}

function availableOcrIds(catalog) {
  return new Set((Array.isArray(catalog?.ocr) ? catalog.ocr : [])
    .map((engine) => engine?.id).filter(Boolean));
}

function firstAvailable(candidates, available) {
  return candidates.find((engineId) => available.has(engineId)) || null;
}

function requiresMultilingualEngine(languages) {
  return languages.length === 0 || languages.some((language) => baseLanguage(language) !== "ja");
}

function assertConfiguredCompatibility(engineId, context) {
  if (!JAPANESE_OCR_ENGINES.includes(engineId) || context.requested.length === 0) return;
  if (!requiresMultilingualEngine(context.requested)) return;
  throw ocrPolicyError(
    `Configured OCR engine ${engineId} does not support: ${context.requested.join(", ")}.`,
    { engineId, requestedSourceLanguages: context.requested },
  );
}

function selectionWarning(engineId, context) {
  if (context.requested.length === 0) return [];
  const warnings = ["Koharu does not expose OCR language hints; languages were used for engine selection only."];
  const known = [...MULTILINGUAL_OCR_ENGINES, ...JAPANESE_OCR_ENGINES].includes(engineId);
  if (!known) warnings.push(`OCR language compatibility is not declared for ${engineId}.`);
  return warnings;
}

function buildResolution(engineId, source, context) {
  return {
    requestedSourceLanguages: context.requested,
    effectiveSourceLanguages: context.requested,
    primarySourceLanguage: context.primary,
    mode: context.mode,
    engineId,
    selectionSource: source,
    hintsSupported: false,
    hintsApplied: false,
    appliedLanguageHints: [],
    warnings: selectionWarning(engineId, context),
  };
}

function automaticCandidates(context) {
  return requiresMultilingualEngine(context.requested)
    ? MULTILINGUAL_OCR_ENGINES
    : [...JAPANESE_OCR_ENGINES, ...MULTILINGUAL_OCR_ENGINES];
}

function resolveAutomaticOcr(available, context) {
  const engineId = firstAvailable(automaticCandidates(context), available);
  if (engineId) {
    const source = context.mode === "auto" ? "adapter_default" : "language_policy";
    return { engineId, resolution: buildResolution(engineId, source, context) };
  }
  const requested = context.requested.length > 0 ? context.requested.join(", ") : "automatic detection";
  const availableList = [...available];
  throw ocrPolicyError(
    `No compatible OCR engine for ${requested}. Available OCR engines: ${availableList.join(", ") || "none"}.`,
    {
      requestedSourceLanguages: context.requested,
      availableOcrEngines: availableList,
    },
  );
}

function resolveKoharuOcr({ catalog, configuredEngine = null, sourceLanguage = null }) {
  const available = availableOcrIds(catalog);
  const context = sourceLanguageContext(sourceLanguage);
  if (!configuredEngine) return resolveAutomaticOcr(available, context);
  assertConfiguredCompatibility(configuredEngine, context);
  return {
    engineId: configuredEngine,
    resolution: buildResolution(configuredEngine, "pipeline_profile", context),
  };
}

module.exports = {
  MULTILINGUAL_OCR_ENGINES,
  resolveKoharuOcr,
};
