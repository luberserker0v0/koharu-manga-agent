import { useEffect, useMemo, useRef, useState } from "react";
import type { GuiJobEvent } from "../../api/jobs";
import { subscribeToJobStream } from "../../stream/job_stream";
import { useInteractionStore } from "../../stores/interaction_store";
import { useLanguageStore } from "../../stores/language_store";
import { formatSystemDateTime } from "../../features/shared/formatters/date_time";

type InteractionPanelProps = {
  jobId: string;
};

type EventSourceType = "backend" | "koharu" | "agent" | "llm";
type EventDirectionType = "all" | "request" | "response" | "internal" | "error";
type Translator = (key: string, params?: Record<string, string | number>) => string;

const SOURCE_FILTERS = ["all", "backend", "koharu", "agent", "llm"] as const;
const DIRECTION_FILTERS = ["all", "request", "response", "internal", "error"] as const;

function inferSource(eventType: string): EventSourceType {
  if (eventType.startsWith("pipeline.")) {
    return "koharu";
  }
  if (eventType.startsWith("llm.")) {
    return "llm";
  }
  if (eventType.startsWith("quality.") || eventType.startsWith("knowledge.")) {
    return "agent";
  }
  return "backend";
}

function inferDirection(event: GuiJobEvent): Exclude<EventDirectionType, "all"> {
  const payload =
    event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : null;

  if (payload && typeof payload.error === "string") {
    return "error";
  }
  if (event.type.endsWith(".requested") || event.type.endsWith(".started") || event.type === "job.created") {
    return "request";
  }
  if (event.type.endsWith(".completed") || event.type.endsWith(".failed") || event.type.endsWith(".cancel_requested")) {
    return payload && typeof payload.error === "string" ? "error" : "response";
  }
  return "internal";
}

function summarizePayload(
  payload: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (!payload || typeof payload !== "object") {
    return typeof payload === "string" ? payload : t("interaction.noPayload");
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string") {
    return record.error;
  }
  if (typeof record.stage === "string") {
    return t("interaction.stage", { value: record.stage });
  }
  if (typeof record.status === "string") {
    return t("interaction.status", { value: record.status });
  }
  if (typeof record.projectName === "string") {
    return t("interaction.project", { value: record.projectName });
  }
  if (typeof record.operationId === "string") {
    return t("interaction.operation", { value: record.operationId });
  }
  const keys = Object.keys(record);
  return keys.length ? t("interaction.keys", { value: keys.join(", ") }) : t("interaction.objectPayload");
}

function EventCard({
  event,
  t,
}: {
  event: GuiJobEvent;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const source = inferSource(event.type);
  const direction = inferDirection(event);

  return (
    <div className="event-row">
      <div className="event-meta">
        <strong>{event.type}</strong>
        <span>{event.createdAt ? formatSystemDateTime(event.createdAt) : t("interaction.live")}</span>
      </div>
      <div className="event-tags">
        <span className="event-tag">{source}</span>
        <span className="event-tag">{direction}</span>
      </div>
      <p className="event-summary">{summarizePayload(event.payload, t)}</p>
      <details className="event-details">
        <summary>{t("interaction.payload")}</summary>
        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
      </details>
    </div>
  );
}

function useJobStream(jobId: string, appendEvent: (jobId: string, event: GuiJobEvent) => void) {
  useEffect(() => subscribeToJobStream(jobId, (event) => appendEvent(jobId, event)), [appendEvent, jobId]);
}

function useAutoFollow(
  jobId: string,
  enabled: boolean,
  clearUnread: (jobId: string) => void,
  count: number,
  viewportRef: React.RefObject<HTMLDivElement>,
) {
  useEffect(() => {
    if (!enabled || !viewportRef.current) return;
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    clearUnread(jobId);
  }, [clearUnread, count, enabled, jobId, viewportRef]);
}

function FilterRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="filter-row">
      {options.map((filter) => (
        <button
          key={filter}
          className={value === filter ? "secondary-button active-filter" : "secondary-button"}
          onClick={() => onChange(filter)}
          type="button"
        >
          {filter}
        </button>
      ))}
    </div>
  );
}

