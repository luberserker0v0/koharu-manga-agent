import type { GuiJob, GuiJobStatus, GuiJobType } from "../../../api/jobs";

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export type JobWorkflowViewModel = {
  root: GuiJob;
  stages: GuiJob[];
  effectiveStages: GuiJob[];
  supersededStageIds: string[];
  completedStages: number;
  activeStage: GuiJob | null;
  failedStage: GuiJob | null;
};

const JOB_TYPE_KEYS: Record<GuiJobType, string> = {
  reference_extraction: "jobList.type.referenceExtraction",
  reference_observation: "jobList.type.referenceObservation",
  reference_deep_review: "jobList.type.referenceDeepReview",
  reference_ingestion: "jobList.type.referenceIngestion",
  reference_story_update: "jobList.type.referenceStoryUpdate",
  reference_knowledge_commit: "jobList.type.referenceKnowledgeCommit",
  reference_style_commit: "jobList.type.referenceStyleCommit",
  reference_bilingual_enrichment: "jobList.type.referenceBilingualEnrichment",
  reference_bilingual_evidence_window: "jobList.type.referenceBilingualEvidenceWindow",
  reference_bilingual_commit: "jobList.type.referenceBilingualCommit",
  translation: "jobList.type.translation",
  translation_knowledge_commit: "jobList.type.translationKnowledgeCommit",
  translation_deep_audit: "jobList.type.translationDeepAudit",
  translation_deep_audit_apply: "jobList.type.translationDeepAuditApply",
  translation_quality_repair: "jobList.type.translationQualityRepair",
  post_edit_export: "jobList.type.postEditExport",
};

const JOB_STATUS_KEYS: Record<GuiJobStatus, string> = {
  queued: "jobList.status.queued",
  waiting_dependency: "jobList.status.waitingDependency",
  running: "jobList.status.running",
  cancel_requested: "jobList.status.cancelRequested",
  succeeded: "jobList.status.succeeded",
  failed: "jobList.status.failed",
  canceled: "jobList.status.canceled",
  blocked: "jobList.status.blocked",
};

export function jobTypeKey(type: GuiJobType | string) {
  return JOB_TYPE_KEYS[type as GuiJobType] || "jobList.type.unknown";
}

export function jobStatusKey(status: GuiJobStatus | string) {
  return JOB_STATUS_KEYS[status as GuiJobStatus] || "jobList.status.unknown";
}

export function jobOutcomeKey(outcome: GuiJob["outcome"]) {
  if (outcome === "warnings") return "jobList.outcome.warnings";
  if (outcome === "partial") return "jobList.outcome.partial";
  return "jobList.outcome.clean";
}

export function resolveJobStageLabel(stage: string, t: Translate) {
  const qualityObservation = stage.match(/^quality_observation_(\d+)_of_(\d+)(?:_(?:split|degraded))?$/);
  if (qualityObservation) return t("jobList.stage.qualityObservation", { current: qualityObservation[1], total: qualityObservation[2] });
  const purposeQualityWindow = stage.match(/^standard_quality_(completeness|sequence|terminology|style|story|representative|review)_(\d+)_of_(\d+)$/);
  if (purposeQualityWindow) {
    return t("jobList.stage.standardQualityPurpose", {
      purpose: t(`jobList.qualityPurpose.${purposeQualityWindow[1]}`),
      current: purposeQualityWindow[2],
      total: purposeQualityWindow[3],
    });
  }
  const qualityWindow = stage.match(/^standard_quality_(\d+)_of_(\d+)$/);
  if (qualityWindow) return t("jobList.stage.standardQuality", { current: qualityWindow[1], total: qualityWindow[2] });
  const deepAuditWindow = stage.match(/^deep_audit_(\d+)_of_(\d+)$/);
  if (deepAuditWindow) return t("jobList.stage.deepAudit", { current: deepAuditWindow[1], total: deepAuditWindow[2] });
  const keys: Record<string, string> = {
    queued: "jobList.stage.waiting",
    waiting_dependency: "jobList.stage.waitingDependency",
    running: "jobList.stage.running",
    failed: "jobList.stage.failed",
    succeeded: "jobList.stage.succeeded",
    koharu_runtime: "jobList.stage.koharuRuntime",
    source_preflight: "jobList.stage.sourcePreflight",
    extract_reference: "jobList.stage.extractReference",
    reference_observation: "jobList.stage.referenceObservation",
    reference_deep_review: "jobList.stage.referenceDeepReview",
    bilingual_evidence_window: "jobList.stage.bilingualEvidenceWindow",
    bilingual_commit: "jobList.stage.bilingualCommit",
    reference_ingestion: "jobList.stage.referenceIngestion",
    "reference_ingestion.prepare_revision": "jobList.stage.referencePrepareRevision",
    reference_locale_projection: "jobList.stage.referenceLocaleProjection",
    resume_quality: "jobList.stage.resumeQuality",
    setup_project: "jobList.stage.setupProject",
    monitor_pipeline: "jobList.stage.monitorPipeline",
    translation_chapter_observation: "jobList.stage.translationObservation",
    learning_evidence: "jobList.stage.learningEvidence",
    quality_context: "jobList.stage.qualityContext",
    quality_apply: "jobList.stage.qualityApply",
    quality_verification: "jobList.stage.qualityVerification",
    lightweight_knowledge_learning: "jobList.stage.lightweightKnowledge",
    deep_audit_apply_open_project: "jobList.stage.deepAuditApplyOpenProject",
    deep_audit_apply_render: "jobList.stage.deepAuditApplyRender",
    export: "jobList.stage.export",
    close_project: "jobList.stage.closeProject",
    rebuild_project: "jobList.stage.rebuildProject",
    apply_post_edit: "jobList.stage.applyPostEdit",
  };
  return keys[stage] ? t(keys[stage]) : stage;
}

