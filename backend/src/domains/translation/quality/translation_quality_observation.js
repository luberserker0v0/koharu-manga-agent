const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { paths } = require("../../../config");
const { writeJsonAtomic } = require("../../../infrastructure/filesystem/json_file");
const { isRetryableAoError } = require("../../../integrations/ao/errors/ao_error_classifier");
const { mergeSemanticResults } = require("../../../integrations/ao/contracts/semantic_result");

const SCHEMA_VERSION = 1;
const DEFAULT_WINDOW_SIZE = 50;
const MIN_SPLIT_WINDOW_SIZE = 8;

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function contractHash() {
  return fingerprint([
    fs.readFileSync(path.join(__dirname, "..", "..", "..", "integrations", "ao", "contracts", "translation_quality_observation_contract.js"), "utf8"),
    fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "ao", "agents", "translation-quality-observer.md"), "utf8"),
    fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "ao", "skills", "translation-quality-observation-contract", "SKILL.md"), "utf8"),
  ]);
}

function compactMemory(translationMemory) {
  const story = translationMemory?.effective?.story || null;
  const style = translationMemory?.effective?.style || null;
  return {
    glossary: (translationMemory?.effective?.glossary || []).slice(0, 40).map((entry) => ({
      sourceTerm: entry.source_term || entry.term,
      targetRendering: entry.canonical_translation || entry.translation,
      locked: entry.locked === true,
    })),
    story: story ? {
      globalSummary: story.global?.summary || null,
      chapterSummary: story.chapter?.summary || null,
      events: [...(story.chapter?.events || []), ...(story.global?.events || [])].slice(0, 6),
    } : null,
    style: style ? {
      profile: style.profile || {},
      examples: (style.chapters || []).slice(0, 3).map((chapter) => ({
        dialogue: (chapter.dialogueSamples || []).slice(0, 1),
        narration: (chapter.narrationSamples || []).slice(0, 1),
        monologue: (chapter.monologueSamples || []).slice(0, 1),
      })),
    } : null,
  };
}

function buildObservationPlan({ translations, translationMemory, model, sourceLanguage, targetLanguage, windowSize = DEFAULT_WINDOW_SIZE }) {
  const nodes = (translations || []).map((entry, index) => ({
    nodeId: entry.id || entry.nodeId,
    pageId: entry.pageId || null,
    pageName: entry.pageName || null,
    source: entry.original || "",
    target: entry.translation || "",
    readingOrder: index,
  })).filter((entry) => entry.nodeId && entry.source);
  const snapshotFingerprint = fingerprint(nodes.map((entry) => [entry.nodeId, entry.source, entry.target]));
  const observerContractHash = contractHash();
  const planHash = fingerprint({ snapshotFingerprint, observerContractHash, model, sourceLanguage, targetLanguage, windowSize });
  const windows = [];
  const pageGroups = [];
  for (const node of nodes) {
    const currentPage = pageGroups[pageGroups.length - 1];
    if (!currentPage || currentPage.pageName !== node.pageName) pageGroups.push({ pageName: node.pageName, nodes: [node] });
    else currentPage.nodes.push(node);
  }
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
    if (pending.length > 0 && pending.length + group.nodes.length > windowSize) flush();
    pending.push(...group.nodes);
  }
  flush();
  return {
    schemaVersion: SCHEMA_VERSION,
    planHash,
    snapshotFingerprint,
    observerContractHash,
    model: model || null,
    sourceLanguage: sourceLanguage || null,
    targetLanguage: targetLanguage || null,
    nodeCount: nodes.length,
    windowSize,
    windows,
  };
}

function loadReusableCheckpoints(checkpointPaths, plan) {
  const reusable = new Map();
  for (const checkpointPath of checkpointPaths || []) {
    try {
      const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
      const resultNodes = Array.isArray(checkpoint.result?.nodes) ? checkpoint.result.nodes : [];
      const coverage = checkpoint.result?.semanticResult?.coverage || null;
      const isComplete =
        checkpoint.outcome !== "partial" &&
        checkpoint.result?.semanticResult?.outcome !== "partial" &&
        resultNodes.length > 0 &&
        resultNodes.every((node) => node?.disposition !== "unobserved") &&
        (!coverage || coverage.expected === coverage.observed);
      if (checkpoint.planHash === plan.planHash && checkpoint.result?.windowId && isComplete) {
        reusable.set(checkpoint.result.windowId, { checkpointPath, checkpoint });
      }
    } catch {
      // Missing and incompatible checkpoints are ignored.
    }
  }
  return reusable;
}

