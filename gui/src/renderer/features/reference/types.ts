import type {
  GuiArtifact,
  GuiJob,
  IngestionKnowledgeReport,
  MangaSeriesSummary,
  ReferenceSetSummary,
  TranslatorProfileSummary,
} from "../../api/jobs";

export type ReferenceExtractionForm = {
  referenceSetId: string;
};

export type ReferenceIngestionForm = {
  referenceSetId: string;
  mangaSelection: string;
  newMangaLabel: string;
  translatorSelection: string;
  newTranslatorLabel: string;
  useForTerminology: boolean;
  useForStyle: boolean;
  analysisDepth: "quick_read" | "deep_read";
};

export type ReferenceImportForm = {
  sourceFolder: string;
  label: string;
  language: string;
  referenceKind: "source" | "translator";
  mangaSelection: string;
  newMangaLabel: string;
  translatorSelection: string;
  newTranslatorLabel: string;
};

export type QueuedReferenceFolder = {
  id: string;
  sourceFolder: string;
  label: string;
};

export type ImportedReferenceBinding = {
  referenceSetId: string;
  label: string;
  referenceKind?: "source" | "translator";
  mangaId?: string;
  mangaLabel?: string;
  translatorId?: string;
  translatorLabel?: string;
  chapterId?: string;
  chapterTitle?: string;
  language?: string;
};

export type WorklistJobSnapshot = {
  extractionJob: GuiJob | null;
  ingestionJob: GuiJob | null;
};

export type ArtifactPreviewState = {
  previewArtifact: GuiArtifact | null;
  previewData: unknown;
  editorValue: string;
  previewStatus: string;
};

export type ReferenceMangaOption = MangaSeriesSummary;

export type ReferenceTranslatorOption = TranslatorProfileSummary;

export type ReferenceJobSummaryLike = GuiJob | null;

export type IngestionReportLike = IngestionKnowledgeReport | undefined;

export type IngestionResultSummary = {
  terminology: number;
  characters: number;
  candidateTerms: number;
  candidateCharacters: number;
  manifestLabel: string | null;
};

export type ReferenceSetMap = Map<string, ReferenceSetSummary>;

export type LatestReferenceJobResolver = (
  jobs: GuiJob[],
  referenceSetId: string,
  type: "reference_extraction" | "reference_ingestion"
) => GuiJob | null;

export type ReferenceWorklistActionHandlers = {
  selectReferenceMaterial: (referenceSetId: string, label: string) => void;
  runWorklistExtraction: () => Promise<void>;
  runWorklistIngestion: () => Promise<void>;
  runWorklistItemExtraction: (
    referenceSet: ReferenceSetSummary,
    worklistEntry: ImportedReferenceBinding | null
  ) => Promise<void>;
  runWorklistItemIngestion: (
    referenceSet: ReferenceSetSummary,
    worklistEntry: ImportedReferenceBinding | null
  ) => Promise<void>;
};
