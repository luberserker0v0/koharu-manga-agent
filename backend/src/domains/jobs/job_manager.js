const fs = require("fs");
const path = require("path");

const KOHARU_JOB_TYPES = new Set(["translation", "reference_extraction", "post_edit_export", "translation_deep_audit_apply"]);
const { EventEmitter } = require("events");
const crypto = require("crypto");

const { paths } = require("../../config");
const { listChapterRegistry } = require("../knowledge/registry/knowledge_paths");
const { loadReferenceManifest } = require("../reference/sets/reference_sets");
const { ensureLegacyReviewMetadata } = require("../reference/review/reference_extraction_review");
const { resolveTranslationModePolicy } = require("../translation/modes/translation_modes");
const { isMachineTranslationTarget } = require("../../integrations/koharu/translation/translation_targets");
const { assertJobType, assertJobStatus } = require("./contracts/job_contracts");
const { buildAoFailureDiagnostics } = require("../../integrations/ao/errors/ao_error_classifier");
const { summarizeJobOutcome } = require("../../integrations/ao/contracts/semantic_result");
const { collectQualityCheckpoints, collectWorkspaceManifestArtifacts } = require("./artifacts/job_artifact_collection");

class JobManager {
  constructor({ store, engine, runtimeConfig, resolvedConfig, koharuRuntimeManager = null, aoClient = null }) {
    this.store = store;
    this.engine = engine;
    this.runtimeConfig = runtimeConfig;
    this.resolvedConfig = resolvedConfig;
    this.koharuRuntimeManager = koharuRuntimeManager;
    this.aoClient = aoClient;
    this.events = new EventEmitter();
    this.cancellations = new Set();
    this.activeJobs = new Set();
    this.pendingQueue = [];
    this.queueDrainScheduled = false;
    this.queueRunning = false;
    this.koharuReviewLease = null;
    this.recoverInterruptedJobs();
  }

  recoverInterruptedJobs() {
    const jobs = typeof this.store.listJobs === "function"
      ? this.store.listJobs({ includeDeleted: true })
      : [];
    const interruptedWorkflowIds = new Set(jobs
      .filter((job) =>
        job.executionKind === "workflow" &&
        ["running", "cancel_requested"].includes(job.status)
      )
      .map((job) => job.id));
    for (const job of jobs) {
      const belongsToInterruptedWorkflow =
        interruptedWorkflowIds.has(job.id) ||
        interruptedWorkflowIds.has(job.parentJobId);
      if (
        belongsToInterruptedWorkflow &&
        ["queued", "waiting_dependency", "running", "cancel_requested"].includes(job.status)
      ) {
        if (
          ["running", "cancel_requested"].includes(job.status) &&
          (job.type === "reference_bilingual_evidence_window" || job.type === "reference_bilingual_commit")
        ) {
          this.engine.referenceBilingualEnrichmentModule?.markRunStopped(job.payload);
        }
        this.store.updateJob({ id: job.id, status: "canceled", stage: "canceled", error: null });
        this.store.addEvent(job.id, "job.canceled", {
          jobId: job.id,
          status: "canceled",
          recoveredAfterRestart: true,
          interruptedWorkflowId: interruptedWorkflowIds.has(job.id) ? job.id : job.parentJobId,
        }, new Date().toISOString());
        continue;
      }
      if (["queued", "waiting_dependency"].includes(job.status) && job.executionKind !== "workflow") {
        this.pendingQueue.push(job.id);
        continue;
      }
      if (!["running", "cancel_requested"].includes(job.status)) {
        continue;
      }
      this.store.updateJob({ id: job.id, status: "canceled", stage: "canceled", error: null });
      this.store.addEvent(job.id, "job.canceled", {
        jobId: job.id,
        status: "canceled",
        recoveredAfterRestart: true,
      }, new Date().toISOString());
    }
    if (this.pendingQueue.length > 0) {
      this.scheduleQueueDrain();
    }
  }

  createJob(type, payload, options = {}) {
    const executionKind = options.executionKind || "job";
    const status = options.status || "queued";
    assertJobType(type, executionKind);
    assertJobStatus(status);
    const jobId = crypto.randomUUID();
    this.store.createJob({
      id: jobId,
      type,
      status,
      stage: options.stage || "queued",
      payload,
      retryOf: options.retryOf || null,
      executionKind,
      workflowId: options.workflowId || null,
      parentJobId: options.parentJobId || null,
      dependencyIds: options.dependencyIds || [],
      laneKey: options.laneKey || null,
      sequenceNumber: options.sequenceNumber ?? null,
    });
    this.publish(jobId, "job.created", {
      jobId,
      type,
      payload,
      retryOf: options.retryOf || null,
      workflowId: options.workflowId || null,
      parentJobId: options.parentJobId || null,
      dependencyIds: options.dependencyIds || [],
    });
    if (executionKind !== "workflow" && options.enqueue !== false) {
      this.pendingQueue.push(jobId);
      this.scheduleQueueDrain();
    }
    return this.getJob(jobId);
  }

  async runAtomicJob(job, hooks) {
    switch (job.type) {
      case "translation":
      case "translation_quality_repair":
        return this.engine.runTranslationJob(job.payload, hooks);
      case "reference_extraction":
        return this.engine.runReferenceExtractionJob(job.payload, hooks);
      case "reference_observation":
        return job.parentJobId
          ? this.engine.runReferenceIngestionAnalysisJob(job.payload, hooks)
          : this.engine.runReferenceObservationJob(job.payload, hooks);
      case "reference_deep_review":
        return this.engine.runReferenceDeepReviewJob(job.payload, hooks);
      case "reference_story_update":
        return this.engine.runReferenceIngestionStoryJob(job.payload, hooks);
      case "reference_knowledge_commit":
      case "reference_style_commit":
        return this.engine.runReferenceIngestionCommitJob(job.payload, hooks);
      case "reference_bilingual_evidence_window":
        return this.engine.runReferenceBilingualEvidenceWindowJob(job.payload, hooks);
      case "reference_bilingual_commit":
        return this.engine.runReferenceBilingualCommitJob(job.payload, hooks);
      case "post_edit_export":
        return this.engine.runPostEditExportJob(job.payload, hooks);
      case "translation_knowledge_commit":
        return this.engine.runTranslationKnowledgeCommitJob(job.payload, hooks);
      case "translation_deep_audit":
        return this.engine.runTranslationDeepAuditJob(job.payload, hooks);
      case "translation_deep_audit_apply":
        return this.engine.runTranslationDeepAuditApplyJob(job.payload, hooks);
      default:
        throw new Error(`No atomic job handler is registered for ${job.type}.`);
    }
  }

  createWorkflow(type, payload, childDefinitions) {
    const parent = this.createJob(type, payload, {
      executionKind: "workflow",
      status: "running",
      stage: "waiting_children",
    });
    const childIdsByKey = new Map();
    for (const [index, definition] of childDefinitions.entries()) {
      const dependencyIds = (definition.dependsOn || []).map((key) => {
        const dependencyId = childIdsByKey.get(key);
        if (!dependencyId) {
          throw new Error(`Workflow child dependency not found: ${key}`);
        }
        return dependencyId;
      });
      const child = this.createJob(definition.type, definition.payload || payload, {
        workflowId: parent.id,
        parentJobId: parent.id,
        dependencyIds: [...dependencyIds, ...(definition.dependencyIds || [])],
        laneKey: definition.laneKey || null,
        sequenceNumber: definition.sequenceNumber ?? index,
      });
      childIdsByKey.set(definition.key, child.id);
    }
    this.publish(parent.id, "workflow.created", {
      workflowId: parent.id,
      childJobIds: [...childIdsByKey.values()],
    });
    return this.getJob(parent.id);
  }

  scheduleQueueDrain() {
    if (this.queueDrainScheduled) {
      return;
    }

    this.queueDrainScheduled = true;
    setImmediate(() => {
      this.queueDrainScheduled = false;
      void this.drainQueue();
    });
  }

  async drainQueue() {
    if (this.queueRunning) {
      return;
    }

    this.queueRunning = true;
    try {
      while (this.pendingQueue.length > 0) {
        let runnableIndex = -1;
        for (let index = 0; index < this.pendingQueue.length; index += 1) {
          const job = this.store.getJob(this.pendingQueue[index]);
          if (!job || !["queued", "waiting_dependency"].includes(job.status)) {
            this.pendingQueue.splice(index, 1);
            index -= 1;
            continue;
          }
          const dependencyState = this.resolveDependencyState(job);
          if (dependencyState.kind === "failed") {
            this.pendingQueue.splice(index, 1);
            index -= 1;
            this.blockJob(job, dependencyState.reason);
            continue;
          }
          if (dependencyState.kind === "waiting") {
            if (job.status !== "waiting_dependency" || job.blockedReason !== dependencyState.reason) {
              this.store.updateJob({
                id: job.id,
                status: "waiting_dependency",
                stage: "waiting_dependency",
                blockedReason: dependencyState.reason,
              });
              this.publish(job.id, "job.waiting_dependency", { reason: dependencyState.reason });
            }
            continue;
          }
          if (this.koharuReviewLease && KOHARU_JOB_TYPES.has(job.type)) {
            const reason = `Waiting for Extraction review ${this.koharuReviewLease.referenceSetId} to finish.`;
            if (job.status !== "waiting_dependency" || job.blockedReason !== reason) {
              this.store.updateJob({
                id: job.id,
                status: "waiting_dependency",
                stage: "waiting_koharu_review",
                blockedReason: reason,
              });
              this.publish(job.id, "job.waiting_koharu_review", { reason });
            }
            continue;
          }
          runnableIndex = index;
          break;
        }
        if (runnableIndex < 0) {
          break;
        }
        const [nextJobId] = this.pendingQueue.splice(runnableIndex, 1);
        await this.runJob(nextJobId);
      }
    } finally {
      this.queueRunning = false;
      if (this.pendingQueue.length > 0 && !this.koharuReviewLease) {
        this.scheduleQueueDrain();
      }
    }
  }

