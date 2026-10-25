import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelJob, deleteJob, deleteJobsBatch, getJobs, purgeJob, purgeJobsBatch, restoreJob,
  restoreJobsBatch, resumeJob, retryJob, type GuiJob,
} from "../../../api/jobs";
import { subscribeToJobsStream } from "../../../stream/job_stream";
import { useLanguageStore } from "../../../stores/language_store";
import { useUiStore } from "../../../stores/ui_store";
import { buildJobWorkflows, isTerminalJob, jobStatusKey, jobTypeKey, workflowSearchText,
  type JobWorkflowViewModel } from "../viewmodels/job_list_viewmodel";

const RECONNECTING_NOTICE_DELAY_MS = 1200;
export type JobFilter = "all" | "active" | "completed" | "failed" | "trash";
export type JobSort = "updated_desc" | "created_desc" | "created_asc" | "status_priority" | "title_asc";
export type ConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "closed";
export type Translate = (key: string, params?: Record<string, string | number>) => string;
type Notice = { tone: "success" | "error" | "info"; message: string; actionLabel?: string; onAction?: () => void };
type StreamMessage = { type?: string; kind?: string; jobs?: unknown; job?: unknown; payload?: unknown };

function mergeJobSummary(current: GuiJob | undefined, incoming: GuiJob): GuiJob {
  return { ...current, ...incoming, events: incoming.events || current?.events || [],
    artifacts: incoming.artifacts || current?.artifacts || [] };
}

function useJobListState() {
  const [jobListCollapsed, setJobListCollapsed] = useState(false);
  const [jobListWidth, setJobListWidth] = useState(440);
  const [checkedJobIds, setCheckedJobIds] = useState<string[]>([]);
  const [filter, setFilter] = useState<JobFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<JobSort>("updated_desc");
  const [liveJobs, setLiveJobs] = useState<GuiJob[]>([]);
  const [listConnectionState, setListConnectionState] = useState<ConnectionState>("idle");
  const [centerNotice, setCenterNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const resizeState = useRef<{ startX: number; startWidth: number } | null>(null);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null);
  return { jobListCollapsed, setJobListCollapsed, jobListWidth, setJobListWidth, checkedJobIds,
    setCheckedJobIds, filter, setFilter, searchQuery, setSearchQuery, sortMode, setSortMode,
    liveJobs, setLiveJobs, listConnectionState, setListConnectionState, centerNotice,
    setCenterNotice, busy, setBusy, resizeState, noticeTimeoutRef, reconnectTimerRef, selectAllCheckboxRef };
}

function useJobNavigation() {
  const selectedJobId = useUiStore((state) => state.selectedJobId);
  const setSelectedJobId = useUiStore((state) => state.setSelectedJobId);
  const setSelectedMangaId = useUiStore((state) => state.setSelectedMangaId);
  const setSelectedTranslatorId = useUiStore((state) => state.setSelectedTranslatorId);
  return { selectedJobId, setSelectedJobId, setSelectedMangaId, setSelectedTranslatorId };
}

type JobListState = ReturnType<typeof useJobListState>;
type JobNavigation = ReturnType<typeof useJobNavigation>;

function selectJobContext(job: GuiJob, navigation: JobNavigation) {
  navigation.setSelectedJobId(job.id);
  const mangaId = job.payload.mangaId;
  if (typeof mangaId === "string" && mangaId.trim()) navigation.setSelectedMangaId(mangaId);
  const translatorId = job.payload.translatorId;
  if (typeof translatorId === "string" && translatorId.trim()) navigation.setSelectedTranslatorId(translatorId);
}

function clearSelectedJob(navigation: JobNavigation, ids: Set<string>) {
  if (!navigation.selectedJobId || !ids.has(navigation.selectedJobId)) return;
  navigation.setSelectedJobId(null);
  navigation.setSelectedMangaId(null);
  navigation.setSelectedTranslatorId(null);
}

async function runJobAction<T>(state: JobListState, operation: () => Promise<T>,
  success: (result: T) => void | Promise<void>, fallback: string) {
  state.setBusy(true);
  try { await success(await operation()); }
  catch (error) { state.setCenterNotice({ tone: "error", message: error instanceof Error ? error.message : fallback }); }
  finally { state.setBusy(false); }
}