export function jobMeta(job: GuiJob) {
  return {
    mangaId: typeof job.payload.mangaId === "string" ? job.payload.mangaId : "none",
    translatorId: typeof job.payload.translatorId === "string" ? job.payload.translatorId : "none",
    chapterId: typeof job.payload.chapterId === "string" ? job.payload.chapterId : "none",
    chapterTitle:
      typeof job.payload.chapterTitle === "string"
        ? job.payload.chapterTitle
        : typeof job.payload.chapterLabel === "string"
          ? job.payload.chapterLabel
          : "none",
  };
}

export function isTerminalJob(job: GuiJob) {
  return ["succeeded", "failed", "canceled", "blocked"].includes(job.status);
}

export function resolveBilingualWindowAttempt(job: GuiJob) {
  const resultAttempt = (job.result as { attemptCount?: unknown } | null)?.attemptCount;
  if (typeof resultAttempt === "number") return resultAttempt;
  const events = Array.isArray(job.events) ? job.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index].payload as { attempt?: unknown } | null;
    if (typeof payload?.attempt === "number") return payload.attempt;
  }
  return 0;
}

export function resolveJobTranslationMode(job: GuiJob, t: Translate) {
  if (job.type === "reference_extraction" || job.type === "reference_observation") {
    return {
      label: t("jobList.mode.referenceExtraction.label"),
      description: t("jobList.mode.referenceExtraction.description"),
    };
  }
  if (
    job.type === "reference_ingestion" ||
    job.type === "reference_bilingual_enrichment" ||
    job.type === "reference_bilingual_evidence_window" ||
    job.type === "reference_bilingual_commit"
  ) {
    return job.payload.referenceKind === "source"
      ? {
          label: t("jobList.mode.sourceIngestion.label"),
          description: t("jobList.mode.sourceIngestion.description"),
        }
      : {
          label: t("jobList.mode.translatorIngestion.label"),
          description: t("jobList.mode.translatorIngestion.description"),
        };
  }
  const translationMode = typeof job.payload.translationMode === "string"
    ? job.payload.translationMode
    : null;
  if (["quick", "reference_style", "local_style", "learning_style"].includes(translationMode || "")) {
    return {
      label: t(`jobList.mode.${translationMode}`),
      description: t(`jobList.mode.${translationMode}.description`),
    };
  }
  return {
    label: t("jobList.mode.translation.label"),
    description: t("jobList.mode.translation.description"),
  };
}

export function buildJobWorkflows(jobs: GuiJob[]): JobWorkflowViewModel[] {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const retryTarget = (job: GuiJob) => {
    const payloadRetryOf = typeof job.payload.retryOf === "string" ? job.payload.retryOf : null;
    return job.retryOf || payloadRetryOf;
  };
  const supersededJobIds = new Set(jobs.flatMap((job) => {
    const target = retryTarget(job);
    return target && jobsById.has(target) ? [target] : [];
  }));
  const childrenByParent = new Map<string, GuiJob[]>();
  for (const job of jobs) {
    if (!job.parentJobId || !jobsById.has(job.parentJobId)) continue;
    const children = childrenByParent.get(job.parentJobId) || [];
    children.push(job);
    childrenByParent.set(job.parentJobId, children);
  }

  const roots = jobs.filter((job) => {
    if (supersededJobIds.has(job.id)) return false;
    if (!job.parentJobId || !jobsById.has(job.parentJobId)) return true;
    const parent = jobsById.get(job.parentJobId);
    return Boolean(job.deletedAt && parent && !parent.deletedAt);
  });
  return roots.map((root) => {
    const stages = [...(childrenByParent.get(root.id) || [])].sort((left, right) => {
      if (left.sequenceNumber != null && right.sequenceNumber != null) {
        return left.sequenceNumber - right.sequenceNumber;
      }
      return Date.parse(left.createdAt) - Date.parse(right.createdAt);
    });
    const supersededStageIds = new Set(stages.flatMap((stage) => {
      const target = retryTarget(stage);
      return target ? [target] : [];
    }));
    const effectiveStages = stages.filter((stage) => !supersededStageIds.has(stage.id));
    return {
      root,
      stages,
      effectiveStages,
      supersededStageIds: [...supersededStageIds],
      completedStages: effectiveStages.filter((stage) => stage.status === "succeeded").length,
      activeStage:
        effectiveStages.find((stage) => ["running", "cancel_requested"].includes(stage.status)) ||
        effectiveStages.find((stage) => ["queued", "waiting_dependency"].includes(stage.status)) ||
        null,
      failedStage:
        effectiveStages.find((stage) => stage.status === "failed") ||
        effectiveStages.find((stage) => stage.status === "blocked") ||
        null,
    };
  });
}

export function workflowSearchText(workflow: JobWorkflowViewModel, t: Translate) {
  return [workflow.root, ...workflow.stages]
    .flatMap((job) => [
      job.id,
      job.type,
      t(jobTypeKey(job.type)),
      t(jobStatusKey(job.status)),
      job.stage,
      job.payload.mangaLabel,
      job.payload.mangaId,
      job.payload.translatorLabel,
      job.payload.translatorId,
      job.payload.chapterId,
      job.payload.chapterTitle,
      job.payload.chapterLabel,
      job.payload.referenceSetId,
    ])
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}
