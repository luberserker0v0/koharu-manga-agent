const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { paths } = require("../../../config");
const { writeJsonAtomic } = require("../../../infrastructure/filesystem/json_file");
const { buildQualityContextProjection, buildQualityWindowInput } = require("../quality/quality_projection");

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function contractHash() {
  return hash(
    [
      fs.readFileSync(
        path.join(__dirname, "..", "..", "..", "integrations", "ao", "contracts", "deep_audit_line_contract.js"),
        "utf8",
      ),
      fs.readFileSync(
        path.join(__dirname, "..", "..", "..", "..", "ao", "skills", "translation-deep-audit-contract", "SKILL.md"),
        "utf8",
      ),
      fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "ao", "agents", "quality-optimizer.md"), "utf8"),
    ].join("\n---\n"),
  );
}

class TranslationDeepAuditModule {
  constructor(aoTaskRunner) {
    this.aoTaskRunner = aoTaskRunner;
  }

  async run(payload, hooks) {
    const prepared = prepareAuditRun(payload, this.aoTaskRunner);
    const windowResult = await runAuditWindows(prepared, hooks, this.aoTaskRunner);
    const report = buildAuditReport(payload, prepared, windowResult);
    const reportPath = path.join(prepared.runRoot, "translation_deep_audit_report.json");
    writeJsonAtomic(reportPath, report);
    const deepAuditReviewPackagePath = path.join(prepared.runRoot, "deep_audit_review_package.json");
    const reviewPackage = buildDeepAuditReviewPackage(prepared.snapshot, report);
    writeJsonAtomic(deepAuditReviewPackagePath, reviewPackage);
    return { ...report, reportPath, deepAuditReviewPackagePath };
  }
}

function loadAuditInputs(payload) {
  const snapshotText = fs.readFileSync(payload.finalTranslationSnapshotPath, "utf8");
  const snapshot = JSON.parse(snapshotText);
  const memory = payload.translationMemorySnapshotPath
    ? JSON.parse(fs.readFileSync(payload.translationMemorySnapshotPath, "utf8"))
    : { fingerprint: snapshot.translationMemoryFingerprint, effective: {} };
  return { snapshotText, snapshot, memory };
}

function buildAuditIdentity(snapshotText, projection, aoTaskRunner) {
  const identity = {
    snapshotFingerprint: hash(snapshotText),
    auditContractHash: contractHash(),
    model: aoTaskRunner.settings?.model || null,
  };
  const planHash = hash(
    JSON.stringify({
      ...identity,
      projectionFingerprint: projection.fingerprint,
    }),
  );
  return { ...identity, planHash };
}

function prepareAuditRun(payload, aoTaskRunner) {
  const inputs = loadAuditInputs(payload);
  const projection = buildQualityContextProjection({
    translations: inputs.snapshot.translations,
    translationMemory: inputs.memory,
    includeAll: true,
    representativeLimit: 0,
  });
  const identity = buildAuditIdentity(inputs.snapshotText, projection, aoTaskRunner);
  return {
    payload,
    ...inputs,
    ...identity,
    projection,
    runRoot: path.join(paths.workspaceRoot, payload.sourceTranslationJobId, "deep_audit", identity.planHash),
  };
}

async function runAuditWindows(prepared, hooks, aoTaskRunner) {
  const results = [];
  let reusedWindows = 0;
  for (let index = 0; index < prepared.projection.windows.length; index += 1) {
    const window = prepared.projection.windows[index];
    const checkpointPath = path.join(prepared.runRoot, "checkpoints", `${window.windowId}.json`);
    const processed = await processAuditWindow({
      prepared,
      hooks,
      aoTaskRunner,
      index,
      window,
      checkpointPath,
    });
    results.push(processed.checkpoint.result);
    if (processed.reused) reusedWindows += 1;
    hooks.emit("deep_audit.window.completed", {
      completedWindows: index + 1,
      totalWindows: prepared.projection.windows.length,
      reusedWindows,
      reused: processed.reused,
      windowId: window.windowId,
      checkpointPath,
    });
  }
  return { results, reusedWindows };
}

function readAuditCheckpoint(checkpointPath, planHash) {
  if (!fs.existsSync(checkpointPath)) return null;
  const existing = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  return existing.planHash === planHash ? existing : null;
}

