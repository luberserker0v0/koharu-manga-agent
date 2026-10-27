const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { paths } = require("../../../config");
const {
  writeJsonAtomic,
} = require("../../../infrastructure/filesystem/json_file");
const {
  validateQualityValidationReport,
} = require("../../../integrations/ao/contracts/ao_contracts");
const {
  buildQualityContextProjection,
  buildQualityWindowInput,
  applyQualitySemanticAnnotations,
  completenessReasons,
} = require("./quality_projection");
const {
  runTranslationQualityObservation,
} = require("./translation_quality_observation");
const {
  isRetryableAoError,
} = require("../../../integrations/ao/errors/ao_error_classifier");
const {
  mergeSemanticResults,
} = require("../../../integrations/ao/contracts/semantic_result");
const { collectSceneTextRegionPages } = require("../../../integrations/koharu/scene/scene_text_regions");

const COMPLETENESS_REASON_TYPES = new Set([
  "translation_missing",
  "source_target_identity",
]);
const STRUCTURAL_BLOCKING_RISKS = new Set([
  "empty_translation",
  "sequence_shift",
  "locked_term_violation",
]);

function qualityContractHash() {
  const files = [
    path.join(__dirname, "..", "..", "..", "integrations", "ao", "contracts", "quality_line_contract.js"),
    path.join(__dirname, "..", "..", "..", "..", "ao", "agents", "quality-optimizer.md"),
    path.join(__dirname, "..", "..", "..", "..", "ao", "skills", "quality-line-contract", "SKILL.md"),
    path.join(__dirname, "..", "..", "..", "..", "ao", "skills", "quality-decision-framework", "SKILL.md"),
  ];
  return crypto
    .createHash("sha256")
    .update(files.map((file) => fs.readFileSync(file, "utf8")).join("\n---\n"))
    .digest("hex");
}

function qualitySemanticResult(results, hasUnresolvedQuality) {
  const merged = mergeSemanticResults(results);
  if (!hasUnresolvedQuality) return merged;
  return {
    ...merged,
    outcome: merged.outcome === "partial" ? "partial" : "warnings",
    warnings: [
      ...(merged.warnings || []),
      "Translation contains unresolved or unobserved nodes; those nodes are excluded from learning.",
    ],
  };
}

function qualityTranslation(page, region) {
  if (!region.sourceText) return null;
  const { x, y, width, height } = region.geometry;
  return {
    id: region.internalNodeId,
    pageId: page.internalPageId,
    pageName: page.pageName,
    original: region.sourceText,
    translation: region.translatedText,
    textRole: region.textRole,
    styleChannel: region.styleChannel,
    speakerRef: region.speakerRef,
    bbox: { x, y, width, height },
  };
}

function collectTranslations(scene) {
  const pages = collectSceneTextRegionPages(scene);
  const translations = pages.flatMap((page) =>
    page.regions.flatMap((region) => qualityTranslation(page, region) || []),
  );
  const pageList = pages.map((page) => ({ id: page.internalPageId, name: page.pageName }));
  return {
    translations,
    pages: pageList,
    totalTranslations: translations.length,
    totalPages: pageList.length,
  };
}

function normalizePreviewTranslations(translations) {
  return (Array.isArray(translations) ? translations : [])
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      const original = typeof entry.original === "string" ? entry.original : "";
      const translation =
        typeof entry.translation === "string"
          ? entry.translation
          : typeof entry.currentTranslation === "string"
            ? entry.currentTranslation
            : "";
      if (!original) return null;
      return {
        id:
          entry.nodeId ||
          entry.id ||
          `preview_${String(index + 1).padStart(4, "0")}`,
        pageId:
          entry.pageId || `preview_page_${String(index + 1).padStart(3, "0")}`,
        pageName:
          entry.pageName || `preview_${String(index + 1).padStart(3, "0")}.txt`,
        original,
        translation,
        textRole: entry.textRole || null,
        styleChannel: entry.styleChannel || null,
        speakerRef: entry.speakerRef || null,
      };
    })
    .filter(Boolean);
}

function applyProposalsToTranslations(translations, proposedTranslations) {
  const byId = new Map(
    (proposedTranslations || []).map((entry) => [entry.nodeId, entry]),
  );
  return (translations || []).map((entry) => {
    const proposal = byId.get(entry.id);
    return proposal?.revisedTranslation
      ? { ...entry, translation: proposal.revisedTranslation }
      : entry;
  });
}

function buildQualityPatchOps(translationsByNodeId, proposedTranslations) {
  return (proposedTranslations || []).flatMap((proposal) => {
    const current = translationsByNodeId.get(proposal.nodeId);
    if (!current || current.translation === proposal.revisedTranslation)
      return [];
    return [
      {
        updateNode: {
          page: current.pageId,
          id: current.id,
          patch: {
            data: { text: { translation: proposal.revisedTranslation } },
          },
        },
      },
    ];
  });
}

function uniqueStrings(values) {
  return [
    ...new Set(values.filter((value) => typeof value === "string" && value)),
  ];
}

function collectQualityReportParts(results) {
  const issues = results.flatMap((entry) => entry.issues || []);
  const warnings = results.flatMap((entry) => entry.warnings || []);
  const proposedTranslations = results.flatMap((entry) => entry.revisions || []);
  const passedChecks = uniqueStrings([
    "translations_present",
    ...results.flatMap((entry) => entry.passedChecks || []),
  ]);
  const failedChecks = uniqueStrings(results.flatMap((entry) => entry.failedChecks || []));
  const notes = uniqueStrings(results.flatMap((entry) => entry.notes || [])).join("\\n") || null;
  return { issues, warnings, proposedTranslations, passedChecks, failedChecks, notes };
}

