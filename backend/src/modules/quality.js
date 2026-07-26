const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { paths } = require("../config");
const { validateQualityValidationReport } = require("../ao_contracts");
const {
  buildQualityContextProjection,
  buildQualityWindowInput,
  applyQualitySemanticAnnotations,
  completenessReasons,
} = require("./quality_projection");
const { runTranslationQualityObservation } = require("./translation_quality_observation");

const COMPLETENESS_REASON_TYPES = new Set([
  "translation_missing",
  "source_target_identity",
]);

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function qualityContractHash() {
  const files = [
    path.join(__dirname, "..", "quality_line_contract.js"),
    path.join(__dirname, "..", "..", "ao", "agents", "quality-optimizer.md"),
    path.join(__dirname, "..", "..", "ao", "skills", "quality-line-contract", "SKILL.md"),
    path.join(__dirname, "..", "..", "ao", "skills", "quality-decision-framework", "SKILL.md"),
  ];
  return crypto.createHash("sha256").update(files.map((file) => fs.readFileSync(file, "utf8")).join("\n---\n")).digest("hex");
}

function collectTranslations(scene) {
  const pages = scene?.scene?.pages || {};
  const translations = [];
  const pageList = [];
  for (const [pageId, page] of Object.entries(pages)) {
    pageList.push({ id: pageId, name: page.name });
    for (const [nodeId, node] of Object.entries(page.nodes || {})) {
      const textNode = node.kind?.text;
      if (textNode?.text) {
        translations.push({
          id: nodeId,
          pageId,
          pageName: page.name,
          original: textNode.text,
          translation: typeof textNode.translation === "string" ? textNode.translation : "",
          textRole: textNode.textRole || node.textRole || null,
          styleChannel: textNode.styleChannel || node.styleChannel || null,
          speakerRef: textNode.speakerRef || node.speakerRef || null,
          bbox: {
            x: Number(node.transform?.x || 0),
            y: Number(node.transform?.y || 0),
            width: Number(node.transform?.width || 0),
            height: Number(node.transform?.height || 0),
          },
        });
      }
    }
  }
  return { translations, pages: pageList, totalTranslations: translations.length, totalPages: pageList.length };
}

function normalizePreviewTranslations(translations) {
  return (Array.isArray(translations) ? translations : []).map((entry, index) => {
    if (!entry || typeof entry !== "object") return null;
    const original = typeof entry.original === "string" ? entry.original : "";
    const translation = typeof entry.translation === "string"
      ? entry.translation
      : typeof entry.currentTranslation === "string" ? entry.currentTranslation : "";
    if (!original) return null;
    return {
      id: entry.nodeId || entry.id || `preview_${String(index + 1).padStart(4, "0")}`,
      pageId: entry.pageId || `preview_page_${String(index + 1).padStart(3, "0")}`,
      pageName: entry.pageName || `preview_${String(index + 1).padStart(3, "0")}.txt`,
      original,
      translation,
      textRole: entry.textRole || null,
      styleChannel: entry.styleChannel || null,
      speakerRef: entry.speakerRef || null,
    };
  }).filter(Boolean);
}

function applyProposalsToTranslations(translations, proposedTranslations) {
  const byId = new Map((proposedTranslations || []).map((entry) => [entry.nodeId, entry]));
  return (translations || []).map((entry) => {
    const proposal = byId.get(entry.id);
    return proposal?.revisedTranslation ? { ...entry, translation: proposal.revisedTranslation } : entry;
  });
}

