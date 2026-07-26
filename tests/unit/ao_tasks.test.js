const fs = require("fs");
const path = require("path");

const {
  AOTaskRunner,
  buildBilingualEvidenceWindowPrompt,
  buildStageRoot,
  buildTerminologyExtractionPrompt,
  canonicalizeTranslationQualityObservationOutput,
} = require("../../backend/src/ao_tasks");

describe("Translation Quality Observation protocol normalization", () => {
  test("canonicalizes only known risk aliases", () => {
    const output = canonicalizeTranslationQualityObservationOutput([
      "NODE|window|n1|suspect|mistranslation,semantic_drift,role_agency|0.8|changed meaning",
      "NODE|window|n2|suspect|terminology_consistency,inconsistency|0.7|term drift",
      "NODE|window|n3|suspect|character_voice|0.6|voice drift",
      "NODE|window|n4|suspect|invented_risk|0.5|must remain invalid",
    ].join("\n"));

    expect(output).toContain("NODE|window|n1|suspect|meaning_change|0.8|");
    expect(output).toContain("NODE|window|n2|suspect|terminology|0.7|");
    expect(output).toContain("NODE|window|n3|suspect|style|0.6|");
    expect(output).toContain("NODE|window|n4|suspect|invented_risk|0.5|");
  });
});