function buildValidatedQualityReport(projection, parts) {
  const { issues, warnings, passedChecks, failedChecks, notes } = parts;
  const highIssues = issues.filter((entry) => entry.severity === "high").length;
  const penalty = calculateQualityPenalty(issues.length, highIssues, warnings.length);
  return validateQualityValidationReport({
    overall: issues.length > 0 ? "needs_review" : "pass",
    score: Number((1 - penalty).toFixed(2)),
    totalTranslations: projection.totalTranslations,
    checks: {
      passed: passedChecks,
      failed: failedChecks,
      totals: { passed: passedChecks.length, failed: failedChecks.length },
    },
    issues,
    warnings,
    passedChecks,
    failedChecks,
    notes,
    usedKnowledgeSources: buildUsedQualityKnowledgeSources(projection),
  });
}

function assembleQualityReport({ projection, results, elapsedMs }) {
  const parts = collectQualityReportParts(results);
  const report = buildValidatedQualityReport(projection, parts);
  return buildAssembledQualityReport(report, projection, parts.proposedTranslations, elapsedMs);
}

function calculateQualityPenalty(issueCount, highIssueCount, warningCount) {
  return Math.min(
    0.8,
    highIssueCount * 0.15 +
      (issueCount - highIssueCount) * 0.08 +
      warningCount * 0.025,
  );
}

function buildUsedQualityKnowledgeSources(projection) {
  return uniqueStrings([
    projection.context.glossary?.length ? "projected_glossary" : null,
    projection.context.story ? "projected_story" : null,
    projection.context.style ? "projected_style" : null,
    projection.context.localPairs?.length ? "projected_local_pairs" : null,
  ]);
}

function buildAssembledQualityReport(
  report,
  projection,
  proposedTranslations,
  elapsedMs,
) {
  return {
    ...report,
    proposedTranslations,
    coverage: projection.coverage,
    candidateCount: projection.candidateCount,
    omittedCount: projection.omittedCount,
    candidateReasonCounts: projection.candidateReasonCounts,
    candidatePurposeCounts: projection.candidatePurposeCounts,
    semanticCoverage: projection.semanticCoverage,
    windowCount: projection.windows.length,
    inputBytes: projection.windows.reduce(
      (sum, window) => sum + window.inputBytes,
      0,
    ),
    elapsedMs,
  };
}

function buildCompletenessContext(projection, finalTranslations, results) {
  const acceptanceByNodeId = new Map(
    results
      .flatMap((entry) => entry.acceptances || [])
      .map((entry) => [entry.nodeId, entry]),
  );
  const acceptedNodeIds = new Set([
    ...results.flatMap((entry) => entry.acceptedNodeIds || []),
    ...acceptanceByNodeId.keys(),
  ]);
  const finalById = new Map((finalTranslations || []).map((entry) => [entry.id, entry]));
  const suspects = (projection.candidates || []).filter((candidate) =>
    (candidate.reasons || []).some((reason) => COMPLETENESS_REASON_TYPES.has(reason.type)),
  );
  return { acceptanceByNodeId, acceptedNodeIds, finalById, suspects, projection };
}

function collectCompletenessOutcomes(context) {
  const outcomes = { accepted: [], repaired: [], unresolved: [] };
  for (const candidate of context.suspects) {
    const outcome = assessCompletenessCandidate(candidate, context);
    outcomes[outcome.bucket].push(outcome.summary);
  }
  return outcomes;
}

function assessTranslationCompleteness({ projection, finalTranslations, results }) {
  const context = buildCompletenessContext(projection, finalTranslations, results);
  const { accepted, repaired, unresolved } = collectCompletenessOutcomes(context);
  return {
    suspectedCount: context.suspects.length,
    repairedCount: repaired.length,
    acceptedCount: accepted.length,
    unresolvedCount: unresolved.length,
    affectedPageCount: new Set(
      context.suspects.map((entry) => entry.pageName).filter(Boolean),
    ).size,
    unresolved,
    accepted,
  };
}

function assessCompletenessCandidate(candidate, context) {
  const final = context.finalById.get(candidate.nodeId) || {
    id: candidate.nodeId,
    pageName: candidate.pageName,
    original: candidate.original,
    translation: "",
  };
  const remainingReasons = completenessReasons(final, context.projection.languages || {});
  const summary = {
    nodeId: candidate.nodeId,
    pageName: candidate.pageName || null,
    reasons: remainingReasons.map((entry) => entry.type),
  };
  if (remainingReasons.length === 0) return { bucket: "repaired", summary };
  if (context.acceptedNodeIds.has(candidate.nodeId)) {
    return {
      bucket: "accepted",
      summary: {
        ...summary,
        acceptanceReason: context.acceptanceByNodeId.get(candidate.nodeId)?.reason || null,
      },
    };
  }
  return { bucket: "unresolved", summary };
}

