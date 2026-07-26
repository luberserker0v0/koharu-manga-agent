#!/usr/bin/env node

const { createRuntime } = require("./src/runtime");

async function main() {
  const runtime = createRuntime();
  let koharu = null;
  if (runtime.koharuRuntimeManager?.enabled) {
    koharu = await runtime.koharuRuntimeManager.ensureRunning();
    runtime.applyKoharuRuntimeStatus(koharu);
  }
  await runtime.api.listen();
  const shutdown = async () => {
    try {
      await runtime.api.close();
      process.exit(0);
    } catch (error) {
      console.error(JSON.stringify({ success: false, error: error.message }));
      process.exit(1);
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  console.log(
    JSON.stringify({
      success: true,
      message: "Process-trigger backend started",
      host: runtime.api.server.address().address,
      port: runtime.api.server.address().port,
      koharu,
    })
  );
}

main().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error.message }));
  process.exit(1);
});
