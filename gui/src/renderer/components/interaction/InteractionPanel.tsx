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
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : null;

  if (payload && typeof payload.error === "string") {
    return "error";
  }
  if (
    event.type.endsWith(".requested") ||
    event.type.endsWith(".started") ||
    event.type === "job.created"
  ) {
    return "request";
  }
  if (
    event.type.endsWith(".completed") ||
    event.type.endsWith(".failed") ||
    event.type.endsWith(".cancel_requested")
  ) {
    return payload && typeof payload.error === "string" ? "error" : "response";
  }
  return "internal";
}

function summarizePayload(
  payload: unknown,
  t: (key: string, params?: Record<string, string | number>) => string
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

export function InteractionPanel({ jobId }: InteractionPanelProps) {
  const t = useLanguageStore((state) => state.t);
  const [sourceFilter, setSourceFilter] = useState<"all" | EventSourceType>("all");
  const [directionFilter, setDirectionFilter] = useState<EventDirectionType>("all");
  const events = useInteractionStore((state) => state.eventsByJob[jobId] ?? []);
  const appendEvent = useInteractionStore((state) => state.appendEvent);
  const autoFollow = useInteractionStore((state) => state.autoFollowByJob[jobId] ?? true);
  const setAutoFollow = useInteractionStore((state) => state.setAutoFollow);
  const clearUnread = useInteractionStore((state) => state.clearUnread);
  const unreadCount = useInteractionStore((state) => state.unreadByJob[jobId] ?? 0);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToJobStream(jobId, (event) => {
      appendEvent(jobId, event);
    });
    return unsubscribe;
  }, [appendEvent, jobId]);

  useEffect(() => {
    if (!autoFollow || !viewportRef.current) {
      return;
    }
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    clearUnread(jobId);
  }, [autoFollow, clearUnread, events.length, jobId]);

  const visibleEvents = useMemo(() => {
    return events.filter((event) => {
      const sourceMatches = sourceFilter === "all" || inferSource(event.type) === sourceFilter;
      const directionMatches =
        directionFilter === "all" || inferDirection(event) === directionFilter;
      return sourceMatches && directionMatches;
    });
  }, [directionFilter, events, sourceFilter]);

  const statusText = useMemo(() => {
    if (autoFollow) {
      return t("interaction.following");
    }
    return t("interaction.paused", { count: unreadCount });
  }, [autoFollow, t, unreadCount]);

  return (
    <article className="card interaction-card">
      <div className="interaction-header">
        <div>
          <h2>{t("interaction.title")}</h2>
          <p>{statusText}</p>
        </div>
        {!autoFollow && (
          <button
            className="primary-button"
            onClick={() => {
              setAutoFollow(jobId, true);
              clearUnread(jobId);
            }}
            type="button"
          >
            {t("interaction.jumpLatest")}
          </button>
        )}
      </div>

      <div className="filter-row">
        {(["all", "backend", "koharu", "agent", "llm"] as const).map((filter) => (
          <button
            key={filter}
            className={sourceFilter === filter ? "secondary-button active-filter" : "secondary-button"}
            onClick={() => setSourceFilter(filter)}
            type="button"
          >
            {filter}
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
            {filter}
          </button>
        ))}
      </div>

      <div
        className="interaction-viewport"
        onScroll={(event) => {
          const target = event.currentTarget;
          const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
          setAutoFollow(jobId, nearBottom);
          if (nearBottom) {
            clearUnread(jobId);
          }
        }}
        ref={viewportRef}
      >
        {visibleEvents.map((event, index) => (
          <EventCard
            event={event}
            key={`${event.id ?? "stream"}-${event.createdAt ?? "live"}-${index}`}
            t={t}
          />
        ))}
      </div>
    </article>
  );
}
