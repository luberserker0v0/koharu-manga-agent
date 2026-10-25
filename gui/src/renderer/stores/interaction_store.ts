import { create } from "zustand";
import type { GuiJobEvent } from "../api/jobs";

function buildEventKey(event: GuiJobEvent): string {
  if (event.id != null) {
    return `id:${event.id}`;
  }
  const createdAt = event.createdAt ?? "live";
  const payload = JSON.stringify(event.payload ?? null);
  return `sig:${createdAt}:${event.type}:${payload}`;
}

type InteractionState = {
  autoFollowByJob: Record<string, boolean>;
  eventKeysByJob: Record<string, string[]>;
  eventsByJob: Record<string, GuiJobEvent[]>;
  unreadByJob: Record<string, number>;
  setAutoFollow: (jobId: string, value: boolean) => void;
  replaceEvents: (jobId: string, events: GuiJobEvent[]) => void;
  appendEvent: (jobId: string, event: GuiJobEvent) => void;
  clearUnread: (jobId: string) => void;
};

function setAutoFollowState(state: InteractionState, jobId: string, autoFollow: boolean) {
  if ((state.autoFollowByJob[jobId] ?? true) === autoFollow) return state;
  return { autoFollowByJob: { ...state.autoFollowByJob, [jobId]: autoFollow } };
}

function replaceEventsState(state: InteractionState, jobId: string, events: GuiJobEvent[]) {
  const nextKeys = events.map(buildEventKey);
  const currentKeys = state.eventKeysByJob[jobId] ?? [];
  const sameKeys = currentKeys.length === nextKeys.length && currentKeys.every((key, index) => key === nextKeys[index]);
  if (sameKeys) return state;
  const autoFollow = state.autoFollowByJob[jobId] ?? true;
  return {
    eventKeysByJob: { ...state.eventKeysByJob, [jobId]: nextKeys },
    eventsByJob: { ...state.eventsByJob, [jobId]: events },
    unreadByJob: {
      ...state.unreadByJob,
      [jobId]: autoFollow ? 0 : (state.unreadByJob[jobId] ?? 0),
    },
  };
}

function appendEventState(state: InteractionState, jobId: string, event: GuiJobEvent) {
  const nextKey = buildEventKey(event);
  const currentKeys = state.eventKeysByJob[jobId] ?? [];
  if (currentKeys.includes(nextKey)) return state;
  const autoFollow = state.autoFollowByJob[jobId] ?? true;
  return {
    eventKeysByJob: {
      ...state.eventKeysByJob,
      [jobId]: [...currentKeys, nextKey],
    },
    eventsByJob: {
      ...state.eventsByJob,
      [jobId]: [...(state.eventsByJob[jobId] ?? []), event],
    },
    unreadByJob: {
      ...state.unreadByJob,
      [jobId]: autoFollow ? 0 : (state.unreadByJob[jobId] ?? 0) + 1,
    },
  };
}

function clearUnreadState(state: InteractionState, jobId: string) {
  if ((state.unreadByJob[jobId] ?? 0) === 0) return state;
  return { unreadByJob: { ...state.unreadByJob, [jobId]: 0 } };
}

export const useInteractionStore = create<InteractionState>((set) => ({
  autoFollowByJob: {},
  eventKeysByJob: {},
  eventsByJob: {},
  unreadByJob: {},
  setAutoFollow: (jobId, autoFollow) => set((state) => setAutoFollowState(state, jobId, autoFollow)),
  replaceEvents: (jobId, events) => set((state) => replaceEventsState(state, jobId, events)),
  appendEvent: (jobId, event) => set((state) => appendEventState(state, jobId, event)),
  clearUnread: (jobId) => set((state) => clearUnreadState(state, jobId)),
}));
