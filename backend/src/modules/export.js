const { config } = require("../config");

class ExportModule {
  constructor(client) {
    this.client = client;
  }

  async run({ baseUrl, exportFormat = config.defaults.exportFormat, outputDir }) {
    if (typeof outputDir !== "string" || !outputDir.trim()) {
      throw new Error("Export outputDir is required.");
    }

    return this.client.exportCurrentProject({
      format: exportFormat,
      outputDir: outputDir.trim(),
      baseUrl,
    });
  }
}

module.exports = {
  ExportModule,
};