describe("AOTaskRunner terminology extraction", () => {
  const jobId = "jest-terminology-output-file";
  const stageRoot = buildStageRoot(jobId, "terminology_extraction");

  afterEach(() => {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  });

  test("parses source-aware line output written by AO to a workspace file", async () => {
    const client = {
      createConversation: jest.fn().mockResolvedValue({ id: "conv-1" }),
      writeConfig: jest.fn().mockResolvedValue({ ok: true }),
      writeAgentsMd: jest.fn().mockResolvedValue({ ok: true }),
      writeAgentFile: jest.fn().mockResolvedValue({ ok: true }),
      uploadSkillZip: jest.fn().mockResolvedValue({ ok: true }),
      startConversation: jest.fn().mockResolvedValue({ ok: true }),
      waitUntilReady: jest.fn().mockResolvedValue({
        id: "conv-1",
        status: "running",
        ready: true,
        sessionId: "ses-1",
      }),
      writeFile: jest.fn().mockImplementation(async (_id, filePath, content) => ({ filePath, content })),
      sendMessage: jest.fn().mockResolvedValue({
        messageId: "msg-1",
        text: "DONE",
        parts: [{ type: "text", text: "DONE" }],
      }),
      readFile: jest.fn().mockImplementation(async (_id, filePath) => {
        if (filePath === "output/terminology_result.txt") {
          return {
            path: filePath,
            content: [
              "TERM|Royal Knights|王都騎士團|organization|0.93|repeated faction reference across lines",
              "CHARACTER|Alice|艾莉絲|aliases=團長;title_forms=艾莉絲隊長|0.89|explicit title usage in snippet",
              "NOTES|Conservative extraction only.",
            ].join("\n"),
          };
        }
        const writeCall = client.writeFile.mock.calls.find((call) => call[1] === filePath);
        return { path: filePath, content: writeCall?.[2] || "" };
      }),
      deleteConversation: jest.fn().mockResolvedValue({ ok: true }),
    };

    const runner = new AOTaskRunner({
      client,
      assetsLoader: () => ({
        opencodeConfig: { runtime: "opencode-direct" },
        agentsMd: "# test agents",
        agentFiles: [],
        skillArchives: [],
      }),
      settings: {
        model: "opencode/deepseek-v4-flash-free",
        readyPollIntervalMs: 1,
        readyTimeoutMs: 50,
        messageTimeoutMs: 50,
        terminologyAgentName: "knowledge-builder",
      },
    });

    const result = await runner.runTerminologyExtraction({
      jobId,
      translationPairs: [
        {
          pageName: "001.jpg",
          nodeId: "n1",
          original: "Alice of the Royal Knights",
          translation: "艾莉絲隊長率領王都騎士團出擊。",
        },
        {
          pageName: "001.jpg",
          nodeId: "n2",
          original: "The Royal Knights are here",
          translation: "王都騎士團已經到了。",
        },
      ],
      lockedTerminology: [],
      manualTerminology: [],
      referenceTerminology: [],
      knowledgeBase: {},
      storyContext: "",
      notes: "",
    });

    expect(client.sendMessage).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({
        model: "opencode/deepseek-v4-flash-free",
        agent: "knowledge-builder",
      })
    );
    expect(result.enrichmentMode).toBe("ao_line_format");
    expect(result.terminologyEntries).toEqual([
      expect.objectContaining({
        term: "Royal Knights",
        source_term: "Royal Knights",
        translation: "王都騎士團",
        category: "organization",
        confidence: 0.93,
      }),
    ]);
    expect(result.characterEntries).toEqual([
      expect.objectContaining({
        name: "艾莉絲",
        source_name: "Alice",
        aliases: ["團長"],
        title_forms: ["艾莉絲隊長"],
        confidence: 0.89,
      }),
    ]);
    expect(result.notes).toContain("Conservative extraction only.");
    expect(client.deleteConversation).toHaveBeenCalledWith("conv-1");

    const resultPath = path.join(stageRoot, "output", "result.json");
    const rawPath = path.join(stageRoot, "artifacts", "raw_response.json");
    const manifestPath = path.join(stageRoot, "artifacts", "export_manifest.json");

    expect(fs.existsSync(resultPath)).toBe(true);
    expect(fs.existsSync(rawPath)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);

    const storedResult = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    const storedRaw = JSON.parse(fs.readFileSync(rawPath, "utf-8"));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    expect(storedResult.terminologyEntries[0].term).toBe("Royal Knights");
    expect(storedResult.terminologyEntries[0].translation).toBe("王都騎士團");
    expect(storedRaw.file.path).toBe("output/terminology_result.txt");
    expect(manifest.metadata.normalizedBy).toBe("output_file");
  });

  test("sanitizes Windows-hostile job ids when building stage roots", () => {
    const stagePath = buildStageRoot("reference_ingestion:ref_123", "terminology_extraction");
    expect(stagePath).toContain("reference_ingestion_ref_123");
    expect(stagePath).not.toContain("reference_ingestion:ref_123\\terminology_extraction");
  });

  test("builds a source-reference terminology prompt without requiring translated alignment", () => {
    const prompt = buildTerminologyExtractionPrompt(
      {
        referenceKind: "source",
        sourceLines: ["リアム", "星間国家"],
        targetLines: [],
        translationPairs: [],
      },
      "output/terminology_result.txt"
    );

    expect(prompt).toContain("Reference mode: source");
    expect(prompt).toContain("This input is original-language reference material");
    expect(prompt).toContain("Use targetLines only as supporting evidence");
    expect(prompt).not.toContain("align it to the preferred target rendering from targetLines or translationPairs");
  });

  test("builds a translator-reference terminology prompt with target alignment guidance", () => {
    const prompt = buildTerminologyExtractionPrompt(
      {
        referenceKind: "translator",
        sourceLines: ["Banfield family"],
        targetLines: ["班菲爾德家"],
        translationPairs: [{ original: "Banfield family", translation: "班菲爾德家" }],
      },
      "output/terminology_result.txt"
    );

    expect(prompt).toContain("Reference mode: translator");
    expect(prompt).toContain("confirmed translationPairs");
    expect(prompt).toContain("Use Traditional Chinese canonical forms when reliable translator evidence exists.");
  });

  test("builds a target-only translator prompt without inventing source identity", () => {
    const prompt = buildTerminologyExtractionPrompt(
      {
        referenceKind: "translator",
        alignmentMode: "target_only",
        sourceLines: [],
        targetLines: ["班菲爾德家"],
        translationPairs: [],
      },
      "output/terminology_result.txt"
    );

    expect(prompt).toContain("target-only translator evidence");
    expect(prompt).toContain("do not invent a source-language identity");
    expect(prompt).not.toContain("confirmed translationPairs");
  });

  test("pins the bilingual fixed-line grammar to the current window id", () => {
    const prompt = buildBilingualEvidenceWindowPrompt({
      windowId: "term_expected_123",
      purpose: "terminology",
      anchors: [],
      sourceNodes: [],
      targetNodes: [],
    }, "output/bilingual_evidence.txt");

    expect(prompt).toContain("The only valid windowId is: term_expected_123");
    expect(prompt).toContain("TERM_LINK|term_expected_123|sourceMentionId|targetSurface|targetNodeKey[,targetNodeKey]|category|confidence|reason");
    expect(prompt).toContain("NO_MATCH|term_expected_123|anchorType|anchorId|reason");
    expect(prompt).toContain("WINDOW_DONE|term_expected_123");
    expect(prompt).toContain("Do not omit, add, or reorder fields.");
  });
});