  acquireKoharuReviewLease({ sessionId, referenceSetId }) {
    if (this.koharuReviewLease) {
      const error = new Error(`Koharu is already reserved by Extraction review ${this.koharuReviewLease.referenceSetId}.`);
      error.statusCode = 409;
      throw error;
    }
    const activeKoharuJob = [...this.activeJobs]
      .map((jobId) => this.store.getJob(jobId))
      .find((job) => job && KOHARU_JOB_TYPES.has(job.type));
    if (activeKoharuJob) {
      const error = new Error(`Koharu job ${activeKoharuJob.id} is still running.`);
      error.statusCode = 409;
      throw error;
    }
    this.koharuReviewLease = { sessionId, referenceSetId, acquiredAt: new Date().toISOString() };
    return this.koharuReviewLease;
  }

  releaseKoharuReviewLease(sessionId) {
    if (!this.koharuReviewLease || this.koharuReviewLease.sessionId !== sessionId) return false;
    this.koharuReviewLease = null;
    for (const jobId of this.pendingQueue) {
      const job = this.store.getJob(jobId);
      if (job?.stage === "waiting_koharu_review") {
        this.store.updateJob({ id: job.id, status: "queued", stage: "queued", blockedReason: null });
      }
    }
    this.scheduleQueueDrain();
    return true;
  }

  getKoharuReviewLease() {
    return this.koharuReviewLease;
  }

  usesConfiguredKoharu(job) {
    return KOHARU_JOB_TYPES.has(job?.type) && !job.payload?.baseUrl;
  }

  async ensureKoharuReadyForJob(job, hooks = null) {
    if (!this.usesConfiguredKoharu(job) || !this.koharuRuntimeManager) {
      return null;
    }
    hooks?.setStage?.("running", "koharu_runtime");
    const inspected = await this.koharuRuntimeManager.inspect?.();
    const status = inspected?.status === "running"
      ? inspected
      : await this.koharuRuntimeManager.ensureRunning();
    if (status?.baseUrl) {
      this.resolvedConfig.api = {
        ...(this.resolvedConfig.api || {}),
        baseUrl: status.baseUrl,
      };
      if (this.engine?.projectLifecycle?.client) {
        this.engine.projectLifecycle.client.defaultBaseUrl = status.baseUrl;
      }
    }
    hooks?.emit?.("koharu_runtime.ready", status);
    return status;
  }

  async inspectKoharuReadiness() {
    const status = this.koharuRuntimeManager
      ? await this.koharuRuntimeManager.inspect()
      : {
          status: this.resolvedConfig.api?.baseUrl ? "configured" : "unconfigured",
          mode: "external",
          baseUrl: this.resolvedConfig.api?.baseUrl || null,
          lastError: null,
        };
    const ready = status.status === "running";
    return {
      ready,
      status: status.status,
      mode: status.mode || "external",
      baseUrl: status.baseUrl || this.resolvedConfig.api?.baseUrl || null,
      error: ready
        ? null
        : status.lastError || `Koharu is not reachable at ${status.baseUrl || this.resolvedConfig.api?.baseUrl || "the configured endpoint"}.`,
    };
  }

  async assertKoharuAvailableForJobType(type, payload = {}) {
    if (!KOHARU_JOB_TYPES.has(type)) return null;
    // Production runtimes always provide the manager. Keep injected test/custom
    // managers without one backward compatible instead of guessing at a client contract.
    if (!this.koharuRuntimeManager) return null;
    try {
      if (payload.baseUrl) {
        if (!this.koharuRuntimeManager.isReachable) return null;
        const ready = await this.koharuRuntimeManager.isReachable(payload.baseUrl);
        if (ready) return { ready: true, status: "running", mode: "external", baseUrl: payload.baseUrl, error: null };
        throw new Error(`Koharu is not reachable at ${payload.baseUrl}.`);
      }
      if (this.koharuRuntimeManager?.ensureRunning) {
        const status = await this.koharuRuntimeManager.ensureRunning();
        const readiness = {
          ready: status?.status === "running",
          status: status?.status || "running",
          mode: status?.mode || "external",
          baseUrl: status?.baseUrl || this.resolvedConfig.api?.baseUrl || null,
          error: null,
        };
        if (!readiness.ready) {
          throw new Error(`Koharu did not report a running state (${readiness.status}).`);
        }
        return readiness;
      }
      const readiness = await this.inspectKoharuReadiness();
      if (readiness.ready) return readiness;
      throw new Error(readiness.error);
    } catch (cause) {
      const readiness = await this.inspectKoharuReadiness().catch(() => ({
        ready: false,
        status: "unavailable",
        mode: "external",
        baseUrl: payload.baseUrl || this.resolvedConfig.api?.baseUrl || null,
        error: cause.message,
      }));
      const error = new Error(cause.message || readiness.error || "Koharu is unavailable.");
      error.statusCode = 503;
      error.code = "koharu_unavailable";
      error.details = {
        service: "koharu",
        jobType: type,
        status: readiness.status,
        mode: readiness.mode,
        baseUrl: payload.baseUrl || readiness.baseUrl,
        retrySafe: true,
      };
      throw error;
    }
  }

  resolveDependencyState(job) {
    for (const dependencyId of job.dependencyIds || []) {
      const dependency = this.store.getJob(dependencyId);
      if (!dependency) {
        return { kind: "failed", reason: `Missing dependency: ${dependencyId}` };
      }
      if (["failed", "canceled", "blocked"].includes(dependency.status)) {
        return {
          kind: "failed",
          reason: `Dependency ${dependency.id} ended with status ${dependency.status}.`,
        };
      }
      if (dependency.status !== "succeeded") {
        return { kind: "waiting", reason: `Waiting for dependency ${dependency.id}.` };
      }
    }
    return { kind: "ready", reason: null };
  }

  blockJob(job, reason) {
    this.store.updateJob({
      id: job.id,
      status: "blocked",
      stage: "blocked_dependency",
      error: null,
      blockedReason: reason,
    });
    this.publish(job.id, "job.blocked", { reason });
    this.updateParentWorkflow(job.parentJobId);
  }

  updateParentWorkflow(parentJobId) {
    if (!parentJobId || typeof this.store.listChildJobs !== "function") {
      return;
    }
    const parent = this.store.getJob(parentJobId);
    if (!parent || parent.executionKind !== "workflow") {
      return;
    }
    if (["succeeded", "failed", "canceled", "blocked"].includes(parent.status)) {
      return;
    }
    const children = this.store.listChildJobs(parentJobId);
    const terminalStatuses = new Set(["succeeded", "failed", "canceled", "blocked"]);
    if (children.some((child) => !terminalStatuses.has(child.status))) {
      const runningChild = children.find((child) => child.status === "running");
      this.store.updateJob({
        id: parentJobId,
        status: "running",
        stage: runningChild?.stage || "waiting_children",
      });
      return;
    }
    const failedChild = children.find((child) => ["failed", "blocked"].includes(child.status));
    const canceledChild = children.find((child) => child.status === "canceled");
    const finalChild = children[children.length - 1] || null;
    const status = failedChild ? "failed" : canceledChild ? "canceled" : "succeeded";
    const childOutcomes = children.filter((child) => child.status === "succeeded");
    const parentOutcome = childOutcomes.some((child) => child.outcome === "partial")
      ? "partial"
      : childOutcomes.some((child) => child.outcome === "warnings")
        ? "warnings"
        : status === "succeeded" ? "clean" : null;
    const diagnostics = failedChild?.diagnostics || {
      warningCount: childOutcomes.reduce((sum, child) => sum + (child.diagnostics?.warningCount || 0), 0),
      acceptedRecordCount: childOutcomes.reduce((sum, child) => sum + (child.diagnostics?.acceptedRecordCount || 0), 0),
      quarantinedRecordCount: childOutcomes.reduce((sum, child) => sum + (child.diagnostics?.quarantinedRecordCount || 0), 0),
      degradedStages: childOutcomes.flatMap((child) => child.diagnostics?.degradedStages || []),
    };
    this.store.updateJob({
      id: parentJobId,
      status,
      stage: status,
      result: status === "succeeded" ? finalChild?.result || null : parent.result,
      error: failedChild?.error || null,
      blockedReason: failedChild?.blockedReason || null,
      outcome: parentOutcome,
      diagnostics,
      resumeMetadata: failedChild?.resumeMetadata || null,
    });
    for (const child of children) {
      for (const artifact of this.store.getArtifacts(child.id)) {
        this.store.addArtifact(parentJobId, artifact.kind, artifact.path, {
          ...(artifact.metadata || {}),
          childJobId: child.id,
          childJobType: child.type,
        });
      }
    }
    this.publish(parentJobId, `workflow.${status}`, {
      workflowId: parentJobId,
      childJobIds: children.map((child) => child.id),
      failedChildId: failedChild?.id || null,
    });
  }

  collectDescendantJobs(parentJobId) {
    if (!parentJobId || typeof this.store.listChildJobs !== "function") {
      return [];
    }
    const descendants = [];
    const pendingParentIds = [parentJobId];
    while (pendingParentIds.length > 0) {
      const currentParentId = pendingParentIds.shift();
      for (const child of this.store.listChildJobs(currentParentId)) {
        descendants.push(child);
        pendingParentIds.push(child.id);
      }
    }
    return descendants;
  }

  toJobSummary(job) {
    if (!job) {
      return null;
    }

    return {
      id: job.id,
      type: job.type,
      status: job.status,
      stage: job.stage,
      payload: job.payload,
      result: job.result ?? null,
      error: job.error ?? null,
      retryOf: job.retryOf ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      deletedAt: job.deletedAt ?? null,
      executionKind: job.executionKind || "job",
      workflowId: job.workflowId || null,
      parentJobId: job.parentJobId || null,
      dependencyIds: job.dependencyIds || [],
      laneKey: job.laneKey || null,
      sequenceNumber: job.sequenceNumber ?? null,
      blockedReason: job.blockedReason || null,
    };
  }

