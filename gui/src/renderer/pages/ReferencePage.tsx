import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  cancelExtractionReview,
  confirmExtractionReview,
  createChapter,
  createManga,
  createReferenceExtractionJob,
  createReferenceIngestionJob,
  createReferenceIngestionJobs,
  createTranslatorProfile,
  deleteIngestionKnowledgeReport,
  deleteJob,
  deleteReferenceExtraction,
  deleteReferenceSet,
  finishExtractionReviewEditor,
  getBilingualEvidence,
  getExtractionReview,
  getJobs,
  getIngestionKnowledgeReport,
  getMangaSeries,
  getReferenceSets,
  importReferenceFolder,
  runBilingualEnrichment,
  runReferenceDeepReview,
  retryJob,
  saveExtractionReviewOrder,
  startExtractionReview,
  syncExtractionReview,
  updateBilingualEvidenceLink,
  type BilingualEvidenceDocument,
  type ExtractionReviewDocument,
  type GuiJob,
  type IngestionKnowledgeReport,
  type ReferenceSetSummary,
} from "../api/jobs";
import {
  CREATE_NEW_MANGA_VALUE,
  MangaSelector,
} from "../components/MangaSelector";
import {
  CREATE_NEW_TRANSLATOR_VALUE,
  resolveSelectedTranslator,
  TranslatorSelector,
} from "../components/TranslatorSelector";
import {
  closeKoharuEditor,
  confirmDialog,
  onKoharuEditorClosed,
  openKoharuEditor,
  openDesktopPath,
  pickDirectory,
  pickDirectories,
} from "../services/desktop_api";
import {
  DEFAULT_REFERENCE_LANGUAGE,
  normalizeReferenceLanguage,
  REFERENCE_LANGUAGE_OPTIONS,
} from "../constants/languages";
import { ArtifactEditorPane } from "../features/reference/components/ArtifactEditorPane";
import { IngestionReportPane } from "../features/reference/components/IngestionReportPane";
import { BilingualEvidencePane } from "../features/reference/components/BilingualEvidencePane";
import { ExtractionReviewPane } from "../features/reference/components/ExtractionReviewPane";
import { ReferenceImportPane } from "../features/reference/components/ReferenceImportPane";
import { ReferenceJobsPane } from "../features/reference/components/ReferenceJobsPane";
import { ReferenceWorklistPane } from "../features/reference/components/ReferenceWorklistPane";
import {
  displayJobType,
  ingestionResultSummary,
  selectedJobSummary,
} from "../features/reference/formatters/referenceJobs";
import { useReferenceArtifacts } from "../features/reference/hooks/useReferenceArtifacts";
import { useReferenceJobActions } from "../features/reference/hooks/useReferenceJobActions";
import { useReferenceWorklistActions } from "../features/reference/hooks/useReferenceWorklistActions";
import { useReferenceWorklistState } from "../features/reference/hooks/useReferenceWorklistState";
import {
  type ImportedReferenceBinding,
  type QueuedReferenceFolder,
  type ReferenceExtractionForm,
  type ReferenceImportForm,
  type ReferenceIngestionForm,
  type WorklistJobSnapshot,
} from "../features/reference/types";
import { PageHeader } from "../features/shared/components/PageHeader";
import { useLanguageStore } from "../stores/language_store";
import { useUiStore } from "../stores/ui_store";
import { subscribeToJobsStream } from "../stream/job_stream";

const REFERENCE_WORKLIST_STORAGE_KEY = "reference-page.worklist.v1";
const REFERENCE_IMPORT_QUEUE_STORAGE_KEY = "reference-page.import-queue.v1";
const LEGACY_REFERENCE_WORKLIST_STORAGE_KEY = "reference-page.batch.v1";
const SOURCE_REFERENCE_TRANSLATOR_LABEL = "Original";

const DEFAULT_EXTRACTION_FORM: ReferenceExtractionForm = {
  referenceSetId: "",
};

const DEFAULT_INGESTION_FORM: ReferenceIngestionForm = {
  referenceSetId: "",
  mangaSelection: "",
  newMangaLabel: "",
  translatorSelection: "",
  newTranslatorLabel: "",
  useForTerminology: true,
  useForStyle: true,
  analysisDepth: "quick_read",
};

const DEFAULT_IMPORT_FORM: ReferenceImportForm = {
  sourceFolder: "",
  label: "",
  language: DEFAULT_REFERENCE_LANGUAGE,
  referenceKind: "source",
  mangaSelection: "",
  newMangaLabel: "",
  translatorSelection: "",
  newTranslatorLabel: "",
};

function folderBaseName(sourceFolder: string) {
  return sourceFolder.split(/[\\/]/).filter(Boolean).pop() || sourceFolder;
}

function normalizeChapterTitleLabel(value: string | null | undefined, fallback = "Untitled chapter") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function createQueuedReferenceFolder(sourceFolder: string): QueuedReferenceFolder {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sourceFolder,
    label: folderBaseName(sourceFolder),
  };
}

function isSourceReferenceKind(value: string | null | undefined): value is "source" {
  return value === "source";
}

function isTranslatorReferenceKind(value: string | null | undefined): value is "translator" {
  return value === "translator";
}

