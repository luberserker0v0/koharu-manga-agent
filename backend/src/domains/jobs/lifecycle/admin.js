const { paths } = require("../../../config");

class AdminModule {
  constructor(client) {
    this.client = client;
  }

  async listProjects({ baseUrl }) {
    return this.client.listProjects(baseUrl);
  }

  cleanLogs({ logsDir = paths.logs, maxFiles = 50 }) {
    const { cleanupLogs } = require("../../maintenance/cleanup_service");
    const result = cleanupLogs({ logsDir, maxFiles, dryRun: false });
    return { deleted: result.deleted, remaining: result.remaining };
  }
}

module.exports = {
  AdminModule,
};
