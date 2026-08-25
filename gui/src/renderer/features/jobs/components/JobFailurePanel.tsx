import type { GuiJob } from "../../../api/jobs";
import { resolveJobStageLabel, type Translate } from "../viewmodels/job_list_viewmodel";

type Props = {
  job: GuiJob;
  t: Translate;
};

export function JobFailurePanel({ job, t }: Props) {
  const diagnostics = job.diagnostics;
  const source = diagnostics?.failureSource || "unknown";
  const failureType = diagnostics?.resourceFailureType || "unknown";
  const stage = diagnostics?.failureStage || job.stage;
  const action = diagnostics?.recommendedAction || "inspect_raw_error";

  return (
    <div className="job-failure-panel">
      <p className="error-text">{t("jobDetail.failure.summary", {
        source: t(`jobDetail.failure.source.${source}`),
        type: t(`jobList.resourceFailure.${failureType}`),
      })}</p>
      <div className="summary-grid">
        <div>
          <strong>{t("jobDetail.failure.source")}</strong>
          <span>{t(`jobDetail.failure.source.${source}`)}</span>
        </div>
        <div>
          <strong>{t("jobDetail.failure.stage")}</strong>
          <span>{resolveJobStageLabel(stage, t)}</span>
        </div>
        <div>
          <strong>{t("jobDetail.failure.type")}</strong>
          <span>{t(`jobList.resourceFailure.${failureType}`)}</span>
        </div>
        {diagnostics?.failureCode ? (
          <div>
            <strong>{t("jobDetail.failure.code")}</strong>
            <span>{diagnostics.failureCode}</span>
          </div>
        ) : null}
      </div>
      <p>{t(`jobDetail.failure.action.${action}`)}</p>
      <details>
        <summary>{t("jobDetail.failure.technicalDetails")}</summary>
        <pre>{job.error}</pre>
      </details>
    </div>
  );
}
