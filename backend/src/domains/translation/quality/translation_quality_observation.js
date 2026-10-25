const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { paths } = require("../../../config");
const {
  writeJsonAtomic,
} = require("../../../infrastructure/filesystem/json_file");
const {
  isRetryableAoError,
} = require("../../../integrations/ao/errors/ao_error_classifier");
const {
  mergeSemanticResults,
} = require("../../../integrations/ao/contracts/semantic_result");

const SCHEMA_VERSION = 1;
const DEFAULT_WINDOW_SIZE = 50;
const MIN_SPLIT_WINDOW_SIZE = 8;

function fingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function qualityObservationContractPaths() {
  return [
    path.join(__dirname, "..", "..", "..", "integrations", "ao", "contracts", "translation_quality_observation_contract.js"),
    path.join(__dirname, "..", "..", "..", "..", "ao", "agents", "translation-quality-observer.md"),
    path.join(
      __dirname,
      "..", "..", "..", "..", "ao", "skills",
      "translation-quality-observation-contract", "SKILL.md",
    ),
  ];
}

function contractHash() {
  return fingerprint(qualityObservationContractPaths().map((filePath) => fs.readFileSync(filePath, "utf8")));
}

function compactObservationGlossary(translationMemory) {
  return (translationMemory?.effective?.glossary || []).slice(0, 40).map((entry) => ({
    sourceTerm: entry.source_term || entry.term,
    targetRendering: entry.canonical_translation || entry.translation,
    locked: entry.locked === true,
  }));
}

function compactObservationStory(story) {
  if (!story) return null;
  return {
    globalSummary: story.global?.summary || null,
    chapterSummary: story.chapter?.summary || null,
    events: [...(story.chapter?.events || []), ...(story.global?.events || [])].slice(0, 6),
  };
}

function compactObservationStyle(style) {
  if (!style) return null;
  return {
    profile: style.profile || {},
    examples: (style.chapters || []).slice(0, 3).map((chapter) => ({
      dialogue: (chapter.dialogueSamples || []).slice(0, 1),
      narration: (chapter.narrationSamples || []).slice(0, 1),
      monologue: (chapter.monologueSamples || []).slice(0, 1),
    })),
  };
}

function compactMemory(translationMemory) {
  return {
    glossary: compactObservationGlossary(translationMemory),
    story: compactObservationStory(translationMemory?.effective?.story),
    style: compactObservationStyle(translationMemory?.effective?.style),
  };
}

function observationPlanNodes(translations) {
  return (translations || [])
    .map((entry, index) => ({
      nodeId: entry.id || entry.nodeId,
      pageId: entry.pageId || null,
      pageName: entry.pageName || null,
      source: entry.original || "",
      target: entry.translation || "",
      readingOrder: index,
    }))
    .filter((entry) => entry.nodeId && entry.source);
}

function observationPlanIdentity(nodes, input, observerContractHash) {
  const snapshotFingerprint = fingerprint(nodes.map((entry) => [entry.nodeId, entry.source, entry.target]));
  const planHash = fingerprint({
    snapshotFingerprint,
    observerContractHash,
    model: input.model,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    windowSize: input.windowSize,
  });
  return { snapshotFingerprint, observerContractHash, planHash };
}

function buildObservationPlan(input) {
  const params = { windowSize: DEFAULT_WINDOW_SIZE, ...input };
  const { model, sourceLanguage, targetLanguage, windowSize } = params;
  const nodes = observationPlanNodes(params.translations);
  const observerContractHash = contractHash();
  const identity = observationPlanIdentity(nodes, params, observerContractHash);
  return {
    schemaVersion: SCHEMA_VERSION,
    ...identity,
    model: model || null,
    sourceLanguage: sourceLanguage || null,
    targetLanguage: targetLanguage || null,
    nodeCount: nodes.length,
    windowSize,
    windows: buildObservationWindows(buildObservationPageGroups(nodes), windowSize),
  };
}

