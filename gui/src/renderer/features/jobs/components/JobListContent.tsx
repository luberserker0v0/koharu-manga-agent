import type { Dispatch, SetStateAction } from "react";
import { JobDetailContent } from "../../../pages/JobDetailPage";
import { isTerminalJob } from "../viewmodels/job_list_viewmodel";
import { JobWorkflowListItem } from "./JobWorkflowListItem";
import { type ConnectionState, type JobFilter, type JobListModel, type JobSort, type Translate,
  useJobListModel } from "../hooks/useJobListModel";

function connectionLabel(state: ConnectionState, t: Translate) {
  return t(`jobList.connection.${state}`);
}

function connectionTone(state: ConnectionState) {
  return state === "live" ? "good" : ["connecting", "reconnecting"].includes(state) ? "warn" : "neutral";
}

function CenterNotice({ model }: { model: JobListModel }) {
  const notice = model.centerNotice;
  if (!notice) return null;
  return <div className="center-notice-layer"><div className={`center-notice center-notice-${notice.tone}`}>
    <div>{notice.message}</div>
    {notice.onAction && notice.actionLabel ? <button className="secondary-button center-notice-action"
      onClick={notice.onAction} type="button">{notice.actionLabel}</button> : null}
  </div></div>;
}

function SelectedJobsButton({ model }: { model: JobListModel }) {
  const trash = model.filter === "trash";
  const empty = model.checkedIds.length === 0;
  const hint = empty ? (trash ? "jobList.hint.selectRestore" : "jobList.hint.selectDelete")
    : trash ? "jobList.hint.restoreSelected" : "jobList.hint.deleteSelected";
  return <button className="secondary-button" disabled={model.busy || empty}
    onClick={trash ? model.confirmRestoreBatch : model.confirmBatchDelete} title={model.t(hint)} type="button">
    {model.t(trash ? "jobList.action.restoreSelected" : "jobList.action.deleteSelected")}
  </button>;
}

function PurgeSelectedButton({ model }: { model: JobListModel }) {
  if (model.filter !== "trash") return null;
  const empty = model.checkedIds.length === 0;
  const waiting = model.checkedJobs.some((job) => !isTerminalJob(job));
  const hint = empty ? "jobList.hint.selectPurge" : waiting ? "jobList.hint.waitForStop" : "jobList.hint.purgeSelected";
  return <button className="secondary-button danger-button" disabled={model.busy || empty || waiting}
    onClick={model.confirmPurgeBatch} title={model.t(hint)} type="button">{model.t("jobList.action.purge")}</button>;
}

function JobListToolbar({ model }: { model: JobListModel }) {
  return <div className="job-list-toolbar">
    <button className="secondary-button" onClick={() => model.setJobListCollapsed((value) => !value)} type="button">
      {model.t(model.jobListCollapsed ? "jobList.action.expandList" : "jobList.action.collapseList")}
    </button>
    {!model.jobListCollapsed ? <button className="secondary-button" onClick={() => void model.refresh()} type="button">
      {model.t("jobList.action.refresh")}</button> : null}
    {!model.jobListCollapsed ? <><SelectedJobsButton model={model} /><PurgeSelectedButton model={model} /></> : null}
  </div>;
}

function JobListHeader({ model }: { model: JobListModel }) {
  return <div className="job-list-header"><div><h2>{model.t("jobList.current.title")}</h2>
    {!model.jobListCollapsed ? <div className="job-list-live-row">
      <p className="muted-text">{model.t("jobList.current.description")}</p>
      <span className={`live-connection-badge live-connection-badge-${connectionTone(model.listConnectionState)}`}>
        {connectionLabel(model.listConnectionState, model.t)}</span>
    </div> : null}
  </div><JobListToolbar model={model} /></div>;
}

const FILTERS: JobFilter[] = ["all", "active", "completed", "failed", "trash"];

function FilterRow({ model }: { model: JobListModel }) {
  if (model.jobListCollapsed) return null;
  return <div className="filter-row">{FILTERS.map((filter) => <button key={filter}
    className={model.filter === filter ? "secondary-button active-filter" : "secondary-button"}
    onClick={() => model.setFilter(filter)} type="button">{model.t(`jobList.filter.${filter}`)}</button>)}</div>;
}

function SortControl({ value, setValue, t }: {
  value: JobSort; setValue: Dispatch<SetStateAction<JobSort>>; t: Translate;
}) {
  return <label className="standalone-field"><span>{t("jobList.sort.label")}</span>
    <select value={value} onChange={(event) => setValue(event.currentTarget.value as JobSort)}>
      <option value="updated_desc">{t("jobList.sort.updatedDesc")}</option>
      <option value="created_desc">{t("jobList.sort.createdDesc")}</option>
      <option value="created_asc">{t("jobList.sort.createdAsc")}</option>
      <option value="status_priority">{t("jobList.sort.status")}</option>
      <option value="title_asc">{t("jobList.sort.title")}</option>
    </select>
  </label>;
}

