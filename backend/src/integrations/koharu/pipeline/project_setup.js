const crypto = require("crypto");
const projectOrchestrator = require("./project_orchestrator");
const { config } = require("../../../config");
const { resolvePipelineProfile } = require("../../../domains/translation/pipeline/pipeline_profiles");

function buildSystemPromptMetadata(systemPrompt, source = "none") {
  if (typeof systemPrompt !== "string" || !systemPrompt) {
    return { applied: false, source: "none", bytes: 0, sha256: null };
  }
  return {
    applied: true,
    source,
    bytes: Buffer.byteLength(systemPrompt, "utf8"),
    sha256: crypto.createHash("sha256").update(systemPrompt, "utf8").digest("hex"),
  };
}

function buildGenerationSettingsMetadata(translationTarget, lmStudio, requested, proxy) {
  const temperature = requested?.temperature ?? translationTarget?.generationOptions?.temperature;
  const applicable = translationTarget?.kind !== "machine_translation";
  const reasoning = typeof requested?.reasoning === "string" ? requested.reasoning : null;
  const enforced = applicable && proxy?.baseUrl && proxy?.providerId === translationTarget?.providerId;
  return {
    temperature: typeof temperature === "number" ? temperature : null,
    temperatureSource: enforced ? "backend_lmstudio_native_proxy" : "koharu_request",
    reasoning,
    thinkingEnabled: enforced && reasoning ? reasoning !== "off" : null,
    thinkingSource: !applicable ? "not_applicable"
      : enforced ? "backend_lmstudio_native_proxy" : "not_exposed_by_execution_api",
    reasoningCapability: lmStudio?.reasoning || null,
  };
}

class ProjectSetupModule {
  constructor({ lmStudioClient = null } = {}) {
    this.lmStudioClient = lmStudioClient;
  }

  async inspectLmStudio(modelId, baseUrl) {
    if (!this.lmStudioClient || !modelId || !baseUrl) return null;
    try {
      return await this.lmStudioClient.inspectModel(modelId, baseUrl);
    } catch {
      return { available: false, errorCode: "lmstudio_metadata_unavailable" };
    }
  }

  async refreshRuntimeMetadata(setup, lmStudioBaseUrl) {
    const lmStudio = await this.inspectLmStudio(setup.translationTarget?.modelId, lmStudioBaseUrl);
    return {
      ...setup,
      generationSettings: buildGenerationSettingsMetadata(
        setup.translationTarget, lmStudio, setup.requestedGenerationOptions, setup.translationProxy,
      ),
      lmStudio,
    };
  }

  async run(options) {
    const { targetLanguage, baseUrl, systemPrompt = null, systemPromptSource = "none",
      sourceImagePaths = null, translationTarget = null, generationOptions = null,
      lmStudioBaseUrl = null, translationProxy = null, translationMode = null } = options;
    const pipelineProfile = resolvePipelineProfile(config.pipeline, { translationMode });
    const result = await projectOrchestrator.orchestrate({
      targetLanguage,
      baseUrl,
      systemPrompt,
      sourceImagePaths,
      translationTarget: translationTarget || config.translation?.defaultTarget || null,
      generationOptions: generationOptions || config.translation?.generationOptions || null,
      translationProxy,
      engines: pipelineProfile.engines,
    });
    return this.refreshRuntimeMetadata({
      projectName: result.projectName,
      operationId: result.operationId,
      engines: result.engines,
      steps: result.steps,
      pipelineProfile,
      translationTarget: result.translationTarget,
      translationProxy: result.translationProxy,
      requestedGenerationOptions: generationOptions || config.translation?.generationOptions || null,
      systemPromptApplied: Boolean(systemPrompt),
      systemPromptMetadata: buildSystemPromptMetadata(systemPrompt, systemPromptSource),
    }, lmStudioBaseUrl);
  }
}

module.exports = {
  ProjectSetupModule,
  buildGenerationSettingsMetadata,
  buildSystemPromptMetadata,
};
