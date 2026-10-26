import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
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
  saveExtractionReviewOrder,
  startExtractionReview,
  syncExtractionReview,
  updateBilingualEvidenceLink,
  type BilingualEvidenceDocument,
  type ExtractionReviewDocument,
  type GuiJob,
  type MangaSeriesSummary,
  type ReferenceSetSummary,
  type TranslatorProfileSummary,
} from "../api/jobs";
import { CREATE_NEW_MANGA_VALUE } from "../components/MangaSelector";
import { CREATE_NEW_TRANSLATOR_VALUE, resolveSelectedTranslator } from "../components/TranslatorSelector";
import {
  closeKoharuEditor,
  confirmDialog,
  onKoharuEditorClosed,
  openKoharuEditor,
  pickDirectory,
  pickDirectories,
  uploadImageFolder,
} from "../services/desktop_api";
import { DEFAULT_REFERENCE_LANGUAGE, normalizeReferenceLanguage } from "../constants/languages";
import { IngestionReportPane } from "../features/reference/components/IngestionReportPane";
import { BilingualEvidencePane } from "../features/reference/components/BilingualEvidencePane";
import { ExtractionReviewPane } from "../features/reference/components/ExtractionReviewPane";
import { ReferenceImportPane } from "../features/reference/components/ReferenceImportPane";
import { ReferenceLibraryPane } from "../features/reference/components/ReferenceLibraryPane";
import { ReferenceWorklistPane } from "../features/reference/components/ReferenceWorklistPane";
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
          job.payload.referenceSetId === referenceSetId,
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

type ReferenceStreamEvent = Parameters<Parameters<typeof subscribeToJobsStream>[0]["onEvent"]>[0];
type ReferenceQueryClient = ReturnType<typeof useQueryClient>;