  createTranslationJob(payload) {
    const translationTarget = payload?.translationTarget || this.resolvedConfig.translation?.defaultTarget || null;
    const policy = resolveTranslationModePolicy(payload?.translationMode, payload?.qualityCheck === true);
    const obsoleteFields = ["referenceSetId", "ingestReference", "knowledgeBuilder"]
      .filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
    if (obsoleteFields.length > 0) {
      throw new Error(`Obsolete translation payload fields are not supported: ${obsoleteFields.join(", ")}.`);
    }
    if (policy.useReferenceMemory && !payload?.referenceTranslatorId) {
      throw new Error(`${payload.translationMode} requires referenceTranslatorId.`);
    }
    if (payload?.translationMode === "learning_style" && payload.translatorId === payload.referenceTranslatorId) {
      throw new Error("Learning Style requires a separate learning clone profile.");
    }
    return this.createJob("translation", {
      ...payload,
      ...(translationTarget ? { translationTarget } : {}),
    });
  }

  async assertAgentAvailableForTranslation(payload) {
    const policy = resolveTranslationModePolicy(payload?.translationMode, payload?.qualityCheck === true);
    const translationTarget = payload?.translationTarget || this.resolvedConfig.translation?.defaultTarget || null;
    const machineSettings = this.resolvedConfig.translation?.machineTranslation || {};
    const machineTranslationPostEdit = isMachineTranslationTarget(translationTarget) && (
      (payload?.translationMode === "reference_style" && machineSettings.referencePostEdit !== false) ||
      (["local_style", "learning_style"].includes(payload?.translationMode) && machineSettings.learningPostEdit !== false)
    );
    const requiresAgent = policy.useReferenceMemory || policy.runQuality || policy.commitKnowledge || machineTranslationPostEdit;
    if (!requiresAgent || !this.aoClient?.checkAvailability) return { required: requiresAgent, available: null };
    await this.aoClient.checkAvailability({ timeoutMs: 3000 });
    return { required: true, available: true };
  }

  createTranslationDeepAuditJob(sourceTranslationJobId) {
    const source = this.store.getJob(sourceTranslationJobId);
    if (!source || source.type !== "translation" || source.status !== "succeeded") {
      throw new Error("Deep Audit requires a completed translation job.");
    }
    if (!source.result?.finalTranslationSnapshotPath) {
      throw new Error("Deep Audit requires a final translation snapshot.");
    }
    return this.createJob("translation_deep_audit", {
      sourceTranslationJobId,
      finalTranslationSnapshotPath: source.result.finalTranslationSnapshotPath,
      translationMemorySnapshotPath: source.result.translationMemorySnapshotPath || null,
      mangaId: source.payload?.mangaId || null,
      translatorId: source.payload?.translatorId || null,
      chapterId: source.payload?.chapterId || null,
    }, { parentJobId: sourceTranslationJobId, laneKey: `translation_deep_audit:${sourceTranslationJobId}` });
  }

  createTranslationDeepAuditApplyJob(deepAuditJobId, decisions) {
    const requested = this.store.getJob(deepAuditJobId);
    const source = requested?.type === "translation_deep_audit"
      ? this.store.getJob(requested.payload?.sourceTranslationJobId)
      : null;
    if (!source || source.type !== "translation" || requested.status !== "succeeded") {
      throw new Error("Deep Audit apply requires a completed Deep Audit job.");
    }
    if (!requested.result?.deepAuditReviewPackagePath) {
      throw new Error("Deep Audit apply requires a review package.");
    }
    if (requested.type === "translation_deep_audit" && (!Array.isArray(decisions) || decisions.length === 0)) {
      throw new Error("Deep Audit apply requires at least one user decision.");
    }
    return this.createJob("translation_deep_audit_apply", {
      sourceTranslationJobId: source.id,
      deepAuditJobId: requested.id,
      decisions: Array.isArray(decisions) ? decisions : [],
    }, { parentJobId: requested.id, laneKey: `translation_deep_audit_apply:${source.id}` });
  }

  createTranslationQualityRepairJob(sourceTranslationJobId) {
    const source = this.store.getJob(sourceTranslationJobId);
    if (!source || source.type !== "translation" || source.status !== "succeeded") {
      throw new Error("Quality repair requires a completed translation job.");
    }
    if (!source.result?.projectName || !source.result?.translationMemorySnapshotPath) {
      throw new Error("Quality repair requires the original Koharu project and Translation Memory snapshot.");
    }
    const previousRepairs = this.store.listChildJobs(source.id)
      .filter((job) => job.type === "translation_quality_repair");
    const reusable = collectQualityCheckpoints(this.store, [source, ...previousRepairs]);
    return this.createJob("translation_quality_repair", {
      ...source.payload,
      resumeFromTranslation: {
        sourceJobId: source.id,
        projectName: source.result.projectName,
        operationId: source.result.operationId || null,
        engines: source.result.engines || {},
        steps: source.result.steps || [],
        translationMemorySnapshotPath: source.result.translationMemorySnapshotPath,
        resumeAtStage: "quality_context",
        qualityCheckpointPaths: reusable.qualityCheckpointPaths,
        qualityObservationCheckpointPaths: reusable.qualityObservationCheckpointPaths,
      },
    }, { parentJobId: source.id, laneKey: `translation_quality_repair:${source.payload?.mangaId || "none"}:${source.payload?.translatorId || "none"}` });
  }

  async preflightTranslationQualityRepair(sourceTranslationJobId) {
    const source = this.store.getJob(sourceTranslationJobId);
    if (!source || source.type !== "translation" || source.status !== "succeeded") {
      const error = new Error("Quality repair requires a completed translation job.");
      error.statusCode = 409;
      throw error;
    }
    const client = this.engine?.projectLifecycle?.client;
    let baseUrl = source.payload?.baseUrl || this.resolvedConfig?.api?.baseUrl || "http://127.0.0.1:4000";
    if (!source.payload?.baseUrl && this.koharuRuntimeManager) {
      const status = await this.koharuRuntimeManager.ensureRunning();
      if (status?.baseUrl) {
        baseUrl = status.baseUrl;
        this.resolvedConfig.api = {
          ...(this.resolvedConfig.api || {}),
          baseUrl,
        };
        if (client) {
          client.defaultBaseUrl = baseUrl;
        }
      }
    }
    if (!client || typeof client.listProjects !== "function") {
      const error = new Error("Koharu project access is not configured.");
      error.statusCode = 503;
      throw error;
    }
    let projects;
    try {
      projects = await client.listProjects(baseUrl);
    } catch (cause) {
      const error = new Error(`Koharu is unavailable at ${baseUrl}. Start Koharu before revalidating translation quality.`);
      error.statusCode = 503;
      error.cause = cause;
      throw error;
    }
    if (!projects.some((project) => project.name === source.result?.projectName)) {
      const error = new Error(`Koharu project is unavailable: ${source.result?.projectName || "unknown"}.`);
      error.statusCode = 409;
      throw error;
    }
    return { baseUrl, projectName: source.result.projectName };
  }

  createReferenceExtractionJob(payload) {
    return this.createJob("reference_extraction", payload);
  }

  createReferenceObservationJob(payload) {
    return this.createJob("reference_observation", payload);
  }

  createReferenceDeepReviewJob(payload) {
    return this.createJob("reference_deep_review", payload);
  }

  createReferenceIngestionJob(payload) {
    const review = ensureLegacyReviewMetadata(payload.referenceSetId);
    payload = { ...payload, extractionFingerprint: review?.currentFingerprint || null };
    const scheduling = this.resolveReferenceIngestionScheduling(payload);
    return this.createReferenceIngestionWorkflow(payload, scheduling);
  }

  createReferenceBilingualEnrichmentJob(payload) {
    if (!payload?.mangaId || !payload?.translatorId) {
      throw new Error("Bilingual enrichment requires mangaId and translatorId.");
    }
    const prepared = this.engine.referenceBilingualEnrichmentModule.prepareRun(payload);
    const existing = this.store.listJobs({ includeDeleted: false }).find((job) =>
      job.type === "reference_bilingual_enrichment" &&
      job.payload?.mangaId === payload.mangaId &&
      job.payload?.translatorId === payload.translatorId &&
      job.payload?.planHash === prepared.plan.planHash &&
      ["queued", "running", "waiting_dependency"].includes(job.status)
    );
    if (existing) return this.getJob(existing.id);
    const parentPayload = {
      ...payload,
      sourceFingerprint: prepared.plan.sourceFingerprint,
      targetFingerprint: prepared.plan.targetFingerprint,
      planHash: prepared.plan.planHash,
      planPath: prepared.paths.planPath,
      totalWindows: prepared.plan.windows.length,
      reusedWindows: prepared.completedWindowIds.length,
    };
    const parent = this.createJob("reference_bilingual_enrichment", parentPayload, {
      executionKind: "workflow",
      status: "running",
      stage: "waiting_children",
      laneKey: `reference_bilingual:${payload.mangaId}:${payload.translatorId}`,
    });
    let dependencyId = null;
    let sequenceNumber = 0;
    const childIds = [];
    for (const window of prepared.plan.windows) {
      if (prepared.completedWindowIds.includes(window.windowId)) continue;
      const child = this.createJob("reference_bilingual_evidence_window", {
        ...parentPayload,
        workflowId: parent.id,
        windowId: window.windowId,
        purpose: window.purpose,
        chapterId: window.chapterId,
        chapterTitle: window.chapterTitle,
      }, {
        workflowId: parent.id,
        parentJobId: parent.id,
        dependencyIds: dependencyId ? [dependencyId] : [],
        laneKey: `reference_bilingual:${payload.mangaId}:${payload.translatorId}`,
        sequenceNumber: sequenceNumber++,
      });
      dependencyId = child.id;
      childIds.push(child.id);
    }
    const commit = this.createJob("reference_bilingual_commit", {
      ...parentPayload,
      workflowId: parent.id,
    }, {
      workflowId: parent.id,
      parentJobId: parent.id,
      dependencyIds: dependencyId ? [dependencyId] : [],
      laneKey: `reference_bilingual:${payload.mangaId}:${payload.translatorId}`,
      sequenceNumber,
    });
    childIds.push(commit.id);
    this.publish(parent.id, "workflow.created", {
      workflowId: parent.id,
      childJobIds: childIds,
      totalWindows: prepared.plan.windows.length,
      reusedWindows: prepared.completedWindowIds.length,
      commitJobId: commit.id,
    });
    return this.getJob(parent.id);
  }

