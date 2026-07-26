import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  cancelJob,
  deleteJob,
  deleteJobsBatch,
  getJobs,
  purgeJob,
  purgeJobsBatch,
  restoreJob,
  restoreJobsBatch,
  retryJob,
  type GuiJob,
} from "../api/jobs";
import { JobDetailContent } from "./JobDetailPage";
import { subscribeToJobsStream } from "../stream/job_stream";
import { useUiStore } from "../stores/ui_store";
import { useLanguageStore } from "../stores/language_store";
import { JobWorkflowListItem } from "../features/jobs/components/JobWorkflowListItem";
import {
  buildJobWorkflows,
  isTerminalJob,
  jobStatusKey,
  jobTypeKey,
  workflowSearchText,
  type JobWorkflowViewModel,
} from "../features/jobs/viewmodels/job_list_viewmodel";

const RECONNECTING_NOTICE_DELAY_MS = 1200;

function mergeJobSummary(current: GuiJob | undefined, incoming: GuiJob): GuiJob {
  return {
    ...current,
    ...incoming,
    events: incoming.events || current?.events || [],
    artifacts: incoming.artifacts || current?.artifacts || [],
  };
}

function liveConnectionLabel(
  state: "idle" | "connecting" | "live" | "reconnecting" | "closed",
  t: (key: string) => string
) {
  switch (state) {
    case "connecting": return t("jobList.connection.connecting");
    case "live": return t("jobList.connection.live");
    case "reconnecting": return t("jobList.connection.reconnecting");
    case "closed": return t("jobList.connection.closed");
    case "idle":
    default: return t("jobList.connection.idle");
  }
}

function liveConnectionTone(state: "idle" | "connecting" | "live" | "reconnecting" | "closed") {
  switch (state) {
    case "live":
      return "good";
    case "connecting":
    case "reconnecting":
      return "warn";
    case "closed":
      return "neutral";
    case "idle":
    default:
      return "neutral";
  }
}

