const legacyOneClick = require("../../../../../.opencode/skills/manga-translate-zhtw/scripts/one_click_translate.js");
const { config } = require("../../../config");

class ProjectSetupModule {
  async run({ targetLanguage, baseUrl, systemPrompt = null, sourceImagePaths = null }) {
    const result = await legacyOneClick.orchestrate({
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