function createRestoreActions(state: JobListState, refresh: () => Promise<unknown>, t: Translate) {
  const restoreOne = (id: string) => runJobAction(state, () => restoreJob(id), async (result) => {
    state.setCheckedJobIds((current) => current.filter((value) => value !== result.restored.id));
    state.setCenterNotice({ tone: "success", message: t("jobList.notice.restored", { value: result.restored.id }) });
    await refresh();
  }, t("jobList.error.restore"));
  const restoreBatch = (ids: string[]) => runJobAction(state, () => restoreJobsBatch(ids), async (result) => {
    const restored = new Set(result.restored.map((entry) => entry.id));
    state.setCheckedJobIds((current) => current.filter((id) => !restored.has(id)));
    state.setCenterNotice({ tone: "success", message: t("jobList.notice.batchRestored", { count: restored.size }) });
    await refresh();
  }, t("jobList.error.batchRestore"));
  return { restoreOne, restoreBatch };
}

function createDeleteActions(state: JobListState, navigation: JobNavigation, refresh: () => Promise<unknown>,
  restore: ReturnType<typeof createRestoreActions>, t: Translate) {
  const deleteOne = (id: string) => runJobAction(state, () => deleteJob(id), async (result) => {
    const deleted = new Set([result.deleted.id]);
    state.setCheckedJobIds((current) => current.filter((value) => !deleted.has(value)));
    clearSelectedJob(navigation, deleted);
    state.setCenterNotice({ tone: "success", message: t("jobList.notice.deleted", { value: result.deleted.id }),
      actionLabel: t("jobList.action.undo"), onAction: () => void restore.restoreOne(result.deleted.id) });
    await refresh();
  }, t("jobList.error.delete"));
  const deleteBatch = (ids: string[]) => runJobAction(state, () => deleteJobsBatch(ids), async (result) => {
    const deleted = new Set(result.deleted.map((entry) => entry.id));
    state.setCheckedJobIds((current) => current.filter((id) => !deleted.has(id)));
    clearSelectedJob(navigation, deleted);
    state.setCenterNotice({ tone: "success", message: t("jobList.notice.batchDeleted", { count: deleted.size }),
      actionLabel: t("jobList.action.undo"), onAction: () => void restore.restoreBatch([...deleted]) });
    await refresh();
  }, t("jobList.error.batchDelete"));
  return { deleteOne, deleteBatch };
}

function createPurgeActions(state: JobListState, navigation: JobNavigation,
  refresh: () => Promise<unknown>, t: Translate) {
  const purgeOne = (id: string) => runJobAction(state, () => purgeJob(id), async (result) => {
    const purged = new Set([result.purged.id]);
    state.setCheckedJobIds((current) => current.filter((value) => !purged.has(value)));
    clearSelectedJob(navigation, purged);
    state.setCenterNotice({ tone: "success", message: t("jobList.notice.purged", { value: result.purged.id }) });
    await refresh();
  }, t("jobList.error.purge"));
  const purgeBatch = (ids: string[]) => runJobAction(state, () => purgeJobsBatch(ids), async (result) => {
    const purged = new Set(result.purged.map((entry) => entry.id));
    state.setCheckedJobIds((current) => current.filter((id) => !purged.has(id)));
    clearSelectedJob(navigation, purged);
    state.setCenterNotice({ tone: "success", message: t("jobList.notice.batchPurged", { count: purged.size }) });
    await refresh();
  }, t("jobList.error.batchPurge"));
  return { purgeOne, purgeBatch };
}

function createLifecycleActions(state: JobListState, navigation: JobNavigation, refresh: () => Promise<unknown>) {
  return { retry: (id: string) => runJobAction(state, () => retryJob(id), async (job) => {
    selectJobContext(job, navigation); await refresh(); }, ""),
    resume: (id: string) => runJobAction(state, () => resumeJob(id), async (job) => {
      navigation.setSelectedJobId(job.id); await refresh(); }, ""),
    cancel: (id: string) => runJobAction(state, () => cancelJob(id), async () => { await refresh(); }, "") };
}

