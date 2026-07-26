const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config, paths } = require("./config");
const { syncMangaManagementBinding } = require("./modules/knowledge_paths");
const {
  finalizeKnowledgeRevision,
  prepareKnowledgeRevision,
  rollbackKnowledgeRevision,
} = require("./modules/knowledge_revisions");
const {
  buildBootstrapPipelineSteps,
  buildExportPipelineSteps,
  buildTranslationPatchOps,
  createRebuiltProjectName,
  matchPostEditDocumentToScene,
  reorderRenderedZip,
  startPipeline,
  uploadPages,
} = require("./modules/post_edit_export");
const { ensureChapterObservation, runReferenceDeepReview } = require("./modules/reference_observation");
const { loadCanonicalGlossary, loadStoryContext } = require("./modules/knowledge_assets");
const { collectTranslations } = require("./modules/quality");
const { buildLearningEvidenceSnapshot } = require("./modules/learning_evidence");
const { applyQualitySemanticAnnotations, buildQualityContextProjection } = require("./modules/quality_projection");
const { ensureTranslationChapterObservation } = require("./modules/translation_chapter_observation");
const { ensureReferenceLocaleProjection } = require("./modules/reference_locale_projection");
const {
  assertTranslationMemoryReady,
  composeTranslationMemory,
  formatTranslationMemoryPrompt,
} = require("./modules/translation_memory");
const { resolveTranslationModePolicy } = require("./modules/translation_modes");

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function translationSceneFingerprint(translations) {
  return crypto.createHash("sha256").update(JSON.stringify((translations || []).map((entry) => [
    entry.id || entry.nodeId, entry.pageId || null, entry.original || "", entry.translation || "",
  ]))).digest("hex");
}

function buildPipelinePlan(engines = {}) {
  const order = [
    "detect",
    "fontDetect",
    "segment",
    "bubbleSegment",
    "ocr",
    "translate",
    "clean",
    "render",
  ];

  return order.filter((key) => Boolean(engines[key]));
}

function resolveReferenceUsage(payload = {}) {
  const useForTerminology = payload.useForTerminology !== false;
  const useForStyle = payload.useForStyle !== false;
  return {
    useForTerminology,
    useForStyle,
    glossaryMode: useForTerminology ? payload.glossaryMode || "canonical" : "disabled",
  };
}

class WorkflowEngine {
  constructor({
    sourcePreflightModule,
    projectSetup,
    pipelineMonitor,
    referenceExtractionModule,
    referenceIngestionModule,
    referenceBilingualEnrichmentModule,
    qualityModule,
    knowledgeModule,
    translationDeepAuditModule,
    exportModule,
    projectLifecycle,
    postEditWorkspaceModule,
    jobStore,
    translationMemoryComposer = composeTranslationMemory,
    translationPublicationService = null,
  }) {
    this.sourcePreflightModule = sourcePreflightModule;
    this.projectSetup = projectSetup;
    this.pipelineMonitor = pipelineMonitor;
    this.referenceExtractionModule = referenceExtractionModule;
    this.referenceIngestionModule = referenceIngestionModule;
    this.referenceBilingualEnrichmentModule = referenceBilingualEnrichmentModule;
    this.qualityModule = qualityModule;
    this.knowledgeModule = knowledgeModule;
    this.translationDeepAuditModule = translationDeepAuditModule;
    this.exportModule = exportModule;
    this.projectLifecycle = projectLifecycle;
    this.postEditWorkspaceModule = postEditWorkspaceModule;
    this.jobStore = jobStore;
    this.translationMemoryComposer = translationMemoryComposer;
    this.translationPublicationService = translationPublicationService;
  }

