const projectOrchestrator = require("./project_orchestrator");
const { config } = require("../../../config");

class ProjectSetupModule {
  async run({ targetLanguage, baseUrl, systemPrompt = null, sourceImagePaths = null, translationTarget = null }) {
    const result = await projectOrchestrator.orchestrate({
      targetLanguage,
      baseUrl,
      systemPrompt,
      sourceImagePaths,
      translationTarget: translationTarget || config.translation?.defaultTarget || null,
      engines: config.engines,
    });

    return {
      projectName: result.projectName,
      operationId: result.operationId,
      engines: result.engines,
      steps: result.steps,
      translationTarget: result.translationTarget,
      systemPromptApplied: Boolean(systemPrompt),
    };
  }
}

module.exports = {
  ProjectSetupModule,
};
