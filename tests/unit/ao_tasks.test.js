const fs = require("fs");
const path = require("path");

const {
  AOTaskRunner,
  buildStageRoot,
  buildTaskDispatchMessage,
  buildTaskRequest,
} = require("../../backend/src/integrations/ao/tasks/ao_tasks");
describe("AOTaskRunner file task contracts", () => {
  test("sanitizes Windows-hostile job ids when building stage roots", () => {
    const stagePath = buildStageRoot("reference_ingestion:ref_123", "chapter_observation");
    expect(stagePath).toContain("reference_ingestion_ref_123");
    expect(stagePath).not.toContain("reference_ingestion:ref_123\\chapter_observation");
  });

  test("does not repeat bilingual grammar or the current window id in the message", () => {
    const prompt = buildTaskDispatchMessage(buildTaskRequest("bilingual_evidence_window", {
      windowId: "term_expected_123",
      purpose: "terminology",
      anchors: [],
      sourceNodes: [],
      targetNodes: [],
    }, { outputFilePath: "output/bilingual_evidence.txt" }));

    expect(prompt).toContain("Execute AO task: bilingual_evidence_window.");
    expect(prompt).not.toContain("term_expected_123");
    expect(prompt).not.toContain("TERM_LINK|");
    expect(prompt).not.toContain("WINDOW_DONE|");
  });

  test("builds a canonical file request for dynamic quality instances", () => {
    const request = buildTaskRequest("quality_review", { windowId: "quality_007" }, {
      outputFilePath: "output/quality_007_result.txt",
    });
    expect(request).toEqual(expect.objectContaining({
      taskType: "quality_review",
      inputFilePath: "input/task_input.json",
      outputMode: {
        type: "line_file",
        outputFilePath: "output/quality_007_result.txt",
        completionReply: "DONE",
      },
    }));
    expect(request).not.toHaveProperty("taskInstructions");
  });
});