function isTransientFailure(error) {
  return isRetryableAoError(error);
}

function isTimeoutFailure(error) {
  return ["AO_OUTPUT_TIMEOUT", "AO_MODEL_NO_OUTPUT"].includes(error?.code) ||
    /did not produce .* within \d+ms|produced no tokens or message parts|timed? out|timeout/i.test(
      String(error?.message || error || "")
    );
}

function splitWindow(window) {
  const midpoint = Math.ceil(window.nodes.length / 2);
  return [window.nodes.slice(0, midpoint), window.nodes.slice(midpoint)].map((nodes, index) => ({
    ...window,
    windowId: `${window.windowId}_${index === 0 ? "a" : "b"}`,
    startIndex: nodes[0].readingOrder,
    endIndex: nodes[nodes.length - 1].readingOrder,
    nodes,
  }));
}

function buildUnobservedWindowResult(window, error) {
  const reason = `AO returned no usable observation output: ${error.message}`;
  return {
    windowId: window.windowId,
    nodes: window.nodes.map((node) => ({
      nodeId: node.nodeId,
      pageId: node.pageId || null,
      pageName: node.pageName || null,
      disposition: "unobserved",
      riskTypes: [],
      confidence: 0,
      reason,
    })),
    sequenceRisks: [],
    semanticResult: {
      outcome: "partial",
      acceptedRecordCount: 0,
      quarantinedRecordCount: 1,
      quarantinedRecords: [{
        lineNumber: null,
        raw: null,
        kind: "OUTPUT_FILE",
        reason: error.message,
      }],
      warnings: [reason],
      coverage: { expected: window.nodes.length, observed: 0 },
      stage: "translation_quality_observation",
    },
  };
}

function isDegradableOutputFailure(error) {
  return ["AO_OUTPUT_MISSING", "AO_OUTPUT_INCOMPLETE"].includes(error?.code);
}