function numericSortValue(label: string) {
  const trimmed = label.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const match = trimmed.match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function sortQueuedReferenceFolders(items: QueuedReferenceFolder[]) {
  return [...items].sort((left, right) => {
    const leftNumber = numericSortValue(left.label);
    const rightNumber = numericSortValue(right.label);
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
    if (leftNumber !== null && rightNumber === null) {
      return -1;
    }
    if (leftNumber === null && rightNumber !== null) {
      return 1;
    }
    return left.label.localeCompare(right.label, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function latestReferenceJobForSet(jobs: GuiJob[], referenceSetId: string, type: GuiJob["type"]) {
  return (
    jobs
      .filter(
        (job) =>
          job.type === type &&
          typeof job.payload.referenceSetId === "string" &&
          job.payload.referenceSetId === referenceSetId
      )
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null
  );
}

function statusPillClass(status: string) {
  if (status === "succeeded") {
    return "pill pill-success";
  }
  if (status === "failed" || status === "canceled") {
    return "pill pill-error";
  }
  if (status === "queued" || status === "running") {
    return "pill pill-warn";
  }
  return "pill pill-neutral";
}

function statusLabel(status: string | null | undefined) {
  switch (status) {
    case "queued":
      return "\u6392\u968A\u4E2D";
    case "running":
      return "\u57F7\u884C\u4E2D";
    case "succeeded":
      return "\u5DF2\u6210\u529F";
    case "failed":
      return "\u5931\u6557";
    case "canceled":
      return "\u5DF2\u53D6\u6D88";
    default:
      return "\u5C1A\u672A\u77E5";
  }
}

function prettyArtifactKind(kind: string) {
  switch (kind) {
    case "reference_scene":
      return "Reference Scene";
    case "reference_texts":
      return "OCR / Text";
    case "glossary":
      return "\u5DF2\u78BA\u8A8D\u5C08\u6709\u540D\u8A5E";
    case "candidate_terms":
      return "\u5F85\u78BA\u8A8D\u5C08\u6709\u540D\u8A5E";
    case "story_context":
      return "\u6545\u4E8B\u8108\u7D61";
    case "style_profile":
      return "\u7FFB\u8B6F\u98A8\u683C";
    case "translation_context":
      return "\u7FFB\u8B6F\u4E0A\u4E0B\u6587";
    default:
      return kind.replaceAll("_", " ");
  }
}

function isEditableArtifact(kind: string) {
  return [
    "reference_scene",
    "reference_texts",
    "glossary",
    "candidate_terms",
    "story_context",
    "style_profile",
    "translation_context",
  ].includes(kind);
}

function ingestionUiWarnings(
  report: IngestionKnowledgeReport | undefined,
  translatorLabel: string | null | undefined
) {
  const warnings: string[] = [];
  if (!report) {
    return warnings;
  }

  if (translatorLabel === "Original") {
    warnings.push(
      "\u76EE\u524D\u6B64 Ingestion \u4F86\u81EA\u539F\u6587 reference\uff0c\u53EA\u6703\u7D2F\u7A4D\u4E0A\u4E0B\u6587\u8207\u5C08\u6709\u540D\u8A5E\uff0C\u4E0D\u6703\u5EFA\u7ACB\u7FFB\u8B6F\u98A8\u683C\u3002"
    );
  }

  const candidateEntries = Array.isArray(report.candidateTerms?.entries)
    ? (report.candidateTerms.entries as Array<Record<string, unknown>>)
    : [];
  const rejectedCandidates = candidateEntries.filter((entry) => entry?.status === "rejected").length;
  if (rejectedCandidates > 0) {
    warnings.push(
      `\u76EE\u524D\u6709 ${rejectedCandidates} \u7B46\u5019\u9078\u689D\u76EE\u88AB\u62D2\u7D55\uff0c\u8ACB\u6AA2\u67E5\u662F\u5426\u9700\u8981\u88DC\u5145\u8B49\u64DA\u6216\u8ABF\u6574\u5408\u4F75\u908F\u8F2F\u3002`
    );
  }

  const dialogueNarration =
    report.styleProfile &&
    typeof report.styleProfile === "object" &&
    typeof (report.styleProfile as Record<string, unknown>).rules === "object"
      ? (((report.styleProfile as Record<string, unknown>).rules as Record<string, unknown>)
          .dialogueNarration as Record<string, unknown> | undefined)
      : undefined;
  const dialogueRatio =
    typeof dialogueNarration?.dialogueRatio === "number" ? dialogueNarration.dialogueRatio : null;
  const narrationRatio =
    typeof dialogueNarration?.narrationRatio === "number" ? dialogueNarration.narrationRatio : null;
  const dialogueSamples =
    report.styleProfile &&
    typeof report.styleProfile === "object" &&
    typeof (report.styleProfile as Record<string, unknown>).samples === "object"
      ? (((report.styleProfile as Record<string, unknown>).samples as Record<string, unknown>)
          .dialogue as string[] | undefined) || []
      : [];
  const hasNoisyDialogueSample = dialogueSamples.some(
    (sample) =>
      typeof sample === "string" &&
      /(manga\d+\.com|raw|scan|watermark|chapter\s*\d+)/i.test(sample)
  );
  if (dialogueRatio === 0 || narrationRatio === 1 || hasNoisyDialogueSample) {
    warnings.push(
      "\u98A8\u683C\u8B49\u64DA\u4ECD\u5E36\u6709\u660E\u986F\u96DC\u8A0A\uff0c\u76EE\u524D\u66F4\u50CF OCR \u6216\u539F\u59CB\u64F7\u53D6\u7D50\u679C\uff0c\u98A8\u683C\u6458\u8981\u53EF\u80FD\u4E0D\u5920\u7A69\u5B9A\u3002"
    );
  }

  const chapterRecords =
    report.storyContext &&
    typeof report.storyContext === "object" &&
    typeof (report.storyContext as Record<string, unknown>).chapters === "object"
      ? Object.values((report.storyContext as Record<string, unknown>).chapters as Record<string, unknown>)
      : [];
  const hasNoisyKeyLines = chapterRecords.some((chapter) => {
    const keyLines =
      chapter && typeof chapter === "object" && Array.isArray((chapter as Record<string, unknown>).keyLines)
        ? ((chapter as Record<string, unknown>).keyLines as string[])
        : [];
    return keyLines.some((line) => /(manga\d+\.com|raw|scan|watermark|chapter\s*\d+)/i.test(line));
  });
  if (hasNoisyKeyLines) {
    warnings.push(
      "\u6545\u4E8B\u8B49\u64DA\u4E2D\u4ECD\u6709\u96DC\u8A0A\u884C\uff0C\u8ACB\u8996\u60C5\u6CC1\u91CD\u8DD1 Extraction \u6216\u88DC\u5145\u66F4\u4E7E\u6DE8\u7684\u7AE0\u7BC0\u4F86\u6E90\u3002"
    );
  }

  return warnings;
}

export function ReferencePage() {
  const t = useLanguageStore((state) => state.t);
  const queryClient = useQueryClient();
  const setSelectedJobId = useUiStore((state) => state.setSelectedJobId);
  const setSelectedMangaId = useUiStore((state) => state.setSelectedMangaId);
  const setSelectedTranslatorId = useUiStore((state) => state.setSelectedTranslatorId);
  const setSelectedPage = useUiStore((state) => state.setSelectedPage);
  const [extractionForm, setExtractionForm] = useState(DEFAULT_EXTRACTION_FORM);
  const [ingestionForm, setIngestionForm] = useState(DEFAULT_INGESTION_FORM);
  const [importForm, setImportForm] = useState(DEFAULT_IMPORT_FORM);
  const [selectedReferenceJobId, setSelectedReferenceJobId] = useState<string | null>(null);
  const [pageStatus, setPageStatus] = useState("\u5C31\u7DD2\u3002");
  const [selectedReportMangaId, setSelectedReportMangaId] = useState<string>("");
  const [selectedReportTranslatorId, setSelectedReportTranslatorId] = useState<string>("");
  const [activeReviewSessionId, setActiveReviewSessionId] = useState<string | null>(null);
  const [activeReviewReferenceSetId, setActiveReviewReferenceSetId] = useState<string | null>(null);
  const closingReviewSessionRef = useRef<string | null>(null);
  const {
    queuedReferenceFolders,
    setQueuedReferenceFolders,
    referenceWorklist,
    setReferenceWorklist,
    isWorklistImporting,
    setIsWorklistImporting,
    isWorklistExtracting,
    setIsWorklistExtracting,
    isWorklistIngesting,
    setIsWorklistIngesting,
    appendQueuedReferenceFolders,
    removeQueuedReferenceFolder,
    updateQueuedReferenceFolderLabel,
    clearQueuedReferenceFolders,
    appendWorklistEntries,
    removeWorklistEntry,
  } = useReferenceWorklistState({
    importQueueStorageKey: REFERENCE_IMPORT_QUEUE_STORAGE_KEY,
    worklistStorageKey: REFERENCE_WORKLIST_STORAGE_KEY,
    legacyWorklistStorageKey: LEGACY_REFERENCE_WORKLIST_STORAGE_KEY,
  });

  const referenceSetsQuery = useQuery({
    queryKey: ["referenceSets"],
    queryFn: getReferenceSets,
  });
  const mangaSeriesQuery = useQuery({
    queryKey: ["mangaSeries"],
    queryFn: getMangaSeries,
  });
  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: getJobs,
  });
  useEffect(() => {
    return subscribeToJobsStream({
      onEvent: (message) => {
        if (message.type === "jobs.snapshot" && Array.isArray(message.jobs)) {
          queryClient.setQueryData(["jobs"], { jobs: message.jobs as GuiJob[] });
          return;
        }
        if (message.kind !== "job" || !message.job || typeof message.job !== "object") {
          return;
        }
        const incoming = message.job as GuiJob;
        if (incoming.type === "reference_extraction" && incoming.status === "succeeded") {
          void queryClient.invalidateQueries({ queryKey: ["referenceSets"] });
          const referenceSetId = incoming.payload?.referenceSetId;
          if (typeof referenceSetId === "string") {
            void queryClient.invalidateQueries({ queryKey: ["extraction-review", referenceSetId] });
          }
        }
        queryClient.setQueryData<{ jobs: GuiJob[] }>(["jobs"], (current) => {
          const jobs = current?.jobs || [];
          const existing = jobs.find((job) => job.id === incoming.id);
          const streamEvent = {
            id: -Date.now(),
            type: message.type,
            payload: message.payload,
            createdAt: message.createdAt || new Date().toISOString(),
          };
          const nextJob: GuiJob = {
            ...incoming,
            events: [...(existing?.events || []), streamEvent],
            artifacts: incoming.artifacts || existing?.artifacts || [],
          };
          const index = jobs.findIndex((job) => job.id === incoming.id);
          if (index < 0) return { jobs: [nextJob, ...jobs] };
          const nextJobs = [...jobs];
          nextJobs[index] = nextJob;
          return { jobs: nextJobs };
        });
      },
    });
  }, [queryClient]);
  const ingestionReportQuery = useQuery({
    queryKey: ["ingestion-knowledge-report", selectedReportMangaId, selectedReportTranslatorId],
    queryFn: () => getIngestionKnowledgeReport(selectedReportMangaId, selectedReportTranslatorId),
    enabled: Boolean(selectedReportMangaId && selectedReportTranslatorId),
  });
  const {
    artifactsQuery,
    previewArtifact,
    previewData,
    editorValue,
    previewStatus,
    setEditorValue,
    loadArtifact,
    saveEditedArtifact,
    deleteArtifact,
    resetPreview,
  } = useReferenceArtifacts(selectedReferenceJobId);

  const referenceSetOptions = useMemo(
    () => referenceSetsQuery.data?.referenceSets || [],
    [referenceSetsQuery.data]
  );
  useEffect(() => {
    const editingReference = referenceSetOptions.find(
      (entry) => entry.reviewStatus === "editing" && entry.activeReviewSessionId
    );
    if (!editingReference?.activeReviewSessionId) return;
    setActiveReviewSessionId(editingReference.activeReviewSessionId);
    setActiveReviewReferenceSetId(editingReference.id);
  }, [referenceSetOptions]);
  const mangaSeriesOptions = useMemo(
    () => mangaSeriesQuery.data?.series || [],
    [mangaSeriesQuery.data]
  );
  useEffect(() => {
    if (!referenceSetsQuery.data) return;
    const existingIds = new Set(referenceSetOptions.map((entry) => entry.id));
    const referenceById = new Map(referenceSetOptions.map((entry) => [entry.id, entry]));
    const mangaLabelById = new Map(
      mangaSeriesOptions.map((entry) => [entry.mangaId, entry.label])
    );
    setReferenceWorklist((current) => {
      let changed = false;
      const next = current
        .filter((entry) => {
          const exists = existingIds.has(entry.referenceSetId);
          if (!exists) changed = true;
          return exists;
        })
        .map((entry) => {
          const referenceSet = referenceById.get(entry.referenceSetId);
          const mangaId = referenceSet?.mangaId || entry.mangaId;
          const mangaLabel = mangaId
            ? mangaLabelById.get(mangaId) || referenceSet?.mangaLabel || entry.mangaLabel
            : referenceSet?.mangaLabel || entry.mangaLabel;
          if (mangaId === entry.mangaId && mangaLabel === entry.mangaLabel) {
            return entry;
          }
          changed = true;
          return { ...entry, mangaId: mangaId || undefined, mangaLabel: mangaLabel || undefined };
        });
      return changed ? next : current;
    });
  }, [mangaSeriesOptions, referenceSetOptions, referenceSetsQuery.data, setReferenceWorklist]);
  const selectedManga = useMemo(() => {
    return mangaSeriesOptions.find((entry) => entry.mangaId === ingestionForm.mangaSelection) || null;
  }, [ingestionForm.mangaSelection, mangaSeriesOptions]);
  const selectedReferenceSetSummary = useMemo(
    () =>
      referenceSetOptions.find((referenceSet) => referenceSet.id === extractionForm.referenceSetId) || null,
    [extractionForm.referenceSetId, referenceSetOptions]
  );
  const extractionReviewQuery = useQuery<{ review: ExtractionReviewDocument }>({
    queryKey: ["extraction-review", selectedReferenceSetSummary?.id],
    queryFn: () => getExtractionReview(selectedReferenceSetSummary?.id || ""),
    enabled: Boolean(selectedReferenceSetSummary?.id && selectedReferenceSetSummary.extractionAvailable),
    retry: false,
  });
  useEffect(() => {
    const review = extractionReviewQuery.data?.review;
    if (review?.status === "editing" && review.activeSessionId) {
      setActiveReviewSessionId(review.activeSessionId);
      setActiveReviewReferenceSetId(review.referenceSetId);
    }
  }, [extractionReviewQuery.data?.review]);
  const availableTranslators = useMemo(() => {
    return selectedManga?.translators || [];
  }, [selectedManga]);
  const selectedTranslator = useMemo(
    () => resolveSelectedTranslator(ingestionForm.translatorSelection, availableTranslators),
    [availableTranslators, ingestionForm.translatorSelection]
  );
  const selectedIngestionManga = selectedManga;
  const selectedIngestionTranslator = selectedTranslator;
  const selectedImportManga = useMemo(() => {
    return mangaSeriesOptions.find((entry) => entry.mangaId === importForm.mangaSelection) || null;
  }, [importForm.mangaSelection, mangaSeriesOptions]);
  const availableImportTranslators = useMemo(() => {
    return selectedImportManga?.translators || [];
  }, [selectedImportManga]);
  const selectedImportTranslator = useMemo(
    () => resolveSelectedTranslator(importForm.translatorSelection, availableImportTranslators),
    [availableImportTranslators, importForm.translatorSelection]
  );
  const selectedReportManga = useMemo(
    () => mangaSeriesOptions.find((entry) => entry.mangaId === selectedReportMangaId) || null,
    [mangaSeriesOptions, selectedReportMangaId]
  );
  const availableReportTranslators = useMemo(
    () => selectedReportManga?.translators || [],
    [selectedReportManga]
  );
  const selectedReportTranslator = useMemo(
    () =>
      availableReportTranslators.find((entry) => entry.translatorId === selectedReportTranslatorId) || null,
    [availableReportTranslators, selectedReportTranslatorId]
  );
  const selectedReportTranslatorIsSource = useMemo(
    () => /^(原文|original|source)$/i.test(String(selectedReportTranslator?.label || "").trim()),
    [selectedReportTranslator]
  );
  const selectedDeletionManga = selectedReportManga || selectedIngestionManga;
  const selectedDeletionTranslator = selectedReportTranslator || selectedIngestionTranslator;
  const referenceJobs = useMemo(() => {
    const jobs = jobsQuery.data?.jobs || [];
    return jobs
      .filter((job) => job.type === "reference_extraction" || job.type === "reference_ingestion")
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }, [jobsQuery.data]);
  const selectedJob = useMemo(
    () => referenceJobs.find((job) => job.id === selectedReferenceJobId) || null,
    [referenceJobs, selectedReferenceJobId]
  );
  const selectedReferenceExtractionJob = useMemo(
    () =>
      extractionForm.referenceSetId
        ? latestReferenceJobForSet(referenceJobs, extractionForm.referenceSetId, "reference_extraction")
        : null,
    [extractionForm.referenceSetId, referenceJobs]
  );
  const selectedReferenceIngestionJob = useMemo(
    () =>
      ingestionForm.referenceSetId
        ? latestReferenceJobForSet(referenceJobs, ingestionForm.referenceSetId, "reference_ingestion")
        : null,
    [ingestionForm.referenceSetId, referenceJobs]
  );
  const worklistJobSnapshots = useMemo(() => {
    const snapshots = new Map<string, WorklistJobSnapshot>();
    for (const entry of referenceWorklist) {
      snapshots.set(entry.referenceSetId, {
        extractionJob: latestReferenceJobForSet(referenceJobs, entry.referenceSetId, "reference_extraction"),
        ingestionJob: latestReferenceJobForSet(referenceJobs, entry.referenceSetId, "reference_ingestion"),
      });
    }
    return snapshots;
  }, [referenceWorklist, referenceJobs]);
  const worklistEntryMap = useMemo(
    () => new Map(referenceWorklist.map((entry) => [entry.referenceSetId, entry])),
    [referenceWorklist]
  );
  const referenceSetMap = useMemo(
    () => new Map(referenceSetOptions.map((entry) => [entry.id, entry])),
    [referenceSetOptions]
  );
  const selectedIngestionSummary = useMemo(
    () => ingestionResultSummary(selectedJob),
    [selectedJob]
  );
  const referenceJobActions = useReferenceJobActions({
    selectedJob,
    selectedReferenceSetSummary,
    selectedReferenceExtractionJob,
    selectedReferenceIngestionJob,
    selectedDeletionManga,
    selectedDeletionTranslator,
    retryReferenceJob: (jobId) => retryMutation.mutate(jobId),
    deleteReferenceJob: (jobId) => deleteJobMutation.mutate(jobId),
    deleteReferenceExtractionResult: (referenceSetId) =>
      deleteReferenceExtractionMutation.mutate(referenceSetId),
    deleteIngestionResult: (mangaId, translatorId) =>
      deleteIngestionMutation.mutate({ mangaId, translatorId }),
    selectReferenceJob: setSelectedReferenceJobId,
    openJobListPage: (job) => {
      setSelectedJobId(job.id);
      if (typeof job.payload.mangaId === "string") {
        setSelectedMangaId(job.payload.mangaId);
      }
      if (typeof job.payload.translatorId === "string") {
        setSelectedTranslatorId(job.payload.translatorId);
      }
      setSelectedPage("job-list");
    },
  });
  const worklistEntriesMissingExtraction = useMemo(
    () =>
      referenceWorklist.filter((entry) => {
        const extractionJob = worklistJobSnapshots.get(entry.referenceSetId)?.extractionJob || null;
        const referenceSet = referenceSetMap.get(entry.referenceSetId);
        return referenceSet?.extractionAvailable !== true && extractionJob?.status !== "succeeded";
      }),
    [referenceSetMap, worklistJobSnapshots, referenceWorklist]
  );
  const hasSourceReferenceInWorklist = useMemo(
    () => referenceWorklist.some((entry) => isSourceReferenceKind(entry.referenceKind)),
    [referenceWorklist]
  );
  const hasTranslatorReferenceInWorklist = useMemo(
    () => referenceWorklist.some((entry) => isTranslatorReferenceKind(entry.referenceKind)),
    [referenceWorklist]
  );
  const selectedAlignmentEntry = useMemo(
    () => worklistEntryMap.get(extractionForm.referenceSetId) || null,
    [extractionForm.referenceSetId, worklistEntryMap]
  );
  const selectedAlignmentIsTranslator = Boolean(
    selectedAlignmentEntry && isTranslatorReferenceKind(selectedAlignmentEntry.referenceKind)
  );
  const bilingualEvidenceQuery = useQuery<BilingualEvidenceDocument>({
    queryKey: [
      "bilingual-evidence",
      selectedAlignmentEntry?.mangaId,
      selectedAlignmentEntry?.translatorId,
    ],
    queryFn: () =>
      getBilingualEvidence(
        selectedAlignmentEntry?.mangaId || "",
        selectedAlignmentEntry?.translatorId || ""
      ),
    enabled: Boolean(
      selectedAlignmentIsTranslator &&
        selectedAlignmentEntry?.mangaId &&
        selectedAlignmentEntry?.translatorId &&
        selectedAlignmentEntry?.chapterId
    ),
    retry: false,
  });
  const styleOptionDisabledForWorklist = referenceWorklist.length > 0 && !hasTranslatorReferenceInWorklist;
  const importBlockedReason = useMemo(() => {
    if (isWorklistImporting) {
      return "正在匯入 Reference，請稍候。";
    }
    if (queuedReferenceFolders.length === 0) {
      return "請先載入至少一筆資料夾，再執行匯入。";
    }
    return null;
  }, [isWorklistImporting, queuedReferenceFolders.length]);
  const extractionBlockedReason = useMemo(() => {
    if (isWorklistExtracting) {
      return "Extraction 執行中，請等待目前批次完成。";
    }
    if (isWorklistIngesting) {
      return "Ingestion 執行中，暫時不能建立新的 Extraction。";
    }
    if (referenceWorklist.length === 0) {
      return "工作區目前為空，請先匯入並加入至少一筆 Reference。";
    }
    return null;
  }, [
    isWorklistExtracting,
    isWorklistIngesting,
    referenceWorklist.length,
  ]);
  const ingestionBlockedReason = useMemo(() => {
    if (isWorklistIngesting) {
      return "Ingestion 執行中，請等待目前批次完成。";
    }
    if (isWorklistExtracting) {
      return "Extraction 執行中，完成後才能建立 Ingestion。";
    }
    if (referenceWorklist.length === 0) {
      return "工作區目前為空，請先匯入並加入至少一筆 Reference。";
    }
    if (worklistEntriesMissingExtraction.length > 0) {
      return `需先完成 Extraction：${worklistEntriesMissingExtraction.map((entry) => entry.label).join(", ")}`;
    }
    if (!ingestionForm.useForTerminology && !ingestionForm.useForStyle) {
      return "請至少選擇一個 Ingestion 用途。";
    }
    if (styleOptionDisabledForWorklist && !ingestionForm.useForTerminology) {
      return "原文 Reference 不會建立翻譯風格，至少需要啟用專有名詞用途。";
    }
    return null;
  }, [
    ingestionForm.useForStyle,
    ingestionForm.useForTerminology,
    isWorklistExtracting,
    isWorklistIngesting,
    referenceWorklist.length,
    styleOptionDisabledForWorklist,
    worklistEntriesMissingExtraction,
  ]);

  useEffect(() => {
    if (!selectedReferenceJobId && referenceJobs.length > 0) {
      setSelectedReferenceJobId(referenceJobs[0].id);
    }
  }, [referenceJobs, selectedReferenceJobId]);

  useEffect(() => {
    if (!selectedReportManga) {
      if (selectedReportTranslatorId) {
        setSelectedReportTranslatorId("");
      }
      return;
    }

    const translatorStillValid = availableReportTranslators.some(
      (entry) => entry.translatorId === selectedReportTranslatorId
    );
    if (translatorStillValid) {
      return;
    }

    setSelectedReportTranslatorId("");
  }, [
    availableReportTranslators,
    selectedReportManga,
    selectedReportTranslatorId,
  ]);

  const extractionMutation = useMutation({
    mutationFn: createReferenceExtractionJob,
    onSuccess: async (job) => {
      setPageStatus("\u5DF2\u5EFA\u7ACB Extraction Job\uFF1A" + job.id);
      setSelectedReferenceJobId(job.id);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => {
      setPageStatus(error instanceof Error ? error.message : "\u5EFA\u7ACB Extraction Job \u5931\u6557\u3002");
    },
  });

  const importMutation = useMutation({
    mutationFn: importReferenceFolder,
    onSuccess: async ({ referenceSet }) => {
      setPageStatus("\u5DF2\u532F\u5165 Reference\uFF1A" + referenceSet.label + " (" + referenceSet.id + ")");
      setImportForm((current) => ({
        ...current,
        label: referenceSet.label,
      }));
      setExtractionForm((current) => ({
        ...current,
        referenceSetId: referenceSet.id,
      }));
      setIngestionForm((current) => ({
        ...current,
        referenceSetId: referenceSet.id,
      }));
      await queryClient.invalidateQueries({ queryKey: ["referenceSets"] });
      await queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
    },
    onError: (error) => {
      setPageStatus(error instanceof Error ? error.message : "\u532F\u5165 Reference \u5931\u6557\u3002");
    },
  });

  const ingestionMutation = useMutation({
    mutationFn: createReferenceIngestionJob,
    onSuccess: async (job) => {
      setPageStatus("\u5DF2\u5EFA\u7ACB Ingestion Job\uFF1A" + job.id);
      setSelectedReferenceJobId(job.id);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => {
      setPageStatus(error instanceof Error ? error.message : "\u5EFA\u7ACB Ingestion Job \u5931\u6557\u3002");
    },
  });

  const deleteReferenceSetMutation = useMutation({
    mutationFn: deleteReferenceSet,
    onSuccess: async ({ deleted, deletedJobs }) => {
      setPageStatus(t("reference.worklist.deleteSuccess", {
        label: deleted.label,
        jobCount: deletedJobs.length,
      }));
      setExtractionForm((current) =>
        current.referenceSetId === deleted.id ? { ...current, referenceSetId: "" } : current
      );
      setIngestionForm((current) =>
        current.referenceSetId === deleted.id ? { ...current, referenceSetId: "" } : current
      );
      setReferenceWorklist((current) => current.filter((entry) => entry.referenceSetId !== deleted.id));
      if (selectedReferenceJobId && deletedJobs.some((job) => job.id === selectedReferenceJobId)) {
        setSelectedReferenceJobId(null);
      }
      resetPreview();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["referenceSets"] }),
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["mangaSeries"] }),
        queryClient.invalidateQueries({ queryKey: ["ingestion-knowledge-report"] }),
        queryClient.invalidateQueries({ queryKey: ["bilingual-evidence"] }),
      ]);
    },
    onError: (error) => {
      setPageStatus(error instanceof Error ? error.message : t("reference.worklist.deleteFailed"));
    },
  });

  const confirmDeleteReference = async (referenceSet: ReferenceSetSummary) => {
    const confirmed = await confirmDialog({
      title: t("reference.worklist.deleteDialog.title"),
      message: t("reference.worklist.deleteDialog.message", {
        label: referenceSet.chapterTitle || referenceSet.label,
        pages: referenceSet.pageCount || 0,
      }),
      detail: t("reference.worklist.deleteDialog.detail"),
      confirmLabel: t("reference.worklist.delete"),
    });
    if (confirmed) {
      deleteReferenceSetMutation.mutate(referenceSet.id);
    }
  };

  const deleteReferenceExtractionMutation = useMutation({
    mutationFn: deleteReferenceExtraction,
    onSuccess: async ({ deletedExtraction, deletedJobs }) => {
      setPageStatus(
        `\u5DF2\u522A\u9664 ${deletedExtraction.label} \u7684 Extraction \u7D50\u679C\uff0c\u4E26\u6E05\u7406 ${deletedJobs.length} \u7B46 Job\u3002`
      );
      if (selectedReferenceJobId && selectedReferenceExtractionJob?.payload?.referenceSetId === deletedExtraction.id) {
        setSelectedReferenceJobId(null);
      }
      resetPreview();
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      await queryClient.invalidateQueries({ queryKey: ["referenceSets"] });
    },
    onError: (error) => {
      setPageStatus(error instanceof Error ? error.message : "\u522A\u9664 Extraction \u7D50\u679C\u5931\u6557\u3002");
    },
  });

  const deleteIngestionMutation = useMutation({
    mutationFn: ({ mangaId, translatorId }: { mangaId: string; translatorId: string }) =>
      deleteIngestionKnowledgeReport(mangaId, translatorId),
    onSuccess: async ({ deletedIngestion, deletedJobs }) => {
      setPageStatus(
        `\u5DF2\u522A\u9664 ${deletedIngestion.label} \u7684 Ingestion \u7D50\u679C\uff0c\u4E26\u6E05\u7406 ${deletedJobs.length} \u7B46 Job\u3002`
      );
      setSelectedReportTranslatorId("");
      if (selectedReferenceJobId && selectedReferenceIngestionJob?.payload?.translatorId === deletedIngestion.translatorId) {
        setSelectedReferenceJobId(null);
      }
      resetPreview();
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      await queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
      await queryClient.invalidateQueries({ queryKey: ["ingestion-knowledge-report"] });
    },
    onError: (error) => {
      setPageStatus(error instanceof Error ? error.message : "\u522A\u9664 Ingestion \u7D50\u679C\u5931\u6557\u3002");
    },
  });

  const startExtractionReviewMutation = useMutation({
    mutationFn: async (referenceSetId: string) => {
      const result = await startExtractionReview(referenceSetId);
      const sessionId = result.review.sessionId;
      const editorUrl = result.review.editorUrl;
      if (!sessionId || !editorUrl) {
        throw new Error(t("reference.extractionReview.sessionMissing"));
      }
      try {
        await openKoharuEditor({ url: editorUrl, sessionId });
      } catch (error) {
        await cancelExtractionReview(referenceSetId, sessionId).catch(() => undefined);
        throw error;
      }
      return result;
    },
    onSuccess: ({ review }) => {
      setActiveReviewSessionId(review.sessionId || null);
      setActiveReviewReferenceSetId(review.referenceSetId);
      queryClient.setQueryData(["extraction-review", review.referenceSetId], { review });
      setPageStatus(t("reference.extractionReview.status.editorOpened"));
    },
    onError: (error) => {
      setPageStatus(error instanceof Error ? error.message : t("reference.extractionReview.status.startFailed"));
    },
  });

  const syncExtractionReviewMutation = useMutation({
    mutationFn: ({ referenceSetId, sessionId }: { referenceSetId: string; sessionId: string }) =>
      syncExtractionReview(referenceSetId, sessionId),
    onSuccess: ({ review }) => {
      queryClient.setQueryData(["extraction-review", review.referenceSetId], { review });
      setPageStatus(t("reference.extractionReview.status.synced"));
    },
    onError: (error) => {
      setPageStatus(error instanceof Error ? error.message : t("reference.extractionReview.status.syncFailed"));
    },
  });

  const finishExtractionReviewMutation = useMutation({
    mutationFn: ({ referenceSetId, sessionId }: { referenceSetId: string; sessionId: string }) =>
      finishExtractionReviewEditor(referenceSetId, sessionId),
    onSuccess: async ({ review }) => {
      const sessionId = activeReviewSessionId;
      if (sessionId) {
        closingReviewSessionRef.current = sessionId;
        await closeKoharuEditor(sessionId).catch(() => undefined);
      }
      setActiveReviewSessionId(null);
      setActiveReviewReferenceSetId(null);
      queryClient.setQueryData(["extraction-review", review.referenceSetId], { review });
      await queryClient.invalidateQueries({ queryKey: ["referenceSets"] });
      setPageStatus(t("reference.extractionReview.status.editorFinished"));
    },
    onError: (error) => {
      setPageStatus(error instanceof Error ? error.message : t("reference.extractionReview.status.finishFailed"));
    },
  });

  const cancelExtractionReviewMutation = useMutation({
    mutationFn: ({ referenceSetId, sessionId }: { referenceSetId: string; sessionId: string }) =>
      cancelExtractionReview(referenceSetId, sessionId),
    onSuccess: async ({ review }) => {
      const sessionId = activeReviewSessionId;
      if (sessionId) {
        closingReviewSessionRef.current = sessionId;
        await closeKoharuEditor(sessionId).catch(() => undefined);
      }
      setActiveReviewSessionId(null);
      setActiveReviewReferenceSetId(null);
      queryClient.setQueryData(["extraction-review", review.referenceSetId], { review });
      await queryClient.invalidateQueries({ queryKey: ["referenceSets"] });
      setPageStatus(t("reference.extractionReview.status.cancelled"));
    },
    onError: (error) => {
      setPageStatus(error instanceof Error ? error.message : t("reference.extractionReview.status.cancelFailed"));
    },
  });

  const saveExtractionReviewOrderMutation = useMutation({
    mutationFn: ({
      referenceSetId,
      pages,
    }: {
      referenceSetId: string;
      pages: Array<{ pageId: string; nodeIds: string[] }>;
    }) => saveExtractionReviewOrder(referenceSetId, pages),
    onSuccess: ({ review }) => {
      queryClient.setQueryData(["extraction-review", review.referenceSetId], { review });
      setPageStatus(t("reference.extractionReview.status.orderSaved"));
    },
    onError: (error) => {
      setPageStatus(error instanceof Error ? error.message : t("reference.extractionReview.status.orderFailed"));
    },
  });

  const confirmExtractionReviewMutation = useMutation({
    mutationFn: confirmExtractionReview,
    onSuccess: async ({ review }) => {
      queryClient.setQueryData(["extraction-review", review.referenceSetId], { review });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["referenceSets"] }),
        queryClient.invalidateQueries({ queryKey: ["bilingual-evidence"] }),
        queryClient.invalidateQueries({ queryKey: ["ingestion-knowledge-report"] }),
      ]);
      setPageStatus(t("reference.extractionReview.status.confirmed"));
    },
    onError: (error) => {
      setPageStatus(error instanceof Error ? error.message : t("reference.extractionReview.status.confirmFailed"));
    },
  });

  useEffect(() => onKoharuEditorClosed(({ sessionId }) => {
    if (!sessionId || closingReviewSessionRef.current === sessionId) {
      closingReviewSessionRef.current = null;
      return;
    }
    if (!activeReviewReferenceSetId || activeReviewSessionId !== sessionId) return;
    setPageStatus(t("reference.extractionReview.status.windowClosedSyncing"));
    finishExtractionReviewMutation.mutate({
      referenceSetId: activeReviewReferenceSetId,
      sessionId,
    });
  }), [activeReviewReferenceSetId, activeReviewSessionId, t]);

  const runBilingualEnrichmentMutation = useMutation({
    mutationFn: runBilingualEnrichment,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const updateBilingualEvidenceMutation = useMutation({
    mutationFn: updateBilingualEvidenceLink,
    onSuccess: (document) => {
      queryClient.setQueryData(
        ["bilingual-evidence", document.mangaId, document.translatorId],
        document
      );
    },
  });
  const deepReviewMutation = useMutation({
    mutationFn: (referenceSetId: string) => runReferenceDeepReview(referenceSetId, {
      reviewReason: "manual_review",
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const retryMutation = useMutation({
    mutationFn: retryJob,
    onSuccess: async (job) => {
      setPageStatus("\u5DF2\u91CD\u8A66 Reference Job\uFF1A" + job.id);
      setSelectedReferenceJobId(job.id);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const deleteJobMutation = useMutation({
    mutationFn: deleteJob,
    onSuccess: async (result) => {
      setPageStatus("Moved job " + result.deleted.id + " to Trash.");
      if (selectedReferenceJobId === result.deleted.id) {
        setSelectedReferenceJobId(null);
      }
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const resolveProfileAndChapter = async (): Promise<{
    mangaId: string;
    mangaLabel: string;
    translatorId: string;
    translatorLabel: string;
    chapterId: string;
    chapterTitle?: string;
  } | null> => {
    let mangaId: string | null = null;
    let mangaLabel: string | null = null;

    if (selectedManga) {
      mangaId = selectedManga.mangaId;
      mangaLabel = selectedManga.label;
    } else if (ingestionForm.mangaSelection === CREATE_NEW_MANGA_VALUE) {
      const nextMangaLabel = ingestionForm.newMangaLabel.trim();
      if (!nextMangaLabel) {
        return null;
      }
      const createdManga = await createManga({ label: nextMangaLabel });
      mangaId = createdManga.manga.mangaId;
      mangaLabel = createdManga.manga.label;
    }

    if (!mangaId || !mangaLabel) {
      return null;
    }

    let translatorId: string | undefined;
    let translatorLabel: string | undefined;

    if (selectedTranslator) {
      translatorId = selectedTranslator.translatorId;
      translatorLabel = selectedTranslator.label;
    } else if (ingestionForm.translatorSelection === CREATE_NEW_TRANSLATOR_VALUE) {
      const nextTranslatorLabel = ingestionForm.newTranslatorLabel.trim();
      if (!nextTranslatorLabel) {
        return null;
      }
      const createdTranslator = await createTranslatorProfile(mangaId, {
        label: nextTranslatorLabel,
      });
      translatorId = createdTranslator.translator.translatorId;
      translatorLabel = createdTranslator.translator.label;
    }

    if (!translatorId || !translatorLabel) {
      return null;
    }

    const selectedReferenceSet = referenceSetOptions.find(
      (referenceSet) => referenceSet.id === ingestionForm.referenceSetId
    );
    const defaultChapterTitle = normalizeChapterTitleLabel(selectedReferenceSet?.label, "Imported chapter");
    const createdChapter = await createChapter(mangaId, translatorId, {
      chapterTitle: defaultChapterTitle,
    });

    return {
      mangaId,
      mangaLabel,
      translatorId,
      translatorLabel,
      chapterId: createdChapter.chapter.chapterId,
      chapterTitle: createdChapter.chapter.chapterTitle || defaultChapterTitle,
    };
  };

  const resolveImportBinding = async (): Promise<{
    mangaId: string;
    mangaLabel: string;
    translatorId?: string;
    translatorLabel?: string;
    chapterId?: string;
    chapterTitle?: string;
  } | null> => {
    let mangaId: string | null = null;
    let mangaLabel: string | null = null;

    if (selectedImportManga) {
      mangaId = selectedImportManga.mangaId;
      mangaLabel = selectedImportManga.label;
    } else if (importForm.mangaSelection === CREATE_NEW_MANGA_VALUE) {
      const nextMangaLabel = importForm.newMangaLabel.trim();
      if (!nextMangaLabel) {
        return null;
      }
      const createdManga = await createManga({
        label: nextMangaLabel,
        language: normalizeReferenceLanguage(importForm.language),
      });
      mangaId = createdManga.manga.mangaId;
      mangaLabel = createdManga.manga.label;
    } else {
      return null;
    }

    let translatorId: string | undefined;
    let translatorLabel: string | undefined;
    if (isSourceReferenceKind(importForm.referenceKind)) {
      const existingOriginalTranslator = selectedImportManga?.translators.find(
        (entry) => entry.label === SOURCE_REFERENCE_TRANSLATOR_LABEL
      );
      if (existingOriginalTranslator) {
        translatorId = existingOriginalTranslator.translatorId;
        translatorLabel = existingOriginalTranslator.label;
      } else {
        const createdTranslator = await createTranslatorProfile(mangaId, {
          label: SOURCE_REFERENCE_TRANSLATOR_LABEL,
          language: normalizeReferenceLanguage(importForm.language),
        });
        translatorId = createdTranslator.translator.translatorId;
        translatorLabel = createdTranslator.translator.label;
      }
    } else if (selectedImportTranslator) {
      translatorId = selectedImportTranslator.translatorId;
      translatorLabel = selectedImportTranslator.label;
    } else if (importForm.translatorSelection === CREATE_NEW_TRANSLATOR_VALUE) {
      const nextTranslatorLabel = importForm.newTranslatorLabel.trim();
      if (!nextTranslatorLabel) {
        return null;
      }
      const createdTranslator = await createTranslatorProfile(mangaId, {
        label: nextTranslatorLabel,
        language: normalizeReferenceLanguage(importForm.language),
      });
      translatorId = createdTranslator.translator.translatorId;
      translatorLabel = createdTranslator.translator.label;
    } else {
      return {
        mangaId,
        mangaLabel,
        translatorId: undefined,
        translatorLabel: undefined,
      };
    }

    return {
      mangaId,
      mangaLabel,
      translatorId,
      translatorLabel,
    };
  };

  const addReferenceSetsToWorklist = (referenceSets: ReferenceSetSummary[]) => {
    if (referenceSets.length === 0) return;
    appendWorklistEntries(
      referenceSets.map((referenceSet) => ({
        referenceSetId: referenceSet.id,
        label: referenceSet.label,
        referenceKind: referenceSet.referenceKind || "translator",
        language: referenceSet.language,
        mangaId: referenceSet.mangaId || undefined,
        mangaLabel: referenceSet.mangaLabel || undefined,
        translatorId: referenceSet.translatorId || undefined,
        translatorLabel: referenceSet.translatorLabel || undefined,
        chapterId: referenceSet.chapterId || undefined,
        chapterTitle: referenceSet.chapterTitle || undefined,
      }))
    );
    setExtractionForm((current) => ({
      ...current,
      referenceSetId: referenceSets[0].id,
    }));
    setIngestionForm((current) => ({
      ...current,
      referenceSetId: referenceSets[0].id,
    }));
    setPageStatus(t("reference.data.addedToWorklist", { count: referenceSets.length }));
  };

  const addReferenceSetToWorklist = (referenceSet: ReferenceSetSummary) => {
    addReferenceSetsToWorklist([referenceSet]);
  };

  const appendQueuedReferenceFolderPaths = (folders: string[]) => {
    appendQueuedReferenceFolders(folders.map((folder) => createQueuedReferenceFolder(folder)));
  };

  const {
    selectReferenceMaterial,
    importQueuedReferenceFolders,
    runWorklistExtraction,
    runWorklistIngestion,
    runWorklistItemExtraction,
    runWorklistItemIngestion,
  } = useReferenceWorklistActions({
    queuedReferenceFolders,
    referenceWorklist,
    importForm,
    ingestionForm,
    referenceJobs,
    worklistEntriesMissingExtraction,
    styleOptionDisabledForWorklist,
    setPageStatus,
    setIsWorklistImporting,
    setIsWorklistExtracting,
    setIsWorklistIngesting,
    appendWorklistEntries,
    clearQueuedReferenceFolders,
    setImportForm,
    setExtractionForm,
    setIngestionForm,
    setSelectedReferenceJobId,
    resolveImportBinding,
    resolveProfileAndChapter,
    createChapterForBinding: async (mangaId, translatorId, chapterTitle) => {
      const createdChapter = await createChapter(mangaId, translatorId, { chapterTitle });
      return {
        chapterId: createdChapter.chapter.chapterId,
        chapterTitle: createdChapter.chapter.chapterTitle || chapterTitle,
      };
    },
    importReferenceFolderFn: importReferenceFolder,
    createReferenceExtractionJobFn: createReferenceExtractionJob,
    createReferenceIngestionJobFn: createReferenceIngestionJob,
    createReferenceIngestionJobsFn: createReferenceIngestionJobs,
    normalizeChapterTitleLabel,
    folderBaseName,
    normalizeReferenceLanguage,
    isSourceReferenceKind,
    latestReferenceJobForSet,
    queryClient,
  });

  const pickSingleReferenceFolder = async () => {
    const picked = await pickDirectory({
      title: "Load Translated Manga Folders",
      defaultPath: importForm.sourceFolder || undefined,
    });
    if (picked.canceled || !picked.path) {
      return;
    }
    appendQueuedReferenceFolderPaths([picked.path]);
    setImportForm((current) => ({
      ...current,
      sourceFolder: picked.path || "",
    }));
  };

  const pickMultipleReferenceFolders = async () => {
    const picked = await pickDirectories({
      title: "Load Translated Manga Folders",
      defaultPath: importForm.sourceFolder || undefined,
    });
    if (picked.canceled || picked.paths.length === 0) {
      return;
    }
    appendQueuedReferenceFolderPaths(picked.paths);
    setImportForm((current) => ({
      ...current,
      sourceFolder: picked.paths[0] || current.sourceFolder,
    }));
  };

  return (
    <section className="page">
      <h1>Reference</h1>
      <div className="card-stack">
        <PageHeader
          title={t("reference.page.title")}
          description={t("reference.page.description")}
          statusItems={[
            { label: t("reference.page.status"), value: pageStatus },
            { label: t("reference.page.queueCount"), value: queuedReferenceFolders.length },
            { label: t("reference.page.worklistCount"), value: referenceWorklist.length },
            {
              label: t("reference.page.selectedReference"),
              value: selectedReferenceSetSummary?.label || t("shared.state.notSelected"),
            },
          ]}
        />

        <ReferenceImportPane
          importForm={importForm}
          setImportForm={setImportForm}
          importQueue={queuedReferenceFolders}
          isWorklistImporting={isWorklistImporting}
          mangaSeriesOptions={mangaSeriesOptions}
          mangaSeriesLoading={mangaSeriesQuery.isLoading}
          mangaSeriesFailed={mangaSeriesQuery.isError}
          availableImportTranslators={availableImportTranslators}
          isSourceReferenceKind={isSourceReferenceKind}
          sourceReferenceTranslatorLabel={SOURCE_REFERENCE_TRANSLATOR_LABEL}
          hasSourceReferenceInWorklist={hasSourceReferenceInWorklist}
          hasTranslatorReferenceInWorklist={hasTranslatorReferenceInWorklist}
          importBlockedReason={importBlockedReason}
          removeQueuedReferenceFolder={removeQueuedReferenceFolder}
          updateQueuedReferenceFolderLabel={updateQueuedReferenceFolderLabel}
          importQueuedReferenceFolders={importQueuedReferenceFolders}
          pickSingleFolder={pickSingleReferenceFolder}
          pickMultipleFolders={pickMultipleReferenceFolders}
          clearQueuedReferenceFolders={clearQueuedReferenceFolders}
        />

        <ReferenceWorklistPane
          ingestionForm={ingestionForm}
          setIngestionForm={setIngestionForm}
          styleOptionDisabledForWorklist={styleOptionDisabledForWorklist}
          hasSourceReferenceInWorklist={hasSourceReferenceInWorklist}
          hasTranslatorReferenceInWorklist={hasTranslatorReferenceInWorklist}
          referenceWorklist={referenceWorklist}
          referenceSetMap={referenceSetMap}
          mangaSeriesOptions={mangaSeriesOptions}
          referenceJobs={referenceJobs}
          latestReferenceJobForSet={latestReferenceJobForSet}
          statusLabel={statusLabel}
          extractionMutationPending={extractionMutation.isPending}
          ingestionMutationPending={ingestionMutation.isPending}
          reviewMutationPending={
            startExtractionReviewMutation.isPending ||
            finishExtractionReviewMutation.isPending ||
            cancelExtractionReviewMutation.isPending
          }
          activeReviewReferenceSetId={activeReviewReferenceSetId}
          worklistEntriesMissingExtraction={worklistEntriesMissingExtraction}
          extractionBlockedReason={extractionBlockedReason}
          ingestionBlockedReason={ingestionBlockedReason}
          removeWorklistEntry={removeWorklistEntry}
          deleteReferencePending={deleteReferenceSetMutation.isPending}
          confirmDeleteReference={confirmDeleteReference}
          selectReferenceMaterial={selectReferenceMaterial}
          runWorklistExtraction={runWorklistExtraction}
          runWorklistIngestion={runWorklistIngestion}
          runWorklistItemExtraction={runWorklistItemExtraction}
          runWorklistItemIngestion={runWorklistItemIngestion}
          deepReviewPending={deepReviewMutation.isPending}
          runDeepReview={(referenceSet) => deepReviewMutation.mutate(referenceSet.id)}
          reviewExtraction={(referenceSet) => {
            setExtractionForm((current) => ({ ...current, referenceSetId: referenceSet.id }));
            startExtractionReviewMutation.mutate(referenceSet.id);
          }}
          finishReviewEditing={(referenceSet) => {
            setExtractionForm((current) => ({ ...current, referenceSetId: referenceSet.id }));
            if (activeReviewSessionId) {
              finishExtractionReviewMutation.mutate({
                referenceSetId: referenceSet.id,
                sessionId: activeReviewSessionId,
              });
            }
          }}
          selectedReferenceSetId={extractionForm.referenceSetId}
        />

        <ExtractionReviewPane
          referenceSet={selectedReferenceSetSummary}
          review={extractionReviewQuery.data?.review || null}
          loading={extractionReviewQuery.isLoading}
          error={extractionReviewQuery.isError}
          busy={
            startExtractionReviewMutation.isPending ||
            syncExtractionReviewMutation.isPending ||
            finishExtractionReviewMutation.isPending ||
            cancelExtractionReviewMutation.isPending ||
            saveExtractionReviewOrderMutation.isPending ||
            confirmExtractionReviewMutation.isPending
          }
          activeSessionId={
            activeReviewReferenceSetId === selectedReferenceSetSummary?.id
              ? activeReviewSessionId
              : null
          }
          onStart={() => {
            if (selectedReferenceSetSummary) {
              startExtractionReviewMutation.mutate(selectedReferenceSetSummary.id);
            }
          }}
          onSync={() => {
            if (activeReviewReferenceSetId && activeReviewSessionId) {
              syncExtractionReviewMutation.mutate({
                referenceSetId: activeReviewReferenceSetId,
                sessionId: activeReviewSessionId,
              });
            }
          }}
          onFinishEditor={() => {
            if (activeReviewReferenceSetId && activeReviewSessionId) {
              finishExtractionReviewMutation.mutate({
                referenceSetId: activeReviewReferenceSetId,
                sessionId: activeReviewSessionId,
              });
            }
          }}
          onCancel={() => {
            if (activeReviewReferenceSetId && activeReviewSessionId) {
              cancelExtractionReviewMutation.mutate({
                referenceSetId: activeReviewReferenceSetId,
                sessionId: activeReviewSessionId,
              });
            }
          }}
          onSaveOrder={(pages) => {
            if (selectedReferenceSetSummary) {
              saveExtractionReviewOrderMutation.mutate({
                referenceSetId: selectedReferenceSetSummary.id,
                pages,
              });
            }
          }}
          onConfirm={() => {
            if (selectedReferenceSetSummary) {
              confirmExtractionReviewMutation.mutate(selectedReferenceSetSummary.id);
            }
          }}
        />

        <BilingualEvidencePane
          visible={selectedAlignmentIsTranslator}
          document={bilingualEvidenceQuery.data || null}
          loading={bilingualEvidenceQuery.isLoading}
          running={runBilingualEnrichmentMutation.isPending}
          updating={updateBilingualEvidenceMutation.isPending}
          onRun={() => {
            if (!selectedAlignmentEntry?.mangaId || !selectedAlignmentEntry.translatorId) return;
            runBilingualEnrichmentMutation.mutate({
              mangaId: selectedAlignmentEntry.mangaId,
              translatorId: selectedAlignmentEntry.translatorId,
            });
          }}
          onUpdate={(linkId, action) => {
            if (!bilingualEvidenceQuery.data) return;
            updateBilingualEvidenceMutation.mutate({
              mangaId: bilingualEvidenceQuery.data.mangaId,
              translatorId: bilingualEvidenceQuery.data.translatorId,
              linkId,
              action,
            });
          }}
        />

        <IngestionReportPane
          mangaSeriesLoading={mangaSeriesQuery.isLoading}
          mangaSeriesError={mangaSeriesQuery.isError}
          mangaSeriesOptions={mangaSeriesOptions}
          referenceSets={referenceSetOptions}
          selectedReportMangaId={selectedReportMangaId}
          selectedReportTranslatorId={selectedReportTranslatorId}
          setSelectedReportMangaId={setSelectedReportMangaId}
          setSelectedReportTranslatorId={setSelectedReportTranslatorId}
          ingestionReportLoading={ingestionReportQuery.isLoading}
          ingestionReportError={ingestionReportQuery.isError}
          ingestionReportData={ingestionReportQuery.data}
          deleteIngestionPending={deleteIngestionMutation.isPending}
          deleteExtractionPending={deleteReferenceExtractionMutation.isPending}
          deleteReferencePending={deleteReferenceSetMutation.isPending}
          worklistReferenceSetIds={referenceWorklist.map((entry) => entry.referenceSetId)}
          addReferenceSetToWorklist={addReferenceSetToWorklist}
          addReferenceSetsToWorklist={addReferenceSetsToWorklist}
          confirmDeleteExtraction={async (referenceSet) => {
            const confirmed = await confirmDialog({
              title: "刪除 Extraction 結果",
              message: `確定要刪除 ${referenceSet.chapterTitle || referenceSet.label} 的 Extraction 結果與相關工作紀錄嗎？`,
              confirmLabel: "刪除 Extraction",
            });
            if (!confirmed) return;
            deleteReferenceExtractionMutation.mutate(referenceSet.id);
          }}
          confirmDeleteReference={confirmDeleteReference}
          confirmDeleteIngestion={async (manga, translator) => {
            const confirmed = await confirmDialog({
              title: "刪除 Ingestion 結果",
              message: `確定要刪除 ${manga.label} / ${translator.label} 的 Ingestion 結果與相關工作紀錄嗎？`,
              confirmLabel: "刪除 Ingestion",
            });
            if (!confirmed) {
              return;
            }
            deleteIngestionMutation.mutate({
              mangaId: manga.mangaId,
              translatorId: translator.translatorId,
            });
          }}
        />

        <ReferenceJobsPane
          selectedReferenceSetSummary={selectedReferenceSetSummary}
          selectedReferenceExtractionJob={selectedReferenceExtractionJob}
          selectedReferenceIngestionJob={selectedReferenceIngestionJob}
          selectedDeletionManga={selectedDeletionManga}
          selectedDeletionTranslator={selectedDeletionTranslator}
          deleteReferenceExtractionPending={deleteReferenceExtractionMutation.isPending}
          deleteIngestionPending={deleteIngestionMutation.isPending}
          selectedJob={selectedJob}
          displayJobType={displayJobType}
          selectedJobSummary={selectedJobSummary}
          selectedIngestionSummary={selectedIngestionSummary}
          retryJob={referenceJobActions.retryJob}
          openJobList={referenceJobActions.openJobList}
          deleteJob={referenceJobActions.deleteJob}
          viewExtraction={referenceJobActions.viewExtraction}
          viewIngestion={referenceJobActions.viewIngestion}
          confirmDeleteExtraction={referenceJobActions.confirmDeleteExtraction}
          confirmDeleteIngestion={referenceJobActions.confirmDeleteIngestion}
        />

        <ArtifactEditorPane
          selectedReferenceJobId={selectedReferenceJobId}
          artifactsLoading={artifactsQuery.isLoading}
          artifacts={Array.isArray(artifactsQuery.data?.artifacts) ? artifactsQuery.data.artifacts : []}
          previewArtifact={previewArtifact}
          previewData={previewData}
          previewStatus={previewStatus}
          editorValue={editorValue}
          setEditorValue={setEditorValue}
          loadArtifact={loadArtifact}
          saveEditedArtifact={saveEditedArtifact}
          deleteArtifact={deleteArtifact}
          openArtifactPath={openDesktopPath}
          prettyArtifactKind={prettyArtifactKind}
          isEditableArtifact={isEditableArtifact}
        />
      </div>
    </section>
  );
}
