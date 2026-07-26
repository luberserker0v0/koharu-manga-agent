#!/usr/bin/env node

const { config, paths } = require("../src/config");
const { KoharuRuntimeManager } = require("../src/modules/koharu_runtime");

async function main() {
  const manager = new KoharuRuntimeManager({
    config: config.koharuRuntime || {},
    installRoot: paths.koharuRuntimeInstallRoot,
  });

  if (!manager.enabled) {
    console.log(JSON.stringify({ success: true, skipped: true, reason: "managed_koharu_disabled" }));
    return;
  }

  const status = await manager.ensureInstalled();
  console.log(JSON.stringify({ success: true, koharu: status }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ success: false, error: error.message }));
    process.exit(1);
  });
}

module.exports = {
  main,
};