async function runAuditWindowTask(prepared, hooks, aoTaskRunner, window) {
  const input = {
    ...buildQualityWindowInput(prepared.projection, window),
    jobId: hooks.jobId,
    snapshotFingerprint: prepared.snapshotFingerprint,
  };
  const startedAt = Date.now();
  const result = await aoTaskRunner.runTranslationDeepAuditWindow(input, {
    isCanceled: hooks.isCanceled,
  });
  return { result, startedAt };
}

function buildAuditCheckpoint(prepared, window, result, startedAt) {
  return {
    schemaVersion: 1,
    snapshotFingerprint: prepared.snapshotFingerprint,
    projectionFingerprint: prepared.projection.fingerprint,
    auditContractHash: prepared.auditContractHash,
    model: prepared.model,
    planHash: prepared.planHash,
    windowId: window.windowId,
    inputBytes: window.inputBytes,
    elapsedMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
    result,
  };
}

async function processAuditWindow({ prepared, hooks, aoTaskRunner, index, window, checkpointPath }) {
  const existing = readAuditCheckpoint(checkpointPath, prepared.planHash);
  if (existing) return { checkpoint: existing, reused: true };
  hooks.setStage("running", `deep_audit_${index + 1}_of_${prepared.projection.windows.length}`);
  const { result, startedAt } = await runAuditWindowTask(prepared, hooks, aoTaskRunner, window);
  const checkpoint = buildAuditCheckpoint(prepared, window, result, startedAt);
  writeJsonAtomic(checkpointPath, checkpoint);
  return { checkpoint, reused: false };
}

function buildAuditReport(payload, prepared, windowResult) {
  return {
    schemaVersion: 1,
    sourceTranslationJobId: payload.sourceTranslationJobId,
    snapshotFingerprint: prepared.snapshotFingerprint,
    projectionFingerprint: prepared.projection.fingerprint,
    auditContractHash: prepared.auditContractHash,
    model: prepared.model,
    planHash: prepared.planHash,
    generatedAt: new Date().toISOString(),
    totalTranslations: prepared.snapshot.translations.length,
    windowCount: prepared.projection.windows.length,
    reusedWindows: windowResult.reusedWindows,
    findings: windowResult.results.flatMap((entry) => entry.findings || []),
    proposedTranslations: windowResult.results.flatMap((entry) => entry.proposals || []),
  };
}

function addDeepAuditReviewItem(pages, translation, finding, proposal) {
  const nodeId = translation.id || translation.nodeId;
  const pageName = translation.pageName || proposal?.pageName || "unknown";
  const page = pages.get(pageName) || {
    pageId: translation.pageId || null,
    pageName,
    items: [],
    sequenceRisks: [],
  };
  page.items.push({
    nodeId,
    original: translation.original,
    currentTranslation: translation.translation,
    proposedTranslation: proposal?.revisedTranslation || null,
    riskTypes: [finding?.type || proposal?.reasonType || "translation_accuracy"],
    confidence: finding?.confidence ?? proposal?.confidence ?? null,
    reason: finding?.message || proposal?.reason || null,
    bbox: translation.bbox || null,
    blocking: false,
    allowedDecisions: ["accept_proposal", "manual_edit", "confirm_current", "ignore_and_publish"],
  });
  pages.set(pageName, page);
}

function buildDeepAuditReviewPackage(snapshot, report) {
  const findingById = new Map(report.findings.map((entry) => [entry.nodeId, entry]));
  const proposalById = new Map(report.proposedTranslations.map((entry) => [entry.nodeId, entry]));
  const reviewNodeIds = new Set([...findingById.keys(), ...proposalById.keys()]);
  const pages = new Map();
  for (const translation of snapshot.translations || []) {
    const nodeId = translation.id || translation.nodeId;
    if (!reviewNodeIds.has(nodeId)) continue;
    addDeepAuditReviewItem(pages, translation, findingById.get(nodeId), proposalById.get(nodeId));
  }
  return {
    schemaVersion: 1,
    source: "translation_deep_audit",
    status: "awaiting_decisions",
    generatedAt: new Date().toISOString(),
    pages: [...pages.values()],
    summary: {
      blocking: 0,
      warnings: report.findings.length,
      pages: pages.size,
    },
  };
}

module.exports = { TranslationDeepAuditModule };