describe("AOTaskRunner output lifecycle", () => {
  test("includes the backend validation failure when repairing JSON output", async () => {
    const writtenFiles = new Map();
    const client = {
      createConversation: jest.fn().mockResolvedValue({ id: "conv-json-repair" }),
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
      readFile: jest.fn(async (_id, filePath) => ({
        path: filePath,
        content: writtenFiles.get(filePath) || "",
      })),
      sendMessage: jest.fn()
        .mockResolvedValueOnce({ text: '{"confidence":"medium"}' })
        .mockResolvedValueOnce({ text: '{"confidence":0.5}' }),
      deleteConversation: jest.fn().mockResolvedValue({ ok: true }),
    };
    const runner = new AOTaskRunner({
      client,
      assetsLoader: () => ({
        opencodeConfig: {}, agentsMd: "", agentFiles: [], docFiles: [], skillArchives: [],
      }),
      settings: { messageTimeoutMs: 100 },
    });
    const validator = (value) => {
      if (!Number.isFinite(value.confidence)) throw new Error("confidence must be a finite number");
      return value;
    };

    const result = await runner.runTask({
      jobId: "json-repair-validation-error",
      stage: "knowledge_enrichment",
      prompt: "test",
      input: {},
      validator,
    });

    expect(result.confidence).toBe(0.5);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage.mock.calls[1][1].text).toContain(
      "Backend validation failure: confidence must be a finite number"
    );
  });

  test("accepts a valid output file and aborts a shared session that does not finish", async () => {
    const writtenFiles = new Map();
    const client = {
      writeFile: jest.fn(async (_id, filePath, content) => {
        writtenFiles.set(filePath, content);
        return { path: filePath, content };
      }),
      readFile: jest.fn(async (_id, filePath) => ({
        path: filePath,
        content: filePath === "output/result.txt" ? "valid result" : writtenFiles.get(filePath) || "",
      })),
      getConversation: jest.fn().mockResolvedValue({ status: "running", ready: true }),
      sendMessage: jest.fn(() => new Promise(() => {})),
      abortSession: jest.fn().mockResolvedValue({ aborted: true }),
    };
    const runner = new AOTaskRunner({ client, settings: { messageTimeoutMs: 5 } });

    const result = await runner.runTask({
      jobId: "shared-output-complete",
      stage: "shared_output_test",
      prompt: "test",
      input: {},
      validator: (value) => value,
      outputFilePath: "output/result.txt",
      outputFileParser: (content) => ({ content }),
      conversationId: "shared-conversation",
    });

    expect(result.content).toBe("valid result");
    expect(client.abortSession).toHaveBeenCalledWith("shared-conversation");
  });

  test("falls back to the nested AO message when output-file parsing fails", async () => {
    const writtenFiles = new Map();
    const client = {
      createConversation: jest.fn().mockResolvedValue({ id: "conv-fallback" }),
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
      readFile: jest.fn(async (_id, filePath) => ({
        path: filePath,
        content: filePath === "output/result.txt" ? "malformed file" : writtenFiles.get(filePath) || "",
      })),
      sendMessage: jest.fn().mockResolvedValue({
        parts: [{ type: "text", text: '{"status":"recovered"}' }],
      }),
      deleteConversation: jest.fn().mockResolvedValue({ ok: true }),
    };
    const runner = new AOTaskRunner({
      client,
      assetsLoader: () => ({
        opencodeConfig: {},
        agentsMd: "",
        agentFiles: [],
        docFiles: [],
        skillArchives: [],
      }),
      settings: { messageTimeoutMs: 100 },
    });

    const result = await runner.runTask({
      jobId: "nested-message-fallback",
      stage: "fallback_test",
      prompt: "test",
      input: {},
      validator: (value) => value,
      outputFilePath: "output/result.txt",
      outputFileParser: () => {
        throw new Error("invalid output file");
      },
    });

    expect(result.status).toBe("recovered");
    const taskInputWrite = client.writeFile.mock.calls.findIndex((call) => call[1] === "input/task_input.json");
    expect(taskInputWrite).toBeGreaterThanOrEqual(0);
    expect(client.writeFile.mock.invocationCallOrder[taskInputWrite])
      .toBeLessThan(client.startConversation.mock.invocationCallOrder[0]);
  });

  test("repairs a strict line output once in the same AO conversation", async () => {
    const writtenFiles = new Map();
    const client = {
      createConversation: jest.fn().mockResolvedValue({ id: "conv-strict-repair" }),
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
        if (filePath === "output/chapter_observation.txt") {
          return {
            path: filePath,
            content: client.sendMessage.mock.calls.length >= 2 ? "valid line" : "invalid line",
          };
        }
        return { path: filePath, content: writtenFiles.get(filePath) || "" };
      }),
      sendMessage: jest.fn().mockResolvedValue({ text: "DONE" }),
      deleteConversation: jest.fn().mockResolvedValue({ ok: true }),
    };
    const runner = new AOTaskRunner({
      client,
      assetsLoader: () => ({
        opencodeConfig: {},
        agentsMd: "",
        agentFiles: [],
        docFiles: [],
        skillArchives: [],
      }),
      settings: { messageTimeoutMs: 100, model: "test/model" },
    });

    const result = await runner.runTask({
      jobId: "strict-line-repair",
      stage: "chapter_observation",
      prompt: "test",
      input: {},
      validator: (value) => value,
      outputFilePath: "output/chapter_observation.txt",
      outputFileParser: (content) => {
        if (content !== "valid line") throw new Error("line contract mismatch");
        return { status: "repaired" };
      },
    });

    expect(result.status).toBe("repaired");
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage.mock.calls[1][1].text).toContain("line contract mismatch");
    expect(client.writeFile).toHaveBeenCalledWith(
      "conv-strict-repair",
      "output/chapter_observation.txt.invalid",
      "invalid line"
    );
    expect(client.deleteConversation).toHaveBeenCalledWith("conv-strict-repair");
  });

  test("uses a strict line response when AO completes without writing the output file", async () => {
    const writtenFiles = new Map();
    const client = {
      createConversation: jest.fn().mockResolvedValue({ id: "conv-line-fallback" }),
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
        if (filePath === "output/observation.txt") throw new Error("file not found");
        return { path: filePath, content: writtenFiles.get(filePath) || "" };
      }),
      getConversation: jest.fn().mockResolvedValue({ status: "running", ready: true }),
      sendMessage: jest.fn().mockResolvedValue({ parts: [{ type: "text", text: "VALID_LINE" }] }),
      deleteConversation: jest.fn().mockResolvedValue({ ok: true }),
    };
    const runner = new AOTaskRunner({
      client,
      assetsLoader: () => ({ opencodeConfig: {}, agentsMd: "", agentFiles: [], docFiles: [], skillArchives: [] }),
      settings: { messageTimeoutMs: 50, model: "test/model" },
    });

    const result = await runner.runTask({
      jobId: "strict-line-message-fallback",
      stage: "chapter_observation",
      prompt: "test",
      input: {},
      validator: (value) => value,
      outputFilePath: "output/observation.txt",
      outputFileParser: (content) => {
        if (content !== "VALID_LINE") throw new Error("invalid line");
        return { status: "recovered" };
      },
      outputTimeoutMs: 5,
    });

    expect(result.status).toBe("recovered");
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("repairs quality line output through the strict file path instead of JSON fallback", async () => {
    const writtenFiles = new Map();
    const outputPath = "output/quality_001_result.txt";
    const client = {
      createConversation: jest.fn().mockResolvedValue({ id: "conv-quality-repair" }),
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
        if (filePath === outputPath) {
          return {
            path: filePath,
            content: client.sendMessage.mock.calls.length >= 2
              ? "WINDOW_DONE|quality_001"
              : "ACCEPT|n1|representative_sample|looks fine\nWINDOW_DONE|quality_001",
          };
        }
        return { path: filePath, content: writtenFiles.get(filePath) || "" };
      }),
      sendMessage: jest.fn().mockResolvedValue({ text: "DONE" }),
      deleteConversation: jest.fn().mockResolvedValue({ ok: true }),
    };
    const runner = new AOTaskRunner({
      client,
      assetsLoader: () => ({
        opencodeConfig: {}, agentsMd: "", agentFiles: [], docFiles: [], skillArchives: [],
      }),
      settings: { messageTimeoutMs: 100, model: "test/model" },
    });

    const result = await runner.runTask({
      jobId: "quality-line-repair",
      stage: "quality_review_quality_001",
      prompt: "test",
      input: { windowId: "quality_001" },
      validator: (value) => value,
      outputFilePath: outputPath,
      outputFileParser: (content) => {
        if (content !== "WINDOW_DONE|quality_001") throw new Error("quality line contract mismatch");
        return { status: "repaired" };
      },
    });

    expect(result.status).toBe("repaired");
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage.mock.calls[1][1].text).toContain("Do not emit a WINDOW header");
    expect(client.sendMessage.mock.calls[1][1].text).not.toContain("Return one corrected JSON object");
    expect(client.writeFile).toHaveBeenCalledWith(
      "conv-quality-repair",
      `${outputPath}.invalid`,
      "ACCEPT|n1|representative_sample|looks fine\nWINDOW_DONE|quality_001"
    );
  });

  test("repairs knowledge line output through the strict file path instead of JSON fallback", async () => {
    const writtenFiles = new Map();
    const outputPath = "output/knowledge_result.txt";
    const client = {
      createConversation: jest.fn().mockResolvedValue({ id: "conv-knowledge-repair" }),
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
        if (filePath === outputPath) {
          return {
            path: filePath,
            content: client.sendMessage.mock.calls.length >= 2
              ? "NOTE|valid, punctuation\nKNOWLEDGE_DONE"
              : "NOTE|invalid\\, punctuation\nKNOWLEDGE_DONE",
          };
        }
        return { path: filePath, content: writtenFiles.get(filePath) || "" };
      }),
      sendMessage: jest.fn().mockResolvedValue({ text: "DONE" }),
      deleteConversation: jest.fn().mockResolvedValue({ ok: true }),
    };
    const runner = new AOTaskRunner({
      client,
      assetsLoader: () => ({
        opencodeConfig: {}, agentsMd: "", agentFiles: [], docFiles: [], skillArchives: [],
      }),
      settings: { messageTimeoutMs: 100, model: "test/model" },
    });

    const result = await runner.runTask({
      jobId: "knowledge-line-repair",
      stage: "knowledge_enrichment",
      prompt: "test",
      input: {},
      validator: (value) => value,
      outputFilePath: outputPath,
      outputFileParser: (content) => {
        if (content !== "NOTE|valid, punctuation\nKNOWLEDGE_DONE") {
          throw new Error("knowledge line contract mismatch");
        }
        return { enrichmentMode: "incremental_line" };
      },
    });

    expect(result.enrichmentMode).toBe("incremental_line");
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage.mock.calls[1][1].text).toContain("Do not escape commas");
    expect(client.sendMessage.mock.calls[1][1].text).not.toContain("Return one corrected JSON object");
    expect(client.writeFile).toHaveBeenCalledWith(
      "conv-knowledge-repair",
      `${outputPath}.invalid`,
      "NOTE|invalid\\, punctuation\nKNOWLEDGE_DONE"
    );
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
      readFile: jest
        .fn()
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

  test("stops waiting when the AO message completes without an output file", async () => {
    const runner = new AOTaskRunner({
      client: {
        readFile: jest.fn().mockRejectedValue(new Error("file not found")),
        getConversation: jest.fn().mockResolvedValue({ status: "running", ready: true }),
      },
      settings: { messageTimeoutMs: 1000 },
    });
    const completion = Promise.resolve({ parts: [{ type: "text", text: "DONE" }] });

    await expect(runner.waitForOutputFile("conv-complete", "output/result.txt", {
      timeoutMs: 1000,
      pollIntervalMs: 1,
      completionGraceMs: 1,
      completionPromise: completion,
    })).rejects.toMatchObject({ code: "AO_OUTPUT_MISSING" });
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
