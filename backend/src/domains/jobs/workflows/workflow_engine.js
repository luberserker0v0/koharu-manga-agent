const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config, paths } = require("../../../config");
const { writeJsonAtomic } = require("../../../infrastructure/filesystem/json_file");
const { syncMangaManagementBinding } = require("../../knowledge/registry/knowledge_paths");
const {
  finalizeKnowledgeRevision,
  prepareKnowledgeRevision,
  rollbackKnowledgeRevision,
} = require("../../knowledge/revisions/knowledge_revisions");
const {
  buildBootstrapPipelineSteps,
  buildExportPipelineSteps,
  buildTranslationPatchOps,
  createRebuiltProjectName,
  matchPostEditDocumentToScene,
  reorderRenderedZip,
  startPipeline,
  uploadPages,
} = require("../../post_edit/export/post_edit_export");
const {
  ensureChapterObservation,
  runReferenceDeepReview,
} = require("../../reference/observation/reference_observation");
const { loadCanonicalGlossary, loadStoryContext } = require("../../knowledge/assets/knowledge_assets");
const { collectTranslations } = require("../../translation/quality/quality");
const { buildLearningEvidenceSnapshot } = require("../../knowledge/learning/learning_evidence");
const {
  applyQualitySemanticAnnotations,
  buildQualityContextProjection,
} = require("../../translation/quality/quality_projection");
const { ensureTranslationChapterObservation } = require("../../translation/execution/translation_chapter_observation");
const { ensureReferenceLocaleProjection } = require("../../reference/locale/reference_locale_projection");
const {
  assertTranslationMemoryReady,
  buildTranslationSystemPrompt,
  composeTranslationMemory,
} = require("../../translation/memory/translation_memory");
const { resolveTranslationModePolicy } = require("../../translation/modes/translation_modes");
const { resolvePipelineProfile } = require("../../translation/pipeline/pipeline_profiles");
const { resolveExportOutputDir } = require("../../translation/execution/export_output_path");
const { buildTextRegionCorrectionOps } = require("../../translation/text_regions/text_region_patch_ops");
const { isMachineTranslationTarget } = require("../../../integrations/koharu/translation/translation_targets");
const { deleteChapterLearningData } = require("../../knowledge/learning/knowledge");
const { buildPipelinePlan, resolveReferenceUsage, translationSceneFingerprint } = require("./workflow_helpers");
const { PipelineMetricsCollector } = require("../../../integrations/koharu/pipeline/pipeline_metrics");
const projectOrchestrator = require("../../../integrations/koharu/pipeline/project_orchestrator");

function resolveDeepAuditOutputDir(sourceJob, jobId) {
  return resolveExportOutputDir({
    mangaId: sourceJob.payload?.mangaId,
    translatorId: sourceJob.payload?.translatorId,
    chapterId: sourceJob.payload?.chapterId,
    jobId,
    variant: "deep-audit",
  });
}

function summarizePipelineTranslationTarget(target) {
  if (!target || typeof target !== "object") return null;
  return {
    kind: target.kind || null,
    providerId: target.providerId || null,
    modelId: target.modelId || null,
    targetKind: target.targetKind || null,
  };
}

function createTranslationPipelineMetrics(ctx) {
  return new PipelineMetricsCollector({
    operationId: ctx.setup.operationId,
    translationTarget: summarizePipelineTranslationTarget(ctx.setup.translationTarget),
    generationSettings: ctx.setup.generationSettings || null,
    lmStudio: ctx.setup.lmStudio || null,
    systemPrompt: ctx.setup.systemPromptMetadata || null,
    pipelineProfile: ctx.setup.pipelineProfile || null,
  });
}

function observeTranslationPipeline(metrics, hooks, progress) {
  metrics.observe(progress);
  hooks.emit("pipeline.progress", progress);
}

function completedPipelineProgress(ctx, pipelinePlan, pipeline, totalPagesHint) {
  const totalPages = pipeline.summary?.totalPages || totalPagesHint;
  const engineIndex = pipelinePlan.length > 0 ? pipelinePlan.length - 1 : null;
  const currentPageName = typeof totalPages === "number" && Array.isArray(ctx.sourceImagePaths)
    ? path.basename(ctx.sourceImagePaths[totalPages - 1] || "") || null
    : null;
  return {
    operationId: ctx.setup.operationId,
    status: "completed",
    progress: 1,
    engine: engineIndex === null ? null : pipelinePlan[engineIndex],
    engineIndex,
    engineStatus: "completed",
    completedPages: totalPages || null,
    totalPages: totalPages || null,
    currentPageIndex: totalPages || null,
    currentPageName,
    progressSemanticsVersion: 2,
    telemetry: { source: "backend_terminal", rawStatus: pipeline.summary?.finalStatus || "completed" },
  };
}

function buildCorrectionCompletionSteps(engines) {
  const steps = [engines.translate, engines.clean, engines.render].filter(Boolean);
  if (![engines.translate, engines.clean, engines.render].every((engine) => steps.includes(engine))) {
    throw new Error("Text-region correction requires translate, clean, and render engines.");
  }
  return steps;
}

function completeTranslationPipelineMetrics(metrics, status, pipeline = null, error = null) {
  return metrics.complete({
    status,
    errorCode: error?.code || error?.pipelineStatus || null,
    pipeline: pipeline ? {
      finalStatus: pipeline.summary?.finalStatus || null,
      recovered: pipeline.recovered === true,
      reason: pipeline.reason || null,
    } : null,
  });
}

class WorkflowEngine {
  constructor(deps) {
    Object.assign(this, {
      sourcePreflightModule: deps.sourcePreflightModule,
      projectSetup: deps.projectSetup,
      pipelineMonitor: deps.pipelineMonitor,
      referenceExtractionModule: deps.referenceExtractionModule,
      referenceIngestionModule: deps.referenceIngestionModule,
      referenceBilingualEnrichmentModule: deps.referenceBilingualEnrichmentModule,
      qualityModule: deps.qualityModule,
      knowledgeModule: deps.knowledgeModule,
      translationDeepAuditModule: deps.translationDeepAuditModule,
      exportModule: deps.exportModule,
      projectLifecycle: deps.projectLifecycle,
      postEditWorkspaceModule: deps.postEditWorkspaceModule,
      regionSnapshotRepository: deps.regionSnapshotRepository,
      jobStore: deps.jobStore,
    });
    this.translationMemoryComposer = deps.translationMemoryComposer || composeTranslationMemory;
    this.translationPublicationService = deps.translationPublicationService || null;
  }

  async runReferenceExtractionJob(payload, hooks) {
    const baseUrl = payload.baseUrl || config.api.baseUrl;
    const targetLanguage = payload.targetLanguage || config.defaults.targetLanguage;
    hooks.setStage("running", "extract_reference");
    const result = await this.referenceExtractionModule.run({
      referenceSetId: payload.referenceSetId,
      baseUrl,
      targetLanguage,
      isCanceled: hooks.isCanceled,
    });
    if (payload.mangaId) this._syncReferenceExtractionBinding(payload, targetLanguage);
    const completedResult = this._buildReferenceExtractionResult(payload, result);
    hooks.emit("reference_extraction.completed", completedResult);
    return completedResult;
  }

  _syncReferenceExtractionBinding(payload, targetLanguage) {
    syncMangaManagementBinding({
      mangaId: payload.mangaId,
      label: payload.mangaLabel || null,
      translatorId: payload.translatorId || null,
      translatorLabel: payload.translatorLabel || payload.translator || null,
      language: targetLanguage,
      chapterId: payload.chapterId || null,
      chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
    });
  }

  _buildReferenceExtractionResult(payload, result) {
    return {
      ...result,
      mangaId: payload.mangaId || null,
      translatorId: payload.translatorId || null,
      translatorLabel: payload.translatorLabel || payload.translator || null,
      chapterId: payload.chapterId || null,
      chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
      translator: payload.translator || null,
      workflowId: payload.workflowId || null,
    };
  }

  async runReferenceObservationJob(payload, hooks) {
    hooks.setStage("running", "reference_observation");
    const result = await ensureChapterObservation({
      aoTaskRunner: this.referenceIngestionModule.aoTaskRunner,
      referenceSetId: payload.referenceSetId,
      chapterId: payload.chapterId,
      chapterTitle: payload.chapterTitle || null,
      glossary: payload.mangaId ? loadCanonicalGlossary(payload.mangaId, payload.translatorId || null) : null,
      storyContext: payload.mangaId ? loadStoryContext(payload.mangaId, payload.translatorId || null) : null,
      force: payload.force === true,
      isCanceled: hooks.isCanceled,
      onProgress: (progress) => hooks.emit("reference_observation.progress", progress),
    });
    return {
      referenceSetId: payload.referenceSetId,
      chapterId: payload.chapterId,
      reused: result.reused,
      observationPath: result.observationPath,
      observation: result.observation,
    };
  }

  async runReferenceDeepReviewJob(payload, hooks) {
    hooks.setStage("running", "reference_deep_review");
    return runReferenceDeepReview({
      aoTaskRunner: this.referenceIngestionModule.aoTaskRunner,
      referenceSetId: payload.referenceSetId,
      nodeKeys: payload.nodeKeys || [],
      reviewReason: payload.reviewReason,
      compactMemory: payload.compactMemory || null,
      isCanceled: hooks.isCanceled,
      onProgress: (progress) => hooks.emit("reference_deep_review.progress", progress),
    });
  }

  async runReferenceBilingualEvidenceWindowJob(payload, hooks) {
    if (!this.referenceBilingualEnrichmentModule) {
      throw new Error("Reference bilingual enrichment module is not configured.");
    }
    hooks.setStage("running", "bilingual_evidence_window");
    return this.referenceBilingualEnrichmentModule.runWindow(
      {
        ...payload,
        jobId: hooks.jobId,
      },
      {
        isCanceled: hooks.isCanceled,
        onProgress: (progress) => {
          hooks.setStage("running", progress.stage || "bilingual_evidence_window");
          hooks.emit("reference_bilingual_enrichment.progress", progress);
        },
      },
    );
  }

  async runReferenceBilingualCommitJob(payload, hooks) {
    if (!this.referenceBilingualEnrichmentModule) {
      throw new Error("Reference bilingual enrichment module is not configured.");
    }
    hooks.setStage("running", "bilingual_commit");
    return this.referenceBilingualEnrichmentModule.commit(payload);
  }

  async runReferenceIngestionAnalysisJob(payload, hooks) {
    return this.runReferenceIngestionPhase(payload, hooks, "analysis");
  }

  async runReferenceIngestionStoryJob(payload, hooks) {
    return this.runReferenceIngestionPhase(payload, hooks, "story");
  }

