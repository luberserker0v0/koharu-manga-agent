import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createQualityRepairJob, createTranslationDeepAuditJob, getJob, getJobArtifacts, getJobEvents, type GuiJob, type GuiJobEvent } from "../api/jobs";
import { ArtifactsContent } from "./ArtifactsPage";
import { translateLiteral } from "../i18n/messages";
import { openDesktopPath } from "../services/desktop_api";
import { subscribeToJobStream } from "../stream/job_stream";
import { useLanguageStore } from "../stores/language_store";
import { useSelectedJobRuntimeStore } from "../stores/selected_job_runtime_store";
import { useUiStore } from "../stores/ui_store";
import { formatSystemDateTime } from "../features/shared/formatters/date_time";
import { resolveJobStageLabel } from "../features/jobs/viewmodels/job_list_viewmodel";
import { QualityReviewPane } from "../features/jobs/components/QualityReviewPane";

function formatValue(value: unknown): string {
  if (value == null) {
    return "n/a";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function statusTone(status: string) {
  if (["failed", "error"].includes(status)) {
    return "bad";
  }
  if (["running", "observed"].includes(status)) {
    return "warn";
  }
  if (["completed", "succeeded"].includes(status)) {
    return "good";
  }
  return "neutral";
}

function eventSignature(event: GuiJobEvent): string {
  return `${event.type}:${JSON.stringify(event.payload ?? null)}`;
}

type TimelineItem = {
  kind: "event" | "progress";
  label: string;
  when: string;
  sourceEventType: string;
  engine?: string | null;
  pageIndex?: number | null;
  totalPages?: number | null;
};

type ProgressSnapshot = {
  engine: string | null;
  pageIndex: number | null;
  totalPages: number | null;
  status: string | null;
};

type WorkflowStageKey = string;
type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

const ENGINE_LABELS: Record<string, string> = {
  detect: "Detect",
  fontDetect: "Font Detect",
  segment: "Segment",
  bubbleSegment: "Bubble Segment",
  ocr: "OCR",
  translate: "Translate",
  clean: "Clean",
  render: "Render",
};

const TERMINAL_PIPELINE_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);
const RECONNECTING_NOTICE_DELAY_MS = 1200;
type WorkflowStageDefinition = {
  key: WorkflowStageKey;
  eventTypes: string[];
  optionalWhen?: (job: { payload?: Record<string, unknown> } | null) => boolean;
};

const TRANSLATION_WORKFLOW_STAGE_DEFS: WorkflowStageDefinition[] = [
  { key: "source_preflight", eventTypes: ["source_preflight.resolved"] },
  { key: "translation_memory", eventTypes: ["translation_memory.built"] },
  { key: "setup_project", eventTypes: ["setup.completed"] },
  { key: "monitor_pipeline", eventTypes: ["pipeline.progress", "pipeline.completed"] },
  {
    key: "quality_review",
    eventTypes: ["quality.completed"],
    optionalWhen: (job) =>
      job?.payload?.translationMode === "quick" ||
      (["reference_style", "local_style"].includes(String(job?.payload?.translationMode)) &&
        job?.payload?.qualityCheck !== true),
  },
  { key: "translation_snapshot", eventTypes: ["translation_snapshot.persisted"] },
  { key: "export", eventTypes: ["export.completed"] },
  { key: "close_project", eventTypes: ["project.closed"] },
];

const REFERENCE_INGESTION_STAGE_DEFS: WorkflowStageDefinition[] = [
  { key: "reference_ingestion.memory", eventTypes: ["reference_ingestion.progress", "job.stage"] },
  { key: "reference_ingestion.ao_start", eventTypes: ["reference_ingestion.progress", "job.stage"] },
  { key: "reference_ingestion.terminology", eventTypes: ["reference_ingestion.progress", "job.stage"] },
  { key: "reference_ingestion.story", eventTypes: ["reference_ingestion.progress", "job.stage"] },
  { key: "reference_ingestion.merge", eventTypes: ["reference_ingestion.progress", "job.stage"] },
  { key: "reference_ingestion.write", eventTypes: ["reference_ingestion.progress", "job.stage"] },
  { key: "reference_ingestion.completed", eventTypes: ["reference_ingestion.completed"] },
];

function workflowStageDefinitions(job: GuiJob | null): WorkflowStageDefinition[] {
  if (job?.type === "reference_extraction") {
    return [{ key: "reference_extraction", eventTypes: ["reference_extraction.completed", "job.stage"] }];
  }
  if (job?.type === "reference_ingestion") {
    return REFERENCE_INGESTION_STAGE_DEFS;
  }
  if (job?.type === "translation_knowledge_commit") {
    return [{ key: "knowledge_build", eventTypes: ["knowledge.completed", "knowledge.failed", "job.stage"] }];
  }
  if (job?.type === "translation_deep_audit") {
    return [{ key: "deep_audit", eventTypes: ["deep_audit.window.completed", "job.stage", "job.completed"] }];
  }
  return TRANSLATION_WORKFLOW_STAGE_DEFS;
}

function eventMatchesStage(event: GuiJobEvent, definition: WorkflowStageDefinition): boolean {
  if (!definition.eventTypes.includes(event.type)) return false;
  if (event.type !== "reference_ingestion.progress" && event.type !== "job.stage") return true;
  const payload = asRecord(event.payload);
  return payload?.stage === definition.key;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function humanizeIdentifier(value: string): string {
  if (!value) {
    return "";
  }
  const withSpaces = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim();
  return titleCase(withSpaces);
}

function formatEngineLabel(engine: string | null | undefined): string | null {
  if (!engine) {
    return null;
  }
  return ENGINE_LABELS[engine] ?? humanizeIdentifier(engine);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function extractLatestEventPayload(events: GuiJobEvent[], type: string): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== type) {
      continue;
    }
    return asRecord(event.payload);
  }
  return null;
}

function resolveCurrentWorkflowStage(
  job: { stage?: string; status?: string } | null,
  events: GuiJobEvent[],
  definitions: WorkflowStageDefinition[]
): WorkflowStageKey | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "job.stage") {
      continue;
    }
    const payload = asRecord(event.payload);
    if (!payload || typeof payload.stage !== "string") {
      continue;
    }
    const stage = payload.stage;
    if (definitions.some((entry) => entry.key === stage)) {
      return stage as WorkflowStageKey;
    }
  }

  if (job?.stage && definitions.some((entry) => entry.key === job.stage)) {
    return job.stage as WorkflowStageKey;
  }

  return null;
}

function extractProgressSnapshot(event: GuiJobEvent): ProgressSnapshot | null {
  if (event.type !== "pipeline.progress") {
    return null;
  }
  const payload = asRecord(event.payload);
  if (!payload) {
    return null;
  }

  return {
    engine: typeof payload.engine === "string" ? payload.engine : null,
    pageIndex: typeof payload.currentPageIndex === "number" ? payload.currentPageIndex : null,
    totalPages: typeof payload.totalPages === "number" ? payload.totalPages : null,
    status: typeof payload.status === "string" ? payload.status : null,
  };
}