function useJobActions(state: JobListState, navigation: JobNavigation, queryClient: QueryClient, t: Translate) {
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["jobs"] });
  const restore = createRestoreActions(state, refresh, t);
  const deletion = createDeleteActions(state, navigation, refresh, restore, t);
  const purge = createPurgeActions(state, navigation, refresh, t);
  const lifecycle = createLifecycleActions(state, navigation, refresh);
  return { ...lifecycle, ...deletion, ...restore, ...purge, refresh };
}

function filterWorkflows(workflows: JobWorkflowViewModel[], filter: JobFilter) {
  switch (filter) {
    case "active": return workflows.filter(({ root }) => !root.deletedAt && !isTerminalJob(root));
    case "completed": return workflows.filter(({ root }) => !root.deletedAt && ["succeeded", "canceled"].includes(root.status));
    case "failed": return workflows.filter(({ root, failedStage }) =>
      !root.deletedAt && (["failed", "blocked"].includes(root.status) || Boolean(failedStage)));
    case "trash": return workflows.filter(({ root }) => Boolean(root.deletedAt));
    default: return workflows.filter(({ root }) => !root.deletedAt);
  }
}

function workflowTime(value: string) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function workflowStatusRank({ root, failedStage }: JobWorkflowViewModel) {
  if (!isTerminalJob(root)) return 0;
  if (root.status === "failed" || failedStage) return 1;
  return root.status === "succeeded" ? 2 : 3;
}

function workflowTitle({ root }: JobWorkflowViewModel) {
  const label = typeof root.payload.mangaLabel === "string" && root.payload.mangaLabel;
  const id = typeof root.payload.mangaId === "string" && root.payload.mangaId;
  return (label || id || "").toLowerCase();
}

function compareWorkflows(left: JobWorkflowViewModel, right: JobWorkflowViewModel, mode: JobSort) {
  if (mode === "created_desc") return workflowTime(right.root.createdAt) - workflowTime(left.root.createdAt);
  if (mode === "created_asc") return workflowTime(left.root.createdAt) - workflowTime(right.root.createdAt);
  if (mode === "status_priority") {
    const rank = workflowStatusRank(left) - workflowStatusRank(right);
    return rank || workflowTime(right.root.updatedAt) - workflowTime(left.root.updatedAt);
  }
  if (mode === "title_asc") {
    const title = workflowTitle(left).localeCompare(workflowTitle(right));
    return title || workflowTime(right.root.updatedAt) - workflowTime(left.root.updatedAt);
  }
  return workflowTime(right.root.updatedAt) - workflowTime(left.root.updatedAt);
}

function useVisibleWorkflows(state: JobListState, t: Translate) {
  const workflows = useMemo(() => buildJobWorkflows(state.liveJobs), [state.liveJobs]);
  const filtered = useMemo(() => {
    const byStatus = filterWorkflows(workflows, state.filter);
    const query = state.searchQuery.trim().toLowerCase();
    return query ? byStatus.filter((workflow) => workflowSearchText(workflow, t).includes(query)) : byStatus;
  }, [state.filter, state.searchQuery, t, workflows]);
  const sortedWorkflows = useMemo(() => [...filtered].sort((left, right) =>
    compareWorkflows(left, right, state.sortMode)), [filtered, state.sortMode]);
  return { workflows, sortedWorkflows, visibleJobs: sortedWorkflows.map(({ root }) => root) };
}

function mergeLiveJob(jobs: GuiJob[], incoming: GuiJob) {
  const index = jobs.findIndex((job) => job.id === incoming.id);
  if (index === -1) return [mergeJobSummary(undefined, incoming), ...jobs];
  const updated = [...jobs];
  updated[index] = mergeJobSummary(jobs[index], incoming);
  return updated;
}

function applySnapshot(jobs: GuiJob[], state: JobListState, queryClient: QueryClient) {
  state.setLiveJobs(jobs);
  queryClient.setQueryData(["jobs"], { jobs });
  for (const job of jobs) queryClient.setQueryData<GuiJob>(["job", job.id], (current) => mergeJobSummary(current, job));
}