function buildObservationPageGroups(nodes) {
  const pageGroups = [];
  for (const node of nodes) {
    const currentPage = pageGroups[pageGroups.length - 1];
    if (!currentPage || currentPage.pageName !== node.pageName)
      pageGroups.push({ pageName: node.pageName, nodes: [node] });
    else currentPage.nodes.push(node);
  }
  return pageGroups;
}

function buildObservationWindows(pageGroups, windowSize) {
  const windows = [];
  let pending = [];
  const flush = () => {
    if (pending.length === 0) return;
    windows.push({
      windowId: `quality_observation_${String(windows.length + 1).padStart(3, "0")}`,
      startIndex: pending[0].readingOrder,
      endIndex: pending[pending.length - 1].readingOrder,
      nodes: pending,
    });
    pending = [];
  };
  for (const group of pageGroups) {
    if (group.nodes.length > windowSize) {
      flush();
      for (let offset = 0; offset < group.nodes.length; offset += windowSize) {
        pending = group.nodes.slice(offset, offset + windowSize);
        flush();
      }
      continue;
    }
    if (pending.length > 0 && pending.length + group.nodes.length > windowSize)
      flush();
    pending.push(...group.nodes);
  }
  flush();
  return windows;
}

function isReusableCheckpoint(checkpoint, plan) {
  const resultNodes = Array.isArray(checkpoint.result?.nodes) ? checkpoint.result.nodes : [];
  const coverage = checkpoint.result?.semanticResult?.coverage || null;
  const isComplete =
    checkpoint.outcome !== "partial" &&
    checkpoint.result?.semanticResult?.outcome !== "partial" &&
    resultNodes.length > 0 &&
    resultNodes.every((node) => node?.disposition !== "unobserved") &&
    (!coverage || coverage.expected === coverage.observed);
  return checkpoint.planHash === plan.planHash && checkpoint.result?.windowId && isComplete;
}

function readReusableCheckpoint(checkpointPath, plan) {
  try {
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    return isReusableCheckpoint(checkpoint, plan) ? checkpoint : null;
  } catch {
    return null;
  }
}

function loadReusableCheckpoints(checkpointPaths, plan) {
  const reusable = new Map();
  for (const checkpointPath of checkpointPaths || []) {
    const checkpoint = readReusableCheckpoint(checkpointPath, plan);
    if (checkpoint) reusable.set(checkpoint.result.windowId, { checkpointPath, checkpoint });
  }
  return reusable;
}

function isTransientFailure(error) {
  return isRetryableAoError(error);
}

function isTimeoutFailure(error) {
  return (
    ["AO_OUTPUT_TIMEOUT", "AO_MODEL_NO_OUTPUT"].includes(error?.code) ||
    /did not produce .* within \d+ms|produced no tokens or message parts|timed? out|timeout/i.test(
      String(error?.message || error || ""),
    )
  );
}

function splitWindow(window) {
  const midpoint = Math.ceil(window.nodes.length / 2);
  return [window.nodes.slice(0, midpoint), window.nodes.slice(midpoint)].map(
    (nodes, index) => ({
      ...window,
      windowId: `${window.windowId}_${index === 0 ? "a" : "b"}`,
      startIndex: nodes[0].readingOrder,
      endIndex: nodes[nodes.length - 1].readingOrder,
      nodes,
    }),
  );
}

function buildUnobservedNodes(window, reason) {
  return window.nodes.map((node) => ({
    nodeId: node.nodeId,
    pageId: node.pageId || null,
    pageName: node.pageName || null,
    disposition: "unobserved",
    riskTypes: [],
    confidence: 0,
    reason,
  }));
}

function buildUnobservedSemanticResult(window, error, reason) {
  return {
    outcome: "partial",
    acceptedRecordCount: 0,
    quarantinedRecordCount: 1,
    quarantinedRecords: [{ lineNumber: null, raw: null, kind: "OUTPUT_FILE", reason: error.message }],
    warnings: [reason],
    coverage: { expected: window.nodes.length, observed: 0 },
    stage: "translation_quality_observation",
  };
}