function InteractionHeader({
  statusText,
  autoFollow,
  onJump,
  t,
}: {
  statusText: string;
  autoFollow: boolean;
  onJump: () => void;
  t: (key: string) => string;
}) {
  return (
    <div className="interaction-header">
      <div>
        <h2>{t("interaction.title")}</h2>
        <p>{statusText}</p>
      </div>
      {!autoFollow && (
        <button className="primary-button" onClick={onJump} type="button">
          {t("interaction.jumpLatest")}
        </button>
      )}
    </div>
  );
}

function EventViewport({
  events,
  onScroll,
  viewportRef,
  t,
}: {
  events: GuiJobEvent[];
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  viewportRef: React.RefObject<HTMLDivElement>;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className="interaction-viewport" onScroll={onScroll} ref={viewportRef}>
      {events.map((event, index) => (
        <EventCard event={event} key={`${event.id ?? "stream"}-${event.createdAt ?? "live"}-${index}`} t={t} />
      ))}
    </div>
  );
}

function isNearViewportBottom(event: React.UIEvent<HTMLDivElement>) {
  const target = event.currentTarget;
  return target.scrollHeight - target.scrollTop - target.clientHeight < 24;
}

function useInteractionEvents(jobId: string) {
  const events = useInteractionStore((state) => state.eventsByJob[jobId] ?? []);
  const appendEvent = useInteractionStore((state) => state.appendEvent);
  const autoFollow = useInteractionStore((state) => state.autoFollowByJob[jobId] ?? true);
  const setAutoFollow = useInteractionStore((state) => state.setAutoFollow);
  const clearUnread = useInteractionStore((state) => state.clearUnread);
  const unreadCount = useInteractionStore((state) => state.unreadByJob[jobId] ?? 0);
  return { events, appendEvent, autoFollow, setAutoFollow, clearUnread, unreadCount };
}

function useVisibleEvents(events: GuiJobEvent[]) {
  const [sourceFilter, setSourceFilter] = useState<"all" | EventSourceType>("all");
  const [directionFilter, setDirectionFilter] = useState<EventDirectionType>("all");
  const visibleEvents = useMemo(
    () => events.filter((event) =>
      (sourceFilter === "all" || inferSource(event.type) === sourceFilter) &&
      (directionFilter === "all" || inferDirection(event) === directionFilter)),
    [directionFilter, events, sourceFilter],
  );
  return { sourceFilter, setSourceFilter, directionFilter, setDirectionFilter, visibleEvents };
}

function InteractionFilters({ model }: { model: ReturnType<typeof useVisibleEvents> }) {
  return <>
    <FilterRow options={SOURCE_FILTERS} value={model.sourceFilter} onChange={model.setSourceFilter} />
    <FilterRow options={DIRECTION_FILTERS} value={model.directionFilter} onChange={model.setDirectionFilter} />
  </>;
}

function useInteractionPanelModel(jobId: string) {
  const t = useLanguageStore((state) => state.t);
  const interaction = useInteractionEvents(jobId);
  const filters = useVisibleEvents(interaction.events);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  useJobStream(jobId, interaction.appendEvent);
  useAutoFollow(jobId, interaction.autoFollow, interaction.clearUnread, interaction.events.length, viewportRef);
  const jumpLatest = () => {
    interaction.setAutoFollow(jobId, true);
    interaction.clearUnread(jobId);
  };
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const nearBottom = isNearViewportBottom(event);
    interaction.setAutoFollow(jobId, nearBottom);
    if (nearBottom) interaction.clearUnread(jobId);
  };
  const statusText = interaction.autoFollow
    ? t("interaction.following")
    : t("interaction.paused", { count: interaction.unreadCount });
  return { t, interaction, filters, viewportRef, jumpLatest, handleScroll, statusText };
}

export function InteractionPanel({ jobId }: InteractionPanelProps) {
  const model = useInteractionPanelModel(jobId);
  return (
    <article className="card interaction-card">
      <InteractionHeader statusText={model.statusText} autoFollow={model.interaction.autoFollow}
        onJump={model.jumpLatest} t={model.t} />
      <InteractionFilters model={model.filters} />
      <EventViewport events={model.filters.visibleEvents} onScroll={model.handleScroll}
        viewportRef={model.viewportRef} t={model.t as Translator} />
    </article>
  );
}
