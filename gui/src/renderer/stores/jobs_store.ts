import { create } from "zustand";
import type { PathValidationSummary, SourcePreflightResult } from "../types/settings";

export type TranslationMode = "quick" | "reference_style" | "local_style" | "learning_style";

export type TranslationDraft = {
  translationMode: TranslationMode;
  sourceFolder: string;
  targetLanguage: string;
  profileSelection: string;
  translatorSelection: string;
  learningProfileSelection: string;
  newMangaLabel: string;
  newTranslatorLabel: string;
  newLearningTranslatorLabel: string;
  chapterSelection: string;
  sourceChapterSelection: string;
  newChapterTitle: string;
  referenceLabel: string;
  glossaryMode: "canonical" | "reference_only" | "disabled";
  qualityCheck: boolean;
};

export type ReferenceExtractionDraft = {
  referenceLabel: string;
  targetLanguage: string;
};

export type ReferenceIngestionDraft = {
  referenceLabel: string;
  mangaLabel: string;
  chapterLabel: string;
  glossaryMode: "canonical" | "reference_only" | "disabled";
};

export const DEFAULT_TRANSLATION_DRAFT: TranslationDraft = {
  translationMode: "quick",
  sourceFolder: "",
  targetLanguage: "zh-TW",
  profileSelection: "",
  translatorSelection: "",
  learningProfileSelection: "",
  newMangaLabel: "",
  newTranslatorLabel: "",
  newLearningTranslatorLabel: "",
  chapterSelection: "",
  sourceChapterSelection: "",
  newChapterTitle: "",
  referenceLabel: "",
  glossaryMode: "canonical",
  qualityCheck: false,
};

export const DEFAULT_REFERENCE_EXTRACTION_DRAFT: ReferenceExtractionDraft = {
  referenceLabel: "",
  targetLanguage: "zh-TW",
};

export const DEFAULT_REFERENCE_INGESTION_DRAFT: ReferenceIngestionDraft = {
  referenceLabel: "",
  mangaLabel: "",
  chapterLabel: "",
  glossaryMode: "canonical",
};

type JobsPageState = {
  translationDraft: TranslationDraft;
  referenceExtractionDraft: ReferenceExtractionDraft;
  referenceIngestionDraft: ReferenceIngestionDraft;
  translationPathValidation: PathValidationSummary | null;
  preflightResult: SourcePreflightResult | null;
  orderedImageIds: string[];
  status: string;
  lastPickedSourceFolder: string;
  preflightDraftFingerprint: string | null;
  setTranslationDraft: (updater: TranslationDraft | ((current: TranslationDraft) => TranslationDraft)) => void;
  setReferenceExtractionDraft: (
    updater:
      | ReferenceExtractionDraft
      | ((current: ReferenceExtractionDraft) => ReferenceExtractionDraft)
  ) => void;
  setReferenceIngestionDraft: (
    updater:
      | ReferenceIngestionDraft
      | ((current: ReferenceIngestionDraft) => ReferenceIngestionDraft)
  ) => void;
  setTranslationPathValidation: (value: PathValidationSummary | null) => void;
  setPreflightResult: (value: SourcePreflightResult | null) => void;
  setOrderedImageIds: (updater: string[] | ((current: string[]) => string[])) => void;
  setStatus: (value: string) => void;
  setLastPickedSourceFolder: (value: string) => void;
  setPreflightDraftFingerprint: (value: string | null) => void;
  clearPreflightState: () => void;
};

function resolveUpdater<T>(current: T, updater: T | ((current: T) => T)): T {
  return typeof updater === "function" ? (updater as (current: T) => T)(current) : updater;
}

export const useJobsPageStore = create<JobsPageState>((set) => ({
  translationDraft: DEFAULT_TRANSLATION_DRAFT,
  referenceExtractionDraft: DEFAULT_REFERENCE_EXTRACTION_DRAFT,
  referenceIngestionDraft: DEFAULT_REFERENCE_INGESTION_DRAFT,
  translationPathValidation: null,
  preflightResult: null,
  orderedImageIds: [],
  status: "Ready.",
  lastPickedSourceFolder: "",
  preflightDraftFingerprint: null,
  setTranslationDraft: (updater) =>
    set((state) => ({
      translationDraft: resolveUpdater(state.translationDraft, updater),
    })),
  setReferenceExtractionDraft: (updater) =>
    set((state) => ({
      referenceExtractionDraft: resolveUpdater(state.referenceExtractionDraft, updater),
    })),
  setReferenceIngestionDraft: (updater) =>
    set((state) => ({
      referenceIngestionDraft: resolveUpdater(state.referenceIngestionDraft, updater),
    })),
  setTranslationPathValidation: (translationPathValidation) => set({ translationPathValidation }),
  setPreflightResult: (preflightResult) => set({ preflightResult }),
  setOrderedImageIds: (updater) =>
    set((state) => ({
      orderedImageIds: resolveUpdater(state.orderedImageIds, updater),
    })),
  setStatus: (status) => set({ status }),
  setLastPickedSourceFolder: (lastPickedSourceFolder) => set({ lastPickedSourceFolder }),
  setPreflightDraftFingerprint: (preflightDraftFingerprint) => set({ preflightDraftFingerprint }),
  clearPreflightState: () =>
    set({
      preflightResult: null,
      orderedImageIds: [],
      translationPathValidation: null,
      preflightDraftFingerprint: null,
    }),
}));