function buildUnobservedWindowResult(window, error) {
  const reason = `AO returned no usable observation output: ${error.message}`;
  return {
    windowId: window.windowId,
    nodes: buildUnobservedNodes(window, reason),
    sequenceRisks: [],
    semanticResult: buildUnobservedSemanticResult(window, error, reason),
  };
}

function isDegradableOutputFailure(error) {
  return ["AO_OUTPUT_MISSING", "AO_OUTPUT_INCOMPLETE"].includes(error?.code);
}

function persistQualityObservation(plan, planPath, context) {
  const observation = buildQualityObservation({ plan, results: context.results, model: context.model });
  const observationPath = path.join(context.workspace, "translation_quality_observation.json");
  writeJsonAtomic(observationPath, observation);
  return { observation, observationPath, planPath, checkpointPaths: context.checkpointPaths };
}

async function runTranslationQualityObservation(input) {
  const params = { reusableCheckpointPaths: [], isCanceled: null, onProgress: null, ...(input || {}) };
  const { plan, planPath, context } = initializeObservationRun(params);
  const processWindow = async (window, index) =>
    processObservationWindow(context, window, index, processWindow);
  for (let index = 0; index < plan.windows.length; index += 1) {
    await processWindow(plan.windows[index], index);
  }
  return persistQualityObservation(plan, planPath, context);
}

function buildObservationRunContext(input, model, plan, workspace) {
  return {
    aoTaskRunner: input.aoTaskRunner,
    plan,
    workspace,
    reusable: loadReusableCheckpoints(input.reusableCheckpointPaths, plan),
    checkpointPaths: [],
    results: [],
    jobId: input.jobId,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    translationMemory: input.translationMemory,
    isCanceled: input.isCanceled,
    onProgress: input.onProgress,
    model,
  };
}

function initializeObservationRun(input) {
  if (!input.aoTaskRunner?.runTranslationQualityObservationWindow) {
    throw new Error("Translation Quality Observer is not configured.");
  }
  const model = input.aoTaskRunner.settings?.model || null;
  const plan = buildObservationPlan({
    translations: input.translations,
    model,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
  });
  const workspace = path.join(
    paths.workspaceRoot,
    input.jobId || `quality_observation_${Date.now()}`,
    "translation_quality_observation",
  );
  const planPath = path.join(workspace, "plan.json");
  writeJsonAtomic(planPath, plan);
  const context = buildObservationRunContext(input, model, plan, workspace);
  return { model, plan, planPath, context };
}

function handleCachedObservationWindow(context, window, index, cached) {
  context.results.push(cached.checkpoint.result);
  context.checkpointPaths.push(cached.checkpointPath);
  context.onProgress?.("quality_observation.window_reused", {
    windowId: window.windowId,
    current: index + 1,
    total: context.plan.windows.length,
    checkpointPath: cached.checkpointPath,
  });
}

async function processObservationWindow(context, window, index, processWindow) {
  if (context.isCanceled?.()) throw new Error("Job canceled by user.");
  const cached = context.reusable.get(window.windowId);
  if (cached) {
    handleCachedObservationWindow(context, window, index, cached);
    return;
  }
  const childPrefix = `${window.windowId}_`;
  const hasReusableChild = [...context.reusable.keys()].some((windowId) =>
    windowId.startsWith(childPrefix),
  );
  if (hasReusableChild && window.nodes.length > MIN_SPLIT_WINDOW_SIZE) {
    const children = splitWindow(window);
    context.onProgress?.("quality_observation.window_split_reused", {
      windowId: window.windowId,
      childWindowIds: children.map((child) => child.windowId),
      current: index + 1,
      total: context.plan.windows.length,
      reason: "reusing_child_checkpoints",
    });
    for (const child of children) await processWindow(child, index);
    return;
  }
  await processFreshObservationWindow(context, window, index, processWindow);
}

