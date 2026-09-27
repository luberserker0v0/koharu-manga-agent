const projectOrchestrator = require("./project_orchestrator");
const { config } = require("../../../config");

class ProjectSetupModule {
  async run({ targetLanguage, baseUrl, systemPrompt = null, sourceImagePaths = null }) {
    const result = await projectOrchestrator.orchestrate({
      targetLanguage,
      baseUrl,
      systemPrompt,
      sourceImagePaths,
      modelId: config.llm.defaultModel,
      providerId: config.llm.defaultProvider,
      engines: config.engines,
    });

    return {
      projectName: result.projectName,
      operationId: result.operationId,
      engines: result.engines,
      steps: result.steps,
      llm: result.llm,
      systemPromptApplied: Boolean(systemPrompt),
    };
  }
}

module.exports = {
  ProjectSetupModule,
};