function applyCompletenessGate(report, completeness) {
  const failedChecks = uniqueStrings([
    ...(report.failedChecks || []),
    completeness.unresolvedCount > 0 ? "translation_completeness" : null,
  ]);
  const passedChecks = uniqueStrings([
    ...(report.passedChecks || []).filter(
      (entry) => entry !== "translation_completeness",
    ),
    completeness.unresolvedCount === 0 ? "translation_completeness" : null,
  ]);
  return {
    ...report,
    overall: completeness.unresolvedCount > 0 ? "fail" : report.overall,
    checks: {
      passed: passedChecks,
      failed: failedChecks,
      totals: { passed: passedChecks.length, failed: failedChecks.length },
    },
    passedChecks,
    failedChecks,
    completeness,
  };
}

function buildFinalVerification(input) {
  const { initialObservation, verificationObservation, proposedTranslations } = input;
  const revisedNodeIds = new Set(
    (proposedTranslations || []).map((entry) => entry.nodeId),
  );
  const verifiedById = new Map((verificationObservation?.nodes || []).map((entry) => [entry.nodeId, entry]));
  const finalNodes = (initialObservation?.nodes || []).map((entry) =>
    buildFinalVerificationNode(
      entry,
      verifiedById,
      revisedNodeIds,
      STRUCTURAL_BLOCKING_RISKS,
    ),
  );
  const blockingIssues = finalNodes.filter((entry) => entry.finalDisposition === "blocking");
  const warnings = finalNodes.filter((entry) => entry.finalDisposition === "unresolved");
  const points = calculateFinalVerificationPoints(finalNodes, warnings);
  return {
    status: blockingIssues.length > 0 ? "failed" : "passed",
    nodes: finalNodes,
    blockingIssues,
    warnings,
    score: finalNodes.length > 0 ? Number((points / finalNodes.length).toFixed(4)) : 1,
    verifiedAt: new Date().toISOString(),
  };
}

function verificationRiskDisposition(riskTypes, structuralBlockingRisks) {
  return (riskTypes || []).some((risk) => structuralBlockingRisks.has(risk)) ? "blocking" : "unresolved";
}

function buildFinalVerificationNode(entry, verifiedById, revisedNodeIds, structuralBlockingRisks) {
  const verified = verifiedById.get(entry.nodeId);
  if (verified?.disposition === "suspect") {
    const finalDisposition = verificationRiskDisposition(verified.riskTypes, structuralBlockingRisks);
    return { ...verified, finalDisposition };
  }
  if (verified?.disposition === "clean" && revisedNodeIds.has(entry.nodeId)) {
    return { ...verified, finalDisposition: "revised_verified" };
  }
  if (verified?.disposition === "clean")
    return { ...verified, finalDisposition: "clean" };
  if (entry.disposition === "clean")
    return { ...entry, finalDisposition: "clean" };
  const finalDisposition = verificationRiskDisposition(entry.riskTypes, structuralBlockingRisks);
  return { ...entry, finalDisposition };
}

function calculateFinalVerificationPoints(finalNodes, warnings) {
  return finalNodes.reduce((sum, entry) => {
    if (
      ["clean", "revised_verified", "manual_verified"].includes(
        entry.finalDisposition,
      )
    )
      return sum + 1;
    if (warnings.includes(entry)) return sum + 0.5;
    return sum;
  }, 0);
}

function selectVerificationTranslations({
  translations = [],
  qualityObservation = null,
  proposedTranslations = [],
}) {
  const ordered = translations.filter((entry) => entry?.id || entry?.nodeId);
  const byPage = buildVerificationPages(ordered);
  const sequencePages = buildSequencePageSet(qualityObservation);
  const targetIds = buildVerificationTargetIds(
    qualityObservation,
    proposedTranslations,
  );
  const selectedIds = selectVerificationIds(byPage, sequencePages, targetIds);
  return ordered.filter((entry) => selectedIds.has(entry.id || entry.nodeId));
}

function buildVerificationPages(ordered) {
  const byPage = new Map();
  for (const entry of ordered) {
    const pageName = entry.pageName || "";
    if (!byPage.has(pageName)) byPage.set(pageName, []);
    byPage.get(pageName).push(entry);
  }
  return byPage;
}

function buildSequencePageSet(qualityObservation) {
  return new Set(
    [
      ...(qualityObservation?.sequenceRisks || []).map(
        (entry) => entry.pageName,
      ),
      ...(qualityObservation?.nodes || [])
        .filter((entry) => (entry.riskTypes || []).includes("sequence_shift"))
        .map((entry) => entry.pageName),
    ].filter(Boolean),
  );
}

function buildVerificationTargetIds(qualityObservation, proposedTranslations) {
  return new Set(
    [
      ...(qualityObservation?.nodes || [])
        .filter((entry) => entry.disposition === "suspect")
        .map((entry) => entry.nodeId),
      ...proposedTranslations.map((entry) => entry.nodeId),
    ].filter(Boolean),
  );
}

function selectVerificationIds(byPage, sequencePages, targetIds) {
  const selectedIds = new Set();
  for (const [pageName, pageEntries] of byPage) {
    if (sequencePages.has(pageName)) {
      for (const entry of pageEntries)
        selectedIds.add(entry.id || entry.nodeId);
      continue;
    }
    selectNeighborVerificationIds(pageEntries, targetIds, selectedIds);
  }
  return selectedIds;
}

function selectNeighborVerificationIds(pageEntries, targetIds, selectedIds) {
  pageEntries.forEach((entry, index) => {
    if (!targetIds.has(entry.id || entry.nodeId)) return;
    for (
      let offset = Math.max(0, index - 1);
      offset <= Math.min(pageEntries.length - 1, index + 1);
      offset += 1
    ) {
      selectedIds.add(pageEntries[offset].id || pageEntries[offset].nodeId);
    }
  });
}