function formatProgressTimelineLabel(snapshot: ProgressSnapshot): string | null {
  const engineLabel = formatEngineLabel(snapshot.engine);
  const pageLabel =
    typeof snapshot.pageIndex === "number"
      ? typeof snapshot.totalPages === "number"
        ? `第 ${snapshot.pageIndex} / ${snapshot.totalPages} 頁`
        : `第 ${snapshot.pageIndex} 頁`
      : null;

  if (snapshot.status && TERMINAL_PIPELINE_STATUSES.has(snapshot.status)) {
    if (snapshot.status === "completed") {
      return "Pipeline 已完成";
    }
    if (snapshot.status === "failed") {
      return "Pipeline 失敗";
    }
    return "Pipeline 已取消";
  }

  if (engineLabel && pageLabel) {
    return `Pipeline 進入 ${engineLabel}，${pageLabel}`;
  }
  if (engineLabel) {
    return `Pipeline 進入 ${engineLabel}`;
  }
  if (pageLabel) {
    return `Pipeline 推進到 ${pageLabel}`;
  }

  return null;
}

function formatReferenceIngestionProgress(
  payload: Record<string, unknown> | null,
  t: TranslateFn
): string {
  const stage = typeof payload?.stage === "string" ? payload.stage : "reference_ingestion";
  const stageKey = `jobDetail.workflow.${stage}`;
  const parts = [t(stageKey)];
  if (typeof payload?.percent === "number") {
    parts.push(t("jobDetail.progress.percent", { percent: payload.percent }));
  }
  if (typeof payload?.batch === "number" && typeof payload?.batches === "number") {
    parts.push(t("jobDetail.progress.batch", { current: payload.batch, total: payload.batches }));
  }
  if (typeof payload?.processedNodes === "number" && typeof payload?.totalNodes === "number") {
    parts.push(t("jobDetail.progress.nodes", {
      completed: payload.processedNodes,
      total: payload.totalNodes,
    }));
  }
  if (typeof payload?.elapsedMs === "number") {
    parts.push(t("jobDetail.progress.waitingAo", {
      seconds: Math.max(0, Math.round(payload.elapsedMs / 1000)),
    }));
  }
  if (typeof payload?.reason === "string" && payload.reason.trim()) {
    parts.push(t("jobDetail.progress.reason", { reason: payload.reason }));
  }
  return parts.join(" · ");
}

function formatTimelineEventLabel(event: GuiJobEvent, t: TranslateFn): string {
  const payload = asRecord(event.payload);

  if (event.type === "reference_ingestion.progress") {
    return formatReferenceIngestionProgress(payload, t);
  }

  if (event.type === "job.stage") {
    const stage = typeof payload?.stage === "string" ? payload.stage : null;
    const status = typeof payload?.status === "string" ? payload.status : null;
    if (stage && status) {
      return `${humanizeIdentifier(stage)} - ${humanizeIdentifier(status)}`;
    }
    if (stage) {
      return humanizeIdentifier(stage);
    }
  }

  const exactLabels: Record<string, string> = {
    "job.created": "工作已建立",
    "setup.completed": "專案建立完成",
    "pipeline.completed": "Pipeline 已完成",
    "quality.completed": "品質驗證完成",
    "knowledge.completed": "本地風格更新完成",
    "export.completed": "匯出完成",
    "project.closed": "專案已關閉",
    "job.completed": "工作已完成",
    "job.failed": "工作失敗",
    "job.canceled": "工作已取消",
    "reference_ingestion.completed": "參考資料風格資產已更新",
    "reference_extraction.completed": "參考資料抽取完成",
    "source_preflight.resolved": "來源預檢完成",
    "translation_context.built": "翻譯風格上下文已建立",
  };

  return exactLabels[event.type] ?? humanizeIdentifier(event.type);
}

function projectTimelineEvents(events: GuiJobEvent[], t: TranslateFn): TimelineItem[] {
  const items: TimelineItem[] = [];
  let lastProgressSnapshot: ProgressSnapshot | null = null;

  for (const event of events) {
    const when = event.createdAt ?? "live";

    if (event.type !== "pipeline.progress") {
      items.push({
        kind: "event",
        label: formatTimelineEventLabel(event, t),
        when,
        sourceEventType: event.type,
      });
      continue;
    }

    const snapshot = extractProgressSnapshot(event);
    if (!snapshot) {
      continue;
    }

    const engineChanged = snapshot.engine !== lastProgressSnapshot?.engine;
    const pageChanged = snapshot.pageIndex !== lastProgressSnapshot?.pageIndex;
    const terminalChanged =
      Boolean(snapshot.status && TERMINAL_PIPELINE_STATUSES.has(snapshot.status)) &&
      snapshot.status !== lastProgressSnapshot?.status;

    if (!engineChanged && !pageChanged && !terminalChanged) {
      continue;
    }

    const label = formatProgressTimelineLabel(snapshot);
    if (!label) {
      lastProgressSnapshot = snapshot;
      continue;
    }

    items.push({
      kind: "progress",
      label,
      when,
      sourceEventType: event.type,
      engine: snapshot.engine,
      pageIndex: snapshot.pageIndex,
      totalPages: snapshot.totalPages,
    });
    lastProgressSnapshot = snapshot;
  }

  return items;
}

function getEngineOrder(job: { result?: unknown } | null): string[] {
  const result = asRecord(job?.result);
  const engines = asRecord(result?.engines);
  const preferredOrder = [
    "detect",
    "fontDetect",
    "segment",
    "bubbleSegment",
    "ocr",
    "translate",
    "clean",
    "render",
  ];

  if (!engines) {
    return preferredOrder;
  }

  const available = preferredOrder.filter((key) => Boolean(engines[key]));
  return available.length > 0 ? available : preferredOrder;
}

function liveConnectionLabel(
  state: "idle" | "connecting" | "live" | "reconnecting" | "closed",
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  switch (state) {
    case "connecting":
      return t("jobDetail.connection.connecting");
    case "live":
      return t("jobDetail.connection.live");
    case "reconnecting":
      return t("jobDetail.connection.reconnecting");
    case "closed":
      return t("jobDetail.connection.closed");
    case "idle":
    default:
      return t("jobDetail.connection.idle");
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
    case "idle":
    default:
      return "neutral";
  }
}

function isTerminalJobStatus(status: string | null | undefined) {
  return status === "succeeded" || status === "failed" || status === "canceled" || status === "waiting_user_review";
}

function collapseEvents(events: GuiJobEvent[]) {
  const collapsed: Array<{
    signature: string;
    event: GuiJobEvent;
    count: number;
    firstSeen: string;
    lastSeen: string;
  }> = [];

  for (const event of events) {
    const signature = eventSignature(event);
    const seenAt = event.createdAt ?? "live";
    const previous = collapsed[collapsed.length - 1];

    if (previous && previous.signature === signature) {
      previous.count += 1;
      previous.lastSeen = seenAt;
      continue;
    }

    collapsed.push({
      signature,
      event,
      count: 1,
      firstSeen: seenAt,
      lastSeen: seenAt,
    });
  }

  return collapsed;
}