  async runReferenceIngestionPrepareJob(payload, hooks) {
    if (!this.jobStore) {
      throw new Error("Reference ingestion revision preparation requires a job store.");
    }
    hooks.setStage("running", "reference_ingestion.prepare_revision");
    const plan = prepareKnowledgeRevision({
      store: this.jobStore,
      payload,
      planPath: payload.revisionPlanPath,
    });
    hooks.emit("reference_ingestion.prepare.completed", {
      revisionId: plan.revisionId,
      staleRevisionIds: plan.staleRevisions.map((revision) => revision.id),
      restoredFromRevisionId: plan.restoredFromRevisionId,
      restoreSkippedReason: plan.restoreSkippedReason || null,
    });
    return {
      phase: "prepare",
      workflowId: payload.workflowId || null,
      mangaId: payload.mangaId,
      translatorId: payload.translatorId || null,
      chapterId: payload.chapterId,
      revisionPlanPath: payload.revisionPlanPath,
      revisionId: plan.revisionId,
      staleRevisionIds: plan.staleRevisions.map((revision) => revision.id),
      restoredFromRevisionId: plan.restoredFromRevisionId,
      restoreSkippedReason: plan.restoreSkippedReason || null,
    };
  }

  async runReferenceIngestionCommitJob(payload, hooks) {
    await this.runReferenceIngestionPrepareJob(payload, hooks);
    return this.runReferenceIngestionPhase(payload, hooks, "commit");
  }

  async runReferenceIngestionPhase(payload, hooks, phase) {
    hooks.setStage("running", "reference_ingestion");
    const referenceUsage = resolveReferenceUsage(payload);
    let result;
    try {
      result = await this._runReferenceIngestionModule(payload, hooks, phase, referenceUsage);
    } catch (error) {
      if (phase === "commit") rollbackKnowledgeRevision(payload.revisionPlanPath);
      throw error;
    }
    const revisionResult =
      phase === "commit"
        ? finalizeKnowledgeRevision({
            store: this.jobStore,
            planPath: payload.revisionPlanPath,
            analysisArtifactPath: payload.analysisArtifactPath || null,
          })
        : null;
    const completedResult = this._buildReferenceIngestionCompletedResult(
      payload,
      result,
      referenceUsage,
      revisionResult,
    );
    hooks.emit(`reference_ingestion.${phase}.completed`, completedResult);
    return completedResult;
  }

  async _runReferenceIngestionModule(payload, hooks, phase, referenceUsage) {
    let currentProgressStage = "reference_ingestion";
    return this.referenceIngestionModule.run({
      referenceSetId: payload.referenceSetId,
      mangaId: payload.mangaId,
      mangaLabel: payload.mangaLabel || null,
      translatorId: payload.translatorId || null,
      translatorLabel: payload.translatorLabel || payload.translator || null,
      chapterId: payload.chapterId || null,
      chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
      glossaryMode: referenceUsage.glossaryMode,
      useForTerminology: referenceUsage.useForTerminology,
      useForStyle: referenceUsage.useForStyle,
      analysisDepth: payload.analysisDepth || "quick_read",
      phase,
      analysisArtifactPath: payload.analysisArtifactPath || null,
      storyArtifactPath: payload.storyArtifactPath || null,
      isCanceled: hooks.isCanceled,
      onProgress: (progress) =>
        this._handleReferenceIngestionProgress(hooks, progress, currentProgressStage, (stage) => {
          currentProgressStage = stage;
        }),
    });
  }

  _handleReferenceIngestionProgress(hooks, progress, currentProgressStage, setCurrent) {
    const nextStage = progress?.stage || "reference_ingestion";
    if (nextStage !== currentProgressStage) {
      setCurrent(nextStage);
      hooks.setStage("running", nextStage);
    }
    hooks.emit("reference_ingestion.progress", progress);
  }

  _buildReferenceIngestionCompletedResult(payload, result, referenceUsage, revisionResult) {
    return {
      ...result,
      mangaId: payload.mangaId || result.mangaId || null,
      translatorId: payload.translatorId || result.translatorId || null,
      translatorLabel: payload.translatorLabel || payload.translator || null,
      chapterId: payload.chapterId || result.chapterId || null,
      chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
      translator: payload.translator || null,
      workflowId: payload.workflowId || null,
      useForTerminology: referenceUsage.useForTerminology,
      useForStyle: referenceUsage.useForStyle,
      glossaryMode: referenceUsage.glossaryMode,
      analysisDepth: payload.analysisDepth || "quick_read",
      knowledgeRevision: revisionResult?.revision || null,
      staleKnowledgeRevisions: revisionResult?.staleRevisions || [],
      restoredFromRevisionId: revisionResult?.restoredFromRevisionId || null,
      revisionPlanPath: payload.revisionPlanPath || null,
    };
  }

  async runTranslationJob(payload, hooks) {
    const ctx = { payload, hooks };
    this._initTranslationBasics(ctx);
    this._initTranslationPolicy(ctx);
    await this._resolveTranslationMemoryAndSnapshot(ctx);
    if (ctx.resume) {
      await this._resumeTranslationProject(ctx);
    } else if (ctx.textRegionCorrection) {
      await this._setupTextRegionCorrectionProjectAndPipeline(ctx);
    } else {
      await this._setupTranslationProjectAndPipeline(ctx);
    }
    this._validateSceneClient(ctx);
    await this._observeTranslationChapter(ctx);
    await this._runTranslationQualityIfNeeded(ctx);
    this._emitQualityDegradedIfNeeded(ctx);
    await this._finalizeTranslationSceneAndSnapshot(ctx);
    this._persistTranslationRegionSnapshot(ctx);
    if (ctx.shouldCommitKnowledge) this._buildTranslationLearningEvidence(ctx);
    this._createTranslationPostEditDocument(ctx);
    await this._exportTranslation(ctx);
    await this._closeTranslationProject(ctx);
    if (ctx.payload.mangaId) this._syncTranslationBinding(ctx);
    this._publishTranslation(ctx);
    return this._buildTranslationResult(ctx);
  }

  _initTranslationBasics(ctx) {
    const { payload, hooks } = ctx;
    ctx.baseUrl = payload.baseUrl || config.api.baseUrl;
    ctx.targetLanguage = payload.targetLanguage || config.defaults.targetLanguage;
    ctx.exportFormat = payload.exportFormat || config.defaults.exportFormat;
    ctx.outputDir = resolveExportOutputDir({
      mangaId: payload.mangaId,
      translatorId: payload.translatorId,
      chapterId: payload.chapterId,
      jobId: hooks.jobId,
    });
    ctx.glossaryMode = payload.glossaryMode || "canonical";
    ctx.translationMode = payload.translationMode;
    ctx.requestedTranslationTarget = payload.translationTarget || config.translation?.defaultTarget || null;
    ctx.generationOptions = payload.generationOptions || config.translation?.generationOptions || null;
    ctx.lmStudioBaseUrl = config.translation?.lmStudio?.baseUrl || null;
    ctx.translationProxy = ctx.requestedTranslationTarget?.providerId === "openai-compatible"
      ? { providerId: "openai-compatible", baseUrl: config.translation?.lmStudio?.koharuProxyBaseUrl || null }
      : null;
    ctx.machineTranslationRequested = isMachineTranslationTarget(ctx.requestedTranslationTarget);
    ctx.machineTranslationSettings = config.translation?.machineTranslation || {};
  }

  _initTranslationPolicy(ctx) {
    const { payload } = ctx;
    const translationMode = ctx.translationMode;
    const machineTranslationSettings = ctx.machineTranslationSettings;
    const machineTranslationRequested = ctx.machineTranslationRequested;
    ctx.machineTranslationPostEdit =
      machineTranslationRequested &&
      ((translationMode === "reference_style" && machineTranslationSettings.referencePostEdit !== false) ||
        (["local_style", "learning_style"].includes(translationMode) &&
          machineTranslationSettings.learningPostEdit !== false));
    ctx.effectiveQualityRequested = payload.qualityCheck === true || ctx.machineTranslationPostEdit;
    ctx.translationPolicy = resolveTranslationModePolicy(translationMode, ctx.effectiveQualityRequested);
    ctx.revisionTranslation = Boolean(payload.revision?.reason);
    ctx.textRegionCorrection = payload.revision?.reason === "text_region_correction";
    ctx.shouldCommitKnowledge = ctx.translationPolicy.commitKnowledge && !ctx.revisionTranslation;
    ctx.resume = payload.resumeFromTranslation || null;
    ctx.sourcePreflight = null;
    ctx.sourceImages = null;
    ctx.sourceImagePaths = null;
    ctx.translationMemory = null;
    ctx.setup = null;
    ctx.pipeline = null;
    ctx.translationObservation = null;
    ctx.quality = null;
  }

  async _resolveTranslationMemoryAndSnapshot(ctx) {
    this._composeOrResumeTranslationMemory(ctx);
    await this._applyReferenceLocaleProjection(ctx);
    this._persistTranslationMemorySnapshot(ctx);
  }

  _composeOrResumeTranslationMemory(ctx) {
    if (ctx.resume) {
      this._validateResumeMemory(ctx);
    } else {
      this._resolveTranslationSource(ctx);
      this._composeTranslationMemory(ctx);
    }
    assertTranslationMemoryReady(ctx.translationMemory);
  }

  _validateResumeMemory(ctx) {
    const { payload } = ctx;
    const resume = ctx.resume;
    if (!fs.existsSync(resume.translationMemorySnapshotPath || "")) {
      throw new Error("Translation resume requires the original Translation Memory snapshot.");
    }
    ctx.translationMemory = JSON.parse(fs.readFileSync(resume.translationMemorySnapshotPath, "utf8"));
    if (
      ctx.translationMemory.translationMode !== ctx.translationMode ||
      ctx.translationMemory.mangaId !== (payload.mangaId || null) ||
      ctx.translationMemory.translatorId !== (payload.translatorId || null) ||
      (ctx.translationMemory.referenceTranslatorId || null) !== (payload.referenceTranslatorId || null) ||
      ctx.translationMemory.chapterId !== (payload.chapterId || null)
    ) {
      throw new Error("Translation resume snapshot does not match the requested translation context.");
    }
  }

  _resolveTranslationSource(ctx) {
    const { payload, hooks } = ctx;
    if (payload.sourcePreflightId && this.sourcePreflightModule) {
      const sourceSelection = this.sourcePreflightModule.resolveSourceSelection(
        payload.sourcePreflightId,
        ctx.revisionTranslation ? payload.sourceImageIds : null,
      );
      ctx.sourcePreflight = sourceSelection.manifest;
      ctx.sourceImages = sourceSelection.images;
      ctx.sourceImagePaths = sourceSelection.images.map((image) => image.orderedPath);
      hooks.emit("source_preflight.resolved", {
        preflightId: ctx.sourcePreflight.preflightId,
        acceptedCount: ctx.sourceImagePaths.length,
        convertedCount: ctx.sourcePreflight.summary.convertedCount,
        orderChanged: ctx.sourcePreflight.orderChanged,
        sourceImageIds: sourceSelection.images.map((image) => image.id),
      });
    } else if (Array.isArray(payload.sourceImagePaths) && payload.sourceImagePaths.length > 0) {
      ctx.sourceImagePaths = payload.sourceImagePaths;
    } else {
      throw new Error("Translation job requires a valid sourcePreflightId.");
    }
  }

