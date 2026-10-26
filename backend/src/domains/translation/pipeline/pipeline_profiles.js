const crypto = require("crypto");

const ENGINE_KEYS = Object.freeze([
  "detect", "fontDetect", "segment", "bubbleSegment", "ocr", "translate", "clean", "render",
]);
const TRANSLATION_MODES = Object.freeze([
  "quick", "reference_style", "local_style", "learning_style",
]);

function profileError(message, code = "pipeline_profile_invalid") {
  return Object.assign(new Error(message), { code, statusCode: 400 });
}

function selectProfileId(pipeline, translationMode, requestedProfileId) {
  if (requestedProfileId) return { id: requestedProfileId, source: "request" };
  const mapped = translationMode ? pipeline?.modeProfiles?.[translationMode] : null;
  if (mapped) return { id: mapped, source: "translation_mode" };
  if (pipeline?.defaultProfile) return { id: pipeline.defaultProfile, source: "default" };
  throw profileError("No pipeline profile is configured.");
}

function normalizedEngines(engines) {
  return Object.fromEntries(ENGINE_KEYS
    .filter((key) => typeof engines?.[key] === "string" && engines[key].trim())
    .map((key) => [key, engines[key].trim()]));
}

function profileFingerprint(id, engines) {
  const ordered = Object.fromEntries(ENGINE_KEYS.filter((key) => engines[key]).map((key) => [key, engines[key]]));
  return crypto.createHash("sha256").update(JSON.stringify({ id, engines: ordered })).digest("hex");
}

function resolvePipelineProfile(pipeline, options = {}) {
  const selected = selectProfileId(pipeline, options.translationMode, options.requestedProfileId);
  const profile = pipeline?.profiles?.[selected.id];
  if (!profile) throw profileError(`Pipeline profile is unavailable: ${selected.id}.`, "pipeline_profile_unavailable");
  const engines = normalizedEngines(profile.engines);
  return {
    id: selected.id,
    source: selected.source,
    engines,
    fingerprint: profileFingerprint(selected.id, engines),
  };
}

module.exports = {
  ENGINE_KEYS,
  TRANSLATION_MODES,
  profileFingerprint,
  resolvePipelineProfile,
};
