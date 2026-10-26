const { config } = require("../../../config");
const { assertTranslationExportComplete } = require("../exports/translation_export_validation");

class ExportModule {
  constructor(client) {
    this.client = client;
  }

  async run({ baseUrl, exportFormat = config.defaults.exportFormat, outputDir, expectedImageCount = null }) {
    if (typeof outputDir !== "string" || !outputDir.trim()) {
      throw new Error("Export outputDir is required.");
    }

    const artifact = await this.client.exportCurrentProject({
      format: exportFormat,
      outputDir: outputDir.trim(),
      baseUrl,
    });
    assertTranslationExportComplete(artifact, expectedImageCount);
    return artifact;
  }
}

module.exports = {
  ExportModule,
};