  _composeTranslationMemory(ctx) {
    const { payload } = ctx;
    ctx.translationMemory = this.translationMemoryComposer({
      translationMode: ctx.translationMode,
      qualityCheck: ctx.effectiveQualityRequested,
      mangaId: payload.mangaId || null,
      translatorId: payload.translatorId || null,
      referenceTranslatorId: payload.referenceTranslatorId || null,
      chapterId: payload.chapterId || null,
      chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
      sourceChapterId: payload.sourceChapterId || null,
      glossaryMode: ctx.glossaryMode,
      sourceLanguage: payload.sourceLanguage || null,
      targetLanguage: ctx.targetLanguage,
    });
  }

  async _applyReferenceLocaleProjection(ctx) {
    const { payload, hooks } = ctx;
    if (!ctx.translationPolicy.useReferenceMemory || ctx.resume) return;
    hooks.setStage("running", "reference_locale_projection");
    const localeProjection = await ensureReferenceLocaleProjection({
      translationMemory: ctx.translationMemory,
      aoTaskRunner: this.qualityModule?.aoTaskRunner,
      jobId: hooks.jobId,
      isCanceled: hooks.isCanceled,
    });
    ctx.translationMemory = localeProjection.translationMemory;
    if (localeProjection.projectionPath) {
      hooks.emit("reference_locale_projection.completed", {
        path: localeProjection.projectionPath,
        fingerprint: localeProjection.projection?.fingerprint || null,
        reused: localeProjection.reused,
        referenceLanguage: ctx.translationMemory.languages.referenceLanguage,
        targetLanguage: ctx.translationMemory.languages.targetLanguage,
      });
      this.jobStore?.addArtifact?.(hooks.jobId, "reference_locale_projection", localeProjection.projectionPath, {
        fingerprint: localeProjection.projection?.fingerprint || null,
        reused: localeProjection.reused,
      });
    }
  }

  _persistTranslationMemorySnapshot(ctx) {
    const { payload, hooks } = ctx;
    const translationMemory = ctx.translationMemory;
    const systemPrompt = buildTranslationSystemPrompt(translationMemory, payload.instructions);
    ctx.systemPrompt = systemPrompt.text;
    ctx.systemPromptSource = systemPrompt.source;
    ctx.translationWorkspace = path.join(
      paths.workspaceRoot,
      hooks.jobId || `translation_${Date.now()}`,
      "translation",
    );
    ctx.translationMemorySnapshotPath = path.join(ctx.translationWorkspace, "translation_memory_snapshot.json");
    writeJsonAtomic(ctx.translationMemorySnapshotPath, translationMemory);
    hooks.emit("translation_memory.built", {
      translationMode: ctx.translationMode,
      fingerprint: translationMemory.fingerprint,
      policy: ctx.translationPolicy,
      chapterMapping: translationMemory.chapterMapping,
      usage: translationMemory.usage,
      warnings: translationMemory.warnings,
      path: ctx.translationMemorySnapshotPath,
    });
  }

  async _resumeTranslationProject(ctx) {
    const { payload, hooks } = ctx;
    const baseUrl = ctx.baseUrl;
    const resume = ctx.resume;
    hooks.setStage("running", "resume_quality");
    const client = this.projectLifecycle?.client;
    if (!client || typeof client.listProjects !== "function" || typeof client.openProject !== "function") {
      throw new Error("Translation resume requires Koharu project access.");
    }
    const project = await this._findResumeTranslationProject(client, baseUrl, resume);
    await client.openProject(project.id, baseUrl);
    this._applyResumeTranslationProject(ctx, resume, project, hooks);
  }

  async _findResumeTranslationProject(client, baseUrl, resume) {
    let projects;
    try {
      projects = await client.listProjects(baseUrl);
    } catch (cause) {
      const error = new Error(`Koharu is unavailable at ${baseUrl} while resuming translation quality.`);
      error.code = "koharu_unavailable";
      error.cause = cause;
      throw error;
    }
    const project = projects.find((entry) => entry.name === resume.projectName);
    if (!project) {
      throw new Error(`Translation resume project is unavailable: ${resume.projectName}.`);
    }
    return project;
  }

  _applyResumeTranslationProject(ctx, resume, project, hooks) {
    ctx.setup = {
      projectName: project.name,
      operationId: resume.operationId || null,
      engines: resume.engines || {},
      steps: resume.steps || [],
      pipelineProfile: resume.pipelineProfile || null,
      resumed: true,
    };
    ctx.pipeline = {
      resumed: true,
      sourceJobId: resume.sourceJobId,
      summary: { finalStatus: "completed" },
    };
    hooks.emit("translation.resumed", {
      sourceJobId: resume.sourceJobId,
      projectId: project.id,
      projectName: project.name,
      resumedAtStage: "quality_context",
    });
  }

  async _setupTranslationProjectAndPipeline(ctx) {
    ctx.hooks.setStage("running", "setup_project");
    ctx.setup = await this.projectSetup.run(this._translationProjectOptions(ctx));
    this._emitTranslationSetup(ctx);
    ctx.hooks.setStage("waiting_pipeline", "monitor_pipeline");
    ctx.pipeline = await this._monitorTranslationPipeline(ctx, ctx.hooks);
  }

  _translationProjectOptions(ctx) {
    return {
      targetLanguage: ctx.targetLanguage,
      baseUrl: ctx.baseUrl,
      systemPrompt: ctx.machineTranslationRequested ? null : ctx.systemPrompt,
      systemPromptSource: ctx.machineTranslationRequested ? "none" : ctx.systemPromptSource,
      sourceImagePaths: ctx.sourceImagePaths,
      translationTarget: ctx.requestedTranslationTarget,
      generationOptions: ctx.generationOptions,
      lmStudioBaseUrl: ctx.lmStudioBaseUrl,
      translationProxy: ctx.translationProxy,
      translationMode: ctx.translationMode,
    };
  }

  _emitTranslationSetup(ctx) {
    ctx.hooks.emit("translation_target.selected", {
      kind: ctx.setup.translationTarget?.kind || null,
      providerId: ctx.setup.translationTarget?.providerId || null,
      modelId: ctx.setup.translationTarget?.modelId || null,
      targetKind: ctx.setup.translationTarget?.targetKind || null,
      referencePostEdit: ctx.machineTranslationPostEdit,
    });
    ctx.hooks.emit("setup.completed", ctx.setup);
  }

  async _setupTextRegionCorrectionProjectAndPipeline(ctx) {
    ctx.hooks.setStage("running", "setup_correction_project");
    ctx.setup = await this.projectSetup.prepare(this._translationProjectOptions(ctx));
    await this._runTextRegionCorrectionBootstrap(ctx);
    await this._applyTextRegionCorrections(ctx);
    await this._startTextRegionCorrectionCompletion(ctx);
    this._emitTranslationSetup(ctx);
    ctx.hooks.setStage("waiting_pipeline", "monitor_pipeline");
    ctx.pipeline = await this._monitorTranslationPipeline(ctx, ctx.hooks);
  }

  async _runTextRegionCorrectionBootstrap(ctx) {
    const steps = buildBootstrapPipelineSteps(ctx.setup.engines);
    const started = await startPipeline(steps, ctx.targetLanguage, ctx.baseUrl);
    ctx.hooks.setStage("waiting_pipeline", "correction_ocr");
    await this.pipelineMonitor.run({
      operationId: started.operationId,
      baseUrl: ctx.baseUrl,
      pipelinePlan: ["detect", "fontDetect", "segment", "bubbleSegment", "ocr"],
      totalPagesHint: ctx.sourceImagePaths.length,
      onProgress: (progress) => ctx.hooks.emit("pipeline.progress", progress),
      isCanceled: ctx.hooks.isCanceled,
    });
    ctx.setup.steps = steps;
  }

  _loadTextRegionCorrectionSnapshot(ctx) {
    const sourceJob = this.jobStore.getJob(ctx.payload.regionCorrections.sourceJobId);
    const snapshot = sourceJob && this.regionSnapshotRepository?.loadForJob(this.jobStore, sourceJob);
    if (snapshot) return snapshot;
    const error = new Error("The correction source text-region snapshot is unavailable.");
    error.code = "text_region_snapshot_unavailable";
    error.statusCode = 409;
    throw error;
  }

  async _applyTextRegionCorrections(ctx) {
    ctx.hooks.setStage("running", "apply_text_region_corrections");
    const snapshot = this._loadTextRegionCorrectionSnapshot(ctx);
    const scene = await this.projectLifecycle.client.getScene(ctx.baseUrl);
    const ops = buildTextRegionCorrectionOps(snapshot, ctx.payload.regionCorrections, scene);
    await this.projectLifecycle.client.applyHistoryBatch({
      ops, label: `text_region_correction_${ctx.hooks.jobId}`, baseUrl: ctx.baseUrl,
    });
    ctx.hooks.emit("text_region_correction.applied", { updatedRegions: ops.length });
  }

  async _startTextRegionCorrectionCompletion(ctx) {
    const steps = buildCorrectionCompletionSteps(ctx.setup.engines);
    const started = await startPipeline(
      steps, ctx.targetLanguage, ctx.baseUrl,
      ctx.machineTranslationRequested ? null : ctx.systemPrompt,
    );
    ctx.setup.operationId = started.operationId;
    ctx.setup.steps = [...ctx.setup.steps, ...steps];
    ctx.pipelinePlan = ["translate", "clean", "render"];
  }

  async _monitorTranslationPipeline(ctx, hooks) {
    const baseUrl = ctx.baseUrl;
    const pipelinePlan = ctx.pipelinePlan || buildPipelinePlan(ctx.setup.engines);
    const totalPagesHint = Array.isArray(ctx.sourceImagePaths) ? ctx.sourceImagePaths.length : null;
    const metrics = createTranslationPipelineMetrics(ctx);
    try {
      const pipeline = await this.pipelineMonitor.run({
        operationId: ctx.setup.operationId,
        baseUrl,
        pipelinePlan,
        totalPagesHint,
        onProgress: (progress) => observeTranslationPipeline(metrics, hooks, progress),
        isCanceled: hooks.isCanceled,
      });
      observeTranslationPipeline(metrics, hooks, completedPipelineProgress(ctx, pipelinePlan, pipeline, totalPagesHint));
      const summary = await this._publishTranslationPipelineMetrics(ctx, metrics, hooks, "completed", pipeline);
      hooks.emit("pipeline.completed", pipeline);
      return { ...pipeline, metrics: summary };
    } catch (error) {
      const status = error?.code === "job_canceled" ? "canceled" : "failed";
      await this._publishTranslationPipelineMetrics(ctx, metrics, hooks, status, null, error);
      throw error;
    }
  }