export function JobListPage() {
  const queryClient = useQueryClient();
  const t = useLanguageStore((state) => state.t);
  const selectedJobId = useUiStore((state) => state.selectedJobId);
  const setSelectedJobId = useUiStore((state) => state.setSelectedJobId);
  const setSelectedMangaId = useUiStore((state) => state.setSelectedMangaId);
  const setSelectedTranslatorId = useUiStore((state) => state.setSelectedTranslatorId);
  const [jobListCollapsed, setJobListCollapsed] = useState(false);
  const [jobListWidth, setJobListWidth] = useState(380);
  const [checkedJobIds, setCheckedJobIds] = useState<string[]>([]);
  const [filter, setFilter] = useState<"all" | "active" | "completed" | "failed" | "trash">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<
    "updated_desc" | "created_desc" | "created_asc" | "status_priority" | "title_asc"
  >("updated_desc");
  const [liveJobs, setLiveJobs] = useState<GuiJob[]>([]);
  const [listConnectionState, setListConnectionState] = useState<
    "idle" | "connecting" | "live" | "reconnecting" | "closed"
  >("idle");
  const [centerNotice, setCenterNotice] = useState<{
    tone: "success" | "error" | "info";
    message: string;
    actionLabel?: string;
    onAction?: () => void;
  } | null>(null);
  const resizeState = useRef<{ startX: number; startWidth: number } | null>(null);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null);

  const query = useQuery({
    queryKey: ["jobs"],
    queryFn: getJobs,
  });

  const retryMutation = useMutation({
    mutationFn: retryJob,
    onSuccess: async (job) => {
      setSelectedJobId(job.id);
      if (typeof job.payload.mangaId === "string" && job.payload.mangaId.trim()) {
        setSelectedMangaId(job.payload.mangaId);
      }
      if (typeof job.payload.translatorId === "string" && job.payload.translatorId.trim()) {
        setSelectedTranslatorId(job.payload.translatorId);
      }
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: cancelJob,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteJob,
    onSuccess: async (result) => {
      setCheckedJobIds((current) => current.filter((id) => id !== result.deleted.id));
      if (selectedJobId === result.deleted.id) {
        setSelectedJobId(null);
        setSelectedMangaId(null);
        setSelectedTranslatorId(null);
      }
      setCenterNotice({
        tone: "success",
        message: t("jobList.notice.deleted", { value: result.deleted.id }),
        actionLabel: t("jobList.action.undo"),
        onAction: () => restoreMutation.mutate(result.deleted.id),
      });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => {
      setCenterNotice({
        tone: "error",
        message: error instanceof Error ? error.message : t("jobList.error.delete"),
      });
    },
  });

  const batchDeleteMutation = useMutation({
    mutationFn: deleteJobsBatch,
    onSuccess: async (result) => {
      const deletedIds = new Set(result.deleted.map((entry) => entry.id));
      setCheckedJobIds((current) => current.filter((id) => !deletedIds.has(id)));
      if (selectedJobId && deletedIds.has(selectedJobId)) {
        setSelectedJobId(null);
        setSelectedMangaId(null);
        setSelectedTranslatorId(null);
      }
      setCenterNotice({
        tone: "success",
        message: t("jobList.notice.batchDeleted", { count: result.deleted.length }),
        actionLabel: t("jobList.action.undo"),
        onAction: () => restoreBatchMutation.mutate(result.deleted.map((entry) => entry.id)),
      });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => {
      setCenterNotice({
        tone: "error",
        message: error instanceof Error ? error.message : t("jobList.error.batchDelete"),
      });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: restoreJob,
    onSuccess: async (result) => {
      setCheckedJobIds((current) => current.filter((id) => id !== result.restored.id));
      setCenterNotice({
        tone: "success",
        message: t("jobList.notice.restored", { value: result.restored.id }),
      });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => {
      setCenterNotice({
        tone: "error",
        message: error instanceof Error ? error.message : t("jobList.error.restore"),
      });
    },
  });

  const restoreBatchMutation = useMutation({
    mutationFn: restoreJobsBatch,
    onSuccess: async (result) => {
      const restoredIds = new Set(result.restored.map((entry) => entry.id));
      setCheckedJobIds((current) => current.filter((id) => !restoredIds.has(id)));
      setCenterNotice({
        tone: "success",
        message: t("jobList.notice.batchRestored", { count: result.restored.length }),
      });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => {
      setCenterNotice({
        tone: "error",
        message: error instanceof Error ? error.message : t("jobList.error.batchRestore"),
      });
    },
  });

  const purgeMutation = useMutation({
    mutationFn: purgeJob,
    onSuccess: async (result) => {
      setCheckedJobIds((current) => current.filter((id) => id !== result.purged.id));
      if (selectedJobId === result.purged.id) {
        setSelectedJobId(null);
        setSelectedMangaId(null);
        setSelectedTranslatorId(null);
      }
      setCenterNotice({
        tone: "success",
        message: t("jobList.notice.purged", { value: result.purged.id }),
      });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => {
      setCenterNotice({
        tone: "error",
        message: error instanceof Error ? error.message : t("jobList.error.purge"),
      });
    },
  });

  const purgeBatchMutation = useMutation({
    mutationFn: purgeJobsBatch,
    onSuccess: async (result) => {
      const purgedIds = new Set(result.purged.map((entry) => entry.id));
      setCheckedJobIds((current) => current.filter((id) => !purgedIds.has(id)));
      if (selectedJobId && purgedIds.has(selectedJobId)) {
        setSelectedJobId(null);
        setSelectedMangaId(null);
        setSelectedTranslatorId(null);
      }
      setCenterNotice({
        tone: "success",
        message: t("jobList.notice.batchPurged", { count: result.purged.length }),
      });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => {
      setCenterNotice({
        tone: "error",
        message: error instanceof Error ? error.message : t("jobList.error.batchPurge"),
      });
    },
  });

  const busy =
    retryMutation.isPending ||
    cancelMutation.isPending ||
    deleteMutation.isPending ||
    batchDeleteMutation.isPending ||
    restoreMutation.isPending ||
    restoreBatchMutation.isPending ||
    purgeMutation.isPending ||
    purgeBatchMutation.isPending;

  const workflows = useMemo(() => buildJobWorkflows(liveJobs), [liveJobs]);
  const filteredWorkflows = useMemo(() => {
    let byStatus: JobWorkflowViewModel[];
    switch (filter) {
      case "active":
        byStatus = workflows.filter(({ root }) => !root.deletedAt && !isTerminalJob(root));
        break;
      case "completed":
        byStatus = workflows.filter(({ root }) => !root.deletedAt && ["succeeded", "canceled"].includes(root.status));
        break;
      case "failed":
        byStatus = workflows.filter(({ root, failedStage }) =>
          !root.deletedAt && (["failed", "blocked"].includes(root.status) || Boolean(failedStage))
        );
        break;
      case "trash":
        byStatus = workflows.filter(({ root }) => Boolean(root.deletedAt));
        break;
      case "all":
      default:
        byStatus = workflows.filter(({ root }) => !root.deletedAt);
        break;
    }

    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return byStatus;
    }

    return byStatus.filter((workflow) => workflowSearchText(workflow, t).includes(normalizedQuery));
  }, [filter, workflows, searchQuery, t]);

  const sortedWorkflows = useMemo(() => {
    const list = [...filteredWorkflows];
    const toTime = (value: string) => {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    const statusRank = ({ root: job, failedStage }: JobWorkflowViewModel) => {
      if (!isTerminalJob(job)) {
        return 0;
      }
      if (job.status === "failed" || failedStage) {
        return 1;
      }
      if (job.status === "succeeded") {
        return 2;
      }
      return 3;
    };
    const titleValue = ({ root: job }: JobWorkflowViewModel) =>
      (
        (typeof job.payload.mangaLabel === "string" && job.payload.mangaLabel) ||
        (typeof job.payload.mangaId === "string" && job.payload.mangaId) ||
        ""
      ).toLowerCase();

    list.sort((left, right) => {
      switch (sortMode) {
        case "created_desc":
          return toTime(right.root.createdAt) - toTime(left.root.createdAt);
        case "created_asc":
          return toTime(left.root.createdAt) - toTime(right.root.createdAt);
        case "status_priority": {
          const rankDifference = statusRank(left) - statusRank(right);
          if (rankDifference !== 0) {
            return rankDifference;
          }
          return toTime(right.root.updatedAt) - toTime(left.root.updatedAt);
        }
        case "title_asc": {
          const titleDifference = titleValue(left).localeCompare(titleValue(right));
          if (titleDifference !== 0) {
            return titleDifference;
          }
          return toTime(right.root.updatedAt) - toTime(left.root.updatedAt);
        }
        case "updated_desc":
        default:
          return toTime(right.root.updatedAt) - toTime(left.root.updatedAt);
      }
    });

    return list;
  }, [filteredWorkflows, sortMode]);

  const visibleJobs = sortedWorkflows.map(({ root }) => root);
  const visibleCheckedJobs = visibleJobs.filter((job) => checkedJobIds.includes(job.id));
  const visibleCheckedJobIds = visibleCheckedJobs.map((job) => job.id);
  const checkedVisibleCount = visibleJobs.filter((job) => checkedJobIds.includes(job.id)).length;
  const allVisibleChecked = visibleJobs.length > 0 && checkedVisibleCount === visibleJobs.length;
  const someVisibleChecked = checkedVisibleCount > 0 && !allVisibleChecked;

  const selectJobContext = (job: GuiJob) => {
    setSelectedJobId(job.id);
    if (typeof job.payload.mangaId === "string" && job.payload.mangaId.trim()) {
      setSelectedMangaId(job.payload.mangaId);
    }
    if (typeof job.payload.translatorId === "string" && job.payload.translatorId.trim()) {
      setSelectedTranslatorId(job.payload.translatorId);
    }
  };

  const toggleCheckedJob = (jobId: string) => {
    setCheckedJobIds((current) =>
      current.includes(jobId) ? current.filter((id) => id !== jobId) : [...current, jobId]
    );
  };

  const toggleAllVisibleJobs = () => {
    const targets = visibleJobs;
    setCheckedJobIds((current) => {
      if (allVisibleChecked) {
        return current.filter((id) => !targets.some((job) => job.id === id));
      }
      const merged = new Set(current);
      for (const job of targets) {
        merged.add(job.id);
      }
      return Array.from(merged);
    });
  };

  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = someVisibleChecked;
    }
  }, [someVisibleChecked]);

  const confirmDeleteJob = (job: GuiJob) => {
    const active = !isTerminalJob(job);
    const accepted = window.confirm(
      t(active ? "jobList.confirm.stopAndDelete" : "jobList.confirm.delete", {
        type: t(jobTypeKey(job.type)), status: t(jobStatusKey(job.status)), id: job.id,
      })
    );
    if (!accepted) {
      return;
    }
    deleteMutation.mutate(job.id);
  };

  const confirmBatchDelete = () => {
    if (visibleCheckedJobIds.length === 0) {
      return;
    }
    const accepted = window.confirm(
      t("jobList.confirm.batchDelete", { count: visibleCheckedJobIds.length })
    );
    if (!accepted) {
      return;
    }
    batchDeleteMutation.mutate(visibleCheckedJobIds);
  };

  const confirmRestoreBatch = () => {
    if (visibleCheckedJobIds.length === 0) {
      return;
    }
    const accepted = window.confirm(
      t("jobList.confirm.batchRestore", { count: visibleCheckedJobIds.length })
    );
    if (!accepted) {
      return;
    }
    restoreBatchMutation.mutate(visibleCheckedJobIds);
  };

  const confirmPurgeJob = (job: GuiJob) => {
    const accepted = window.confirm(
      t("jobList.confirm.purge", {
        type: t(jobTypeKey(job.type)), status: t(jobStatusKey(job.status)), id: job.id,
      })
    );
    if (!accepted) {
      return;
    }
    purgeMutation.mutate(job.id);
  };

  const confirmPurgeBatch = () => {
    if (visibleCheckedJobIds.length === 0 || visibleCheckedJobs.some((job) => !isTerminalJob(job))) {
      return;
    }
    const accepted = window.confirm(
      t("jobList.confirm.batchPurge", { count: visibleCheckedJobIds.length })
    );
    if (!accepted) {
      return;
    }
    purgeBatchMutation.mutate(visibleCheckedJobIds);
  };

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!resizeState.current) {
        return;
      }

      const delta = event.clientX - resizeState.current.startX;
      const nextWidth = Math.min(520, Math.max(260, resizeState.current.startWidth + delta));
      setJobListWidth(nextWidth);
    };

    const handleMouseUp = () => {
      if (!resizeState.current) {
        return;
      }
      resizeState.current = null;
      document.body.classList.remove("is-resizing-pane");
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.classList.remove("is-resizing-pane");
    };
  }, []);

  useEffect(() => {
    if (query.data?.jobs) {
      setLiveJobs(query.data.jobs);
    }
  }, [query.data]);

  useEffect(() => {
    setListConnectionState("connecting");
    const unsubscribe = subscribeToJobsStream({
      onOpen: () => {
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        setListConnectionState("live");
      },
      onError: () => {
        if (reconnectTimerRef.current) {
          return;
        }
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          setListConnectionState("reconnecting");
        }, RECONNECTING_NOTICE_DELAY_MS);
      },
      onEvent: (message) => {
        if (message.type === "jobs.snapshot" && Array.isArray(message.jobs)) {
          const jobs = message.jobs as GuiJob[];
          setLiveJobs(jobs);
          queryClient.setQueryData(["jobs"], { jobs });
          for (const job of jobs) {
            queryClient.setQueryData<GuiJob>(["job", job.id], (current) =>
              mergeJobSummary(current, job)
            );
          }
          return;
        }

        if (message.kind === "job" && message.job && typeof message.job === "object") {
          const nextJob = message.job as GuiJob;
          setLiveJobs((current) => {
            const index = current.findIndex((job) => job.id === nextJob.id);
            if (index === -1) {
              return [mergeJobSummary(undefined, nextJob), ...current];
            }
            const updated = [...current];
            updated[index] = mergeJobSummary(current[index], nextJob);
            return updated;
          });
          queryClient.setQueryData<{ jobs: GuiJob[] }>(["jobs"], (current) => {
            const jobs = current?.jobs || [];
            const index = jobs.findIndex((job) => job.id === nextJob.id);
            if (index === -1) {
              return { jobs: [mergeJobSummary(undefined, nextJob), ...jobs] };
            }
            const updated = [...jobs];
            updated[index] = mergeJobSummary(jobs[index], nextJob);
            return { jobs: updated };
          });
          queryClient.setQueryData<GuiJob>(["job", nextJob.id], (current) =>
            mergeJobSummary(current, nextJob)
          );
          return;
        }

        if (message.type === "job.purged") {
          const payload =
            message.payload && typeof message.payload === "object"
              ? (message.payload as Record<string, unknown>)
              : null;
          const jobId = typeof payload?.jobId === "string" ? payload.jobId : null;
          if (!jobId) {
            return;
          }
          setLiveJobs((current) => current.filter((job) => job.id !== jobId));
          return;
        }

        if (message.type === "job.batch_purged" || message.type === "job.trash_cleanup") {
          const payload =
            message.payload && typeof message.payload === "object"
              ? (message.payload as Record<string, unknown>)
              : null;
          const jobIds = Array.isArray(payload?.jobIds)
            ? payload.jobIds.filter((value): value is string => typeof value === "string")
            : Array.isArray(payload?.purgedIds)
              ? payload.purgedIds.filter((value): value is string => typeof value === "string")
              : [];
          if (jobIds.length === 0) {
            return;
          }
          const deleted = new Set(jobIds);
          setLiveJobs((current) => current.filter((job) => !deleted.has(job.id)));
        }
      },
    });

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      unsubscribe();
      setListConnectionState("closed");
    };
  }, [queryClient]);

  useEffect(() => {
    if (!selectedJobId) {
      return;
    }
    const selectedStillExists = liveJobs.some((job) => job.id === selectedJobId);
    if (!selectedStillExists) {
      setSelectedJobId(null);
      setSelectedMangaId(null);
      setSelectedTranslatorId(null);
    }
  }, [liveJobs, selectedJobId, setSelectedJobId, setSelectedMangaId, setSelectedTranslatorId]);

  useEffect(() => {
    if (!centerNotice) {
      return;
    }
    if (noticeTimeoutRef.current) {
      clearTimeout(noticeTimeoutRef.current);
    }
    noticeTimeoutRef.current = setTimeout(() => {
      setCenterNotice(null);
      noticeTimeoutRef.current = null;
    }, 2600);

    return () => {
      if (noticeTimeoutRef.current) {
        clearTimeout(noticeTimeoutRef.current);
        noticeTimeoutRef.current = null;
      }
    };
  }, [centerNotice]);

  const beginResize = (event: React.MouseEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 980 || jobListCollapsed) {
      return;
    }
    resizeState.current = {
      startX: event.clientX,
      startWidth: jobListWidth,
    };
    document.body.classList.add("is-resizing-pane");
  };

  return (
    <section className="page job-list-page">
      {centerNotice ? (
        <div className="center-notice-layer">
          <div className={`center-notice center-notice-${centerNotice.tone}`}>
            <div>{centerNotice.message}</div>
            {centerNotice.onAction && centerNotice.actionLabel ? (
              <button
                className="secondary-button center-notice-action"
                onClick={centerNotice.onAction}
                type="button"
              >
                {centerNotice.actionLabel}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <h1>{t("jobList.title")}</h1>
      <p className="muted-text">{t("jobList.description")}</p>

      <div
        className={jobListCollapsed ? "job-workspace-layout fully-collapsed-list" : "job-workspace-layout"}
        style={
          jobListCollapsed
            ? undefined
            : {
                gridTemplateColumns: `${jobListWidth}px 10px minmax(0, 1fr)`,
              }
        }
      >
        <article className={jobListCollapsed ? "card job-list-pane fully-collapsed" : "card job-list-pane"}>
          <div className="job-list-header">
            <div>
              <h2>{t("jobList.current.title")}</h2>
              {!jobListCollapsed ? (
                <div className="job-list-live-row">
                  <p className="muted-text">{t("jobList.current.description")}</p>
                  <span className={`live-connection-badge live-connection-badge-${liveConnectionTone(listConnectionState)}`}>
                    {liveConnectionLabel(listConnectionState, t)}
                  </span>
                </div>
              ) : null}
            </div>
            <div className="job-list-toolbar">
              <button
                className="secondary-button"
                onClick={() => setJobListCollapsed((value) => !value)}
                type="button"
              >
                {t(jobListCollapsed ? "jobList.action.expandList" : "jobList.action.collapseList")}
              </button>
              {!jobListCollapsed ? (
                <button
                  className="secondary-button"
                  onClick={() => void queryClient.invalidateQueries({ queryKey: ["jobs"] })}
                  type="button"
                >
                  {t("jobList.action.refresh")}
                </button>
              ) : null}
              {!jobListCollapsed ? (
                <>
                  <button
                    className="secondary-button"
                    disabled={busy || visibleCheckedJobIds.length === 0}
                    onClick={filter === "trash" ? confirmRestoreBatch : confirmBatchDelete}
                    title={
                      visibleCheckedJobIds.length === 0
                        ? t(filter === "trash" ? "jobList.hint.selectRestore" : "jobList.hint.selectDelete")
                        : t(filter === "trash" ? "jobList.hint.restoreSelected" : "jobList.hint.deleteSelected")
                    }
                    type="button"
                  >
                    {t(filter === "trash" ? "jobList.action.restoreSelected" : "jobList.action.deleteSelected")}
                  </button>
                  {filter === "trash" ? (
                    <button
                      className="secondary-button danger-button"
                      disabled={
                        busy ||
                        visibleCheckedJobIds.length === 0 ||
                        visibleCheckedJobs.some((job) => !isTerminalJob(job))
                      }
                      onClick={confirmPurgeBatch}
                      title={
                        visibleCheckedJobIds.length === 0
                          ? t("jobList.hint.selectPurge")
                          : visibleCheckedJobs.some((job) => !isTerminalJob(job))
                            ? t("jobList.hint.waitForStop")
                            : t("jobList.hint.purgeSelected")
                      }
                      type="button"
                    >
                      {t("jobList.action.purge")}
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>

          {!jobListCollapsed ? (
            <div className="filter-row">
              {[
                { key: "all", label: t("jobList.filter.all") },
                { key: "active", label: t("jobList.filter.active") },
                { key: "completed", label: t("jobList.filter.completed") },
                { key: "failed", label: t("jobList.filter.failed") },
                { key: "trash", label: t("jobList.filter.trash") },
              ].map((entry) => (
                <button
                  key={entry.key}
                  className={filter === entry.key ? "secondary-button active-filter" : "secondary-button"}
                  onClick={() => setFilter(entry.key as typeof filter)}
                  type="button"
                >
                  {entry.label}
                </button>
              ))}
            </div>
          ) : null}

          {!jobListCollapsed ? (
            <div className="list-controls-grid">
              <label className="standalone-field">
                <span>{t("jobList.search.label")}</span>
                <input
                  onChange={(event) => setSearchQuery(event.currentTarget.value)}
                  placeholder={t("jobList.search.placeholder")}
                  value={searchQuery}
                />
              </label>
              <label className="standalone-field">
                <span>{t("jobList.sort.label")}</span>
                <select
                  onChange={(event) =>
                    setSortMode(
                      event.currentTarget.value as
                        | "updated_desc"
                        | "created_desc"
                        | "created_asc"
                        | "status_priority"
                        | "title_asc"
                    )
                  }
                  value={sortMode}
                >
                  <option value="updated_desc">{t("jobList.sort.updatedDesc")}</option>
                  <option value="created_desc">{t("jobList.sort.createdDesc")}</option>
                  <option value="created_asc">{t("jobList.sort.createdAsc")}</option>
                  <option value="status_priority">{t("jobList.sort.status")}</option>
                  <option value="title_asc">{t("jobList.sort.title")}</option>
                </select>
              </label>
            </div>
          ) : null}

          {!jobListCollapsed ? (
            <label className="checkbox-row select-all-row">
              <input
                checked={allVisibleChecked}
                disabled={visibleJobs.length === 0 || busy}
                onChange={toggleAllVisibleJobs}
                ref={selectAllCheckboxRef}
                type="checkbox"
              />
              <span>
                {filter === "trash"
                  ? t("jobList.selectAll.trash", { count: visibleJobs.length })
                  : t("jobList.selectAll.visible", { count: visibleJobs.length })}
              </span>
            </label>
          ) : null}

          {query.isLoading && <p>{t("jobList.loading")}</p>}
          {query.isError && <p>{t("jobList.loadFailed")}</p>}
          {!query.isLoading && !query.isError && query.data && (
            <ul className="job-list">
              {sortedWorkflows.length === 0 ? (
                <li className="job-list-item empty-state-item">
                  <div className="job-subtext">
                    {searchQuery.trim()
                      ? t("jobList.empty.search", { value: searchQuery.trim() })
                      : t("jobList.empty.filtered")}
                  </div>
                </li>
              ) : null}
              {sortedWorkflows.map((workflow) => (
                <JobWorkflowListItem
                  key={workflow.root.id}
                  busy={busy}
                  checked={checkedJobIds.includes(workflow.root.id)}
                  collapsed={jobListCollapsed}
                  onCancel={(jobId) => cancelMutation.mutate(jobId)}
                  onDelete={confirmDeleteJob}
                  onPurge={confirmPurgeJob}
                  onRestore={(jobId) => restoreMutation.mutate(jobId)}
                  onRetry={(jobId) => retryMutation.mutate(jobId)}
                  onSelect={selectJobContext}
                  onToggleChecked={toggleCheckedJob}
                  t={t}
                  workflow={workflow}
                />
              ))}
            </ul>
          )}
        </article>

        <div className={jobListCollapsed ? "pane-rail collapsed" : "pane-rail"}>
          {jobListCollapsed ? (
            <button
              className="pane-rail-button"
              onClick={() => setJobListCollapsed(false)}
              title={t("jobList.action.expandList")}
              type="button"
            >
              &gt;&gt;
            </button>
          ) : (
            <div aria-hidden="true" className="pane-resizer" onMouseDown={beginResize} />
          )}
        </div>

        <div className="job-detail-workspace">
          <JobDetailContent embedded />
        </div>
      </div>
    </section>
  );
}