function qualityWorkspace(jobId) {
  return path.join(
    paths.workspaceRoot,
    jobId || `quality_${Date.now()}`,
    "standard_quality",
  );
}

function isTransientQualityFailure(error) {
  return isRetryableAoError(error);
}

function loadReusableCheckpoints(checkpointPaths, projection) {
  const reusable = new Map();
  for (const checkpointPath of checkpointPaths || []) {
    try {
      const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
      if (
        checkpoint?.projectionFingerprint === projection.fingerprint &&
        typeof checkpoint?.windowId === "string" &&
        checkpoint?.result &&
        checkpoint?.outcome !== "partial" &&
        checkpoint?.result?.semanticResult?.outcome !== "partial"
      ) {
        reusable.set(checkpoint.windowId, { checkpoint, checkpointPath });
      }
    } catch {
      // Missing or incompatible checkpoints are safely ignored.
    }
  }
  return reusable;
}

function normalizeQualityExecuteParams(input) {
  const params = {
    onProgress: null,
    includeAll: false,
    semanticRoleEvidence: [],
    semanticEvidenceFingerprint: null,
    reusableCheckpointPaths: [],
    reusableObservationCheckpointPaths: [],
    isCanceled: null,
    ...(input || {}),
  };
  if (params.sourceLanguage === undefined)
    params.sourceLanguage = params.translationMemory?.languages?.sourceLanguage || null;
  if (params.targetLanguage === undefined)
    params.targetLanguage = params.translationMemory?.languages?.targetLanguage || null;
  return params;
}

function normalizeQualityRunParams(input) {
  return normalizeQualityExecuteParams({
    mangaId: null,
    translatorId: null,
    chapterId: null,
    glossaryMode: "canonical",
    jobId: null,
    translationMemory: null,
    ...(input || {}),
  });
}

function normalizeQualityPreviewParams(input) {
  return normalizeQualityExecuteParams({
    mangaId: null,
    translatorId: null,
    chapterId: null,
    glossaryMode: "canonical",
    jobId: null,
    translations: [],
    translationMemory: null,
    ...(input || {}),
  });
}

function qualityContextProgress(projection, projectionPath) {
  return {
    projectionPath,
    candidateCount: projection.candidateCount,
    totalTranslations: projection.totalTranslations,
    windowCount: projection.windows.length,
    candidateReasonCounts: projection.candidateReasonCounts,
    candidatePurposeCounts: projection.candidatePurposeCounts,
    semanticCoverage: projection.semanticCoverage,
    inputBytes: projection.windows.reduce((sum, window) => sum + window.inputBytes, 0),
  };
}

function reportQualityWindowStarted(input) {
  input.onProgress?.("quality.window.started", {
    windowId: input.window.windowId,
    purpose: input.window.purpose,
    currentWindow: input.index + 1,
    totalWindows: input.projection.windows.length,
    inputBytes: input.window.inputBytes,
  });
}

function persistQualityWindowCheckpoint(input, checkpoint) {
  const checkpointPath = path.join(input.workspace, "checkpoints", `${input.window.windowId}.json`);
  writeJsonAtomic(checkpointPath, checkpoint);
  input.checkpointPaths.push(checkpointPath);
  input.results.push(checkpoint.result);
  return checkpointPath;
}

function reportQualityWindowCompleted(input, checkpoint, checkpointPath) {
  input.onProgress?.("quality.window.completed", {
    windowId: input.window.windowId,
    purpose: input.window.purpose,
    completedWindows: input.index + 1,
    totalWindows: input.projection.windows.length,
    inputBytes: input.window.inputBytes,
    elapsedMs: checkpoint.elapsedMs,
    checkpointPath,
    attemptCount: checkpoint.attemptCount,
  });
}

function reportQualityWindowRetry(input, attemptCount, error) {
  input.onProgress?.("quality.window.retrying", {
    windowId: input.window.windowId,
    purpose: input.window.purpose,
    currentWindow: input.index + 1,
    totalWindows: input.projection.windows.length,
    attempt: attemptCount + 1,
    reason: error.message,
  });
}

function persistQualityFinalReport(context, finalReport) {
  const reportPath = path.join(qualityWorkspace(context.jobId), "quality_report.json");
  const persisted = {
    generatedAt: new Date().toISOString(),
    mangaId: context.mangaId,
    translatorId: context.translatorId,
    chapterId: context.chapterId,
    glossaryMode: context.glossaryMode,
    translationMemoryFingerprint: context.translationMemory?.fingerprint || null,
    ...finalReport,
  };
  writeJsonAtomic(reportPath, persisted);
  return reportPath;
}

class QualityModule {
  constructor(client, aoTaskRunner) {
    this.client = client;
    this.aoTaskRunner = aoTaskRunner;
  }

  async execute(input) {
    const params = normalizeQualityExecuteParams(input);
    const resolvedMemory = this.resolveExecutionMemory(params.translationMemory);
    const startedAt = Date.now(), workspace = qualityWorkspace(params.jobId);
    const qualityObservationExecution = await this.runQualityObservationAndNotify({
      ...params,
      resolvedMemory,
    });
    const { projection, projectionPath } = await this.buildAndPersistQualityProjection({
      ...params,
      resolvedMemory,
      qualityObservationExecution,
      workspace,
    });
    const windowResults = await this.processQualityWindows({
      projection,
      jobId: params.jobId,
      workspace,
      reusableCheckpointPaths: params.reusableCheckpointPaths,
      onProgress: params.onProgress,
      isCanceled: params.isCanceled,
    });
    return this.buildExecutionResult({
      projection,
      projectionPath,
      ...windowResults,
      qualityObservationExecution,
      startedAt,
    });
  }

