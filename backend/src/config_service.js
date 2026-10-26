const fs = require("fs");
const path = require("path");
const { DEFAULT_CONFIG, PROJECT_CONFIG_PATH, deepMerge } = require("./config");
const {
  ENGINE_KEYS: PIPELINE_ENGINE_KEYS,
  TRANSLATION_MODES,
} = require("./domains/translation/pipeline/pipeline_profiles");

const ENGINE_KEYS = new Set(PIPELINE_ENGINE_KEYS);
const MODE_KEYS = new Set(TRANSLATION_MODES);
const TIMEOUT_KEYS = new Set([
  "startTimeoutMs",
  "readyPollIntervalMs",
  "readyTimeoutMs",
  "messageTimeoutMs",
  "modelSilenceTimeoutMs",
]);
const EDITABLE_KEYS = {
  api: new Set(["baseUrl"]),
  translation: new Set(["defaultTarget", "generationOptions", "lmStudio", "machineTranslation"]),
  workflow: new Set(["qualityCheck"]),
  agent: new Set(["baseUrl", "apiKey", "model", "agentName", ...TIMEOUT_KEYS]),
  pipeline: new Set(["defaultProfile", "modeProfiles", "profiles"]),
  defaults: new Set([
    "trashRetentionDays",
    "logRetentionDays",
    "logMaxFiles",
    "translatedRetentionDays",
    "workspaceRetentionDays",
    "postEditRetentionDays",
  ]),
  cleanup: new Set(["enabled", "intervalMs"]),
};

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function assertHttpUrl(value, field) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid(`${field} must be a valid HTTP URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw invalid(`${field} must be a valid HTTP URL.`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateTranslationTarget(value) {
  const allowed = ["providerId", "modelId"];
  if (!isPlainObject(value) || Object.keys(value).some((item) => !allowed.includes(item))) {
    throw invalid("translation.defaultTarget only accepts providerId and modelId.");
  }
  if (![value.providerId, value.modelId].every((item) => typeof item === "string" && item.trim())) {
    throw invalid("translation.defaultTarget requires providerId and modelId.");
  }
}

function validateMachineTranslation(value) {
  const allowed = ["referencePostEdit", "learningPostEdit"];
  const invalidField = isPlainObject(value) && Object.keys(value).some((item) => !allowed.includes(item));
  const invalidValue = isPlainObject(value) && Object.values(value).some((item) => typeof item !== "boolean");
  if (!isPlainObject(value) || invalidField || invalidValue) {
    throw invalid("translation.machineTranslation only accepts boolean referencePostEdit and learningPostEdit fields.");
  }
}

function validateGenerationOptions(value) {
  const allowed = ["temperature", "reasoning"];
  if (!isPlainObject(value) || Object.keys(value).some((item) => !allowed.includes(item))) {
    throw invalid("translation.generationOptions only accepts temperature and reasoning.");
  }
  if (typeof value.temperature !== "number" || !Number.isFinite(value.temperature) ||
      value.temperature < 0 || value.temperature > 1) {
    throw invalid("translation.generationOptions.temperature must be a number between 0 and 1.");
  }
  const reasoning = ["off", "on", "low", "medium", "high"];
  if (!reasoning.includes(value.reasoning)) throw invalid("translation.generationOptions.reasoning is invalid.");
}

function validateLmStudio(value) {
  const allowed = ["baseUrl", "koharuProxyBaseUrl"];
  if (!isPlainObject(value) || Object.keys(value).some((item) => !allowed.includes(item))) {
    throw invalid("translation.lmStudio only accepts baseUrl and koharuProxyBaseUrl.");
  }
  assertHttpUrl(value.baseUrl, "translation.lmStudio.baseUrl");
  assertHttpUrl(value.koharuProxyBaseUrl, "translation.lmStudio.koharuProxyBaseUrl");
}

function validateQualityCheck(value) {
  if (!isPlainObject(value) || Object.keys(value).some((item) => item !== "enabled")) {
    throw invalid("workflow.qualityCheck only accepts enabled.");
  }
  if (typeof value.enabled !== "boolean") throw invalid("workflow.qualityCheck.enabled must be a boolean.");
}

function validProfileId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

function validateProfileEngines(value, profileId) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !ENGINE_KEYS.has(key))) {
    throw invalid(`pipeline.profiles.${profileId}.engines contains an unsupported engine key.`);
  }
  const invalidValue = Object.values(value)
    .some((engineId) => engineId !== null && (typeof engineId !== "string" || !engineId.trim()));
  if (invalidValue) {
    throw invalid(`pipeline.profiles.${profileId}.engines values must be non-empty strings or null.`);
  }
}

function validatePipelineProfiles(value) {
  if (!isPlainObject(value) || Object.keys(value).some((id) => !validProfileId(id))) {
    throw invalid("pipeline.profiles must use lowercase profile IDs.");
  }
  for (const [id, profile] of Object.entries(value)) {
    if (!isPlainObject(profile) || Object.keys(profile).some((key) => key !== "engines")) {
      throw invalid(`pipeline.profiles.${id} only accepts engines.`);
    }
    validateProfileEngines(profile.engines, id);
  }
}

function validateModeProfiles(value) {
  if (!isPlainObject(value) || Object.keys(value).some((mode) => !MODE_KEYS.has(mode))) {
    throw invalid("pipeline.modeProfiles contains an unsupported translation mode.");
  }
  if (Object.values(value).some((profileId) => !validProfileId(profileId))) {
    throw invalid("pipeline.modeProfiles values must be valid profile IDs.");
  }
}

function validatePipelineEntry(key, value) {
  if (key === "profiles") return validatePipelineProfiles(value);
  if (key === "modeProfiles") return validateModeProfiles(value);
  if (!validProfileId(value)) throw invalid("pipeline.defaultProfile must be a valid profile ID.");
}

function validatePipelineReferences(pipeline) {
  const profiles = pipeline?.profiles || {};
  const references = [pipeline?.defaultProfile, ...Object.values(pipeline?.modeProfiles || {})];
  const missing = references.find((profileId) => profileId && !profiles[profileId]);
  if (missing) throw invalid(`Pipeline profile is unavailable: ${missing}.`);
}

function validateDefaults(key, value) {
  if (key === "logMaxFiles") {
    if (!Number.isInteger(value) || value < 0) throw invalid("defaults.logMaxFiles must be an integer >= 0.");
    return;
  }
  const retentionKeys = [
    "trashRetentionDays",
    "logRetentionDays",
    "translatedRetentionDays",
    "workspaceRetentionDays",
    "postEditRetentionDays",
  ];
  if (!retentionKeys.includes(key)) throw invalid(`Unsupported config field: defaults.${key}.`);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalid(`defaults.${key} must be a number >= 0 (0 disables).`);
  }
}

function validateCleanup(key, value) {
  if (key === "enabled" && typeof value !== "boolean") throw invalid("cleanup.enabled must be a boolean.");
  if (key === "intervalMs" && (!Number.isInteger(value) || value < 60000)) {
    throw invalid("cleanup.intervalMs must be an integer >= 60000.");
  }
  if (!["enabled", "intervalMs"].includes(key)) throw invalid(`Unsupported config field: cleanup.${key}.`);
}

function validateAgentEntry(key, value) {
  if (key === "baseUrl") return assertHttpUrl(value, "agent.baseUrl");
  if (TIMEOUT_KEYS.has(key)) {
    if (!Number.isInteger(value) || value <= 0) throw invalid(`agent.${key} must be a positive integer.`);
    return;
  }
  if (["apiKey", "agentName"].includes(key)) {
    if (value !== null && typeof value !== "string") throw invalid(`agent.${key} must be a string or null.`);
    return;
  }
  if (typeof value !== "string" || !value.trim()) throw invalid(`agent.${key} must be a non-empty string.`);
  const parts = String(value).trim().split("/");
  if (key === "model" && (parts.length !== 2 || parts.some((part) => !part.trim() || part.includes(" ")))) {
    throw invalid("agent.model must use the provider_id/model_id format.");
  }
}

function validateConfigEntry(section, key, value) {
  if (section === "translation" && key === "defaultTarget") return validateTranslationTarget(value);
  if (section === "translation" && key === "generationOptions") return validateGenerationOptions(value);
  if (section === "translation" && key === "lmStudio") return validateLmStudio(value);
  if (section === "translation" && key === "machineTranslation") return validateMachineTranslation(value);
  if (section === "pipeline") return validatePipelineEntry(key, value);
  if (section === "workflow") return validateQualityCheck(value);
  if (section === "defaults") return validateDefaults(key, value);
  if (section === "cleanup") return validateCleanup(key, value);
  if (section === "api" && key === "baseUrl") return assertHttpUrl(value, "api.baseUrl");
  if (section === "agent") return validateAgentEntry(key, value);
  if (typeof value !== "string" || !value.trim()) throw invalid(`${section}.${key} must be a non-empty string.`);
}

function validateConfigPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw invalid("Config patch must be an object.");
  for (const [section, values] of Object.entries(patch)) {
    if (!EDITABLE_KEYS[section]) throw invalid(`Unsupported config section: ${section}.`);
    if (!values || typeof values !== "object" || Array.isArray(values)) throw invalid(`${section} must be an object.`);
    for (const [key, value] of Object.entries(values)) {
      if (!EDITABLE_KEYS[section].has(key)) throw invalid(`Unsupported config field: ${section}.${key}.`);
      validateConfigEntry(section, key, value);
    }
  }
  return patch;
}

function replaceMutableConfig(target, next) {
  for (const key of Object.keys(target)) {
    if (!(key in next)) delete target[key];
  }
  for (const [key, value] of Object.entries(next)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      replaceMutableConfig(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

class ConfigService {
  constructor({ configPath = PROJECT_CONFIG_PATH, defaults = DEFAULT_CONFIG, effectiveConfig, onApply = null } = {}) {
    this.configPath = configPath;
    this.defaults = defaults;
    this.effectiveConfig = effectiveConfig;
    this.onApply = onApply;
  }

  readProjectConfig() {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  persist(projectConfig) {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    const tempPath = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(projectConfig, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, this.configPath);
    const next = deepMerge(this.defaults, projectConfig);
    replaceMutableConfig(this.effectiveConfig, next);
    this.onApply?.(this.effectiveConfig);
    return this.effectiveConfig;
  }

  update(patch) {
    validateConfigPatch(patch);
    const current = this.readProjectConfig();
    delete current.engines;
    const next = deepMerge(current, patch);
    validatePipelineReferences(deepMerge(this.defaults, next).pipeline);
    return this.persist(next);
  }

  reset() {
    const current = this.readProjectConfig();
    delete current.engines;
    for (const [section, keys] of Object.entries(EDITABLE_KEYS)) {
      if (!current[section] || typeof current[section] !== "object") continue;
      for (const key of keys) delete current[section][key];
      if (Object.keys(current[section]).length === 0) delete current[section];
    }
    return this.persist(current);
  }
}

module.exports = { ConfigService, ENGINE_KEYS, validateConfigPatch };
