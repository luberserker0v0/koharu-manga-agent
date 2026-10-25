import { create } from "zustand";
import { isGuiJobStatus } from "../api/jobs";
import type { GuiArtifact, GuiJob, GuiJobEvent } from "../api/jobs";

export type StreamConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "closed";

type SelectedJobRuntimeState = {
  jobId: string | null;
  snapshotLoaded: boolean;
  connectionState: StreamConnectionState;
  job: GuiJob | null;
  rawEvents: GuiJobEvent[];
  artifacts: GuiArtifact[];
  lastEventAt: string | null;
  resetForJob: (jobId: string | null) => void;
  hydrateJob: (job: GuiJob) => void;
  hydrateEvents: (events: GuiJobEvent[]) => void;
  hydrateArtifacts: (artifacts: GuiArtifact[]) => void;
  appendEvent: (event: GuiJobEvent) => void;
  setConnectionState: (state: StreamConnectionState) => void;
};

function eventSignature(event: GuiJobEvent): string {
  return `${event.type}:${event.createdAt ?? "live"}:${JSON.stringify(event.payload ?? null)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function mergeEvents(baseEvents: GuiJobEvent[], incomingEvents: GuiJobEvent[]) {
  const seenIds = new Set(baseEvents.map((event) => (typeof event.id === "number" ? event.id : null)).filter(Boolean));
  const seenSignatures = new Set(baseEvents.map((event) => eventSignature(event)));
  const merged = [...baseEvents];

  for (const event of incomingEvents) {
    if (typeof event.id === "number") {
      if (seenIds.has(event.id)) {
        continue;
      }
      seenIds.add(event.id);
      merged.push(event);
      continue;
    }

    const signature = eventSignature(event);
    if (seenSignatures.has(signature)) {
      continue;
    }
    seenSignatures.add(signature);
    merged.push(event);
  }

  return merged;
}

function stageJob(job: GuiJob, payload: Record<string, unknown> | null, updatedAt: string): GuiJob {
  return {
    ...job,
    status: isGuiJobStatus(payload?.status) ? payload.status : job.status,
    stage: typeof payload?.stage === "string" ? payload.stage : job.stage,
    updatedAt,
  };
}

function completedJob(job: GuiJob, event: GuiJobEvent, updatedAt: string): GuiJob {
  return {
    ...job,
    status: "succeeded",
    stage: "succeeded",
    result: event.payload,
    error: null,
    updatedAt,
  };
}

function failedJob(job: GuiJob, payload: Record<string, unknown> | null, updatedAt: string): GuiJob {
  return {
    ...job,
    status: isGuiJobStatus(payload?.status) ? payload.status : "failed",
    stage: typeof payload?.status === "string" ? payload.status : "failed",
    error: typeof payload?.error === "string" ? payload.error : job.error,
    updatedAt,
  };
}

function canceledJob(job: GuiJob, payload: Record<string, unknown> | null, updatedAt: string): GuiJob {
  return {
    ...job,
    status: "canceled",
    stage: "canceled",
    error: typeof payload?.error === "string" ? payload.error : job.error,
    updatedAt,
  };
}

function reduceJobFromEvent(job: GuiJob | null, event: GuiJobEvent): GuiJob | null {
  if (!job) return job;
  const payload = isRecord(event.payload) ? event.payload : null;
  const updatedAt = event.createdAt ?? job.updatedAt;
  if (event.type === "job.stage") return stageJob(job, payload, updatedAt);
  if (event.type === "job.completed") return completedJob(job, event, updatedAt);
  if (event.type === "job.failed") return failedJob(job, payload, updatedAt);
  if (event.type === "job.canceled") return canceledJob(job, payload, updatedAt);
  return { ...job, updatedAt };
}

function resetState(state: SelectedJobRuntimeState, jobId: string | null) {
  if (state.jobId === jobId) return state;
  return {
    jobId,
    snapshotLoaded: false,
    connectionState: jobId ? ("connecting" as const) : ("idle" as const),
    job: null,
    rawEvents: [],
    artifacts: [],
    lastEventAt: null,
  };
}

function hydrateJobState(state: SelectedJobRuntimeState, job: GuiJob) {
  const current = state.job?.id === job.id ? state.job : null;
  return {
    jobId: job.id,
    snapshotLoaded: true,
    job: {
      ...current,
      ...job,
      events: job.events || current?.events || [],
      artifacts: job.artifacts || current?.artifacts || [],
      children: job.children ?? current?.children,
    },
    connectionState: state.connectionState === "idle" && job.id ? ("connecting" as const) : state.connectionState,
  };
}

export const useSelectedJobRuntimeStore = create<SelectedJobRuntimeState>((set) => ({
  jobId: null,
  snapshotLoaded: false,
  connectionState: "idle",
  job: null,
  rawEvents: [],
  artifacts: [],
  lastEventAt: null,
  resetForJob: (jobId) => set((state) => resetState(state, jobId)),
  hydrateJob: (job) => set((state) => hydrateJobState(state, job)),
  hydrateEvents: (events) =>
    set((state) => ({
      rawEvents: mergeEvents(events, state.rawEvents),
      lastEventAt: events.length > 0 ? (events[events.length - 1].createdAt ?? state.lastEventAt) : state.lastEventAt,
    })),
  hydrateArtifacts: (artifacts) => set({ artifacts }),
  appendEvent: (event) =>
    set((state) => ({
      rawEvents: mergeEvents(state.rawEvents, [event]),
      job: reduceJobFromEvent(state.job, event),
      lastEventAt: event.createdAt ?? state.lastEventAt,
    })),
  setConnectionState: (connectionState) =>
    set((state) => (state.connectionState === connectionState ? state : { connectionState })),
}));
