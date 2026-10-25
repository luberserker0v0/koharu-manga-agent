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

type JobWorkflowListItemModel = {
  workflow: JobWorkflowViewModel;
  job: GuiJob;
  mode: ReturnType<typeof resolveJobTranslationMode>;
  mangaLabel: string;
  translatorLabel: string;
  chapterDisplay: string;
  hasStages: boolean;
  failedStage: JobWorkflowViewModel["failedStage"];
  isBilingualWorkflow: boolean;
  reusedWindows: number;
  publicationStatus: string | null;
  progressTotal: number;
  progressCompleted: number;
  progressPercent: number;
  progressText: string;
  retryTarget: GuiJob;
  canRetry: boolean;
  canStop: boolean;
};

function resolveMangaLabel(
  job: GuiJob,
  meta: ReturnType<typeof jobMeta>,
  t: Translate,
) {
  return typeof job.payload.mangaLabel === "string"
    ? job.payload.mangaLabel
    : meta.mangaId !== "none"
      ? meta.mangaId
      : t("jobList.value.unassignedManga");
}

function resolveTranslatorLabel(
  job: GuiJob,
  meta: ReturnType<typeof jobMeta>,
  t: Translate,
) {
  return typeof job.payload.translatorLabel === "string"
    ? job.payload.translatorLabel
    : meta.translatorId !== "none"
      ? meta.translatorId
      : t("jobList.value.unassignedTranslator");
}

function resolveChapterDisplay(meta: ReturnType<typeof jobMeta>, t: Translate) {
  const chapterLabel =
    meta.chapterTitle !== "none" ? meta.chapterTitle : meta.chapterId;
  if (chapterLabel === "none") return t("jobList.value.unassignedChapter");
  return /^\d+(?:\.\d+)?$/.test(chapterLabel.trim())
    ? t("jobList.card.chapter", { value: chapterLabel })
    : chapterLabel;
}

function resolveProgressText(
  workflow: JobWorkflowViewModel,
  job: GuiJob,
  failedStage: JobWorkflowViewModel["failedStage"],
  hasStages: boolean,
  t: Translate,
) {
  if (workflow.activeStage) {
    return t("jobList.card.runningStage", {
      value: resolveJobStageLabel(workflow.activeStage.stage, t),
    });
  }
  if (failedStage) {
    return t("jobList.card.failedStage", {
      value: t(jobTypeKey(failedStage.type)),
    });
  }
  if (job.status === "succeeded") {
    return hasStages
      ? t("jobList.card.completedStages", {
          count: workflow.effectiveStages.length,
        })
      : t("jobList.card.completed");
  }
  if (job.status === "queued" || job.status === "waiting_dependency") {
    return t("jobList.card.waiting");
  }
  return resolveJobStageLabel(job.stage, t);
}

function resolveJobWorkflowLabels(
  job: GuiJob,
  meta: ReturnType<typeof jobMeta>,
  t: Translate,
) {
  return {
    mangaLabel: resolveMangaLabel(job, meta, t),
    translatorLabel: resolveTranslatorLabel(job, meta, t),
    chapterDisplay: resolveChapterDisplay(meta, t),
  };
}

function resolveJobWorkflowProgress(
  workflow: JobWorkflowViewModel,
  job: GuiJob,
  failedStage: JobWorkflowViewModel["failedStage"],
  hasStages: boolean,
  t: Translate,
) {
  const progressTotal = Math.max(workflow.effectiveStages.length, 1);
  const progressCompleted = hasStages
    ? workflow.completedStages
    : job.status === "succeeded"
      ? 1
      : 0;
  const progressPercent = Math.round((progressCompleted / progressTotal) * 100);
  const progressText = resolveProgressText(
    workflow,
    job,
    failedStage,
    hasStages,
    t,
  );
  return { progressTotal, progressCompleted, progressPercent, progressText };
}

function resolveJobWorkflowFlags(
  job: GuiJob,
  failedStage: JobWorkflowViewModel["failedStage"],
  hasStages: boolean,
  isBilingualWorkflow: boolean,
) {
  const reusedWindows =
    typeof job.payload.reusedWindows === "number"
      ? job.payload.reusedWindows
      : 0;
  const publicationStatus =
    job.result && typeof job.result === "object"
      ? ((job.result as { publication?: { status?: string } }).publication
          ?.status ?? null)
      : null;
  const retryTarget = failedStage && !isBilingualWorkflow ? failedStage : job;
  const canRetry =
    Boolean(failedStage) ||
    ["failed", "canceled", "blocked"].includes(job.status);
  const canStop = !isTerminalJob(job) && job.status !== "cancel_requested";
  return { reusedWindows, publicationStatus, retryTarget, canRetry, canStop };
}

