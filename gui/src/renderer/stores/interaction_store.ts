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

export const useInteractionStore = create<InteractionState>((set) => ({
  autoFollowByJob: {},
  eventKeysByJob: {},
  eventsByJob: {},
  unreadByJob: {},
  setAutoFollow: (jobId, autoFollow) =>
    set((state) => {
      const current = state.autoFollowByJob[jobId] ?? true;
      if (current === autoFollow) {
        return state;
      }
      return {
        autoFollowByJob: {
          ...state.autoFollowByJob,
          [jobId]: autoFollow,
        },
      };
    }),
  replaceEvents: (jobId, events) =>
    set((state) => {
      const nextKeys = events.map(buildEventKey);
      const currentKeys = state.eventKeysByJob[jobId] ?? [];
      const sameKeys =
        currentKeys.length === nextKeys.length &&
        currentKeys.every((key, index) => key === nextKeys[index]);
      const autoFollow = state.autoFollowByJob[jobId] ?? true;
      if (sameKeys) {
        return state;
      }
      return {
        eventKeysByJob: {
          ...state.eventKeysByJob,
          [jobId]: nextKeys,
        },
        eventsByJob: {
          ...state.eventsByJob,
          [jobId]: events,
        },
        unreadByJob: {
          ...state.unreadByJob,
          [jobId]: autoFollow ? 0 : state.unreadByJob[jobId] ?? 0,
        },
      };
    }),
  appendEvent: (jobId, event) =>
    set((state) => {
      const nextKey = buildEventKey(event);
      const currentKeys = state.eventKeysByJob[jobId] ?? [];
      if (currentKeys.includes(nextKey)) {
        return state;
      }
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
    }),
  clearUnread: (jobId) =>
    set((state) => {
      const current = state.unreadByJob[jobId] ?? 0;
      if (current === 0) {
        return state;
      }
      return {
        unreadByJob: {
          ...state.unreadByJob,
          [jobId]: 0,
        },
      };
    }),
}));