  async runQualityObservationAndNotify({
    translations,
    resolvedMemory,
    jobId,
    sourceLanguage,
    targetLanguage,
    reusableObservationCheckpointPaths,
    isCanceled,
    onProgress,
  }) {
    const qualityObservationExecution = await this.runQualityObservation({
      translations,
      resolvedMemory,
      jobId,
      sourceLanguage,
      targetLanguage,
      reusableObservationCheckpointPaths,
      isCanceled,
      onProgress,
    });
    onProgress?.("quality_observation.completed", {
      observationPath: qualityObservationExecution.observationPath,
      planPath: qualityObservationExecution.planPath,
      checkpointPaths: qualityObservationExecution.checkpointPaths,
      summary: qualityObservationExecution.observation.summary,
      coverage: qualityObservationExecution.observation.coverage,
    });
    return qualityObservationExecution;
  }

  async buildAndPersistQualityProjection(input) {
    const projection = this.buildQualityProjection({
      ...input,
      qualityObservation: input.qualityObservationExecution.observation,
    });
    const projectionPath = path.join(input.workspace, "quality_context_projection.json");
    writeJsonAtomic(projectionPath, projection);
    input.onProgress?.("quality.context_built", qualityContextProgress(projection, projectionPath));
    return { projection, projectionPath };
  }

  resolveExecutionMemory(translationMemory) {
    return (
      translationMemory || {
        fingerprint: null,
        effective: {
          glossary: [],
          story: null,
          style: null,
          localKnowledge: null,
        },
      }
    );
  }

  async runQualityObservation({
    translations,
    resolvedMemory,
    jobId,
    sourceLanguage,
    targetLanguage,
    reusableObservationCheckpointPaths,
    isCanceled,
    onProgress,
  }) {
    return runTranslationQualityObservation({
      aoTaskRunner: this.aoTaskRunner,
      translations,
      translationMemory: resolvedMemory,
      jobId,
      sourceLanguage,
      targetLanguage,
      reusableCheckpointPaths: reusableObservationCheckpointPaths,
      isCanceled,
      onProgress,
    });
  }