  async _publishTranslationPipelineMetrics(ctx, metrics, hooks, status, pipeline, error = null) {
    const result = completeTranslationPipelineMetrics(metrics, status, pipeline, error);
    if (typeof this.projectSetup.refreshRuntimeMetadata === "function") {
      ctx.setup = await this.projectSetup.refreshRuntimeMetadata(ctx.setup, ctx.lmStudioBaseUrl);
      metrics.setExecutionMetadata({
        generationSettings: ctx.setup.generationSettings,
        lmStudio: ctx.setup.lmStudio,
      });
    }
    hooks.emit("pipeline.metrics", result);
    return result;
  }

  _validateSceneClient(ctx) {
    const sceneClient = this.projectLifecycle?.client || this.qualityModule?.client;
    if (!sceneClient || typeof sceneClient.getScene !== "function") {
      throw new Error("Translation workflow cannot read the Koharu scene.");
    }
    ctx.sceneClient = sceneClient;
  }

  async _observeTranslationChapter(ctx) {
    const { payload, hooks } = ctx;
    const translationMode = ctx.translationMode;
    const translationPolicy = ctx.translationPolicy;
    const shouldObserveTranslation =
      translationMode !== "quick" && (translationPolicy.runQuality || translationPolicy.commitKnowledge);
    const observationRunner = this.qualityModule?.aoTaskRunner || null;
    if (shouldObserveTranslation && observationRunner?.runChapterObservation) {
      await this._runTranslationObservation(ctx, payload, hooks, observationRunner);
    } else if (shouldObserveTranslation) {
      hooks.emit("translation_observation.unavailable", {
        reason: "chapter_observer_not_configured",
      });
    }
    ctx.shouldObserveTranslation = shouldObserveTranslation;
  }

  async _runTranslationObservation(ctx, payload, hooks, observationRunner) {
    const baseUrl = ctx.baseUrl;
    hooks.setStage("running", "translation_chapter_observation");
    const observedScene = collectTranslations(await ctx.sceneClient.getScene(baseUrl));
    ctx.translationObservation = await ensureTranslationChapterObservation({
      aoTaskRunner: observationRunner,
      translations: observedScene.translations,
      mangaId: payload.mangaId || null,
      chapterId: payload.chapterId || null,
      chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
      contentLanguage: payload.sourceLanguage || ctx.translationMemory.languages?.sourceLanguage || null,
      translationMemory: ctx.translationMemory,
      isCanceled: hooks.isCanceled,
      onProgress: (progress) => hooks.emit("translation_observation.progress", progress),
    });
    this._emitTranslationObservationCompleted(ctx, hooks);
  }

  _emitTranslationObservationCompleted(ctx, hooks) {
    this.jobStore?.addArtifact?.(
      hooks.jobId,
      "translation_chapter_observation",
      ctx.translationObservation.observationPath,
      {
        fingerprint: ctx.translationObservation.observation.fingerprint,
        reused: ctx.translationObservation.reused,
        coverage: ctx.translationObservation.observation.coverage,
      },
    );
    hooks.emit("translation_observation.completed", {
      path: ctx.translationObservation.observationPath,
      fingerprint: ctx.translationObservation.observation.fingerprint,
      reused: ctx.translationObservation.reused,
      coverage: ctx.translationObservation.observation.coverage,
    });
  }

  async _runTranslationQualityIfNeeded(ctx) {
    const { payload, hooks } = ctx;
    const translationPolicy = ctx.translationPolicy;
    if (!translationPolicy.runQuality) return;
    const resume = ctx.resume;
    if (resume?.resumeAtStage === "learning_evidence") {
      this._reuseQualityFromResume(ctx);
    } else {
      await this._runTranslationQualityModule(ctx);
    }
  }

  _reuseQualityFromResume(ctx) {
    const { payload, hooks, resume } = ctx;
    if (!fs.existsSync(resume.qualityReportPath || "") || !fs.existsSync(resume.qualityProjectionPath || "")) {
      throw new Error("Translation resume requires completed Quality artifacts.");
    }
    const report = JSON.parse(fs.readFileSync(resume.qualityReportPath, "utf8"));
    ctx.quality = {
      ...report,
      reportPath: resume.qualityReportPath,
      projectionPath: resume.qualityProjectionPath,
      checkpointPaths: resume.qualityCheckpointPaths || [],
      optimizedTranslations: report.proposedTranslations || [],
      translationMemoryFingerprint: ctx.translationMemory.fingerprint,
    };
    hooks.setStage("running", "learning_evidence");
    hooks.emit("quality.reused", {
      sourceJobId: resume.sourceJobId,
      reportPath: ctx.quality.reportPath,
      projectionPath: ctx.quality.projectionPath,
      revisionCount: ctx.quality.optimizedTranslations.length,
    });
  }

  async _runTranslationQualityModule(ctx) {
    const { payload, hooks } = ctx;
    const baseUrl = ctx.baseUrl;
    const targetLanguage = ctx.targetLanguage;
    const glossaryMode = ctx.glossaryMode;
    const translationMemory = ctx.translationMemory;
    const translationObservation = ctx.translationObservation;
    hooks.setStage("running", "quality_context");
    ctx.quality = await this.qualityModule.run({
      baseUrl,
      mangaId: payload.mangaId || null,
      translatorId: payload.translatorId || null,
      chapterId: payload.chapterId || null,
      glossaryMode,
      jobId: hooks.jobId || null,
      translationMemory,
      sourceLanguage: payload.sourceLanguage || translationMemory.languages?.sourceLanguage || null,
      targetLanguage,
      semanticRoleEvidence: translationObservation?.observation?.nodes || [],
      semanticEvidenceFingerprint: translationObservation?.observation?.fingerprint || null,
      reusableCheckpointPaths: ctx.resume?.qualityCheckpointPaths || [],
      reusableObservationCheckpointPaths: ctx.resume?.qualityObservationCheckpointPaths || [],
      isCanceled: hooks.isCanceled,
      onProgress: (eventType, eventPayload) =>
        this._handleTranslationQualityProgress(ctx, hooks, eventType, eventPayload),
    });
    hooks.emit("quality.completed", ctx.quality);
  }

  _handleTranslationQualityProgress(ctx, hooks, eventType, eventPayload) {
    this._handleQualityObservationStage(hooks, eventType, eventPayload);
    this._handleQualityObservationArtifacts(ctx, hooks, eventType, eventPayload);
    this._handleQualityContextStage(hooks, eventType, eventPayload);
    this._handleQualityContextArtifacts(ctx, hooks, eventType, eventPayload);
    this._handleQualityWindowStage(hooks, eventType, eventPayload);
    this._handleQualityWindowArtifacts(ctx, hooks, eventType, eventPayload);
    if (eventType === "quality.window.retrying") {
      hooks.setStage(
        "running",
        `standard_quality_${eventPayload.purpose || "review"}_${eventPayload.currentWindow}_of_${eventPayload.totalWindows}`,
      );
    }
    if (eventType === "quality.window.started") {
      hooks.setStage(
        "running",
        `standard_quality_${eventPayload.purpose || "review"}_${eventPayload.currentWindow}_of_${eventPayload.totalWindows}`,
      );
    }
    if (eventType === "quality.apply_started") hooks.setStage("running", "quality_apply");
    hooks.emit(eventType, eventPayload);
  }

  _handleQualityObservationStage(hooks, eventType, eventPayload) {
    if (eventType === "quality_observation.window_started") {
      hooks.setStage("running", `quality_observation_${eventPayload.current}_of_${eventPayload.total}`);
    }
    if (eventType === "quality_observation.window_split" || eventType === "quality_observation.window_split_reused") {
      hooks.setStage("running", `quality_observation_${eventPayload.current}_of_${eventPayload.total}_split`);
    }
    if (eventType === "quality_observation.window_degraded") {
      hooks.setStage("running", `quality_observation_${eventPayload.current}_of_${eventPayload.total}_degraded`);
    }
  }

  _handleQualityObservationArtifacts(ctx, hooks, eventType, eventPayload) {
    if (eventType === "quality_observation.window_completed" || eventType === "quality_observation.window_reused") {
      this.jobStore?.addArtifact?.(
        hooks.jobId,
        "translation_quality_observation_checkpoint",
        eventPayload.checkpointPath,
        {
          windowId: eventPayload.windowId,
          current: eventPayload.current,
          total: eventPayload.total,
          elapsedMs: eventPayload.elapsedMs || 0,
        },
      );
    }
    if (eventType === "quality_observation.completed") {
      this.jobStore?.addArtifact?.(hooks.jobId, "translation_quality_observation", eventPayload.observationPath, {
        coverage: eventPayload.coverage,
        summary: eventPayload.summary,
      });
    }
  }

  _handleQualityContextStage(hooks, eventType, eventPayload) {
    if (eventType === "quality.verification_started") hooks.setStage("running", "quality_verification");
    if (eventType === "quality.context_built") hooks.setStage("running", "quality_context");
  }

  _handleQualityContextArtifacts(ctx, hooks, eventType, eventPayload) {
    if (eventType === "quality.context_built") {
      this.jobStore?.addArtifact?.(hooks.jobId, "quality_context_projection", eventPayload.projectionPath, {
        candidateCount: eventPayload.candidateCount,
        totalTranslations: eventPayload.totalTranslations,
        windowCount: eventPayload.windowCount,
      });
    }
  }

  _handleQualityWindowStage(hooks, eventType, eventPayload) {
    if (eventType === "quality.window.completed" || eventType === "quality.window.reused") {
      hooks.setStage(
        "running",
        `standard_quality_${eventPayload.purpose || "review"}_${eventPayload.completedWindows}_of_${eventPayload.totalWindows}`,
      );
    }
  }

  _handleQualityWindowArtifacts(ctx, hooks, eventType, eventPayload) {
    if (eventType === "quality.window.completed") {
      this.jobStore?.addArtifact?.(hooks.jobId, "quality_window_checkpoint", eventPayload.checkpointPath, {
        windowId: eventPayload.windowId,
        inputBytes: eventPayload.inputBytes,
        elapsedMs: eventPayload.elapsedMs,
      });
    }
    if (eventType === "quality.window.reused") {
      this.jobStore?.addArtifact?.(hooks.jobId, "quality_window_checkpoint", eventPayload.checkpointPath, {
        windowId: eventPayload.windowId,
        reused: true,
        attemptCount: eventPayload.attemptCount,
      });
    }
  }

  _emitQualityDegradedIfNeeded(ctx) {
    const { hooks } = ctx;
    const quality = ctx.quality;
    if (quality?.completenessStatus === "incomplete" || quality?.failedChecks?.includes("translation_completeness")) {
      hooks.emit("stage.degraded", {
        stage: "quality",
        reason: "translation_incomplete",
        affectedNodeCount: quality.learningExcludedNodeIds?.length || quality.completeness?.unresolvedCount || 0,
      });
    }
  }

  async _finalizeTranslationSceneAndSnapshot(ctx) {
    await this._loadFinalTranslationScene(ctx);
    this._persistFinalTranslationSnapshot(ctx);
  }