function applyLiveJob(job: GuiJob, state: JobListState, queryClient: QueryClient) {
  state.setLiveJobs((current) => mergeLiveJob(current, job));
  queryClient.setQueryData<{ jobs: GuiJob[] }>(["jobs"], (current) =>
    ({ jobs: mergeLiveJob(current?.jobs || [], job) }));
  queryClient.setQueryData<GuiJob>(["job", job.id], (current) => mergeJobSummary(current, job));
}

function purgedJobIds(message: StreamMessage) {
  const payload = message.payload && typeof message.payload === "object"
    ? message.payload as Record<string, unknown> : null;
  if (message.type === "job.purged") return typeof payload?.jobId === "string" ? [payload.jobId] : [];
  const values = Array.isArray(payload?.jobIds) ? payload.jobIds
    : Array.isArray(payload?.purgedIds) ? payload.purgedIds : [];
  return values.filter((value): value is string => typeof value === "string");
}

function handleJobsStreamEvent(message: StreamMessage, state: JobListState, queryClient: QueryClient) {
  if (message.type === "jobs.snapshot" && Array.isArray(message.jobs)) {
    applySnapshot(message.jobs as GuiJob[], state, queryClient);
    return;
  }
  if (message.kind === "job" && message.job && typeof message.job === "object") {
    applyLiveJob(message.job as GuiJob, state, queryClient);
    return;
  }
  const ids = purgedJobIds(message);
  if (ids.length) {
    const deleted = new Set(ids);
    state.setLiveJobs((current) => current.filter((job) => !deleted.has(job.id)));
  }
}

function clearTimer(ref: { current: ReturnType<typeof setTimeout> | null }) {
  if (!ref.current) return;
  clearTimeout(ref.current);
  ref.current = null;
}

function useJobsStream(state: JobListState, queryClient: QueryClient) {
  useEffect(() => {
    state.setListConnectionState("connecting");
    const unsubscribe = subscribeToJobsStream({
      onOpen: () => { clearTimer(state.reconnectTimerRef); state.setListConnectionState("live"); },
      onError: () => {
        if (state.reconnectTimerRef.current) return;
        state.reconnectTimerRef.current = setTimeout(() => {
          state.reconnectTimerRef.current = null;
          state.setListConnectionState("reconnecting");
        }, RECONNECTING_NOTICE_DELAY_MS);
      },
      onEvent: (message) => handleJobsStreamEvent(message, state, queryClient),
    });
    return () => { clearTimer(state.reconnectTimerRef); unsubscribe(); state.setListConnectionState("closed"); };
  }, [queryClient]);
}

function usePaneResize(state: JobListState) {
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!state.resizeState.current) return;
      const delta = event.clientX - state.resizeState.current.startX;
      state.setJobListWidth(Math.min(620, Math.max(320, state.resizeState.current.startWidth + delta)));
    };
    const stop = () => {
      if (!state.resizeState.current) return;
      state.resizeState.current = null;
      document.body.classList.remove("is-resizing-pane");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", stop);
      document.body.classList.remove("is-resizing-pane"); };
  }, []);
}

function useNoticeTimeout(state: JobListState) {
  useEffect(() => {
    if (!state.centerNotice) return;
    clearTimer(state.noticeTimeoutRef);
    state.noticeTimeoutRef.current = setTimeout(() => {
      state.setCenterNotice(null);
      state.noticeTimeoutRef.current = null;
    }, 2600);
    return () => clearTimer(state.noticeTimeoutRef);
  }, [state.centerNotice]);
}

function useSelectedJobCleanup(state: JobListState, navigation: JobNavigation) {
  useEffect(() => {
    if (!navigation.selectedJobId || state.liveJobs.some((job) => job.id === navigation.selectedJobId)) return;
    navigation.setSelectedJobId(null);
    navigation.setSelectedMangaId(null);
    navigation.setSelectedTranslatorId(null);
  }, [navigation.selectedJobId, state.liveJobs]);
}

function toggleChecked(state: JobListState, jobId: string) {
  state.setCheckedJobIds((current) => current.includes(jobId)
    ? current.filter((id) => id !== jobId) : [...current, jobId]);
}