  buildQualityProjection({
    translations,
    resolvedMemory,
    includeAll,
    sourceLanguage,
    targetLanguage,
    semanticRoleEvidence,
    semanticEvidenceFingerprint,
    qualityObservation,
  }) {
    const projection = buildQualityContextProjection({
      translations,
      translationMemory: resolvedMemory,
      includeAll,
      sourceLanguage,
      targetLanguage,
      semanticRoleEvidence,
      semanticEvidenceFingerprint,
      qualityObservation,
    });
    projection.contractHash = qualityContractHash();
    projection.model = this.aoTaskRunner.settings?.model || null;
    delete projection.fingerprint;
    projection.fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify(projection))
      .digest("hex");
    return projection;
  }

  async processQualityWindows({
    projection,
    jobId,
    workspace,
    reusableCheckpointPaths,
    onProgress,
    isCanceled,
  }) {
    const results = [];
    const checkpointPaths = [];
    const reusableCheckpoints = loadReusableCheckpoints(
      reusableCheckpointPaths,
      projection,
    );
    for (let index = 0; index < projection.windows.length; index += 1) {
      await this.processQualityWindow({
        projection,
        window: projection.windows[index],
        index,
        jobId,
        workspace,
        reusableCheckpoints,
        results,
        checkpointPaths,
        onProgress,
        isCanceled,
      });
    }
    return { results, checkpointPaths };
  }

  async processQualityWindow(input) {
    const { projection, window, index, jobId, reusableCheckpoints } = input;
    const reusable = reusableCheckpoints.get(window.windowId);
    if (reusable) {
      handleReusedQualityWindow({
        ...input,
        reusable,
      });
      return;
    }
    const windowStartedAt = Date.now();
    reportQualityWindowStarted(input);
    const { result, attemptCount } = await this.runQualityWindowWithRetry({
      projection,
      window,
      jobId,
      onProgress: input.onProgress,
      index,
    });
    const checkpoint = buildQualityCheckpoint({
      projection,
      window,
      result,
      attemptCount,
      windowStartedAt,
    });
    const checkpointPath = persistQualityWindowCheckpoint(input, checkpoint);
    reportQualityWindowCompleted(input, checkpoint, checkpointPath);
  }

  async runQualityWindowWithRetry(input) {
    let result;
    let attemptCount = 0;
    while (attemptCount < 2) {
      attemptCount += 1;
      try {
        result = await this.runQualityWindowAttempt(input, attemptCount);
        break;
      } catch (error) {
        if (attemptCount >= 2 || !isTransientQualityFailure(error)) throw error;
        reportQualityWindowRetry(input, attemptCount, error);
      }
    }
    return { result, attemptCount };
  }

  async runQualityWindowAttempt(input, attemptCount) {
    const taskInput = { ...buildQualityWindowInput(input.projection, input.window), jobId: input.jobId };
    return this.aoTaskRunner.runQualityReviewAndOptimization(
      {
        ...taskInput,
        jobId: attemptCount === 1 ? input.jobId : `${input.jobId}_retry_${attemptCount}`,
      },
      { outputFilePath: `output/${input.window.windowId}_result.txt` },
    );
  }

  buildExecutionResult({
    projection,
    projectionPath,
    checkpointPaths,
    results,
    qualityObservationExecution,
    startedAt,
  }) {
    return {
      projection,
      projectionPath,
      checkpointPaths,
      results,
      report: assembleQualityReport({
        projection,
        results,
        elapsedMs: Date.now() - startedAt,
      }),
      qualityObservation: qualityObservationExecution.observation,
      qualityObservationPath: qualityObservationExecution.observationPath,
      qualityObservationCheckpointPaths:
        qualityObservationExecution.checkpointPaths,
      semanticResult: mergeSemanticResults([
        qualityObservationExecution.observation?.semanticResult,
        ...results.map((entry) => entry.semanticResult),
      ]),
    };
  }

  async run(input) {
    const context = await this.createQualityRunContext(normalizeQualityRunParams(input));
    await this.applyQualityProposals(context);
    this.assessInitialQuality(context);
    await this.runQualityVerification(context);
    await this.runQualityRepairRound(context);
    return this.finalizeQualityRun(context);
  }

  async createQualityRunContext(params) {
    const context = { ...params };
    context.initial = collectTranslations(
      await this.client.getScene(context.baseUrl),
    );
    context.execution = await this.execute({
      translations: context.initial.translations,
      translationMemory: context.translationMemory,
      jobId: context.jobId,
      onProgress: context.onProgress,
      sourceLanguage: context.sourceLanguage,
      targetLanguage: context.targetLanguage,
      semanticRoleEvidence: context.semanticRoleEvidence,
      semanticEvidenceFingerprint: context.semanticEvidenceFingerprint,
      reusableCheckpointPaths: context.reusableCheckpointPaths,
      reusableObservationCheckpointPaths:
        context.reusableObservationCheckpointPaths,
      isCanceled: context.isCanceled,
    });
    context.proposals = context.execution.report.proposedTranslations;
    return context;
  }

  async applyQualityProposals(context) {
    const ops = buildQualityPatchOps(
      new Map(context.initial.translations.map((entry) => [entry.id, entry])),
      context.proposals,
    );
    context.onProgress?.("quality.apply_started", {
      revisionCount: context.proposals.length,
      operationCount: ops.length,
    });
    if (ops.length > 0)
      await this.client.applyHistoryBatch({
        ops,
        label: `quality_optimize_${context.jobId || Date.now()}`,
        baseUrl: context.baseUrl,
      });
    context.finalData = collectTranslations(
      await this.client.getScene(context.baseUrl),
    );
    context.finalData.translations = applyQualitySemanticAnnotations(
      context.finalData.translations,
      context.execution.projection,
    );
  }

  assessInitialQuality(context) {
    context.completeness = assessTranslationCompleteness({
      projection: context.execution.projection,
      finalTranslations: context.finalData.translations,
      results: context.execution.results,
    });
    context.verificationTranslations = selectVerificationTranslations({
      translations: context.finalData.translations,
      qualityObservation: context.execution.qualityObservation,
      proposedTranslations: context.proposals,
    });
    context.verificationObservation = {
      nodes: [],
      sequenceRisks: [],
      fingerprint: null,
    };
    context.verificationObservationPath = null;
    context.verificationCheckpointPaths = [];
    context.repairRoundCount = 1;
    context.finalVerification = buildFinalVerification({
      initialObservation: context.execution.qualityObservation,
      verificationObservation: context.verificationObservation,
      proposedTranslations: context.proposals,
    });
  }

  async runQualityVerification(context) {
    if (context.verificationTranslations.length === 0) return;
    context.onProgress?.("quality.verification_started", {
      nodeCount: context.verificationTranslations.length,
    });
    const verification = await runTranslationQualityObservation({
      aoTaskRunner: this.aoTaskRunner,
      translations: context.verificationTranslations,
      translationMemory: context.translationMemory,
      jobId: `${context.jobId || "quality"}_verification`,
      sourceLanguage: context.sourceLanguage,
      targetLanguage: context.targetLanguage,
      isCanceled: context.isCanceled,
      onProgress: context.onProgress,
    });
    context.verificationObservation = verification.observation;
    context.verificationObservationPath = verification.observationPath;
    context.verificationCheckpointPaths = verification.checkpointPaths;
    context.onProgress?.("quality.verification_completed", {
      observationPath: context.verificationObservationPath,
      summary: context.verificationObservation.summary,
    });
    context.finalVerification = buildFinalVerification({
      initialObservation: context.execution.qualityObservation,
      verificationObservation: context.verificationObservation,
      proposedTranslations: context.proposals,
    });
  }

  async runQualityRepairRound(context) {
    if (
      !(
        context.finalVerification.blockingIssues.length > 0 &&
        context.proposals.length > 0
      )
    )
      return;
    context.repairRoundCount = 2;
    context.onProgress?.("quality.repair_round_started", {
      round: 2,
      nodeCount: context.verificationTranslations.length,
    });
    await this.runQualityRepairSecondRound(context);
    await this.runQualityRepairSecondVerification(context);
    context.onProgress?.("quality.repair_round_completed", {
      round: 2,
      revisionCount: context.secondProposals.length,
      blockingIssueCount: context.finalVerification.blockingIssues.length,
    });
  }

  async runQualityRepairSecondRound(context) {
    const secondRound = await this.execute({
      translations: context.verificationTranslations,
      translationMemory: context.translationMemory,
      jobId: `${context.jobId || "quality"}_repair_2`,
      onProgress: context.onProgress,
      sourceLanguage: context.sourceLanguage,
      targetLanguage: context.targetLanguage,
      isCanceled: context.isCanceled,
    });
    const secondProposals = secondRound.report.proposedTranslations;
    const secondOps = buildQualityPatchOps(
      new Map(context.finalData.translations.map((entry) => [entry.id, entry])),
      secondProposals,
    );
    await this.applySecondRoundPatches(context, secondOps);
    context.proposals = [...context.proposals, ...secondProposals];
    context.secondProposals = secondProposals;
  }

  async applySecondRoundPatches(context, secondOps) {
    if (secondOps.length === 0) return;
    await this.client.applyHistoryBatch({
      ops: secondOps,
      label: `quality_repair_2_${context.jobId || Date.now()}`,
      baseUrl: context.baseUrl,
    });
    const refreshed = collectTranslations(await this.client.getScene(context.baseUrl));
    context.finalData.translations = applyQualitySemanticAnnotations(
      refreshed.translations,
      context.execution.projection,
    );
  }

  async runQualityRepairSecondVerification(context) {
    const secondVerificationTranslations = selectVerificationTranslations({
      translations: context.finalData.translations,
      qualityObservation: context.execution.qualityObservation,
      proposedTranslations: context.proposals,
    });
    const secondVerification = await runTranslationQualityObservation({
      aoTaskRunner: this.aoTaskRunner,
      translations: secondVerificationTranslations,
      translationMemory: context.translationMemory,
      jobId: `${context.jobId || "quality"}_verification_2`,
      sourceLanguage: context.sourceLanguage,
      targetLanguage: context.targetLanguage,
      isCanceled: context.isCanceled,
      onProgress: context.onProgress,
    });
    context.verificationObservation = secondVerification.observation;
    context.verificationObservationPath = secondVerification.observationPath;
    context.verificationCheckpointPaths.push(
      ...secondVerification.checkpointPaths,
    );
    context.finalVerification = buildFinalVerification({
      initialObservation: context.execution.qualityObservation,
      verificationObservation: context.verificationObservation,
      proposedTranslations: context.proposals,
    });
  }

  finalizeQualityRun(context) {
    const completenessReport = applyCompletenessGate(
      context.execution.report,
      context.completeness,
    );
    const hasUnresolvedQuality =
      context.completeness.unresolvedCount > 0 ||
      (context.execution.qualityObservation.coverage?.unobserved || 0) > 0 ||
      context.finalVerification.status === "failed";
    const finalReport = buildQualityFinalReport(
      context,
      completenessReport,
      hasUnresolvedQuality,
    );
    const reportPath = persistQualityFinalReport(context, finalReport);
    return buildQualityRunReturn(context, finalReport, reportPath);
  }

  async prepareQualityPreview(params) {
    const originalTranslations = normalizePreviewTranslations(params.translations);
    const execution = await this.execute({
      translations: originalTranslations,
      translationMemory: params.translationMemory,
      jobId: params.jobId || `quality_preview_${Date.now()}`,
      sourceLanguage: params.sourceLanguage,
      targetLanguage: params.targetLanguage,
    });
    const revisedTranslations = applyProposalsToTranslations(
      originalTranslations,
      execution.report.proposedTranslations,
    );
    const completeness = assessTranslationCompleteness({
      projection: execution.projection,
      finalTranslations: revisedTranslations,
      results: execution.results,
    });
    return { originalTranslations, execution, revisedTranslations, completeness };
  }

  async verifyQualityPreview(params, preview) {
    const verificationTranslations = selectVerificationTranslations({
      translations: preview.revisedTranslations,
      qualityObservation: preview.execution.qualityObservation,
      proposedTranslations: preview.execution.report.proposedTranslations,
    });
    const verification = await this.runPreviewVerification({
      verificationTranslations,
      translationMemory: params.translationMemory,
      jobId: params.jobId,
      sourceLanguage: params.sourceLanguage,
      targetLanguage: params.targetLanguage,
    });
    const finalVerification = buildFinalVerification({
      initialObservation: preview.execution.qualityObservation,
      verificationObservation: verification.observation,
      proposedTranslations: preview.execution.report.proposedTranslations,
    });
    return { verification, finalVerification };
  }

  async runPreview(input) {
    const params = normalizeQualityPreviewParams(input);
    const preview = await this.prepareQualityPreview(params);
    const verified = await this.verifyQualityPreview(params, preview);
    const completenessReport = applyCompletenessGate(preview.execution.report, preview.completeness);
    const hasUnresolvedQuality = this.hasUnresolvedQuality(
      preview.completeness,
      preview.execution,
      verified.finalVerification,
    );
    const finalReport = this.buildPreviewFinalReport(
      completenessReport,
      verified.finalVerification,
      hasUnresolvedQuality,
      preview.execution,
      verified.verification,
    );
    return this.buildPreviewReturn({
      ...params,
      ...preview,
      finalReport,
    });
  }

  async runPreviewVerification({
    verificationTranslations,
    translationMemory,
    jobId,
    sourceLanguage,
    targetLanguage,
  }) {
    if (verificationTranslations.length === 0)
      return { observation: { nodes: [], sequenceRisks: [] } };
    return runTranslationQualityObservation({
      aoTaskRunner: this.aoTaskRunner,
      translations: verificationTranslations,
      translationMemory,
      jobId: `${jobId || "quality_preview"}_verification`,
      sourceLanguage,
      targetLanguage,
    });
  }

  hasUnresolvedQuality(completeness, execution, finalVerification) {
    return (
      completeness.unresolvedCount > 0 ||
      (execution.qualityObservation.coverage?.unobserved || 0) > 0 ||
      finalVerification.status === "failed"
    );
  }

  buildPreviewFinalReport(
    completenessReport,
    finalVerification,
    hasUnresolvedQuality,
    execution,
    verification,
  ) {
    return {
      ...completenessReport,
      status: "passed",
      overall: "pass",
      finalScore: finalVerification.score,
      finalVerification,
      blockingIssues: finalVerification.blockingIssues,
      completenessStatus: hasUnresolvedQuality ? "incomplete" : "complete",
      semanticResult: qualitySemanticResult(
        [execution.semanticResult, verification.observation?.semanticResult],
        hasUnresolvedQuality,
      ),
    };
  }

  buildPreviewReturn({
    finalReport,
    execution,
    translationMemory,
    mangaId,
    translatorId,
    chapterId,
    glossaryMode,
    originalTranslations,
    revisedTranslations,
  }) {
    return {
      ...finalReport,
      reportPath: null,
      projectionPath: execution.projectionPath,
      checkpointPaths: execution.checkpointPaths,
      mangaId,
      translatorId,
      chapterId,
      glossaryMode,
      originalTranslations,
      revisedTranslations,
      optimizedTranslations: execution.report.proposedTranslations,
      translationMemoryFingerprint: translationMemory?.fingerprint || null,
      projection: execution.projection,
      qualityObservation: execution.qualityObservation,
    };
  }
}