function resolveJobWorkflowListItemModel(
  workflow: JobWorkflowViewModel,
  t: Translate,
): JobWorkflowListItemModel {
  const job = workflow.root;
  const meta = jobMeta(job);
  const mode = resolveJobTranslationMode(job, t);
  const hasStages = workflow.stages.length > 0;
  const failedStage = workflow.failedStage;
  const isBilingualWorkflow = job.type === "reference_bilingual_enrichment";
  const labels = resolveJobWorkflowLabels(job, meta, t);
  const progress = resolveJobWorkflowProgress(
    workflow,
    job,
    failedStage,
    hasStages,
    t,
  );
  const flags = resolveJobWorkflowFlags(
    job,
    failedStage,
    hasStages,
    isBilingualWorkflow,
  );
  return { workflow, job, mode, ...labels, hasStages, failedStage, isBilingualWorkflow,
    ...progress, ...flags };
}

function WorkflowHeadingBadges({ model, t }: { model: JobWorkflowListItemModel; t: Translate }) {
  const job = model.job;
  return <>
    <span className={`pill job-status-${job.status}`}>{t(jobStatusKey(job.status))}</span>
    {job.status === "succeeded" && job.outcome && job.outcome !== "clean"
      ? <span className="pill pill-neutral">{t(jobOutcomeKey(job.outcome))}</span> : null}
    {model.failedStage ? <span className="pill job-status-failed">{t("jobList.workflow.childFailed")}</span> : null}
    {model.publicationStatus === "superseded"
      ? <span className="pill pill-neutral">{t("jobList.workflow.supersededAttempt")}</span> : null}
  </>;
}

function JobWorkflowListItemHeading({
  model,
  t,
}: {
  model: JobWorkflowListItemModel;
  t: Translate;
}) {
  return (
    <div className="workflow-row-heading">
      <strong className="job-card-title">
        {t("jobList.card.title", {
          manga: model.mangaLabel,
          chapter: model.chapterDisplay,
        })}
      </strong>
      <WorkflowHeadingBadges model={model} t={t} />
    </div>
  );
}

function JobWorkflowListItemContext({
  model,
  t,
}: {
  model: JobWorkflowListItemModel;
  t: Translate;
}) {
  const job = model.job;
  return (
    <>
      <div className="job-card-purpose">
        <strong>{t(jobTypeKey(job.type))}</strong>
        <span>{model.mode.label}</span>
      </div>
      <div className="job-card-context">
        <span>
          {t("jobList.card.translator", { value: model.translatorLabel })}
        </span>
        <span>
          {t("jobList.updatedAt", {
            value: formatSystemDateTime(job.updatedAt),
          })}
        </span>
      </div>
    </>
  );
}

function bilingualWindowContext(stage: GuiJob | null | undefined, t: Translate) {
  if (stage?.type !== "reference_bilingual_evidence_window") return null;
  const purpose = stage.payload.purpose === "style"
    ? t("jobList.workflow.purpose.style") : t("jobList.workflow.purpose.terminology");
  const chapter = typeof stage.payload.chapterTitle === "string"
    ? stage.payload.chapterTitle : t("jobList.value.unassignedChapter");
  return t("jobList.workflow.windowContext", { purpose, chapter, attempt: resolveBilingualWindowAttempt(stage) });
}

function BilingualWindowContext({ stage, t }: { stage: GuiJob | null | undefined; t: Translate }) {
  const context = bilingualWindowContext(stage, t);
  return context ? <span>{context}</span> : null;
}

function JobWorkflowListItemProgressCopy({
  model,
  t,
}: {
  model: JobWorkflowListItemModel;
  t: Translate;
}) {
  const workflow = model.workflow;
  return (
    <div className="job-progress-copy">
      <strong>{model.progressText}</strong>
      {model.hasStages ? (
        <span>
          {t("jobList.workflow.progress", {
            completed: model.progressCompleted,
            total: model.progressTotal,
          })}
        </span>
      ) : null}
      {model.isBilingualWorkflow ? (
        <span>
          {t("jobList.workflow.reusedWindows", { count: model.reusedWindows })}
        </span>
      ) : null}
      <BilingualWindowContext stage={workflow.activeStage} t={t} />
    </div>
  );
}

function JobWorkflowListItemProgressBar({
  model,
  t,
}: {
  model: JobWorkflowListItemModel;
  t: Translate;
}) {
  return (
    <div
      aria-label={t("jobList.card.progressLabel", {
        value: model.progressPercent,
      })}
      className="job-progress-track"
      role="progressbar"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={model.progressPercent}
    >
      <span style={{ width: `${model.progressPercent}%` }} />
    </div>
  );
}

