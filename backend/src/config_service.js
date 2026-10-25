const fs = require("fs");
const path = require("path");
const { DEFAULT_CONFIG, PROJECT_CONFIG_PATH, deepMerge } = require("./config");

const ENGINE_KEYS = new Set([
  "detect",
  "fontDetect",
  "segment",
  "bubbleSegment",
  "ocr",
  "translate",
  "clean",
  "render",
]);
const TIMEOUT_KEYS = new Set([
  "startTimeoutMs",
  "readyPollIntervalMs",
  "readyTimeoutMs",
  "messageTimeoutMs",
  "modelSilenceTimeoutMs",
]);
const EDITABLE_KEYS = {
  api: new Set(["baseUrl"]),
  translation: new Set(["defaultTarget", "machineTranslation"]),
  workflow: new Set(["qualityCheck"]),
  agent: new Set(["baseUrl", "apiKey", "model", "agentName", ...TIMEOUT_KEYS]),
  engines: ENGINE_KEYS,
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

function validateQualityCheck(value) {
  if (!isPlainObject(value) || Object.keys(value).some((item) => item !== "enabled")) {
    throw invalid("workflow.qualityCheck only accepts enabled.");
  }
  if (typeof value.enabled !== "boolean") throw invalid("workflow.qualityCheck.enabled must be a boolean.");
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
  if (section === "translation" && key === "machineTranslation") return validateMachineTranslation(value);
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
    return this.persist(deepMerge(this.readProjectConfig(), patch));
  }

  reset() {
    const current = this.readProjectConfig();
    for (const [section, keys] of Object.entries(EDITABLE_KEYS)) {
      if (!current[section] || typeof current[section] !== "object") continue;
      if (section === "engines") {
        delete current.engines;
        continue;
      }
      for (const key of keys) delete current[section][key];
      if (Object.keys(current[section]).length === 0) delete current[section];
    }
    return this.persist(current);
  }
}

module.exports = { ConfigService, ENGINE_KEYS, validateConfigPatch };