function qualityLearningExcludedNodeIds(context) {
  return [
    ...new Set([
      ...(context.completeness.unresolved || []).map((entry) => entry.nodeId).filter(Boolean),
      ...(context.execution.qualityObservation.nodes || [])
        .filter((entry) => entry.disposition === "unobserved")
        .map((entry) => entry.nodeId),
      ...(context.finalVerification.blockingIssues || []).map((entry) => entry.nodeId).filter(Boolean),
    ]),
  ];
}

function buildQualityFinalReport(context, completenessReport, hasUnresolvedQuality) {
  return {
    ...completenessReport,
    status: "passed",
    overall: "pass",
    score: context.finalVerification.score,
    finalScore: context.finalVerification.score,
    discoveredFindings: [
      ...(context.execution.report.issues || []),
      ...(context.execution.report.warnings || []),
    ],
    appliedRevisions: context.proposals,
    finalVerification: context.finalVerification,
    blockingIssues: context.finalVerification.blockingIssues,
    completenessStatus: hasUnresolvedQuality ? "incomplete" : "complete",
    learningExcludedNodeIds: qualityLearningExcludedNodeIds(context),
    semanticResult: qualitySemanticResult(
      [
        context.execution.semanticResult,
        context.verificationObservation?.semanticResult,
      ],
      hasUnresolvedQuality,
    ),
    repairRoundCount: context.repairRoundCount,
  };
}

