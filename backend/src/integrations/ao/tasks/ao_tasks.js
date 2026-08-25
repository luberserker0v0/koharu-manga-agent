const fs = require("fs");
const path = require("path");
const { config, paths } = require("../../../config");
const { loadAoAssets } = require("../assets/ao_assets");
const {
  validateKnowledgeEnrichmentResult,
} = require("../contracts/ao_contracts");
const {
  parseLineBasedStoryDelta,
  validateStoryDeltaResult,
} = require("../contracts/story_delta_contract");
const {
  collectExpectedNodes: collectObservationNodes,
  parseLineBasedChapterObservation,
  validateChapterObservation,
} = require("../contracts/chapter_observation_contract");
const {
  parseBilingualEvidenceWindow,
  validateBilingualEvidenceWindow,
} = require("../contracts/bilingual_evidence_contract");
const {
  buildTaskDispatchMessage,
  buildTaskRequest,
} = require("./ao_prompt_templates");
const { parseQualityWindowOutput } = require("../contracts/quality_line_contract");
const { parseTranslationQualityObservationOutput } = require("../contracts/translation_quality_observation_contract");
const { parseDeepAuditWindowOutput } = require("../contracts/deep_audit_line_contract");
const { parseKnowledgeEnrichmentOutput } = require("../contracts/knowledge_line_contract");
const { parseReferenceLocaleProjectionOutput } = require("../contracts/reference_locale_projection_contract");