function JobWorkflowListItemProgress({
  model,
  t,
}: {
  model: JobWorkflowListItemModel;
  t: Translate;
}) {
  return (
    <div className="workflow-progress-summary">
      <JobWorkflowListItemProgressCopy model={model} t={t} />
      <JobWorkflowListItemProgressBar model={model} t={t} />
    </div>
  );
}

function JobWorkflowRetryButton({
  model,
  props,
}: {
  model: JobWorkflowListItemModel;
  props: Props;
}) {
  const t = props.t;
  if (!model.canRetry) return null;
  return (
    <button
      className="primary-button"
      disabled={props.busy}
      onClick={() =>
        model.retryTarget.resumeMetadata?.resumeAvailable
          ? props.onResume(model.retryTarget.id)
          : props.onRetry(model.retryTarget.id)
      }
      type="button"
    >
      {model.retryTarget.resumeMetadata?.resumeAvailable
        ? t("jobList.action.resume")
        : t("jobList.action.retry")}
    </button>
  );
}

function JobWorkflowExpandButton({
  model,
  props,
  expanded,
  setExpanded,
}: {
  model: JobWorkflowListItemModel;
  props: Props;
  expanded: boolean;
  setExpanded: (value: boolean | ((value: boolean) => boolean)) => void;
}) {
  const t = props.t;
  if (!model.hasStages) return null;
  return (
    <button
      className="secondary-button"
      onClick={() => setExpanded((value) => !value)}
      type="button"
    >
      {expanded
        ? t("jobList.workflow.collapseStages")
        : t("jobList.workflow.expandStages", {
            count: props.workflow.stages.length,
          })}
    </button>
  );
}

function JobWorkflowMainActions({
  model,
  props,
  expanded,
  setExpanded,
}: {
  model: JobWorkflowListItemModel;
  props: Props;
  expanded: boolean;
  setExpanded: (value: boolean | ((value: boolean) => boolean)) => void;
}) {
  return (
    <>
      <JobWorkflowRetryButton model={model} props={props} />
      <JobWorkflowExpandButton
        model={model}
        props={props}
        expanded={expanded}
        setExpanded={setExpanded}
      />
    </>
  );
}

function JobWorkflowNonDeletedActions({ model, props }: { model: JobWorkflowListItemModel; props: Props }) {
  const t = props.t;
  const job = model.job;
  return (
    <>
      {model.canStop ? <button className="secondary-button" disabled={props.busy}
        onClick={() => props.onCancel(job.id)} type="button">{t("jobList.action.stop")}</button> : null}
      <button className="secondary-button" disabled={props.busy}
        onClick={() => props.onDelete(job)} type="button">{t("jobList.action.delete")}</button>
    </>
  );
}

function JobWorkflowDeletedActions({
  model,
  props,
}: {
  model: JobWorkflowListItemModel;
  props: Props;
}) {
  const t = props.t;
  const job = model.job;
  return (
    <>
      <button
        className="secondary-button"
        disabled={props.busy}
        onClick={() => props.onRestore(job.id)}
        type="button"
      >
        {t("jobList.action.restore")}
      </button>
      <button
        className="secondary-button danger-button"
        disabled={props.busy || !isTerminalJob(job)}
        onClick={() => props.onPurge(job)}
        type="button"
      >
        {t("jobList.action.purge")}
      </button>
    </>
  );
}

function JobWorkflowDangerActions({
  model,
  props,
}: {
  model: JobWorkflowListItemModel;
  props: Props;
}) {
  const job = model.job;
  if (!job.deletedAt)
    return <JobWorkflowNonDeletedActions model={model} props={props} />;
  return <JobWorkflowDeletedActions model={model} props={props} />;
}

function JobWorkflowStageDetails({ stage, workflow, t }: {
  stage: JobWorkflowViewModel["stages"][number]; workflow: JobWorkflowViewModel; t: Translate;
}) {
  const context = bilingualWindowContext(stage, t);
  return <span><strong>{t(jobTypeKey(stage.type))}</strong>
    <small>{stage.stage === "reused" ? t("jobList.workflow.reused") : resolveJobStageLabel(stage.stage, t)}</small>
    {workflow.supersededStageIds.includes(stage.id)
      ? <small>{t("jobList.workflow.supersededAttempt")}</small> : null}
    {context ? <small>{context}</small> : null}
  </span>;
}