  createReferenceIngestionWorkflow(payload, scheduling) {
    const workflowPayload = {
      ...payload,
      referenceKind: scheduling.referenceKind,
      chapterSortOrder: scheduling.sequenceNumber,
      schedulingWarnings: scheduling.warnings,
    };
    const parent = this.createJob("reference_ingestion", workflowPayload, {
      executionKind: "workflow",
      status: "running",
      stage: "waiting_children",
      laneKey: scheduling.laneKey,
      sequenceNumber: scheduling.sequenceNumber,
    });
    const artifactRoot = path.join(paths.workspaceRoot, parent.id, "reference_ingestion");
    const reusableAnalysisArtifactPath = payload.reuseAnalysisArtifactPath &&
      fs.existsSync(payload.reuseAnalysisArtifactPath)
      ? payload.reuseAnalysisArtifactPath
      : null;
    const analysisArtifactPath = reusableAnalysisArtifactPath ||
      path.join(artifactRoot, "analysis.json");
    const storyArtifactPath = path.join(artifactRoot, "story_delta.json");
    const revisionPlanPath = path.join(artifactRoot, "revision_plan.json");
    const sharedPayload = {
      ...workflowPayload,
      workflowId: parent.id,
      analysisArtifactPath,
      storyArtifactPath,
      revisionPlanPath,
    };
    const observation = this.createJob("reference_observation", sharedPayload, {
      workflowId: parent.id,
      parentJobId: parent.id,
      dependencyIds: scheduling.dependencyIds || [],
      laneKey: scheduling.laneKey,
      sequenceNumber: 0,
      status: reusableAnalysisArtifactPath ? "succeeded" : "queued",
      stage: reusableAnalysisArtifactPath ? "reused" : "queued",
      enqueue: !reusableAnalysisArtifactPath,
    });
    if (reusableAnalysisArtifactPath) {
      const reusedResult = {
        phase: "observation",
        reused: true,
        reusedFromJobId: payload.reuseAnalysisFromJobId || null,
        analysisArtifactPath: reusableAnalysisArtifactPath,
      };
      this.store.updateJob({
        id: observation.id,
        status: "succeeded",
        stage: "reused",
        result: reusedResult,
        error: null,
      });
      this.publish(observation.id, "job.reused", reusedResult);
    }
    let finalDependencyId = observation.id;
    if (scheduling.referenceKind === "source") {
      const story = this.createJob("reference_story_update", sharedPayload, {
        workflowId: parent.id,
        parentJobId: parent.id,
        dependencyIds: [observation.id],
        laneKey: scheduling.laneKey,
        sequenceNumber: 1,
      });
      finalDependencyId = story.id;
    }
    const commitType = scheduling.referenceKind === "source"
      ? "reference_knowledge_commit"
      : "reference_style_commit";
    const commit = this.createJob(commitType, sharedPayload, {
      workflowId: parent.id,
      parentJobId: parent.id,
      dependencyIds: [finalDependencyId],
      laneKey: scheduling.laneKey,
      sequenceNumber: scheduling.referenceKind === "source" ? 2 : 1,
    });
    this.publish(parent.id, "workflow.created", {
      workflowId: parent.id,
      childJobIds: this.store.listChildJobs(parent.id).map((job) => job.id),
      commitJobId: commit.id,
    });
    return this.getJob(parent.id);
  }

  createReferenceIngestionJobs(payloads) {
    if (!Array.isArray(payloads) || payloads.length === 0) {
      throw new Error("Reference ingestion batch requires at least one item.");
    }
    const prepared = payloads.map((payload) => ({
      payload,
      scheduling: this.resolveReferenceIngestionScheduling(payload, { findPredecessor: false }),
    }));
    prepared.sort((left, right) => {
      if (left.scheduling.laneKey !== right.scheduling.laneKey) {
        return left.scheduling.laneKey.localeCompare(right.scheduling.laneKey);
      }
      return (left.scheduling.sequenceNumber ?? Number.MAX_SAFE_INTEGER) -
        (right.scheduling.sequenceNumber ?? Number.MAX_SAFE_INTEGER);
    });

    const jobs = [];
    const lastJobByLane = new Map();
    for (const entry of prepared) {
      const { payload, scheduling } = entry;
      const priorBatchJobId = lastJobByLane.get(scheduling.laneKey);
      const dependencyIds = priorBatchJobId
        ? [priorBatchJobId]
        : this.findReferenceIngestionPredecessors(payload, scheduling);
      const job = this.createReferenceIngestionWorkflow(payload, {
        ...scheduling,
        dependencyIds,
      });
      jobs.push(job);
      lastJobByLane.set(scheduling.laneKey, job.id);
    }
    return jobs;
  }

  resolveReferenceIngestionScheduling(payload, { findPredecessor = true } = {}) {
    let referenceKind = payload.referenceKind === "source" ? "source" : "translator";
    try {
      const manifest = loadReferenceManifest(payload.referenceSetId);
      referenceKind = manifest.referenceKind === "source" ? "source" : "translator";
    } catch (_error) {
      // Scheduling remains backward-compatible; ingestion performs authoritative manifest validation.
    }
    const chapters = payload.mangaId && payload.translatorId
      ? listChapterRegistry({ mangaId: payload.mangaId, translatorId: payload.translatorId })
      : [];
    const chapterIndex = chapters.findIndex((chapter) => chapter.chapterId === payload.chapterId);
    const sequenceNumber = chapterIndex >= 0
      ? chapters[chapterIndex].sortOrder
      : Number.isFinite(payload.chapterSortOrder)
        ? payload.chapterSortOrder
        : null;
    const laneKey = referenceKind === "source"
      ? `source-story:${payload.mangaId || "unknown"}`
      : `translator-reference:${payload.mangaId || "unknown"}:${payload.translatorId || "unknown"}`;
    const warnings = [];
    if (referenceKind === "source" && chapterIndex > 0) {
      const previousChapter = chapters[chapterIndex - 1];
      if (!previousChapter) {
        warnings.push("The previous source chapter could not be resolved from chapter order.");
      }
    }
    const scheduling = {
      referenceKind,
      laneKey,
      sequenceNumber,
      chapters,
      chapterIndex,
      warnings,
      dependencyIds: [],
    };
    if (findPredecessor) {
      scheduling.dependencyIds = this.findReferenceIngestionPredecessors(payload, scheduling);
    }
    return scheduling;
  }

  findReferenceIngestionPredecessors(payload, scheduling) {
    if (scheduling.chapterIndex <= 0) {
      return [];
    }
    const previousChapter = scheduling.chapters[scheduling.chapterIndex - 1];
    const candidates = this.store.listJobs({ includeDeleted: false })
      .filter((job) =>
        job.type === "reference_ingestion" &&
        job.payload?.mangaId === payload.mangaId &&
        job.payload?.chapterId === previousChapter.chapterId &&
        (job.payload?.referenceKind === "source" || job.laneKey === scheduling.laneKey)
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (candidates.length > 0) return [candidates[0].id];
    if (scheduling.referenceKind === "source") {
      const committedRevision = this.store.listKnowledgeRevisions({
        mangaId: payload.mangaId,
        translatorId: payload.translatorId || null,
        includeStale: false,
      }).find((revision) => revision.chapterId === previousChapter.chapterId);
      if (!committedRevision) {
        const error = new Error(
          `Previous source chapter ${previousChapter.chapterTitle || previousChapter.chapterId} must complete Ingestion before ${payload.chapterTitle || payload.chapterId}.`
        );
        error.statusCode = 409;
        throw error;
      }
    }
    return [];
  }

  createPostEditExportJob(payload) {
    return this.createJob("post_edit_export", payload);
  }

  cleanupExpiredTrash() {
    const retentionDays = Number(this.resolvedConfig.defaults?.trashRetentionDays ?? 30);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return [];
    }

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const purgedIds = this.store.purgeDeletedBefore(cutoff);
    if (purgedIds.length > 0) {
      try {
        const { deleteJobDirectories } = require("../maintenance/cleanup_service");
        deleteJobDirectories({ jobIds: purgedIds, paths });
      } catch {
        // Filesystem cleanup is best-effort; DB purge already succeeded.
      }
      this.publishSystem("job.trash_cleanup", {
        purgedIds,
        retentionDays,
      });
    }
    return purgedIds;
  }

  runMaintenanceCleanup({ targets = ["logs", "translated", "workspaces", "postedit"], dryRun = true, overrides = {} } = {}) {
    const { runCleanup } = require("../maintenance/cleanup_service");
    const results = runCleanup({
      targets,
      options: {
        dryRun,
        logRetentionDays: overrides.logRetentionDays ?? this.resolvedConfig.defaults?.logRetentionDays,
        logMaxFiles: overrides.logMaxFiles ?? this.resolvedConfig.defaults?.logMaxFiles,
        translatedRetentionDays: overrides.translatedRetentionDays ?? this.resolvedConfig.defaults?.translatedRetentionDays,
        workspaceRetentionDays: overrides.workspaceRetentionDays ?? this.resolvedConfig.defaults?.workspaceRetentionDays,
        postEditRetentionDays: overrides.postEditRetentionDays ?? this.resolvedConfig.defaults?.postEditRetentionDays,
        olderThanDays: overrides.olderThanDays,
      },
      context: { paths, config: this.resolvedConfig, store: this.store },
    });
    if (!dryRun) {
      this.publishSystem("maintenance.cleanup_completed", { targets, results });
    }
    return results;
  }