  async _loadFinalTranslationScene(ctx) {
    const { payload, hooks } = ctx;
    const baseUrl = ctx.baseUrl;
    const sceneClient = ctx.sceneClient;
    const translationMemory = ctx.translationMemory;
    const quality = ctx.quality;
    const translationObservation = ctx.translationObservation;
    const finalScene = await sceneClient.getScene(baseUrl);
    ctx.finalScene = finalScene;
    const finalTranslations = collectTranslations(finalScene);
    ctx.finalTranslations = finalTranslations;
    ctx.fallbackLearningProjection = null;
    if (quality?.projectionPath && fs.existsSync(quality.projectionPath)) {
      const projection = JSON.parse(fs.readFileSync(quality.projectionPath, "utf8"));
      finalTranslations.translations = applyQualitySemanticAnnotations(finalTranslations.translations, projection);
    } else if (translationObservation?.observation) {
      ctx.fallbackLearningProjection = buildQualityContextProjection({
        translations: finalTranslations.translations,
        translationMemory,
        semanticRoleEvidence: translationObservation.observation.nodes,
        semanticEvidenceFingerprint: translationObservation.observation.fingerprint,
      });
      finalTranslations.translations = applyQualitySemanticAnnotations(
        finalTranslations.translations,
        ctx.fallbackLearningProjection,
      );
    }
  }

  _persistFinalTranslationSnapshot(ctx) {
    ctx.finalTranslationSnapshotPath = path.join(ctx.translationWorkspace, "final_translation_snapshot.json");
    const finalTranslationSnapshot = this._buildFinalTranslationSnapshot(ctx);
    writeJsonAtomic(ctx.finalTranslationSnapshotPath, finalTranslationSnapshot);
    ctx.hooks.emit("translation_snapshot.persisted", {
      path: ctx.finalTranslationSnapshotPath,
      translationCount: ctx.finalTranslations.totalTranslations,
      translationMemoryFingerprint: ctx.translationMemory.fingerprint,
      fingerprint: finalTranslationSnapshot.fingerprint,
    });
    ctx.finalTranslationSnapshot = finalTranslationSnapshot;
  }

  _regionSnapshotSourceImages(ctx) {
    if (ctx.sourceImages) return ctx.sourceImages;
    const selectedIds = Array.isArray(ctx.payload.sourceImageIds) ? ctx.payload.sourceImageIds : null;
    const selection = this.sourcePreflightModule.resolveSourceSelection(
      ctx.payload.sourcePreflightId,
      selectedIds,
    );
    return selection.images;
  }

  _persistTranslationRegionSnapshot(ctx) {
    ctx.regionSnapshot = null;
    ctx.regionSnapshotPath = null;
    if (!this.regionSnapshotRepository || !ctx.hooks.jobId) return;
    ctx.regionSnapshotPath = path.join(ctx.translationWorkspace, "text_region_snapshot.json");
    ctx.regionSnapshot = this.regionSnapshotRepository.persist(ctx.regionSnapshotPath, {
      jobId: ctx.hooks.jobId,
      rootJobId: ctx.payload.revision?.rootJobId || ctx.hooks.jobId,
      sourcePreflightId: ctx.payload.sourcePreflightId,
      sourceImages: this._regionSnapshotSourceImages(ctx),
      scene: ctx.finalScene,
    });
    ctx.hooks.emit("text_region_snapshot.persisted", {
      path: ctx.regionSnapshotPath,
      fingerprint: ctx.regionSnapshot.fingerprint,
      pageCount: ctx.regionSnapshot.pages.length,
    });
  }

