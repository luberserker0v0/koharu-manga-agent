const fs = require("fs");
const path = require("path");
const { DEFAULT_CONFIG, PROJECT_CONFIG_PATH, deepMerge } = require("./config");

const ENGINE_KEYS = new Set(["detect", "fontDetect", "segment", "bubbleSegment", "ocr", "translate", "clean", "render"]);
const TIMEOUT_KEYS = new Set([
  "startTimeoutMs", "readyPollIntervalMs", "readyTimeoutMs", "messageTimeoutMs", "modelSilenceTimeoutMs",
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
  try { parsed = new URL(value); } catch { throw invalid(`${field} must be a valid HTTP URL.`); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw invalid(`${field} must be a valid HTTP URL.`);
}

function validateConfigPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw invalid("Config patch must be an object.");
  for (const [section, values] of Object.entries(patch)) {
    if (!EDITABLE_KEYS[section]) throw invalid(`Unsupported config section: ${section}.`);
    if (!values || typeof values !== "object" || Array.isArray(values)) throw invalid(`${section} must be an object.`);
    for (const [key, value] of Object.entries(values)) {
      if (!EDITABLE_KEYS[section].has(key)) throw invalid(`Unsupported config field: ${section}.${key}.`);
      if (section === "translation" && key === "defaultTarget") {
        if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).some((item) => !["providerId", "modelId"].includes(item))) {
          throw invalid("translation.defaultTarget only accepts providerId and modelId.");
        }
        if (![value.providerId, value.modelId].every((item) => typeof item === "string" && item.trim())) {
          throw invalid("translation.defaultTarget requires providerId and modelId.");
        }
      } else if (section === "translation" && key === "machineTranslation") {
        if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).some((item) => !["referencePostEdit", "learningPostEdit"].includes(item)) ||
          Object.values(value).some((item) => typeof item !== "boolean")) {
          throw invalid("translation.machineTranslation only accepts boolean referencePostEdit and learningPostEdit fields.");
        }
      } else if (section === "workflow") {
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((item) => item !== "enabled")) {
          throw invalid("workflow.qualityCheck only accepts enabled.");
        }
        if (typeof value.enabled !== "boolean") throw invalid("workflow.qualityCheck.enabled must be a boolean.");
      } else if (section === "defaults") {
        if (key === "logMaxFiles") {
          if (!Number.isInteger(value) || value < 0) throw invalid("defaults.logMaxFiles must be an integer >= 0.");
        } else if (["trashRetentionDays", "logRetentionDays", "translatedRetentionDays", "workspaceRetentionDays", "postEditRetentionDays"].includes(key)) {
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invalid(`defaults.${key} must be a number >= 0 (0 disables).`);
        } else {
          throw invalid(`Unsupported config field: ${section}.${key}.`);
        }
      } else if (section === "cleanup") {
        if (key === "enabled") {
          if (typeof value !== "boolean") throw invalid("cleanup.enabled must be a boolean.");
        } else if (key === "intervalMs") {
          if (!Number.isInteger(value) || value < 60000) throw invalid("cleanup.intervalMs must be an integer >= 60000.");
        } else {
          throw invalid(`Unsupported config field: ${section}.${key}.`);
        }
      } else if ((section === "api" || section === "agent") && key === "baseUrl") {
        assertHttpUrl(value, `${section}.${key}`);
      } else if (section === "agent" && TIMEOUT_KEYS.has(key)) {
        if (!Number.isInteger(value) || value <= 0) throw invalid(`agent.${key} must be a positive integer.`);
      } else if (section === "agent" && ["apiKey", "agentName"].includes(key)) {
        if (value !== null && typeof value !== "string") throw invalid(`agent.${key} must be a string or null.`);
      } else if (typeof value !== "string" || !value.trim()) {
        throw invalid(`${section}.${key} must be a non-empty string.`);
      } else if (section === "agent" && key === "model" && !/^[^/\s]+\/[^/\s]+$/.test(value.trim())) {
        throw invalid("agent.model must use the provider_id/model_id format.");
      }
    }
  }
  return patch;
}

function replaceMutableConfig(target, next) {
  for (const key of Object.keys(target)) {
    if (!(key in next)) delete target[key];
  }
  for (const [key, value] of Object.entries(next)) {
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object" && !Array.isArray(target[key])) {
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
    try { return JSON.parse(fs.readFileSync(this.configPath, "utf8")); }
    catch (error) {
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