function toggleAllChecked(state: JobListState, jobs: GuiJob[], allChecked: boolean) {
  state.setCheckedJobIds((current) => {
    if (allChecked) return current.filter((id) => !jobs.some((job) => job.id === id));
    return [...new Set([...current, ...jobs.map((job) => job.id)])];
  });
}

function useSelectionState(state: JobListState, visibleJobs: GuiJob[]) {
  const checkedJobs = visibleJobs.filter((job) => state.checkedJobIds.includes(job.id));
  const checkedIds = checkedJobs.map((job) => job.id);
  const allChecked = visibleJobs.length > 0 && checkedJobs.length === visibleJobs.length;
  const someChecked = checkedJobs.length > 0 && !allChecked;
  useEffect(() => { if (state.selectAllCheckboxRef.current)
    state.selectAllCheckboxRef.current.indeterminate = someChecked; }, [someChecked]);
  return { checkedJobs, checkedIds, allChecked, someChecked,
    toggleChecked: (id: string) => toggleChecked(state, id),
    toggleAll: () => toggleAllChecked(state, visibleJobs, allChecked) };
}

function createConfirmations(model: { state: JobListState; actions: ReturnType<typeof useJobActions>;
  selection: ReturnType<typeof useSelectionState>; t: Translate }) {
  const confirmDeleteJob = (job: GuiJob) => {
    const key = isTerminalJob(job) ? "jobList.confirm.delete" : "jobList.confirm.stopAndDelete";
    if (window.confirm(model.t(key, { type: model.t(jobTypeKey(job.type)),
      status: model.t(jobStatusKey(job.status)), id: job.id }))) void model.actions.deleteOne(job.id);
  };
  const confirmPurgeJob = (job: GuiJob) => {
    if (window.confirm(model.t("jobList.confirm.purge", { type: model.t(jobTypeKey(job.type)),
      status: model.t(jobStatusKey(job.status)), id: job.id }))) void model.actions.purgeOne(job.id);
  };
  const confirmBatch = (kind: "delete" | "restore" | "purge") => {
    if (!model.selection.checkedIds.length) return;
    if (kind === "purge" && model.selection.checkedJobs.some((job) => !isTerminalJob(job))) return;
    const key = kind === "delete" ? "jobList.confirm.batchDelete"
      : kind === "restore" ? "jobList.confirm.batchRestore" : "jobList.confirm.batchPurge";
    if (!window.confirm(model.t(key, { count: model.selection.checkedIds.length }))) return;
    if (kind === "delete") void model.actions.deleteBatch(model.selection.checkedIds);
    else if (kind === "restore") void model.actions.restoreBatch(model.selection.checkedIds);
    else void model.actions.purgeBatch(model.selection.checkedIds);
  };
  return { confirmDeleteJob, confirmPurgeJob, confirmBatchDelete: () => confirmBatch("delete"),
    confirmRestoreBatch: () => confirmBatch("restore"), confirmPurgeBatch: () => confirmBatch("purge") };
}

export function useJobListModel() {
  const queryClient = useQueryClient();
  const t = useLanguageStore((current) => current.t);
  const state = useJobListState();
  const navigation = useJobNavigation();
  const query = useQuery({ queryKey: ["jobs"], queryFn: getJobs });
  const visible = useVisibleWorkflows(state, t);
  const selection = useSelectionState(state, visible.visibleJobs);
  const actions = useJobActions(state, navigation, queryClient, t);
  useEffect(() => { if (query.data?.jobs) state.setLiveJobs(query.data.jobs); }, [query.data]);
  useJobsStream(state, queryClient);
  usePaneResize(state);
  useNoticeTimeout(state);
  useSelectedJobCleanup(state, navigation);
  const confirmations = createConfirmations({ state, actions, selection, t });
  const beginResize = (event: React.MouseEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 980 || state.jobListCollapsed) return;
    state.resizeState.current = { startX: event.clientX, startWidth: state.jobListWidth };
    document.body.classList.add("is-resizing-pane");
  };
  return { ...state, ...navigation, ...visible, ...selection, ...actions, ...confirmations,
    query, t, beginResize, selectJob: (job: GuiJob) => selectJobContext(job, navigation) };
}

export type JobListModel = ReturnType<typeof useJobListModel>;
