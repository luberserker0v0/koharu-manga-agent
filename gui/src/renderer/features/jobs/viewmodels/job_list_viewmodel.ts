import type { GuiJob } from "../../../api/jobs";

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

export function jobTypeKey(type: string) {
  switch (type) {
    case "reference_extraction": return "jobList.type.referenceExtraction";
    case "reference_observation": return "jobList.type.referenceObservation";
    case "reference_deep_review": return "jobList.type.referenceDeepReview";
    case "reference_ingestion": return "jobList.type.referenceIngestion";
    case "reference_story_update": return "jobList.type.referenceStoryUpdate";
    case "reference_knowledge_commit": return "jobList.type.referenceKnowledgeCommit";
    case "reference_style_commit": return "jobList.type.referenceStyleCommit";
    case "reference_bilingual_enrichment": return "jobList.type.referenceBilingualEnrichment";
    case "reference_bilingual_evidence_window": return "jobList.type.referenceBilingualEvidenceWindow";
    case "reference_bilingual_commit": return "jobList.type.referenceBilingualCommit";
    case "translation": return "jobList.type.translation";
    case "translation_knowledge_commit": return "jobList.type.translationKnowledgeCommit";
    case "translation_deep_audit": return "jobList.type.translationDeepAudit";
    case "translation_quality_finalize": return "jobList.type.translationQualityFinalize";
    case "translation_quality_repair": return "jobList.type.translationQualityRepair";
    case "post_edit_export": return "jobList.type.postEditExport";
    default: return "jobList.type.unknown";
  }
}

export function jobStatusKey(status: string) {
  switch (status) {
    case "queued": return "jobList.status.queued";
    case "waiting_dependency": return "jobList.status.waitingDependency";
    case "waiting_user_review": return "jobList.status.waitingUserReview";
    case "running": return "jobList.status.running";
    case "cancel_requested": return "jobList.status.cancelRequested";
    case "succeeded": return "jobList.status.succeeded";
    case "failed": return "jobList.status.failed";
    case "canceled": return "jobList.status.canceled";
    case "blocked": return "jobList.status.blocked";
    default: return "jobList.status.unknown";
  }
}

export function resolveJobStageLabel(stage: string, t: Translate) {
  const qualityObservation = stage.match(/^quality_observation_(\d+)_of_(\d+)$/);
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
    translation_chapter_observation: "jobList.stage.translationObservation",
    quality_context: "jobList.stage.qualityContext",
    quality_apply: "jobList.stage.qualityApply",
    quality_verification: "jobList.stage.qualityVerification",
    lightweight_knowledge_learning: "jobList.stage.lightweightKnowledge",
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
  return ["succeeded", "failed", "canceled", "blocked", "waiting_user_review"].includes(job.status);
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