function reportObservationWindowStarted(context, window, index) {
  context.onProgress?.("quality_observation.window_started", {
    windowId: window.windowId,
    current: index + 1,
    total: context.plan.windows.length,
    nodeCount: window.nodes.length,
  });
}

function buildObservationCheckpoint(context, window, attempt) {
  const { result, attemptCount, startedAt } = attempt;
  return {
    schemaVersion: SCHEMA_VERSION,
    planHash: context.plan.planHash,
    windowId: window.windowId,
    attemptCount,
    elapsedMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
    outcome: result?.semanticResult?.outcome || "clean",
    acceptedRecordCount: result?.semanticResult?.acceptedRecordCount || 0,
    quarantinedRecordCount: result?.semanticResult?.quarantinedRecordCount || 0,
    result,
  };
}

function persistObservationCheckpoint(context, window, checkpoint) {
  const checkpointPath = path.join(
    context.workspace,
    "checkpoints",
    `${window.windowId}.json`,
  );
  writeJsonAtomic(checkpointPath, checkpoint);
  context.checkpointPaths.push(checkpointPath);
  context.results.push(checkpoint.result);
  return checkpointPath;
}

function reportObservationWindowCompleted(context, window, index, checkpoint, checkpointPath) {
  context.onProgress?.("quality_observation.window_completed", {
    windowId: window.windowId,
    current: index + 1,
    total: context.plan.windows.length,
    nodeCount: window.nodes.length,
    elapsedMs: checkpoint.elapsedMs,
    checkpointPath,
  });
}

async function processFreshObservationWindow(context, window, index, processWindow) {
  reportObservationWindowStarted(context, window, index);
  const attempt = await runObservationAttemptLoop(context, window, index, processWindow);
  if (attempt.split) return;
  const checkpoint = buildObservationCheckpoint(context, window, attempt);
  const checkpointPath = persistObservationCheckpoint(context, window, checkpoint);
  reportObservationWindowCompleted(context, window, index, checkpoint, checkpointPath);
}

async function runObservationAttemptLoop(
  context,
  window,
  index,
  processWindow,
) {
  let result;
  let attemptCount = 0;
  const startedAt = Date.now();
  while (attemptCount < 2) {
    attemptCount += 1;
    const attempt = await tryObservationWindowAttempt(
      context,
      window,
      index,
      attemptCount,
      processWindow,
    );
    if (attempt.split) return { split: true };
    if (attempt.result !== undefined) {
      result = attempt.result;
      break;
    }
    if (attempt.retry) continue;
  }
  return { result, attemptCount, startedAt, split: false };
}

async function tryObservationWindowAttempt(
  context,
  window,
  index,
  attemptCount,
  processWindow,
) {
  try {
    const result = await runObservationWindowCall(
      context,
      window,
      attemptCount,
    );
    return { result };
  } catch (error) {
    return handleObservationAttemptError(
      context,
      window,
      index,
      error,
      attemptCount,
      processWindow,
    );
  }
}

async function runObservationWindowCall(context, window, attemptCount) {
  return context.aoTaskRunner.runTranslationQualityObservationWindow(
    {
      jobId:
        attemptCount === 1
          ? context.jobId
          : `${context.jobId}_observer_retry_${attemptCount}`,
      windowId: window.windowId,
      snapshotFingerprint: context.plan.snapshotFingerprint,
      sourceLanguage: context.sourceLanguage,
      targetLanguage: context.targetLanguage,
      nodes: window.nodes,
      compactMemory: compactMemory(context.translationMemory),
    },
    { isCanceled: context.isCanceled },
  );
}