  async runReferenceExtractionJob(payload, hooks) {
    const baseUrl = payload.baseUrl || config.api.baseUrl;
    const targetLanguage = payload.targetLanguage || config.defaults.targetLanguage;

    hooks.setStage("running", "extract_reference");
    const result = await this.referenceExtractionModule.run({
      referenceSetId: payload.referenceSetId,
      baseUrl,
      targetLanguage,
    });
    if (payload.mangaId) {
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
    const completedResult = {
      ...result,
      mangaId: payload.mangaId || null,
      translatorId: payload.translatorId || null,
      translatorLabel: payload.translatorLabel || payload.translator || null,
      chapterId: payload.chapterId || null,
      chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
      translator: payload.translator || null,
      workflowId: payload.workflowId || null,
    };
    hooks.emit("reference_extraction.completed", completedResult);

    return completedResult;
  }

  async runReferenceObservationJob(payload, hooks) {
    hooks.setStage("running", "reference_observation");
    const result = await ensureChapterObservation({
      aoTaskRunner: this.referenceIngestionModule.aoTaskRunner,
      referenceSetId: payload.referenceSetId,
      chapterId: payload.chapterId,
      chapterTitle: payload.chapterTitle || null,
      glossary: payload.mangaId
        ? loadCanonicalGlossary(payload.mangaId, payload.translatorId || null)
        : null,
      storyContext: payload.mangaId
        ? loadStoryContext(payload.mangaId, payload.translatorId || null)
        : null,
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

  async runReferenceIngestionJob(payload, hooks) {
    return this.runReferenceIngestionPhase(payload, hooks, "full");
  }

  async runReferenceBilingualEnrichmentJob(payload, hooks) {
    throw new Error("Bilingual enrichment is a workflow and cannot run as an atomic job.");
  }

  async runReferenceBilingualEvidenceWindowJob(payload, hooks) {
    if (!this.referenceBilingualEnrichmentModule) {
      throw new Error("Reference bilingual enrichment module is not configured.");
    }
    hooks.setStage("running", "bilingual_evidence_window");
    return this.referenceBilingualEnrichmentModule.runWindow({
      ...payload,
      jobId: hooks.jobId,
    }, {
      isCanceled: hooks.isCanceled,
      onProgress: (progress) => {
        hooks.setStage("running", progress.stage || "bilingual_evidence_window");
        hooks.emit("reference_bilingual_enrichment.progress", progress);
      },
    });
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
    return this.runReferenceIngestionPhase(payload, hooks, "commit");
  }

  async runReferenceKnowledgeCommitJob(payload, hooks) {
    await this.runReferenceIngestionPrepareJob(payload, hooks);
    return this.runReferenceIngestionCommitJob(payload, hooks);
  }

  async runReferenceIngestionPhase(payload, hooks, phase) {
    hooks.setStage("running", "reference_ingestion");
    const referenceUsage = resolveReferenceUsage(payload);
    let currentProgressStage = "reference_ingestion";
    let result;
    try {
      result = await this.referenceIngestionModule.run({
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
        onProgress: (progress) => {
          const nextStage = progress?.stage || "reference_ingestion";
          if (nextStage !== currentProgressStage) {
            currentProgressStage = nextStage;
            hooks.setStage("running", nextStage);
          }
          hooks.emit("reference_ingestion.progress", progress);
        },
      });
    } catch (error) {
      if (phase === "commit") {
        rollbackKnowledgeRevision(payload.revisionPlanPath);
      }
      throw error;
    }
    const revisionResult = phase === "commit"
      ? finalizeKnowledgeRevision({
          store: this.jobStore,
          planPath: payload.revisionPlanPath,
          analysisArtifactPath: payload.analysisArtifactPath || null,
        })
      : null;
    const completedResult = {
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
    hooks.emit(`reference_ingestion.${phase}.completed`, completedResult);
    return completedResult;
  }

  async runTranslationJob(payload, hooks) {
    const baseUrl = payload.baseUrl || config.api.baseUrl;
    const targetLanguage = payload.targetLanguage || config.defaults.targetLanguage;
    const exportFormat = payload.exportFormat || config.defaults.exportFormat;
    const outputDir = typeof payload.outputDir === "string" ? payload.outputDir.trim() : "";
    const glossaryMode = payload.glossaryMode || "canonical";
    const translationMode = payload.translationMode;
    const translationPolicy = resolveTranslationModePolicy(translationMode, payload.qualityCheck === true);
    const resume = payload.resumeFromTranslation || null;
    let sourcePreflight = null;
    let sourceImagePaths = null;
    let translationMemory = null;
    let setup = null;
    let pipeline = null;
    let translationObservation = null;

    if (!outputDir) {
      throw new Error("Translation job requires outputDir.");
    }

    if (resume) {
      if (!fs.existsSync(resume.translationMemorySnapshotPath || "")) {
        throw new Error("Translation resume requires the original Translation Memory snapshot.");
      }
      translationMemory = JSON.parse(fs.readFileSync(resume.translationMemorySnapshotPath, "utf8"));
      if (
        translationMemory.translationMode !== translationMode ||
        translationMemory.mangaId !== (payload.mangaId || null) ||
        translationMemory.translatorId !== (payload.translatorId || null) ||
        (translationMemory.referenceTranslatorId || null) !== (payload.referenceTranslatorId || null) ||
        translationMemory.chapterId !== (payload.chapterId || null)
      ) {
        throw new Error("Translation resume snapshot does not match the requested translation context.");
      }
    } else {
      if (payload.sourcePreflightId && this.sourcePreflightModule) {
        sourcePreflight = this.sourcePreflightModule.get(payload.sourcePreflightId);
        sourceImagePaths = this.sourcePreflightModule.resolveSourceImages(payload.sourcePreflightId);
        hooks.emit("source_preflight.resolved", {
          preflightId: sourcePreflight.preflightId,
          sourceFolder: sourcePreflight.sourceFolder,
          acceptedCount: sourcePreflight.summary.acceptedCount,
          convertedCount: sourcePreflight.summary.convertedCount,
          orderChanged: sourcePreflight.orderChanged,
        });
      } else if (Array.isArray(payload.sourceImagePaths) && payload.sourceImagePaths.length > 0) {
        sourceImagePaths = payload.sourceImagePaths;
      } else {
        throw new Error("Translation job requires a valid sourcePreflightId.");
      }
      translationMemory = this.translationMemoryComposer({
        translationMode,
        qualityCheck: payload.qualityCheck === true,
        mangaId: payload.mangaId || null,
        translatorId: payload.translatorId || null,
        referenceTranslatorId: payload.referenceTranslatorId || null,
        chapterId: payload.chapterId || null,
        chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
        sourceChapterId: payload.sourceChapterId || null,
        glossaryMode,
        sourceLanguage: payload.sourceLanguage || null,
        targetLanguage,
      });
    }
    if (resume && payload.allowPendingLocalRevalidation === true) {
      translationMemory = this.translationMemoryComposer({
        translationMode,
        qualityCheck: true,
        mangaId: payload.mangaId || null,
        translatorId: payload.translatorId || null,
        referenceTranslatorId: payload.referenceTranslatorId || null,
        chapterId: payload.chapterId || null,
        chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
        sourceChapterId: payload.sourceChapterId || null,
        glossaryMode,
        sourceLanguage: payload.sourceLanguage || null,
        targetLanguage,
      });
      if (translationMemory.layers?.local) {
        translationMemory.layers.local.revalidationBlocked = false;
        translationMemory.layers.local.available = false;
      }
      translationMemory.warnings = (translationMemory.warnings || []).filter((entry) =>
        entry?.code !== "local_memory_pending_revalidation"
      );
      delete translationMemory.fingerprint;
      translationMemory.fingerprint = crypto.createHash("sha256")
        .update(JSON.stringify(translationMemory))
        .digest("hex");
    }
    assertTranslationMemoryReady(translationMemory);
    if (translationPolicy.useReferenceMemory && (!resume || payload.allowPendingLocalRevalidation === true)) {
      const localeProjection = await ensureReferenceLocaleProjection({
        translationMemory,
        aoTaskRunner: this.qualityModule?.aoTaskRunner,
        jobId: hooks.jobId,
        isCanceled: hooks.isCanceled,
      });
      translationMemory = localeProjection.translationMemory;
      if (localeProjection.projectionPath) {
        hooks.emit("reference_locale_projection.completed", {
          path: localeProjection.projectionPath,
          fingerprint: localeProjection.projection?.fingerprint || null,
          reused: localeProjection.reused,
          referenceLanguage: translationMemory.languages.referenceLanguage,
          targetLanguage: translationMemory.languages.targetLanguage,
        });
        this.jobStore?.addArtifact?.(hooks.jobId, "reference_locale_projection", localeProjection.projectionPath, {
          fingerprint: localeProjection.projection?.fingerprint || null,
          reused: localeProjection.reused,
        });
      }
    }
    const systemPrompt = formatTranslationMemoryPrompt(translationMemory);
    const translationWorkspace = path.join(paths.workspaceRoot, hooks.jobId || `translation_${Date.now()}`, "translation");
    const translationMemorySnapshotPath = path.join(translationWorkspace, "translation_memory_snapshot.json");
    writeJsonAtomic(translationMemorySnapshotPath, translationMemory);
    hooks.emit("translation_memory.built", {
      translationMode,
      fingerprint: translationMemory.fingerprint,
      policy: translationPolicy,
      chapterMapping: translationMemory.chapterMapping,
      usage: translationMemory.usage,
      warnings: translationMemory.warnings,
      path: translationMemorySnapshotPath,
    });

    if (resume) {
      hooks.setStage("running", "resume_quality");
      const client = this.projectLifecycle?.client;
      if (!client || typeof client.listProjects !== "function" || typeof client.openProject !== "function") {
        throw new Error("Translation resume requires Koharu project access.");
      }
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
      await client.openProject(project.id, baseUrl);
      setup = {
        projectName: project.name,
        operationId: resume.operationId || null,
        engines: resume.engines || {},
        steps: resume.steps || [],
        resumed: true,
      };
      pipeline = {
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
    } else {
      hooks.setStage("running", "setup_project");
      setup = await this.projectSetup.run({
        targetLanguage,
        baseUrl,
        systemPrompt,
        sourceImagePaths,
      });
      hooks.emit("setup.completed", setup);

      hooks.setStage("waiting_pipeline", "monitor_pipeline");
      const pipelinePlan = buildPipelinePlan(setup.engines);
      const totalPagesHint =
        typeof sourcePreflight?.summary?.acceptedCount === "number"
          ? sourcePreflight.summary.acceptedCount
          : null;
      pipeline = await this.pipelineMonitor.run({
        operationId: setup.operationId,
        baseUrl,
        pipelinePlan,
        totalPagesHint,
        onProgress: (progress) => hooks.emit("pipeline.progress", progress),
        isCanceled: hooks.isCanceled,
      });
      hooks.emit("pipeline.completed", pipeline);
    }

    const sceneClient = this.projectLifecycle?.client || this.qualityModule?.client;
    if (!sceneClient || typeof sceneClient.getScene !== "function") {
      throw new Error("Translation workflow cannot read the Koharu scene.");
    }
    const shouldObserveTranslation = translationMode !== "quick" && (
      translationPolicy.runQuality || translationPolicy.commitKnowledge
    );
    const observationRunner = this.qualityModule?.aoTaskRunner || null;
    if (shouldObserveTranslation && observationRunner?.runChapterObservation) {
      hooks.setStage("running", "translation_chapter_observation");
      const observedScene = collectTranslations(await sceneClient.getScene(baseUrl));
      translationObservation = await ensureTranslationChapterObservation({
        aoTaskRunner: observationRunner,
        translations: observedScene.translations,
        mangaId: payload.mangaId || null,
        chapterId: payload.chapterId || null,
        chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
        contentLanguage: payload.sourceLanguage || translationMemory.languages?.sourceLanguage || null,
        translationMemory,
        isCanceled: hooks.isCanceled,
        onProgress: (progress) => hooks.emit("translation_observation.progress", progress),
      });
      this.jobStore?.addArtifact?.(
        hooks.jobId,
        "translation_chapter_observation",
        translationObservation.observationPath,
        {
          fingerprint: translationObservation.observation.fingerprint,
          reused: translationObservation.reused,
          coverage: translationObservation.observation.coverage,
        }
      );
      hooks.emit("translation_observation.completed", {
        path: translationObservation.observationPath,
        fingerprint: translationObservation.observation.fingerprint,
        reused: translationObservation.reused,
        coverage: translationObservation.observation.coverage,
      });
    } else if (shouldObserveTranslation) {
      hooks.emit("translation_observation.unavailable", {
        reason: "chapter_observer_not_configured",
      });
    }

    let quality = null;
    if (translationPolicy.runQuality) {
      if (resume?.resumeAtStage === "learning_evidence") {
        if (
          !fs.existsSync(resume.qualityReportPath || "") ||
          !fs.existsSync(resume.qualityProjectionPath || "")
        ) {
          throw new Error("Translation resume requires completed Quality artifacts.");
        }
        const report = JSON.parse(fs.readFileSync(resume.qualityReportPath, "utf8"));
        quality = {
          ...report,
          reportPath: resume.qualityReportPath,
          projectionPath: resume.qualityProjectionPath,
          checkpointPaths: resume.qualityCheckpointPaths || [],
          optimizedTranslations: report.proposedTranslations || [],
          translationMemoryFingerprint: translationMemory.fingerprint,
        };
        hooks.setStage("running", "learning_evidence");
        hooks.emit("quality.reused", {
          sourceJobId: resume.sourceJobId,
          reportPath: quality.reportPath,
          projectionPath: quality.projectionPath,
          revisionCount: quality.optimizedTranslations.length,
        });
      } else {
        hooks.setStage("running", "quality_context");
        quality = await this.qualityModule.run({
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
        reusableCheckpointPaths: resume?.qualityCheckpointPaths || [],
        reusableObservationCheckpointPaths: resume?.qualityObservationCheckpointPaths || [],
        isCanceled: hooks.isCanceled,
        onProgress: (eventType, eventPayload) => {
          if (eventType === "quality_observation.window_started") {
            hooks.setStage("running", `quality_observation_${eventPayload.current}_of_${eventPayload.total}`);
          }
          if (eventType === "quality_observation.window_split" || eventType === "quality_observation.window_split_reused") {
            hooks.setStage("running", `quality_observation_${eventPayload.current}_of_${eventPayload.total}_split`);
          }
          if (eventType === "quality_observation.window_degraded") {
            hooks.setStage("running", `quality_observation_${eventPayload.current}_of_${eventPayload.total}_degraded`);
          }
          if (eventType === "quality_observation.window_completed" || eventType === "quality_observation.window_reused") {
            this.jobStore?.addArtifact?.(hooks.jobId, "translation_quality_observation_checkpoint", eventPayload.checkpointPath, {
              windowId: eventPayload.windowId,
              current: eventPayload.current,
              total: eventPayload.total,
              elapsedMs: eventPayload.elapsedMs || 0,
            });
          }
          if (eventType === "quality_observation.completed") {
            this.jobStore?.addArtifact?.(hooks.jobId, "translation_quality_observation", eventPayload.observationPath, {
              coverage: eventPayload.coverage,
              summary: eventPayload.summary,
            });
          }
          if (eventType === "quality.verification_started") hooks.setStage("running", "quality_verification");
          if (eventType === "quality.context_built") {
            hooks.setStage("running", "quality_context");
            this.jobStore?.addArtifact?.(hooks.jobId, "quality_context_projection", eventPayload.projectionPath, {
              candidateCount: eventPayload.candidateCount,
              totalTranslations: eventPayload.totalTranslations,
              windowCount: eventPayload.windowCount,
            });
          }
          if (eventType === "quality.window.completed") {
            hooks.setStage("running", `standard_quality_${eventPayload.purpose || "review"}_${eventPayload.completedWindows}_of_${eventPayload.totalWindows}`);
            this.jobStore?.addArtifact?.(hooks.jobId, "quality_window_checkpoint", eventPayload.checkpointPath, {
              windowId: eventPayload.windowId,
              inputBytes: eventPayload.inputBytes,
              elapsedMs: eventPayload.elapsedMs,
            });
          }
          if (eventType === "quality.window.reused") {
            hooks.setStage("running", `standard_quality_${eventPayload.purpose || "review"}_${eventPayload.completedWindows}_of_${eventPayload.totalWindows}`);
            this.jobStore?.addArtifact?.(hooks.jobId, "quality_window_checkpoint", eventPayload.checkpointPath, {
              windowId: eventPayload.windowId,
              reused: true,
              attemptCount: eventPayload.attemptCount,
            });
          }
          if (eventType === "quality.window.retrying") {
            hooks.setStage("running", `standard_quality_${eventPayload.purpose || "review"}_${eventPayload.currentWindow}_of_${eventPayload.totalWindows}`);
          }
          if (eventType === "quality.window.started") {
            hooks.setStage("running", `standard_quality_${eventPayload.purpose || "review"}_${eventPayload.currentWindow}_of_${eventPayload.totalWindows}`);
          }
          if (eventType === "quality.apply_started") hooks.setStage("running", "quality_apply");
          hooks.emit(eventType, eventPayload);
        },
        });
        hooks.emit("quality.completed", quality);
      }
    }
    if (quality?.status === "failed" || quality?.failedChecks?.includes("translation_completeness")) {
      throw new Error(
        `Quality blocked export: ${quality.blockingIssues?.length || quality.completeness?.unresolvedCount || 0} structural issue(s) remain.`
      );
    }

    const finalScene = await sceneClient.getScene(baseUrl);
    const finalTranslations = collectTranslations(finalScene);
    let fallbackLearningProjection = null;
    if (quality?.projectionPath && fs.existsSync(quality.projectionPath)) {
      const projection = JSON.parse(fs.readFileSync(quality.projectionPath, "utf8"));
      finalTranslations.translations = applyQualitySemanticAnnotations(finalTranslations.translations, projection);
    } else if (translationObservation?.observation) {
      fallbackLearningProjection = buildQualityContextProjection({
        translations: finalTranslations.translations,
        translationMemory,
        semanticRoleEvidence: translationObservation.observation.nodes,
        semanticEvidenceFingerprint: translationObservation.observation.fingerprint,
      });
      finalTranslations.translations = applyQualitySemanticAnnotations(
        finalTranslations.translations,
        fallbackLearningProjection
      );
    }
    const finalTranslationSnapshotPath = path.join(translationWorkspace, "final_translation_snapshot.json");
    const finalTranslationSnapshot = {
      schemaVersion: 2,
      jobId: hooks.jobId || null,
      projectName: setup.projectName,
      mangaId: payload.mangaId || null,
      translatorId: payload.translatorId || null,
      referenceTranslatorId: payload.referenceTranslatorId || null,
      chapterId: payload.chapterId || null,
      sourceChapterId: translationMemory.chapterMapping?.sourceChapterId || null,
      translationMode,
      translationMemoryFingerprint: translationMemory.fingerprint,
      generatedAt: new Date().toISOString(),
      translations: finalTranslations.translations,
    };
    finalTranslationSnapshot.fingerprint = crypto.createHash("sha256")
      .update(JSON.stringify(finalTranslationSnapshot))
      .digest("hex");
    writeJsonAtomic(finalTranslationSnapshotPath, finalTranslationSnapshot);
    hooks.emit("translation_snapshot.persisted", {
      path: finalTranslationSnapshotPath,
      translationCount: finalTranslations.totalTranslations,
      translationMemoryFingerprint: translationMemory.fingerprint,
      fingerprint: finalTranslationSnapshot.fingerprint,
    });

    let learningEvidenceSnapshotPath = null;
    let learningEvidence = null;
    if (translationPolicy.commitKnowledge) {
      learningEvidence = buildLearningEvidenceSnapshot({
        sourceTranslationJobId: hooks.jobId || null,
        chapterId: payload.chapterId || null,
        finalTranslationSnapshotPath,
        finalTranslationSnapshotFingerprint: finalTranslationSnapshot.fingerprint,
        finalTranslations: finalTranslations.translations,
        translationMemory,
        quality: quality ? {
          ...quality,
          projection: JSON.parse(fs.readFileSync(quality.projectionPath, "utf8")),
        } : {
          optimizedTranslations: [],
          projection: fallbackLearningProjection || buildQualityContextProjection({
            translations: finalTranslations.translations,
            translationMemory,
            semanticRoleEvidence: translationObservation?.observation?.nodes || [],
            semanticEvidenceFingerprint: translationObservation?.observation?.fingerprint || null,
          }),
        },
      });
      learningEvidenceSnapshotPath = path.join(translationWorkspace, "learning_evidence_snapshot.json");
      writeJsonAtomic(learningEvidenceSnapshotPath, learningEvidence);
      hooks.emit("learning_evidence.persisted", {
        path: learningEvidenceSnapshotPath,
        fingerprint: learningEvidence.fingerprint,
        ...learningEvidence.summary,
      });
    }

    let postEditDocumentPath = null;
    if (this.postEditWorkspaceModule && hooks.jobId) {
      postEditDocumentPath = this.postEditWorkspaceModule.createDocumentFromScene({
        jobId: hooks.jobId,
        sourcePreflightId: payload.sourcePreflightId || null,
        mangaId: payload.mangaId || null,
        translatorId: payload.translatorId || null,
        chapterId: payload.chapterId || null,
        scene: finalScene,
      });
      hooks.emit("post_edit_document.persisted", { path: postEditDocumentPath });
    }

    hooks.setStage("exporting", "export");
    const artifact = await this.exportModule.run({
      baseUrl,
      exportFormat,
      outputDir,
    });
    hooks.emit("export.completed", artifact);

    hooks.setStage("closing", "close_project");
    await this.projectLifecycle.closeCurrentProject({ baseUrl });
    hooks.emit("project.closed", { baseUrl });

    if (payload.mangaId) {
      syncMangaManagementBinding({
        mangaId: payload.mangaId,
        label: payload.mangaLabel || null,
        translatorId: payload.translatorId || null,
        translatorLabel: payload.translatorLabel || payload.translator || null,
        language: targetLanguage,
        chapterId: payload.chapterId || null,
        chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
        profileKind: payload.translationMode === "learning_style" ? "learning_clone" : null,
        styleSourceTranslatorId: payload.translationMode === "learning_style"
          ? payload.referenceTranslatorId || null
          : null,
      });
    }

    const publication = this.translationPublicationService?.publish({
      mangaId: payload.mangaId || null,
      translatorId: payload.translatorId || null,
      chapterId: payload.chapterId || null,
      chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
      jobId: hooks.jobId || null,
      finalTranslationSnapshotPath,
      finalTranslationSnapshotFingerprint: finalTranslationSnapshot.fingerprint,
      translationMemoryFingerprint: translationMemory.fingerprint,
      learningEvidenceSnapshotPath,
      postEditDocumentPath,
      exportArtifact: artifact,
      qualityStatus: quality ? quality.status : "not_applicable",
      qualityReportPath: quality?.reportPath || null,
      qualityObservationFingerprint: quality?.qualityObservation?.fingerprint || null,
      verifiedAt: quality?.finalVerification?.verifiedAt || new Date().toISOString(),
      manualOverrideCount: 0,
    });
    if (publication) {
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
      hooks.emit("translation.publication_updated", publication);
    }

    return {
      projectName: setup.projectName,
      operationId: setup.operationId,
      postEditDocumentPath,
      sourcePreflight,
      engines: setup.engines,
      steps: setup.steps,
      translationMode,
      translationPolicy,
      translationMemoryFingerprint: translationMemory.fingerprint,
      translationMemorySnapshotPath,
      finalTranslationSnapshotPath,
      learningEvidenceSnapshotPath,
      publication,
      pipeline,
      quality,
      qualityObservationPath: quality?.qualityObservationPath || null,
      qualityReviewPackagePath: quality?.reviewPackagePath || null,
      qualityReportPath: quality?.reportPath || null,
      knowledge: null,
      knowledgePayload: translationPolicy.commitKnowledge ? {
        sourceTranslationJobId: hooks.jobId || null,
        learningEvidenceSnapshotPath,
        mangaId: payload.mangaId || null,
        translatorId: payload.translatorId || null,
        mangaLabel: payload.mangaLabel || null,
        translatorLabel: payload.translatorLabel || payload.translator || null,
        chapterId: payload.chapterId || null,
        chapterTitle: payload.chapterTitle || payload.chapterLabel || null,
        publicationRevisionId: publication?.revisionId || null,
      } : null,
      artifact,
      closed: true,
    };
  }

  async runTranslationKnowledgeCommitJob(payload, hooks) {
    hooks.setStage("running", "lightweight_knowledge_learning");
    if (payload.publicationRevisionId && this.translationPublicationService && !this.translationPublicationService.isActive({
      mangaId: payload.mangaId,
      translatorId: payload.translatorId,
      chapterId: payload.chapterId,
      revisionId: payload.publicationRevisionId,
    })) {
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
      return {
        skipped: true,
        reason: "superseded_translation_revision",
        publicationRevisionId: payload.publicationRevisionId,
        sourceTranslationJobId: payload.sourceTranslationJobId || null,
      };
    }
    try {
      const knowledge = await this.knowledgeModule.run({
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
      if (payload.publicationRevisionId && this.translationPublicationService) {
        this.translationPublicationService.updateKnowledgeStatus({
          mangaId: payload.mangaId,
          translatorId: payload.translatorId,
          chapterId: payload.chapterId,
          revisionId: payload.publicationRevisionId,
          status: "committed",
          knowledgeJobId: hooks.jobId || null,
        });
      }
      hooks.emit("knowledge.completed", {
        ...knowledge,
        sourceTranslationJobId: payload.sourceTranslationJobId || null,
      });
      return {
        ...knowledge,
        sourceTranslationJobId: payload.sourceTranslationJobId || null,
      };
    } catch (error) {
      if (payload.publicationRevisionId && this.translationPublicationService) {
        this.translationPublicationService.updateKnowledgeStatus({
          mangaId: payload.mangaId,
          translatorId: payload.translatorId,
          chapterId: payload.chapterId,
          revisionId: payload.publicationRevisionId,
          status: "failed",
          knowledgeJobId: hooks.jobId || null,
        });
      }
      throw error;
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

  async runTranslationQualityFinalizeJob(payload, hooks) {
    if (!this.jobStore) throw new Error("Quality finalize requires a job store.");
    const sourceJob = this.jobStore.getJob(payload.sourceTranslationJobId);
    const reviewJob = payload.qualityReviewJobId
      ? this.jobStore.getJob(payload.qualityReviewJobId)
      : sourceJob;
    const isDeepAuditReview = reviewJob?.type === "translation_deep_audit" && reviewJob.status === "succeeded";
    if (!sourceJob || !["translation", "translation_quality_repair"].includes(sourceJob.type) ||
      (!isDeepAuditReview && sourceJob.status !== "waiting_user_review")) {
      throw new Error("Quality finalize requires a translation waiting for user review.");
    }
    const sourceResult = sourceJob.result || {};
    const reviewResult = reviewJob?.result || {};
    const reviewPackagePath = reviewResult.qualityReviewPackagePath;
    if (!reviewPackagePath || !fs.existsSync(reviewPackagePath)) {
      throw new Error("Quality review package is unavailable.");
    }
    const reviewPackage = JSON.parse(fs.readFileSync(reviewPackagePath, "utf8"));
    const decisionById = new Map((payload.decisions || []).map((entry) => [entry.nodeId, entry]));
    const blockingIds = new Set((reviewResult.quality?.blockingIssues || []).map((entry) => entry.nodeId));
    const validActions = new Set(["accept_proposal", "manual_edit", "confirm_current", "ignore_and_publish"]);
    for (const nodeId of blockingIds) {
      const decision = decisionById.get(nodeId);
      if (!decision || !validActions.has(decision.action)) {
        throw new Error(`Blocking Quality item ${nodeId} requires a valid user decision.`);
      }
      if (decision.action === "manual_edit" && !String(decision.translation || "").trim()) {
        throw new Error(`Manual Quality decision ${nodeId} requires a translation.`);
      }
    }

    const baseUrl = sourceJob.payload?.baseUrl || config.api.baseUrl;
    const client = this.projectLifecycle?.client;
    hooks.setStage("running", "quality_finalize_open_project");
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
    await client.openProject(project.id, baseUrl);
    const scene = await client.getScene(baseUrl);
    const before = collectTranslations(scene);
    if (sourceResult.reviewSceneFingerprint && translationSceneFingerprint(before.translations) !== sourceResult.reviewSceneFingerprint) {
      throw new Error("Koharu scene changed after the Quality review package was created.");
    }
    const reviewProposals = reviewResult.quality?.appliedRevisions || reviewResult.proposedTranslations || [];
    const proposalById = new Map(reviewProposals.map((entry) => [entry.nodeId, entry]));
    const currentById = new Map(before.translations.map((entry) => [entry.id, entry]));
    const manualOps = [];
    for (const [nodeId, decision] of decisionById) {
      const current = currentById.get(nodeId);
      if (!current) throw new Error(`Quality decision references unknown node ${nodeId}.`);
      const desired = decision.action === "manual_edit"
        ? String(decision.translation).trim()
        : decision.action === "accept_proposal"
          ? proposalById.get(nodeId)?.revisedTranslation || current.translation
          : current.translation;
      if (desired !== current.translation) {
        manualOps.push({ updateNode: { page: current.pageId, id: nodeId, patch: { data: { text: { translation: desired } } } } });
      }
    }
    if (manualOps.length > 0) {
      await client.applyHistoryBatch({ ops: manualOps, label: `quality_finalize_${hooks.jobId}`, baseUrl });
    }
    const finalScene = await client.getScene(baseUrl);
    const finalTranslations = collectTranslations(finalScene);
    const ignoredIds = new Set([...decisionById].filter(([, entry]) => entry.action === "ignore_and_publish").map(([nodeId]) => nodeId));
    const manuallyVerifiedIds = new Set([...decisionById].filter(([, entry]) => entry.action !== "ignore_and_publish").map(([nodeId]) => nodeId));
    const reviewItems = reviewPackage.pages.flatMap((page) => page.items || []);
    const baseVerificationNodes = reviewResult.quality?.finalVerification?.nodes || reviewItems.map((item) => ({
      nodeId: item.nodeId,
      pageName: reviewPackage.pages.find((page) => page.items?.some((entry) => entry.nodeId === item.nodeId))?.pageName || null,
      riskTypes: item.riskTypes || [],
      confidence: item.confidence,
      reason: item.reason,
      finalDisposition: "warning",
    }));
    const finalVerification = {
      ...(reviewResult.quality?.finalVerification || {}),
      status: "passed",
      verifiedAt: new Date().toISOString(),
      blockingIssues: [],
      nodes: baseVerificationNodes.map((entry) => ({
        ...entry,
        finalDisposition: ignoredIds.has(entry.nodeId)
          ? "manual_ignored"
          : manuallyVerifiedIds.has(entry.nodeId) ? "manual_verified" : entry.finalDisposition,
      })),
    };
    const finalPoints = finalVerification.nodes.reduce((sum, entry) => {
      if (["clean", "revised_verified", "manual_verified"].includes(entry.finalDisposition)) return sum + 1;
      return sum;
    }, 0);
    finalVerification.score = finalVerification.nodes.length > 0
      ? Number((finalPoints / finalVerification.nodes.length).toFixed(4))
      : 1;
    const workspace = path.join(paths.workspaceRoot, hooks.jobId, "quality_finalize");
    const finalTranslationSnapshotPath = path.join(workspace, "final_translation_snapshot.json");
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
    finalTranslationSnapshot.fingerprint = crypto.createHash("sha256").update(JSON.stringify(finalTranslationSnapshot)).digest("hex");
    writeJsonAtomic(finalTranslationSnapshotPath, finalTranslationSnapshot);
    const finalReport = {
      ...(reviewResult.quality || {}),
      status: "passed",
      overall: "pass",
      blockingIssues: [],
      finalVerification,
      score: finalVerification.score,
      finalScore: finalVerification.score,
      manualOverrideCount: ignoredIds.size,
      source: isDeepAuditReview ? "translation_deep_audit" : "standard_quality",
    };
    const qualityReportPath = path.join(workspace, "quality_final_report.json");
    writeJsonAtomic(qualityReportPath, finalReport);
    const memory = JSON.parse(fs.readFileSync(sourceResult.translationMemorySnapshotPath, "utf8"));
    const projection = sourceResult.quality?.projectionPath && fs.existsSync(sourceResult.quality.projectionPath)
      ? JSON.parse(fs.readFileSync(sourceResult.quality.projectionPath, "utf8"))
      : { candidates: reviewItems.map((item) => ({
        nodeId: item.nodeId,
        pageName: reviewPackage.pages.find((page) => page.items?.some((entry) => entry.nodeId === item.nodeId))?.pageName || null,
        reasons: [],
      })) };
    const learningEvidence = buildLearningEvidenceSnapshot({
      sourceTranslationJobId: sourceJob.id,
      chapterId: sourceJob.payload?.chapterId || null,
      finalTranslationSnapshotPath,
      finalTranslationSnapshotFingerprint: finalTranslationSnapshot.fingerprint,
      finalTranslations: finalTranslations.translations,
      translationMemory: memory,
      quality: { ...finalReport, projection, optimizedTranslations: reviewProposals },
    });
    const learningEvidenceSnapshotPath = path.join(workspace, "learning_evidence_snapshot.json");
    writeJsonAtomic(learningEvidenceSnapshotPath, learningEvidence);

    hooks.setStage("exporting", "quality_finalize_render");
    const exportSteps = buildExportPipelineSteps(sourceResult.engines || config.engines || {});
    const pipeline = await startPipeline(exportSteps, sourceJob.payload?.targetLanguage || config.defaults.targetLanguage, baseUrl);
    await this.pipelineMonitor.run({
      operationId: pipeline.operationId,
      baseUrl,
      pipelinePlan: ["clean", "render"],
      totalPagesHint: finalTranslations.totalPages,
      onProgress: (progress) => hooks.emit("pipeline.progress", progress),
      isCanceled: hooks.isCanceled,
    });
    const artifact = await this.exportModule.run({
      baseUrl,
      exportFormat: sourceJob.payload?.exportFormat || config.defaults.exportFormat,
      outputDir: sourceJob.payload?.outputDir,
    });
    await this.projectLifecycle.closeCurrentProject({ baseUrl });
    const publication = this.translationPublicationService.publish({
      mangaId: sourceJob.payload?.mangaId || null,
      translatorId: sourceJob.payload?.translatorId || null,
      chapterId: sourceJob.payload?.chapterId || null,
      chapterTitle: sourceJob.payload?.chapterTitle || sourceJob.payload?.chapterLabel || null,
      jobId: hooks.jobId,
      finalTranslationSnapshotPath,
      finalTranslationSnapshotFingerprint: finalTranslationSnapshot.fingerprint,
      translationMemoryFingerprint: sourceResult.translationMemoryFingerprint,
      learningEvidenceSnapshotPath,
      postEditDocumentPath: sourceResult.postEditDocumentPath || null,
      exportArtifact: artifact,
      qualityStatus: "passed",
      qualityReportPath,
      qualityObservationFingerprint: reviewResult.quality?.qualityObservation?.fingerprint || null,
      verifiedAt: finalVerification.verifiedAt,
      manualOverrideCount: ignoredIds.size,
    });
    return {
      sourceTranslationJobId: sourceJob.id,
      projectName: project.name,
      finalTranslationSnapshotPath,
      learningEvidenceSnapshotPath,
      qualityReportPath,
      quality: finalReport,
      publication,
      artifact,
      knowledgePayload: sourceJob.payload?.translationMode === "learning_style" ? {
        sourceTranslationJobId: sourceJob.id,
        learningEvidenceSnapshotPath,
        mangaId: sourceJob.payload?.mangaId || null,
        translatorId: sourceJob.payload?.translatorId || null,
        mangaLabel: sourceJob.payload?.mangaLabel || null,
        translatorLabel: sourceJob.payload?.translatorLabel || sourceJob.payload?.translator || null,
        chapterId: sourceJob.payload?.chapterId || null,
        chapterTitle: sourceJob.payload?.chapterTitle || sourceJob.payload?.chapterLabel || null,
        publicationRevisionId: publication?.revisionId || null,
      } : null,
    };
  }

  async runPostEditExportJob(payload, hooks) {
    if (!this.jobStore) {
      throw new Error("Post-edit export requires a job store.");
    }
    if (!this.postEditWorkspaceModule) {
      throw new Error("Post-edit export requires post-edit workspace support.");
    }

    const sourceJob = this.jobStore.getJob(payload.sourceJobId);
    if (!sourceJob || sourceJob.type !== "translation" || sourceJob.status !== "succeeded") {
      throw new Error("Post-edit export requires a completed translation job.");
    }

    const baseUrl = payload.baseUrl || config.api.baseUrl;
    const exportFormat = payload.exportFormat || config.defaults.exportFormat;
    const outputDir = typeof payload.outputDir === "string" ? payload.outputDir.trim() : "";
    if (!outputDir) {
      throw new Error("Post-edit export requires outputDir.");
    }
    const postEditDocument = this.postEditWorkspaceModule.load(payload.sourceJobId);
    if (!postEditDocument) {
      throw new Error("Post-edit document not found for the requested translation job.");
    }
    const sourcePreflightId = postEditDocument.sourcePreflightId || sourceJob.payload?.sourcePreflightId;
    if (!sourcePreflightId || !this.sourcePreflightModule) {
      throw new Error("Post-edit export requires a valid source preflight manifest.");
    }
    const sourceImagePaths = this.sourcePreflightModule.resolveSourceImages(sourcePreflightId);
    const rebuiltProjectName = createRebuiltProjectName();

    hooks.setStage("running", "rebuild_project");
    const createdProject = await this.projectLifecycle.client.createProject(rebuiltProjectName, baseUrl);
    await this.projectLifecycle.client.openProject(createdProject.id, baseUrl);
    const upload = await uploadPages(sourceImagePaths, baseUrl);
    const bootstrapSteps = buildBootstrapPipelineSteps(config.engines || {});
    const bootstrapPipeline = await startPipeline(
      bootstrapSteps,
      sourceJob.payload?.targetLanguage || config.defaults.targetLanguage,
      baseUrl
    );
    hooks.emit("post_edit.rebuild_started", {
      projectId: createdProject.id,
      projectName: rebuiltProjectName,
      uploaded: upload.uploaded,
      sourcePreflightId,
    });
    await this.pipelineMonitor.run({
      operationId: bootstrapPipeline.operationId,
      baseUrl,
      pipelinePlan: ["detect", "fontDetect", "segment", "bubbleSegment", "ocr"],
      totalPagesHint: sourceImagePaths.length,
      onProgress: (progress) => hooks.emit("pipeline.progress", progress),
      isCanceled: hooks.isCanceled,
    });
    const rebuiltScene = await this.projectLifecycle.client.getScene(baseUrl);
    const { matches, unresolved } = matchPostEditDocumentToScene(postEditDocument, rebuiltScene);
    if (unresolved.length > 0) {
      throw new Error(
        `Post-edit node matching failed: ${unresolved
          .map((entry) => `${entry.pageName}/${entry.nodeId} (${entry.reason})`)
          .join("; ")}`
      );
    }

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

    hooks.setStage("exporting", "export");
    const exportSteps = buildExportPipelineSteps(config.engines || {});
    const exportPipeline = await startPipeline(
      exportSteps,
      sourceJob.payload?.targetLanguage || config.defaults.targetLanguage,
      baseUrl
    );
    await this.pipelineMonitor.run({
      operationId: exportPipeline.operationId,
      baseUrl,
      pipelinePlan: ["clean", "render"],
      totalPagesHint: sourceImagePaths.length,
      onProgress: (progress) => hooks.emit("pipeline.progress", progress),
      isCanceled: hooks.isCanceled,
    });
    const artifact = await this.exportModule.run({ baseUrl, exportFormat, outputDir });

    const postEditPaths = this.postEditWorkspaceModule.getPaths(payload.sourceJobId);
    const reorderedArtifactPath = reorderRenderedZip({
      zipPath: artifact.path,
      sourcePageOrder: postEditDocument.sourcePageOrder || postEditDocument.pageOrder,
      targetPageOrder: postEditDocument.pageOrder,
      workspaceRoot: postEditPaths.postEditRoot,
    });
    const finalArtifact =
      reorderedArtifactPath === artifact.path
        ? artifact
        : {
            ...artifact,
            path: reorderedArtifactPath,
            reordered: true,
          };
    hooks.emit("export.completed", finalArtifact);

    hooks.setStage("closing", "close_project");
    await this.projectLifecycle.closeCurrentProject({ baseUrl });
    hooks.emit("project.closed", { baseUrl });

    return {
      sourceJobId: payload.sourceJobId,
      editedScenePath: postEditPaths.documentPath,
      sourceProjectName: sourceJob.result?.projectName || null,
      rebuiltProjectId: createdProject.id,
      rebuiltProjectName,
      matchedNodeCount: matches.length,
      unresolvedNodeCount: unresolved.length,
      updatedNodes: ops.length,
      pageOrderChanged:
        (postEditDocument.sourcePageOrder || []).join("|") !==
        (postEditDocument.pageOrder || []).join("|"),
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
