const fs = require("fs");
const path = require("path");
const { config, paths } = require("../../../config");
const { loadAoAssets } = require("../assets/ao_assets");
const { validateKnowledgeEnrichmentResult } = require("../contracts/ao_contracts");
const { parseLineBasedStoryDelta, validateStoryDeltaResult } = require("../contracts/story_delta_contract");
const {
  collectExpectedNodes: collectObservationNodes,
  parseLineBasedChapterObservation,
  validateChapterObservation,
} = require("../contracts/chapter_observation_contract");
const {
  parseBilingualEvidenceWindow,
  validateBilingualEvidenceWindow,
} = require("../contracts/bilingual_evidence_contract");
const { buildTaskDispatchMessage, buildTaskRequest } = require("./ao_prompt_templates");
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
  return path.join(paths.workspaceRoot, sanitizePathSegment(jobId, "adhoc"), sanitizePathSegment(stage, "stage"));
}

function buildConversationId(stage, jobId) {
  const base = `${stage}-${jobId || "adhoc"}`.replace(/[^a-zA-Z0-9:_-]/g, "_");
  return `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeRawStageOutput(stageRoot, rawOutput, exportPayload) {
  if (rawOutput === null || rawOutput === undefined) return null;
  const rawOutputPath = path.join(stageRoot, "artifacts", "raw_response.json");
  fs.writeFileSync(rawOutputPath, JSON.stringify(rawOutput, null, 2), "utf8");
  exportPayload.accepted.push({ file: "artifacts/raw_response.json", path: rawOutputPath });
  return rawOutputPath;
}

function writeStageResult(stageRoot, taskOutput, rejectedReason, exportPayload) {
  if (rejectedReason) {
    exportPayload.rejected.push({ file: "output/result.json", reason: rejectedReason });
    return null;
  }
  const resultPath = path.join(stageRoot, "output", "result.json");
  fs.writeFileSync(resultPath, JSON.stringify(taskOutput, null, 2), "utf8");
  exportPayload.accepted.push({ file: "output/result.json", path: resultPath });
  return resultPath;
}

function writeStageArtifacts(stageRoot, options) {
  const { taskType, taskInput, taskOutput, rawOutput = null, metadata = {}, rejectedReason = null } = options;
  ensureDir(path.join(stageRoot, "artifacts"));
  ensureDir(path.join(stageRoot, "output"));
  const taskInputPath = path.join(stageRoot, "artifacts", "task_input.json");
  fs.writeFileSync(taskInputPath, JSON.stringify(taskInput, null, 2), "utf8");
  const importManifestPath = path.join(stageRoot, "artifacts", "import_manifest.json");
  writeImportManifest(importManifestPath, taskType, taskInput, taskInputPath);
  const exportManifestPath = path.join(stageRoot, "artifacts", "export_manifest.json");
  const exportPayload = createExportPayload(taskType, metadata);
  const rawOutputPath = writeRawStageOutput(stageRoot, rawOutput, exportPayload);
  const resultPath = writeStageResult(stageRoot, taskOutput, rejectedReason, exportPayload);
  fs.writeFileSync(exportManifestPath, JSON.stringify(exportPayload, null, 2), "utf8");
  return {
    taskInputPath,
    importManifestPath,
    exportManifestPath,
    rawOutputPath,
    resultPath,
  };
}

function writeImportManifest(importManifestPath, taskType, taskInput, taskInputPath) {
  fs.writeFileSync(
    importManifestPath,
    JSON.stringify(
      {
        metadata: { stage: taskType, createdAt: new Date().toISOString() },
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
      2,
    ),
    "utf8",
  );
}

function createExportPayload(taskType, metadata) {
  return {
    metadata: {
      stage: taskType,
      createdAt: new Date().toISOString(),
      ...metadata,
    },
    accepted: [],
    rejected: [],
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
    ].join(" "),
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

function createOutputWaitState(settings, conversationId, outputFilePath, options) {
  const modelSilenceTimeoutMs = options.modelSilenceTimeoutMs ?? settings.modelSilenceTimeoutMs ?? null;
  return {
    startedAt: Date.now(),
    lastHeartbeatAt: 0,
    lastError: null,
    lastSessionCheckAt: 0,
    completion: { settled: false, rejected: false, value: null, error: null, settledAt: 0 },
    timeoutMs: options.timeoutMs ?? settings.messageTimeoutMs ?? 300000,
    pollIntervalMs: options.pollIntervalMs ?? 1500,
    isCanceled: options.isCanceled ?? null,
    onProgress: options.onProgress ?? null,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10000,
    completionPromise: options.completionPromise ?? null,
    completionGraceMs: options.completionGraceMs ?? 500,
    modelSilenceTimeoutMs,
    sessionCheckIntervalMs:
      options.sessionCheckIntervalMs ?? Math.min(10000, Math.max(1, modelSilenceTimeoutMs || 10000)),
    conversationId,
    outputFilePath,
  };
}

function repairProgressHandler(onProgress) {
  return typeof onProgress === "function"
    ? (progress) => onProgress({ ...progress, activity: "repairing_ao_output" })
    : null;
}

function successfulStageArtifacts(context) {
  const { params, activeConversationId, payload, outputFileContent, repairAttempted,
    degradedOutputError, promptBytes, inputBytes, startedAt } = context;
  return {
    taskType: params.taskType,
    taskInput: params.input,
    taskOutput: payload,
    rawOutput: {
      file: { path: params.outputFilePath, content: outputFileContent },
      validation: degradedOutputError ? "degraded" : "passed",
      repairAttempted,
      degradedFromError: degradedOutputError?.message || null,
    },
    metadata: {
      conversationId: activeConversationId,
      normalizedBy: repairAttempted ? "output_file_repair" : "output_file",
      semanticOutcome: degradedOutputError ? "partial" : "validated",
      promptBytes, inputBytes,
      outputBytes: Buffer.byteLength(outputFileContent, "utf8"),
      elapsedMs: Date.now() - startedAt,
    },
  };
}

function failedStageArtifacts(context, error) {
  const { params, activeConversationId, outputFileContent, repairAttempted,
    promptBytes, inputBytes, startedAt } = context;
  const rawOutput = outputFileContent == null ? null : {
    file: { path: params.outputFilePath, content: outputFileContent },
    validation: "failed",
    repairAttempted,
  };
  return {
    taskType: params.taskType, taskInput: params.input, taskOutput: null, rawOutput,
    metadata: {
      conversationId: activeConversationId, promptBytes, inputBytes,
      outputBytes: outputFileContent == null ? 0 : Buffer.byteLength(outputFileContent, "utf8"),
      elapsedMs: Date.now() - startedAt,
    },
    rejectedReason: error.message,
  };
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
    await this.writeConversationAssets(created.id, assets);
    await this.writeWorkspaceFiles(created.id, workspaceFiles);
    await this.client.startConversation(created.id);
    await this.client.waitUntilReady(created.id, {
      readyPollIntervalMs: this.settings.readyPollIntervalMs,
      readyTimeoutMs: this.settings.readyTimeoutMs,
    });
    return created.id;
  }

  async writeConversationAssets(conversationId, assets) {
    await this.client.writeConfig(conversationId, assets.opencodeConfig);
    if (assets.agentsMd) await this.client.writeAgentsMd(conversationId, assets.agentsMd);
    for (const agentFile of assets.agentFiles) {
      await this.client.writeAgentFile(conversationId, agentFile.name, agentFile.content);
    }
    for (const docFile of assets.docFiles || []) {
      await this.client.writeFile(conversationId, `.opencode/docs/${docFile.path}`, docFile.content);
    }
    for (const skill of assets.skillArchives) {
      await this.client.uploadSkillZip(conversationId, skill.name, skill.zipBuffer);
    }
  }

  async writeWorkspaceFiles(conversationId, workspaceFiles) {
    for (const file of workspaceFiles) {
      await this.client.writeFile(conversationId, file.path, file.content);
      const roundTripFile = await this.client.readFile(conversationId, file.path);
      const actualContent = roundTripFile && typeof roundTripFile.content === "string" ? roundTripFile.content : "";
      if (normalizeAoFileContent(actualContent) !== normalizeAoFileContent(file.content)) {
        throw buildAoFileMismatchError(file.path, file.content, actualContent);
      }
    }
  }

  async createTaskSession(jobId, stage = "reference_ingestion") {
    return this.initializeConversation(buildConversationId(stage, jobId));
  }

  async closeTaskSession(conversationId) {
    if (conversationId) {
      await this.client.deleteConversation(conversationId).catch(() => {});
    }
  }

  async waitForOutputFile(conversationId, outputFilePath, options = {}) {
    const state = createOutputWaitState(this.settings, conversationId, outputFilePath, options);
    this.attachCompletionPromise(state, state.completionPromise);
    while (Date.now() - state.startedAt < state.timeoutMs) {
      const content = await this.runWaitIteration(state);
      if (content !== null) return content;
    }
    const timeoutError = new Error(`AO did not produce ${outputFilePath} within ${state.timeoutMs}ms.`);
    timeoutError.code = "AO_OUTPUT_TIMEOUT";
    timeoutError.cause = state.lastError;
    throw timeoutError;
  }

  attachCompletionPromise(state, completionPromise) {
    if (!completionPromise) return;
    Promise.resolve(completionPromise).then(
      (value) => {
        Object.assign(state.completion, {
          settled: true,
          value,
          settledAt: Date.now(),
        });
      },
      (error) => {
        Object.assign(state.completion, {
          settled: true,
          rejected: true,
          error,
          settledAt: Date.now(),
        });
      },
    );
  }

  async runWaitIteration(state) {
    if (typeof state.isCanceled === "function" && state.isCanceled()) {
      throw new Error("AO task canceled by user.");
    }
    try {
      const file = await this.client.readFile(state.conversationId, state.outputFilePath);
      if (file && typeof file.content === "string" && file.content.trim().length > 0) {
        return file.content;
      }
    } catch (error) {
      state.lastError = error;
    }
    if (state.completion.rejected) {
      const messageError = new Error(
        `AO message failed before producing ${state.outputFilePath}: ${state.completion.error?.message || state.completion.error}`,
      );
      messageError.code = "AO_MESSAGE_FAILED";
      messageError.cause = state.completion.error;
      throw messageError;
    }
    if (state.completion.settled && Date.now() - state.completion.settledAt >= state.completionGraceMs) {
      const missingError = new Error(`AO completed without writing ${state.outputFilePath}.`);
      missingError.code = "AO_OUTPUT_MISSING";
      missingError.messageResponse = state.completion.value;
      missingError.cause = state.lastError;
      throw missingError;
    }
    await this.handleWaitConversation(state);
    return null;
  }

  async handleWaitConversation(state) {
    const conversation = await this.client.getConversation(state.conversationId);
    if (conversation.status !== "running") {
      throw new Error(
        `AO conversation ${state.conversationId} stopped before producing ${state.outputFilePath} (status=${conversation.status || "unknown"}, needsRestart=${conversation.needsRestart === true}).`,
      );
    }
    const now = Date.now();
    await this.checkWaitSessionSilence(state, conversation, now);
    this.emitWaitHeartbeat(state, conversation, now);
    const remainingMs = state.timeoutMs - (Date.now() - state.startedAt);
    const completionWaitMs = state.completion.settled
      ? Math.max(1, state.completionGraceMs - (Date.now() - state.completion.settledAt))
      : state.pollIntervalMs;
    if (remainingMs > 0) await sleep(Math.min(state.pollIntervalMs, completionWaitMs, remainingMs));
  }

  async checkWaitSessionSilence(state, conversation, now) {
    if (typeof this.client.listSessionMessages !== "function" || !conversation.sessionId) return;
    if (now - state.lastSessionCheckAt < state.sessionCheckIntervalMs) return;
    state.lastSessionCheckAt = now;
    try {
      const messagePayload = await this.client.listSessionMessages(state.conversationId, conversation.sessionId);
      const messages = Array.isArray(messagePayload) ? messagePayload : messagePayload?.messages || [];
      const assistant = [...messages].reverse().find((entry) => entry?.info?.role === "assistant");
      const tokens = assistant?.info?.tokens || {};
      const tokenCount = Number(tokens.input || 0) + Number(tokens.output || 0) + Number(tokens.reasoning || 0);
      const hasParts = Array.isArray(assistant?.parts) && assistant.parts.length > 0;
      if (
        state.modelSilenceTimeoutMs > 0 &&
        assistant &&
        !hasParts &&
        tokenCount === 0 &&
        now - state.startedAt >= state.modelSilenceTimeoutMs
      ) {
        const silenceError = new Error(
          `AO model produced no tokens or message parts for ${state.modelSilenceTimeoutMs}ms (conversation=${state.conversationId}, session=${conversation.sessionId}).`,
        );
        silenceError.code = "AO_MODEL_NO_OUTPUT";
        throw silenceError;
      }
    } catch (error) {
      if (error?.code === "AO_MODEL_NO_OUTPUT") throw error;
    }
  }

  emitWaitHeartbeat(state, conversation, now) {
    if (typeof state.onProgress !== "function" || now - state.lastHeartbeatAt < state.heartbeatIntervalMs) return;
    state.lastHeartbeatAt = now;
    state.onProgress({
      activity: "waiting_ao_output",
      elapsedMs: now - state.startedAt,
      conversationStatus: conversation.status,
      ready: conversation.ready === true,
      needsRestart: conversation.needsRestart === true,
      outputFilePath: state.outputFilePath,
      heartbeatAt: new Date(now).toISOString(),
    });
  }

  async repairStrictOutputFile(options) {
    const { conversationId, taskType, outputFilePath, validationError, invalidContent, input,
      validator, outputFileParser, agentName, isCanceled, onProgress, outputTimeoutMs = null } = options;
    const invalidFilePath = `${outputFilePath}.invalid`;
    await this.client.writeFile(conversationId, invalidFilePath, invalidContent || "");
    await this.client.writeFile(conversationId, outputFilePath, "");
    const repairPrompt = this.buildRepairPrompt(taskType, validationError, outputFilePath, invalidFilePath);
    const repairMessagePromise = this.client.sendMessage(conversationId, {
      text: repairPrompt, model: this.settings.model || null, agent: agentName || this.settings.agentName || null,
    });
    repairMessagePromise.catch(() => {});
    const repairedContent = await this.waitForOutputFile(conversationId, outputFilePath, {
      timeoutMs: outputTimeoutMs || this.settings.messageTimeoutMs || 300000,
      isCanceled,
      onProgress: repairProgressHandler(onProgress),
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
    return { payload, content: repairedContent };
  }

  buildRepairPrompt(taskType, validationError, outputFilePath, invalidFilePath) {
    return [
      `Repair the invalid output file for AO task: ${taskType}.`,
      `Validation error: ${validationError.message}`,
      `Read input/task_request.json, input/task_input.json, and ${invalidFilePath}.`,
      `Overwrite ${outputFilePath} with one complete contract-valid result.`,
      "Do not repeat the result or explain the repair in the message reply.",
      "After writing the corrected file, reply with only: DONE",
    ].join("\n");
  }

  async runTask(params) {
    if (!params.taskType) throw new Error("AO file task requires a canonical taskType.");
    if (!params.outputFilePath || typeof params.outputFileParser !== "function") {
      throw new Error("AO task " + params.taskType + " requires outputFilePath and outputFileParser.");
    }
    const context = this.createTaskContext(params);
    try {
      await this.initializeTaskConversation(context);
      await this.executeTaskAttempt(context);
      return this.finishTaskSuccess(context);
    } catch (error) {
      await this.finishTaskFailure(context, error);
    } finally {
      await this.cleanupTaskConversation(context);
    }
  }

  createTaskContext(params) {
    const requestedConversationId = params.conversationId || buildConversationId(params.stage, params.jobId);
    const stageRoot = buildStageRoot(params.jobId, params.stage);
    const taskRequest = buildTaskRequest(params.taskType, params.input, { outputFilePath: params.outputFilePath });
    const dispatchMessage = buildTaskDispatchMessage(taskRequest);
    const promptBytes = Buffer.byteLength(dispatchMessage, "utf8");
    const inputBytes = Buffer.byteLength(JSON.stringify(params.input), "utf8");
    const startedAt = Date.now();
    const workspaceFiles = buildTaskWorkspaceFiles(taskRequest, params.input);
    const ownsConversation = !params.conversationId;
    ensureDir(stageRoot);
    return {
      params,
      requestedConversationId,
      stageRoot,
      taskRequest,
      dispatchMessage,
      promptBytes,
      inputBytes,
      startedAt,
      workspaceFiles,
      ownsConversation,
      activeConversationId: null,
      outputFileContent: null,
      repairAttempted: false,
      degradedOutputError: null,
      payload: null,
    };
  }

  async initializeTaskConversation(context) {
    const { params, ownsConversation, requestedConversationId, workspaceFiles } = context;
    context.activeConversationId = ownsConversation
      ? await this.initializeConversation(requestedConversationId, workspaceFiles)
      : requestedConversationId;
    if (typeof params.isCanceled === "function" && params.isCanceled()) {
      throw new Error("AO task canceled by user.");
    }
    if (!ownsConversation) await this.writeTaskWorkspaceFiles(context);
    await this.client.writeFile(context.activeConversationId, params.outputFilePath, "");
  }

  async writeTaskWorkspaceFiles(context) {
    for (const file of context.workspaceFiles) {
      await this.client.writeFile(context.activeConversationId, file.path, file.content);
      const roundTripFile = await this.client.readFile(context.activeConversationId, file.path);
      const actualContent = roundTripFile && typeof roundTripFile.content === "string" ? roundTripFile.content : "";
      if (normalizeAoFileContent(actualContent) !== normalizeAoFileContent(file.content)) {
        throw buildAoFileMismatchError(file.path, file.content, actualContent);
      }
    }
  }

  async executeTaskAttempt(context) {
    const { params } = context;
    const messagePromise = this.client.sendMessage(context.activeConversationId, {
      text: context.dispatchMessage,
      model: this.settings.model || null,
      agent: params.agentName || this.settings.agentName || null,
    });
    messagePromise.catch(() => {});
    await this.waitForTaskOutput(context, messagePromise);
    await this.validateOrRepairTaskOutput(context);
    if (!context.repairAttempted && typeof this.client.abortSession === "function") {
      await this.client.abortSession(context.activeConversationId).catch(() => {});
    }
  }

  async waitForTaskOutput(context, messagePromise) {
    const { params } = context;
    try {
      context.outputFileContent = await this.waitForOutputFile(context.activeConversationId, params.outputFilePath, {
        timeoutMs: params.outputTimeoutMs || this.settings.messageTimeoutMs || 300000,
        isCanceled: params.isCanceled,
        onProgress: params.onProgress,
        completionPromise: messagePromise,
      });
    } catch (error) {
      if (typeof params.degradedOutputFactory !== "function" || !isDegradableOutputError(error)) throw error;
      context.degradedOutputError = error;
      context.outputFileContent = params.degradedOutputFactory(params.input, error);
    }
  }

  async validateOrRepairTaskOutput(context) {
    const { params } = context;
    try {
      context.payload = params.validator(params.outputFileParser(context.outputFileContent, params.input));
    } catch (validationError) {
      context.repairAttempted = true;
      if (typeof this.client.abortSession === "function") {
        await this.client.abortSession(context.activeConversationId).catch(() => {});
      }
      await this.attemptTaskRepair(context, validationError);
    }
  }

  async attemptTaskRepair(context, validationError) {
    const { params } = context;
    try {
      const repaired = await this.repairStrictOutputFile({
        conversationId: context.activeConversationId,
        taskType: params.taskType,
        outputFilePath: params.outputFilePath,
        validationError,
        invalidContent: context.outputFileContent,
        input: params.input,
        validator: params.validator,
        outputFileParser: params.outputFileParser,
        agentName: params.agentName,
        isCanceled: params.isCanceled,
        onProgress: params.onProgress,
        outputTimeoutMs: params.outputTimeoutMs,
      });
      context.payload = repaired.payload;
      context.outputFileContent = repaired.content;
    } catch (repairError) {
      if (typeof params.degradedOutputFactory !== "function" || !isDegradableOutputError(repairError))
        throw repairError;
      context.degradedOutputError = repairError;
      context.outputFileContent = params.degradedOutputFactory(params.input, repairError);
      context.payload = params.validator(params.outputFileParser(context.outputFileContent, params.input));
    }
  }

  finishTaskSuccess(context) {
    writeStageArtifacts(context.stageRoot, successfulStageArtifacts(context));
    return { ...context.payload, stageRoot: context.stageRoot, conversationId: context.activeConversationId };
  }

  async finishTaskFailure(context, error) {
    if (context.activeConversationId && typeof this.client.abortSession === "function") {
      await this.client.abortSession(context.activeConversationId).catch(() => {});
    }
    writeStageArtifacts(context.stageRoot, failedStageArtifacts(context, error));
    throw error;
  }

  async cleanupTaskConversation(context) {
    const { activeConversationId, ownsConversation } = context;
    if (activeConversationId && ownsConversation) {
      await this.client.deleteConversation(activeConversationId).catch(() => {});
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