function uniqueStringList(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function sanitizePathSegment(value, fallback = "adhoc") {
  const normalized = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return normalized || fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStageRoot(jobId, stage) {
  return path.join(
    paths.workspaceRoot,
    sanitizePathSegment(jobId, "adhoc"),
    sanitizePathSegment(stage, "stage")
  );
}

function buildConversationId(stage, jobId) {
  const base = `${stage}-${jobId || "adhoc"}`.replace(/[^a-zA-Z0-9:_-]/g, "_");
  return `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeStageArtifacts(stageRoot, {
  taskType,
  taskInput,
  taskOutput,
  rawOutput = null,
  metadata = {},
  rejectedReason = null,
}) {
  ensureDir(path.join(stageRoot, "artifacts"));
  ensureDir(path.join(stageRoot, "output"));
  const taskInputPath = path.join(stageRoot, "artifacts", "task_input.json");
  fs.writeFileSync(taskInputPath, JSON.stringify(taskInput, null, 2), "utf8");
  const importManifestPath = path.join(stageRoot, "artifacts", "import_manifest.json");
  fs.writeFileSync(
    importManifestPath,
    JSON.stringify(
      {
        metadata: {
          stage: taskType,
          createdAt: new Date().toISOString(),
        },
        inputs: [
          {
            key: "task_input",
            type: "json",
            bytes: Buffer.byteLength(JSON.stringify(taskInput), "utf8"),
            path: taskInputPath,
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  const exportManifestPath = path.join(stageRoot, "artifacts", "export_manifest.json");
  const exportPayload = {
    metadata: {
      stage: taskType,
      createdAt: new Date().toISOString(),
      ...metadata,
    },
    accepted: [],
    rejected: [],
  };

  let rawOutputPath = null;
  if (rawOutput !== null && rawOutput !== undefined) {
    rawOutputPath = path.join(stageRoot, "artifacts", "raw_response.json");
    fs.writeFileSync(rawOutputPath, JSON.stringify(rawOutput, null, 2), "utf8");
    exportPayload.accepted.push({
      file: "artifacts/raw_response.json",
      path: rawOutputPath,
    });
  }

  if (rejectedReason) {
    exportPayload.rejected.push({
      file: "output/result.json",
      reason: rejectedReason,
    });
  } else {
    const resultPath = path.join(stageRoot, "output", "result.json");
    fs.writeFileSync(resultPath, JSON.stringify(taskOutput, null, 2), "utf8");
    exportPayload.accepted.push({
      file: "output/result.json",
      path: resultPath,
    });
  }

  fs.writeFileSync(exportManifestPath, JSON.stringify(exportPayload, null, 2), "utf8");
  return {
    taskInputPath,
    importManifestPath,
    exportManifestPath,
    rawOutputPath,
    resultPath: rejectedReason ? null : path.join(stageRoot, "output", "result.json"),
  };
}

function normalizeAoFileContent(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function findFirstDiffIndex(left, right) {
  const max = Math.min(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }
  return left.length === right.length ? -1 : max;
}

function buildAoFileMismatchError(filePath, expected, actual) {
  const normalizedExpected = normalizeAoFileContent(expected);
  const normalizedActual = normalizeAoFileContent(actual);
  const diffIndex = findFirstDiffIndex(normalizedExpected, normalizedActual);
  const start = Math.max(0, diffIndex - 40);
  const end = diffIndex < 0 ? 80 : diffIndex + 80;
  const expectedSlice = normalizedExpected.slice(start, end);
  const actualSlice = normalizedActual.slice(start, end);
  return new Error(
    [
      `AO file round-trip mismatch for ${filePath}.`,
      `First diff index: ${diffIndex}.`,
      `Expected slice: ${JSON.stringify(expectedSlice)}`,
      `Actual slice: ${JSON.stringify(actualSlice)}`,
    ].join(" ")
  );
}

function buildTaskWorkspaceFiles(taskRequest, input) {
  return [
    {
      path: "input/task_input.json",
      content: JSON.stringify(input, null, 2),
    },
    {
      path: "input/task_request.json",
      content: JSON.stringify(taskRequest, null, 2),
    },
  ];
}

function isDegradableOutputError(error) {
  return ["AO_OUTPUT_MISSING", "AO_OUTPUT_INCOMPLETE"].includes(error?.code);
}

class AOTaskRunner {
  constructor({ client, assetsLoader = loadAoAssets, settings = config.agent } = {}) {
    this.client = client;
    this.assetsLoader = assetsLoader;
    this.settings = settings;
  }

  async initializeConversation(conversationId, workspaceFiles = []) {
    const created = await this.client.createConversation(conversationId);
    const assets = this.assetsLoader();

    await this.client.writeConfig(created.id, assets.opencodeConfig);
    if (assets.agentsMd) {
      await this.client.writeAgentsMd(created.id, assets.agentsMd);
    }
    for (const agentFile of assets.agentFiles) {
      await this.client.writeAgentFile(created.id, agentFile.name, agentFile.content);
    }
    for (const docFile of assets.docFiles || []) {
      await this.client.writeFile(
        created.id,
        `.opencode/docs/${docFile.path}`,
        docFile.content
      );
    }
    for (const skill of assets.skillArchives) {
      await this.client.uploadSkillZip(created.id, skill.name, skill.zipBuffer);
    }
    for (const file of workspaceFiles) {
      await this.client.writeFile(created.id, file.path, file.content);
      const roundTripFile = await this.client.readFile(created.id, file.path);
      const actualContent =
        roundTripFile && typeof roundTripFile.content === "string" ? roundTripFile.content : "";
      if (normalizeAoFileContent(actualContent) !== normalizeAoFileContent(file.content)) {
        throw buildAoFileMismatchError(file.path, file.content, actualContent);
      }
    }
    await this.client.startConversation(created.id);
    await this.client.waitUntilReady(created.id, {
      readyPollIntervalMs: this.settings.readyPollIntervalMs,
      readyTimeoutMs: this.settings.readyTimeoutMs,
    });
    return created.id;
  }

  async createTaskSession(jobId, stage = "reference_ingestion") {
    return this.initializeConversation(buildConversationId(stage, jobId));
  }

  async closeTaskSession(conversationId) {
    if (conversationId) {
      await this.client.deleteConversation(conversationId).catch(() => {});
    }
  }

  async waitForOutputFile(conversationId, outputFilePath, {
    timeoutMs = this.settings.messageTimeoutMs || 300000,
    pollIntervalMs = 1500,
    isCanceled = null,
    onProgress = null,
    heartbeatIntervalMs = 10000,
    completionPromise = null,
    completionGraceMs = 500,
    modelSilenceTimeoutMs = this.settings.modelSilenceTimeoutMs || null,
    sessionCheckIntervalMs = Math.min(10000, Math.max(1, modelSilenceTimeoutMs || 10000)),
  } = {}) {
    const startedAt = Date.now();
    let lastHeartbeatAt = 0;
    let lastError = null;
    let lastSessionCheckAt = 0;
    const completion = { settled: false, rejected: false, value: null, error: null, settledAt: 0 };
    if (completionPromise) {
      Promise.resolve(completionPromise).then((value) => {
        Object.assign(completion, { settled: true, value, settledAt: Date.now() });
      }, (error) => {
        Object.assign(completion, { settled: true, rejected: true, error, settledAt: Date.now() });
      });
    }

    while (Date.now() - startedAt < timeoutMs) {
      if (typeof isCanceled === "function" && isCanceled()) {
        throw new Error("AO task canceled by user.");
      }
      try {
        const file = await this.client.readFile(conversationId, outputFilePath);
        if (file && typeof file.content === "string" && file.content.trim().length > 0) {
          return file.content;
        }
      } catch (error) {
        lastError = error;
      }
      if (completion.rejected) {
        const messageError = new Error(`AO message failed before producing ${outputFilePath}: ${completion.error?.message || completion.error}`);
        messageError.code = "AO_MESSAGE_FAILED";
        messageError.cause = completion.error;
        throw messageError;
      }
      if (completion.settled && Date.now() - completion.settledAt >= completionGraceMs) {
        const missingError = new Error(`AO completed without writing ${outputFilePath}.`);
        missingError.code = "AO_OUTPUT_MISSING";
        missingError.messageResponse = completion.value;
        missingError.cause = lastError;
        throw missingError;
      }
      const conversation = await this.client.getConversation(conversationId);
      if (conversation.status !== "running") {
        throw new Error(
          `AO conversation ${conversationId} stopped before producing ${outputFilePath} ` +
          `(status=${conversation.status || "unknown"}, needsRestart=${conversation.needsRestart === true}).`
        );
      }
      const now = Date.now();
      if (
        typeof this.client.listSessionMessages === "function" &&
        conversation.sessionId &&
        now - lastSessionCheckAt >= sessionCheckIntervalMs
      ) {
        lastSessionCheckAt = now;
        try {
          const messagePayload = await this.client.listSessionMessages(conversationId, conversation.sessionId);
          const messages = Array.isArray(messagePayload) ? messagePayload : (messagePayload?.messages || []);
          const assistant = [...messages].reverse().find((entry) => entry?.info?.role === "assistant");
          const tokens = assistant?.info?.tokens || {};
          const tokenCount = Number(tokens.input || 0) + Number(tokens.output || 0) + Number(tokens.reasoning || 0);
          const hasParts = Array.isArray(assistant?.parts) && assistant.parts.length > 0;
          if (
            modelSilenceTimeoutMs > 0 &&
            assistant &&
            !hasParts &&
            tokenCount === 0 &&
            now - startedAt >= modelSilenceTimeoutMs
          ) {
            const silenceError = new Error(
              `AO model produced no tokens or message parts for ${modelSilenceTimeoutMs}ms ` +
              `(conversation=${conversationId}, session=${conversation.sessionId}).`
            );
            silenceError.code = "AO_MODEL_NO_OUTPUT";
            throw silenceError;
          }
        } catch (error) {
          if (error?.code === "AO_MODEL_NO_OUTPUT") throw error;
        }
      }
      if (typeof onProgress === "function" && now - lastHeartbeatAt >= heartbeatIntervalMs) {
        lastHeartbeatAt = now;
        onProgress({
          activity: "waiting_ao_output",
          elapsedMs: now - startedAt,
          conversationStatus: conversation.status,
          ready: conversation.ready === true,
          needsRestart: conversation.needsRestart === true,
          outputFilePath,
          heartbeatAt: new Date(now).toISOString(),
        });
      }
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      const completionWaitMs = completion.settled
        ? Math.max(1, completionGraceMs - (Date.now() - completion.settledAt))
        : pollIntervalMs;
      if (remainingMs > 0) await sleep(Math.min(pollIntervalMs, completionWaitMs, remainingMs));
    }

    const timeoutError = new Error(`AO did not produce ${outputFilePath} within ${timeoutMs}ms.`);
    timeoutError.code = "AO_OUTPUT_TIMEOUT";
    timeoutError.cause = lastError;
    throw timeoutError;
  }

  async repairStrictOutputFile({
    conversationId,
    taskType,
    outputFilePath,
    validationError,
    invalidContent,
    input,
    validator,
    outputFileParser,
    agentName,
    isCanceled,
    onProgress,
    outputTimeoutMs = null,
  }) {
    const invalidFilePath = `${outputFilePath}.invalid`;
    await this.client.writeFile(conversationId, invalidFilePath, invalidContent || "");
    await this.client.writeFile(conversationId, outputFilePath, "");
    const repairPrompt = [
      `Repair the invalid output file for AO task: ${taskType}.`,
      `Validation error: ${validationError.message}`,
      `Read input/task_request.json, input/task_input.json, and ${invalidFilePath}.`,
      `Overwrite ${outputFilePath} with one complete contract-valid result.`,
      "Do not repeat the result or explain the repair in the message reply.",
      "After writing the corrected file, reply with only: DONE",
    ].join("\n");
    const repairMessagePromise = this.client.sendMessage(conversationId, {
      text: repairPrompt,
      model: this.settings.model || null,
      agent: agentName || this.settings.agentName || null,
    });
    repairMessagePromise.catch(() => {});
    const repairedContent = await this.waitForOutputFile(conversationId, outputFilePath, {
      timeoutMs: outputTimeoutMs || this.settings.messageTimeoutMs || 300000,
      isCanceled,
      onProgress: typeof onProgress === "function"
        ? (progress) => onProgress({ ...progress, activity: "repairing_ao_output" })
        : null,
      completionPromise: repairMessagePromise,
    });
    let payload;
    try {
      payload = validator(outputFileParser(repairedContent, input));
    } catch (error) {
      error.outputFileContent = repairedContent;
      throw error;
    }
    if (typeof this.client.abortSession === "function") {
      await this.client.abortSession(conversationId).catch(() => {});
    }
    return {
      payload,
      content: repairedContent,
    };
  }

  async runTask({
    jobId,
    stage,
    taskType,
    input,
    validator,
    agentName = null,
    outputFilePath,
    outputFileParser,
    conversationId = null,
    isCanceled = null,
    onProgress = null,
    outputTimeoutMs = null,
    degradedOutputFactory = null,
  }) {
    if (!taskType) throw new Error("AO file task requires a canonical taskType.");
    if (!outputFilePath || typeof outputFileParser !== "function") {
      throw new Error("AO task " + taskType + " requires outputFilePath and outputFileParser.");
    }

    const requestedConversationId = conversationId || buildConversationId(stage, jobId);
    const stageRoot = buildStageRoot(jobId, stage);
    const taskRequest = buildTaskRequest(taskType, input, { outputFilePath });
    const dispatchMessage = buildTaskDispatchMessage(taskRequest);
    const promptBytes = Buffer.byteLength(dispatchMessage, "utf8");
    const inputBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    const startedAt = Date.now();
    const workspaceFiles = buildTaskWorkspaceFiles(taskRequest, input);
    const ownsConversation = !conversationId;
    let activeConversationId = null;
    let outputFileContent = null;
    let repairAttempted = false;
    let degradedOutputError = null;
    ensureDir(stageRoot);

    try {
      activeConversationId = ownsConversation
        ? await this.initializeConversation(requestedConversationId, workspaceFiles)
        : requestedConversationId;
      if (typeof isCanceled === "function" && isCanceled()) {
        throw new Error("AO task canceled by user.");
      }
      if (!ownsConversation) {
        for (const file of workspaceFiles) {
          await this.client.writeFile(activeConversationId, file.path, file.content);
          const roundTripFile = await this.client.readFile(activeConversationId, file.path);
          const actualContent =
            roundTripFile && typeof roundTripFile.content === "string" ? roundTripFile.content : "";
          if (normalizeAoFileContent(actualContent) !== normalizeAoFileContent(file.content)) {
            throw buildAoFileMismatchError(file.path, file.content, actualContent);
          }
        }
      }
      await this.client.writeFile(activeConversationId, outputFilePath, "");

      const messagePromise = this.client.sendMessage(activeConversationId, {
        text: dispatchMessage,
        model: this.settings.model || null,
        agent: agentName || this.settings.agentName || null,
      });
      messagePromise.catch(() => {});
      try {
        outputFileContent = await this.waitForOutputFile(activeConversationId, outputFilePath, {
          timeoutMs: outputTimeoutMs || this.settings.messageTimeoutMs || 300000,
          isCanceled,
          onProgress,
          completionPromise: messagePromise,
        });
      } catch (error) {
        if (typeof degradedOutputFactory !== "function" || !isDegradableOutputError(error)) throw error;
        degradedOutputError = error;
        outputFileContent = degradedOutputFactory(input, error);
      }

      let payload;
      try {
        payload = validator(outputFileParser(outputFileContent, input));
      } catch (validationError) {
        repairAttempted = true;
        if (typeof this.client.abortSession === "function") {
          await this.client.abortSession(activeConversationId).catch(() => {});
        }
        try {
          const repaired = await this.repairStrictOutputFile({
            conversationId: activeConversationId,
            taskType,
            outputFilePath,
            validationError,
            invalidContent: outputFileContent,
            input,
            validator,
            outputFileParser,
            agentName,
            isCanceled,
            onProgress,
            outputTimeoutMs,
          });
          payload = repaired.payload;
          outputFileContent = repaired.content;
        } catch (repairError) {
          if (typeof degradedOutputFactory !== "function" || !isDegradableOutputError(repairError)) throw repairError;
          degradedOutputError = repairError;
          outputFileContent = degradedOutputFactory(input, repairError);
          payload = validator(outputFileParser(outputFileContent, input));
        }
      }

      if (!repairAttempted && typeof this.client.abortSession === "function") {
        await this.client.abortSession(activeConversationId).catch(() => {});
      }
      writeStageArtifacts(stageRoot, {
        taskType,
        taskInput: input,
        taskOutput: payload,
        rawOutput: {
          file: { path: outputFilePath, content: outputFileContent },
          validation: degradedOutputError ? "degraded" : "passed",
          repairAttempted,
          degradedFromError: degradedOutputError?.message || null,
        },
        metadata: {
          conversationId: activeConversationId,
          normalizedBy: repairAttempted ? "output_file_repair" : "output_file",
          semanticOutcome: degradedOutputError ? "partial" : "validated",
          promptBytes,
          inputBytes,
          outputBytes: Buffer.byteLength(outputFileContent, "utf8"),
          elapsedMs: Date.now() - startedAt,
        },
      });
      return { ...payload, stageRoot, conversationId: activeConversationId };
    } catch (error) {
      if (activeConversationId && typeof this.client.abortSession === "function") {
        await this.client.abortSession(activeConversationId).catch(() => {});
      }
      writeStageArtifacts(stageRoot, {
        taskType,
        taskInput: input,
        taskOutput: null,
        rawOutput: outputFileContent == null
          ? null
          : {
              file: { path: outputFilePath, content: outputFileContent },
              validation: "failed",
              repairAttempted,
            },
        metadata: {
          conversationId: activeConversationId,
          promptBytes,
          inputBytes,
          outputBytes: outputFileContent == null ? 0 : Buffer.byteLength(outputFileContent, "utf8"),
          elapsedMs: Date.now() - startedAt,
        },
        rejectedReason: error.message,
      });
      throw error;
    } finally {
      if (activeConversationId && ownsConversation) {
        await this.client.deleteConversation(activeConversationId).catch(() => {});
      }
    }
  }
  async runQualityReviewAndOptimization(input, options = {}) {
    const outputFilePath = options.outputFilePath || `output/${input.windowId || "quality"}_result.txt`;

    return this.runTask({
      jobId: input.jobId,
      stage: `quality_review_${input.windowId || "window"}`,
      taskType: "quality_review",
      input,
      validator: (value) => value,
      agentName: this.settings.qualityAgentName || null,
      outputFilePath,
      outputFileParser: parseQualityWindowOutput,
      degradedOutputFactory: (taskInput) => `WINDOW_DONE|${taskInput.windowId}`,
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
      outputTimeoutMs: options.outputTimeoutMs || this.settings.messageTimeoutMs || 300000,
    });
  }

  async runTranslationQualityObservationWindow(input, options = {}) {
    const outputFilePath = options.outputFilePath || `output/${input.windowId}_quality_observation.txt`;
    return this.runTask({
      jobId: input.jobId,
      stage: `translation_quality_observation_${input.windowId}`,
      taskType: "translation_quality_observation",
      input,
      validator: (value) => value,
      agentName: this.settings.qualityAgentName || null,
      outputFilePath,
      outputFileParser: parseTranslationQualityObservationOutput,
      degradedOutputFactory: (taskInput) => `WINDOW_DONE|${taskInput.windowId}`,
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
      outputTimeoutMs: options.outputTimeoutMs || this.settings.messageTimeoutMs || 300000,
    });
  }

  async runReferenceLocaleProjection(input, options = {}) {
    const outputFilePath = options.outputFilePath || "output/reference_locale_projection.txt";
    return this.runTask({
      jobId: input.jobId,
      stage: "reference_locale_projection",
      taskType: "reference_locale_projection",
      input,
      validator: (value) => value,
      agentName: this.settings.qualityAgentName || null,
      outputFilePath,
      outputFileParser: parseReferenceLocaleProjectionOutput,
      degradedOutputFactory: (taskInput) => `PROJECTION_DONE|${taskInput.projectionId}`,
      isCanceled: options.isCanceled || null,
    });
  }

  async runKnowledgeEnrichment(input) {
    const outputFilePath = "output/knowledge_result.txt";

    return this.runTask({
      jobId: input.jobId,
      stage: "knowledge_enrichment",
      taskType: "knowledge_enrichment",
      input,
      validator: validateKnowledgeEnrichmentResult,
      agentName: this.settings.knowledgeAgentName || null,
      outputFilePath,
      outputFileParser: parseKnowledgeEnrichmentOutput,
      degradedOutputFactory: () => "KNOWLEDGE_DONE",
    });
  }

  async runTranslationDeepAuditWindow(input, options = {}) {
    const outputFilePath = options.outputFilePath || `output/${input.windowId}_deep_audit.txt`;
    return this.runTask({
      jobId: input.jobId,
      stage: `translation_deep_audit_${input.windowId}`,
      taskType: "translation_deep_audit",
      input,
      validator: (value) => value,
      agentName: this.settings.qualityAgentName || null,
      outputFilePath,
      outputFileParser: parseDeepAuditWindowOutput,
      degradedOutputFactory: (taskInput) => `WINDOW_DONE|${taskInput.windowId}`,
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
    });
  }

  async runChapterObservation(input, options = {}) {
    if (collectObservationNodes(input).size === 0) {
      throw new Error("Chapter observation requires at least one valid text node.");
    }
    const outputFilePath = options.outputFilePath || "output/chapter_observation.txt";
    return this.runTask({
      jobId: input.jobId,
      stage: "chapter_observation",
      taskType: "chapter_observation",
      input,
      validator: validateChapterObservation,
      agentName: this.settings.chapterObserverAgentName || "chapter-observer",
      outputFilePath,
      outputFileParser: parseLineBasedChapterObservation,
      degradedOutputFactory: () => "OBSERVATION_DONE",
      conversationId: options.conversationId || null,
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
    });
  }

  async runBilingualEvidenceWindow(input, options = {}) {
    const outputFilePath = options.outputFilePath || "output/bilingual_evidence.txt";
    return this.runTask({
      jobId: input.jobId || input.windowId,
      stage: "bilingual_evidence_window",
      taskType: "bilingual_evidence_window",
      input,
      validator: validateBilingualEvidenceWindow,
      agentName: this.settings.bilingualEvidenceAgentName || "bilingual-evidence-builder",
      outputFilePath,
      outputFileParser: parseBilingualEvidenceWindow,
      degradedOutputFactory: (taskInput) => `WINDOW_DONE|${taskInput.windowId}`,
      conversationId: options.conversationId || null,
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
    });
  }

  async runReferenceDeepReview(input, options = {}) {
    if (collectObservationNodes(input).size === 0) {
      throw new Error("Reference deep review requires a bounded local node window.");
    }
    const outputFilePath = options.outputFilePath || "output/reference_deep_review.txt";
    return this.runTask({
      jobId: input.jobId,
      stage: "reference_deep_review",
      taskType: "reference_deep_review",
      input,
      validator: validateChapterObservation,
      agentName: this.settings.referenceDeepReviewerAgentName || "reference-deep-reviewer",
      outputFilePath,
      outputFileParser: parseLineBasedChapterObservation,
      degradedOutputFactory: () => "OBSERVATION_DONE",
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
    });
  }

  async runStoryContextUpdate(input, options = {}) {
    const outputFilePath = options.outputFilePath || "output/story_delta_result.txt";
    return this.runTask({
      jobId: input.jobId,
      stage: "story_context_update",
      taskType: "story_context_update",
      input,
      validator: validateStoryDeltaResult,
      agentName: this.settings.storyContextAgentName || "story-context-builder",
      outputFilePath,
      outputFileParser: parseLineBasedStoryDelta,
      degradedOutputFactory: () => "STORY_DELTA_DONE",
      conversationId: options.conversationId || null,
      isCanceled: options.isCanceled || null,
      onProgress: options.onProgress || null,
    });
  }
}

module.exports = {
  AOTaskRunner,
  buildStageRoot,
  buildTaskDispatchMessage,
  buildTaskRequest,
  buildTaskWorkspaceFiles,
  uniqueStringList,
  writeStageArtifacts,
};
