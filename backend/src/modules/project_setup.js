const legacyOneClick = require("../../../.opencode/skills/manga-translate-zhtw/scripts/one_click_translate.js");

class ProjectSetupModule {
  async run({ targetLanguage, baseUrl, systemPrompt = null, sourceImagePaths = null }) {
    const result = await legacyOneClick.orchestrate({
      targetLanguage,
      baseUrl,
      systemPrompt,
      sourceImagePaths,
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