  _buildFinalTranslationSnapshot(ctx) {
    const { payload, hooks, translationMemory, finalTranslations } = ctx;
    const finalTranslationSnapshot = {
      schemaVersion: 2,
      jobId: hooks.jobId || null,
      projectName: ctx.setup.projectName,
      mangaId: payload.mangaId || null,
      translatorId: payload.translatorId || null,
      referenceTranslatorId: payload.referenceTranslatorId || null,
      chapterId: payload.chapterId || null,
      sourceChapterId: translationMemory.chapterMapping?.sourceChapterId || null,
      translationMode: ctx.translationMode,
      translationTarget: ctx.setup.translationTarget || ctx.requestedTranslationTarget,
      translationMemoryFingerprint: translationMemory.fingerprint,
      generatedAt: new Date().toISOString(),
      translations: finalTranslations.translations,
    };
    finalTranslationSnapshot.fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify(finalTranslationSnapshot))
      .digest("hex");
    return finalTranslationSnapshot;
  }

  _buildTranslationLearningEvidence(ctx) {
    const { payload, hooks } = ctx;
    const finalTranslations = ctx.finalTranslations;
    const translationMemory = ctx.translationMemory;
    const finalTranslationSnapshot = ctx.finalTranslationSnapshot;
    const finalTranslationSnapshotPath = ctx.finalTranslationSnapshotPath;
    const translationWorkspace = ctx.translationWorkspace;
    const learningQuality = this._buildTranslationLearningQuality(ctx);
    const learningEvidence = buildLearningEvidenceSnapshot({
      sourceTranslationJobId: hooks.jobId || null,
      chapterId: payload.chapterId || null,
      finalTranslationSnapshotPath,
      finalTranslationSnapshotFingerprint: finalTranslationSnapshot.fingerprint,
      finalTranslations: finalTranslations.translations,
      translationMemory,
      quality: learningQuality,
    });
    ctx.learningEvidenceSnapshotPath = path.join(translationWorkspace, "learning_evidence_snapshot.json");
    writeJsonAtomic(ctx.learningEvidenceSnapshotPath, learningEvidence);
    hooks.emit("learning_evidence.persisted", {
      path: ctx.learningEvidenceSnapshotPath,
      fingerprint: learningEvidence.fingerprint,
      ...learningEvidence.summary,
    });
    ctx.learningEvidence = learningEvidence;
  }

  _buildTranslationLearningQuality(ctx) {
    const { quality, finalTranslations, translationMemory, translationObservation } = ctx;
    if (quality) {
      return {
        ...quality,
        projection: JSON.parse(fs.readFileSync(quality.projectionPath, "utf8")),
      };
    }
    return {
      optimizedTranslations: [],
      projection:
        ctx.fallbackLearningProjection ||
        buildQualityContextProjection({
          translations: finalTranslations.translations,
          translationMemory,
          semanticRoleEvidence: translationObservation?.observation?.nodes || [],
          semanticEvidenceFingerprint: translationObservation?.observation?.fingerprint || null,
        }),
    };
  }

  _createTranslationPostEditDocument(ctx) {
    const { payload, hooks } = ctx;
    ctx.postEditDocumentPath = null;
    if (this.postEditWorkspaceModule && hooks.jobId) {
      const create = ctx.regionSnapshot && this.postEditWorkspaceModule.createDocumentFromRegionSnapshot
        ? "createDocumentFromRegionSnapshot" : "createDocumentFromScene";
      ctx.postEditDocumentPath = this.postEditWorkspaceModule[create]({
        jobId: hooks.jobId,
        sourcePreflightId: payload.sourcePreflightId || null,
        mangaId: payload.mangaId || null,
        translatorId: payload.translatorId || null,
        chapterId: payload.chapterId || null,
        ...(ctx.regionSnapshot ? { snapshot: ctx.regionSnapshot } : { scene: ctx.finalScene }),
      });
      hooks.emit("post_edit_document.persisted", {
        path: ctx.postEditDocumentPath,
      });
    }
  }

  async _exportTranslation(ctx) {
    const { payload, hooks } = ctx;
    const baseUrl = ctx.baseUrl;
    const exportFormat = ctx.exportFormat;
    const outputDir = ctx.outputDir;
    hooks.setStage("exporting", "export");
    ctx.artifact = await this.exportModule.run({
      baseUrl,
      exportFormat,
      outputDir,
      expectedImageCount: Array.isArray(ctx.sourceImagePaths) ? ctx.sourceImagePaths.length : null,
    });
    hooks.emit("export.completed", ctx.artifact);
  }

  async _closeTranslationProject(ctx) {
    const { payload, hooks } = ctx;
    const baseUrl = ctx.baseUrl;
    hooks.setStage("closing", "close_project");
    await this.projectLifecycle.closeCurrentProject({ baseUrl });
    hooks.emit("project.closed", { baseUrl });
  }

  _syncTranslationBinding(ctx) {
    const { payload } = ctx;
    const targetLanguage = ctx.targetLanguage;
    syncMangaManagementBinding({
      mangaId: payload.mangaId,
      label: payload.mangaLabel || null,
      translatorId: payload.translatorId || null,
      translatorLabel: payload.translatorLabel || payload.translator || null,
      language: targetLanguage,
      chapterId: payload.chapterId || null,
      chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
      profileKind: payload.translationMode === "learning_style" ? "learning_clone" : null,
      styleSourceTranslatorId:
        payload.translationMode === "learning_style" ? payload.referenceTranslatorId || null : null,
    });
  }

  _createTranslationPublication(ctx) {
    const { payload, hooks } = ctx;
    const quality = ctx.quality;
    return this.translationPublicationService?.publish({
      mangaId: payload.mangaId || null,
      translatorId: payload.translatorId || null,
      chapterId: payload.chapterId || null,
      chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
      jobId: hooks.jobId || null,
      finalTranslationSnapshotPath: ctx.finalTranslationSnapshotPath,
      finalTranslationSnapshotFingerprint: ctx.finalTranslationSnapshot.fingerprint,
      translationMemoryFingerprint: ctx.translationMemory.fingerprint,
      learningEvidenceSnapshotPath: ctx.learningEvidenceSnapshotPath || null,
      postEditDocumentPath: ctx.postEditDocumentPath,
      exportArtifact: ctx.artifact,
      qualityStatus: quality ? quality.status : "not_applicable",
      qualityOutcome: quality?.semanticResult?.outcome || (quality ? "clean" : null),
      qualityReportPath: quality?.reportPath || null,
      qualityObservationFingerprint: quality?.qualityObservation?.fingerprint || null,
      completenessStatus: quality?.completenessStatus || "complete",
      qualityWarningCount: (quality?.warnings?.length || 0) + (quality?.semanticResult?.warnings?.length || 0),
      learningExcludedNodeIds: quality?.learningExcludedNodeIds || [],
      verifiedAt: quality?.finalVerification?.verifiedAt || new Date().toISOString(),
      manualOverrideCount: 0,
    });
  }

  _handleSupersededTranslationPublication(ctx, publication, hooks) {
    if (publication.previousActiveJobId && this.jobStore) {
      const previousJob = this.jobStore.getJob(publication.previousActiveJobId);
      if (previousJob) {
        this.jobStore.updateJob({
          id: previousJob.id,
          result: {
            ...(previousJob.result || {}),
            publication: {
              ...(previousJob.result?.publication || {}),
              status: "superseded",
              supersededByRevisionId: publication.revisionId,
              supersededByJobId: hooks.jobId || null,
            },
          },
        });
      }
    }
  }

  _publishTranslation(ctx) {
    const { payload, hooks } = ctx;
    const translationPolicy = ctx.translationPolicy;
    const publication = ctx.revisionTranslation ? null : this._createTranslationPublication(ctx);
    ctx.publication = publication || null;
    ctx.discardedChapterLearning = null;
    if (publication) {
      this._handleSupersededTranslationPublication(ctx, publication, hooks);
      if (!translationPolicy.commitKnowledge) {
        ctx.discardedChapterLearning = deleteChapterLearningData({
          mangaId: payload.mangaId,
          translatorId: payload.translatorId,
          chapterId: payload.chapterId,
        });
        hooks.emit("translation.chapter_learning_discarded", {
          chapterId: payload.chapterId,
          reason: "active_publication_does_not_commit_knowledge",
          ...ctx.discardedChapterLearning,
        });
      }
      hooks.emit("translation.publication_updated", publication);
    }
  }

  _buildTranslationKnowledgePayload(ctx, hooks, payload) {
    return {
      sourceTranslationJobId: hooks.jobId || null,
      learningEvidenceSnapshotPath: ctx.learningEvidenceSnapshotPath || null,
      mangaId: payload.mangaId || null,
      translatorId: payload.translatorId || null,
      mangaLabel: payload.mangaLabel || null,
      translatorLabel: payload.translatorLabel || payload.translator || null,
      chapterId: payload.chapterId || null,
      chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
      publicationRevisionId: ctx.publication?.revisionId || null,
    };
  }

  _translationSnapshotResult(ctx) {
    return {
      translationMemorySnapshotPath: ctx.translationMemorySnapshotPath,
      finalTranslationSnapshotPath: ctx.finalTranslationSnapshotPath,
      regionSnapshotPath: ctx.regionSnapshotPath,
      regionSnapshotFingerprint: ctx.regionSnapshot?.fingerprint || null,
    };
  }

  _buildTranslationResult(ctx) {
    const { payload, hooks } = ctx;
    return {
      projectName: ctx.setup.projectName,
      operationId: ctx.setup.operationId,
      postEditDocumentPath: ctx.postEditDocumentPath,
      sourcePreflight: ctx.sourcePreflight,
      engines: ctx.setup.engines,
      steps: ctx.setup.steps,
      translationMode: ctx.translationMode,
      translationPolicy: ctx.translationPolicy,
      translationTarget: ctx.setup.translationTarget || ctx.requestedTranslationTarget,
      machineTranslationPostEdit: ctx.machineTranslationPostEdit,
      translationMemoryFingerprint: ctx.translationMemory.fingerprint,
      ...this._translationSnapshotResult(ctx),
      learningEvidenceSnapshotPath: ctx.learningEvidenceSnapshotPath || null,
      publication: ctx.publication,
      discardedChapterLearning: ctx.discardedChapterLearning,
      pipeline: ctx.pipeline,
      quality: ctx.quality,
      qualityObservationPath: ctx.quality?.qualityObservationPath || null,
      qualityReportPath: ctx.quality?.reportPath || null,
      knowledge: null,
      knowledgePayload: ctx.shouldCommitKnowledge ? this._buildTranslationKnowledgePayload(ctx, hooks, payload) : null,
      artifact: ctx.artifact,
      closed: true,
    };
  }

  async runTranslationKnowledgeCommitJob(payload, hooks) {
    hooks.setStage("running", "lightweight_knowledge_learning");
    if (this._isKnowledgeCommitSuperseded(payload)) {
      this._handleSupersededKnowledgeCommit(payload, hooks);
      return this._skippedKnowledgeResult(payload);
    }
    try {
      const knowledge = await this._runKnowledgeModule(payload, hooks);
      this._markKnowledgeCommitted(payload, knowledge, hooks);
      return this._completedKnowledgeResult(payload, knowledge, hooks);
    } catch (error) {
      this._markKnowledgeFailed(payload, hooks);
      throw error;
    }
  }

  _isKnowledgeCommitSuperseded(payload) {
    return !!(
      payload.publicationRevisionId &&
      this.translationPublicationService &&
      !this.translationPublicationService.isActive({
        mangaId: payload.mangaId,
        translatorId: payload.translatorId,
        chapterId: payload.chapterId,
        revisionId: payload.publicationRevisionId,
      })
    );
  }

  _handleSupersededKnowledgeCommit(payload, hooks) {
    this.translationPublicationService?.updateKnowledgeStatus({
      mangaId: payload.mangaId,
      translatorId: payload.translatorId,
      chapterId: payload.chapterId,
      revisionId: payload.publicationRevisionId,
      status: "skipped_superseded",
      knowledgeJobId: hooks.jobId || null,
    });
    hooks.emit("knowledge.skipped", {
      reason: "superseded_translation_revision",
      publicationRevisionId: payload.publicationRevisionId,
    });
  }

  _skippedKnowledgeResult(payload) {
    return {
      skipped: true,
      reason: "superseded_translation_revision",
      publicationRevisionId: payload.publicationRevisionId,
      sourceTranslationJobId: payload.sourceTranslationJobId || null,
    };
  }

  async _runKnowledgeModule(payload, hooks) {
    return this.knowledgeModule.run({
      baseUrl: null,
      mangaId: payload.mangaId || null,
      translatorId: payload.translatorId || null,
      mangaLabel: payload.mangaLabel || null,
      translatorLabel: payload.translatorLabel || null,
      chapterId: payload.chapterId || null,
      chapterTitle: payload.chapterTitle || null,
      jobId: hooks.jobId || null,
      learningEvidenceSnapshotPath: payload.learningEvidenceSnapshotPath,
      publicationRevisionId: payload.publicationRevisionId || null,
    });
  }

  _markKnowledgeCommitted(payload, knowledge, hooks) {
    if (payload.publicationRevisionId && this.translationPublicationService) {
      this.translationPublicationService.updateKnowledgeStatus({
        mangaId: payload.mangaId,
        translatorId: payload.translatorId,
        chapterId: payload.chapterId,
        revisionId: payload.publicationRevisionId,
        status: "committed",
        knowledgeJobId: hooks.jobId || null,
        outcome: knowledge?.semanticResult?.outcome || knowledge?.outcome || "clean",
      });
    }
  }

  _completedKnowledgeResult(payload, knowledge, hooks) {
    hooks.emit("knowledge.completed", {
      ...knowledge,
      sourceTranslationJobId: payload.sourceTranslationJobId || null,
    });
    return {
      ...knowledge,
      sourceTranslationJobId: payload.sourceTranslationJobId || null,
    };
  }

  _markKnowledgeFailed(payload, hooks) {
    if (payload.publicationRevisionId && this.translationPublicationService) {
      this.translationPublicationService.updateKnowledgeStatus({
        mangaId: payload.mangaId,
        translatorId: payload.translatorId,
        chapterId: payload.chapterId,
        revisionId: payload.publicationRevisionId,
        status: "failed",
        knowledgeJobId: hooks?.jobId || null,
      });
    }
  }

  async runTranslationDeepAuditJob(payload, hooks) {
    return this.translationDeepAuditModule.run(payload, {
      ...hooks,
      emit: (eventType, eventPayload) => {
        if (eventType === "deep_audit.window.completed" && eventPayload.checkpointPath) {
          this.jobStore?.addArtifact?.(hooks.jobId, "translation_deep_audit_checkpoint", eventPayload.checkpointPath, {
            windowId: eventPayload.windowId,
            reused: eventPayload.reused === true,
          });
        }
        hooks.emit(eventType, eventPayload);
      },
    });
  }

  async runTranslationDeepAuditApplyJob(payload, hooks) {
    if (!this.jobStore) throw new Error("Deep Audit apply requires a job store.");
    const state = this._loadDeepAuditApplyState(payload);
    await this._openDeepAuditProject(state, hooks);
    this._applyDeepAuditSceneChanges(state);
    this._buildDeepAuditVerification(state);
    await this._writeDeepAuditArtifacts(state, hooks);
    return this._finalizeDeepAuditApply(state, hooks);
  }

  _loadDeepAuditApplyState(payload) {
    const sourceJob = this.jobStore.getJob(payload.sourceTranslationJobId);
    const reviewJob = this.jobStore.getJob(payload.deepAuditJobId);
    this._validateDeepAuditJobs(sourceJob, reviewJob);
    const sourceResult = sourceJob.result || {};
    const reviewResult = reviewJob?.result || {};
    const reviewPackage = this._loadDeepAuditReviewPackage(reviewResult);
    const decisionById = new Map((payload.decisions || []).map((entry) => [entry.nodeId, entry]));
    const reviewItems = reviewPackage.pages.flatMap((page) => page.items || []);
    const reviewItemById = new Map(reviewItems.map((item) => [item.nodeId, item]));
    const reviewProposals = reviewResult.proposedTranslations || [];
    const proposalById = new Map(reviewProposals.map((entry) => [entry.nodeId, entry]));
    const validActions = new Set(["accept_proposal", "manual_edit", "confirm_current", "ignore_and_publish"]);
    for (const [nodeId, decision] of decisionById) {
      this._validateDeepAuditDecision(nodeId, decision, reviewItemById, proposalById, validActions);
    }
    return { payload, sourceJob, reviewJob, sourceResult, reviewResult, reviewPackage,
      decisionById, reviewItems, reviewItemById, reviewProposals, proposalById };
  }

  _validateDeepAuditJobs(sourceJob, reviewJob) {
    const valid = sourceJob?.type === "translation" &&
      reviewJob?.type === "translation_deep_audit" &&
      reviewJob.status === "succeeded" &&
      reviewJob.payload?.sourceTranslationJobId === sourceJob.id;
    if (!valid) throw new Error("Deep Audit apply requires a completed audit and its source translation.");
  }

  _loadDeepAuditReviewPackage(reviewResult) {
    const reviewPackagePath = reviewResult.deepAuditReviewPackagePath;
    if (!reviewPackagePath || !fs.existsSync(reviewPackagePath)) {
      throw new Error("Deep Audit review package is unavailable.");
    }
    return JSON.parse(fs.readFileSync(reviewPackagePath, "utf8"));
  }

  _validateDeepAuditDecision(nodeId, decision, reviewItemById, proposalById, validActions) {
    if (!reviewItemById.has(nodeId)) throw new Error(`Deep Audit decision references unknown item ${nodeId}.`);
    if (!validActions.has(decision.action)) throw new Error(`Deep Audit item ${nodeId} has an invalid decision.`);
    if (decision.action === "accept_proposal" && !proposalById.get(nodeId)?.revisedTranslation) {
      throw new Error(`Deep Audit item ${nodeId} has no proposal to accept.`);
    }
    if (decision.action === "manual_edit" && !String(decision.translation || "").trim()) {
      throw new Error(`Manual Quality decision ${nodeId} requires a translation.`);
    }
  }

  async _openDeepAuditProject(state, hooks) {
    const { sourceJob, sourceResult } = state;
    const baseUrl = sourceJob.payload?.baseUrl || config.api.baseUrl;
    const client = this.projectLifecycle?.client;
    hooks.setStage("running", "deep_audit_apply_open_project");
    const project = await this._findDeepAuditProject(client, baseUrl, sourceResult);
    await client.openProject(project.id, baseUrl);
    const scene = await client.getScene(baseUrl);
    const before = collectTranslations(scene);
    if (
      sourceResult.reviewSceneFingerprint &&
      translationSceneFingerprint(before.translations) !== sourceResult.reviewSceneFingerprint
    ) {
      throw new Error("Koharu scene changed after the Quality review package was created.");
    }
    state.baseUrl = baseUrl;
    state.client = client;
    state.project = project;
    state.before = before;
    state.currentById = new Map(before.translations.map((entry) => [entry.id, entry]));
  }

  async _findDeepAuditProject(client, baseUrl, sourceResult) {
    let projects;
    try {
      projects = await client.listProjects(baseUrl);
    } catch (cause) {
      const error = new Error(`Koharu is unavailable at ${baseUrl} while finalizing translation quality.`);
      error.code = "koharu_unavailable";
      error.cause = cause;
      throw error;
    }
    const project = projects.find((entry) => entry.name === sourceResult.projectName);
    if (!project) {
      const error = new Error(`project_missing: ${sourceResult.projectName}`);
      error.code = "project_missing";
      throw error;
    }
    return project;
  }

  _applyDeepAuditSceneChanges(state) {
    const { decisionById, proposalById, currentById } = state;
    const manualOps = [];
    for (const [nodeId, decision] of decisionById) {
      const current = currentById.get(nodeId);
      if (!current) throw new Error(`Quality decision references unknown node ${nodeId}.`);
      const desired =
        decision.action === "manual_edit"
          ? String(decision.translation).trim()
          : decision.action === "accept_proposal"
            ? proposalById.get(nodeId)?.revisedTranslation || current.translation
            : current.translation;
      if (desired !== current.translation) {
        manualOps.push({
          updateNode: {
            page: current.pageId,
            id: nodeId,
            patch: { data: { text: { translation: desired } } },
          },
        });
      }
    }
    state.manualOps = manualOps;
  }

  async _applyDeepAuditHistory(state) {
    const { manualOps, client, baseUrl, hooks } = state;
    if (manualOps.length > 0) {
      await client.applyHistoryBatch({
        ops: manualOps,
        label: `deep_audit_apply_${hooks.jobId}`,
        baseUrl,
      });
    }
    const finalScene = await client.getScene(baseUrl);
    state.finalTranslations = collectTranslations(finalScene);
  }

  _buildDeepAuditVerification(state) {
    const { ignoredIds, manuallyVerifiedIds } = this._deepAuditDecisionSets(state.decisionById);
    const baseVerificationNodes = this._deepAuditBaseVerificationNodes(state);
    const finalVerification = {
      ...(state.reviewResult.quality?.finalVerification || {}),
      status: "passed",
      verifiedAt: new Date().toISOString(),
      blockingIssues: [],
      nodes: this._applyDeepAuditDecisions(baseVerificationNodes, ignoredIds, manuallyVerifiedIds),
    };
    finalVerification.score = this._scoreDeepAuditVerification(finalVerification.nodes);
    state.ignoredIds = ignoredIds;
    state.manuallyVerifiedIds = manuallyVerifiedIds;
    state.finalVerification = finalVerification;
  }

  _deepAuditDecisionSets(decisionById) {
    const ignoredIds = new Set();
    const manuallyVerifiedIds = new Set();
    for (const [nodeId, decision] of decisionById) {
      if (decision.action === "ignore_and_publish") ignoredIds.add(nodeId);
      else manuallyVerifiedIds.add(nodeId);
    }
    return { ignoredIds, manuallyVerifiedIds };
  }

  _deepAuditBaseVerificationNodes(state) {
    return state.reviewResult.quality?.finalVerification?.nodes || state.reviewItems.map((item) => ({
      nodeId: item.nodeId,
      pageName: state.reviewPackage.pages.find(
        (page) => page.items?.some((entry) => entry.nodeId === item.nodeId),
      )?.pageName || null,
      riskTypes: item.riskTypes || [],
      confidence: item.confidence,
      reason: item.reason,
      finalDisposition: "warning",
    }));
  }

  _applyDeepAuditDecisions(nodes, ignoredIds, manuallyVerifiedIds) {
    return nodes.map((entry) => ({
      ...entry,
      finalDisposition: ignoredIds.has(entry.nodeId)
        ? "manual_ignored"
        : manuallyVerifiedIds.has(entry.nodeId) ? "manual_verified" : entry.finalDisposition,
    }));
  }

  _scoreDeepAuditVerification(nodes) {
    const finalPoints = nodes.reduce((sum, entry) => {
      if (["clean", "revised_verified", "manual_verified"].includes(entry.finalDisposition)) return sum + 1;
      return sum;
    }, 0);
    return nodes.length > 0 ? Number((finalPoints / nodes.length).toFixed(4)) : 1;
  }

  async _writeDeepAuditArtifacts(state, hooks) {
    state.hooks = hooks;
    await this._applyDeepAuditHistory(state);
    state.workspace = path.join(paths.workspaceRoot, hooks.jobId, "deep_audit_apply");
    await this._persistDeepAuditSnapshot(state, hooks);
    this._persistDeepAuditReport(state);
    await this._persistDeepAuditEvidence(state);
  }

  async _persistDeepAuditSnapshot(state, hooks) {
    const { sourceJob, sourceResult, project, finalTranslations } = state;
    const finalTranslationSnapshotPath = path.join(state.workspace, "final_translation_snapshot.json");
    const finalTranslationSnapshot = {
      schemaVersion: 2,
      jobId: hooks.jobId,
      sourceTranslationJobId: sourceJob.id,
      projectName: project.name,
      mangaId: sourceJob.payload?.mangaId || null,
      translatorId: sourceJob.payload?.translatorId || null,
      referenceTranslatorId: sourceJob.payload?.referenceTranslatorId || null,
      chapterId: sourceJob.payload?.chapterId || null,
      sourceChapterId: sourceResult.quality?.chapterMapping?.sourceChapterId || null,
      translationMode: sourceJob.payload?.translationMode,
      translationMemoryFingerprint: sourceResult.translationMemoryFingerprint,
      generatedAt: new Date().toISOString(),
      translations: finalTranslations.translations,
    };
    finalTranslationSnapshot.fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify(finalTranslationSnapshot))
      .digest("hex");
    writeJsonAtomic(finalTranslationSnapshotPath, finalTranslationSnapshot);
    state.finalTranslationSnapshotPath = finalTranslationSnapshotPath;
    state.finalTranslationSnapshot = finalTranslationSnapshot;
  }

  _persistDeepAuditReport(state) {
    const { reviewResult, finalVerification, ignoredIds, workspace } = state;
    const finalReport = {
      ...(reviewResult.quality || {}),
      status: "passed",
      overall: "pass",
      blockingIssues: [],
      finalVerification,
      score: finalVerification.score,
      finalScore: finalVerification.score,
      manualOverrideCount: ignoredIds.size,
      source: "translation_deep_audit",
    };
    const qualityReportPath = path.join(workspace, "quality_final_report.json");
    writeJsonAtomic(qualityReportPath, finalReport);
    state.finalReport = finalReport;
    state.qualityReportPath = qualityReportPath;
  }

  async _persistDeepAuditEvidence(state) {
    const memory = JSON.parse(fs.readFileSync(state.sourceResult.translationMemorySnapshotPath, "utf8"));
    const projection = this._loadDeepAuditProjection(state.sourceResult, state.reviewItems, state.reviewPackage);
    const learningEvidence = buildLearningEvidenceSnapshot({
      sourceTranslationJobId: state.sourceJob.id,
      chapterId: state.sourceJob.payload?.chapterId || null,
      finalTranslationSnapshotPath: state.finalTranslationSnapshotPath,
      finalTranslationSnapshotFingerprint: state.finalTranslationSnapshot.fingerprint,
      finalTranslations: state.finalTranslations.translations,
      translationMemory: memory,
      quality: {
        ...state.finalReport,
        projection,
        optimizedTranslations: state.reviewProposals,
      },
    });
    const learningEvidenceSnapshotPath = path.join(state.workspace, "learning_evidence_snapshot.json");
    writeJsonAtomic(learningEvidenceSnapshotPath, learningEvidence);
    state.memory = memory;
    state.projection = projection;
    state.learningEvidenceSnapshotPath = learningEvidenceSnapshotPath;
  }

  _loadDeepAuditProjection(sourceResult, reviewItems, reviewPackage) {
    if (sourceResult.quality?.projectionPath && fs.existsSync(sourceResult.quality.projectionPath)) {
      return JSON.parse(fs.readFileSync(sourceResult.quality.projectionPath, "utf8"));
    }
    return {
      candidates: reviewItems.map((item) => ({
        nodeId: item.nodeId,
        pageName:
          reviewPackage.pages.find((page) => page.items?.some((entry) => entry.nodeId === item.nodeId))?.pageName ||
          null,
        reasons: [],
      })),
    };
  }

  async _finalizeDeepAuditApply(state, hooks) {
    const artifact = await this._exportDeepAuditApply(state, hooks);
    const publication = this._publishDeepAuditApply(state, hooks, artifact);
    return this._buildDeepAuditApplyResult(state, hooks, artifact, publication);
  }

  async _exportDeepAuditApply(state, hooks) {
    const { sourceJob, sourceResult, baseUrl, finalTranslations } = state;
    hooks.setStage("exporting", "deep_audit_apply_render");
    const profile = resolvePipelineProfile(config.pipeline);
    const exportSteps = buildExportPipelineSteps(sourceResult.engines || profile.engines);
    const pipeline = await startPipeline(
      exportSteps,
      sourceJob.payload?.targetLanguage || config.defaults.targetLanguage,
      baseUrl,
    );
    await this.pipelineMonitor.run({
      operationId: pipeline.operationId,
      baseUrl,
      pipelinePlan: ["clean", "render"],
      totalPagesHint: finalTranslations.totalPages,
      onProgress: (progress) => hooks.emit("pipeline.progress", progress),
      isCanceled: hooks.isCanceled,
    });
    const outputDir = resolveDeepAuditOutputDir(sourceJob, hooks.jobId);
    const artifact = await this.exportModule.run({
      baseUrl,
      exportFormat: sourceJob.payload?.exportFormat || config.defaults.exportFormat,
      outputDir,
    });
    await this.projectLifecycle.closeCurrentProject({ baseUrl });
    return artifact;
  }

  _publishDeepAuditApply(state, hooks, artifact) {
    const {
      sourceJob,
      sourceResult,
      finalTranslationSnapshot,
      learningEvidenceSnapshotPath,
      qualityReportPath,
      finalVerification,
      ignoredIds,
    } = state;
    return this.translationPublicationService.publish({
      mangaId: sourceJob.payload?.mangaId || null,
      translatorId: sourceJob.payload?.translatorId || null,
      chapterId: sourceJob.payload?.chapterId || null,
      chapterTitle: sourceJob.payload?.chapterTitle || sourceJob.payload?.chapterLabel || null,
      jobId: hooks.jobId,
      finalTranslationSnapshotPath: state.finalTranslationSnapshotPath,
      finalTranslationSnapshotFingerprint: finalTranslationSnapshot.fingerprint,
      translationMemoryFingerprint: sourceResult.translationMemoryFingerprint,
      learningEvidenceSnapshotPath,
      postEditDocumentPath: sourceResult.postEditDocumentPath || null,
      exportArtifact: artifact,
      qualityStatus: "passed",
      qualityReportPath,
      qualityObservationFingerprint: state.reviewResult.quality?.qualityObservation?.fingerprint || null,
      verifiedAt: finalVerification.verifiedAt,
      manualOverrideCount: ignoredIds.size,
    });
  }

  _buildDeepAuditApplyResult(state, hooks, artifact, publication) {
    const { sourceJob, learningEvidenceSnapshotPath, qualityReportPath, finalReport } = state;
    return {
      sourceTranslationJobId: sourceJob.id,
      projectName: state.project.name,
      finalTranslationSnapshotPath: state.finalTranslationSnapshotPath,
      learningEvidenceSnapshotPath,
      qualityReportPath,
      quality: finalReport,
      publication,
      artifact,
      knowledgePayload:
        sourceJob.payload?.translationMode === "learning_style"
          ? {
              sourceTranslationJobId: sourceJob.id,
              learningEvidenceSnapshotPath,
              mangaId: sourceJob.payload?.mangaId || null,
              translatorId: sourceJob.payload?.translatorId || null,
              mangaLabel: sourceJob.payload?.mangaLabel || null,
              translatorLabel: sourceJob.payload?.translatorLabel || sourceJob.payload?.translator || null,
              chapterId: sourceJob.payload?.chapterId || null,
              chapterTitle: sourceJob.payload?.chapterTitle || sourceJob.payload?.chapterLabel || null,
              publicationRevisionId: publication?.revisionId || null,
            }
          : null,
    };
  }

  async runPostEditExportJob(payload, hooks) {
    if (!this.jobStore) throw new Error("Post-edit export requires a job store.");
    if (!this.postEditWorkspaceModule) throw new Error("Post-edit export requires post-edit workspace support.");
    const state = await this._preparePostEditExport(payload, hooks);
    await this._rebuildPostEditProject(state, hooks);
    this._applyPostEditChanges(state, hooks);
    const artifact = await this._exportPostEdit(state, hooks);
    return this._finalizePostEditExport(state, hooks, artifact);
  }

  async _preparePostEditExport(payload, hooks) {
    const sourceJob = this.jobStore.getJob(payload.sourceJobId);
    if (!sourceJob || sourceJob.type !== "translation" || sourceJob.status !== "succeeded") {
      throw new Error("Post-edit export requires a completed translation job.");
    }
    const baseUrl = payload.baseUrl || config.api.baseUrl;
    const exportFormat = payload.exportFormat || config.defaults.exportFormat;
    const outputDir = resolveExportOutputDir({
      mangaId: sourceJob.payload?.mangaId,
      translatorId: sourceJob.payload?.translatorId,
      chapterId: sourceJob.payload?.chapterId,
      jobId: hooks.jobId,
      variant: "post-edit",
    });
    const postEditDocument = this.postEditWorkspaceModule.load(payload.sourceJobId);
    if (!postEditDocument) throw new Error("Post-edit document not found for the requested translation job.");
    const { sourcePreflightId, sourceImagePaths } = this._resolvePostEditSourceImages(postEditDocument, sourceJob);
    return {
      payload, hooks, sourceJob, baseUrl, exportFormat, outputDir, postEditDocument,
      sourcePreflightId, sourceImagePaths, rebuiltProjectName: createRebuiltProjectName(),
    };
  }

  _resolvePostEditSourceImages(postEditDocument, sourceJob) {
    const sourcePreflightId = postEditDocument.sourcePreflightId || sourceJob.payload?.sourcePreflightId;
    if (!sourcePreflightId || !this.sourcePreflightModule) {
      throw new Error("Post-edit export requires a valid source preflight manifest.");
    }
    const sourceImagePaths = this.sourcePreflightModule.resolveSourceImages(sourcePreflightId);
    return { sourcePreflightId, sourceImagePaths };
  }

  async _rebuildPostEditProject(state, hooks) {
    const { baseUrl, rebuiltProjectName, sourceImagePaths, sourcePreflightId, postEditDocument } = state;
    hooks.setStage("running", "rebuild_project");
    const createdProject = await this.projectLifecycle.client.createProject(rebuiltProjectName, baseUrl);
    await this.projectLifecycle.client.openProject(createdProject.id, baseUrl);
    const upload = await uploadPages(sourceImagePaths, baseUrl);
    const bootstrapPipeline = await this._startPostEditBootstrapPipeline(state, baseUrl);
    hooks.emit("post_edit.rebuild_started", {
      projectId: createdProject.id,
      projectName: rebuiltProjectName,
      uploaded: upload.uploaded,
      sourcePreflightId,
    });
    await this._monitorPostEditBootstrapPipeline(state, hooks, bootstrapPipeline, sourceImagePaths);
    const rebuiltScene = await this.projectLifecycle.client.getScene(baseUrl);
    const { matches, unresolved } = matchPostEditDocumentToScene(postEditDocument, rebuiltScene);
    if (unresolved.length > 0) {
      throw new Error(
        `Post-edit node matching failed: ${unresolved
          .map((entry) => `${entry.pageName}/${entry.nodeId} (${entry.reason})`)
          .join("; ")}`,
      );
    }
    state.createdProject = createdProject;
    state.matches = matches;
    state.unresolved = unresolved;
  }

  async _startPostEditBootstrapPipeline(state, baseUrl) {
    const profile = resolvePipelineProfile(config.pipeline);
    const engines = await projectOrchestrator.resolveEngines(baseUrl, profile.engines);
    const bootstrapSteps = buildBootstrapPipelineSteps(engines);
    return startPipeline(
      bootstrapSteps,
      state.sourceJob.payload?.targetLanguage || config.defaults.targetLanguage,
      baseUrl,
    );
  }

  async _monitorPostEditBootstrapPipeline(state, hooks, bootstrapPipeline, sourceImagePaths) {
    const baseUrl = state.baseUrl;
    await this.pipelineMonitor.run({
      operationId: bootstrapPipeline.operationId,
      baseUrl,
      pipelinePlan: ["detect", "fontDetect", "segment", "bubbleSegment", "ocr"],
      totalPagesHint: sourceImagePaths.length,
      onProgress: (progress) => hooks.emit("pipeline.progress", progress),
      isCanceled: hooks.isCanceled,
    });
  }

  async _applyPostEditChanges(state, hooks) {
    const { matches, baseUrl, hooks: _h } = state;
    hooks.setStage("running", "apply_post_edit");
    const ops = buildTranslationPatchOps(matches);
    if (ops.length > 0) {
      await this.projectLifecycle.client.applyHistoryBatch({
        ops,
        label: `post_edit_${hooks.jobId}`,
        baseUrl,
      });
    }
    hooks.emit("post_edit.applied", {
      updatedNodes: ops.length,
      matchedNodes: matches.length,
    });
    state.ops = ops;
  }

  async _exportPostEdit(state, hooks) {
    const { sourceImagePaths, baseUrl, exportFormat, outputDir, sourceJob } = state;
    hooks.setStage("exporting", "export");
    const exportPipeline = await this._startPostEditExportPipeline(state, baseUrl);
    await this._monitorPostEditExportPipeline(state, hooks, exportPipeline, sourceImagePaths);
    const artifact = await this.exportModule.run({
      baseUrl,
      exportFormat,
      outputDir,
    });
    const postEditPaths = this.postEditWorkspaceModule.getPaths(state.payload.sourceJobId);
    const reorderedArtifactPath = reorderRenderedZip({
      zipPath: artifact.path,
      sourcePageOrder: state.postEditDocument.sourcePageOrder || state.postEditDocument.pageOrder,
      targetPageOrder: state.postEditDocument.pageOrder,
      workspaceRoot: postEditPaths.postEditRoot,
    });
    const finalArtifact =
      reorderedArtifactPath === artifact.path
        ? artifact
        : { ...artifact, path: reorderedArtifactPath, reordered: true };
    hooks.emit("export.completed", finalArtifact);
    state.postEditPaths = postEditPaths;
    state.finalArtifact = finalArtifact;
    return finalArtifact;
  }

  async _startPostEditExportPipeline(state, baseUrl) {
    const profile = resolvePipelineProfile(config.pipeline);
    const engines = await projectOrchestrator.resolveEngines(baseUrl, profile.engines);
    const exportSteps = buildExportPipelineSteps(engines);
    return startPipeline(
      exportSteps,
      state.sourceJob.payload?.targetLanguage || config.defaults.targetLanguage,
      baseUrl,
    );
  }

  async _monitorPostEditExportPipeline(state, hooks, exportPipeline, sourceImagePaths) {
    const baseUrl = state.baseUrl;
    await this.pipelineMonitor.run({
      operationId: exportPipeline.operationId,
      baseUrl,
      pipelinePlan: ["clean", "render"],
      totalPagesHint: sourceImagePaths.length,
      onProgress: (progress) => hooks.emit("pipeline.progress", progress),
      isCanceled: hooks.isCanceled,
    });
  }

  async _finalizePostEditExport(state, hooks, artifact) {
    const { baseUrl, sourceJob, postEditDocument, createdProject, matches, unresolved, ops, postEditPaths } = state;
    hooks.setStage("closing", "close_project");
    await this.projectLifecycle.closeCurrentProject({ baseUrl });
    hooks.emit("project.closed", { baseUrl });
    const finalArtifact = state.finalArtifact || artifact;
    return {
      sourceJobId: state.payload.sourceJobId,
      editedScenePath: postEditPaths.documentPath,
      sourceProjectName: sourceJob.result?.projectName || null,
      rebuiltProjectId: createdProject.id,
      rebuiltProjectName: state.rebuiltProjectName,
      matchedNodeCount: matches.length,
      unresolvedNodeCount: unresolved.length,
      updatedNodes: ops.length,
      pageOrderChanged:
        (postEditDocument.sourcePageOrder || []).join("|") !== (postEditDocument.pageOrder || []).join("|"),
      nodeOrderCustomized: Object.values(postEditDocument.pages || {}).some((page) => {
        const sourceOrder = Object.keys(page?.nodes || {});
        return sourceOrder.join("|") !== (page?.nodeOrder || []).join("|");
      }),
      artifact: finalArtifact,
      closed: true,
    };
  }
}

module.exports = {
  WorkflowEngine,
};