function ListControls({ model }: { model: JobListModel }) {
  if (model.jobListCollapsed) return null;
  return <div className="list-controls-grid">
    <label className="standalone-field"><span>{model.t("jobList.search.label")}</span>
      <input onChange={(event) => model.setSearchQuery(event.currentTarget.value)}
        placeholder={model.t("jobList.search.placeholder")} value={model.searchQuery} />
    </label>
    <SortControl value={model.sortMode} setValue={model.setSortMode} t={model.t} />
  </div>;
}

function SelectAllRow({ model }: { model: JobListModel }) {
  if (model.jobListCollapsed) return null;
  const key = model.filter === "trash" ? "jobList.selectAll.trash" : "jobList.selectAll.visible";
  return <label className="checkbox-row select-all-row"><input checked={model.allChecked}
    disabled={model.visibleJobs.length === 0 || model.busy} onChange={model.toggleAll}
    ref={model.selectAllCheckboxRef} type="checkbox" />
    <span>{model.t(key, { count: model.visibleJobs.length })}</span>
  </label>;
}

function EmptyJobList({ model }: { model: JobListModel }) {
  if (model.sortedWorkflows.length) return null;
  const message = model.searchQuery.trim()
    ? model.t("jobList.empty.search", { value: model.searchQuery.trim() }) : model.t("jobList.empty.filtered");
  return <li className="job-list-item empty-state-item"><div className="job-subtext">{message}</div></li>;
}

function WorkflowItems({ model }: { model: JobListModel }) {
  return <>{model.sortedWorkflows.map((workflow) => <JobWorkflowListItem key={workflow.root.id}
    busy={model.busy} checked={model.checkedJobIds.includes(workflow.root.id)} collapsed={model.jobListCollapsed}
    selected={model.selectedJobId === workflow.root.id || workflow.stages.some((stage) => stage.id === model.selectedJobId)}
    onCancel={(id) => void model.cancel(id)} onDelete={model.confirmDeleteJob} onPurge={model.confirmPurgeJob}
    onRestore={(id) => void model.restoreOne(id)} onResume={(id) => void model.resume(id)}
    onRetry={(id) => void model.retry(id)} onSelect={model.selectJob} onToggleChecked={model.toggleChecked}
    t={model.t} workflow={workflow} />)}</>;
}

function JobListItems({ model }: { model: JobListModel }) {
  if (model.query.isLoading) return <p>{model.t("jobList.loading")}</p>;
  if (model.query.isError) return <p>{model.t("jobList.loadFailed")}</p>;
  if (!model.query.data) return null;
  return <ul className="job-list"><EmptyJobList model={model} /><WorkflowItems model={model} /></ul>;
}

function JobListPane({ model }: { model: JobListModel }) {
  const className = model.jobListCollapsed ? "card job-list-pane fully-collapsed" : "card job-list-pane";
  return <article className={className}><JobListHeader model={model} /><FilterRow model={model} />
    <ListControls model={model} /><SelectAllRow model={model} /><JobListItems model={model} /></article>;
}

function PaneRail({ model }: { model: JobListModel }) {
  return <div className={model.jobListCollapsed ? "pane-rail collapsed" : "pane-rail"}>
    {model.jobListCollapsed ? <button className="pane-rail-button" onClick={() => model.setJobListCollapsed(false)}
      title={model.t("jobList.action.expandList")} type="button">&gt;&gt;</button>
      : <div aria-hidden="true" className="pane-resizer" onMouseDown={model.beginResize} />}
  </div>;
}

function JobWorkspace({ model }: { model: JobListModel }) {
  const style = model.jobListCollapsed ? undefined
    : { gridTemplateColumns: `${model.jobListWidth}px 10px minmax(0, 1fr)` };
  return <div className={model.jobListCollapsed ? "job-workspace-layout fully-collapsed-list" : "job-workspace-layout"}
    style={style}><JobListPane model={model} /><PaneRail model={model} />
    <div className="job-detail-workspace"><JobDetailContent embedded /></div>
  </div>;
}

export function JobListContent() {
  const model = useJobListModel();
  return <section className="page job-list-page"><CenterNotice model={model} />
    <h1>{model.t("jobList.title")}</h1><p className="muted-text">{model.t("jobList.description")}</p>
    <JobWorkspace model={model} />
  </section>;
}