function buildQualityPatchOps(translationsByNodeId, proposedTranslations) {
  return (proposedTranslations || []).flatMap((proposal) => {
    const current = translationsByNodeId.get(proposal.nodeId);
    if (!current || current.translation === proposal.revisedTranslation) return [];
    return [{ updateNode: { page: current.pageId, id: current.id, patch: {
      data: { text: { translation: proposal.revisedTranslation } },
    } } }];
  });
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function assembleQualityReport({ projection, results, elapsedMs }) {
  const issues = results.flatMap((entry) => entry.issues || []);
  const warnings = results.flatMap((entry) => entry.warnings || []);
  const proposedTranslations = results.flatMap((entry) => entry.revisions || []);
  const passedChecks = uniqueStrings(["translations_present", ...results.flatMap((entry) => entry.passedChecks || [])]);
  const failedChecks = uniqueStrings(results.flatMap((entry) => entry.failedChecks || []));
  const highIssues = issues.filter((entry) => entry.severity === "high").length;
  const penalty = Math.min(0.8, highIssues * 0.15 + (issues.length - highIssues) * 0.08 + warnings.length * 0.025);
  const report = validateQualityValidationReport({
    overall: issues.length > 0 ? "needs_review" : "pass",
    score: Number((1 - penalty).toFixed(2)),
    totalTranslations: projection.totalTranslations,
    checks: { passed: passedChecks, failed: failedChecks, totals: { passed: passedChecks.length, failed: failedChecks.length } },
    issues,
    warnings,
    passedChecks,
    failedChecks,
    notes: uniqueStrings(results.flatMap((entry) => entry.notes || [])).join("\n") || null,
    usedKnowledgeSources: uniqueStrings([
      projection.context.glossary?.length ? "projected_glossary" : null,
      projection.context.story ? "projected_story" : null,
      projection.context.style ? "projected_style" : null,
      projection.context.localPairs?.length ? "projected_local_pairs" : null,
    ]),
  });
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
    inputBytes: projection.windows.reduce((sum, window) => sum + window.inputBytes, 0),
    elapsedMs,
  };
}

function assessTranslationCompleteness({ projection, finalTranslations, results }) {
  const acceptanceByNodeId = new Map(results.flatMap((entry) => entry.acceptances || []).map((entry) => [entry.nodeId, entry]));
  const acceptedNodeIds = new Set([
    ...results.flatMap((entry) => entry.acceptedNodeIds || []),
    ...acceptanceByNodeId.keys(),
  ]);
  const finalById = new Map((finalTranslations || []).map((entry) => [entry.id, entry]));
  const suspects = (projection.candidates || []).filter((candidate) =>
    (candidate.reasons || []).some((reason) => COMPLETENESS_REASON_TYPES.has(reason.type))
  );
  const accepted = [];
  const repaired = [];
  const unresolved = [];
  for (const candidate of suspects) {
    const final = finalById.get(candidate.nodeId) || {
      id: candidate.nodeId,
      pageName: candidate.pageName,
      original: candidate.original,
      translation: "",
    };
    const remainingReasons = completenessReasons(final, projection.languages || {});
    const summary = {
      nodeId: candidate.nodeId,
      pageName: candidate.pageName || null,
      reasons: remainingReasons.map((entry) => entry.type),
    };
    if (remainingReasons.length === 0) repaired.push(summary);
    else if (acceptedNodeIds.has(candidate.nodeId)) accepted.push({
      ...summary,
      acceptanceReason: acceptanceByNodeId.get(candidate.nodeId)?.reason || null,
    });
    else unresolved.push(summary);
  }
  return {
    suspectedCount: suspects.length,
    repairedCount: repaired.length,
    acceptedCount: accepted.length,
    unresolvedCount: unresolved.length,
    affectedPageCount: new Set(suspects.map((entry) => entry.pageName).filter(Boolean)).size,
    unresolved,
    accepted,
  };
}