  async runJob(jobId) {
    const job = this.store.getJob(jobId);
    if (!job || !["queued", "waiting_dependency"].includes(job.status)) {
      return;
    }

    const hooks = {
      jobId,
      setStage: (status, stage) => {
        this.store.updateJob({ id: jobId, status, stage });
        this.publish(jobId, "job.stage", { status, stage });
        if (job.parentJobId) {
          const parent = this.store.getJob(job.parentJobId);
          if (parent?.executionKind === "workflow") {
            this.store.updateJob({ id: job.parentJobId, status: "running", stage });
          }
          this.publish(job.parentJobId, "workflow.progress", {
            childJobId: jobId,
            childJobType: job.type,
            status,
            stage,
          });
        }
      },
      emit: (type, payload) => {
        this.emitJobEvent(jobId, type, payload);
        if (
          job.parentJobId &&
          (["reference_ingestion.progress", "reference_bilingual_enrichment.progress"].includes(type) ||
            job.type === "translation_knowledge_commit")
        ) {
          this.emitJobEvent(job.parentJobId, type, {
            ...payload,
            childJobId: jobId,
            childJobType: job.type,
          });
        }
      },
      isCanceled: () => this.cancellations.has(jobId),
    };

    this.activeJobs.add(jobId);
    try {
      this.store.updateJob({ id: jobId, blockedReason: null });
      hooks.setStage("running", job.type);
      await this.ensureKoharuReadyForJob(job, hooks);
      assertJobType(job.type, job.executionKind || "job");
      if (job.executionKind === "workflow") {
        throw new Error(`Workflow ${job.type} cannot run as an atomic job.`);
      }
      const result = await this.runAtomicJob(job, hooks);
      if (this.cancellations.has(jobId)) {
        throw new Error("Job canceled by user.");
      }
      let completedResult = result;
      const outcomeSummary = summarizeJobOutcome(result);
      const diagnostics = {
        warningCount: outcomeSummary.warnings.length,
        acceptedRecordCount: outcomeSummary.acceptedRecordCount,
        quarantinedRecordCount: outcomeSummary.quarantinedRecordCount,
        degradedStages: outcomeSummary.degradedStages,
        warnings: outcomeSummary.warnings,
      };
      this.store.updateJob({
        id: jobId,
        status: "succeeded",
        stage: "succeeded",
        result,
        error: null,
        outcome: outcomeSummary.outcome,
        diagnostics,
        resumeMetadata: null,
      });
      this.persistArtifacts(jobId, result);
      if (["translation", "translation_quality_repair", "translation_deep_audit_apply"].includes(job.type) && result?.knowledgePayload) {
        const knowledgeJob = this.createJob("translation_knowledge_commit", result.knowledgePayload, {
          parentJobId: jobId,
          laneKey: `translation_knowledge:${result.knowledgePayload.mangaId || "none"}:${result.knowledgePayload.translatorId || "none"}`,
        });
        if (result.knowledgePayload.publicationRevisionId) {
          this.engine.translationPublicationService?.updateKnowledgeStatus({
            mangaId: result.knowledgePayload.mangaId,
            translatorId: result.knowledgePayload.translatorId,
            chapterId: result.knowledgePayload.chapterId,
            revisionId: result.knowledgePayload.publicationRevisionId,
            status: "queued",
            knowledgeJobId: knowledgeJob.id,
          });
        }
        completedResult = { ...result, knowledgeJobId: knowledgeJob.id };
        this.store.updateJob({ id: jobId, result: completedResult });
        this.publish(jobId, "knowledge.scheduled", {
          knowledgeJobId: knowledgeJob.id,
          learningEvidenceSnapshotPath: result.knowledgePayload.learningEvidenceSnapshotPath,
        });
      }
      if (outcomeSummary.outcome === "partial") {
        this.publish(jobId, "job.partial", diagnostics);
      } else if (outcomeSummary.outcome === "warnings") {
        this.publish(jobId, "job.completed_with_warnings", diagnostics);
      }
      if (outcomeSummary.outcome !== "clean") {
        this.publish(jobId, "stage.degraded", { stage: job.type, outcome: outcomeSummary.outcome, ...diagnostics });
      }
      if (outcomeSummary.quarantinedRecordCount > 0) {
        this.publish(jobId, "evidence.quarantined", {
          stage: job.type,
          count: outcomeSummary.quarantinedRecordCount,
        });
      }
      this.publish(jobId, "job.completed", { ...completedResult, outcome: outcomeSummary.outcome, diagnostics });
      if (job.type === "translation_deep_audit_apply" && job.parentJobId) {
        const source = this.store.getJob(result.sourceTranslationJobId || job.parentJobId);
        if (source) {
          this.store.updateJob({
            id: source.id,
            status: "succeeded",
            stage: "succeeded",
            result: { ...(source.result || {}), ...completedResult, deepAuditAppliedByJobId: jobId },
            error: null,
          });
          this.publish(source.id, "deep_audit.applied", { applyJobId: jobId, publication: result.publication || null });
        }
      }
      if (job.type === "reference_knowledge_commit" || job.type === "reference_style_commit") {
        this.scheduleBilingualEnrichmentAfterCommit(job.payload);
      }
      if (
        job.type === "reference_knowledge_commit" &&
        Array.isArray(result?.staleKnowledgeRevisions) &&
        result.staleKnowledgeRevisions.length > 0 &&
        job.payload?.isReplay !== true
      ) {
        const currentSequence = job.payload.chapterSortOrder;
        const activeWorkflows = this.store.listJobs({ includeDeleted: false })
          .filter((workflow) =>
            workflow.executionKind === "workflow" &&
            workflow.type === "reference_ingestion" &&
            workflow.id !== job.workflowId &&
            ["queued", "running", "waiting_dependency", "cancel_requested"].includes(workflow.status)
          );
        const replayRevisionByChapter = new Map();
        for (const revision of result.staleKnowledgeRevisions
          .filter((revision) =>
            revision.sequenceNumber != null &&
            currentSequence != null &&
            revision.sequenceNumber > currentSequence &&
            !activeWorkflows.some((workflow) =>
              workflow.laneKey === job.laneKey &&
              workflow.sequenceNumber === revision.sequenceNumber &&
              workflow.payload?.chapterId === revision.chapterId
            )
          )
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
          replayRevisionByChapter.set(revision.chapterId, revision);
        }
        const replayPayloads = [...replayRevisionByChapter.values()]
          .sort((left, right) => left.sequenceNumber - right.sequenceNumber)
          .map((revision) => ({
            ...revision.payload,
            isReplay: true,
            replayedFromRevisionId: revision.id,
            reuseAnalysisArtifactPath: revision.analysisArtifactPath ||
              revision.payload?.analysisArtifactPath || null,
          }));
        if (replayPayloads.length > 0) {
          setImmediate(() => {
            const replayJobs = this.createReferenceIngestionJobs(replayPayloads);
            this.publishSystem("knowledge.replay_scheduled", {
              sourceWorkflowId: job.workflowId || job.parentJobId || null,
              replayWorkflowIds: replayJobs.map((entry) => entry.id),
            });
          });
        }
      }
    } catch (error) {
      const canceled = this.cancellations.has(jobId);
      const status = canceled ? "canceled" : "failed";
      const current = this.store.getJob(jobId);
      const checkpointPaths = this.store.getEvents(jobId)
        .map((event) => event.payload?.checkpointPath)
        .filter((checkpointPath) => typeof checkpointPath === "string" && fs.existsSync(checkpointPath));
      const failedWindowEvent = [...this.store.getEvents(jobId)].reverse().find((event) =>
        typeof event.payload?.windowId === "string" &&
        (event.type.endsWith(".window_started") || event.type.endsWith(".window_retrying"))
      );
      const failureDiagnostics = buildAoFailureDiagnostics(error, {
        checkpointPaths: [...new Set(checkpointPaths)],
        failedWindowId: current?.payload?.windowId || failedWindowEvent?.payload?.windowId || null,
        stage: current?.stage || job.stage || null,
        jobType: job.type,
      });
      const resumeMetadata = failureDiagnostics.resumeAvailable
        ? {
            resumeAvailable: true,
            checkpointPaths: failureDiagnostics.checkpointPaths,
            failedWindowId: failureDiagnostics.failedWindowId,
            resourceFailureType: failureDiagnostics.resourceFailureType,
          }
        : null;
      this.store.updateJob({
        id: jobId,
        status,
        stage: status,
        error: canceled ? null : error.message,
        outcome: null,
        diagnostics: canceled ? null : failureDiagnostics,
        resumeMetadata,
      });
      if (!canceled) {
        this.store.addError(jobId, current?.stage || job.stage, error.message);
        if (job.type === "reference_bilingual_evidence_window" || job.type === "reference_bilingual_commit") {
          this.engine.referenceBilingualEnrichmentModule?.markRunFailed(job.payload, error);
        }
      } else if (job.type === "reference_bilingual_evidence_window" || job.type === "reference_bilingual_commit") {
        this.engine.referenceBilingualEnrichmentModule?.markRunStopped(job.payload);
      }
      if (!canceled && resumeMetadata) {
        this.publish(jobId, "job.resume_available", resumeMetadata);
      }
      this.persistArtifacts(jobId, current?.result || null);
      this.publish(
        jobId,
        canceled ? "job.canceled" : "job.failed",
        canceled ? { status } : { error: error.message, status, diagnostics: failureDiagnostics }
      );
      if (job.type === "translation_knowledge_commit" && job.parentJobId) {
        this.publish(job.parentJobId, canceled ? "knowledge.canceled" : "knowledge.failed", {
          knowledgeJobId: jobId,
          error: canceled ? null : error.message,
        });
      }
    } finally {
      this.cancellations.delete(jobId);
      this.activeJobs.delete(jobId);
      this.updateParentWorkflow(job.parentJobId);
      this.scheduleQueueDrain();
    }
  }

  scheduleBilingualEnrichmentAfterCommit(payload) {
    const module = this.engine.referenceBilingualEnrichmentModule;
    if (!module || !payload?.mangaId) return [];
    const translatorIds = payload.referenceKind === "translator" && payload.translatorId
      ? [payload.translatorId]
      : require("../reference/sets/reference_sets").listReferenceSets()
          .filter((entry) => entry.mangaId === payload.mangaId && entry.referenceKind === "translator")
          .map((entry) => entry.translatorId)
          .filter(Boolean);
    const jobs = [];
    for (const translatorId of [...new Set(translatorIds)]) {
      const pendingIngestion = this.store.listJobs({ includeDeleted: false }).some((workflow) =>
        workflow.executionKind === "workflow" &&
        workflow.type === "reference_ingestion" &&
        workflow.id !== payload.workflowId &&
        workflow.payload?.mangaId === payload.mangaId &&
        ["queued", "running", "waiting_dependency", "cancel_requested"].includes(workflow.status) &&
        (workflow.payload?.referenceKind === "source" || workflow.payload?.translatorId === translatorId)
      );
      if (pendingIngestion) continue;
      const prerequisites = module.inspectPrerequisites({ mangaId: payload.mangaId, translatorId });
      if (!prerequisites.ready) continue;
      jobs.push(this.createReferenceBilingualEnrichmentJob({
        mangaId: payload.mangaId,
        translatorId,
        sourceFingerprint: prerequisites.source.fingerprint,
        targetFingerprint: prerequisites.target.fingerprint,
        trigger: "ingestion_commit",
      }));
    }
    return jobs;
  }