function mergeUniqueEvents(baseEvents: GuiJobEvent[], incomingEvents: GuiJobEvent[]) {
  const seen = new Set(baseEvents.map((event) => eventSignature(event)));
  const merged = [...baseEvents];

  for (const event of incomingEvents) {
    const signature = eventSignature(event);
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    merged.push(event);
  }

  return merged;
}

function SafeInteractionPanel({
  jobId,
  events,
}: {
  jobId: string;
  events: GuiJobEvent[];
}) {
  const { locale, t } = useLanguageStore();
  const [sourceFilter, setSourceFilter] = useState<"all" | "backend" | "koharu" | "agent" | "llm">("all");
  const [directionFilter, setDirectionFilter] = useState<"all" | "request" | "response" | "internal" | "error">("all");
  const [autoFollow, setAutoFollow] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lastEventCountRef = useRef(events.length);

  useEffect(() => {
    setAutoFollow(true);
    setUnreadCount(0);
    lastEventCountRef.current = events.length;
  }, [events.length, jobId]);

  useEffect(() => {
    if (events.length > lastEventCountRef.current && !autoFollow) {
      setUnreadCount((count) => count + (events.length - lastEventCountRef.current));
    }
    lastEventCountRef.current = events.length;
  }, [autoFollow, events.length]);

  useEffect(() => {
    if (!autoFollow || !viewportRef.current) {
      return;
    }
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    setUnreadCount(0);
  }, [autoFollow, events, viewportRef]);

  const visibleEvents = useMemo(() => {
    return events.filter((event) => {
      const source = event.type.startsWith("pipeline.")
        ? "koharu"
        : event.type.startsWith("llm.")
          ? "llm"
          : event.type.startsWith("quality.") || event.type.startsWith("knowledge.")
            ? "agent"
            : "backend";
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : null;
      const direction =
        payload && typeof payload.error === "string"
          ? "error"
          : event.type.endsWith(".requested") || event.type.endsWith(".started") || event.type === "job.created"
            ? "request"
            : event.type.endsWith(".completed") || event.type.endsWith(".failed") || event.type.endsWith(".cancel_requested")
              ? "response"
              : "internal";

      return (sourceFilter === "all" || sourceFilter === source) &&
        (directionFilter === "all" || directionFilter === direction);
    });
  }, [directionFilter, events, sourceFilter]);

  return (
    <article className="card interaction-card">
      <div className="interaction-header">
        <div>
          <h3>{t("jobDetail.liveInteraction.title")}</h3>
          <p className="muted-text">
            {autoFollow ? t("jobDetail.liveInteraction.following") : t("jobDetail.liveInteraction.paused", { count: unreadCount })}
          </p>
        </div>
        {!autoFollow ? (
          <button
            className="primary-button"
            onClick={() => {
              setAutoFollow(true);
              setUnreadCount(0);
            }}
            type="button"
          >
            {t("jobDetail.liveInteraction.jumpLatest")}
          </button>
        ) : null}
      </div>

      <div className="filter-row">
        {(["all", "backend", "koharu", "agent", "llm"] as const).map((filter) => (
          <button
            key={filter}
            className={sourceFilter === filter ? "secondary-button active-filter" : "secondary-button"}
            onClick={() => setSourceFilter(filter)}
            type="button"
          >
            {translateLiteral(locale, filter)}
          </button>
        ))}
      </div>

      <div className="filter-row">
        {(["all", "request", "response", "internal", "error"] as const).map((filter) => (
          <button
            key={filter}
            className={directionFilter === filter ? "secondary-button active-filter" : "secondary-button"}
            onClick={() => setDirectionFilter(filter)}
            type="button"
          >
            {translateLiteral(locale, filter)}
          </button>
        ))}
      </div>

      <div
        className="interaction-viewport"
        onScroll={(event) => {
          const target = event.currentTarget;
          const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
          setAutoFollow(nearBottom);
          if (nearBottom) {
            setUnreadCount(0);
          }
        }}
        ref={(node) => {
          viewportRef.current = node;
        }}
      >
        {visibleEvents.map((event, index) => (
          <div className="event-row" key={`${event.id ?? "stream"}-${event.createdAt ?? "live"}-${index}`}>
            <div className="event-meta">
              <strong>{event.type}</strong>
              <span>{event.createdAt ? formatSystemDateTime(event.createdAt) : t("interaction.live")}</span>
            </div>
            <pre>{JSON.stringify(event.payload, null, 2)}</pre>
          </div>
        ))}
      </div>
    </article>
  );
}

export function JobDetailPage() {
  const { t } = useLanguageStore();
  return (
    <section className="page">
      <h1>{t("jobDetail.title")}</h1>
      <JobDetailContent embedded={false} />
    </section>
  );
}