function appendReferenceJobEvent(current: { jobs: GuiJob[] } | undefined, incoming: GuiJob, message: ReferenceStreamEvent) {
  const jobs = current?.jobs || [];
  const existing = jobs.find((job) => job.id === incoming.id);
  const streamEvent = {
    id: -Date.now(), type: message.type, payload: message.payload,
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
}

function refreshReferenceJobQueries(queryClient: ReferenceQueryClient, job: GuiJob) {
  if (job.type === "reference_extraction" && job.status === "succeeded") {
    void queryClient.invalidateQueries({ queryKey: ["referenceSets"] });
    const referenceSetId = job.payload?.referenceSetId;
    if (typeof referenceSetId === "string") {
      void queryClient.invalidateQueries({ queryKey: ["extraction-review", referenceSetId] });
    }
  }
  if (job.type === "reference_ingestion" && job.status === "succeeded") {
    void queryClient.invalidateQueries({ queryKey: ["ingestion-knowledge-report"] });
    void queryClient.invalidateQueries({ queryKey: ["referenceSets"] });
    void queryClient.invalidateQueries({ queryKey: ["bilingual-evidence"] });
  }
}

function handleReferenceStreamEvent(queryClient: ReferenceQueryClient, message: ReferenceStreamEvent) {
  if (message.type === "jobs.snapshot" && Array.isArray(message.jobs)) {
    queryClient.setQueryData(["jobs"], { jobs: message.jobs as GuiJob[] });
    return;
  }
  if (message.kind !== "job" || !message.job || typeof message.job !== "object") return;
  const incoming = message.job as GuiJob;
  refreshReferenceJobQueries(queryClient, incoming);
  queryClient.setQueryData<{ jobs: GuiJob[] }>(["jobs"], (current) =>
    appendReferenceJobEvent(current, incoming, message));
}

function useReferenceJobStream(queryClient: ReferenceQueryClient) {
  useEffect(() => subscribeToJobsStream({
    onEvent: (message) => handleReferenceStreamEvent(queryClient, message),
  }), [queryClient]);
}

function reconcileWorklistEntry(
  entry: ImportedReferenceBinding,
  referenceById: Map<string, ReferenceSetSummary>,
  mangaLabelById: Map<string, string>,
) {
  const referenceSet = referenceById.get(entry.referenceSetId);
  const mangaId = referenceSet?.mangaId || entry.mangaId;
  const mangaLabel = mangaId
    ? mangaLabelById.get(mangaId) || referenceSet?.mangaLabel || entry.mangaLabel
    : referenceSet?.mangaLabel || entry.mangaLabel;
  return mangaId === entry.mangaId && mangaLabel === entry.mangaLabel
    ? entry : { ...entry, mangaId: mangaId || undefined, mangaLabel: mangaLabel || undefined };
}

function reconcileReferenceWorklist(
  current: ImportedReferenceBinding[],
  references: ReferenceSetSummary[],
  mangaSeries: MangaSeriesSummary[],
) {
  const existingIds = new Set(references.map((entry) => entry.id));
  const referenceById = new Map(references.map((entry) => [entry.id, entry]));
  const mangaLabelById = new Map(mangaSeries.map((entry) => [entry.mangaId, entry.label]));
  const next = current.filter((entry) => existingIds.has(entry.referenceSetId))
    .map((entry) => reconcileWorklistEntry(entry, referenceById, mangaLabelById));
  const unchanged = next.length === current.length && next.every((entry, index) => entry === current[index]);
  return unchanged ? current : next;
}

function useReferenceWorklistSync(
  loaded: boolean,
  references: ReferenceSetSummary[],
  mangaSeries: MangaSeriesSummary[],
  setWorklist: Dispatch<SetStateAction<ImportedReferenceBinding[]>>,
) {
  useEffect(() => {
    if (!loaded) return;
    setWorklist((current) => reconcileReferenceWorklist(current, references, mangaSeries));
  }, [loaded, mangaSeries, references, setWorklist]);
}

type MangaBinding = { mangaId: string; mangaLabel: string };
type TranslatorBinding = { translatorId: string; translatorLabel: string };
type ProfileChapterBinding = MangaBinding & TranslatorBinding & { chapterId: string; chapterTitle?: string };
type ImportProfileBinding = MangaBinding & Partial<TranslatorBinding> & { chapterId?: string; chapterTitle?: string };

async function resolveIngestionManga(
  selected: MangaSeriesSummary | null,
  form: ReferenceIngestionForm,
): Promise<MangaBinding | null> {
  if (selected) return { mangaId: selected.mangaId, mangaLabel: selected.label };
  if (form.mangaSelection !== CREATE_NEW_MANGA_VALUE || !form.newMangaLabel.trim()) return null;
  const created = await createManga({ label: form.newMangaLabel.trim() });
  return { mangaId: created.manga.mangaId, mangaLabel: created.manga.label };
}

async function resolveIngestionTranslator(
  mangaId: string,
  selected: TranslatorProfileSummary | null,
  form: ReferenceIngestionForm,
): Promise<TranslatorBinding | null> {
  if (selected) return { translatorId: selected.translatorId, translatorLabel: selected.label };
  if (form.translatorSelection !== CREATE_NEW_TRANSLATOR_VALUE || !form.newTranslatorLabel.trim()) return null;
  const created = await createTranslatorProfile(mangaId, { label: form.newTranslatorLabel.trim() });
  return { translatorId: created.translator.translatorId, translatorLabel: created.translator.label };
}

async function resolveProfileAndChapterAction(
  selectedManga: MangaSeriesSummary | null,
  selectedTranslator: TranslatorProfileSummary | null,
  form: ReferenceIngestionForm,
  referenceSets: ReferenceSetSummary[],
): Promise<ProfileChapterBinding | null> {
  const manga = await resolveIngestionManga(selectedManga, form);
  if (!manga) return null;
  const translator = await resolveIngestionTranslator(manga.mangaId, selectedTranslator, form);
  if (!translator) return null;
  const selectedReference = referenceSets.find((entry) => entry.id === form.referenceSetId);
  const title = normalizeChapterTitleLabel(selectedReference?.label, "Imported chapter");
  const created = await createChapter(manga.mangaId, translator.translatorId, { chapterTitle: title });
  return { ...manga, ...translator, chapterId: created.chapter.chapterId, chapterTitle: created.chapter.chapterTitle || title };
}

async function resolveImportManga(
  selected: MangaSeriesSummary | null,
  form: ReferenceImportForm,
): Promise<MangaBinding | null> {
  if (selected) return { mangaId: selected.mangaId, mangaLabel: selected.label };
  if (form.mangaSelection !== CREATE_NEW_MANGA_VALUE || !form.newMangaLabel.trim()) return null;
  const created = await createManga({
    label: form.newMangaLabel.trim(), language: normalizeReferenceLanguage(form.language),
  });
  return { mangaId: created.manga.mangaId, mangaLabel: created.manga.label };
}

async function resolveSourceImportTranslator(
  mangaId: string,
  selectedManga: MangaSeriesSummary | null,
  language: string,
): Promise<TranslatorBinding> {
  const existing = selectedManga?.translators.find((entry) => entry.label === SOURCE_REFERENCE_TRANSLATOR_LABEL);
  if (existing) return { translatorId: existing.translatorId, translatorLabel: existing.label };
  const created = await createTranslatorProfile(mangaId, {
    label: SOURCE_REFERENCE_TRANSLATOR_LABEL, language: normalizeReferenceLanguage(language),
  });
  return { translatorId: created.translator.translatorId, translatorLabel: created.translator.label };
}

async function resolveImportTranslator(
  mangaId: string,
  selectedManga: MangaSeriesSummary | null,
  selectedTranslator: TranslatorProfileSummary | null,
  form: ReferenceImportForm,
): Promise<TranslatorBinding | null> {
  if (isSourceReferenceKind(form.referenceKind)) {
    return resolveSourceImportTranslator(mangaId, selectedManga, form.language);
  }
  if (selectedTranslator) return { translatorId: selectedTranslator.translatorId, translatorLabel: selectedTranslator.label };
  if (form.translatorSelection !== CREATE_NEW_TRANSLATOR_VALUE || !form.newTranslatorLabel.trim()) return null;
  const created = await createTranslatorProfile(mangaId, {
    label: form.newTranslatorLabel.trim(), language: normalizeReferenceLanguage(form.language),
  });
  return { translatorId: created.translator.translatorId, translatorLabel: created.translator.label };
}

async function resolveImportBindingAction(
  selectedManga: MangaSeriesSummary | null,
  selectedTranslator: TranslatorProfileSummary | null,
  form: ReferenceImportForm,
): Promise<ImportProfileBinding | null> {
  const manga = await resolveImportManga(selectedManga, form);
  if (!manga) return null;
  const translator = await resolveImportTranslator(manga.mangaId, selectedManga, selectedTranslator, form);
  if (!translator && form.translatorSelection === CREATE_NEW_TRANSLATOR_VALUE) return null;
  return { ...manga, ...(translator || {}) };
}

type LibrarySelectionContext = {
  referenceSets: ReferenceSetSummary[];
  detailTab: "report" | "review" | "bilingual";
  setReportMangaId: Dispatch<SetStateAction<string>>;
  setReportTranslatorId: Dispatch<SetStateAction<string>>;
  setImportForm: Dispatch<SetStateAction<ReferenceImportForm>>;
  setIngestionForm: Dispatch<SetStateAction<ReferenceIngestionForm>>;
  setExtractionForm: Dispatch<SetStateAction<ReferenceExtractionForm>>;
  setWorklist: Dispatch<SetStateAction<ImportedReferenceBinding[]>>;
  setDetailTab: Dispatch<SetStateAction<"report" | "review" | "bilingual">>;
};

function librarySourceSets(context: LibrarySelectionContext, mangaId: string, translatorId: string) {
  return context.referenceSets
    .filter((entry) => entry.mangaId === mangaId && entry.translatorId === translatorId)
    .sort((left, right) => String(left.chapterTitle || left.label)
      .localeCompare(String(right.chapterTitle || right.label), undefined, { numeric: true, sensitivity: "base" }));
}

function isSourceLibrarySelection(referenceSets: ReferenceSetSummary[], translator: TranslatorProfileSummary) {
  return referenceSets.some((entry) => entry.referenceKind === "source")
    || translator.translatorId === "translator_original"
    || translator.label.toLocaleLowerCase() === "original";
}

function libraryWorklistBinding(
  referenceSet: ReferenceSetSummary,
  manga: MangaSeriesSummary,
  translator: TranslatorProfileSummary,
  isSource: boolean,
): ImportedReferenceBinding {
  return {
    referenceSetId: referenceSet.id, label: referenceSet.label,
    referenceKind: referenceSet.referenceKind || (isSource ? "source" : "translator"),
    language: referenceSet.language, mangaId: manga.mangaId, mangaLabel: manga.label,
    translatorId: translator.translatorId, translatorLabel: translator.label,
    chapterId: referenceSet.chapterId || undefined, chapterTitle: referenceSet.chapterTitle || undefined,
  };
}

function selectLibrarySourceAction(
  context: LibrarySelectionContext,
  manga: MangaSeriesSummary,
  translator: TranslatorProfileSummary,
) {
  const sourceSets = librarySourceSets(context, manga.mangaId, translator.translatorId);
  const isSource = isSourceLibrarySelection(sourceSets, translator);
  context.setReportMangaId(manga.mangaId);
  context.setReportTranslatorId(translator.translatorId);
  context.setImportForm((current) => ({
    ...current, mangaSelection: manga.mangaId, translatorSelection: translator.translatorId,
    referenceKind: isSource ? "source" : "translator",
  }));
  context.setIngestionForm((current) => ({
    ...current, mangaSelection: manga.mangaId, translatorSelection: translator.translatorId,
    referenceSetId: sourceSets[0]?.id || "", useForStyle: !isSource,
  }));
  context.setExtractionForm((current) => ({ ...current, referenceSetId: sourceSets[0]?.id || "" }));
  context.setWorklist(sourceSets.map((entry) => libraryWorklistBinding(entry, manga, translator, isSource)));
  if (isSource && context.detailTab === "bilingual") context.setDetailTab("report");
}

function useReferenceForms() {
  const [extractionForm, setExtractionForm] = useState(DEFAULT_EXTRACTION_FORM);
  const [ingestionForm, setIngestionForm] = useState(DEFAULT_INGESTION_FORM);
  const [importForm, setImportForm] = useState(DEFAULT_IMPORT_FORM);
  return { extractionForm, setExtractionForm, ingestionForm, setIngestionForm, importForm, setImportForm };
}

function useReferencePageSelection() {
  const [selectedReferenceJobId, setSelectedReferenceJobId] = useState<string | null>(null);
  const [pageStatus, setPageStatus] = useState("\u5C31\u7DD2\u3002");
  const [selectedReportMangaId, setSelectedReportMangaId] = useState("");
  const [selectedReportTranslatorId, setSelectedReportTranslatorId] = useState("");
  const [importPanelOpen, setImportPanelOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"report" | "review" | "bilingual">("report");
  return {
    selectedReferenceJobId, setSelectedReferenceJobId, pageStatus, setPageStatus,
    selectedReportMangaId, setSelectedReportMangaId, selectedReportTranslatorId, setSelectedReportTranslatorId,
    importPanelOpen, setImportPanelOpen, detailTab, setDetailTab,
  };
}

function useReferenceReviewSession() {
  const [activeReviewSessionId, setActiveReviewSessionId] = useState<string | null>(null);
  const [activeReviewReferenceSetId, setActiveReviewReferenceSetId] = useState<string | null>(null);
  const closingReviewSessionRef = useRef<string | null>(null);
  return {
    activeReviewSessionId, setActiveReviewSessionId,
    activeReviewReferenceSetId, setActiveReviewReferenceSetId, closingReviewSessionRef,
  };
}

function useReferenceUiActions() {
  const setSelectedJobId = useUiStore((state) => state.setSelectedJobId);
  const setSelectedMangaId = useUiStore((state) => state.setSelectedMangaId);
  const setSelectedTranslatorId = useUiStore((state) => state.setSelectedTranslatorId);
  const setSelectedPage = useUiStore((state) => state.setSelectedPage);
  return { setSelectedJobId, setSelectedMangaId, setSelectedTranslatorId, setSelectedPage };
}

function useReferenceBaseQueries(mangaId: string, translatorId: string) {
  const referenceSetsQuery = useQuery({ queryKey: ["referenceSets"], queryFn: getReferenceSets });
  const mangaSeriesQuery = useQuery({ queryKey: ["mangaSeries"], queryFn: getMangaSeries });
  const jobsQuery = useQuery({ queryKey: ["jobs"], queryFn: getJobs });
  const ingestionReportQuery = useQuery({
    queryKey: ["ingestion-knowledge-report", mangaId, translatorId],
    queryFn: () => getIngestionKnowledgeReport(mangaId, translatorId),
    enabled: Boolean(mangaId && translatorId),
  });
  return { referenceSetsQuery, mangaSeriesQuery, jobsQuery, ingestionReportQuery };
}

function useReferencePageFoundation() {
  const t = useLanguageStore((state) => state.t);
  const queryClient = useQueryClient();
  const forms = useReferenceForms();
  const selection = useReferencePageSelection();
  const reviewSession = useReferenceReviewSession();
  const ui = useReferenceUiActions();
  const worklist = useReferenceWorklistState({
    importQueueStorageKey: REFERENCE_IMPORT_QUEUE_STORAGE_KEY,
    worklistStorageKey: REFERENCE_WORKLIST_STORAGE_KEY,
    legacyWorklistStorageKey: LEGACY_REFERENCE_WORKLIST_STORAGE_KEY,
  });
  const queries = useReferenceBaseQueries(selection.selectedReportMangaId, selection.selectedReportTranslatorId);
  useReferenceJobStream(queryClient);
  return { t, queryClient, ...forms, ...selection, ...reviewSession, ...ui, ...worklist, ...queries };
}

type ReferenceFoundation = ReturnType<typeof useReferencePageFoundation>;

function useReferenceOptions(foundation: ReferenceFoundation) {
  const referenceSetOptions = useMemo(
    () => foundation.referenceSetsQuery.data?.referenceSets || [],
    [foundation.referenceSetsQuery.data],
  );
  const mangaSeriesOptions = useMemo(
    () => foundation.mangaSeriesQuery.data?.series || [],
    [foundation.mangaSeriesQuery.data],
  );
  useEffect(() => {
    const editing = referenceSetOptions.find((entry) => entry.reviewStatus === "editing" && entry.activeReviewSessionId);
    if (!editing?.activeReviewSessionId) return;
    foundation.setActiveReviewSessionId(editing.activeReviewSessionId);
    foundation.setActiveReviewReferenceSetId(editing.id);
  }, [referenceSetOptions]);
  useReferenceWorklistSync(
    Boolean(foundation.referenceSetsQuery.data), referenceSetOptions,
    mangaSeriesOptions, foundation.setReferenceWorklist,
  );
  return { referenceSetOptions, mangaSeriesOptions };
}

type ReferenceOptions = ReturnType<typeof useReferenceOptions>;

function useReferenceProfileSelections(foundation: ReferenceFoundation, options: ReferenceOptions) {
  const selectedManga = useMemo(() => options.mangaSeriesOptions.find(
    (entry) => entry.mangaId === foundation.ingestionForm.mangaSelection) || null,
  [foundation.ingestionForm.mangaSelection, options.mangaSeriesOptions]);
  const selectedReferenceSetSummary = useMemo(() => options.referenceSetOptions.find(
    (entry) => entry.id === foundation.extractionForm.referenceSetId) || null,
  [foundation.extractionForm.referenceSetId, options.referenceSetOptions]);
  const extractionReviewQuery = useQuery<{ review: ExtractionReviewDocument }>({
    queryKey: ["extraction-review", selectedReferenceSetSummary?.id],
    queryFn: () => getExtractionReview(selectedReferenceSetSummary?.id || ""),
    enabled: Boolean(selectedReferenceSetSummary?.id && selectedReferenceSetSummary.extractionAvailable), retry: false,
  });
  useEffect(() => {
    const review = extractionReviewQuery.data?.review;
    if (review?.status !== "editing" || !review.activeSessionId) return;
    foundation.setActiveReviewSessionId(review.activeSessionId);
    foundation.setActiveReviewReferenceSetId(review.referenceSetId);
  }, [extractionReviewQuery.data?.review]);
  const availableTranslators = selectedManga?.translators || [];
  const selectedTranslator = resolveSelectedTranslator(foundation.ingestionForm.translatorSelection, availableTranslators);
  const selectedImportManga = options.mangaSeriesOptions.find(
    (entry) => entry.mangaId === foundation.importForm.mangaSelection) || null;
  const availableImportTranslators = selectedImportManga?.translators || [];
  const selectedImportTranslator = resolveSelectedTranslator(
    foundation.importForm.translatorSelection, availableImportTranslators,
  );
  return { selectedManga, selectedReferenceSetSummary, extractionReviewQuery, availableTranslators,
    selectedTranslator, selectedImportManga, availableImportTranslators, selectedImportTranslator };
}

function isSourceReportTranslator(
  translator: TranslatorProfileSummary | null,
  mangaId: string,
  referenceSets: ReferenceSetSummary[],
) {
  return translator?.translatorId === "translator_original"
    || /^(original|source)$/i.test(String(translator?.label || "").trim())
    || referenceSets.some((entry) => entry.mangaId === mangaId
      && entry.translatorId === translator?.translatorId && entry.referenceKind === "source");
}

function useReferenceReportSelection(foundation: ReferenceFoundation, options: ReferenceOptions) {
  const selectedReportManga = useMemo(() => options.mangaSeriesOptions.find(
    (entry) => entry.mangaId === foundation.selectedReportMangaId) || null,
  [foundation.selectedReportMangaId, options.mangaSeriesOptions]);
  const availableReportTranslators = selectedReportManga?.translators || [];
  const selectedReportTranslator = availableReportTranslators.find(
    (entry) => entry.translatorId === foundation.selectedReportTranslatorId) || null;
  const selectedReportTranslatorIsSource = isSourceReportTranslator(
    selectedReportTranslator, foundation.selectedReportMangaId, options.referenceSetOptions,
  );
  useEffect(() => {
    if (!selectedReportManga) {
      if (foundation.selectedReportTranslatorId) foundation.setSelectedReportTranslatorId("");
      return;
    }
    const valid = availableReportTranslators.some(
      (entry) => entry.translatorId === foundation.selectedReportTranslatorId,
    );
    if (!valid) foundation.setSelectedReportTranslatorId("");
  }, [availableReportTranslators, selectedReportManga, foundation.selectedReportTranslatorId]);
  return { selectedReportManga, availableReportTranslators, selectedReportTranslator,
    selectedReportTranslatorIsSource };
}

function filterReferenceJobs(jobs: GuiJob[]) {
  return jobs.filter((job) => job.type === "reference_extraction" || job.type === "reference_ingestion")
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

function buildWorklistJobSnapshots(worklist: ImportedReferenceBinding[], jobs: GuiJob[]) {
  const snapshots = new Map<string, WorklistJobSnapshot>();
  for (const entry of worklist) {
    snapshots.set(entry.referenceSetId, {
      extractionJob: latestReferenceJobForSet(jobs, entry.referenceSetId, "reference_extraction"),
      ingestionJob: latestReferenceJobForSet(jobs, entry.referenceSetId, "reference_ingestion"),
    });
  }
  return snapshots;
}

function useReferenceJobsState(foundation: ReferenceFoundation) {
  const referenceJobs = useMemo(
    () => filterReferenceJobs(foundation.jobsQuery.data?.jobs || []),
    [foundation.jobsQuery.data],
  );
  const selectedReferenceExtractionJob = foundation.extractionForm.referenceSetId
    ? latestReferenceJobForSet(referenceJobs, foundation.extractionForm.referenceSetId, "reference_extraction") : null;
  const selectedReferenceIngestionJob = foundation.ingestionForm.referenceSetId
    ? latestReferenceJobForSet(referenceJobs, foundation.ingestionForm.referenceSetId, "reference_ingestion") : null;
  const worklistJobSnapshots = useMemo(
    () => buildWorklistJobSnapshots(foundation.referenceWorklist, referenceJobs),
    [foundation.referenceWorklist, referenceJobs],
  );
  useEffect(() => {
    if (!foundation.selectedReferenceJobId && referenceJobs.length > 0) {
      foundation.setSelectedReferenceJobId(referenceJobs[0].id);
    }
  }, [referenceJobs, foundation.selectedReferenceJobId]);
  return { referenceJobs, selectedReferenceExtractionJob, selectedReferenceIngestionJob, worklistJobSnapshots };
}

type ReferenceJobsState = ReturnType<typeof useReferenceJobsState>;

function useReferenceWorklistDerived(foundation: ReferenceFoundation, options: ReferenceOptions, jobs: ReferenceJobsState) {
  const worklistEntryMap = useMemo(() => new Map(
    foundation.referenceWorklist.map((entry) => [entry.referenceSetId, entry])), [foundation.referenceWorklist]);
  const referenceSetMap = useMemo(() => new Map(
    options.referenceSetOptions.map((entry) => [entry.id, entry])), [options.referenceSetOptions]);
  const worklistEntriesMissingExtraction = foundation.referenceWorklist.filter((entry) => {
    const extractionJob = jobs.worklistJobSnapshots.get(entry.referenceSetId)?.extractionJob || null;
    return referenceSetMap.get(entry.referenceSetId)?.extractionAvailable !== true && extractionJob?.status !== "succeeded";
  });
  const hasSourceReferenceInWorklist = foundation.referenceWorklist.some(
    (entry) => isSourceReferenceKind(entry.referenceKind));
  const hasTranslatorReferenceInWorklist = foundation.referenceWorklist.some(
    (entry) => isTranslatorReferenceKind(entry.referenceKind));
  const selectedAlignmentEntry = worklistEntryMap.get(foundation.extractionForm.referenceSetId) || null;
  const selectedAlignmentIsTranslator = Boolean(
    selectedAlignmentEntry && isTranslatorReferenceKind(selectedAlignmentEntry.referenceKind));
  const bilingualEvidenceQuery = useQuery<BilingualEvidenceDocument>({
    queryKey: ["bilingual-evidence", selectedAlignmentEntry?.mangaId, selectedAlignmentEntry?.translatorId],
    queryFn: () => getBilingualEvidence(selectedAlignmentEntry?.mangaId || "", selectedAlignmentEntry?.translatorId || ""),
    enabled: Boolean(selectedAlignmentIsTranslator && selectedAlignmentEntry?.mangaId
      && selectedAlignmentEntry?.translatorId && selectedAlignmentEntry?.chapterId), retry: false,
  });
  const styleOptionDisabledForWorklist = foundation.referenceWorklist.length > 0 && !hasTranslatorReferenceInWorklist;
  return { worklistEntryMap, referenceSetMap, worklistEntriesMissingExtraction,
    hasSourceReferenceInWorklist, hasTranslatorReferenceInWorklist, selectedAlignmentEntry,
    selectedAlignmentIsTranslator, bilingualEvidenceQuery, styleOptionDisabledForWorklist };
}

function resolveImportBlockedReason(importing: boolean, queueLength: number) {
  if (importing) return "正在匯入 Reference，請稍候。";
  if (queueLength === 0) return "請先載入至少一筆資料夾，再執行匯入。";
  return null;
}

function resolveExtractionBlockedReason(extracting: boolean, ingesting: boolean, worklistLength: number) {
  if (extracting) return "Extraction 執行中，請等待目前批次完成。";
  if (ingesting) return "Ingestion 執行中，暫時不能建立新的 Extraction。";
  if (worklistLength === 0) return "工作區目前為空，請先匯入並加入至少一筆 Reference。";
  return null;
}

function resolveIngestionBlockedReason(foundation: ReferenceFoundation, derived: ReturnType<typeof useReferenceWorklistDerived>) {
  if (foundation.isWorklistIngesting) return "Ingestion 執行中，請等待目前批次完成。";
  if (foundation.isWorklistExtracting) return "Extraction 執行中，完成後才能建立 Ingestion。";
  if (foundation.referenceWorklist.length === 0) return "工作區目前為空，請先匯入並加入至少一筆 Reference。";
  if (derived.worklistEntriesMissingExtraction.length > 0) {
    return `需先完成 Extraction：${derived.worklistEntriesMissingExtraction.map((entry) => entry.label).join(", ")}`;
  }
  if (!foundation.ingestionForm.useForTerminology && !foundation.ingestionForm.useForStyle) {
    return "請至少選擇一個 Ingestion 用途。";
  }
  if (derived.styleOptionDisabledForWorklist && !foundation.ingestionForm.useForTerminology) {
    return "原文 Reference 不會建立翻譯風格，至少需要啟用專有名詞用途。";
  }
  return null;
}

function resolveReferenceBlockers(foundation: ReferenceFoundation, derived: ReturnType<typeof useReferenceWorklistDerived>) {
  return {
    importBlockedReason: resolveImportBlockedReason(
      foundation.isWorklistImporting, foundation.queuedReferenceFolders.length),
    extractionBlockedReason: resolveExtractionBlockedReason(
      foundation.isWorklistExtracting, foundation.isWorklistIngesting, foundation.referenceWorklist.length),
    ingestionBlockedReason: resolveIngestionBlockedReason(foundation, derived),
  };
}

type ReferenceProfiles = ReturnType<typeof useReferenceProfileSelections>;
type ReferenceReport = ReturnType<typeof useReferenceReportSelection>;
type ReferenceDerived = ReturnType<typeof useReferenceWorklistDerived>;
type ReferenceBlockers = ReturnType<typeof resolveReferenceBlockers>;
type ReferenceModel = ReferenceFoundation & ReferenceOptions & ReferenceProfiles
  & ReferenceReport & ReferenceJobsState & ReferenceDerived & ReferenceBlockers;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function useExtractionMutation(context: ReferenceModel) {
  return useMutation({
    mutationFn: createReferenceExtractionJob,
    onSuccess: async (job) => {
      context.setPageStatus("\u5DF2\u5EFA\u7ACB Extraction Job\uFF1A" + job.id);
      context.setSelectedReferenceJobId(job.id);
      await context.queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => context.setPageStatus(errorMessage(error, "\u5EFA\u7ACB Extraction Job \u5931\u6557\u3002")),
  });
}

function useImportMutation(context: ReferenceModel) {
  return useMutation({
    mutationFn: importReferenceFolder,
    onSuccess: async ({ referenceSet }) => {
      context.setPageStatus(`\u5DF2\u532F\u5165 Reference\uFF1A${referenceSet.label} (${referenceSet.id})`);
      context.setImportForm((current) => ({ ...current, label: referenceSet.label }));
      context.setExtractionForm((current) => ({ ...current, referenceSetId: referenceSet.id }));
      context.setIngestionForm((current) => ({ ...current, referenceSetId: referenceSet.id }));
      await context.queryClient.invalidateQueries({ queryKey: ["referenceSets"] });
      await context.queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
    },
    onError: (error) => context.setPageStatus(errorMessage(error, "\u532F\u5165 Reference \u5931\u6557\u3002")),
  });
}

function useIngestionMutation(context: ReferenceModel) {
  return useMutation({
    mutationFn: createReferenceIngestionJob,
    onSuccess: async (job) => {
      context.setPageStatus("\u5DF2\u5EFA\u7ACB Ingestion Job\uFF1A" + job.id);
      context.setSelectedReferenceJobId(job.id);
      await context.queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => context.setPageStatus(errorMessage(error, "\u5EFA\u7ACB Ingestion Job \u5931\u6557\u3002")),
  });
}

async function handleReferenceSetDeleted(
  context: ReferenceModel,
  result: Awaited<ReturnType<typeof deleteReferenceSet>>,
) {
  const { deleted, deletedJobs } = result;
  context.setPageStatus(context.t("reference.worklist.deleteSuccess", {
    label: deleted.label, jobCount: deletedJobs.length,
  }));
  context.setExtractionForm((current) => current.referenceSetId === deleted.id
    ? { ...current, referenceSetId: "" } : current);
  context.setIngestionForm((current) => current.referenceSetId === deleted.id
    ? { ...current, referenceSetId: "" } : current);
  context.setReferenceWorklist((current) => current.filter((entry) => entry.referenceSetId !== deleted.id));
  if (context.selectedReferenceJobId && deletedJobs.some((job) => job.id === context.selectedReferenceJobId)) {
    context.setSelectedReferenceJobId(null);
  }
  await Promise.all([
    ["referenceSets"], ["jobs"], ["mangaSeries"], ["ingestion-knowledge-report"], ["bilingual-evidence"],
  ].map((queryKey) => context.queryClient.invalidateQueries({ queryKey })));
}

function useDeleteReferenceSetMutation(context: ReferenceModel) {
  return useMutation({
    mutationFn: deleteReferenceSet,
    onSuccess: (result) => handleReferenceSetDeleted(context, result),
    onError: (error) => context.setPageStatus(
      errorMessage(error, context.t("reference.worklist.deleteFailed"))),
  });
}

async function handleExtractionDeleted(
  context: ReferenceModel,
  result: Awaited<ReturnType<typeof deleteReferenceExtraction>>,
) {
  const { deletedExtraction, deletedJobs } = result;
  context.setPageStatus(
    `\u5DF2\u522A\u9664 ${deletedExtraction.label} \u7684 Extraction \u7D50\u679C\uFF0C\u4E26\u6E05\u7406 ${deletedJobs.length} \u7B46 Job\u3002`,
  );
  if (context.selectedReferenceJobId
    && context.selectedReferenceExtractionJob?.payload?.referenceSetId === deletedExtraction.id) {
    context.setSelectedReferenceJobId(null);
  }
  await context.queryClient.invalidateQueries({ queryKey: ["jobs"] });
  await context.queryClient.invalidateQueries({ queryKey: ["referenceSets"] });
}

function useDeleteExtractionMutation(context: ReferenceModel) {
  return useMutation({
    mutationFn: deleteReferenceExtraction,
    onSuccess: (result) => handleExtractionDeleted(context, result),
    onError: (error) => context.setPageStatus(errorMessage(error, "\u522A\u9664 Extraction \u7D50\u679C\u5931\u6557\u3002")),
  });
}

async function handleIngestionDeleted(
  context: ReferenceModel,
  result: Awaited<ReturnType<typeof deleteIngestionKnowledgeReport>>,
) {
  const { deletedIngestion, deletedJobs } = result;
  context.setPageStatus(
    `\u5DF2\u522A\u9664 ${deletedIngestion.label} \u7684 Ingestion \u7D50\u679C\uFF0C\u4E26\u6E05\u7406 ${deletedJobs.length} \u7B46 Job\u3002`,
  );
  context.setSelectedReportTranslatorId("");
  if (context.selectedReferenceJobId
    && context.selectedReferenceIngestionJob?.payload?.translatorId === deletedIngestion.translatorId) {
    context.setSelectedReferenceJobId(null);
  }
  await context.queryClient.invalidateQueries({ queryKey: ["jobs"] });
  await context.queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
  await context.queryClient.invalidateQueries({ queryKey: ["ingestion-knowledge-report"] });
}

function useDeleteIngestionMutation(context: ReferenceModel) {
  return useMutation({
    mutationFn: ({ mangaId, translatorId }: { mangaId: string; translatorId: string }) =>
      deleteIngestionKnowledgeReport(mangaId, translatorId),
    onSuccess: (result) => handleIngestionDeleted(context, result),
    onError: (error) => context.setPageStatus(errorMessage(error, "\u522A\u9664 Ingestion \u7D50\u679C\u5931\u6557\u3002")),
  });
}

function useReferenceDataMutations(context: ReferenceModel) {
  return {
    extractionMutation: useExtractionMutation(context),
    importMutation: useImportMutation(context),
    ingestionMutation: useIngestionMutation(context),
    deleteReferenceSetMutation: useDeleteReferenceSetMutation(context),
    deleteReferenceExtractionMutation: useDeleteExtractionMutation(context),
    deleteIngestionMutation: useDeleteIngestionMutation(context),
  };
}

type ReviewSessionPayload = { referenceSetId: string; sessionId: string };
type ReviewCloseOperation = (referenceSetId: string, sessionId: string) => ReturnType<typeof cancelExtractionReview>;

async function startReviewEditor(referenceSetId: string, t: ReferenceFoundation["t"]) {
  const result = await startExtractionReview(referenceSetId);
  const sessionId = result.review.sessionId;
  const editorUrl = result.review.editorUrl;
  if (!sessionId || !editorUrl) throw new Error(t("reference.extractionReview.sessionMissing"));
  try {
    await openKoharuEditor({ url: editorUrl, sessionId });
  } catch (error) {
    await cancelExtractionReview(referenceSetId, sessionId).catch(() => undefined);
    throw error;
  }
  return result;
}

function cacheExtractionReview(context: ReferenceModel, review: ExtractionReviewDocument) {
  context.queryClient.setQueryData(["extraction-review", review.referenceSetId], { review });
}

async function closeReviewEditorSession(context: ReferenceModel) {
  const sessionId = context.activeReviewSessionId;
  if (sessionId) {
    context.closingReviewSessionRef.current = sessionId;
    await closeKoharuEditor(sessionId).catch(() => undefined);
  }
  context.setActiveReviewSessionId(null);
  context.setActiveReviewReferenceSetId(null);
}

function useStartExtractionReviewMutation(context: ReferenceModel) {
  return useMutation({
    mutationFn: (referenceSetId: string) => startReviewEditor(referenceSetId, context.t),
    onSuccess: ({ review }) => {
      context.setActiveReviewSessionId(review.sessionId || null);
      context.setActiveReviewReferenceSetId(review.referenceSetId);
      cacheExtractionReview(context, review);
      context.setPageStatus(context.t("reference.extractionReview.status.editorOpened"));
    },
    onError: (error) => context.setPageStatus(
      errorMessage(error, context.t("reference.extractionReview.status.startFailed"))),
  });
}

function useSyncExtractionReviewMutation(context: ReferenceModel) {
  return useMutation({
    mutationFn: ({ referenceSetId, sessionId }: ReviewSessionPayload) => syncExtractionReview(referenceSetId, sessionId),
    onSuccess: ({ review }) => {
      cacheExtractionReview(context, review);
      context.setPageStatus(context.t("reference.extractionReview.status.synced"));
    },
    onError: (error) => context.setPageStatus(
      errorMessage(error, context.t("reference.extractionReview.status.syncFailed"))),
  });
}

function useCloseExtractionReviewMutation(
  context: ReferenceModel,
  operation: ReviewCloseOperation,
  successKey: string,
  failureKey: string,
) {
  return useMutation({
    mutationFn: ({ referenceSetId, sessionId }: ReviewSessionPayload) => operation(referenceSetId, sessionId),
    onSuccess: async ({ review }) => {
      await closeReviewEditorSession(context);
      cacheExtractionReview(context, review);
      await context.queryClient.invalidateQueries({ queryKey: ["referenceSets"] });
      context.setPageStatus(context.t(successKey));
    },
    onError: (error) => context.setPageStatus(errorMessage(error, context.t(failureKey))),
  });
}

function useSaveReviewOrderMutation(context: ReferenceModel) {
  return useMutation({
    mutationFn: ({ referenceSetId, pages }: {
      referenceSetId: string; pages: Array<{ pageId: string; nodeIds: string[] }>;
    }) => saveExtractionReviewOrder(referenceSetId, pages),
    onSuccess: ({ review }) => {
      cacheExtractionReview(context, review);
      context.setPageStatus(context.t("reference.extractionReview.status.orderSaved"));
    },
    onError: (error) => context.setPageStatus(
      errorMessage(error, context.t("reference.extractionReview.status.orderFailed"))),
  });
}

function useConfirmExtractionReviewMutation(context: ReferenceModel) {
  return useMutation({
    mutationFn: confirmExtractionReview,
    onSuccess: async ({ review }) => {
      cacheExtractionReview(context, review);
      await Promise.all([
        ["referenceSets"], ["bilingual-evidence"], ["ingestion-knowledge-report"],
      ].map((queryKey) => context.queryClient.invalidateQueries({ queryKey })));
      context.setPageStatus(context.t("reference.extractionReview.status.confirmed"));
    },
    onError: (error) => context.setPageStatus(
      errorMessage(error, context.t("reference.extractionReview.status.confirmFailed"))),
  });
}

function useReviewEditorCloseEffect(
  context: ReferenceModel,
  finishMutation: { mutate: (payload: ReviewSessionPayload) => void },
) {
  useEffect(() => onKoharuEditorClosed(({ sessionId }) => {
    if (!sessionId || context.closingReviewSessionRef.current === sessionId) {
      context.closingReviewSessionRef.current = null;
      return;
    }
    if (!context.activeReviewReferenceSetId || context.activeReviewSessionId !== sessionId) return;
    context.setPageStatus(context.t("reference.extractionReview.status.windowClosedSyncing"));
    finishMutation.mutate({ referenceSetId: context.activeReviewReferenceSetId, sessionId });
  }), [context.activeReviewReferenceSetId, context.activeReviewSessionId, context.t]);
}

function useReferenceReviewMutations(context: ReferenceModel) {
  const startExtractionReviewMutation = useStartExtractionReviewMutation(context);
  const syncExtractionReviewMutation = useSyncExtractionReviewMutation(context);
  const finishExtractionReviewMutation = useCloseExtractionReviewMutation(
    context, finishExtractionReviewEditor,
    "reference.extractionReview.status.editorFinished", "reference.extractionReview.status.finishFailed",
  );
  const cancelExtractionReviewMutation = useCloseExtractionReviewMutation(
    context, cancelExtractionReview,
    "reference.extractionReview.status.cancelled", "reference.extractionReview.status.cancelFailed",
  );
  const saveExtractionReviewOrderMutation = useSaveReviewOrderMutation(context);
  const confirmExtractionReviewMutation = useConfirmExtractionReviewMutation(context);
  useReviewEditorCloseEffect(context, finishExtractionReviewMutation);
  return { startExtractionReviewMutation, syncExtractionReviewMutation, finishExtractionReviewMutation,
    cancelExtractionReviewMutation, saveExtractionReviewOrderMutation, confirmExtractionReviewMutation };
}

function useReferenceEnrichmentMutations(context: ReferenceModel) {
  const runBilingualEnrichmentMutation = useMutation({
    mutationFn: runBilingualEnrichment,
    onSuccess: () => context.queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });
  const updateBilingualEvidenceMutation = useMutation({
    mutationFn: updateBilingualEvidenceLink,
    onSuccess: (document) => context.queryClient.setQueryData(
      ["bilingual-evidence", document.mangaId, document.translatorId], document),
  });
  const deepReviewMutation = useMutation({
    mutationFn: (referenceSetId: string) => runReferenceDeepReview(referenceSetId, { reviewReason: "manual_review" }),
    onSuccess: () => context.queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });
  return { runBilingualEnrichmentMutation, updateBilingualEvidenceMutation, deepReviewMutation };
}

type ReferenceMutations = ReturnType<typeof useReferenceDataMutations>
  & ReturnType<typeof useReferenceReviewMutations>
  & ReturnType<typeof useReferenceEnrichmentMutations>;

function referenceSetBinding(referenceSet: ReferenceSetSummary): ImportedReferenceBinding {
  return {
    referenceSetId: referenceSet.id, label: referenceSet.label,
    referenceKind: referenceSet.referenceKind || "translator", language: referenceSet.language,
    mangaId: referenceSet.mangaId || undefined, mangaLabel: referenceSet.mangaLabel || undefined,
    translatorId: referenceSet.translatorId || undefined,
    translatorLabel: referenceSet.translatorLabel || undefined,
    chapterId: referenceSet.chapterId || undefined, chapterTitle: referenceSet.chapterTitle || undefined,
  };
}

function addReferenceSetsToWorklistAction(context: ReferenceModel, referenceSets: ReferenceSetSummary[]) {
  if (referenceSets.length === 0) return;
  context.appendWorklistEntries(referenceSets.map(referenceSetBinding));
  context.setExtractionForm((current) => ({ ...current, referenceSetId: referenceSets[0].id }));
  context.setIngestionForm((current) => ({ ...current, referenceSetId: referenceSets[0].id }));
  context.setPageStatus(context.t("reference.data.addedToWorklist", { count: referenceSets.length }));
}

async function createChapterForBinding(mangaId: string, translatorId: string, chapterTitle: string) {
  const created = await createChapter(mangaId, translatorId, { chapterTitle });
  return {
    chapterId: created.chapter.chapterId,
    chapterTitle: created.chapter.chapterTitle || chapterTitle,
  };
}

function useReferenceWorklistActionBindings(context: ReferenceModel) {
  return useReferenceWorklistActions({
    ...context,
    resolveImportBinding: () => resolveImportBindingAction(
      context.selectedImportManga, context.selectedImportTranslator, context.importForm),
    resolveProfileAndChapter: () => resolveProfileAndChapterAction(
      context.selectedManga, context.selectedTranslator, context.ingestionForm, context.referenceSetOptions),
    createChapterForBinding,
    importReferenceFolderFn: importReferenceFolder,
    uploadImageFolderFn: uploadImageFolder,
    createReferenceExtractionJobFn: createReferenceExtractionJob,
    createReferenceIngestionJobFn: createReferenceIngestionJob,
    createReferenceIngestionJobsFn: createReferenceIngestionJobs,
    normalizeChapterTitleLabel,
    folderBaseName,
    normalizeReferenceLanguage,
    isSourceReferenceKind,
    latestReferenceJobForSet,
  });
}

function appendQueuedFolderPaths(context: ReferenceModel, folders: string[]) {
  context.appendQueuedReferenceFolders(folders.map((folder) => createQueuedReferenceFolder(folder)));
}

async function pickSingleReferenceFolderAction(context: ReferenceModel) {
  const picked = await pickDirectory({
    title: "Load Translated Manga Folders", defaultPath: context.importForm.sourceFolder || undefined,
  });
  if (picked.canceled || !picked.path) return;
  appendQueuedFolderPaths(context, [picked.path]);
  context.setImportForm((current) => ({ ...current, sourceFolder: picked.path || "" }));
}

async function pickMultipleReferenceFoldersAction(context: ReferenceModel) {
  const picked = await pickDirectories({
    title: "Load Translated Manga Folders", defaultPath: context.importForm.sourceFolder || undefined,
  });
  if (picked.canceled || picked.paths.length === 0) return;
  appendQueuedFolderPaths(context, picked.paths);
  context.setImportForm((current) => ({ ...current, sourceFolder: picked.paths[0] || current.sourceFolder }));
}

async function confirmDeleteReferenceAction(
  context: ReferenceModel,
  mutation: ReferenceMutations["deleteReferenceSetMutation"],
  referenceSet: ReferenceSetSummary,
) {
  const confirmed = await confirmDialog({
    title: context.t("reference.worklist.deleteDialog.title"),
    message: context.t("reference.worklist.deleteDialog.message", {
      label: referenceSet.chapterTitle || referenceSet.label, pages: referenceSet.pageCount || 0,
    }),
    detail: context.t("reference.worklist.deleteDialog.detail"),
    confirmLabel: context.t("reference.worklist.delete"),
  });
  if (confirmed) mutation.mutate(referenceSet.id);
}

async function confirmDeleteExtractionAction(
  context: ReferenceModel,
  mutation: ReferenceMutations["deleteReferenceExtractionMutation"],
  referenceSet: ReferenceSetSummary,
) {
  const confirmed = await confirmDialog({
    title: context.t("reference.workspace.deleteExtractionTitle"),
    message: context.t("reference.workspace.deleteExtractionMessage", {
      label: referenceSet.chapterTitle || referenceSet.label,
    }),
    confirmLabel: context.t("reference.data.deleteExtraction"),
  });
  if (confirmed) mutation.mutate(referenceSet.id);
}

function librarySelectionContext(context: ReferenceModel): LibrarySelectionContext {
  return {
    referenceSets: context.referenceSetOptions, detailTab: context.detailTab,
    setReportMangaId: context.setSelectedReportMangaId,
    setReportTranslatorId: context.setSelectedReportTranslatorId,
    setImportForm: context.setImportForm, setIngestionForm: context.setIngestionForm,
    setExtractionForm: context.setExtractionForm, setWorklist: context.setReferenceWorklist,
    setDetailTab: context.setDetailTab,
  };
}

function openReferenceJobsAction(context: ReferenceModel) {
  if (context.selectedReferenceJobId) context.setSelectedJobId(context.selectedReferenceJobId);
  if (context.selectedReportMangaId) context.setSelectedMangaId(context.selectedReportMangaId);
  if (context.selectedReportTranslatorId) context.setSelectedTranslatorId(context.selectedReportTranslatorId);
  context.setSelectedPage("job-list");
}

function useReferencePageActions(context: ReferenceModel, mutations: ReferenceMutations) {
  const worklistActions = useReferenceWorklistActionBindings(context);
  const addReferenceSetsToWorklist = (sets: ReferenceSetSummary[]) => addReferenceSetsToWorklistAction(context, sets);
  return {
    ...worklistActions,
    resolveProfileAndChapter: () => resolveProfileAndChapterAction(
      context.selectedManga, context.selectedTranslator, context.ingestionForm, context.referenceSetOptions),
    resolveImportBinding: () => resolveImportBindingAction(
      context.selectedImportManga, context.selectedImportTranslator, context.importForm),
    addReferenceSetsToWorklist,
    addReferenceSetToWorklist: (referenceSet: ReferenceSetSummary) => addReferenceSetsToWorklist([referenceSet]),
    pickSingleReferenceFolder: () => pickSingleReferenceFolderAction(context),
    pickMultipleReferenceFolders: () => pickMultipleReferenceFoldersAction(context),
    confirmDeleteReference: (referenceSet: ReferenceSetSummary) =>
      confirmDeleteReferenceAction(context, mutations.deleteReferenceSetMutation, referenceSet),
    confirmDeleteExtraction: (referenceSet: ReferenceSetSummary) =>
      confirmDeleteExtractionAction(context, mutations.deleteReferenceExtractionMutation, referenceSet),
    selectLibrarySource: (manga: MangaSeriesSummary, translator: TranslatorProfileSummary) =>
      selectLibrarySourceAction(librarySelectionContext(context), manga, translator),
    openReferenceJobs: () => openReferenceJobsAction(context),
  };
}

function useReferencePageController() {
  const foundation = useReferencePageFoundation();
  const options = useReferenceOptions(foundation);
  const profiles = useReferenceProfileSelections(foundation, options);
  const report = useReferenceReportSelection(foundation, options);
  const jobs = useReferenceJobsState(foundation);
  const derived = useReferenceWorklistDerived(foundation, options, jobs);
  const blockers = resolveReferenceBlockers(foundation, derived);
  const model = { ...foundation, ...options, ...profiles, ...report, ...jobs, ...derived, ...blockers };
  const dataMutations = useReferenceDataMutations(model);
  const reviewMutations = useReferenceReviewMutations(model);
  const enrichmentMutations = useReferenceEnrichmentMutations(model);
  const mutations = { ...dataMutations, ...reviewMutations, ...enrichmentMutations };
  const actions = useReferencePageActions(model, mutations);
  return { ...model, ...mutations, ...actions };
}
export type ReferencePageController = ReturnType<typeof useReferencePageController>;

function ReferenceWorkbenchHeader(c: ReferencePageController) {
  const source = c.selectedReportManga && c.selectedReportTranslator
    ? `${c.selectedReportManga.label} / ${c.selectedReportTranslator.label}`
    : c.t("reference.workspace.selectSource");
  return (
    <header className="reference-workbench-header">
      <div>
        <h1>{c.t("reference.page.title")}</h1>
        <p className="muted-text">{source}</p>
      </div>
      <div className="reference-workbench-header-actions">
        <span className="reference-workbench-status">{c.pageStatus}</span>
        <button className="secondary-button" type="button" onClick={c.openReferenceJobs}>
          {c.t("reference.workspace.openJobs")}
        </button>
      </div>
    </header>
  );
}

function selectLibraryManga(c: ReferencePageController, mangaId: string) {
  if (mangaId === c.selectedReportMangaId) return;
  c.setSelectedReportMangaId(mangaId);
  c.setSelectedReportTranslatorId("");
  c.setReferenceWorklist([]);
  c.setExtractionForm((current) => ({ ...current, referenceSetId: "" }));
  c.setIngestionForm((current) => ({
    ...current, mangaSelection: mangaId, translatorSelection: "", referenceSetId: "",
  }));
  c.setImportForm((current) => ({ ...current, mangaSelection: mangaId, translatorSelection: "" }));
  c.setDetailTab("report");
}

function ReferenceLibrary(c: ReferencePageController) {
  return (
    <ReferenceLibraryPane
      mangaSeries={c.mangaSeriesOptions} referenceSets={c.referenceSetOptions}
      selectedMangaId={c.selectedReportMangaId} selectedTranslatorId={c.selectedReportTranslatorId}
      loading={c.mangaSeriesQuery.isLoading} failed={c.mangaSeriesQuery.isError}
      onSelectManga={(mangaId) => selectLibraryManga(c, mangaId)}
      onSelectSource={c.selectLibrarySource}
      onImport={() => c.setImportPanelOpen((current) => !current)}
    />
  );
}

function ReferenceCenterHeading(c: ReferencePageController) {
  const subtitle = c.selectedReportTranslator
    ? c.t("reference.workspace.chapterCount", { count: c.referenceWorklist.length })
    : c.t("reference.workspace.selectSource");
  return (
    <div className="reference-pane-heading">
      <div>
        <h2>{c.t("reference.workspace.chapterTitle")}</h2>
        <p>{subtitle}</p>
      </div>
      <button className="secondary-button" type="button"
        onClick={() => c.setImportPanelOpen((current) => !current)}>
        {c.t(c.importPanelOpen ? "reference.workspace.importClose" : "reference.workspace.importAction")}
      </button>
    </div>
  );
}

function ReferenceImportSection(c: ReferencePageController) {
  if (!c.importPanelOpen) return null;
  return (
    <div className="reference-import-inline">
      <ReferenceImportPane
        importForm={c.importForm} setImportForm={c.setImportForm} importQueue={c.queuedReferenceFolders}
        isWorklistImporting={c.isWorklistImporting} mangaSeriesOptions={c.mangaSeriesOptions}
        mangaSeriesLoading={c.mangaSeriesQuery.isLoading} mangaSeriesFailed={c.mangaSeriesQuery.isError}
        availableImportTranslators={c.availableImportTranslators} isSourceReferenceKind={isSourceReferenceKind}
        sourceReferenceTranslatorLabel={SOURCE_REFERENCE_TRANSLATOR_LABEL}
        hasSourceReferenceInWorklist={c.hasSourceReferenceInWorklist}
        hasTranslatorReferenceInWorklist={c.hasTranslatorReferenceInWorklist}
        importBlockedReason={c.importBlockedReason} removeQueuedReferenceFolder={c.removeQueuedReferenceFolder}
        updateQueuedReferenceFolderLabel={c.updateQueuedReferenceFolderLabel}
        importQueuedReferenceFolders={c.importQueuedReferenceFolders} pickSingleFolder={c.pickSingleReferenceFolder}
        pickMultipleFolders={c.pickMultipleReferenceFolders} clearQueuedReferenceFolders={c.clearQueuedReferenceFolders}
      />
    </div>
  );
}

function reviewWorklistExtraction(c: ReferencePageController, referenceSet: ReferenceSetSummary) {
  c.setDetailTab("review");
  c.setExtractionForm((current) => ({ ...current, referenceSetId: referenceSet.id }));
  c.startExtractionReviewMutation.mutate(referenceSet.id);
}

function finishWorklistReview(c: ReferencePageController, referenceSet: ReferenceSetSummary) {
  c.setExtractionForm((current) => ({ ...current, referenceSetId: referenceSet.id }));
  if (!c.activeReviewSessionId) return;
  c.finishExtractionReviewMutation.mutate({
    referenceSetId: referenceSet.id,
    sessionId: c.activeReviewSessionId,
  });
}

function ReferenceWorklist(c: ReferencePageController) {
  const reviewPending = c.startExtractionReviewMutation.isPending
    || c.finishExtractionReviewMutation.isPending || c.cancelExtractionReviewMutation.isPending;
  return (
    <ReferenceWorklistPane
      ingestionForm={c.ingestionForm} setIngestionForm={c.setIngestionForm}
      styleOptionDisabledForWorklist={c.styleOptionDisabledForWorklist}
      hasSourceReferenceInWorklist={c.hasSourceReferenceInWorklist}
      hasTranslatorReferenceInWorklist={c.hasTranslatorReferenceInWorklist}
      referenceWorklist={c.referenceWorklist} referenceSetMap={c.referenceSetMap}
      mangaSeriesOptions={c.mangaSeriesOptions} referenceJobs={c.referenceJobs}
      latestReferenceJobForSet={latestReferenceJobForSet} statusLabel={statusLabel}
      extractionMutationPending={c.extractionMutation.isPending} ingestionMutationPending={c.ingestionMutation.isPending}
      reviewMutationPending={reviewPending} activeReviewReferenceSetId={c.activeReviewReferenceSetId}
      worklistEntriesMissingExtraction={c.worklistEntriesMissingExtraction}
      extractionBlockedReason={c.extractionBlockedReason} ingestionBlockedReason={c.ingestionBlockedReason}
      removeWorklistEntry={c.removeWorklistEntry} deleteReferencePending={c.deleteReferenceSetMutation.isPending}
      deleteExtractionPending={c.deleteReferenceExtractionMutation.isPending}
      confirmDeleteExtraction={c.confirmDeleteExtraction} confirmDeleteReference={c.confirmDeleteReference}
      selectReferenceMaterial={c.selectReferenceMaterial} runWorklistExtraction={c.runWorklistExtraction}
      runWorklistIngestion={c.runWorklistIngestion} runWorklistItemExtraction={c.runWorklistItemExtraction}
      runWorklistItemIngestion={c.runWorklistItemIngestion} deepReviewPending={c.deepReviewMutation.isPending}
      runDeepReview={(referenceSet) => c.deepReviewMutation.mutate(referenceSet.id)}
      reviewExtraction={(referenceSet) => reviewWorklistExtraction(c, referenceSet)}
      finishReviewEditing={(referenceSet) => finishWorklistReview(c, referenceSet)}
      selectedReferenceSetId={c.extractionForm.referenceSetId}
    />
  );
}

function ReferenceCenterPane(c: ReferencePageController) {
  return (
    <main className="reference-center-pane reference-workbench-pane">
      <ReferenceCenterHeading {...c} />
      <div className="reference-pane-scroll reference-center-scroll">
        <ReferenceImportSection {...c} />
        <ReferenceWorklist {...c} />
      </div>
    </main>
  );
}

function ReferenceDetailTabs(c: ReferencePageController) {
  const tabClass = (tab: typeof c.detailTab) =>
    c.detailTab === tab ? "reference-detail-tab active" : "reference-detail-tab";
  return (
    <div className="reference-detail-tabs" role="tablist">
      <button className={tabClass("report")} type="button" onClick={() => c.setDetailTab("report")}>
        {c.t("reference.workspace.reportTab")}
      </button>
      <button className={tabClass("review")} type="button" onClick={() => c.setDetailTab("review")}>
        {c.t("reference.workspace.reviewTab")}
      </button>
      {c.selectedReportTranslator && !c.selectedReportTranslatorIsSource ? (
        <button className={tabClass("bilingual")} type="button" onClick={() => c.setDetailTab("bilingual")}>
          {c.t("reference.workspace.bilingualTab")}
        </button>
      ) : null}
    </div>
  );
}

type ActiveReviewMutation = (payload: { referenceSetId: string; sessionId: string }) => void;

function mutateActiveReview(c: ReferencePageController, mutate: ActiveReviewMutation) {
  if (!c.activeReviewReferenceSetId || !c.activeReviewSessionId) return;
  mutate({ referenceSetId: c.activeReviewReferenceSetId, sessionId: c.activeReviewSessionId });
}

function extractionReviewActions(c: ReferencePageController) {
  return {
    onStart: () => {
      if (c.selectedReferenceSetSummary) c.startExtractionReviewMutation.mutate(c.selectedReferenceSetSummary.id);
    },
    onSync: () => mutateActiveReview(c, c.syncExtractionReviewMutation.mutate),
    onFinishEditor: () => mutateActiveReview(c, c.finishExtractionReviewMutation.mutate),
    onCancel: () => mutateActiveReview(c, c.cancelExtractionReviewMutation.mutate),
    onSaveOrder: (pages: Array<{ pageId: string; nodeIds: string[] }>) => {
      if (!c.selectedReferenceSetSummary) return;
      c.saveExtractionReviewOrderMutation.mutate({ referenceSetId: c.selectedReferenceSetSummary.id, pages });
    },
    onConfirm: () => {
      if (c.selectedReferenceSetSummary) c.confirmExtractionReviewMutation.mutate(c.selectedReferenceSetSummary.id);
    },
  };
}

function ExtractionReviewDetail(c: ReferencePageController) {
  if (c.detailTab !== "review") return null;
  const busy = c.startExtractionReviewMutation.isPending || c.syncExtractionReviewMutation.isPending
    || c.finishExtractionReviewMutation.isPending || c.cancelExtractionReviewMutation.isPending
    || c.saveExtractionReviewOrderMutation.isPending || c.confirmExtractionReviewMutation.isPending;
  const activeSessionId = c.activeReviewReferenceSetId === c.selectedReferenceSetSummary?.id
    ? c.activeReviewSessionId : null;
  return (
    <ExtractionReviewPane
      referenceSet={c.selectedReferenceSetSummary} review={c.extractionReviewQuery.data?.review || null}
      loading={c.extractionReviewQuery.isLoading} error={c.extractionReviewQuery.isError}
      busy={busy} activeSessionId={activeSessionId} {...extractionReviewActions(c)}
    />
  );
}

function runBilingualEnrichmentAction(c: ReferencePageController) {
  if (!c.selectedAlignmentEntry?.mangaId || !c.selectedAlignmentEntry.translatorId) return;
  c.runBilingualEnrichmentMutation.mutate({
    mangaId: c.selectedAlignmentEntry.mangaId,
    translatorId: c.selectedAlignmentEntry.translatorId,
  });
}

function updateBilingualAction(c: ReferencePageController, linkId: string, action: "accept" | "unbind") {
  const document = c.bilingualEvidenceQuery.data;
  if (!document) return;
  c.updateBilingualEvidenceMutation.mutate({
    mangaId: document.mangaId, translatorId: document.translatorId, linkId, action,
  });
}

function BilingualEvidenceDetail(c: ReferencePageController) {
  if (c.detailTab !== "bilingual") return null;
  return (
    <BilingualEvidencePane
      visible={c.selectedAlignmentIsTranslator} document={c.bilingualEvidenceQuery.data || null}
      loading={c.bilingualEvidenceQuery.isLoading} running={c.runBilingualEnrichmentMutation.isPending}
      updating={c.updateBilingualEvidenceMutation.isPending}
      onRun={() => runBilingualEnrichmentAction(c)}
      onUpdate={(linkId, action) => updateBilingualAction(c, linkId, action)}
    />
  );
}

async function confirmDeleteIngestion(c: ReferencePageController, manga: MangaSeriesSummary, translator: TranslatorProfileSummary) {
  const confirmed = await confirmDialog({
    title: c.t("reference.workspace.deleteIngestionTitle"),
    message: c.t("reference.workspace.deleteIngestionMessage", {
      manga: manga.label,
      translator: translator.label,
    }),
    confirmLabel: c.t("reference.workspace.deleteIngestionTitle"),
  });
  if (confirmed) c.deleteIngestionMutation.mutate({ mangaId: manga.mangaId, translatorId: translator.translatorId });
}

function IngestionReportDetail(c: ReferencePageController) {
  if (c.detailTab !== "report" || !c.selectedReportManga || !c.selectedReportTranslator) return null;
  return (
    <div className="reference-report-embedded">
      <IngestionReportPane
        embedded mangaSeriesLoading={c.mangaSeriesQuery.isLoading} mangaSeriesError={c.mangaSeriesQuery.isError}
        mangaSeriesOptions={c.mangaSeriesOptions} referenceSets={c.referenceSetOptions}
        selectedReportMangaId={c.selectedReportMangaId} selectedReportTranslatorId={c.selectedReportTranslatorId}
        setSelectedReportMangaId={c.setSelectedReportMangaId}
        setSelectedReportTranslatorId={c.setSelectedReportTranslatorId}
        ingestionReportLoading={c.ingestionReportQuery.isLoading} ingestionReportError={c.ingestionReportQuery.isError}
        ingestionReportData={c.ingestionReportQuery.data} deleteIngestionPending={c.deleteIngestionMutation.isPending}
        deleteExtractionPending={c.deleteReferenceExtractionMutation.isPending}
        deleteReferencePending={c.deleteReferenceSetMutation.isPending}
        worklistReferenceSetIds={c.referenceWorklist.map((entry) => entry.referenceSetId)}
        addReferenceSetToWorklist={c.addReferenceSetToWorklist}
        addReferenceSetsToWorklist={c.addReferenceSetsToWorklist}
        confirmDeleteExtraction={c.confirmDeleteExtraction} confirmDeleteReference={c.confirmDeleteReference}
        confirmDeleteIngestion={(manga, translator) => confirmDeleteIngestion(c, manga, translator)}
      />
    </div>
  );
}

function ReferenceDetailPane(c: ReferencePageController) {
  const empty = c.detailTab === "report" && (!c.selectedReportManga || !c.selectedReportTranslator);
  return (
    <aside className="reference-detail-pane reference-workbench-pane">
      <ReferenceDetailTabs {...c} />
      <div className="reference-pane-scroll reference-detail-scroll">
        <ExtractionReviewDetail {...c} />
        <BilingualEvidenceDetail {...c} />
        <IngestionReportDetail {...c} />
        {empty ? <p className="muted-text reference-detail-empty">{c.t("reference.workspace.selectSource")}</p> : null}
      </div>
    </aside>
  );
}

export function ReferencePageContent() {
  const controller = useReferencePageController();
  return (
    <section className="page reference-workspace-page">
      <ReferenceWorkbenchHeader {...controller} />
      <div className="reference-workbench-layout">
        <ReferenceLibrary {...controller} />
        <ReferenceCenterPane {...controller} />
        <ReferenceDetailPane {...controller} />
      </div>
    </section>
  );
}