async function handleObservationAttemptError(
  context,
  window,
  index,
  error,
  attemptCount,
  processWindow,
) {
  if (isDegradableOutputFailure(error)) {
    const result = buildUnobservedWindowResult(window, error);
    reportObservationDegraded(context, window, index, error);
    return { result };
  }
  if (isTimeoutFailure(error) && window.nodes.length > MIN_SPLIT_WINDOW_SIZE) {
    await splitObservationWindow(context, window, index, error, processWindow);
    return { split: true };
  }
  if (attemptCount >= 2 || !isTransientFailure(error)) throw error;
  reportObservationRetry(context, window, index, error, attemptCount);
  return { retry: true };
}

function reportObservationDegraded(context, window, index, error) {
  context.onProgress?.("quality_observation.window_degraded", {
    windowId: window.windowId,
    current: index + 1,
    total: context.plan.windows.length,
    nodeCount: window.nodes.length,
    reason: error.message,
    outcome: "partial",
  });
}

function reportObservationRetry(context, window, index, error, attemptCount) {
  context.onProgress?.("quality_observation.window_retrying", {
    windowId: window.windowId,
    current: index + 1,
    total: context.plan.windows.length,
    attempt: attemptCount + 1,
    reason: error.message,
  });
}

async function splitObservationWindow(
  context,
  window,
  index,
  error,
  processWindow,
) {
  const children = splitWindow(window);
  context.onProgress?.("quality_observation.window_split", {
    windowId: window.windowId,
    childWindowIds: children.map((child) => child.windowId),
    childNodeCounts: children.map((child) => child.nodes.length),
    current: index + 1,
    total: context.plan.windows.length,
    reason: error.message,
  });
  for (const child of children) await processWindow(child, index);
}

function buildQualityObservation({ plan, results, model }) {
  const nodes = results.flatMap((entry) => entry.nodes || []);
  if (
    nodes.length !== plan.nodeCount ||
    new Set(nodes.map((entry) => entry.nodeId)).size !== plan.nodeCount
  ) {
    throw new Error(
      "Translation Quality Observation does not cover every chapter node exactly once.",
    );
  }
  const observation = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    planHash: plan.planHash,
    snapshotFingerprint: plan.snapshotFingerprint,
    observerContractHash: plan.observerContractHash,
    model,
    coverage: buildObservationCoverage(nodes, plan),
    nodes,
    sequenceRisks: results.flatMap((entry) => entry.sequenceRisks || []),
    summary: buildObservationSummary(nodes, results, plan),
    semanticResult: mergeSemanticResults(
      results.map((entry) => entry.semanticResult),
    ),
  };
  observation.fingerprint = fingerprint(
    buildObservationFingerprintInput(observation),
  );
  return observation;
}

function buildObservationCoverage(nodes, plan) {
  const observed = nodes.filter(
    (entry) => entry.disposition !== "unobserved",
  ).length;
  return {
    observed,
    unobserved: nodes.filter((entry) => entry.disposition === "unobserved")
      .length,
    total: plan.nodeCount,
    ratio: plan.nodeCount ? observed / plan.nodeCount : 1,
  };
}

function buildObservationSummary(nodes, results, plan) {
  return {
    clean: nodes.filter((entry) => entry.disposition === "clean").length,
    suspect: nodes.filter((entry) => entry.disposition === "suspect").length,
    unobserved: nodes.filter((entry) => entry.disposition === "unobserved")
      .length,
    sequenceRisks: results.reduce(
      (sum, entry) => sum + (entry.sequenceRisks || []).length,
      0,
    ),
    windowCount: results.length,
    plannedWindowCount: plan.windows.length,
  };
}

function buildObservationFingerprintInput(observation) {
  return {
    planHash: observation.planHash,
    snapshotFingerprint: observation.snapshotFingerprint,
    observerContractHash: observation.observerContractHash,
    model: observation.model,
    nodes: observation.nodes,
    sequenceRisks: observation.sequenceRisks,
  };
}

module.exports = {
  DEFAULT_WINDOW_SIZE,
  MIN_SPLIT_WINDOW_SIZE,
  buildObservationPlan,
  buildUnobservedWindowResult,
  runTranslationQualityObservation,
};
