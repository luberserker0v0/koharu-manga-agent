import { create } from "zustand";
import type { RouteKey } from "../app/routes";

type UiState = {
  hydrated: boolean;
  selectedPage: RouteKey;
  selectedJobId: string | null;
  selectedMangaId: string | null;
  selectedTranslatorId: string | null;
  markHydrated: () => void;
  setSelectedPage: (page: RouteKey) => void;
  setSelectedJobId: (jobId: string | null) => void;
  setSelectedMangaId: (mangaId: string | null) => void;
  setSelectedTranslatorId: (translatorId: string | null) => void;
};

export const useUiStore = create<UiState>((set) => ({
  hydrated: false,
  selectedPage: "job",
  selectedJobId: null,
  selectedMangaId: null,
  selectedTranslatorId: null,
  markHydrated: () =>
    set((state) => (state.hydrated ? state : { hydrated: true })),
  setSelectedPage: (selectedPage) =>
    set((state) => (state.selectedPage === selectedPage ? state : { selectedPage })),
  setSelectedJobId: (selectedJobId) =>
    set((state) => (state.selectedJobId === selectedJobId ? state : { selectedJobId })),
  setSelectedMangaId: (selectedMangaId) =>
    set((state) => (state.selectedMangaId === selectedMangaId ? state : { selectedMangaId })),
  setSelectedTranslatorId: (selectedTranslatorId) =>
    set((state) =>
      state.selectedTranslatorId === selectedTranslatorId ? state : { selectedTranslatorId }
    ),
}));