function buildQualityRunReturn(context, finalReport, reportPath) {
  return {
    ...finalReport,
    reportPath,
    projectionPath: context.execution.projectionPath,
    checkpointPaths: context.execution.checkpointPaths,
    optimizedTranslations: context.proposals,
    qualityObservation: context.execution.qualityObservation,
    qualityObservationPath: context.execution.qualityObservationPath,
    qualityObservationCheckpointPaths:
      context.execution.qualityObservationCheckpointPaths,
    verificationObservation: context.verificationObservation,
    verificationObservationPath: context.verificationObservationPath,
    verificationCheckpointPaths: context.verificationCheckpointPaths,
    finalTranslations: context.finalData.translations,
    translationMemoryFingerprint:
      context.translationMemory?.fingerprint || null,
  };
}

function handleReusedQualityWindow({
  reusable,
  window,
  index,
  projection,
  results,
  checkpointPaths,
  onProgress,
}) {
  results.push(reusable.checkpoint.result);
  checkpointPaths.push(reusable.checkpointPath);
  onProgress?.("quality.window.reused", {
    windowId: window.windowId,
    purpose: window.purpose,
    completedWindows: index + 1,
    totalWindows: projection.windows.length,
    inputBytes: window.inputBytes,
    elapsedMs: reusable.checkpoint.elapsedMs || 0,
    checkpointPath: reusable.checkpointPath,
    attemptCount: reusable.checkpoint.attemptCount || 1,
  });
}

function buildQualityCheckpoint({
  projection,
  window,
  result,
  attemptCount,
  windowStartedAt,
}) {
  return {
    schemaVersion: 1,
    projectionFingerprint: projection.fingerprint,
    windowId: window.windowId,
    purpose: window.purpose,
    inputBytes: window.inputBytes,
    candidateCount: window.candidates.length,
    attemptCount,
    elapsedMs: Date.now() - windowStartedAt,
    completedAt: new Date().toISOString(),
    outcome: result?.semanticResult?.outcome || "clean",
    acceptedRecordCount: result?.semanticResult?.acceptedRecordCount || 0,
    quarantinedRecordCount: result?.semanticResult?.quarantinedRecordCount || 0,
    result,
  };
}

module.exports = {
  QualityModule,
  applyProposalsToTranslations,
  applyCompletenessGate,
  assessTranslationCompleteness,
  assembleQualityReport,
  buildQualityPatchOps,
  collectTranslations,
  normalizePreviewTranslations,
  selectVerificationTranslations,
};
