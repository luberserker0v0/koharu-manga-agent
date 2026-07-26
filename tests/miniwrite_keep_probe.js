const { AOClient } = require("../backend/src/ao_client");
const { config } = require("../backend/src/config");
const opencode = require("../backend/ao/opencode/opencode.json");

async function main() {
  const model = process.argv[2] || "opencode/deepseek-v4-flash-free";
  const client = new AOClient({
    baseUrl: config.agent.baseUrl,
    apiKey: config.agent.apiKey,
    readyPollIntervalMs: config.agent.readyPollIntervalMs,
    readyTimeoutMs: config.agent.readyTimeoutMs,
  });

  const id = `miniwrite-keep-${Date.now()}`;
  console.log(JSON.stringify({
    step: "create",
    id,
    model,
    messageTimeoutMs: config.agent.messageTimeoutMs,
  }, null, 2));

  await client.createConversation(id);
  await client.writeConfig(id, opencode);
  await client.startConversation(id);

  const ready = await client.waitUntilReady(id);
  console.log(JSON.stringify({
    step: "ready",
    id,
    status: ready.status,
    ready: ready.ready,
    sessionId: ready.sessionId,
  }, null, 2));

  const prompt = [
    "Write exactly two lines to output/mini_result.txt and overwrite the file.",
    "Line 1 must be exactly:",
    "TERM|班菲爾德家|organization|0.90|repeated family name",
    "Line 2 must be exactly:",
    "CHARACTER|里爾姆·塞拉·班菲爾德|aliases=里爾姆;title_forms=|0.88|formal full-name introduction",
    "Do not write anything else to the file.",
    "After writing the file, reply with exactly DONE.",
  ].join("\n");

  const res = await client.sendMessage(id, { text: prompt, model });
  console.log(JSON.stringify({
    step: "message_response",
    id,
    response: res,
  }, null, 2));

  for (let i = 0; i < 20; i += 1) {
    try {
      const listRoot = await client.listFiles(id);
      console.log(JSON.stringify({
        step: "list_root",
        id,
        attempt: i + 1,
        listRoot,
      }, null, 2));

      try {
        const listOutput = await client.listFiles(id, "output");
        console.log(JSON.stringify({
          step: "list_output",
          id,
          attempt: i + 1,
          listOutput,
        }, null, 2));
      } catch (error) {
        console.log(JSON.stringify({
          step: "list_output_error",
          id,
          attempt: i + 1,
          error: error.message,
        }, null, 2));
      }

      try {
        const file = await client.readFile(id, "output/mini_result.txt");
        console.log(JSON.stringify({
          step: "read_file",
          id,
          attempt: i + 1,
          file,
        }, null, 2));
        break;
      } catch (error) {
        console.log(JSON.stringify({
          step: "read_file_error",
          id,
          attempt: i + 1,
          error: error.message,
        }, null, 2));
      }
    } catch (error) {
      console.log(JSON.stringify({
        step: "list_root_error",
        id,
        attempt: i + 1,
        error: error.message,
      }, null, 2));
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  console.log(JSON.stringify({
    step: "done_keep",
    id,
    note: "conversation preserved for manual inspection",
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