describe("AOTaskRunner output lifecycle", () => {
  function createOwnedClient({ readOutput, sendMessage } = {}) {
    const writtenFiles = new Map();
    const client = {
      createConversation: jest.fn().mockResolvedValue({ id: "conv-file-task" }),
      writeConfig: jest.fn().mockResolvedValue({ ok: true }),
      writeAgentsMd: jest.fn().mockResolvedValue({ ok: true }),
      writeAgentFile: jest.fn().mockResolvedValue({ ok: true }),
      uploadSkillZip: jest.fn().mockResolvedValue({ ok: true }),
      startConversation: jest.fn().mockResolvedValue({ ok: true }),
      waitUntilReady: jest.fn().mockResolvedValue({ status: "running", ready: true }),
      writeFile: jest.fn(async (_id, filePath, content) => {
        writtenFiles.set(filePath, content);
        return { path: filePath, content };
      }),
      readFile: jest.fn(async (_id, filePath) => {
        if (filePath.startsWith("output/") && typeof readOutput === "function") {
          return readOutput(filePath, client, writtenFiles);
        }
        return { path: filePath, content: writtenFiles.get(filePath) || "" };
      }),
      getConversation: jest.fn().mockResolvedValue({ status: "running", ready: true }),
      sendMessage: jest.fn(sendMessage || (() => Promise.resolve({ text: "DONE" }))),
      abortSession: jest.fn().mockResolvedValue({ aborted: true }),
      deleteConversation: jest.fn().mockResolvedValue({ ok: true }),
    };
    return { client, writtenFiles };
  }

  test("requires a canonical task type and file parser", async () => {
    const runner = new AOTaskRunner({ client: {} });
    await expect(runner.runTask({
      jobId: "invalid-contract",
      stage: "chapter_observation",
      input: {},
      validator: (value) => value,
    })).rejects.toThrow("canonical taskType");
  });

  test("accepts a valid output file and aborts immediately without waiting for message prose", async () => {
    const writtenFiles = new Map();
    const client = {
      writeFile: jest.fn(async (_id, filePath, content) => {
        writtenFiles.set(filePath, content);
        return { path: filePath, content };
      }),
      readFile: jest.fn(async (_id, filePath) => ({
        path: filePath,
        content: filePath === "output/result.txt" ? "VALID_FILE" : writtenFiles.get(filePath) || "",
      })),
      getConversation: jest.fn().mockResolvedValue({ status: "running", ready: true }),
      sendMessage: jest.fn(() => new Promise(() => {})),
      abortSession: jest.fn().mockResolvedValue({ aborted: true }),
    };
    const runner = new AOTaskRunner({ client, settings: { messageTimeoutMs: 1000 } });

    const result = await runner.runTask({
      jobId: "shared-output-complete",
      stage: "chapter_observation_instance",
      taskType: "chapter_observation",
      input: { uniqueText: "NOT_IN_MESSAGE" },
      validator: (value) => value,
      outputFilePath: "output/result.txt",
      outputFileParser: (content) => ({ content }),
      conversationId: "shared-conversation",
    });

    expect(result.content).toBe("VALID_FILE");
    expect(client.abortSession).toHaveBeenCalledWith("shared-conversation");
    const dispatch = client.sendMessage.mock.calls[0][1].text;
    expect(dispatch).not.toContain("NOT_IN_MESSAGE");
    expect(dispatch).toContain("reply only: DONE");
  });

  test("does not use a valid-looking message when the output file is missing", async () => {
    const { client } = createOwnedClient({
      readOutput: async () => {
        throw new Error("file not found");
      },
      sendMessage: () => Promise.resolve({ parts: [{ type: "text", text: "VALID_LINE" }] }),
    });
    const runner = new AOTaskRunner({
      client,
      assetsLoader: () => ({
        opencodeConfig: {}, agentsMd: "", agentFiles: [], docFiles: [], skillArchives: [],
      }),
      settings: { messageTimeoutMs: 2000 },
    });

    await expect(runner.runTask({
      jobId: "missing-file",
      stage: "chapter_observation_instance",
      taskType: "chapter_observation",
      input: {},
      validator: (value) => value,
      outputFilePath: "output/result.txt",
      outputFileParser: (content) => ({ content }),
    })).rejects.toMatchObject({ code: "AO_OUTPUT_MISSING" });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("uses an explicit typed fallback for a semantic task with a missing output file", async () => {
    const { client } = createOwnedClient({
      readOutput: async () => {
        throw new Error("file not found");
      },
      sendMessage: () => Promise.resolve({ text: "DONE" }),
    });
    const runner = new AOTaskRunner({
      client,
      assetsLoader: () => ({
        opencodeConfig: {}, agentsMd: "", agentFiles: [], docFiles: [], skillArchives: [],
      }),
      settings: { messageTimeoutMs: 2000 },
    });

    const result = await runner.runTask({
      jobId: "missing-semantic-file",
      stage: "quality_review_instance",
      taskType: "quality_review",
      input: { windowId: "quality_001" },
      validator: (value) => value,
      outputFilePath: "output/result.txt",
      outputFileParser: (content) => ({ content, semanticResult: { outcome: "partial" } }),
      degradedOutputFactory: (input) => `WINDOW_DONE|${input.windowId}`,
    });

    expect(result.content).toBe("WINDOW_DONE|quality_001");
    expect(result.semanticResult.outcome).toBe("partial");
  });

  test("repairs an invalid file once with a short file-referenced message", async () => {
    const { client, writtenFiles } = createOwnedClient({
      readOutput: async (filePath, currentClient) => ({
        path: filePath,
        content: currentClient.sendMessage.mock.calls.length >= 2 ? "VALID_FILE" : "INVALID_FILE",
      }),
    });
    const runner = new AOTaskRunner({
      client,
      assetsLoader: () => ({
        opencodeConfig: {}, agentsMd: "", agentFiles: [], docFiles: [], skillArchives: [],
      }),
      settings: { messageTimeoutMs: 1000, model: "test/model" },
    });

    const result = await runner.runTask({
      jobId: "repair-once",
      stage: "chapter_observation_instance",
      taskType: "chapter_observation",
      input: { uniqueText: "DO_NOT_REPEAT_THIS_INPUT" },
      validator: (value) => value,
      outputFilePath: "output/result.txt",
      outputFileParser: (content) => {
        if (content !== "VALID_FILE") throw new Error("line contract mismatch");
        return { status: "repaired" };
      },
    });

    expect(result.status).toBe("repaired");
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(writtenFiles.get("output/result.txt.invalid")).toBe("INVALID_FILE");
    const repairMessage = client.sendMessage.mock.calls[1][1].text;
    expect(repairMessage).toContain("line contract mismatch");
    expect(repairMessage).toContain("output/result.txt.invalid");
    expect(repairMessage).not.toContain("DO_NOT_REPEAT_THIS_INPUT");
    expect(repairMessage).not.toContain("NODE|");
  });

  test("fails after one repair attempt when the corrected file remains invalid", async () => {
    const { client } = createOwnedClient({
      readOutput: async (filePath) => ({ path: filePath, content: "INVALID_FILE" }),
    });
    const runner = new AOTaskRunner({
      client,
      assetsLoader: () => ({
        opencodeConfig: {}, agentsMd: "", agentFiles: [], docFiles: [], skillArchives: [],
      }),
      settings: { messageTimeoutMs: 1000 },
    });

    await expect(runner.runTask({
      jobId: "repair-fails",
      stage: "chapter_observation_instance",
      taskType: "chapter_observation",
      input: {},
      validator: (value) => value,
      outputFilePath: "output/result.txt",
      outputFileParser: () => {
        throw new Error("still invalid");
      },
    })).rejects.toThrow("still invalid");
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  test("fails immediately when AO stops before writing the output file", async () => {
    const runner = new AOTaskRunner({
      client: {
        readFile: jest.fn().mockRejectedValue(new Error("file not found")),
        getConversation: jest.fn().mockResolvedValue({
          status: "stopped",
          ready: false,
          needsRestart: true,
        }),
      },
      settings: { messageTimeoutMs: 600000 },
    });

    await expect(runner.waitForOutputFile("conv-stopped", "output/result.txt"))
      .rejects.toThrow("stopped before producing");
  });

  test("emits heartbeat progress while AO is running and output is pending", async () => {
    const onProgress = jest.fn();
    const client = {
      readFile: jest.fn()
        .mockResolvedValueOnce({ content: "" })
        .mockResolvedValueOnce({ content: "DONE" }),
      getConversation: jest.fn().mockResolvedValue({
        status: "running",
        ready: true,
        needsRestart: false,
      }),
    };
    const runner = new AOTaskRunner({ client, settings: { messageTimeoutMs: 100 } });

    await expect(runner.waitForOutputFile("conv-running", "output/result.txt", {
      pollIntervalMs: 1,
      heartbeatIntervalMs: 0,
      onProgress,
    })).resolves.toBe("DONE");
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      activity: "waiting_ao_output",
      conversationStatus: "running",
      ready: true,
    }));
  });

  test("fails fast when the AO session has an empty zero-token assistant message", async () => {
    const runner = new AOTaskRunner({
      client: {
        readFile: jest.fn().mockRejectedValue(new Error("file not found")),
        getConversation: jest.fn().mockResolvedValue({
          status: "running",
          ready: true,
          sessionId: "session-silent",
        }),
        listSessionMessages: jest.fn().mockResolvedValue([{
          info: { role: "assistant", tokens: { input: 0, output: 0, reasoning: 0 } },
          parts: [],
        }]),
      },
      settings: { messageTimeoutMs: 1000 },
    });

    await expect(runner.waitForOutputFile("conv-silent", "output/result.txt", {
      timeoutMs: 1000,
      pollIntervalMs: 1,
      modelSilenceTimeoutMs: 1,
    })).rejects.toMatchObject({ code: "AO_MODEL_NO_OUTPUT" });
  });
});
