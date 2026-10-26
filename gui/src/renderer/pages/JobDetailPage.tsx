import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createQualityRepairJob,
  createTranslationDeepAuditJob,
  createTranslationKnowledgeRetryJob,
  getJob,
  getJobArtifacts,
  getJobEvents,
  resumeJob,
  type GuiArtifact,
  type GuiJob,
  type GuiJobEvent,
} from "../api/jobs";
import { ArtifactsContent } from "./ArtifactsPage";
import { translateLiteral } from "../i18n/messages";
import { downloadJobArtifact, openDesktopPath } from "../services/desktop_api";
import { subscribeToJobStream } from "../stream/job_stream";
import { useLanguageStore } from "../stores/language_store";
import {
  type StreamConnectionState,
  useSelectedJobRuntimeStore,
} from "../stores/selected_job_runtime_store";
import { useUiStore } from "../stores/ui_store";
import { formatSystemDateTime } from "../features/shared/formatters/date_time";
import { resolveJobStageLabel } from "../features/jobs/viewmodels/job_list_viewmodel";
import { DeepAuditReviewPane } from "../features/jobs/components/DeepAuditReviewPane";
import { JobFailurePanel } from "../features/jobs/components/JobFailurePanel";
import { PipelineMetricsCard } from "../features/jobs/components/PipelineMetricsCard";

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
  {
    key: "monitor_pipeline",
    eventTypes: ["pipeline.progress", "pipeline.completed"],
  },
  {
    key: "quality_review",
    eventTypes: ["quality.completed"],
    optionalWhen: (job) =>
      job?.payload?.translationMode === "quick" ||
      (["reference_style", "local_style"].includes(String(job?.payload?.translationMode)) &&
        job?.payload?.qualityCheck !== true),
  },
  {
    key: "translation_snapshot",
    eventTypes: ["translation_snapshot.persisted"],
  },
  { key: "export", eventTypes: ["export.completed"] },
  { key: "close_project", eventTypes: ["project.closed"] },
];

const REFERENCE_INGESTION_STAGE_DEFS: WorkflowStageDefinition[] = [
  {
    key: "reference_ingestion.memory",
    eventTypes: ["reference_ingestion.progress", "job.stage"],
  },
  {
    key: "reference_ingestion.ao_start",
    eventTypes: ["reference_ingestion.progress", "job.stage"],
  },
  {
    key: "reference_ingestion.terminology",
    eventTypes: ["reference_ingestion.progress", "job.stage"],
  },
  {
    key: "reference_ingestion.story",
    eventTypes: ["reference_ingestion.progress", "job.stage"],
  },
  {
    key: "reference_ingestion.merge",
    eventTypes: ["reference_ingestion.progress", "job.stage"],
  },
  {
    key: "reference_ingestion.write",
    eventTypes: ["reference_ingestion.progress", "job.stage"],
  },
  {
    key: "reference_ingestion.completed",
    eventTypes: ["reference_ingestion.completed"],
  },
];