  persistArtifacts(jobId, result) {
    if (result?.sourcePreflight?.manifestPath) {
      this.store.addArtifact(jobId, "source_preflight_manifest", result.sourcePreflight.manifestPath, {
        preflightId: result.sourcePreflight.preflightId,
        sourceFolder: result.sourcePreflight.sourceFolder,
        orderedDir: result.sourcePreflight.orderedDir,
        acceptedCount: result.sourcePreflight.summary?.acceptedCount || 0,
      });
    }
    if (result?.artifact?.path) {
      this.store.addArtifact(jobId, "export", result.artifact.path, result.artifact);
    }
    if (result?.postEditDocumentPath) {
      this.store.addArtifact(jobId, "post_edit_document", result.postEditDocumentPath, {
        jobId,
      });
    }
    if (result?.translationMemorySnapshotPath) {
      this.store.addArtifact(jobId, "translation_memory_snapshot", result.translationMemorySnapshotPath, {
        fingerprint: result.translationMemoryFingerprint || null,
        translationMode: result.translationMode || null,
      });
    }
    if (result?.finalTranslationSnapshotPath) {
      this.store.addArtifact(jobId, "final_translation_snapshot", result.finalTranslationSnapshotPath, {
        fingerprint: result.publication?.finalTranslationSnapshotFingerprint || null,
        translationMode: result.translationMode || null,
        publicationRevisionId: result.publication?.revisionId || null,
        publicationStatus: result.publication?.status || null,
      });
    }
    if (result?.learningEvidenceSnapshotPath) {
      this.store.addArtifact(jobId, "learning_evidence_snapshot", result.learningEvidenceSnapshotPath, {});
    }
    if (result?.qualityObservationPath) {
      this.store.addArtifact(jobId, "translation_quality_observation", result.qualityObservationPath, {});
    }
    if (result?.deepAuditReviewPackagePath) {
      this.store.addArtifact(jobId, "deep_audit_review_package", result.deepAuditReviewPackagePath, {
        status: "awaiting_decisions",
        findingCount: result.findings?.length || 0,
      });
    }
    if (result?.qualityReportPath || result?.quality?.reportPath) {
      this.store.addArtifact(jobId, "quality_final_report", result.qualityReportPath || result.quality.reportPath, {
        status: result.quality?.status || null,
        finalScore: result.quality?.finalScore ?? null,
      });
    }
    if (result?.publication?.registryPath) {
      this.store.addArtifact(jobId, "translation_publication_registry", result.publication.registryPath, {
        revisionId: result.publication.revisionId,
        status: result.publication.status,
        chapterId: result.publication.chapterId,
      });
    }
    if (result?.reportPath && result?.sourceTranslationJobId && result?.snapshotFingerprint) {
      this.store.addArtifact(jobId, "translation_deep_audit_report", result.reportPath, {
        sourceTranslationJobId: result.sourceTranslationJobId,
        windowCount: result.windowCount || 0,
      });
    }
    if (result?.output) {
      this.store.addArtifact(jobId, "knowledge_base", result.output, {
        mangaId: result.mangaId || null,
        translatorId: result.translatorId || null,
        chapterId: result.chapterId || null,
      });
    }
    if (result?.report) {
      this.store.addArtifact(jobId, "knowledge_report", result.report, {
        mangaId: result.mangaId || null,
        translatorId: result.translatorId || null,
        chapterId: result.chapterId || null,
      });
    }
    if (result?.editedScenePath) {
      this.store.addArtifact(jobId, "edited_scene", result.editedScenePath, {
        sourceJobId: result.sourceJobId || jobId,
      });
    }
    if (result?.scenePath) {
      this.store.addArtifact(jobId, "reference_scene", result.scenePath, {
        referenceSetId: result.referenceSetId,
      });
    }
    if (result?.textsPath) {
      this.store.addArtifact(jobId, "reference_texts", result.textsPath, {
        referenceSetId: result.referenceSetId,
      });
    }
    if (result?.observationPath) {
      this.store.addArtifact(jobId, "chapter_observation", result.observationPath, {
        referenceSetId: result.referenceSetId || null,
        chapterId: result.chapterId || null,
      });
    }
    if (result?.bilingualEvidencePath) {
      this.store.addArtifact(jobId, "bilingual_evidence", result.bilingualEvidencePath, {
        mangaId: result.mangaId || null,
        translatorId: result.translatorId || null,
      });
    }
    if (result?.checkpointPath) {
      this.store.addArtifact(jobId, "bilingual_evidence_checkpoint", result.checkpointPath, {
        planHash: result.planHash || null,
        windowId: result.windowId || null,
        purpose: result.purpose || null,
        reused: result.reused === true,
      });
    }
    if (result?.glossaryPath) {
      this.store.addArtifact(jobId, "glossary", result.glossaryPath, {
        mangaId: result.mangaId,
        referenceSetId: result.referenceSetId,
      });
    }
    if (result?.candidateTermsPath) {
      this.store.addArtifact(jobId, "candidate_terms", result.candidateTermsPath, {
        mangaId: result.mangaId,
        referenceSetId: result.referenceSetId,
      });
    }
    if (result?.storyContextPath) {
      this.store.addArtifact(jobId, "story_context", result.storyContextPath, {
        mangaId: result.mangaId,
        referenceSetId: result.referenceSetId,
      });
    }
    if (result?.styleEvidencePath) {
      this.store.addArtifact(jobId, "style_evidence", result.styleEvidencePath, {
        mangaId: result.mangaId,
        referenceSetId: result.referenceSetId,
      });
    }
    if (result?.styleProfilePath) {
      this.store.addArtifact(jobId, "style_profile", result.styleProfilePath, {
        mangaId: result.mangaId,
        referenceSetId: result.referenceSetId,
      });
    }
    if (result?.translationContextPath) {
      this.store.addArtifact(jobId, "translation_context", result.translationContextPath, {
        mangaId: result.mangaId,
        chapterId: result.chapterId || null,
        referenceSetId: result.referenceSetId,
      });
    }
    if (result?.analysisArtifactPath) {
      this.store.addArtifact(jobId, "reference_ingestion_analysis", result.analysisArtifactPath, {
        referenceSetId: result.referenceSetId || null,
        mangaId: result.mangaId || null,
        chapterId: result.chapterId || null,
        workflowId: result.workflowId || null,
      });
    }
    if (result?.storyArtifactPath) {
      this.store.addArtifact(jobId, "reference_ingestion_story_delta", result.storyArtifactPath, {
        referenceSetId: result.referenceSetId || null,
        mangaId: result.mangaId || null,
        chapterId: result.chapterId || null,
        workflowId: result.workflowId || null,
      });
    }
    if (result?.revisionPlanPath) {
      this.store.addArtifact(jobId, "knowledge_revision_plan", result.revisionPlanPath, {
        workflowId: result.workflowId || null,
        revisionId: result.knowledgeRevision?.id || result.revisionId || null,
        chapterId: result.chapterId || null,
      });
    }
    if (result?.knowledgeRevision?.afterSnapshotPath) {
      this.store.addArtifact(
        jobId,
        "knowledge_revision_snapshot",
        result.knowledgeRevision.afterSnapshotPath,
        {
          revisionId: result.knowledgeRevision.id,
          chapterId: result.knowledgeRevision.chapterId,
          sequenceNumber: result.knowledgeRevision.sequenceNumber,
        }
      );
    }
    if (result?.quality?.reportPath) {
      this.store.addArtifact(jobId, "quality_validation_report", result.quality.reportPath, {
        mangaId: result.mangaId || null,
        chapterId: result.chapterId || null,
        coverage: result.quality.coverage || 0,
        candidateCount: result.quality.candidateCount || 0,
        windowCount: result.quality.windowCount || 0,
      });
    }

    for (const artifact of collectWorkspaceManifestArtifacts(jobId)) {
      this.store.addArtifact(jobId, artifact.kind, artifact.path, artifact.metadata);
    }
  }

