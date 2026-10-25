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

const STAGE_KEYS: Record<string, string> = {
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

function dynamicStageLabel(stage: string, t: Translate): string | null {
  const observation = stage.match(/^quality_observation_(\d+)_of_(\d+)(?:_(?:split|degraded))?$/);
  if (observation) return t("jobList.stage.qualityObservation", { current: observation[1], total: observation[2] });
  const purpose = stage.match(
    /^standard_quality_(completeness|sequence|terminology|style|story|representative|review)_(\d+)_of_(\d+)$/,
  );
  if (purpose)
    return t("jobList.stage.standardQualityPurpose", {
      purpose: t(`jobList.qualityPurpose.${purpose[1]}`),
      current: purpose[2],
      total: purpose[3],
    });
  const quality = stage.match(/^standard_quality_(\d+)_of_(\d+)$/);
  if (quality) return t("jobList.stage.standardQuality", { current: quality[1], total: quality[2] });
  const audit = stage.match(/^deep_audit_(\d+)_of_(\d+)$/);
  return audit ? t("jobList.stage.deepAudit", { current: audit[1], total: audit[2] }) : null;
}

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
  return dynamicStageLabel(stage, t) || (STAGE_KEYS[stage] ? t(STAGE_KEYS[stage]) : stage);
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

function translationModeView(t: Translate, key: string) {
  return { label: t(`jobList.mode.${key}.label`), description: t(`jobList.mode.${key}.description`) };
}

export function resolveJobTranslationMode(job: GuiJob, t: Translate) {
  if (job.type === "reference_extraction" || job.type === "reference_observation") {
    return translationModeView(t, "referenceExtraction");
  }
  const ingestionTypes = [
    "reference_ingestion",
    "reference_bilingual_enrichment",
    "reference_bilingual_evidence_window",
    "reference_bilingual_commit",
  ];
  if (ingestionTypes.includes(job.type)) {
    return translationModeView(t, job.payload.referenceKind === "source" ? "sourceIngestion" : "translatorIngestion");
  }
  const translationMode = typeof job.payload.translationMode === "string" ? job.payload.translationMode : null;
  if (["quick", "reference_style", "local_style", "learning_style"].includes(translationMode || "")) {
    return {
      label: t(`jobList.mode.${translationMode}`),
      description: t(`jobList.mode.${translationMode}.description`),
    };
  }
  return translationModeView(t, "translation");
}

function retryTarget(job: GuiJob) {
  const payloadRetryOf = typeof job.payload.retryOf === "string" ? job.payload.retryOf : null;
  return job.retryOf || payloadRetryOf;
}

function childrenByParent(jobs: GuiJob[], jobsById: Map<string, GuiJob>) {
  const children = new Map<string, GuiJob[]>();
  for (const job of jobs) {
    if (!job.parentJobId || !jobsById.has(job.parentJobId)) continue;
    children.set(job.parentJobId, [...(children.get(job.parentJobId) || []), job]);
  }
  return children;
}

function sortedStages(stages: GuiJob[]) {
  return [...stages].sort((left, right) => {
    if (left.sequenceNumber != null && right.sequenceNumber != null) return left.sequenceNumber - right.sequenceNumber;
    return Date.parse(left.createdAt) - Date.parse(right.createdAt);
  });
}

function workflowView(root: GuiJob, children: Map<string, GuiJob[]>): JobWorkflowViewModel {
  const stages = sortedStages(children.get(root.id) || []);
  const supersededStageIds = new Set(
    stages.flatMap((stage) => (retryTarget(stage) ? [retryTarget(stage) as string] : [])),
  );
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
}

export function buildJobWorkflows(jobs: GuiJob[]): JobWorkflowViewModel[] {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const supersededJobIds = new Set(
    jobs.flatMap((job) => {
      const target = retryTarget(job);
      return target && jobsById.has(target) ? [target] : [];
    }),
  );
  const children = childrenByParent(jobs, jobsById);
  const roots = jobs.filter((job) => {
    if (supersededJobIds.has(job.id)) return false;
    if (!job.parentJobId || !jobsById.has(job.parentJobId)) return true;
    const parent = jobsById.get(job.parentJobId);
    return Boolean(job.deletedAt && parent && !parent.deletedAt);
  });
  return roots.map((root) => workflowView(root, children));
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