function workflowStageDefinitions(job: GuiJob | null): WorkflowStageDefinition[] {
  if (job?.type === "reference_extraction") {
    return [
      {
        key: "reference_extraction",
        eventTypes: ["reference_extraction.completed", "job.stage"],
      },
    ];
  }
  if (job?.type === "reference_ingestion") {
    return REFERENCE_INGESTION_STAGE_DEFS;
  }
  if (job?.type === "translation_knowledge_commit") {
    return [
      {
        key: "knowledge_build",
        eventTypes: ["knowledge.completed", "knowledge.failed", "job.stage"],
      },
    ];
  }
  if (job?.type === "translation_deep_audit") {
    return [
      {
        key: "deep_audit",
        eventTypes: ["deep_audit.window.completed", "job.stage", "job.completed"],
      },
    ];
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
  definitions: WorkflowStageDefinition[],
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

function appendReferenceBatchProgress(parts: string[], payload: Record<string, unknown>, t: TranslateFn) {
  if (typeof payload.batch === "number" && typeof payload.batches === "number") {
    parts.push(t("jobDetail.progress.batch", { current: payload.batch, total: payload.batches }));
  }
  if (typeof payload.processedNodes === "number" && typeof payload.totalNodes === "number") {
    parts.push(t("jobDetail.progress.nodes", { completed: payload.processedNodes, total: payload.totalNodes }));
  }
}

function appendReferenceWaitProgress(parts: string[], payload: Record<string, unknown>, t: TranslateFn) {
  if (typeof payload.elapsedMs === "number") {
    parts.push(t("jobDetail.progress.waitingAo", { seconds: Math.max(0, Math.round(payload.elapsedMs / 1000)) }));
  }
  if (typeof payload.reason === "string" && payload.reason.trim()) {
    parts.push(t("jobDetail.progress.reason", { reason: payload.reason }));
  }
}

function formatReferenceIngestionProgress(payload: Record<string, unknown> | null, t: TranslateFn): string {
  const stage = typeof payload?.stage === "string" ? payload.stage : "reference_ingestion";
  const stageKey = `jobDetail.workflow.${stage}`;
  const parts = [t(stageKey)];
  if (typeof payload?.percent === "number") {
    parts.push(t("jobDetail.progress.percent", { percent: payload.percent }));
  }
  if (payload) appendReferenceBatchProgress(parts, payload, t);
  if (payload) appendReferenceWaitProgress(parts, payload, t);
  return parts.join(" · ");
}

const EXACT_TIMELINE_LABELS: Record<string, string> = {
  "job.created": "工作已建立", "setup.completed": "專案建立完成",
  "pipeline.completed": "Pipeline 已完成", "quality.completed": "品質驗證完成",
  "knowledge.completed": "本地風格更新完成", "export.completed": "匯出完成",
  "project.closed": "專案已關閉", "job.completed": "工作已完成",
  "job.failed": "工作失敗", "job.canceled": "工作已取消",
  "reference_ingestion.completed": "參考資料風格資產已更新",
  "reference_extraction.completed": "參考資料抽取完成",
  "source_preflight.resolved": "來源預檢完成", "translation_context.built": "翻譯風格上下文已建立",
};

function formatTimelineEventLabel(event: GuiJobEvent, t: TranslateFn): string {
  const payload = asRecord(event.payload);
  if (event.type === "pipeline.metrics") return t("jobDetail.timeline.pipelineMetrics");
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
  return EXACT_TIMELINE_LABELS[event.type] ?? humanizeIdentifier(event.type);
}

function progressSnapshotChanged(current: ProgressSnapshot, previous: ProgressSnapshot | null) {
  const terminalChanged = Boolean(current.status && TERMINAL_PIPELINE_STATUSES.has(current.status))
    && current.status !== previous?.status;
  return current.engine !== previous?.engine || current.pageIndex !== previous?.pageIndex || terminalChanged;
}

function timelineProgressItem(event: GuiJobEvent, snapshot: ProgressSnapshot): TimelineItem | null {
  const label = formatProgressTimelineLabel(snapshot);
  return label ? {
    kind: "progress", label, when: event.createdAt ?? "live", sourceEventType: event.type,
    engine: snapshot.engine, pageIndex: snapshot.pageIndex, totalPages: snapshot.totalPages,
  } : null;
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
    if (!progressSnapshotChanged(snapshot, lastProgressSnapshot)) continue;
    const item = timelineProgressItem(event, snapshot);
    if (item) items.push(item);
    lastProgressSnapshot = snapshot;
  }
  return items;
}

function getEngineOrder(job: { result?: unknown } | null): string[] {
  const result = asRecord(job?.result);
  const engines = asRecord(result?.engines);
  const preferredOrder = ["detect", "fontDetect", "segment", "bubbleSegment", "ocr", "translate", "clean", "render"];

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
  return status === "succeeded" || status === "failed" || status === "canceled";
}

type CollapsedEvent = {
  signature: string;
  event: GuiJobEvent;
  count: number;
  firstSeen: string;
  lastSeen: string;
};

function collapseEvents(events: GuiJobEvent[]) {
  const collapsed: CollapsedEvent[] = [];
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

type InteractionSourceFilter = "all" | "backend" | "koharu" | "agent" | "llm";
type InteractionDirectionFilter = "all" | "request" | "response" | "internal" | "error";
type InteractionLocale = Parameters<typeof translateLiteral>[0];

function interactionEventSource(event: GuiJobEvent): Exclude<InteractionSourceFilter, "all"> {
  if (event.type.startsWith("pipeline.")) return "koharu";
  if (event.type.startsWith("llm.")) return "llm";
  if (event.type.startsWith("quality.") || event.type.startsWith("knowledge.")) return "agent";
  return "backend";
}

function interactionEventDirection(event: GuiJobEvent): Exclude<InteractionDirectionFilter, "all"> {
  const payload = event.payload && typeof event.payload === "object"
    ? event.payload as Record<string, unknown> : null;
  if (payload && typeof payload.error === "string") return "error";
  if (event.type.endsWith(".requested") || event.type.endsWith(".started") || event.type === "job.created") {
    return "request";
  }
  if (event.type.endsWith(".completed") || event.type.endsWith(".failed") || event.type.endsWith(".cancel_requested")) {
    return "response";
  }
  return "internal";
}

function useInteractionReset(jobId: string, eventCount: number, state: {
  setAutoFollow: (value: boolean) => void;
  setUnreadCount: (value: number) => void;
  lastEventCountRef: MutableRefObject<number>;
}) {
  useEffect(() => {
    state.setAutoFollow(true);
    state.setUnreadCount(0);
    state.lastEventCountRef.current = eventCount;
  }, [eventCount, jobId]);
}

function useInteractionUnread(
  eventCount: number,
  autoFollow: boolean,
  setUnreadCount: Dispatch<SetStateAction<number>>,
  lastEventCountRef: MutableRefObject<number>,
) {
  useEffect(() => {
    if (eventCount > lastEventCountRef.current && !autoFollow) {
      setUnreadCount((count) => count + (eventCount - lastEventCountRef.current));
    }
    lastEventCountRef.current = eventCount;
  }, [autoFollow, eventCount]);
}

function useInteractionAutoScroll(
  autoFollow: boolean,
  events: GuiJobEvent[],
  viewportRef: MutableRefObject<HTMLDivElement | null>,
  setUnreadCount: (value: number) => void,
) {
  useEffect(() => {
    if (!autoFollow || !viewportRef.current) return;
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    setUnreadCount(0);
  }, [autoFollow, events, viewportRef]);
}

function useSafeInteractionPanel(jobId: string, events: GuiJobEvent[]) {
  const { locale, t } = useLanguageStore();
  const [sourceFilter, setSourceFilter] = useState<InteractionSourceFilter>("all");
  const [directionFilter, setDirectionFilter] = useState<InteractionDirectionFilter>("all");
  const [autoFollow, setAutoFollow] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lastEventCountRef = useRef(events.length);
  useInteractionReset(jobId, events.length, { setAutoFollow, setUnreadCount, lastEventCountRef });
  useInteractionUnread(events.length, autoFollow, setUnreadCount, lastEventCountRef);
  useInteractionAutoScroll(autoFollow, events, viewportRef, setUnreadCount);
  const visibleEvents = useMemo(() => events.filter((event) =>
    (sourceFilter === "all" || sourceFilter === interactionEventSource(event))
    && (directionFilter === "all" || directionFilter === interactionEventDirection(event))),
  [directionFilter, events, sourceFilter]);
  return { locale, t, sourceFilter, setSourceFilter, directionFilter, setDirectionFilter,
    autoFollow, setAutoFollow, unreadCount, setUnreadCount, viewportRef, visibleEvents };
}

type SafeInteractionState = ReturnType<typeof useSafeInteractionPanel>;

function InteractionPanelHeader(state: SafeInteractionState) {
  return (
    <div className="interaction-header">
      <div>
        <h3>{state.t("jobDetail.liveInteraction.title")}</h3>
        <p className="muted-text">
          {state.autoFollow ? state.t("jobDetail.liveInteraction.following")
            : state.t("jobDetail.liveInteraction.paused", { count: state.unreadCount })}
        </p>
      </div>
      {!state.autoFollow ? (
        <button className="primary-button" onClick={() => {
          state.setAutoFollow(true);
          state.setUnreadCount(0);
        }} type="button">{state.t("jobDetail.liveInteraction.jumpLatest")}</button>
      ) : null}
    </div>
  );
}

function InteractionFilterRow<T extends string>({ options, selected, onSelect, locale }: {
  options: readonly T[]; selected: T; onSelect: (value: T) => void; locale: InteractionLocale;
}) {
  return (
    <div className="filter-row">
      {options.map((filter) => (
        <button key={filter} className={selected === filter ? "secondary-button active-filter" : "secondary-button"}
          onClick={() => onSelect(filter)} type="button">
          {translateLiteral(locale, filter)}
        </button>
      ))}
    </div>
  );
}

function InteractionEventRow({ event, index, state }: {
  event: GuiJobEvent; index: number; state: SafeInteractionState;
}) {
  return (
    <div className="event-row" key={`${event.id ?? "stream"}-${event.createdAt ?? "live"}-${index}`}>
      <div className="event-meta">
        <strong>{event.type}</strong>
        <span>{event.createdAt ? formatSystemDateTime(event.createdAt) : state.t("interaction.live")}</span>
      </div>
      <pre>{JSON.stringify(event.payload, null, 2)}</pre>
    </div>
  );
}

function updateInteractionScroll(state: SafeInteractionState, target: HTMLDivElement) {
  const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
  state.setAutoFollow(nearBottom);
  if (nearBottom) state.setUnreadCount(0);
}

function InteractionEventViewport(state: SafeInteractionState) {
  return (
    <div className="interaction-viewport"
      onScroll={(event) => updateInteractionScroll(state, event.currentTarget)}
      ref={(node) => { state.viewportRef.current = node; }}>
      {state.visibleEvents.map((event, index) => (
        <InteractionEventRow event={event} index={index} state={state}
          key={`${event.id ?? "stream"}-${event.createdAt ?? "live"}-${index}`} />
      ))}
    </div>
  );
}

function SafeInteractionPanel({ jobId, events }: { jobId: string; events: GuiJobEvent[] }) {
  const state = useSafeInteractionPanel(jobId, events);
  return (
    <article className="card interaction-card">
      <InteractionPanelHeader {...state} />
      <InteractionFilterRow options={["all", "backend", "koharu", "agent", "llm"] as const}
        selected={state.sourceFilter} onSelect={state.setSourceFilter} locale={state.locale} />
      <InteractionFilterRow options={["all", "request", "response", "internal", "error"] as const}
        selected={state.directionFilter} onSelect={state.setDirectionFilter} locale={state.locale} />
      <InteractionEventViewport {...state} />
    </article>
  );
}

type WorkflowSummaryEntry = { stage: string; status: string; updatedAt: string | null };
type JobNotice = { level: "error" | "warning" | "info"; title: string; message: string };
type PipelineProgress = Record<string, unknown> | null;
type JobStreamEvent = GuiJobEvent & { job?: unknown };

function resolveWorkflowStageStatus(
  job: GuiJob | null,
  definition: WorkflowStageDefinition,
  currentStage: string | null,
  currentStageIndex: number,
  definitionIndex: number,
  hasEvent: boolean,
): string {
  if (job?.status === "failed" && currentStage === definition.key) return "failed";
  if (job?.status === "canceled" && currentStage === definition.key) return "canceled";
  if (definition.optionalWhen?.(job) ?? false) return "skipped";
  const terminal = ["succeeded", "failed", "canceled"].includes(job?.status ?? "");
  if (currentStage === definition.key && !terminal) return "running";
  if (hasEvent) return definition.key === "source_preflight" ? "observed" : "completed";
  if (job?.status === "succeeded") return "completed";
  return currentStageIndex > definitionIndex ? "observed" : "waiting";
}

function buildWorkflowSummary(job: GuiJob | null, events: GuiJobEvent[]): WorkflowSummaryEntry[] {
  const definitions = workflowStageDefinitions(job);
  const currentStage = resolveCurrentWorkflowStage(job, events, definitions);
  const currentIndex = currentStage ? definitions.findIndex((entry) => entry.key === currentStage) : -1;
  return definitions.map((definition, index) => {
    const matched = events.filter((event) => eventMatchesStage(event, definition));
    const latest = matched[matched.length - 1];
    return {
      stage: definition.key,
      status: resolveWorkflowStageStatus(job, definition, currentStage, currentIndex, index, Boolean(latest)),
      updatedAt: latest?.createdAt ?? null,
    };
  });
}

function findLatestPipelineProgress(events: GuiJobEvent[]): PipelineProgress {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "pipeline.progress") return asRecord(event.payload);
  }
  return null;
}