export function JobDetailContent({ embedded }: { embedded: boolean }) {
  const queryClient = useQueryClient();
  const { t } = useLanguageStore();
  const selectedJobId = useUiStore((state) => state.selectedJobId);
  const setSelectedJobId = useUiStore((state) => state.setSelectedJobId);
  const setSelectedPage = useUiStore((state) => state.setSelectedPage);
  const setSelectedMangaId = useUiStore((state) => state.setSelectedMangaId);
  const setSelectedTranslatorId = useUiStore((state) => state.setSelectedTranslatorId);
  const runtimeJob = useSelectedJobRuntimeStore((state) => state.job);
  const runtimeEvents = useSelectedJobRuntimeStore((state) => state.rawEvents);
  const runtimeArtifacts = useSelectedJobRuntimeStore((state) => state.artifacts);
  const connectionState = useSelectedJobRuntimeStore((state) => state.connectionState);
  const lastEventAt = useSelectedJobRuntimeStore((state) => state.lastEventAt);
  const resetForJob = useSelectedJobRuntimeStore((state) => state.resetForJob);
  const hydrateJob = useSelectedJobRuntimeStore((state) => state.hydrateJob);
  const hydrateEvents = useSelectedJobRuntimeStore((state) => state.hydrateEvents);
  const hydrateArtifacts = useSelectedJobRuntimeStore((state) => state.hydrateArtifacts);
  const appendEvent = useSelectedJobRuntimeStore((state) => state.appendEvent);
  const setConnectionState = useSelectedJobRuntimeStore((state) => state.setConnectionState);
  const [activeTab, setActiveTab] = useState<"preflight" | "artifacts" | "reference" | "events">("preflight");
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const jobQuery = useQuery({
    queryKey: ["job", selectedJobId],
    queryFn: () => getJob(selectedJobId as string),
    enabled: Boolean(selectedJobId),
  });

  const eventsQuery = useQuery({
    queryKey: ["job-events", selectedJobId],
    queryFn: () => getJobEvents(selectedJobId as string),
    enabled: Boolean(selectedJobId),
  });

  const artifactsQuery = useQuery({
    queryKey: ["job-artifacts", selectedJobId],
    queryFn: () => getJobArtifacts(selectedJobId as string),
    enabled: Boolean(selectedJobId),
  });
  const refetchJob = jobQuery.refetch;
  const refetchArtifacts = artifactsQuery.refetch;
  const deepAuditMutation = useMutation({
    mutationFn: (jobId: string) => createTranslationDeepAuditJob(jobId),
    onSuccess: (job) => setSelectedJobId(job.id),
  });
  const qualityRepairMutation = useMutation({
    mutationFn: (jobId: string) => createQualityRepairJob(jobId),
    onSuccess: (job) => setSelectedJobId(job.id),
  });

  const timeline = useMemo(() => {
    return projectTimelineEvents(runtimeEvents, t);
  }, [runtimeEvents, t]);

  const collapsedEvents = useMemo(() => {
    return collapseEvents(runtimeEvents);
  }, [runtimeEvents]);

  const preflightArtifacts = useMemo(() => {
    return runtimeArtifacts.filter((artifact) =>
      ["source_preflight_manifest", "reference_scene", "reference_texts"].includes(artifact.kind)
    );
  }, [runtimeArtifacts]);

  const preflightManifestArtifact = useMemo(() => {
    return runtimeArtifacts.find((artifact) => artifact.kind === "source_preflight_manifest") ?? null;
  }, [runtimeArtifacts]);

  const sourcePreflightSnapshot = useMemo(() => {
    const eventPayload = extractLatestEventPayload(runtimeEvents, "source_preflight.resolved");
    if (eventPayload) {
      return eventPayload;
    }
    const sourcePreflight = asRecord(runtimeJob?.result)?.sourcePreflight;
    if (sourcePreflight) {
      return sourcePreflight;
    }
    const metadata =
      preflightManifestArtifact?.metadata && typeof preflightManifestArtifact.metadata === "object"
        ? (preflightManifestArtifact.metadata as Record<string, unknown>)
        : null;
    return metadata;
  }, [preflightManifestArtifact, runtimeEvents, runtimeJob?.result]);

  const workflowSummary = useMemo(() => {
    const definitions = workflowStageDefinitions(runtimeJob);
    const currentStage = resolveCurrentWorkflowStage(runtimeJob, runtimeEvents, definitions);
    const currentStageIndex = currentStage
      ? definitions.findIndex((entry) => entry.key === currentStage)
      : -1;

    return definitions.map((entry, index) => {
      const matched = runtimeEvents.filter((event) => eventMatchesStage(event, entry));
      const latest = matched[matched.length - 1];
      const stageFailed = runtimeJob?.status === "failed" && currentStage === entry.key;
      const stageCanceled = runtimeJob?.status === "canceled" && currentStage === entry.key;
      const stageSkipped = entry.optionalWhen?.(runtimeJob ?? null) ?? false;

      let status = "waiting";
      if (stageFailed) {
        status = "failed";
      } else if (stageCanceled) {
        status = "canceled";
      } else if (stageSkipped) {
        status = "skipped";
      } else if (currentStage === entry.key && !["succeeded", "failed", "canceled"].includes(runtimeJob?.status ?? "")) {
        status = "running";
      } else if (latest) {
        status = entry.key === "source_preflight" ? "observed" : "completed";
      } else if (runtimeJob?.status === "succeeded") {
        status = "completed";
      } else if (currentStageIndex > index) {
        status = "observed";
      }

      return {
        stage: entry.key,
        status,
        updatedAt: latest?.createdAt ?? null,
      };
    });
  }, [runtimeEvents, runtimeJob]);

  const latestPipelineProgress = useMemo(() => {
    const events = runtimeEvents;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === "pipeline.progress" && event.payload && typeof event.payload === "object") {
        return event.payload as Record<string, unknown>;
      }
    }
    return null;
  }, [runtimeEvents]);

  const pipelineEngines = useMemo(() => {
    const engineKeys = getEngineOrder(runtimeJob);
    const currentEngine =
      latestPipelineProgress && typeof latestPipelineProgress.engine === "string"
        ? latestPipelineProgress.engine
        : runtimeJob?.status === "succeeded"
          ? engineKeys[engineKeys.length - 1] ?? "render"
          : null;
    const terminal = runtimeJob?.status === "succeeded";

    return engineKeys.map((engine) => ({
      engine,
      status: currentEngine
        ? currentEngine === engine
          ? typeof latestPipelineProgress?.engineStatus === "string"
            ? terminal && latestPipelineProgress.engineStatus === "running"
              ? "completed"
              : latestPipelineProgress.engineStatus
            : "running"
          : terminal
            ? "completed"
            : "waiting"
        : "unknown",
    }));
  }, [runtimeJob, runtimeJob?.status, latestPipelineProgress]);

  const pageProgress = useMemo(() => {
    const engineKeys = getEngineOrder(runtimeJob);
    const preflightSnapshot = asRecord(sourcePreflightSnapshot);
    const pipelineResult = asRecord(asRecord(asRecord(runtimeJob?.result)?.pipeline)?.summary);
    const artifactMetadata =
      preflightManifestArtifact?.metadata && typeof preflightManifestArtifact.metadata === "object"
        ? (preflightManifestArtifact.metadata as Record<string, unknown>)
        : null;
    const totalPages =
      typeof latestPipelineProgress?.totalPages === "number"
        ? latestPipelineProgress.totalPages
        : typeof preflightSnapshot?.acceptedCount === "number"
          ? preflightSnapshot.acceptedCount
          : typeof preflightSnapshot?.acceptedCount === "string"
            ? Number(preflightSnapshot.acceptedCount)
              : typeof pipelineResult?.totalPages === "number"
                ? Number(pipelineResult.totalPages)
                : artifactMetadata && typeof artifactMetadata.acceptedCount !== "undefined"
                  ? Number(artifactMetadata.acceptedCount)
                  : null;
    const progress =
      latestPipelineProgress && typeof latestPipelineProgress.progress === "number"
        ? latestPipelineProgress.progress
        : null;
    const completedPages =
      latestPipelineProgress && typeof latestPipelineProgress.completedPages === "number"
        ? latestPipelineProgress.completedPages
        : typeof progress === "number" && typeof totalPages === "number"
          ? Math.max(0, Math.min(totalPages, Math.round(totalPages * progress)))
          : null;
    const terminalSucceeded = runtimeJob?.status === "succeeded";
    const finalCurrentPageIndex =
      latestPipelineProgress && typeof latestPipelineProgress.currentPageIndex === "number"
        ? latestPipelineProgress.currentPageIndex
        : terminalSucceeded && typeof totalPages === "number"
          ? totalPages
          : null;
    const finalCompletedPages =
      typeof completedPages === "number"
        ? completedPages
        : terminalSucceeded && typeof totalPages === "number"
          ? totalPages
          : null;
    const finalCurrentEngine =
      latestPipelineProgress && typeof latestPipelineProgress.engine === "string"
        ? latestPipelineProgress.engine
        : terminalSucceeded
          ? engineKeys[engineKeys.length - 1] ?? "render"
          : null;

    return {
      totalPages,
      completedPages: finalCompletedPages,
      currentPageIndex: finalCurrentPageIndex,
      currentPageName:
        latestPipelineProgress && typeof latestPipelineProgress.currentPageName === "string"
          ? latestPipelineProgress.currentPageName
          : null,
      currentEngine: finalCurrentEngine,
    };
  }, [latestPipelineProgress, preflightManifestArtifact, runtimeJob, sourcePreflightSnapshot]);

  const notices = useMemo(() => {
    const next = [] as Array<{
      level: "error" | "warning" | "info";
      title: string;
      message: string;
    }>;

    if (runtimeJob?.error) {
      next.push({
        level: "error",
        title: t("jobDetail.notice.jobError"),
        message: runtimeJob.error,
      });
    }

      const mode = runtimeJob?.payload?.translationMode;
      const qualityEnabled = mode === "learning_style" ||
        (["reference_style", "local_style"].includes(String(mode)) && runtimeJob?.payload?.qualityCheck === true);
      const knowledgeEnabled = mode === "learning_style" || mode === "local_style";

      if (!qualityEnabled) {
        next.push({
          level: "info",
          title: t("jobDetail.notice.qualitySkipped"),
          message: t("jobDetail.notice.qualitySkippedMessage"),
        });
      }

      if (!knowledgeEnabled) {
        next.push({
          level: "info",
          title: t("jobDetail.notice.localStyleSkipped"),
          message: t("jobDetail.notice.localStyleSkippedMessage"),
        });
      }

    if (!latestPipelineProgress) {
      next.push({
        level: "warning",
        title: t("jobDetail.notice.limitedPipeline"),
        message: t("jobDetail.notice.limitedPipelineMessage"),
      });
    }

    return next;
  }, [runtimeJob?.error, runtimeJob?.payload?.qualityCheck, runtimeJob?.payload?.translationMode, latestPipelineProgress, t]);

  useEffect(() => {
    const payloadMangaId = runtimeJob?.payload?.mangaId;
    if (typeof payloadMangaId === "string" && payloadMangaId.trim()) {
      setSelectedMangaId(payloadMangaId);
    }
    const payloadTranslatorId = runtimeJob?.payload?.translatorId;
    if (typeof payloadTranslatorId === "string" && payloadTranslatorId.trim()) {
      setSelectedTranslatorId(payloadTranslatorId);
    }
  }, [runtimeJob?.payload, setSelectedMangaId, setSelectedTranslatorId]);

  useEffect(() => {
    resetForJob(selectedJobId);
  }, [resetForJob, selectedJobId]);

  useEffect(() => {
    if (jobQuery.data) {
      hydrateJob(jobQuery.data);
    }
  }, [hydrateJob, jobQuery.data]);

  useEffect(() => {
    if (eventsQuery.data?.events) {
      hydrateEvents(eventsQuery.data.events);
    }
  }, [eventsQuery.data, hydrateEvents]);

  useEffect(() => {
    if (artifactsQuery.data?.artifacts) {
      hydrateArtifacts(artifactsQuery.data.artifacts);
    }
  }, [artifactsQuery.data, hydrateArtifacts]);

  const displayJob = runtimeJob ?? jobQuery.data ?? null;
  const effectiveConnectionState =
    displayJob && isTerminalJobStatus(displayJob.status) ? "closed" : connectionState;

  useEffect(() => {
    if (!selectedJobId || isTerminalJobStatus(runtimeJob?.status ?? jobQuery.data?.status)) {
      if (isTerminalJobStatus(runtimeJob?.status ?? jobQuery.data?.status)) {
        setConnectionState("closed");
      }
      return;
    }

    setConnectionState("connecting");
    const unsubscribe = subscribeToJobStream(selectedJobId, {
      onOpen: () => {
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        setConnectionState("live");
      },
      onError: () => {
        if (reconnectTimerRef.current) {
          return;
        }
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          setConnectionState("reconnecting");
        }, RECONNECTING_NOTICE_DELAY_MS);
      },
      onEvent: (event) => {
        appendEvent(event);

        if (event.job && typeof event.job === "object") {
          const nextJob = event.job as GuiJob;
          hydrateJob(nextJob);
          queryClient.setQueryData<GuiJob>(["job", selectedJobId], (current) => ({
            ...current,
            ...nextJob,
            events: nextJob.events || current?.events || [],
            artifacts: nextJob.artifacts || current?.artifacts || [],
            children: nextJob.children ?? current?.children,
          }));
          queryClient.setQueryData<{ jobs: GuiJob[] }>(["jobs"], (current) => {
            if (!current) return current;
            return {
              jobs: current.jobs.map((job) => job.id === nextJob.id ? { ...job, ...nextJob } : job),
            };
          });
        }

        if (
          [
            "reference_ingestion.completed",
            "quality.completed",
            "knowledge.completed",
            "export.completed",
            "job.completed",
            "job.failed",
            "job.canceled",
            "project.closed",
          ].includes(event.type)
        ) {
          void refetchJob();
          void refetchArtifacts();
        }

        if (event.type === "job.stage" || event.type === "job.completed" || event.type === "job.failed" || event.type === "job.canceled") {
          void refetchJob();
        }
      },
    });

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      unsubscribe();
      setConnectionState("closed");
    };
  }, [appendEvent, hydrateJob, queryClient, refetchArtifacts, refetchJob, runtimeJob?.status, selectedJobId, setConnectionState]);

  const translationModeView = useMemo(() => {
    const mode = displayJob?.payload?.translationMode;
    if (mode === "learning_style") {
      return {
        label: t("jobDetail.translationMode.learningStyle.label"),
        description: t("jobDetail.translationMode.learningStyle.description"),
      };
    }
    if (mode === "reference_style") {
      return {
        label: t("jobDetail.translationMode.referenceStyle.label"),
        description: t("jobDetail.translationMode.referenceStyle.description"),
      };
    }
    if (mode === "local_style") {
      return {
        label: t("jobDetail.translationMode.localStyle.label"),
        description: t("jobDetail.translationMode.localStyle.description"),
      };
    }
    return {
      label: t("jobDetail.translationMode.quick.label"),
      description: t("jobDetail.translationMode.quick.description"),
    };
  }, [displayJob?.payload, t]);

  const translationMemorySummary = useMemo(
    () => extractLatestEventPayload(runtimeEvents, "translation_memory.built"),
    [runtimeEvents]
  );
  const qualitySummary = useMemo(
    () => extractLatestEventPayload(runtimeEvents, "quality.completed"),
    [runtimeEvents]
  );
  const qualityContextSummary = useMemo(
    () => extractLatestEventPayload(runtimeEvents, "quality.context_built"),
    [runtimeEvents]
  );
  const displayedQualitySummary = qualitySummary || qualityContextSummary;
  const qualitySemanticCoverage = asRecord(displayedQualitySummary?.semanticCoverage);
  const qualityRevisionCount = Array.isArray(qualitySummary?.optimizedTranslations)
    ? qualitySummary.optimizedTranslations.length
    : 0;
  const learningEvidenceSummary = useMemo(
    () => extractLatestEventPayload(runtimeEvents, "learning_evidence.persisted"),
    [runtimeEvents]
  );
  const knowledgeSummary = useMemo(
    () => extractLatestEventPayload(runtimeEvents, "knowledge.completed"),
    [runtimeEvents]
  );
  const knowledgeChild = useMemo(
    () => displayJob?.children?.find((child) => child.type === "translation_knowledge_commit") || null,
    [displayJob?.children]
  );

  const translateJobStatus = (value: string | null | undefined) => {
    if (!value) {
      return t("jobDetail.status.notReported");
    }
    const key = `jobDetail.status.${value}`;
    const translated = t(key);
    return translated === key ? humanizeIdentifier(value) : translated;
  };

  const translateWorkflowStage = (value: string) => {
    const key = `jobDetail.workflow.${value}`;
    const translated = t(key);
    return translated === key ? resolveJobStageLabel(value, t) : translated;
  };

  if (!selectedJobId) {
    return (
      <article className={embedded ? "card" : "page"}>
        {embedded ? <h2>{t("jobDetail.selectedTitle")}</h2> : null}
        <p>{t("jobDetail.empty")}</p>
      </article>
    );
  }

  return (
    <>
      {jobQuery.isLoading && <p>{t("jobDetail.loading")}</p>}
      {jobQuery.isError && <p>{t("jobDetail.loadFailed")}</p>}
      {!jobQuery.isLoading && !jobQuery.isError && displayJob && (
        <div className="detail-layout">
          {embedded ? (
            <article className="card">
              <h2>{t("jobDetail.selectedTitle")}</h2>
              <p className="muted-text">{t("jobDetail.selectedDescription")}</p>
            </article>
          ) : null}
          <article className="card">
            <h2>{t("jobDetail.summary.title")}</h2>
            <div className="overview-card-grid">
              <div className="overview-card">
                <span className="overview-card-label">{t("jobDetail.summary.status")}</span>
                <strong className="overview-card-value">{translateJobStatus(displayJob.status)}</strong>
                <span className={`pill pill-${statusTone(displayJob.status)}`}>{translateWorkflowStage(displayJob.stage)}</span>
              </div>
              <div className="overview-card">
                <span className="overview-card-label">{t("jobDetail.summary.jobType")}</span>
                <strong className="overview-card-value">{displayJob.type}</strong>
                <span className="job-subtext">{displayJob.id}</span>
              </div>
              {displayJob.type === "translation" ? (
                <div className="overview-card">
                  <span className="overview-card-label">{t("jobDetail.summary.translationMode")}</span>
                  <strong className="overview-card-value">{translationModeView.label}</strong>
                  <span className="job-subtext">{translationModeView.description}</span>
                </div>
              ) : null}
              <div className="overview-card">
                <span className="overview-card-label">{t("jobDetail.summary.created")}</span>
                <strong className="overview-card-value">{formatSystemDateTime(displayJob.createdAt)}</strong>
                <span className="job-subtext">{t("jobDetail.summary.updated", { value: formatSystemDateTime(displayJob.updatedAt) })}</span>
              </div>
              <div className="overview-card">
                <span className="overview-card-label">{t("jobDetail.summary.liveSync")}</span>
                <span className={`live-connection-badge live-connection-badge-${liveConnectionTone(effectiveConnectionState)}`}>
                  {liveConnectionLabel(effectiveConnectionState, t)}
                </span>
                <span className="job-subtext">
                  {displayJob && isTerminalJobStatus(displayJob.status)
                    ? t("jobDetail.summary.completedLive")
                    : lastEventAt
                      ? t("jobDetail.summary.lastEvent", { value: formatSystemDateTime(lastEventAt) })
                      : t("jobDetail.summary.waitingEvents")}
                </span>
              </div>
            </div>
            <div className="summary-grid">
              <div><strong>{t("jobDetail.summary.jobId")}</strong><span>{displayJob.id}</span></div>
              <div><strong>{t("jobDetail.summary.manga")}</strong><span>{formatValue(displayJob.payload.mangaLabel ?? displayJob.payload.mangaId)}</span></div>
              <div><strong>{t("jobDetail.summary.translator")}</strong><span>{formatValue(displayJob.payload.translatorLabel ?? displayJob.payload.translatorId ?? displayJob.payload.translator)}</span></div>
              <div><strong>{t("jobDetail.summary.chapter")}</strong><span>{formatValue(displayJob.payload.chapterTitle ?? displayJob.payload.chapterLabel ?? displayJob.payload.chapterId)}</span></div>
              {displayJob.type === "translation_knowledge_commit" ? (
                <div><strong>{t("jobDetail.summary.sourceTranslationJob")}</strong><span>{formatValue(displayJob.payload.sourceTranslationJobId)}</span></div>
              ) : displayJob.type === "translation" || displayJob.type === "post_edit_export" ? (
                <div><strong>{t("jobDetail.summary.outputFolder")}</strong><span>{formatValue(displayJob.payload.outputFolder)}</span></div>
              ) : (
                <div><strong>{t("jobDetail.summary.referenceSet")}</strong><span>{formatValue(displayJob.payload.referenceSetId)}</span></div>
              )}
            </div>
            {displayJob.type === "translation" && ["succeeded", "waiting_user_review"].includes(displayJob.status) ? (
              <div className="button-row">
                <button className="secondary-button" type="button" onClick={() => setSelectedPage("post-edit")}>
                  {t("jobDetail.summary.openPostEdit")}
                </button>
              </div>
            ) : null}
          </article>

          {displayJob.type === "translation" ? (
            <article className="card">
              <h2>{t("jobDetail.translationMemory.title")}</h2>
              <div className="summary-grid">
                <div>
                  <strong>{t("jobDetail.translationMemory.fingerprint")}</strong>
                  <span>{formatValue(translationMemorySummary?.fingerprint)}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.translationMemory.terminology")}</strong>
                  <span>{formatValue(asRecord(translationMemorySummary?.usage)?.glossaryEntries)}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.translationMemory.story")}</strong>
                  <span>{formatValue(asRecord(translationMemorySummary?.usage)?.storyCharacters)}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.translationMemory.style")}</strong>
                  <span>{formatValue(asRecord(translationMemorySummary?.usage)?.styleChapters)}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.translationMemory.qualityChanges")}</strong>
                  <span>{formatValue(qualityRevisionCount)}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.quality.coverage")}</strong>
                  <span>{formatValue(displayedQualitySummary?.candidateCount)} / {formatValue(displayedQualitySummary?.totalTranslations)}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.quality.windows")}</strong>
                  <span>{formatValue(displayedQualitySummary?.windowCount)}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.quality.reasons")}</strong>
                  <span>{formatValue(displayedQualitySummary?.candidateReasonCounts)}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.quality.inputBytes")}</strong>
                  <span>{formatValue(displayedQualitySummary?.inputBytes)}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.quality.elapsed")}</strong>
                  <span>{formatValue(displayedQualitySummary?.elapsedMs)}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.quality.semanticCoverage")}</strong>
                  <span>{t("jobDetail.quality.semanticCoverageValue", {
                    annotated: Number(qualitySemanticCoverage?.annotated || 0),
                    total: Number(qualitySemanticCoverage?.total || 0),
                    ratio: Math.round(Number(qualitySemanticCoverage?.ratio || 0) * 100),
                  })}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.translationMemory.knowledge")}</strong>
                  <span>{knowledgeChild ? translateJobStatus(knowledgeChild.status) : t("jobDetail.translationMemory.notScheduled")}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.knowledge.evidence")}</strong>
                  <span>{formatValue(learningEvidenceSummary?.total)}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.knowledge.confidenceUpdates")}</strong>
                  <span>{formatValue(knowledgeSummary?.confidenceUpdates ?? asRecord(knowledgeChild?.result)?.confidenceUpdates)}</span>
                </div>
                <div>
                  <strong>{t("jobDetail.knowledge.semanticRoles")}</strong>
                  <span>{formatValue(learningEvidenceSummary?.semanticRoles)}</span>
                </div>
              </div>
              {displayJob.status === "succeeded" ? (
                <div className="button-row">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={deepAuditMutation.isPending}
                    onClick={() => deepAuditMutation.mutate(displayJob.id)}
                  >
                    {deepAuditMutation.isPending ? t("jobDetail.deepAudit.starting") : t("jobDetail.deepAudit.start")}
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={qualityRepairMutation.isPending}
                    onClick={() => qualityRepairMutation.mutate(displayJob.id)}
                  >
                    {qualityRepairMutation.isPending ? t("jobDetail.qualityRepair.starting") : t("jobDetail.qualityRepair.start")}
                  </button>
                </div>
              ) : null}
            </article>
          ) : null}

          {["translation", "translation_quality_repair", "translation_deep_audit"].includes(displayJob.type) ? (
            <QualityReviewPane job={displayJob} onFinalizeCreated={(job) => setSelectedJobId(job.id)} />
          ) : null}

          {displayJob.type === "translation_deep_audit" ? (
            <article className="card">
              <h2>{t("jobDetail.deepAudit.title")}</h2>
              <div className="summary-grid">
                <div><strong>{t("jobDetail.deepAudit.windows")}</strong><span>{formatValue(asRecord(displayJob.result)?.windowCount)}</span></div>
                <div><strong>{t("jobDetail.deepAudit.reused")}</strong><span>{formatValue(asRecord(displayJob.result)?.reusedWindows)}</span></div>
                <div><strong>{t("jobDetail.deepAudit.findings")}</strong><span>{formatValue(Array.isArray(asRecord(displayJob.result)?.findings) ? (asRecord(displayJob.result)?.findings as unknown[]).length : 0)}</span></div>
                <div><strong>{t("jobDetail.deepAudit.proposals")}</strong><span>{formatValue(Array.isArray(asRecord(displayJob.result)?.proposedTranslations) ? (asRecord(displayJob.result)?.proposedTranslations as unknown[]).length : 0)}</span></div>
              </div>
              {displayJob.status === "succeeded" && typeof displayJob.payload.sourceTranslationJobId === "string" ? (
                <div className="button-row">
                  <button className="secondary-button" type="button" onClick={() => {
                    setSelectedJobId(displayJob.payload.sourceTranslationJobId as string);
                    setSelectedPage("post-edit");
                  }}>
                    {t("jobDetail.deepAudit.openPostEdit")}
                  </button>
                </div>
              ) : null}
            </article>
          ) : null}

          <article className="card">
            <h2>{t("jobDetail.workflow.title")}</h2>
            <div className="workflow-card-grid">
              {workflowSummary.map((entry) => (
                <div key={entry.stage} className={`workflow-card workflow-card-${statusTone(entry.status)}`}>
                  <span className="workflow-card-label">{translateWorkflowStage(entry.stage)}</span>
                  <strong className="workflow-card-status">{translateJobStatus(entry.status)}</strong>
                  {entry.updatedAt ? <span className="job-subtext">{formatSystemDateTime(entry.updatedAt)}</span> : null}
                </div>
              ))}
            </div>
          </article>

          {displayJob.type === "translation" ? <article className="card">
            <h2>{t("jobDetail.pipeline.title")}</h2>
            <div className="engine-card-grid">
              {pipelineEngines.map((entry) => (
                <div key={entry.engine} className={`engine-card engine-card-${statusTone(entry.status)}`}>
                  <span className="engine-card-label">{formatEngineLabel(entry.engine) ?? entry.engine}</span>
                  <strong className="engine-card-status">{translateJobStatus(entry.status)}</strong>
                </div>
              ))}
            </div>
            {!latestPipelineProgress ? (
              <p className="muted-text">{t("jobDetail.pipeline.pending")}</p>
            ) : null}
          </article> : null}

          {displayJob.type === "translation" ? <article className="card">
            <h2>{t("jobDetail.pageProgress.title")}</h2>
            <div className="page-progress-hero">
              <div className="page-progress-main">
                <span className="overview-card-label">{t("jobDetail.pageProgress.completed")}</span>
                <strong className="page-progress-value">
                  {typeof pageProgress.completedPages === "number" && typeof pageProgress.totalPages === "number"
                    ? `${pageProgress.completedPages} / ${pageProgress.totalPages}`
                    : typeof pageProgress.totalPages === "number"
                      ? `0 / ${pageProgress.totalPages}`
                      : t("jobDetail.status.notReported")}
                </strong>
              </div>
              <div className="page-progress-side">
                <div className="page-progress-item">
                  <span className="overview-card-label">{t("jobDetail.pageProgress.currentEngine")}</span>
                  <strong>{formatEngineLabel(pageProgress.currentEngine) ?? t("jobDetail.status.notReported")}</strong>
                </div>
                <div className="page-progress-item">
                  <span className="overview-card-label">{t("jobDetail.pageProgress.currentPage")}</span>
                  <strong>{pageProgress.currentPageName ?? t("jobDetail.status.notReported")}</strong>
                </div>
                <div className="page-progress-item">
                  <span className="overview-card-label">{t("jobDetail.pageProgress.pageIndex")}</span>
                  <strong>{pageProgress.currentPageIndex ?? t("jobDetail.status.notReported")}</strong>
                </div>
              </div>
            </div>
          </article> : null}

          <article className="card">
            <h2>{t("jobDetail.warnings.title")}</h2>
            {notices.length === 0 ? (
              <p className="muted-text">{t("jobDetail.warnings.none")}</p>
            ) : (
              <div className="notice-card-stack">
                {notices.map((notice, index) => (
                  <div key={`${notice.title}-${index}`} className={`notice-card notice-card-${notice.level}`}>
                    <strong>{notice.title}</strong>
                    <p>{notice.message}</p>
                  </div>
                ))}
              </div>
            )}
          </article>

          <article className="card">
            <h2>{t("jobDetail.timeline.title")}</h2>
            {timeline.length === 0 ? (
              <p>{t("jobDetail.timeline.empty")}</p>
            ) : (
              <ul className="timeline-list">
                {timeline.map((entry, index) => (
                  <li
                    key={`${entry.sourceEventType}-${entry.when}-${entry.label}-${index}`}
                    className={`timeline-item ${entry.kind === "progress" ? "timeline-item-progress" : ""}`}
                  >
                    <strong>{entry.label}</strong>
                    <span>{entry.when === "live" ? t("interaction.live") : formatSystemDateTime(entry.when)}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="card">
            <h2>{t("jobDetail.result.title")}</h2>
            {displayJob.error ? (
              <p className="error-text">{displayJob.error}</p>
            ) : (
              <pre>{JSON.stringify(displayJob.result, null, 2)}</pre>
            )}
          </article>

          <article className="card">
            <div className="detail-tab-bar">
              <button
                className={activeTab === "preflight" ? "nav-button active" : "nav-button"}
                onClick={() => setActiveTab("preflight")}
                type="button"
              >
                {t("jobDetail.tabs.preflight")}
              </button>
              <button
                className={activeTab === "artifacts" ? "nav-button active" : "nav-button"}
                onClick={() => setActiveTab("artifacts")}
                type="button"
              >
                {t("jobDetail.tabs.artifacts")}
              </button>
                <button
                  className={activeTab === "reference" ? "nav-button active" : "nav-button"}
                  onClick={() => setActiveTab("reference")}
                  type="button"
                >
                  {t("jobDetail.tabs.reference")}
                </button>
              <button
                className={activeTab === "events" ? "nav-button active" : "nav-button"}
                onClick={() => setActiveTab("events")}
                type="button"
              >
                {t("jobDetail.tabs.events")}
              </button>
            </div>

            {activeTab === "preflight" ? (
              <div className="detail-tab-panel">
                <div className="summary-grid">
                  <div>
                    <strong>{t("jobDetail.preflight.sourceFolder")}</strong>
                    <span>{formatValue(displayJob.payload.sourceFolder)}</span>
                  </div>
                  <div>
                    <strong>{t("jobDetail.preflight.sourcePreflight")}</strong>
                    <span>{formatValue(displayJob.payload.sourcePreflightId)}</span>
                  </div>
                </div>
                {artifactsQuery.isLoading && <p>{t("jobDetail.preflight.loadingArtifacts")}</p>}
                {preflightArtifacts.length === 0 && !artifactsQuery.isLoading ? (
                  <p>{t("jobDetail.preflight.emptyArtifacts")}</p>
                ) : (
                  <ul className="artifact-list">
                    {preflightArtifacts.map((artifact) => (
                      <li key={artifact.id} className="artifact-item">
                        <div>
                          <strong>{artifact.kind}</strong>
                          <div className="job-subtext">{artifact.path}</div>
                          <div className="job-subtext">{formatValue(artifact.metadata)}</div>
                        </div>
                        <button
                          className="secondary-button"
                          onClick={() => openDesktopPath(artifact.path)}
                          type="button"
                        >
                          {t("jobDetail.preflight.open")}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            {activeTab === "artifacts" ? (
              <div className="detail-tab-panel">
                <ArtifactsContent embedded />
              </div>
            ) : null}

            {activeTab === "reference" ? (
              <div className="detail-tab-panel">
              <div className="summary-grid">
                  <div>
                    <strong>{t("jobDetail.summary.translationMode")}</strong>
                    <span>{translationModeView.label}</span>
                  </div>
                  <div>
                    <strong>{t("jobDetail.translationMemory.fingerprint")}</strong>
                    <span>{formatValue(translationMemorySummary?.fingerprint)}</span>
                  </div>
                  <div>
                    <strong>{t("jobDetail.reference.referenceGlossaryStrategy")}</strong>
                    <span>{formatValue(displayJob.payload.glossaryMode ?? displayJob.payload.terminologyLibraryId)}</span>
                  </div>
                  <div>
                    <strong>{t("jobDetail.reference.qualityValidation")}</strong>
                    <span>{
                      displayJob.payload.translationMode === "learning_style" ||
                      (["reference_style", "local_style"].includes(String(displayJob.payload.translationMode)) && displayJob.payload.qualityCheck === true)
                        ? t("jobDetail.reference.enabled")
                        : t("jobDetail.reference.disabled")
                    }</span>
                  </div>
                  <div>
                    <strong>{t("jobDetail.reference.localStyleUpdate")}</strong>
                    <span>{["learning_style", "local_style"].includes(String(displayJob.payload.translationMode)) ? t("jobDetail.reference.enabled") : t("jobDetail.reference.disabled")}</span>
                  </div>
                </div>
                <p className="muted-text">
                  {translationModeView.description} {t("jobDetail.reference.description")}
                </p>
              </div>
            ) : null}

            {activeTab === "events" ? (
              <div className="detail-tab-panel">
                <SafeInteractionPanel
                  jobId={selectedJobId}
                  events={runtimeEvents}
                />
                {eventsQuery.isLoading && runtimeEvents.length === 0 && <p>{t("jobDetail.events.loading")}</p>}
                {eventsQuery.isError && <p>{t("jobDetail.events.loadFailed")}</p>}
                {!eventsQuery.isLoading && collapsedEvents.length === 0 && <p>{t("jobDetail.timeline.empty")}</p>}
                {collapsedEvents.length > 0 && (
                  <div className="event-stack">
                    {collapsedEvents.map((entry, index) => (
                      <div className="event-row" key={`${entry.signature}-${entry.lastSeen}-${index}`}>
                        <div className="event-meta">
                          <strong>
                            {entry.event.type}
                            {entry.count > 1 ? ` x${entry.count}` : ""}
                          </strong>
                          <span>{entry.lastSeen === "live" ? t("interaction.live") : formatSystemDateTime(entry.lastSeen)}</span>
                        </div>
                        {entry.count > 1 ? (
                          <p className="muted-text">
                            {t("jobDetail.events.collapsed", {
                              from: entry.firstSeen === "live" ? t("interaction.live") : formatSystemDateTime(entry.firstSeen),
                              to: entry.lastSeen === "live" ? t("interaction.live") : formatSystemDateTime(entry.lastSeen),
                            })}
                          </p>
                        ) : null}
                        <pre>{JSON.stringify(entry.event.payload, null, 2)}</pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </article>
        </div>
      )}
    </>
  );
}
