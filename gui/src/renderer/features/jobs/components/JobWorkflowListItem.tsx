import { useEffect, useState } from "react";
import type { GuiJob } from "../../../api/jobs";
import {
  isTerminalJob,
  jobMeta,
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
  checked: boolean;
  collapsed: boolean;
  busy: boolean;
  t: Translate;
  onToggleChecked: (jobId: string) => void;
  onSelect: (job: GuiJob) => void;
  onRetry: (jobId: string) => void;
  onCancel: (jobId: string) => void;
  onDelete: (job: GuiJob) => void;
  onRestore: (jobId: string) => void;
  onPurge: (job: GuiJob) => void;
};

export function JobWorkflowListItem({
  workflow,
  checked,
  collapsed,
  busy,
  t,
  onToggleChecked,
  onSelect,
  onRetry,
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

  useEffect(() => {
    if (failedStage) setExpanded(true);
  }, [failedStage?.id]);

  return (
    <li className="job-list-item workflow-list-item">
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
            <strong>{t(jobTypeKey(job.type))}</strong>
            <span className={`pill job-status-${job.status}`}>{t(jobStatusKey(job.status))}</span>
            {failedStage ? (
              <span className="pill job-status-failed">{t("jobList.workflow.childFailed")}</span>
            ) : null}
            {publicationStatus === "superseded" ? (
              <span className="pill pill-neutral">{t("jobList.workflow.supersededAttempt")}</span>
            ) : null}
          </div>
          <div className="job-subtext"><span className="pill pill-neutral">{mode.label}</span></div>
          <div className="job-subtext workflow-context-line">
            <span>{mangaLabel}</span>
            <span>{translatorLabel}</span>
            <span>{chapterLabel !== "none" ? chapterLabel : t("jobList.value.unassignedChapter")}</span>
          </div>
          {hasStages ? (
            <div className="workflow-progress-summary">
              <span>{t("jobList.workflow.progress", { completed: workflow.completedStages, total: workflow.effectiveStages.length })}</span>
              <span>
                {workflow.activeStage
                  ? t("jobList.workflow.currentStage", { value: t(jobTypeKey(workflow.activeStage.type)) })
                  : t("jobList.workflow.noActiveStage")}
              </span>
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
              {failedStage ? (
                <span className="job-error">
                  {t("jobList.workflow.failedStage", { value: t(jobTypeKey(failedStage.type)) })}
                </span>
              ) : null}
            </div>
          ) : (
            <div className="job-subtext">
              <span>{mode.description}</span>
              <span>{resolveJobStageLabel(job.stage, t)}</span>
            </div>
          )}
          <div className="job-subtext">{t("jobList.updatedAt", { value: formatSystemDateTime(job.updatedAt) })}</div>
          {job.blockedReason ? (
            <div className="job-subtext job-error">{t("jobList.blockedReason", { value: job.blockedReason })}</div>
          ) : null}
        </button>
        <div className="job-actions">
          {failedStage && !isBilingualWorkflow ? (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => onRetry(failedStage.id)}
              type="button"
            >
              {t("jobList.workflow.retryFailedStage", { value: t(jobTypeKey(failedStage.type)) })}
            </button>
          ) : null}
          {hasStages ? (
            <button className="secondary-button" onClick={() => setExpanded((value) => !value)} type="button">
              {expanded ? t("jobList.workflow.collapseStages") : t("jobList.workflow.expandStages", { count: workflow.stages.length })}
            </button>
          ) : null}
          <button
            className="secondary-button"
            disabled={busy || Boolean(job.deletedAt) || !["failed", "canceled", "blocked"].includes(job.status)}
            onClick={() => onRetry(job.id)}
            type="button"
          >
            {isBilingualWorkflow
              ? t("jobList.workflow.resumeUnfinishedWindows")
              : t("jobList.action.retry")}
          </button>
          {!job.deletedAt ? (
            <>
              <button
                className="secondary-button"
                disabled={busy || isTerminalJob(job) || job.status === "cancel_requested"}
                onClick={() => onCancel(job.id)}
                type="button"
              >
                {t("jobList.action.stop")}
              </button>
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
              {!isBilingualWorkflow && ["failed", "canceled", "blocked"].includes(stage.status) && !workflow.supersededStageIds.includes(stage.id) ? (
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => onRetry(stage.id)}
                  type="button"
                >
                  {t("jobList.action.retry")}
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}
