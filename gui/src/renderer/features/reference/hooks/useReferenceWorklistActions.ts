import type { QueryClient } from "@tanstack/react-query";
import type {
  GuiJob,
  ImportedReferenceSet,
  ReferenceExtractionPayload,
  ReferenceIngestionPayload,
} from "../../../api/jobs";
import type {
  ImportedReferenceBinding,
  LatestReferenceJobResolver,
  QueuedReferenceFolder,
  ReferenceImportForm,
  ReferenceIngestionForm,
} from "../types";
import { runWorklistExtraction, runWorklistItemExtraction } from "./referenceWorklistExtraction";
import { importQueuedReferenceFolders } from "./referenceWorklistImport";
import { runWorklistIngestion, runWorklistItemIngestion } from "./referenceWorklistIngestion";
import { selectReferenceMaterial } from "./referenceWorklistSelection";

export type BindingResolution = {
  mangaId: string;
  mangaLabel: string;
  translatorId?: string;
  translatorLabel?: string;
  chapterId?: string;
  chapterTitle?: string;
};

export type WorklistActionParams = {
  queuedReferenceFolders: QueuedReferenceFolder[];
  referenceWorklist: ImportedReferenceBinding[];
  importForm: ReferenceImportForm;
  ingestionForm: ReferenceIngestionForm;
  referenceJobs: GuiJob[];
  worklistEntriesMissingExtraction: ImportedReferenceBinding[];
  styleOptionDisabledForWorklist: boolean;
  setPageStatus: (value: string) => void;
  setIsWorklistImporting: (value: boolean) => void;
  setIsWorklistExtracting: (value: boolean) => void;
  setIsWorklistIngesting: (value: boolean) => void;
  appendWorklistEntries: (entries: ImportedReferenceBinding[]) => void;
  clearQueuedReferenceFolders: () => void;
  setImportForm: (updater: (current: ReferenceImportForm) => ReferenceImportForm) => void;
  setExtractionForm: (updater: (current: { referenceSetId: string }) => { referenceSetId: string }) => void;
  setIngestionForm: (updater: (current: ReferenceIngestionForm) => ReferenceIngestionForm) => void;
  setSelectedReferenceJobId: (jobId: string | null) => void;
  resolveImportBinding: () => Promise<BindingResolution | null>;
  resolveProfileAndChapter: () => Promise<
    (BindingResolution & { translatorId: string; translatorLabel: string; chapterId: string }) | null
  >;
  createChapterForBinding: (
    mangaId: string,
    translatorId: string,
    chapterTitle: string,
  ) => Promise<{ chapterId: string; chapterTitle: string }>;
  importReferenceFolderFn: (payload: {
    sourceFolder: string;
    label: string;
    language: string;
    referenceKind: "source" | "translator";
    mangaId?: string;
    mangaLabel?: string;
    translatorId?: string;
    translatorLabel?: string;
    chapterId?: string;
    chapterTitle?: string;
  }) => Promise<{ referenceSet: ImportedReferenceSet }>;
  createReferenceExtractionJobFn: (payload: ReferenceExtractionPayload) => Promise<GuiJob>;
  createReferenceIngestionJobFn: (payload: ReferenceIngestionPayload) => Promise<GuiJob>;
  createReferenceIngestionJobsFn: (payloads: ReferenceIngestionPayload[]) => Promise<{ jobs: GuiJob[] }>;
  normalizeChapterTitleLabel: (value: string | null | undefined, fallback?: string) => string;
  folderBaseName: (sourceFolder: string) => string;
  normalizeReferenceLanguage: (value: string) => string;
  isSourceReferenceKind: (value: string | null | undefined) => value is "source";
  latestReferenceJobForSet: LatestReferenceJobResolver;
  queryClient: QueryClient;
};

export function useReferenceWorklistActions(params: WorklistActionParams) {
  return {
    selectReferenceMaterial: (id: string, label: string) => selectReferenceMaterial(id, label, params),
    importQueuedReferenceFolders: () => importQueuedReferenceFolders(params),
    runWorklistExtraction: () => runWorklistExtraction(params),
    runWorklistIngestion: () => runWorklistIngestion(params),
    runWorklistItemExtraction: (
      set: Parameters<typeof runWorklistItemExtraction>[0],
      entry: ImportedReferenceBinding | null,
    ) => runWorklistItemExtraction(set, entry, params),
    runWorklistItemIngestion: (
      set: Parameters<typeof runWorklistItemIngestion>[0],
      entry: ImportedReferenceBinding | null,
    ) => runWorklistItemIngestion(set, entry, params),
  };
}
