const fs = require("fs");
const path = require("path");
const { paths } = require("../config");

class AdminModule {
  constructor(client) {
    this.client = client;
  }

  async listProjects({ baseUrl }) {
    return this.client.listProjects(baseUrl);
  }

  cleanLogs({ logsDir = paths.logs, maxFiles = 50 }) {
    if (!fs.existsSync(logsDir)) {
      return { deleted: 0, remaining: 0 };
    }

    const files = fs
      .readdirSync(logsDir)
      .map((name) => ({
        name,
        fullPath: path.join(logsDir, name),
        stat: fs.statSync(path.join(logsDir, name)),
      }))
      .filter((entry) => entry.stat.isFile())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    const toDelete = files.slice(maxFiles);
    for (const entry of toDelete) {
      fs.unlinkSync(entry.fullPath);
    }

    return {
      deleted: toDelete.length,
      remaining: files.length - toDelete.length,
    };
  }
}

module.exports = {
  AdminModule,
};