function applyCompletenessGate(report, completeness) {
  const failedChecks = uniqueStrings([
    ...(report.failedChecks || []),
    completeness.unresolvedCount > 0 ? "translation_completeness" : null,
  ]);
  const passedChecks = uniqueStrings([
    ...(report.passedChecks || []).filter((entry) => entry !== "translation_completeness"),
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

function buildFinalVerification({ initialObservation, verificationObservation, proposedTranslations }) {
  const structuralBlockingRisks = new Set([
    "empty_translation",
    "sequence_shift",
    "locked_term_violation",
  ]);
  const revisedNodeIds = new Set((proposedTranslations || []).map((entry) => entry.nodeId));
  const verifiedById = new Map((verificationObservation?.nodes || []).map((entry) => [entry.nodeId, entry]));
  const finalNodes = (initialObservation?.nodes || []).map((entry) => {
    const verified = verifiedById.get(entry.nodeId);
    if (verified?.disposition === "suspect") {
      const risks = new Set(verified.riskTypes || []);
      const finalDisposition = [...risks].some((risk) => structuralBlockingRisks.has(risk))
        ? "blocking"
        : "unresolved";
      return { ...verified, finalDisposition };
    }
    if (verified?.disposition === "clean" && revisedNodeIds.has(entry.nodeId)) {
      return { ...verified, finalDisposition: "revised_verified" };
    }
    if (verified?.disposition === "clean") return { ...verified, finalDisposition: "clean" };
    if (entry.disposition === "clean") return { ...entry, finalDisposition: "clean" };
    const risks = new Set(entry.riskTypes || []);
    const finalDisposition = [...risks].some((risk) => structuralBlockingRisks.has(risk))
      ? "blocking"
      : "unresolved";
    return { ...entry, finalDisposition };
  });
  const blockingIssues = finalNodes.filter((entry) => entry.finalDisposition === "blocking");
  const warnings = finalNodes.filter((entry) => entry.finalDisposition === "unresolved");
  const points = finalNodes.reduce((sum, entry) => {
    if (["clean", "revised_verified", "manual_verified"].includes(entry.finalDisposition)) return sum + 1;
    if (warnings.includes(entry)) return sum + 0.5;
    return sum;
  }, 0);
  return {
    status: blockingIssues.length > 0 ? "failed" : "passed",
    nodes: finalNodes,
    blockingIssues,
    warnings,
    score: finalNodes.length > 0 ? Number((points / finalNodes.length).toFixed(4)) : 1,
    verifiedAt: new Date().toISOString(),
  };
}

function buildQualityReviewPackage({ translations, finalVerification, proposedTranslations, qualityObservation }) {
  const byId = new Map((translations || []).map((entry) => [entry.id, entry]));
  const proposalById = new Map((proposedTranslations || []).map((entry) => [entry.nodeId, entry]));
  const reviewIds = new Set([
    ...(finalVerification.blockingIssues || []).map((entry) => entry.nodeId),
    ...(finalVerification.warnings || []).map((entry) => entry.nodeId),
  ]);
  const blockingNodeIds = new Set((finalVerification.blockingIssues || []).map((entry) => entry.nodeId));
  const pages = new Map();
  for (const nodeId of reviewIds) {
    const translation = byId.get(nodeId);
    if (!translation) continue;
    const pageName = translation.pageName || "unknown";
    const page = pages.get(pageName) || { pageId: translation.pageId || null, pageName, items: [], sequenceRisks: [] };
    const finding = finalVerification.nodes.find((entry) => entry.nodeId === nodeId);
    const proposal = proposalById.get(nodeId);
    page.items.push({
      nodeId,
      original: translation.original,
      currentTranslation: translation.translation,
      proposedTranslation: proposal?.revisedTranslation || null,
      riskTypes: finding?.riskTypes || [],
      confidence: finding?.confidence ?? null,
      reason: finding?.reason || proposal?.reason || null,
      bbox: translation.bbox || null,
      blocking: blockingNodeIds.has(nodeId),
      allowedDecisions: [
        ...(proposal?.revisedTranslation ? ["accept_proposal"] : []),
        "manual_edit",
        "confirm_current",
        "ignore_and_publish",
      ],
    });
    pages.set(pageName, page);
  }
  for (const risk of qualityObservation?.sequenceRisks || []) {
    const page = pages.get(risk.pageName);
    if (page) page.sequenceRisks.push(risk);
  }
  return {
    schemaVersion: 1,
    status: finalVerification.status,
    generatedAt: new Date().toISOString(),
    pages: [...pages.values()],
    summary: {
      blocking: finalVerification.blockingIssues.length,
      warnings: finalVerification.warnings.length,
      pages: pages.size,
    },
  };
}

function qualityWorkspace(jobId) {
  return path.join(paths.workspaceRoot, jobId || `quality_${Date.now()}`, "standard_quality");
}

function isTransientQualityFailure(error) {
  const message = String(error?.message || error || "");
  return /stopped before producing|needsRestart=true|timed? out|timeout|ECONNRESET|ECONNREFUSED|\b429\b|\b5\d\d\b/i.test(message);
}

function loadReusableCheckpoints(checkpointPaths, projection) {
  const reusable = new Map();
  for (const checkpointPath of checkpointPaths || []) {
    try {
      const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
      if (
        checkpoint?.projectionFingerprint === projection.fingerprint &&
        typeof checkpoint?.windowId === "string" &&
        checkpoint?.result
      ) {
        reusable.set(checkpoint.windowId, { checkpoint, checkpointPath });
      }
    } catch {
      // Missing or incompatible checkpoints are safely ignored.
    }
  }
  return reusable;
}

class QualityModule {
  constructor(client, aoTaskRunner) {
    this.client = client;
    this.aoTaskRunner = aoTaskRunner;
  }

  async execute({
    translations,
    translationMemory,
    jobId,
    onProgress = null,
    includeAll = false,
    sourceLanguage = translationMemory?.languages?.sourceLanguage || null,
    targetLanguage = translationMemory?.languages?.targetLanguage || null,
    semanticRoleEvidence = [],
    semanticEvidenceFingerprint = null,
    reusableCheckpointPaths = [],
    reusableObservationCheckpointPaths = [],
    isCanceled = null,
  }) {
    const resolvedMemory = translationMemory || {
      fingerprint: null,
      effective: { glossary: [], story: null, style: null, localKnowledge: null },
    };
    const startedAt = Date.now();
    const workspace = qualityWorkspace(jobId);
    const qualityObservationExecution = await runTranslationQualityObservation({
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
    onProgress?.("quality_observation.completed", {
      observationPath: qualityObservationExecution.observationPath,
      planPath: qualityObservationExecution.planPath,
      checkpointPaths: qualityObservationExecution.checkpointPaths,
      summary: qualityObservationExecution.observation.summary,
      coverage: qualityObservationExecution.observation.coverage,
    });
    if (qualityObservationExecution.observation.coverage.ratio < 0.9) {
      const error = new Error(
        `Quality Observer coverage is ${(qualityObservationExecution.observation.coverage.ratio * 100).toFixed(1)}%: ` +
        `${qualityObservationExecution.observation.coverage.unobserved || 0} node(s) received no AO output. ` +
        "The configured AO model is unavailable or stalled; specialist Quality was not started."
      );
      error.code = "AO_QUALITY_COVERAGE_INSUFFICIENT";
      throw error;
    }
    const projection = buildQualityContextProjection({
      translations,
      translationMemory: resolvedMemory,
      includeAll,
      sourceLanguage,
      targetLanguage,
      semanticRoleEvidence,
      semanticEvidenceFingerprint,
      qualityObservation: qualityObservationExecution.observation,
    });
    projection.contractHash = qualityContractHash();
    projection.model = this.aoTaskRunner.settings?.model || null;
    delete projection.fingerprint;
    projection.fingerprint = crypto.createHash("sha256").update(JSON.stringify(projection)).digest("hex");
    const projectionPath = path.join(workspace, "quality_context_projection.json");
    writeJsonAtomic(projectionPath, projection);
    onProgress?.("quality.context_built", {
      projectionPath,
      candidateCount: projection.candidateCount,
      totalTranslations: projection.totalTranslations,
      windowCount: projection.windows.length,
      candidateReasonCounts: projection.candidateReasonCounts,
      candidatePurposeCounts: projection.candidatePurposeCounts,
      semanticCoverage: projection.semanticCoverage,
      inputBytes: projection.windows.reduce((sum, window) => sum + window.inputBytes, 0),
    });

    const results = [];
    const checkpointPaths = [];
    const reusableCheckpoints = loadReusableCheckpoints(reusableCheckpointPaths, projection);
    for (let index = 0; index < projection.windows.length; index += 1) {
      const window = projection.windows[index];
      const input = { ...buildQualityWindowInput(projection, window), jobId };
      const reusable = reusableCheckpoints.get(window.windowId);
      if (reusable) {
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
        continue;
      }
      const windowStartedAt = Date.now();
      onProgress?.("quality.window.started", {
        windowId: window.windowId,
        purpose: window.purpose,
        currentWindow: index + 1,
        totalWindows: projection.windows.length,
        inputBytes: window.inputBytes,
      });
      let result;
      let attemptCount = 0;
      while (attemptCount < 2) {
        attemptCount += 1;
        try {
          result = await this.aoTaskRunner.runQualityReviewAndOptimization({
            ...input,
            jobId: attemptCount === 1 ? jobId : `${jobId}_retry_${attemptCount}`,
          }, {
            outputFilePath: `output/${window.windowId}_result.txt`,
          });
          break;
        } catch (error) {
          if (attemptCount >= 2 || !isTransientQualityFailure(error)) throw error;
          onProgress?.("quality.window.retrying", {
            windowId: window.windowId,
            purpose: window.purpose,
            currentWindow: index + 1,
            totalWindows: projection.windows.length,
            attempt: attemptCount + 1,
            reason: error.message,
          });
        }
      }
      const checkpoint = {
        schemaVersion: 1,
        projectionFingerprint: projection.fingerprint,
        windowId: window.windowId,
        purpose: window.purpose,
        inputBytes: window.inputBytes,
        candidateCount: window.candidates.length,
        attemptCount,
        elapsedMs: Date.now() - windowStartedAt,
        completedAt: new Date().toISOString(),
        result,
      };
      const checkpointPath = path.join(workspace, "checkpoints", `${window.windowId}.json`);
      writeJsonAtomic(checkpointPath, checkpoint);
      checkpointPaths.push(checkpointPath);
      results.push(result);
      onProgress?.("quality.window.completed", {
        windowId: window.windowId,
        purpose: window.purpose,
        completedWindows: index + 1,
        totalWindows: projection.windows.length,
        inputBytes: window.inputBytes,
        elapsedMs: checkpoint.elapsedMs,
        checkpointPath,
        attemptCount,
      });
    }
    return {
      projection,
      projectionPath,
      checkpointPaths,
      results,
      report: assembleQualityReport({ projection, results, elapsedMs: Date.now() - startedAt }),
      qualityObservation: qualityObservationExecution.observation,
      qualityObservationPath: qualityObservationExecution.observationPath,
      qualityObservationCheckpointPaths: qualityObservationExecution.checkpointPaths,
    };
  }

  async run({
    baseUrl,
    mangaId = null,
    translatorId = null,
    chapterId = null,
    glossaryMode = "canonical",
    jobId = null,
    translationMemory = null,
    sourceLanguage = translationMemory?.languages?.sourceLanguage || null,
    targetLanguage = translationMemory?.languages?.targetLanguage || null,
    semanticRoleEvidence = [],
    semanticEvidenceFingerprint = null,
    reusableCheckpointPaths = [],
    reusableObservationCheckpointPaths = [],
    isCanceled = null,
    onProgress = null,
  }) {
    const initial = collectTranslations(await this.client.getScene(baseUrl));
    const execution = await this.execute({
      translations: initial.translations,
      translationMemory,
      jobId,
      onProgress,
      sourceLanguage,
      targetLanguage,
      semanticRoleEvidence,
      semanticEvidenceFingerprint,
      reusableCheckpointPaths,
      reusableObservationCheckpointPaths,
      isCanceled,
    });
    let proposals = execution.report.proposedTranslations;
    const ops = buildQualityPatchOps(new Map(initial.translations.map((entry) => [entry.id, entry])), proposals);
    onProgress?.("quality.apply_started", { revisionCount: proposals.length, operationCount: ops.length });
    if (ops.length > 0) await this.client.applyHistoryBatch({ ops, label: `quality_optimize_${jobId || Date.now()}`, baseUrl });
    const finalData = collectTranslations(await this.client.getScene(baseUrl));
    finalData.translations = applyQualitySemanticAnnotations(finalData.translations, execution.projection);
    const completeness = assessTranslationCompleteness({
      projection: execution.projection,
      finalTranslations: finalData.translations,
      results: execution.results,
    });
    const suspectPages = new Set((execution.qualityObservation.nodes || [])
      .filter((entry) => entry.disposition === "suspect")
      .map((entry) => entry.pageName));
    const revisedNodeIds = new Set(proposals.map((entry) => entry.nodeId));
    for (const translation of finalData.translations) {
      if (revisedNodeIds.has(translation.id)) suspectPages.add(translation.pageName);
    }
    let verificationObservation = { nodes: [], sequenceRisks: [], fingerprint: null };
    let verificationObservationPath = null;
    let verificationCheckpointPaths = [];
    if (suspectPages.size > 0) {
      onProgress?.("quality.verification_started", { pageCount: suspectPages.size });
      const verification = await runTranslationQualityObservation({
        aoTaskRunner: this.aoTaskRunner,
        translations: finalData.translations.filter((entry) => suspectPages.has(entry.pageName)),
        translationMemory,
        jobId: `${jobId || "quality"}_verification`,
        sourceLanguage,
        targetLanguage,
        isCanceled,
        onProgress,
      });
      verificationObservation = verification.observation;
      verificationObservationPath = verification.observationPath;
      verificationCheckpointPaths = verification.checkpointPaths;
      onProgress?.("quality.verification_completed", {
        observationPath: verificationObservationPath,
        summary: verificationObservation.summary,
      });
    }
    let finalVerification = buildFinalVerification({
      initialObservation: execution.qualityObservation,
      verificationObservation,
      proposedTranslations: proposals,
    });
    let repairRoundCount = 1;
    if (finalVerification.blockingIssues.length > 0 && proposals.length > 0) {
      repairRoundCount = 2;
      onProgress?.("quality.repair_round_started", { round: 2, pageCount: suspectPages.size });
      const secondRound = await this.execute({
        translations: finalData.translations.filter((entry) => suspectPages.has(entry.pageName)),
        translationMemory,
        jobId: `${jobId || "quality"}_repair_2`,
        onProgress,
        sourceLanguage,
        targetLanguage,
        isCanceled,
      });
      const secondProposals = secondRound.report.proposedTranslations;
      const secondOps = buildQualityPatchOps(
        new Map(finalData.translations.map((entry) => [entry.id, entry])),
        secondProposals
      );
      if (secondOps.length > 0) {
        await this.client.applyHistoryBatch({ ops: secondOps, label: `quality_repair_2_${jobId || Date.now()}`, baseUrl });
        const refreshed = collectTranslations(await this.client.getScene(baseUrl));
        finalData.translations = applyQualitySemanticAnnotations(refreshed.translations, execution.projection);
      }
      proposals = [...proposals, ...secondProposals];
      const secondVerification = await runTranslationQualityObservation({
        aoTaskRunner: this.aoTaskRunner,
        translations: finalData.translations.filter((entry) => suspectPages.has(entry.pageName)),
        translationMemory,
        jobId: `${jobId || "quality"}_verification_2`,
        sourceLanguage,
        targetLanguage,
        isCanceled,
        onProgress,
      });
      verificationObservation = secondVerification.observation;
      verificationObservationPath = secondVerification.observationPath;
      verificationCheckpointPaths.push(...secondVerification.checkpointPaths);
      finalVerification = buildFinalVerification({
        initialObservation: execution.qualityObservation,
        verificationObservation,
        proposedTranslations: proposals,
      });
      onProgress?.("quality.repair_round_completed", {
        round: 2,
        revisionCount: secondProposals.length,
        blockingIssueCount: finalVerification.blockingIssues.length,
      });
    }
    const completenessReport = applyCompletenessGate(execution.report, completeness);
    const finalStatus = completeness.unresolvedCount > 0 || finalVerification.status === "failed"
      ? "failed"
      : "passed";
    const finalReport = {
      ...completenessReport,
      status: finalStatus,
      overall: finalStatus === "passed" ? "pass" : "fail",
      score: finalVerification.score,
      finalScore: finalVerification.score,
      discoveredFindings: [...(execution.report.issues || []), ...(execution.report.warnings || [])],
      appliedRevisions: proposals,
      finalVerification,
      blockingIssues: finalVerification.blockingIssues,
      repairRoundCount,
    };
    const reportPath = path.join(qualityWorkspace(jobId), "quality_report.json");
    const qualityReviewPackage = buildQualityReviewPackage({
      translations: finalData.translations,
      finalVerification,
      proposedTranslations: proposals,
      qualityObservation: execution.qualityObservation,
    });
    const reviewPackagePath = path.join(qualityWorkspace(jobId), "quality_review_package.json");
    writeJsonAtomic(reviewPackagePath, qualityReviewPackage);
    const persisted = {
      generatedAt: new Date().toISOString(), mangaId, translatorId, chapterId, glossaryMode,
      translationMemoryFingerprint: translationMemory?.fingerprint || null,
      ...finalReport,
    };
    writeJsonAtomic(reportPath, persisted);
    return {
      ...finalReport,
      reportPath,
      reviewPackagePath,
      projectionPath: execution.projectionPath,
      checkpointPaths: execution.checkpointPaths,
      optimizedTranslations: proposals,
      qualityObservation: execution.qualityObservation,
      qualityObservationPath: execution.qualityObservationPath,
      qualityObservationCheckpointPaths: execution.qualityObservationCheckpointPaths,
      verificationObservation,
      verificationObservationPath,
      verificationCheckpointPaths,
      finalTranslations: finalData.translations,
      translationMemoryFingerprint: translationMemory?.fingerprint || null,
    };
  }

  async runPreview({ mangaId = null, translatorId = null, chapterId = null, glossaryMode = "canonical", jobId = null, translations = [], translationMemory = null, sourceLanguage = translationMemory?.languages?.sourceLanguage || null, targetLanguage = translationMemory?.languages?.targetLanguage || null }) {
    const originalTranslations = normalizePreviewTranslations(translations);
    const execution = await this.execute({ translations: originalTranslations, translationMemory, jobId: jobId || `quality_preview_${Date.now()}`, sourceLanguage, targetLanguage });
    const revisedTranslations = applyProposalsToTranslations(originalTranslations, execution.report.proposedTranslations);
    const completeness = assessTranslationCompleteness({ projection: execution.projection, finalTranslations: revisedTranslations, results: execution.results });
    const suspectPages = new Set((execution.qualityObservation.nodes || []).filter((entry) => entry.disposition === "suspect").map((entry) => entry.pageName));
    const verification = suspectPages.size > 0 ? await runTranslationQualityObservation({
      aoTaskRunner: this.aoTaskRunner,
      translations: revisedTranslations.filter((entry) => suspectPages.has(entry.pageName)),
      translationMemory,
      jobId: `${jobId || "quality_preview"}_verification`,
      sourceLanguage,
      targetLanguage,
    }) : { observation: { nodes: [], sequenceRisks: [] } };
    const finalVerification = buildFinalVerification({
      initialObservation: execution.qualityObservation,
      verificationObservation: verification.observation,
      proposedTranslations: execution.report.proposedTranslations,
    });
    const completenessReport = applyCompletenessGate(execution.report, completeness);
    const finalStatus = completeness.unresolvedCount > 0 || finalVerification.status === "failed"
      ? "failed"
      : "passed";
    const finalReport = {
      ...completenessReport,
      status: finalStatus,
      overall: finalStatus === "passed" ? "pass" : "fail",
      finalScore: finalVerification.score,
      finalVerification,
      blockingIssues: finalVerification.blockingIssues,
    };
    return {
      ...finalReport,
      reportPath: null,
      projectionPath: execution.projectionPath,
      checkpointPaths: execution.checkpointPaths,
      mangaId, translatorId, chapterId, glossaryMode,
      originalTranslations,
      revisedTranslations,
      optimizedTranslations: execution.report.proposedTranslations,
      translationMemoryFingerprint: translationMemory?.fingerprint || null,
      projection: execution.projection,
      qualityObservation: execution.qualityObservation,
    };
  }
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
};