async function runTranslationQualityObservation({
  aoTaskRunner,
  translations,
  translationMemory,
  jobId,
  sourceLanguage,
  targetLanguage,
  reusableCheckpointPaths = [],
  isCanceled = null,
  onProgress = null,
}) {
  if (!aoTaskRunner?.runTranslationQualityObservationWindow) {
    throw new Error("Translation Quality Observer is not configured.");
  }
  const model = aoTaskRunner.settings?.model || null;
  const plan = buildObservationPlan({ translations, translationMemory, model, sourceLanguage, targetLanguage });
  const workspace = path.join(paths.workspaceRoot, jobId || `quality_observation_${Date.now()}`, "translation_quality_observation");
  const planPath = path.join(workspace, "plan.json");
  writeJsonAtomic(planPath, plan);
  const reusable = loadReusableCheckpoints(reusableCheckpointPaths, plan);
  const checkpointPaths = [];
  const results = [];

  const processWindow = async (window, index, depth = 0) => {
    if (isCanceled?.()) throw new Error("Job canceled by user.");
    const cached = reusable.get(window.windowId);
    if (cached) {
      results.push(cached.checkpoint.result);
      checkpointPaths.push(cached.checkpointPath);
      onProgress?.("quality_observation.window_reused", {
        windowId: window.windowId, current: index + 1, total: plan.windows.length,
        checkpointPath: cached.checkpointPath,
      });
      return;
    }
    const childPrefix = `${window.windowId}_`;
    const hasReusableChild = [...reusable.keys()].some((windowId) => windowId.startsWith(childPrefix));
    if (hasReusableChild && window.nodes.length > MIN_SPLIT_WINDOW_SIZE) {
      const children = splitWindow(window);
      onProgress?.("quality_observation.window_split_reused", {
        windowId: window.windowId,
        childWindowIds: children.map((child) => child.windowId),
        current: index + 1,
        total: plan.windows.length,
        reason: "reusing_child_checkpoints",
      });
      for (const child of children) await processWindow(child, index, depth + 1);
      return;
    }
    onProgress?.("quality_observation.window_started", {
      windowId: window.windowId, current: index + 1, total: plan.windows.length, nodeCount: window.nodes.length,
    });
    let result;
    let attemptCount = 0;
    const startedAt = Date.now();
    while (attemptCount < 2) {
      attemptCount += 1;
      try {
        result = await aoTaskRunner.runTranslationQualityObservationWindow({
          jobId: attemptCount === 1 ? jobId : `${jobId}_observer_retry_${attemptCount}`,
          windowId: window.windowId,
          snapshotFingerprint: plan.snapshotFingerprint,
          sourceLanguage,
          targetLanguage,
          nodes: window.nodes,
          compactMemory: compactMemory(translationMemory),
        }, { isCanceled });
        break;
      } catch (error) {
        if (isDegradableOutputFailure(error)) {
          result = buildUnobservedWindowResult(window, error);
          onProgress?.("quality_observation.window_degraded", {
            windowId: window.windowId,
            current: index + 1,
            total: plan.windows.length,
            nodeCount: window.nodes.length,
            reason: error.message,
            outcome: "partial",
          });
          break;
        }
        if (isTimeoutFailure(error) && window.nodes.length > MIN_SPLIT_WINDOW_SIZE) {
          const children = splitWindow(window);
          onProgress?.("quality_observation.window_split", {
            windowId: window.windowId,
            childWindowIds: children.map((child) => child.windowId),
            childNodeCounts: children.map((child) => child.nodes.length),
            current: index + 1,
            total: plan.windows.length,
            reason: error.message,
          });
          for (const child of children) await processWindow(child, index, depth + 1);
          return;
        }
        if (attemptCount >= 2 || !isTransientFailure(error)) throw error;
        onProgress?.("quality_observation.window_retrying", {
          windowId: window.windowId, current: index + 1, total: plan.windows.length,
          attempt: attemptCount + 1, reason: error.message,
        });
      }
    }
    const checkpoint = {
      schemaVersion: SCHEMA_VERSION,
      planHash: plan.planHash,
      windowId: window.windowId,
      attemptCount,
      elapsedMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
      outcome: result?.semanticResult?.outcome || "clean",
      acceptedRecordCount: result?.semanticResult?.acceptedRecordCount || 0,
      quarantinedRecordCount: result?.semanticResult?.quarantinedRecordCount || 0,
      result,
    };
    const checkpointPath = path.join(workspace, "checkpoints", `${window.windowId}.json`);
    writeJsonAtomic(checkpointPath, checkpoint);
    checkpointPaths.push(checkpointPath);
    results.push(result);
    onProgress?.("quality_observation.window_completed", {
      windowId: window.windowId, current: index + 1, total: plan.windows.length,
      nodeCount: window.nodes.length, elapsedMs: checkpoint.elapsedMs, checkpointPath,
    });
  };

  for (let index = 0; index < plan.windows.length; index += 1) {
    await processWindow(plan.windows[index], index);
  }

  const nodes = results.flatMap((entry) => entry.nodes || []);
  if (nodes.length !== plan.nodeCount || new Set(nodes.map((entry) => entry.nodeId)).size !== plan.nodeCount) {
    throw new Error("Translation Quality Observation does not cover every chapter node exactly once.");
  }
  const observation = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    planHash: plan.planHash,
    snapshotFingerprint: plan.snapshotFingerprint,
    observerContractHash: plan.observerContractHash,
    model,
    coverage: {
      observed: nodes.filter((entry) => entry.disposition !== "unobserved").length,
      unobserved: nodes.filter((entry) => entry.disposition === "unobserved").length,
      total: plan.nodeCount,
      ratio: plan.nodeCount
        ? nodes.filter((entry) => entry.disposition !== "unobserved").length / plan.nodeCount
        : 1,
    },
    nodes,
    sequenceRisks: results.flatMap((entry) => entry.sequenceRisks || []),
    summary: {
      clean: nodes.filter((entry) => entry.disposition === "clean").length,
      suspect: nodes.filter((entry) => entry.disposition === "suspect").length,
      unobserved: nodes.filter((entry) => entry.disposition === "unobserved").length,
      sequenceRisks: results.reduce((sum, entry) => sum + (entry.sequenceRisks || []).length, 0),
      windowCount: results.length,
      plannedWindowCount: plan.windows.length,
    },
    semanticResult: mergeSemanticResults(results.map((entry) => entry.semanticResult)),
  };
  observation.fingerprint = fingerprint({
    planHash: observation.planHash,
    snapshotFingerprint: observation.snapshotFingerprint,
    observerContractHash: observation.observerContractHash,
    model: observation.model,
    nodes: observation.nodes,
    sequenceRisks: observation.sequenceRisks,
  });
  const observationPath = path.join(workspace, "translation_quality_observation.json");
  writeJsonAtomic(observationPath, observation);
  return { observation, observationPath, planPath, checkpointPaths };
}

module.exports = {
  DEFAULT_WINDOW_SIZE,
  MIN_SPLIT_WINDOW_SIZE,
  buildObservationPlan,
  buildUnobservedWindowResult,
  runTranslationQualityObservation,
};