function resolvePipelineEngineStatus(
  engine: string,
  currentEngine: string | null,
  progress: PipelineProgress,
  terminal: boolean,
): string {
  if (!currentEngine) return "unknown";
  if (currentEngine !== engine) return terminal ? "completed" : "waiting";
  if (typeof progress?.engineStatus !== "string") return "running";
  return terminal && progress.engineStatus === "running" ? "completed" : progress.engineStatus;
}

function buildPipelineEngines(job: GuiJob | null, progress: PipelineProgress) {
  const engineKeys = getEngineOrder(job);
  const terminal = job?.status === "succeeded";
  const currentEngine =
    terminal
      ? (engineKeys[engineKeys.length - 1] ?? "render")
      : typeof progress?.engine === "string"
        ? progress.engine
        : null;
  return engineKeys.map((engine) => ({
    engine,
    status: resolvePipelineEngineStatus(engine, currentEngine, progress, terminal),
  }));
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function resolveTotalPages(
  progress: PipelineProgress,
  preflight: Record<string, unknown> | null,
  job: GuiJob | null,
  artifactMetadata: Record<string, unknown> | null,
): number | null {
  const pipelineSummary = asRecord(asRecord(asRecord(job?.result)?.pipeline)?.summary);
  return firstNumber(
    progress?.totalPages,
    preflight?.acceptedCount,
    pipelineSummary?.totalPages,
    artifactMetadata?.acceptedCount,
  );
}

function resolveCompletedPages(progress: PipelineProgress, totalPages: number | null): number | null {
  if (typeof progress?.completedPages === "number") return progress.completedPages;
  if (typeof progress?.progress !== "number" || totalPages === null) return null;
  return Math.max(0, Math.min(totalPages, Math.round(totalPages * progress.progress)));
}

function finalSourcePageName(sourcePreflight: unknown, totalPages: number | null) {
  const images = asRecord(sourcePreflight)?.images;
  if (!Array.isArray(images) || totalPages === null) return null;
  const image = asRecord(images[totalPages - 1]);
  return typeof image?.orderedName === "string" ? image.orderedName : null;
}

function buildPageProgress(
  job: GuiJob | null,
  progress: PipelineProgress,
  sourcePreflight: unknown,
  artifactMetadata: unknown,
) {
  const totalPages = resolveTotalPages(progress, asRecord(sourcePreflight), job, asRecord(artifactMetadata));
  const terminal = job?.status === "succeeded";
  const completedPages = terminal ? totalPages : resolveCompletedPages(progress, totalPages);
  const engineKeys = getEngineOrder(job);
  return {
    totalPages,
    completedPages,
    currentPageIndex: terminal ? totalPages : firstNumber(progress?.currentPageIndex),
    currentPageName: terminal
      ? finalSourcePageName(sourcePreflight, totalPages)
      : typeof progress?.currentPageName === "string" ? progress.currentPageName : null,
    currentEngine:
      terminal
        ? (engineKeys[engineKeys.length - 1] ?? "render")
        : typeof progress?.engine === "string" ? progress.engine : null,
  };
}

function buildFailureNotice(job: GuiJob | null, t: TranslateFn): JobNotice | null {
  if (!job?.error) return null;
  const source = job.diagnostics?.failureSource || "unknown";
  const failureType = job.diagnostics?.resourceFailureType || "unknown";
  const stage = job.diagnostics?.failureStage || job.stage;
  return {
    level: "error",
    title: t("jobDetail.notice.jobError"),
    message: t("jobDetail.failure.notice", {
      source: t(`jobDetail.failure.source.${source}`),
      stage: resolveJobStageLabel(stage, t),
      type: t(`jobList.resourceFailure.${failureType}`),
    }),
  };
}

function buildConfigurationNotices(job: GuiJob | null, t: TranslateFn): JobNotice[] {
  const notices: JobNotice[] = [];
  const mode = job?.payload?.translationMode;
  const qualityEnabled =
    mode === "learning_style" ||
    (["reference_style", "local_style"].includes(String(mode)) && job?.payload?.qualityCheck === true);
  const knowledgeEnabled = mode === "learning_style" || mode === "local_style";
  if (!qualityEnabled) {
    notices.push({
      level: "info",
      title: t("jobDetail.notice.qualitySkipped"),
      message: t("jobDetail.notice.qualitySkippedMessage"),
    });
  }
  if (!knowledgeEnabled) {
    notices.push({
      level: "info",
      title: t("jobDetail.notice.localStyleSkipped"),
      message: t("jobDetail.notice.localStyleSkippedMessage"),
    });
  }
  return notices;
}

function buildJobNotices(job: GuiJob | null, progress: PipelineProgress, t: TranslateFn): JobNotice[] {
  const failure = buildFailureNotice(job, t);
  const notices = [...(failure ? [failure] : []), ...buildConfigurationNotices(job, t)];
  if (!progress) {
    notices.push({
      level: "warning",
      title: t("jobDetail.notice.limitedPipeline"),
      message: t("jobDetail.notice.limitedPipelineMessage"),
    });
  }
  return notices;
}

const ARTIFACT_REFRESH_EVENTS = new Set([
  "reference_ingestion.completed", "quality.completed", "knowledge.completed", "export.completed",
  "job.completed", "job.failed", "job.canceled", "project.closed",
]);
const JOB_REFRESH_EVENTS = new Set(["job.stage", "job.completed", "job.failed", "job.canceled"]);

function mergeStreamJob(queryClient: QueryClient, selectedJobId: string, nextJob: GuiJob) {
  queryClient.setQueryData<GuiJob>(["job", selectedJobId], (current) => ({
    ...current,
    ...nextJob,
    events: nextJob.events || current?.events || [],
    artifacts: nextJob.artifacts || current?.artifacts || [],
    children: nextJob.children ?? current?.children,
  }));
  queryClient.setQueryData<{ jobs: GuiJob[] }>(["jobs"], (current) => {
    if (!current) return current;
    return { jobs: current.jobs.map((job) => (job.id === nextJob.id ? { ...job, ...nextJob } : job)) };
  });
}

type JobStreamContext = {
  queryClient: QueryClient;
  selectedJobId: string;
  appendEvent: (event: GuiJobEvent) => void;
  hydrateJob: (job: GuiJob) => void;
  refetchJob: () => unknown;
  refetchArtifacts: () => unknown;
};

function handleJobStreamEvent(event: JobStreamEvent, context: JobStreamContext) {
  context.appendEvent(event);
  if (event.job && typeof event.job === "object") {
    const nextJob = event.job as GuiJob;
    context.hydrateJob(nextJob);
    mergeStreamJob(context.queryClient, context.selectedJobId, nextJob);
  }
  if (ARTIFACT_REFRESH_EVENTS.has(event.type)) {
    void context.refetchJob();
    void context.refetchArtifacts();
  } else if (JOB_REFRESH_EVENTS.has(event.type)) {
    void context.refetchJob();
  }
}

function clearReconnectTimer(timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>) {
  if (!timerRef.current) return;
  clearTimeout(timerRef.current);
  timerRef.current = null;
}

function scheduleReconnectNotice(
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
  setConnectionState: (state: StreamConnectionState) => void,
) {
  if (timerRef.current) return;
  timerRef.current = setTimeout(() => {
    timerRef.current = null;
    setConnectionState("reconnecting");
  }, RECONNECTING_NOTICE_DELAY_MS);
}

function openJobStream(
  jobId: string,
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
  setConnectionState: (state: StreamConnectionState) => void,
  contextRef: MutableRefObject<Omit<JobStreamContext, "selectedJobId">>,
) {
  setConnectionState("connecting");
  return subscribeToJobStream(jobId, {
    onOpen: () => {
      clearReconnectTimer(timerRef);
      setConnectionState("live");
    },
    onError: () => scheduleReconnectNotice(timerRef, setConnectionState),
    onEvent: (event) => handleJobStreamEvent(event, { ...contextRef.current, selectedJobId: jobId }),
  });
}

function useSelectedJobStream(
  jobId: string | null,
  status: string | undefined,
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
  setConnectionState: (state: StreamConnectionState) => void,
  contextRef: MutableRefObject<Omit<JobStreamContext, "selectedJobId">>,
) {
  useEffect(() => {
    if (!jobId || isTerminalJobStatus(status)) {
      if (isTerminalJobStatus(status)) setConnectionState("closed");
      return;
    }
    const unsubscribe = openJobStream(jobId, timerRef, setConnectionState, contextRef);
    return () => {
      clearReconnectTimer(timerRef);
      unsubscribe();
      setConnectionState("closed");
    };
  }, [contextRef, jobId, setConnectionState, status, timerRef]);
}

function formatCollapsedEventTime(value: string, t: TranslateFn) {
  return value === "live" ? t("interaction.live") : formatSystemDateTime(value);
}

function CollapsedEventRow({ entry, index, t }: { entry: CollapsedEvent; index: number; t: TranslateFn }) {
  const range = t("jobDetail.events.collapsed", {
    from: formatCollapsedEventTime(entry.firstSeen, t),
    to: formatCollapsedEventTime(entry.lastSeen, t),
  });
  return (
    <div className="event-row" key={`${entry.signature}-${entry.lastSeen}-${index}`}>
      <div className="event-meta">
        <strong>{entry.event.type} {entry.count > 1 ? ` x${entry.count}` : ""}</strong>
        <span>{formatCollapsedEventTime(entry.lastSeen, t)}</span>
      </div>
      {entry.count > 1 ? <p className="muted-text">{range}</p> : null}
      <pre>{JSON.stringify(entry.event.payload, null, 2)}</pre>
    </div>
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

function WorkflowCard({ entries, t }: { entries: WorkflowSummaryEntry[]; t: TranslateFn }) {
  return (
    <article className="card">
      <h2>{t("jobDetail.workflow.title")}</h2>
      <div className="workflow-card-grid">
        {entries.map((entry) => (
          <div key={entry.stage} className={`workflow-card workflow-card-${statusTone(entry.status)}`}>
            <span className="workflow-card-label">{translateWorkflowStageValue(entry.stage, t)}</span>
            <strong className="workflow-card-status">{translateJobStatusValue(entry.status, t)}</strong>
            {entry.updatedAt ? <span className="job-subtext">{formatSystemDateTime(entry.updatedAt)}</span> : null}
          </div>
        ))}
      </div>
    </article>
  );
}

function PipelineCard({ engines, progress, t }: {
  engines: ReturnType<typeof buildPipelineEngines>; progress: PipelineProgress; t: TranslateFn;
}) {
  return (
    <article className="card">
      <h2>{t("jobDetail.pipeline.title")}</h2>
      <div className="engine-card-grid">
        {engines.map((entry) => (
          <div key={entry.engine} className={`engine-card engine-card-${statusTone(entry.status)}`}>
            <span className="engine-card-label">{formatEngineLabel(entry.engine) ?? entry.engine}</span>
            <strong className="engine-card-status">{translateJobStatusValue(entry.status, t)}</strong>
          </div>
        ))}
      </div>
      {!progress ? <p className="muted-text">{t("jobDetail.pipeline.pending")}</p> : null}
    </article>
  );
}

function completedPageLabel(progress: ReturnType<typeof buildPageProgress>, t: TranslateFn) {
  if (progress.completedPages !== null && progress.totalPages !== null) {
    return `${progress.completedPages} / ${progress.totalPages}`;
  }
  return progress.totalPages !== null ? `0 / ${progress.totalPages}` : t("jobDetail.status.notReported");
}

function PageProgressItem({ label, value }: { label: string; value: string | number }) {
  return <div className="page-progress-item"><span className="overview-card-label">{label}</span><strong>{value}</strong></div>;
}

function PageProgressCard({ progress, t }: { progress: ReturnType<typeof buildPageProgress>; t: TranslateFn }) {
  const missing = t("jobDetail.status.notReported");
  return (
    <article className="card">
      <h2>{t("jobDetail.pageProgress.title")}</h2>
      <div className="page-progress-hero">
        <div className="page-progress-main">
          <span className="overview-card-label">{t("jobDetail.pageProgress.completed")}</span>
          <strong className="page-progress-value">{completedPageLabel(progress, t)}</strong>
        </div>
        <div className="page-progress-side">
          <PageProgressItem label={t("jobDetail.pageProgress.currentEngine")} value={formatEngineLabel(progress.currentEngine) ?? missing} />
          <PageProgressItem label={t("jobDetail.pageProgress.currentPage")} value={progress.currentPageName ?? missing} />
          <PageProgressItem label={t("jobDetail.pageProgress.pageIndex")} value={progress.currentPageIndex ?? missing} />
        </div>
      </div>
    </article>
  );
}

function NoticesCard({ notices, t }: { notices: JobNotice[]; t: TranslateFn }) {
  return (
    <article className="card">
      <h2>{t("jobDetail.warnings.title")}</h2>
      {notices.length === 0 ? <p className="muted-text">{t("jobDetail.warnings.none")}</p> : (
        <div className="notice-card-stack">
          {notices.map((notice, index) => (
            <div key={`${notice.title}-${index}`} className={`notice-card notice-card-${notice.level}`}>
              <strong>{notice.title}</strong><p>{notice.message}</p>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function TimelineCard({ timeline, t }: { timeline: TimelineItem[]; t: TranslateFn }) {
  return (
    <article className="card">
      <h2>{t("jobDetail.timeline.title")}</h2>
      {timeline.length === 0 ? <p>{t("jobDetail.timeline.empty")}</p> : (
        <ul className="timeline-list">
          {timeline.map((entry, index) => (
            <li key={`${entry.sourceEventType}-${entry.when}-${entry.label}-${index}`}
              className={`timeline-item ${entry.kind === "progress" ? "timeline-item-progress" : ""}`}>
              <strong>{entry.label}</strong>
              <span>{formatCollapsedEventTime(entry.when, t)}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ResultCard({ job, t }: { job: GuiJob; t: TranslateFn }) {
  return (
    <article className="card">
      <h2>{t("jobDetail.result.title")}</h2>
      {job.error ? <JobFailurePanel job={job} t={t} /> : <pre>{JSON.stringify(job.result, null, 2)}</pre>}
    </article>
  );
}

function translateJobStatusValue(value: string | null | undefined, t: TranslateFn) {
  if (!value) return t("jobDetail.status.notReported");
  const key = `jobDetail.status.${value}`;
  const translated = t(key);
  return translated === key ? humanizeIdentifier(value) : translated;
}

function translateWorkflowStageValue(value: string, t: TranslateFn) {
  const key = `jobDetail.workflow.${value}`;
  const translated = t(key);
  return translated === key ? resolveJobStageLabel(value, t) : translated;
}

type DetailTab = "preflight" | "artifacts" | "reference" | "events";
type TranslationModeView = { label: string; description: string };

function DetailTabBar({ active, select, t }: {
  active: DetailTab; select: Dispatch<SetStateAction<DetailTab>>; t: TranslateFn;
}) {
  const tabs: DetailTab[] = ["preflight", "artifacts", "reference", "events"];
  return (
    <div className="detail-tab-bar">
      {tabs.map((tab) => (
        <button className={active === tab ? "nav-button active" : "nav-button"}
          onClick={() => select(tab)} type="button" key={tab}>
          {t(`jobDetail.tabs.${tab}`)}
        </button>
      ))}
    </div>
  );
}

async function openJobArtifact(jobId: string, artifactId: number) {
  const result = await downloadJobArtifact({ jobId, artifactId });
  return openDesktopPath(result.path);
}

function PreflightArtifactRow({ jobId, artifact, t }: { jobId: string; artifact: GuiArtifact; t: TranslateFn }) {
  return (
    <li className="artifact-item">
      <div><strong>{artifact.kind}</strong><div className="job-subtext">{artifact.fileName}</div>
        <div className="job-subtext">{formatValue(artifact.metadata)}</div></div>
      <button className="secondary-button" onClick={() => void openJobArtifact(jobId, artifact.id).catch(console.error)} type="button">
        {t("jobDetail.preflight.open")}
      </button>
    </li>
  );
}

function PreflightPanel({ job, artifacts, loading, t }: {
  job: GuiJob; artifacts: GuiArtifact[]; loading: boolean; t: TranslateFn;
}) {
  return (
    <div className="detail-tab-panel">
      <div className="summary-grid">
        <div><strong>{t("jobDetail.preflight.sourcePreflight")}</strong><span>{formatValue(job.payload.sourcePreflightId)}</span></div>
      </div>
      {loading ? <p>{t("jobDetail.preflight.loadingArtifacts")}</p> : null}
      {artifacts.length === 0 && !loading ? <p>{t("jobDetail.preflight.emptyArtifacts")}</p> : (
        <ul className="artifact-list">
          {artifacts.map((artifact) => <PreflightArtifactRow jobId={job.id} artifact={artifact} t={t} key={artifact.id} />)}
        </ul>
      )}
    </div>
  );
}

function referenceEnabled(job: GuiJob) {
  const mode = job.payload.translationMode;
  return mode === "learning_style" ||
    (["reference_style", "local_style"].includes(String(mode)) && job.payload.qualityCheck === true);
}

function ReferencePanel({ job, mode, target, memory, t }: {
  job: GuiJob; mode: TranslationModeView; target: string | null;
  memory: Record<string, unknown> | null; t: TranslateFn;
}) {
  const enabled = t("jobDetail.reference.enabled");
  const disabled = t("jobDetail.reference.disabled");
  return (
    <div className="detail-tab-panel">
      <div className="summary-grid">
        <div><strong>{t("jobDetail.summary.translationMode")}</strong><span>{mode.label}</span></div>
        <div><strong>{t("jobDetail.summary.translationTarget")}</strong><span>{formatValue(target)}</span></div>
        <div><strong>{t("jobDetail.translationMemory.fingerprint")}</strong><span>{formatValue(memory?.fingerprint)}</span></div>
        <div><strong>{t("jobDetail.reference.referenceGlossaryStrategy")}</strong>
          <span>{formatValue(job.payload.glossaryMode ?? job.payload.terminologyLibraryId)}</span></div>
        <div><strong>{t("jobDetail.reference.qualityValidation")}</strong>
          <span>{referenceEnabled(job) ? enabled : disabled}</span></div>
        <div><strong>{t("jobDetail.reference.localStyleUpdate")}</strong>
          <span>{["learning_style", "local_style"].includes(String(job.payload.translationMode)) ? enabled : disabled}</span></div>
      </div>
      <p className="muted-text">{mode.description} {t("jobDetail.reference.description")}</p>
    </div>
  );
}

function EventsPanel({ jobId, events, collapsed, loading, failed, t }: {
  jobId: string; events: GuiJobEvent[]; collapsed: CollapsedEvent[];
  loading: boolean; failed: boolean; t: TranslateFn;
}) {
  return (
    <div className="detail-tab-panel">
      <SafeInteractionPanel jobId={jobId} events={events} />
      {loading && events.length === 0 ? <p>{t("jobDetail.events.loading")}</p> : null}
      {failed ? <p>{t("jobDetail.events.loadFailed")}</p> : null}
      {!loading && collapsed.length === 0 ? <p>{t("jobDetail.timeline.empty")}</p> : null}
      {collapsed.length > 0 ? <div className="event-stack">
        {collapsed.map((entry, index) => <CollapsedEventRow entry={entry} index={index} t={t}
          key={`${entry.signature}-${entry.lastSeen}-${index}`} />)}
      </div> : null}
    </div>
  );
}

type DetailTabsProps = {
  active: DetailTab; select: Dispatch<SetStateAction<DetailTab>>; job: GuiJob; jobId: string;
  artifacts: GuiArtifact[]; artifactsLoading: boolean; events: GuiJobEvent[]; collapsed: CollapsedEvent[];
  eventsLoading: boolean; eventsFailed: boolean; mode: TranslationModeView; target: string | null;
  memory: Record<string, unknown> | null; t: TranslateFn;
};

function DetailTabs(props: DetailTabsProps) {
  return (
    <article className="card">
      <DetailTabBar active={props.active} select={props.select} t={props.t} />
      {props.active === "preflight" ? <PreflightPanel job={props.job} artifacts={props.artifacts}
        loading={props.artifactsLoading} t={props.t} /> : null}
      {props.active === "artifacts" ? <div className="detail-tab-panel"><ArtifactsContent embedded /></div> : null}
      {props.active === "reference" ? <ReferencePanel job={props.job} mode={props.mode} target={props.target}
        memory={props.memory} t={props.t} /> : null}
      {props.active === "events" ? <EventsPanel jobId={props.jobId} events={props.events} collapsed={props.collapsed}
        loading={props.eventsLoading} failed={props.eventsFailed} t={props.t} /> : null}
    </article>
  );
}

type SummaryFieldData = { label: string; value: unknown };

function SummaryField({ label, value }: SummaryFieldData) {
  return <div><strong>{label}</strong><span>{formatValue(value)}</span></div>;
}

function SummaryFields({ fields }: { fields: SummaryFieldData[] }) {
  return <>{fields.map((field) => <SummaryField {...field} key={field.label} />)}</>;
}

function OverviewCard({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="overview-card">
      <span className="overview-card-label">{label}</span>
      <strong className="overview-card-value">{value}</strong>
      {detail}
    </div>
  );
}

function liveSyncDetail(job: GuiJob, lastEventAt: string | null, t: TranslateFn) {
  if (isTerminalJobStatus(job.status)) return t("jobDetail.summary.completedLive");
  if (lastEventAt) return t("jobDetail.summary.lastEvent", { value: formatSystemDateTime(lastEventAt) });
  return t("jobDetail.summary.waitingEvents");
}

function JobOverviewGrid({ job, mode, connection, lastEventAt, t }: {
  job: GuiJob; mode: TranslationModeView; connection: StreamConnectionState;
  lastEventAt: string | null; t: TranslateFn;
}) {
  return (
    <div className="overview-card-grid">
      <OverviewCard label={t("jobDetail.summary.status")} value={translateJobStatusValue(job.status, t)}
        detail={<span className={`pill pill-${statusTone(job.status)}`}>{translateWorkflowStageValue(job.stage, t)}</span>} />
      <OverviewCard label={t("jobDetail.summary.jobType")} value={job.type}
        detail={<span className="job-subtext">{job.id}</span>} />
      {job.type === "translation" ? <OverviewCard label={t("jobDetail.summary.translationMode")}
        value={mode.label} detail={<span className="job-subtext">{mode.description}</span>} /> : null}
      <OverviewCard label={t("jobDetail.summary.created")} value={formatSystemDateTime(job.createdAt)}
        detail={<span className="job-subtext">{t("jobDetail.summary.updated", { value: formatSystemDateTime(job.updatedAt) })}</span>} />
      <OverviewCard label={t("jobDetail.summary.liveSync")}
        value={<span className={`live-connection-badge live-connection-badge-${liveConnectionTone(connection)}`}>
          {liveConnectionLabel(connection, t)}</span>}
        detail={<span className="job-subtext">{liveSyncDetail(job, lastEventAt, t)}</span>} />
    </div>
  );
}

function jobIdentityFields(job: GuiJob, target: string | null, t: TranslateFn): SummaryFieldData[] {
  const fields: SummaryFieldData[] = [
    { label: t("jobDetail.summary.jobId"), value: job.id },
    { label: t("jobDetail.summary.manga"), value: job.payload.mangaLabel ?? job.payload.mangaId },
    { label: t("jobDetail.summary.translator"), value: job.payload.translatorLabel ?? job.payload.translatorId ?? job.payload.translator },
    { label: t("jobDetail.summary.chapter"), value: job.payload.chapterTitle ?? job.payload.chapterLabel ?? job.payload.chapterId },
  ];
  if (job.type === "translation") fields.push({ label: t("jobDetail.summary.translationTarget"), value: target });
  if (job.type === "translation_knowledge_commit") {
    fields.push({ label: t("jobDetail.summary.sourceTranslationJob"), value: job.payload.sourceTranslationJobId });
  } else if (!["translation", "post_edit_export"].includes(job.type)) {
    fields.push({ label: t("jobDetail.summary.referenceSet"), value: job.payload.referenceSetId });
  }
  if (job.outcome) fields.push({ label: t("jobDetail.outcome.label"), value: t(`jobList.outcome.${job.outcome}`) });
  return fields;
}

function diagnosticFields(job: GuiJob, t: TranslateFn): SummaryFieldData[] {
  if (!job.diagnostics) return [];
  const fields: SummaryFieldData[] = [
    { label: t("jobDetail.outcome.accepted"), value: job.diagnostics.acceptedRecordCount ?? 0 },
    { label: t("jobDetail.outcome.quarantined"), value: job.diagnostics.quarantinedRecordCount ?? 0 },
    { label: t("jobDetail.outcome.warnings"), value: job.diagnostics.warningCount ?? 0 },
  ];
  if (job.diagnostics.failedWindowId) {
    fields.push({ label: t("jobDetail.outcome.failedWindow"), value: job.diagnostics.failedWindowId });
  }
  return fields;
}

function JobSummaryActions({ job, resuming, resume, openPostEdit, t }: {
  job: GuiJob; resuming: boolean; resume: () => void; openPostEdit: () => void; t: TranslateFn;
}) {
  return <>
    {job.status === "failed" && job.resumeMetadata?.resumeAvailable ? <div className="button-row">
      <button className="primary-button" disabled={resuming} onClick={resume} type="button">
        {resuming ? t("jobDetail.outcome.resuming") : t("jobDetail.outcome.resume")}
      </button>
    </div> : null}
    {job.type === "translation" && job.status === "succeeded" ? <div className="button-row">
      <button className="secondary-button" type="button" onClick={openPostEdit}>
        {t("jobDetail.summary.openPostEdit")}
      </button>
    </div> : null}
  </>;
}

type JobSummaryCardProps = {
  job: GuiJob; mode: TranslationModeView; target: string | null; connection: StreamConnectionState;
  lastEventAt: string | null; resuming: boolean; resume: () => void; openPostEdit: () => void; t: TranslateFn;
};

function JobSummaryCard(props: JobSummaryCardProps) {
  const fields = [...jobIdentityFields(props.job, props.target, props.t), ...diagnosticFields(props.job, props.t)];
  return (
    <article className="card">
      <h2>{props.t("jobDetail.summary.title")}</h2>
      <JobOverviewGrid job={props.job} mode={props.mode} connection={props.connection}
        lastEventAt={props.lastEventAt} t={props.t} />
      <div className="summary-grid"><SummaryFields fields={fields} /></div>
      <JobSummaryActions job={props.job} resuming={props.resuming} resume={props.resume}
        openPostEdit={props.openPostEdit} t={props.t} />
    </article>
  );
}

type InsightData = {
  memory: Record<string, unknown> | null; quality: Record<string, unknown> | null;
  coverage: Record<string, unknown> | null; revisionCount: number; evidence: Record<string, unknown> | null;
  knowledge: Record<string, unknown> | null; knowledgeChild: GuiJob | null;
};

function MemoryInsightFields({ data, t }: { data: InsightData; t: TranslateFn }) {
  const usage = asRecord(data.memory?.usage);
  return <SummaryFields fields={[
    { label: t("jobDetail.translationMemory.fingerprint"), value: data.memory?.fingerprint },
    { label: t("jobDetail.translationMemory.terminology"), value: usage?.glossaryEntries },
    { label: t("jobDetail.translationMemory.story"), value: usage?.storyCharacters },
    { label: t("jobDetail.translationMemory.style"), value: usage?.styleChapters },
    { label: t("jobDetail.translationMemory.qualityChanges"), value: data.revisionCount },
  ]} />;
}

function QualityInsightFields({ data, t }: { data: InsightData; t: TranslateFn }) {
  const coverage = t("jobDetail.quality.semanticCoverageValue", {
    annotated: Number(data.coverage?.annotated || 0), total: Number(data.coverage?.total || 0),
    ratio: Math.round(Number(data.coverage?.ratio || 0) * 100),
  });
  return <SummaryFields fields={[
    { label: t("jobDetail.quality.coverage"), value: `${formatValue(data.quality?.candidateCount)} / ${formatValue(data.quality?.totalTranslations)}` },
    { label: t("jobDetail.quality.windows"), value: data.quality?.windowCount },
    { label: t("jobDetail.quality.reasons"), value: data.quality?.candidateReasonCounts },
    { label: t("jobDetail.quality.inputBytes"), value: data.quality?.inputBytes },
    { label: t("jobDetail.quality.elapsed"), value: data.quality?.elapsedMs },
    { label: t("jobDetail.quality.semanticCoverage"), value: coverage },
  ]} />;
}

function KnowledgeInsightFields({ data, t }: { data: InsightData; t: TranslateFn }) {
  const childResult = asRecord(data.knowledgeChild?.result);
  return <SummaryFields fields={[
    { label: t("jobDetail.translationMemory.knowledge"), value: data.knowledgeChild
      ? translateJobStatusValue(data.knowledgeChild.status, t) : t("jobDetail.translationMemory.notScheduled") },
    ...(data.knowledgeChild?.outcome ? [{ label: t("jobDetail.outcome.label"), value: t(`jobList.outcome.${data.knowledgeChild.outcome}`) }] : []),
    { label: t("jobDetail.knowledge.evidence"), value: data.evidence?.total },
    { label: t("jobDetail.knowledge.confidenceUpdates"), value: data.knowledge?.confidenceUpdates ?? childResult?.confidenceUpdates },
    { label: t("jobDetail.knowledge.changes"), value: data.knowledge?.knowledgeChanges ?? childResult?.knowledgeChanges },
    { label: t("jobDetail.knowledge.semanticRoles"), value: data.evidence?.semanticRoles },
  ]} />;
}

type InsightActions = {
  auditPending: boolean; repairPending: boolean; retryPending: boolean; needsRepair: boolean;
  startAudit: () => void; startRepair: () => void; retryKnowledge: () => void; retryError: unknown;
};

function TranslationActions({ actions, t }: { actions: InsightActions; t: TranslateFn }) {
  return <>
    <button className="secondary-button" type="button" disabled={actions.auditPending} onClick={actions.startAudit}>
      {t(actions.auditPending ? "jobDetail.deepAudit.starting" : "jobDetail.deepAudit.start")}
    </button>
    <button className="secondary-button" type="button" disabled={actions.repairPending} onClick={actions.startRepair}>
      {actions.repairPending ? t("jobDetail.qualityRepair.starting")
        : t(actions.needsRepair ? "jobDetail.qualityRepair.resumePartial" : "jobDetail.qualityRepair.start")}
    </button>
  </>;
}

function KnowledgeRetryAction({ job, child, actions, t }: {
  job: GuiJob; child: GuiJob | null; actions: InsightActions; t: TranslateFn;
}) {
  if (child || !asRecord(job.result)?.knowledgePayload) return null;
  return <button className="secondary-button" type="button" disabled={actions.retryPending}
    onClick={actions.retryKnowledge}>
    {t(actions.retryPending ? "jobDetail.knowledgeRetry.starting" : "jobDetail.knowledgeRetry.start")}
  </button>;
}

function InsightActionRow({ job, child, actions, t }: {
  job: GuiJob; child: GuiJob | null; actions: InsightActions; t: TranslateFn;
}) {
  if (job.status !== "succeeded") return null;
  return <div className="button-row">
    {job.type === "translation" ? <TranslationActions actions={actions} t={t} /> : null}
    <KnowledgeRetryAction job={job} child={child} actions={actions} t={t} />
  </div>;
}

function KnowledgeRetryError({ error, t }: { error: unknown; t: TranslateFn }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <p className="error-text">{t("jobDetail.knowledgeRetry.failed", { message })}</p>;
}

function TranslationInsightsCard({ job, data, actions, t }: {
  job: GuiJob; data: InsightData; actions: InsightActions; t: TranslateFn;
}) {
  const visible = ["translation", "translation_quality_repair", "translation_deep_audit_apply"].includes(job.type);
  if (!visible) return null;
  return <article className="card">
    <h2>{t("jobDetail.translationMemory.title")}</h2>
    <div className="summary-grid"><MemoryInsightFields data={data} t={t} />
      <QualityInsightFields data={data} t={t} /><KnowledgeInsightFields data={data} t={t} /></div>
    <InsightActionRow job={job} child={data.knowledgeChild} actions={actions} t={t} />
    <KnowledgeRetryError error={actions.retryError} t={t} />
  </article>;
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function openAuditSource(job: GuiJob, selectJob: (id: string) => void, selectPage: (page: "post-edit") => void) {
  selectJob(job.payload.sourceTranslationJobId as string);
  selectPage("post-edit");
}

function DeepAuditSummaryCard({ job, selectJob, selectPage, t }: {
  job: GuiJob; selectJob: (id: string) => void; selectPage: (page: "post-edit") => void; t: TranslateFn;
}) {
  if (job.type !== "translation_deep_audit") return null;
  const result = asRecord(job.result);
  const canOpen = job.status === "succeeded" && typeof job.payload.sourceTranslationJobId === "string";
  return <article className="card">
    <h2>{t("jobDetail.deepAudit.title")}</h2>
    <div className="summary-grid"><SummaryFields fields={[
      { label: t("jobDetail.deepAudit.windows"), value: result?.windowCount },
      { label: t("jobDetail.deepAudit.reused"), value: result?.reusedWindows },
      { label: t("jobDetail.deepAudit.findings"), value: arrayLength(result?.findings) },
      { label: t("jobDetail.deepAudit.proposals"), value: arrayLength(result?.proposedTranslations) },
    ]} /></div>
    {canOpen ? <div className="button-row"><button className="secondary-button" type="button"
      onClick={() => openAuditSource(job, selectJob, selectPage)}>{t("jobDetail.deepAudit.openPostEdit")}</button></div> : null}
  </article>;
}

function useJobNavigation() {
  const { t } = useLanguageStore();
  const selectedJobId = useUiStore((state) => state.selectedJobId);
  const setSelectedJobId = useUiStore((state) => state.setSelectedJobId);
  const setSelectedPage = useUiStore((state) => state.setSelectedPage);
  const setSelectedMangaId = useUiStore((state) => state.setSelectedMangaId);
  const setSelectedTranslatorId = useUiStore((state) => state.setSelectedTranslatorId);
  const [activeTab, setActiveTab] = useState<DetailTab>("preflight");
  return { t, selectedJobId, setSelectedJobId, setSelectedPage, setSelectedMangaId,
    setSelectedTranslatorId, activeTab, setActiveTab };
}

function useJobRuntimeBindings() {
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
  return { runtimeJob, runtimeEvents, runtimeArtifacts, connectionState, lastEventAt, resetForJob,
    hydrateJob, hydrateEvents, hydrateArtifacts, appendEvent, setConnectionState };
}

function useJobDetailQueries(selectedJobId: string | null) {
  const jobQuery = useQuery({ queryKey: ["job", selectedJobId],
    queryFn: () => getJob(selectedJobId as string), enabled: Boolean(selectedJobId) });
  const eventsQuery = useQuery({ queryKey: ["job-events", selectedJobId],
    queryFn: () => getJobEvents(selectedJobId as string), enabled: Boolean(selectedJobId) });
  const artifactsQuery = useQuery({ queryKey: ["job-artifacts", selectedJobId],
    queryFn: () => getJobArtifacts(selectedJobId as string), enabled: Boolean(selectedJobId) });
  return { jobQuery, eventsQuery, artifactsQuery };
}

function useJobDetailMutations(setSelectedJobId: (id: string) => void) {
  const deepAuditMutation = useMutation({ mutationFn: createTranslationDeepAuditJob,
    onSuccess: (job) => setSelectedJobId(job.id) });
  const qualityRepairMutation = useMutation({ mutationFn: createQualityRepairJob,
    onSuccess: (job) => setSelectedJobId(job.id) });
  const knowledgeRetryMutation = useMutation({ mutationFn: createTranslationKnowledgeRetryJob,
    onSuccess: (job) => setSelectedJobId(job.id) });
  const resumeMutation = useMutation({ mutationFn: resumeJob,
    onSuccess: (job) => setSelectedJobId(job.id) });
  return { deepAuditMutation, qualityRepairMutation, knowledgeRetryMutation, resumeMutation };
}

function resolveSourcePreflight(job: GuiJob | null, events: GuiJobEvent[], manifest: GuiArtifact | null) {
  const eventPayload = extractLatestEventPayload(events, "source_preflight.resolved");
  if (eventPayload) return eventPayload;
  const resultPreflight = asRecord(job?.result)?.sourcePreflight;
  return resultPreflight || asRecord(manifest?.metadata);
}

function useJobDerivedData(job: GuiJob | null, events: GuiJobEvent[], artifacts: GuiArtifact[], t: TranslateFn) {
  const timeline = useMemo(() => projectTimelineEvents(events, t), [events, t]);
  const collapsedEvents = useMemo(() => collapseEvents(events), [events]);
  const preflightArtifacts = useMemo(() => artifacts.filter((artifact) =>
    ["source_preflight_manifest", "reference_scene", "reference_texts"].includes(artifact.kind)), [artifacts]);
  const manifest = useMemo(() => artifacts.find((artifact) => artifact.kind === "source_preflight_manifest") ?? null, [artifacts]);
  const preflight = useMemo(() => resolveSourcePreflight(job, events, manifest), [events, job, manifest]);
  const workflowSummary = useMemo(() => buildWorkflowSummary(job, events), [events, job]);
  const latestPipelineProgress = useMemo(() => findLatestPipelineProgress(events), [events]);
  const pipelineEngines = useMemo(() => buildPipelineEngines(job, latestPipelineProgress), [job, latestPipelineProgress]);
  const pageProgress = useMemo(() => buildPageProgress(job, latestPipelineProgress, preflight, manifest?.metadata),
    [job, latestPipelineProgress, manifest?.metadata, preflight]);
  const notices = useMemo(() => buildJobNotices(job, latestPipelineProgress, t), [job, latestPipelineProgress, t]);
  return { timeline, collapsedEvents, preflightArtifacts, workflowSummary, latestPipelineProgress,
    pipelineEngines, pageProgress, notices };
}

function translationModeFor(job: GuiJob | null, t: TranslateFn): TranslationModeView {
  const mode = String(job?.payload?.translationMode ?? "quick");
  const key = mode === "learning_style" ? "learningStyle"
    : mode === "reference_style" ? "referenceStyle" : mode === "local_style" ? "localStyle" : "quick";
  return { label: t(`jobDetail.translationMode.${key}.label`),
    description: t(`jobDetail.translationMode.${key}.description`) };
}

function translationTargetFor(job: GuiJob | null) {
  const target = asRecord(asRecord(job?.result)?.translationTarget) || asRecord(job?.payload?.translationTarget);
  const providerId = typeof target?.providerId === "string" ? target.providerId : null;
  const modelId = typeof target?.modelId === "string" ? target.modelId : null;
  return providerId && modelId ? `${providerId} / ${modelId}` : null;
}

function buildJobInsights(job: GuiJob | null, events: GuiJobEvent[], t: TranslateFn) {
  const translationMemorySummary = extractLatestEventPayload(events, "translation_memory.built");
  const qualitySummary = extractLatestEventPayload(events, "quality.completed");
  const qualityContext = extractLatestEventPayload(events, "quality.context_built");
  const displayedQualitySummary = qualitySummary || qualityContext;
  const persistedQuality = asRecord(asRecord(job?.result)?.quality);
  const qualityNeedsRepair = job?.outcome === "partial" || persistedQuality?.completenessStatus === "incomplete" ||
    asRecord(persistedQuality?.semanticResult)?.outcome === "partial";
  return {
    translationModeView: translationModeFor(job, t), translationTarget: translationTargetFor(job),
    translationMemorySummary, qualitySummary, displayedQualitySummary,
    qualitySemanticCoverage: asRecord(displayedQualitySummary?.semanticCoverage), qualityNeedsRepair,
    qualityRevisionCount: Array.isArray(qualitySummary?.optimizedTranslations) ? qualitySummary.optimizedTranslations.length : 0,
    learningEvidenceSummary: extractLatestEventPayload(events, "learning_evidence.persisted"),
    knowledgeSummary: extractLatestEventPayload(events, "knowledge.completed"),
    knowledgeChild: job?.children?.find((child) => child.type === "translation_knowledge_commit") || null,
  };
}

function useSelectionSync(
  job: GuiJob | null,
  setManga: (id: string | null) => void,
  setTranslator: (id: string | null) => void,
) {
  useEffect(() => {
    const mangaId = job?.payload?.mangaId;
    if (typeof mangaId === "string" && mangaId.trim()) setManga(mangaId);
    const translatorId = job?.payload?.translatorId;
    if (typeof translatorId === "string" && translatorId.trim()) setTranslator(translatorId);
  }, [job?.payload, setManga, setTranslator]);
}

function useRuntimeHydration(
  selectedJobId: string | null,
  runtime: ReturnType<typeof useJobRuntimeBindings>,
  queries: ReturnType<typeof useJobDetailQueries>,
) {
  useEffect(() => runtime.resetForJob(selectedJobId), [runtime.resetForJob, selectedJobId]);
  useEffect(() => {
    if (queries.jobQuery.data) runtime.hydrateJob(queries.jobQuery.data);
  }, [queries.jobQuery.data, runtime.hydrateJob]);
  useEffect(() => {
    if (queries.eventsQuery.data?.events) runtime.hydrateEvents(queries.eventsQuery.data.events);
  }, [queries.eventsQuery.data, runtime.hydrateEvents]);
  useEffect(() => {
    if (queries.artifactsQuery.data?.artifacts) runtime.hydrateArtifacts(queries.artifactsQuery.data.artifacts);
  }, [queries.artifactsQuery.data, runtime.hydrateArtifacts]);
}

function useJobStreamBinding(
  jobId: string | null,
  runtime: ReturnType<typeof useJobRuntimeBindings>,
  queries: ReturnType<typeof useJobDetailQueries>,
) {
  const queryClient = useQueryClient();
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const context = useMemo(() => ({ queryClient, appendEvent: runtime.appendEvent,
    hydrateJob: runtime.hydrateJob, refetchJob: queries.jobQuery.refetch,
    refetchArtifacts: queries.artifactsQuery.refetch }),
  [queryClient, queries.artifactsQuery.refetch, queries.jobQuery.refetch, runtime.appendEvent, runtime.hydrateJob]);
  const contextRef = useRef(context);
  contextRef.current = context;
  useSelectedJobStream(jobId, runtime.runtimeJob?.status ?? queries.jobQuery.data?.status,
    reconnectTimerRef, runtime.setConnectionState, contextRef);
}

function useJobDetailModel() {
  const navigation = useJobNavigation();
  const runtime = useJobRuntimeBindings();
  const queries = useJobDetailQueries(navigation.selectedJobId);
  const mutations = useJobDetailMutations(navigation.setSelectedJobId);
  const displayJob = runtime.runtimeJob ?? queries.jobQuery.data ?? null;
  const derived = useJobDerivedData(runtime.runtimeJob, runtime.runtimeEvents, runtime.runtimeArtifacts, navigation.t);
  const insights = useMemo(() => buildJobInsights(displayJob, runtime.runtimeEvents, navigation.t),
    [displayJob, navigation.t, runtime.runtimeEvents]);
  useSelectionSync(runtime.runtimeJob, navigation.setSelectedMangaId, navigation.setSelectedTranslatorId);
  useRuntimeHydration(navigation.selectedJobId, runtime, queries);
  useJobStreamBinding(navigation.selectedJobId, runtime, queries);
  const effectiveConnectionState = displayJob && isTerminalJobStatus(displayJob.status)
    ? "closed" as const : runtime.connectionState;
  return { ...navigation, ...runtime, ...queries, ...mutations, ...derived, ...insights,
    displayJob, effectiveConnectionState };
}

type JobDetailModel = ReturnType<typeof useJobDetailModel>;

function EmbeddedJobIntro({ t }: { t: TranslateFn }) {
  return <article className="card"><h2>{t("jobDetail.selectedTitle")}</h2>
    <p className="muted-text">{t("jobDetail.selectedDescription")}</p></article>;
}

function JobDeepAuditReview({ model }: { model: JobDetailModel }) {
  const job = model.displayJob;
  if (!job || !["translation", "translation_quality_repair", "translation_deep_audit"].includes(job.type)) return null;
  return <DeepAuditReviewPane job={job} onApplyCreated={(created) => model.setSelectedJobId(created.id)} />;
}

function JobDetailLayout({ model, embedded }: { model: JobDetailModel; embedded: boolean }) {
  const job = model.displayJob as GuiJob;
  return <div className="detail-layout">
    {embedded ? <EmbeddedJobIntro t={model.t} /> : null}
    <JobSummaryCard job={job} mode={model.translationModeView} target={model.translationTarget}
      connection={model.effectiveConnectionState} lastEventAt={model.lastEventAt} resuming={model.resumeMutation.isPending}
      resume={() => model.resumeMutation.mutate(job.id)} openPostEdit={() => model.setSelectedPage("post-edit")} t={model.t} />
    <TranslationInsightsCard job={job} data={jobInsightData(model)} actions={jobInsightActions(model, job)} t={model.t} />
    <JobDeepAuditReview model={model} />
    <DeepAuditSummaryCard job={job} selectJob={model.setSelectedJobId} selectPage={model.setSelectedPage} t={model.t} />
    <WorkflowCard entries={model.workflowSummary} t={model.t} />
    {job.type === "translation" ? <><PipelineCard engines={model.pipelineEngines}
      progress={model.latestPipelineProgress} t={model.t} /><PageProgressCard progress={model.pageProgress} t={model.t} />
      <PipelineMetricsCard events={model.runtimeEvents} t={model.t} /></> : null}
    <NoticesCard notices={model.notices} t={model.t} />
    <TimelineCard timeline={model.timeline} t={model.t} />
    <ResultCard job={job} t={model.t} />
    <DetailTabs active={model.activeTab} select={model.setActiveTab} job={job} jobId={model.selectedJobId as string}
      artifacts={model.preflightArtifacts} artifactsLoading={model.artifactsQuery.isLoading} events={model.runtimeEvents}
      collapsed={model.collapsedEvents} eventsLoading={model.eventsQuery.isLoading} eventsFailed={model.eventsQuery.isError}
      mode={model.translationModeView} target={model.translationTarget} memory={model.translationMemorySummary} t={model.t} />
  </div>;
}

function jobInsightData(model: JobDetailModel): InsightData {
  return { memory: model.translationMemorySummary, quality: model.displayedQualitySummary,
    coverage: model.qualitySemanticCoverage, revisionCount: model.qualityRevisionCount,
    evidence: model.learningEvidenceSummary, knowledge: model.knowledgeSummary,
    knowledgeChild: model.knowledgeChild };
}

function jobInsightActions(model: JobDetailModel, job: GuiJob): InsightActions {
  return { auditPending: model.deepAuditMutation.isPending, repairPending: model.qualityRepairMutation.isPending,
    retryPending: model.knowledgeRetryMutation.isPending, needsRepair: model.qualityNeedsRepair,
    startAudit: () => model.deepAuditMutation.mutate(job.id),
    startRepair: () => model.qualityRepairMutation.mutate(job.id),
    retryKnowledge: () => model.knowledgeRetryMutation.mutate(job.id), retryError: model.knowledgeRetryMutation.error };
}

function JobDetailView({ model, embedded }: { model: JobDetailModel; embedded: boolean }) {
  if (!model.selectedJobId) {
    return <article className={embedded ? "card" : "page"}>
      {embedded ? <h2>{model.t("jobDetail.selectedTitle")}</h2> : null}<p>{model.t("jobDetail.empty")}</p>
    </article>;
  }
  return <>
    {model.jobQuery.isLoading ? <p>{model.t("jobDetail.loading")}</p> : null}
    {model.jobQuery.isError ? <p>{model.t("jobDetail.loadFailed")}</p> : null}
    {!model.jobQuery.isLoading && !model.jobQuery.isError && model.displayJob
      ? <JobDetailLayout model={model} embedded={embedded} /> : null}
  </>;
}

export function JobDetailContent({ embedded }: { embedded: boolean }) {
  const model = useJobDetailModel();
  return <JobDetailView model={model} embedded={embedded} />;
}