  cancelJob(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) {
      return null;
    }
    if (["succeeded", "failed", "canceled", "blocked"].includes(job.status)) {
      return this.getJob(jobId);
    }
    if (job.executionKind === "workflow") {
      let stopping = false;
      for (const child of this.store.listChildJobs(job.id)) {
        if (!["succeeded", "failed", "canceled", "blocked"].includes(child.status)) {
          this.cancelJob(child.id);
          if (this.activeJobs.has(child.id)) {
            stopping = true;
          }
        }
      }
      const status = stopping ? "cancel_requested" : "canceled";
      this.store.updateJob({ id: job.id, status, stage: status, error: null });
      this.publish(job.id, stopping ? "workflow.cancel_requested" : "workflow.canceled", {
        workflowId: job.id,
      });
      return this.getJob(job.id);
    }
    if (["queued", "waiting_dependency"].includes(job.status)) {
      this.pendingQueue = this.pendingQueue.filter((pendingId) => pendingId !== jobId);
      this.store.updateJob({ id: jobId, status: "canceled", stage: "canceled", error: null });
      this.publish(jobId, "job.canceled", { jobId, status: "canceled" });
      return this.getJob(jobId);
    }
    if (!this.activeJobs.has(jobId)) {
      this.store.updateJob({ id: jobId, status: "canceled", stage: "canceled", error: null });
      this.publish(jobId, "job.canceled", { jobId, status: "canceled", recovered: true });
      return this.getJob(jobId);
    }
    this.cancellations.add(jobId);
    this.store.updateJob({ id: jobId, status: "cancel_requested" });
    this.publish(jobId, "job.cancel_requested", { jobId });
    return this.getJob(jobId);
  }

  deleteJob(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) {
      return null;
    }
    if (!["succeeded", "failed", "canceled", "blocked"].includes(job.status)) {
      this.cancelJob(jobId);
    }

    const descendants = this.collectDescendantJobs(job.id);
    for (const child of descendants) {
      if (!["succeeded", "failed", "canceled", "blocked"].includes(child.status)) {
        this.cancelJob(child.id);
      }
      this.store.softDeleteJob(child.id);
    }
    const deleted = this.store.softDeleteJob(jobId);
    this.emitJobListUpdate("job.deleted", { jobId }, deleted);
    this.publishSystem("job.deleted", { jobId, status: deleted.status, type: deleted.type });
    return deleted;
  }

  deleteJobs(jobIds) {
    if (!Array.isArray(jobIds) || jobIds.length === 0) {
      return { deleted: [], missing: [] };
    }

    const deleted = [];
    const missing = [];
    for (const jobId of jobIds) {
      const job = this.store.getJob(jobId);
      if (!job) {
        missing.push(jobId);
        continue;
      }
      const removed = this.deleteJob(jobId);
      this.emitJobListUpdate("job.deleted", { jobId }, removed);
      deleted.push({
        id: removed.id,
        status: removed.status,
        type: removed.type,
      });
    }
    if (deleted.length > 0) {
      this.publishSystem("job.batch_deleted", {
        jobIds: deleted.map((entry) => entry.id),
      });
    }
    return { deleted, missing };
  }

  restoreJob(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) {
      return null;
    }
    if (!job.deletedAt) {
      return job;
    }

    const restored = this.store.restoreJob(jobId);
    for (const child of this.collectDescendantJobs(job.id)) {
      this.store.restoreJob(child.id);
    }
    this.emitJobListUpdate("job.restored", { jobId }, restored);
    this.publishSystem("job.restored", { jobId, status: restored.status, type: restored.type });
    return restored;
  }

  restoreJobs(jobIds) {
    if (!Array.isArray(jobIds) || jobIds.length === 0) {
      return { restored: [], missing: [] };
    }

    const restored = [];
    const missing = [];
    for (const jobId of jobIds) {
      const job = this.store.getJob(jobId);
      if (!job) {
        missing.push(jobId);
        continue;
      }
      const recovered = this.restoreJob(jobId);
      this.emitJobListUpdate("job.restored", { jobId }, recovered);
      restored.push({
        id: recovered.id,
        status: recovered.status,
        type: recovered.type,
      });
    }
    if (restored.length > 0) {
      this.publishSystem("job.batch_restored", {
        jobIds: restored.map((entry) => entry.id),
      });
    }
    return { restored, missing };
  }

  purgeJob(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) {
      return null;
    }
    if (!job.deletedAt) {
      throw new Error("Only trashed jobs can be permanently deleted.");
    }
    if (!["succeeded", "failed", "canceled", "blocked"].includes(job.status)) {
      if (this.activeJobs.has(jobId)) {
        this.cancelJob(jobId);
        throw new Error("The job is still stopping. Try permanent deletion again after it becomes canceled.");
      }
      this.store.updateJob({ id: jobId, status: "canceled", stage: "canceled", error: null });
    }

    const descendants = this.collectDescendantJobs(job.id);
    for (const child of descendants) {
      if (!["succeeded", "failed", "canceled", "blocked"].includes(child.status)) {
        if (this.activeJobs.has(child.id)) {
          this.cancelJob(child.id);
          throw new Error(
            `Child job ${child.id} is still stopping. Try permanent deletion again after it becomes canceled.`
          );
        }
        this.store.updateJob({ id: child.id, status: "canceled", stage: "canceled", error: null });
      }
    }
    for (const child of descendants.slice().reverse()) {
      const removedChild = this.store.deleteJob(child.id);
      if (removedChild) {
        this.publishSystem("job.purged", {
          jobId: removedChild.id,
          status: removedChild.status,
          type: removedChild.type,
        });
      }
    }
    const purged = this.store.deleteJob(jobId);
    this.events.emit("jobs", {
      kind: "system",
      type: "job.purged",
      payload: { jobId, status: purged.status, type: purged.type },
      createdAt: new Date().toISOString(),
    });
    this.publishSystem("job.purged", { jobId, status: purged.status, type: purged.type });
    return purged;
  }

  purgeJobs(jobIds) {
    if (!Array.isArray(jobIds) || jobIds.length === 0) {
      return { purged: [], missing: [] };
    }

    const purged = [];
    const missing = [];
    for (const jobId of jobIds) {
      const job = this.store.getJob(jobId);
      if (!job) {
        missing.push(jobId);
        continue;
      }
      const removed = this.purgeJob(jobId);
      purged.push({
        id: removed.id,
        status: removed.status,
        type: removed.type,
      });
    }
    if (purged.length > 0) {
      this.publishSystem("job.batch_purged", {
        jobIds: purged.map((entry) => entry.id),
      });
    }
    return { purged, missing };
  }

  retryJob(jobId) {
    const current = this.store.getJob(jobId);
    if (!current) {
      return null;
    }
    if (
      current.type === "reference_bilingual_enrichment" ||
      current.type === "reference_bilingual_evidence_window" ||
      current.type === "reference_bilingual_commit"
    ) {
      const parent = current.type === "reference_bilingual_enrichment"
        ? current
        : this.store.getJob(current.parentJobId);
      if (!parent?.payload?.mangaId || !parent?.payload?.translatorId) {
        throw new Error("Bilingual enrichment retry requires its parent workflow context.");
      }
      return this.createReferenceBilingualEnrichmentJob({
        mangaId: parent.payload.mangaId,
        translatorId: parent.payload.translatorId,
        trigger: "retry",
        retryOf: parent.id,
      });
    }
    if (current.executionKind === "workflow" && current.type === "reference_ingestion") {
      const reusableAnalysis = (workflow) => {
        const analysis = this.store
          .listChildJobs(workflow.id)
          .find((child) =>
            child.type === "reference_observation" &&
            child.status === "succeeded" &&
            fs.existsSync(child.result?.analysisArtifactPath || child.payload?.analysisArtifactPath || "")
          );
        return analysis
          ? {
              path: analysis.result?.analysisArtifactPath || analysis.payload.analysisArtifactPath,
              jobId: analysis.id,
            }
          : null;
      };
      const retryPayload = (workflow) => {
        const analysis = reusableAnalysis(workflow);
        return {
          ...workflow.payload,
          retryOf: workflow.id,
          reuseAnalysisArtifactPath: analysis?.path || null,
          reuseAnalysisFromJobId: analysis?.jobId || null,
        };
      };
      const isOrderedReference = current.laneKey && Number.isFinite(current.sequenceNumber);
      if (isOrderedReference) {
        const latestBySequence = new Map();
        for (const workflow of this.store.listJobs({ includeDeleted: false })) {
          if (
            workflow.executionKind !== "workflow" ||
            workflow.type !== "reference_ingestion" ||
            workflow.laneKey !== current.laneKey ||
            !Number.isFinite(workflow.sequenceNumber) ||
            workflow.sequenceNumber >= current.sequenceNumber
          ) {
            continue;
          }
          const existing = latestBySequence.get(workflow.sequenceNumber);
          if (!existing || workflow.createdAt > existing.createdAt) {
            latestBySequence.set(workflow.sequenceNumber, workflow);
          }
        }
        const retryChain = [...latestBySequence.values()]
          .filter((workflow) => ["failed", "blocked"].includes(workflow.status))
          .concat(current)
          .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
        if (retryChain.length > 1) {
          const retried = this.createReferenceIngestionJobs(retryChain.map(retryPayload));
          return retried[retried.length - 1];
        }
      }
      return this.createReferenceIngestionJob(retryPayload(current));
    }
    if (current.type === "translation_knowledge_commit" || current.type === "translation_deep_audit") {
      return this.createJob(current.type, {
        ...current.payload,
      }, {
        retryOf: jobId,
        parentJobId: current.parentJobId || null,
        laneKey: current.laneKey || null,
      });
    }
    if (current.type === "translation_quality_repair") {
      const reusable = collectQualityCheckpoints(this.store, [current]);
      const {
        allowPendingLocalRevalidation: _obsoleteRevalidationFlag,
        ...retryPayload
      } = current.payload || {};
      const previousResume = current.payload?.resumeFromTranslation || {};
      return this.createJob("translation_quality_repair", {
        ...retryPayload,
        resumeFromTranslation: {
          ...previousResume,
          qualityCheckpointPaths: [...new Set([
            ...(previousResume.qualityCheckpointPaths || []),
            ...reusable.qualityCheckpointPaths,
          ])].filter((checkpointPath) => typeof checkpointPath === "string" && fs.existsSync(checkpointPath)),
          qualityObservationCheckpointPaths: [...new Set([
            ...(previousResume.qualityObservationCheckpointPaths || []),
            ...reusable.qualityObservationCheckpointPaths,
          ])].filter((checkpointPath) => typeof checkpointPath === "string" && fs.existsSync(checkpointPath)),
        },
      }, {
        retryOf: jobId,
        parentJobId: current.parentJobId || null,
        laneKey: current.laneKey || null,
      });
    }
    if (current.type === "translation") {
      const events = this.store.getEvents(jobId);
      const setup = events.find((event) => event.type === "setup.completed")?.payload || null;
      const memory = events.find((event) => event.type === "translation_memory.built")?.payload || null;
      const pipelineCompleted = events.some((event) => event.type === "pipeline.completed");
      const previousResume = current.payload?.resumeFromTranslation || null;
      const quality = events.find((event) => event.type === "quality.completed")?.payload || null;
      const partialQualityCheckpointPaths = [...new Set([
        ...(previousResume?.qualityCheckpointPaths || []),
        ...events
          .filter((event) => event.type === "quality.window.completed" || event.type === "quality.window.reused")
          .map((event) => event.payload?.checkpointPath)
          .filter((checkpointPath) => typeof checkpointPath === "string" && fs.existsSync(checkpointPath)),
      ])];
      const qualityObservationCheckpointPaths = [...new Set([
        ...(previousResume?.qualityObservationCheckpointPaths || []),
        ...events
          .filter((event) => event.type === "quality_observation.window_completed" || event.type === "quality_observation.window_reused")
          .map((event) => event.payload?.checkpointPath)
          .filter((checkpointPath) => typeof checkpointPath === "string" && fs.existsSync(checkpointPath)),
      ])];
      const projectName = setup?.projectName || previousResume?.projectName || null;
      const memoryPath = memory?.path || previousResume?.translationMemorySnapshotPath || null;
      if (
        (pipelineCompleted || previousResume) &&
        typeof projectName === "string" && projectName.length > 0 &&
        typeof memoryPath === "string" && fs.existsSync(memoryPath)
      ) {
        const qualityCanBeReused = Boolean(
          quality?.reportPath && fs.existsSync(quality.reportPath) &&
          quality?.projectionPath && fs.existsSync(quality.projectionPath)
        );
        return this.createJob("translation", {
          ...current.payload,
          resumeFromTranslation: {
            sourceJobId: jobId,
            projectName,
            operationId: setup?.operationId || previousResume?.operationId || null,
            engines: setup?.engines || previousResume?.engines || {},
            steps: setup?.steps || previousResume?.steps || [],
            translationMemorySnapshotPath: memoryPath,
            resumeAtStage: qualityCanBeReused ? "learning_evidence" : "quality_context",
            qualityReportPath: qualityCanBeReused ? quality.reportPath : null,
            qualityProjectionPath: qualityCanBeReused ? quality.projectionPath : null,
            qualityCheckpointPaths: qualityCanBeReused
              ? quality.checkpointPaths || partialQualityCheckpointPaths
              : partialQualityCheckpointPaths,
            qualityObservationCheckpointPaths,
          },
        }, { retryOf: jobId });
      }
    }
    return this.createJob(current.type, {
      ...current.payload,
    }, { retryOf: jobId });
  }

  resumeJob(jobId) {
    const current = this.store.getJob(jobId);
    if (!current) return null;
    if (current.status !== "failed" || current.resumeMetadata?.resumeAvailable !== true) {
      const error = new Error("Only a failed job with compatible checkpoints can be resumed.");
      error.statusCode = 409;
      throw error;
    }
    return this.retryJob(jobId);
  }

  getJob(jobId) {
    this.cleanupExpiredTrash();
    const job = this.store.getJob(jobId);
    if (!job) {
      return null;
    }
    const children = typeof this.store.listChildJobs === "function"
      ? this.store.listChildJobs(jobId).map((child) => ({
          ...child,
          events: this.store.getEvents(child.id),
          artifacts: this.store.getArtifacts(child.id),
        }))
      : [];
    return {
      ...job,
      events: this.store.getEvents(jobId),
      artifacts: this.store.getArtifacts(jobId),
      children,
    };
  }

  listJobs() {
    this.cleanupExpiredTrash();
    return this.store.listJobs().map((job) => ({
      ...job,
      events: this.store.getEvents(job.id),
      artifacts: this.store.getArtifacts(job.id),
    }));
  }

  listJobsWithDeleted() {
    this.cleanupExpiredTrash();
    return this.store.listJobs({ includeDeleted: true }).map((job) => ({
      ...job,
      events: this.store.getEvents(job.id),
      artifacts: this.store.getArtifacts(job.id),
    }));
  }

  getJobEvents(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) {
      return null;
    }
    return this.store.getEvents(jobId);
  }

  getJobArtifacts(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) {
      return null;
    }
    return this.store.getArtifacts(jobId);
  }

  getConfig() {
    return this.resolvedConfig;
  }

  async getRuntimeStatus() {
    const koharuStatus = this.koharuRuntimeManager
      ? await this.koharuRuntimeManager.inspect()
      : {
          status: this.resolvedConfig.api?.baseUrl ? "configured" : "unconfigured",
          mode: "external",
          baseUrl: this.resolvedConfig.api?.baseUrl || null,
          version: this.resolvedConfig.koharuRuntime?.version || null,
          installed: false,
          managedPid: null,
          lastError: null,
        };
    let agentStatus = "unconfigured";
    let agentError = null;
    if (this.resolvedConfig.agent?.baseUrl) {
      if (this.aoClient?.checkAvailability) {
        try {
          await this.aoClient.checkAvailability({ timeoutMs: 1500 });
          agentStatus = "ready";
        } catch (error) {
          agentStatus = "unavailable";
          agentError = error.message;
        }
      } else {
        agentStatus = "configured";
      }
    }
    return {
      backend: {
        status: "ready",
        host: this.runtimeConfig.host,
        port: this.runtimeConfig.port,
        deploymentMode: process.env.MANGA_TRANSLATION_BACKEND_MODE || "standalone",
      },
      koharu: {
        ...koharuStatus,
        baseUrl: koharuStatus.baseUrl || this.resolvedConfig.api?.baseUrl || null,
      },
      agent: {
        status: agentStatus,
        baseUrl: this.resolvedConfig.agent?.baseUrl || null,
        model: this.resolvedConfig.agent?.model || null,
        agentName: this.resolvedConfig.agent?.agentName || null,
        lastError: agentError,
      },
      quality: {
        enabled: this.resolvedConfig.workflow?.qualityCheck?.enabled !== false,
        modelId: this.resolvedConfig.quality?.modelId || null,
        serverUrl: this.resolvedConfig.quality?.serverUrl || null,
      },
      translation: {
        defaultTarget: this.resolvedConfig.translation?.defaultTarget || null,
      },
    };
  }

  async getReadiness() {
    const runtime = await this.getRuntimeStatus();
    const koharuReady = runtime.koharu.status === "running";
    const agentReady = runtime.agent.status === "ready";
    const blockers = koharuReady ? [] : [{
      service: "koharu",
      code: "koharu_unavailable",
      message: runtime.koharu.lastError || `Koharu is not reachable at ${runtime.koharu.baseUrl || "the configured endpoint"}.`,
    }];
    const warnings = agentReady ? [] : [{
      service: "ao",
      code: "ao_unavailable",
      message: runtime.agent.lastError || `AO is not ready at ${runtime.agent.baseUrl || "the configured endpoint"}.`,
    }];
    return {
      ok: koharuReady,
      status: !koharuReady ? "blocked" : agentReady ? "ready" : "degraded",
      checkedAt: new Date().toISOString(),
      deploymentMode: runtime.backend.deploymentMode,
      services: {
        backend: { required: true, ready: true, status: runtime.backend.status },
        koharu: {
          required: true,
          ready: koharuReady,
          status: runtime.koharu.status,
          mode: runtime.koharu.mode,
          baseUrl: runtime.koharu.baseUrl,
        },
        ao: {
          required: false,
          ready: agentReady,
          status: runtime.agent.status,
          baseUrl: runtime.agent.baseUrl,
        },
      },
      capabilities: {
        koharuJobs: koharuReady,
        aoJobs: agentReady,
      },
      blockers,
      warnings,
    };
  }

  subscribe(jobId, listener) {
    const channel = `job:${jobId}`;
    this.events.on(channel, listener);
    return () => this.events.off(channel, listener);
  }

  subscribeAll(listener) {
    this.events.on("jobs", listener);
    return () => this.events.off("jobs", listener);
  }

  emitJobEvent(jobId, type, payload) {
    const createdAt = new Date().toISOString();
    this.store.addEvent(jobId, type, payload, createdAt);
    const job = this.store.getJob(jobId);
    const message = {
      type,
      payload,
      createdAt,
      job: this.toJobSummary(job),
    };
    this.events.emit(`job:${jobId}`, message);
    this.events.emit("jobs", {
      kind: "job",
      ...message,
    });
  }

  createTranslationKnowledgeRetryJob(sourceJobId) {
    const source = this.store.getJob(sourceJobId);
    const supportedTypes = new Set(["translation", "translation_quality_repair", "translation_deep_audit_apply"]);
    if (!source || !supportedTypes.has(source.type) || source.status !== "succeeded") {
      throw new Error("Knowledge retry requires a completed translation publication job.");
    }
    const payload = source.result?.knowledgePayload;
    if (!payload?.publicationRevisionId || !payload?.learningEvidenceSnapshotPath) {
      throw new Error("Knowledge retry requires persisted learning evidence and a publication revision.");
    }
    if (!fs.existsSync(payload.learningEvidenceSnapshotPath)) {
      throw new Error("Knowledge retry learning evidence file is missing.");
    }
    const publication = this.engine.translationPublicationService?.getChapter(
      payload.mangaId,
      payload.translatorId,
      payload.chapterId
    );
    const revision = publication?.revisions?.find((entry) => entry.revisionId === payload.publicationRevisionId);
    if (!revision || publication.activeRevisionId !== revision.revisionId || revision.qualityStatus !== "passed") {
      throw new Error("Knowledge retry requires the active, Quality-passed publication revision.");
    }
    if (revision.knowledgeStatus === "committed") {
      throw new Error("Knowledge is already committed for this publication revision.");
    }
    const existing = this.store.listJobs({ includeDeleted: true }).find((job) =>
      job.type === "translation_knowledge_commit" &&
      job.payload?.publicationRevisionId === revision.revisionId &&
      ["queued", "waiting_dependency", "running", "succeeded"].includes(job.status)
    );
    if (existing) {
      throw new Error(`Knowledge job ${existing.id} already exists for this publication revision.`);
    }
    const knowledgeJob = this.createJob("translation_knowledge_commit", payload, {
      parentJobId: source.id,
      laneKey: `translation_knowledge:${payload.mangaId}:${payload.translatorId}`,
    });
    this.engine.translationPublicationService.updateKnowledgeStatus({
      mangaId: payload.mangaId,
      translatorId: payload.translatorId,
      chapterId: payload.chapterId,
      revisionId: payload.publicationRevisionId,
      status: "queued",
      knowledgeJobId: knowledgeJob.id,
    });
    return knowledgeJob;
  }

  emitJobListUpdate(type, payload, job) {
    this.events.emit("jobs", {
      kind: "job",
      type,
      payload,
      job: this.toJobSummary(job),
      createdAt: new Date().toISOString(),
    });
  }

  publish(jobId, type, payload) {
    this.emitJobEvent(jobId, type, payload);
  }

  publishSystem(type, payload) {
    this.events.emit("system", { type, payload });
    this.events.emit("jobs", {
      kind: "system",
      type,
      payload,
      createdAt: new Date().toISOString(),
    });
  }
}

module.exports = {
  JobManager,
  collectWorkspaceManifestArtifacts,
};
