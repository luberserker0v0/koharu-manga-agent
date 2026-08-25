import { useEffect, useState } from "react";
import type { GuiJob } from "../../../api/jobs";
import {
  isTerminalJob,
  jobMeta,
  jobOutcomeKey,
  jobStatusKey,
  jobTypeKey,
  resolveBilingualWindowAttempt,
  resolveJobTranslationMode,
  resolveJobStageLabel,
  type JobWorkflowViewModel,
  type Translate,
} from "../viewmodels/job_list_viewmodel";
import { formatSystemDateTime } from "../../shared/formatters/date_time";

type Props = {
  workflow: JobWorkflowViewModel;
  selected: boolean;
  checked: boolean;
  collapsed: boolean;
  busy: boolean;
  t: Translate;
  onToggleChecked: (jobId: string) => void;
  onSelect: (job: GuiJob) => void;
  onRetry: (jobId: string) => void;
  onResume: (jobId: string) => void;
  onCancel: (jobId: string) => void;
  onDelete: (job: GuiJob) => void;
  onRestore: (jobId: string) => void;
  onPurge: (job: GuiJob) => void;
};

export function JobWorkflowListItem({
  workflow,
  selected,
  checked,
  collapsed,
  busy,
  t,
  onToggleChecked,
  onSelect,
  onRetry,
  onResume,
  onCancel,
  onDelete,
  onRestore,
  onPurge,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const job = workflow.root;
  const meta = jobMeta(job);
  const mode = resolveJobTranslationMode(job, t);
  const hasStages = workflow.stages.length > 0;
  const failedStage = workflow.failedStage;
  const mangaLabel =
    typeof job.payload.mangaLabel === "string"
      ? job.payload.mangaLabel
      : meta.mangaId !== "none"
        ? meta.mangaId
        : t("jobList.value.unassignedManga");
  const translatorLabel =
    typeof job.payload.translatorLabel === "string"
      ? job.payload.translatorLabel
      : meta.translatorId !== "none"
        ? meta.translatorId
        : t("jobList.value.unassignedTranslator");
  const chapterLabel = meta.chapterTitle !== "none" ? meta.chapterTitle : meta.chapterId;
  const isBilingualWorkflow = job.type === "reference_bilingual_enrichment";
  const reusedWindows = typeof job.payload.reusedWindows === "number" ? job.payload.reusedWindows : 0;
  const publicationStatus = job.result && typeof job.result === "object"
    ? (job.result as { publication?: { status?: string } }).publication?.status
    : null;
  const chapterDisplay = chapterLabel !== "none"
    ? /^\d+(?:\.\d+)?$/.test(chapterLabel.trim())
      ? t("jobList.card.chapter", { value: chapterLabel })
      : chapterLabel
    : t("jobList.value.unassignedChapter");
  const progressTotal = Math.max(workflow.effectiveStages.length, 1);
  const progressCompleted = hasStages
    ? workflow.completedStages
    : job.status === "succeeded" ? 1 : 0;
  const progressPercent = Math.round((progressCompleted / progressTotal) * 100);
  const retryTarget = failedStage && !isBilingualWorkflow ? failedStage : job;
  const canRetry = Boolean(failedStage) || ["failed", "canceled", "blocked"].includes(job.status);
  const canStop = !isTerminalJob(job) && job.status !== "cancel_requested";
  const progressText = workflow.activeStage
    ? t("jobList.card.runningStage", { value: resolveJobStageLabel(workflow.activeStage.stage, t) })
    : failedStage
      ? t("jobList.card.failedStage", { value: t(jobTypeKey(failedStage.type)) })
      : job.status === "succeeded"
        ? hasStages
          ? t("jobList.card.completedStages", { count: workflow.effectiveStages.length })
          : t("jobList.card.completed")
        : job.status === "queued" || job.status === "waiting_dependency"
          ? t("jobList.card.waiting")
          : resolveJobStageLabel(job.stage, t);

  useEffect(() => {
    if (failedStage) setExpanded(true);
  }, [failedStage?.id]);

  return (
    <li className={`job-list-item workflow-list-item${selected ? " is-selected" : ""}`}>
      <div className={collapsed ? "job-row compact" : "job-row"}>
        {!collapsed ? (
          <label className="job-checkbox">
            <input
              checked={checked}
              disabled={busy}
              onChange={() => onToggleChecked(job.id)}
              type="checkbox"
            />
          </label>
        ) : null}
        <button className="job-link" onClick={() => onSelect(job)} type="button">
          <div className="workflow-row-heading">
            <strong className="job-card-title">{t("jobList.card.title", { manga: mangaLabel, chapter: chapterDisplay })}</strong>
            <span className={`pill job-status-${job.status}`}>{t(jobStatusKey(job.status))}</span>
            {job.status === "succeeded" && job.outcome && job.outcome !== "clean" ? (
              <span className="pill pill-neutral">{t(jobOutcomeKey(job.outcome))}</span>
            ) : null}
            {failedStage ? (
              <span className="pill job-status-failed">{t("jobList.workflow.childFailed")}</span>
            ) : null}
            {publicationStatus === "superseded" ? (
              <span className="pill pill-neutral">{t("jobList.workflow.supersededAttempt")}</span>
            ) : null}
          </div>
          <div className="job-card-purpose">
            <strong>{t(jobTypeKey(job.type))}</strong>
            <span>{mode.label}</span>
          </div>
          <div className="job-card-context">
            <span>{t("jobList.card.translator", { value: translatorLabel })}</span>
            <span>{t("jobList.updatedAt", { value: formatSystemDateTime(job.updatedAt) })}</span>
          </div>
          <div className="workflow-progress-summary">
            <div className="job-progress-copy">
              <strong>{progressText}</strong>
              {hasStages ? (
                <span>{t("jobList.workflow.progress", { completed: progressCompleted, total: progressTotal })}</span>
              ) : null}
              {isBilingualWorkflow ? (
                <span>{t("jobList.workflow.reusedWindows", { count: reusedWindows })}</span>
              ) : null}
              {workflow.activeStage?.type === "reference_bilingual_evidence_window" ? (
                <span>
                  {t("jobList.workflow.windowContext", {
                    purpose: workflow.activeStage.payload.purpose === "style"
                      ? t("jobList.workflow.purpose.style")
                      : t("jobList.workflow.purpose.terminology"),
                    chapter: typeof workflow.activeStage.payload.chapterTitle === "string"
                      ? workflow.activeStage.payload.chapterTitle
                      : t("jobList.value.unassignedChapter"),
                    attempt: resolveBilingualWindowAttempt(workflow.activeStage),
                  })}
                </span>
              ) : null}
            </div>
            <div
              aria-label={t("jobList.card.progressLabel", { value: progressPercent })}
              className="job-progress-track"
              role="progressbar"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={progressPercent}
            >
              <span style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
          {job.blockedReason ? (
            <div className="job-subtext job-error">{t("jobList.blockedReason", { value: job.blockedReason })}</div>
          ) : null}
          {job.status === "failed" && job.diagnostics?.resourceFailureType ? (
            <div className="job-subtext job-error">
              {t("jobList.failureSummary", {
                source: t(`jobDetail.failure.source.${job.diagnostics.failureSource || "unknown"}`),
                stage: resolveJobStageLabel(job.diagnostics.failureStage || job.stage, t),
                type: t(`jobList.resourceFailure.${job.diagnostics.resourceFailureType}`),
              })}
            </div>
          ) : null}
        </button>
        <div className="job-actions">
          {canRetry ? (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => retryTarget.resumeMetadata?.resumeAvailable
                ? onResume(retryTarget.id)
                : onRetry(retryTarget.id)}
              type="button"
            >
              {retryTarget.resumeMetadata?.resumeAvailable
                ? t("jobList.action.resume")
                : t("jobList.action.retry")}
            </button>
          ) : null}
          {hasStages ? (
            <button className="secondary-button" onClick={() => setExpanded((value) => !value)} type="button">
              {expanded ? t("jobList.workflow.collapseStages") : t("jobList.workflow.expandStages", { count: workflow.stages.length })}
            </button>
          ) : null}
          {!job.deletedAt ? (
            <>
              {canStop ? <button
                className="secondary-button"
                disabled={busy}
                onClick={() => onCancel(job.id)}
                type="button"
              >
                {t("jobList.action.stop")}
              </button> : null}
              <button className="secondary-button" disabled={busy} onClick={() => onDelete(job)} type="button">
                {t("jobList.action.delete")}
              </button>
            </>
          ) : (
            <>
              <button className="secondary-button" disabled={busy} onClick={() => onRestore(job.id)} type="button">
                {t("jobList.action.restore")}
              </button>
              <button
                className="secondary-button danger-button"
                disabled={busy || !isTerminalJob(job)}
                onClick={() => onPurge(job)}
                type="button"
              >
                {t("jobList.action.purge")}
              </button>
            </>
          )}
        </div>
      </div>
      {expanded && hasStages ? (
        <ol className="workflow-stage-list">
          {workflow.stages.map((stage, index) => (
            <li key={stage.id}>
              <button className="workflow-stage-button" onClick={() => onSelect(stage)} type="button">
                <span className={`workflow-stage-marker job-status-${stage.status}`}>{index + 1}</span>
                <span>
                  <strong>{t(jobTypeKey(stage.type))}</strong>
                  <small>{stage.stage === "reused" ? t("jobList.workflow.reused") : resolveJobStageLabel(stage.stage, t)}</small>
                  {workflow.supersededStageIds.includes(stage.id) ? (
                    <small>{t("jobList.workflow.supersededAttempt")}</small>
                  ) : null}
                  {stage.type === "reference_bilingual_evidence_window" ? (
                    <small>
                      {t("jobList.workflow.windowContext", {
                        purpose: stage.payload.purpose === "style"
                          ? t("jobList.workflow.purpose.style")
                          : t("jobList.workflow.purpose.terminology"),
                        chapter: typeof stage.payload.chapterTitle === "string"
                          ? stage.payload.chapterTitle
                          : t("jobList.value.unassignedChapter"),
                        attempt: resolveBilingualWindowAttempt(stage),
                      })}
                    </small>
                  ) : null}
                </span>
                <span className="workflow-stage-status">{t(jobStatusKey(stage.status))}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}