function JobWorkflowStageItem({ stage, index, workflow, props, t }: {
  stage: JobWorkflowViewModel["stages"][number]; index: number;
  workflow: JobWorkflowViewModel; props: Props; t: Translate;
}) {
  return (
    <li key={stage.id}>
      <button
        className="workflow-stage-button"
        onClick={() => props.onSelect(stage)}
        type="button"
      >
        <span className={`workflow-stage-marker job-status-${stage.status}`}>
          {index + 1}
        </span>
        <JobWorkflowStageDetails stage={stage} workflow={workflow} t={t} />
        <span className="workflow-stage-status">
          {t(jobStatusKey(stage.status))}
        </span>
      </button>
    </li>
  );
}

function JobWorkflowListItemStages({
  model,
  props,
  t,
}: {
  model: JobWorkflowListItemModel;
  props: Props;
  t: Translate;
}) {
  const workflow = model.workflow;
  if (!model.hasStages) return null;
  return (
    <ol className="workflow-stage-list">
      {workflow.stages.map((stage, index) => (
        <JobWorkflowStageItem
          key={stage.id}
          stage={stage}
          index={index}
          workflow={workflow}
          props={props}
          t={t}
        />
      ))}
    </ol>
  );
}

function JobWorkflowFailureCopy({ job, t }: { job: GuiJob; t: Translate }) {
  if (job.blockedReason) {
    return <div className="job-subtext job-error">{t("jobList.blockedReason", { value: job.blockedReason })}</div>;
  }
  if (job.status !== "failed" || !job.diagnostics?.resourceFailureType) return null;
  return <div className="job-subtext job-error">{t("jobList.failureSummary", {
    source: t(`jobDetail.failure.source.${job.diagnostics.failureSource || "unknown"}`),
    stage: resolveJobStageLabel(job.diagnostics.failureStage || job.stage, t),
    type: t(`jobList.resourceFailure.${job.diagnostics.resourceFailureType}`),
  })}</div>;
}

function JobWorkflowListItemMainButton({
  model,
  props,
}: {
  model: JobWorkflowListItemModel;
  props: Props;
}) {
  const t = props.t;
  const job = model.job;
  return (
    <button
      className="job-link"
      onClick={() => props.onSelect(job)}
      type="button"
    >
      <JobWorkflowListItemHeading model={model} t={t} />
      <JobWorkflowListItemContext model={model} t={t} />
      <JobWorkflowListItemProgress model={model} t={t} />
      <JobWorkflowFailureCopy job={job} t={t} />
    </button>
  );
}

function JobWorkflowCheckbox({ job, props }: { job: GuiJob; props: Props }) {
  if (props.collapsed) return null;
  return <label className="job-checkbox"><input checked={props.checked} disabled={props.busy}
    onChange={() => props.onToggleChecked(job.id)} type="checkbox" /></label>;
}

function JobWorkflowActions({ model, props, expanded, setExpanded }: {
  model: JobWorkflowListItemModel; props: Props; expanded: boolean;
  setExpanded: (value: boolean | ((value: boolean) => boolean)) => void;
}) {
  return <div className="job-actions"><JobWorkflowMainActions model={model} props={props}
    expanded={expanded} setExpanded={setExpanded} />
    <JobWorkflowDangerActions model={model} props={props} />
  </div>;
}

function JobWorkflowListItemContent({
  model,
  props,
  expanded,
  setExpanded,
}: {
  model: JobWorkflowListItemModel;
  props: Props;
  expanded: boolean;
  setExpanded: (value: boolean | ((value: boolean) => boolean)) => void;
}) {
  const job = model.job;
  return (
    <li
      className={`job-list-item workflow-list-item${props.selected ? " is-selected" : ""}`}
    >
      <div className={props.collapsed ? "job-row compact" : "job-row"}>
        <JobWorkflowCheckbox job={job} props={props} />
        <JobWorkflowListItemMainButton model={model} props={props} />
        <JobWorkflowActions model={model} props={props} expanded={expanded} setExpanded={setExpanded} />
      </div>
      {expanded && model.hasStages ? (
        <JobWorkflowListItemStages model={model} props={props} t={props.t} />
      ) : null}
    </li>
  );
}

function JobWorkflowListItemView(props: Props) {
  const [expanded, setExpanded] = useState(false);
  const model = resolveJobWorkflowListItemModel(props.workflow, props.t);
  useEffect(() => {
    if (model.failedStage) setExpanded(true);
  }, [model.failedStage?.id]);
  return (
    <JobWorkflowListItemContent
      model={model}
      props={props}
      expanded={expanded}
      setExpanded={setExpanded}
    />
  );
}

export function JobWorkflowListItem(props: Props) {
  return <JobWorkflowListItemView {...props} />;
}
