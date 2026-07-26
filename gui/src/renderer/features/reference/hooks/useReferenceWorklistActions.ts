import type { QueryClient } from "@tanstack/react-query";
import type {
  GuiJob,
  ImportedReferenceSet,
  ReferenceExtractionPayload,
  ReferenceIngestionPayload,
  ReferenceSetSummary,
} from "../../../api/jobs";
import type {
  ImportedReferenceBinding,
  LatestReferenceJobResolver,
  QueuedReferenceFolder,
  ReferenceImportForm,
  ReferenceIngestionForm,
} from "../types";

type BindingResolution = {
  mangaId: string;
  mangaLabel: string;
  translatorId?: string;
  translatorLabel?: string;
  chapterId?: string;
  chapterTitle?: string;
};

type WorklistActionParams = {
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
  resolveProfileAndChapter: () => Promise<{
    mangaId: string;
    mangaLabel: string;
    translatorId: string;
    translatorLabel: string;
    chapterId: string;
    chapterTitle?: string;
  } | null>;
  createChapterForBinding: (
    mangaId: string,
    translatorId: string,
    chapterTitle: string
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
  createReferenceIngestionJobsFn: (
    payloads: ReferenceIngestionPayload[]
  ) => Promise<{ jobs: GuiJob[] }>;
  normalizeChapterTitleLabel: (value: string | null | undefined, fallback?: string) => string;
  folderBaseName: (sourceFolder: string) => string;
  normalizeReferenceLanguage: (value: string) => string;
  isSourceReferenceKind: (value: string | null | undefined) => value is "source";
  latestReferenceJobForSet: LatestReferenceJobResolver;
  queryClient: QueryClient;
};

export function useReferenceWorklistActions(params: WorklistActionParams) {
  const {
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
    createChapterForBinding,
    importReferenceFolderFn,
    createReferenceExtractionJobFn,
    createReferenceIngestionJobFn,
    createReferenceIngestionJobsFn,
    normalizeChapterTitleLabel,
    folderBaseName,
    normalizeReferenceLanguage,
    isSourceReferenceKind,
    latestReferenceJobForSet,
    queryClient,
  } = params;

  const selectReferenceMaterial = (referenceSetId: string, label: string) => {
    const preferredJob =
      latestReferenceJobForSet(referenceJobs, referenceSetId, "reference_ingestion") ||
      latestReferenceJobForSet(referenceJobs, referenceSetId, "reference_extraction");
    setExtractionForm((current) => ({
      ...current,
      referenceSetId,
    }));
    setIngestionForm((current) => ({
      ...current,
      referenceSetId,
    }));
    setSelectedReferenceJobId(preferredJob?.id || null);
    setPageStatus(`已選取 Reference：${label} (${referenceSetId})`);
  };

  const importQueuedReferenceFolders = async () => {
    if (queuedReferenceFolders.length === 0) {
      setPageStatus("請先載入至少一筆 Reference 資料夾。");
      return;
    }

    setIsWorklistImporting(true);
    try {
      const baseBinding = importForm.mangaSelection ? await resolveImportBinding() : null;
      if (importForm.mangaSelection && !baseBinding) {
        setPageStatus("請先完成漫畫與譯者綁定。");
        return;
      }

      const importedReferenceSets: ImportedReferenceSet[] = [];
      const importedBindings: ImportedReferenceBinding[] = [];

      for (const entry of queuedReferenceFolders) {
        let chapterId = baseBinding?.chapterId;
        let chapterTitle = baseBinding?.chapterTitle;

        if (baseBinding?.mangaId && baseBinding?.translatorId && !chapterId) {
          const createdChapter = await createChapterForBinding(
            baseBinding.mangaId,
            baseBinding.translatorId,
            normalizeChapterTitleLabel(entry.label, folderBaseName(entry.sourceFolder))
          );
          chapterId = createdChapter.chapterId;
          chapterTitle = createdChapter.chapterTitle;
        }

        setPageStatus(`正在匯入 ${entry.label}...`);
        const { referenceSet } = await importReferenceFolderFn({
          sourceFolder: entry.sourceFolder,
          label: entry.label.trim() || folderBaseName(entry.sourceFolder),
          language: normalizeReferenceLanguage(importForm.language),
          referenceKind: importForm.referenceKind,
          mangaId: baseBinding?.mangaId,
          mangaLabel: baseBinding?.mangaLabel,
          translatorId: baseBinding?.translatorId,
          translatorLabel: baseBinding?.translatorLabel,
          chapterId,
          chapterTitle,
        });

        importedReferenceSets.push(referenceSet);
        importedBindings.push({
          referenceSetId: referenceSet.id,
          label: referenceSet.label,
          referenceKind: referenceSet.referenceKind || importForm.referenceKind,
          mangaId: baseBinding?.mangaId,
          mangaLabel: baseBinding?.mangaLabel,
          translatorId: baseBinding?.translatorId,
          translatorLabel: baseBinding?.translatorLabel,
          chapterId,
          chapterTitle,
          language: normalizeReferenceLanguage(importForm.language),
        });
      }

      if (importedReferenceSets.length > 0) {
        const firstImported = importedReferenceSets[0];
        setExtractionForm((current) => ({
          ...current,
          referenceSetId: firstImported.id,
        }));
        setIngestionForm((current) => ({
          ...current,
          referenceSetId: firstImported.id,
        }));
      }

      clearQueuedReferenceFolders();
      appendWorklistEntries(importedBindings);
      setImportForm((current) => ({
        ...current,
        sourceFolder: "",
        label: "",
      }));
      setPageStatus(`已匯入 ${importedReferenceSets.length} 筆 Reference。`);
      await queryClient.invalidateQueries({ queryKey: ["referenceSets"] });
      await queryClient.invalidateQueries({ queryKey: ["mangaSeries"] });
    } catch (error) {
      setPageStatus(error instanceof Error ? error.message : "匯入 Reference 失敗。");
    } finally {
      setIsWorklistImporting(false);
    }
  };

  const runWorklistExtraction = async () => {
    if (referenceWorklist.length === 0) {
      setPageStatus("工作區目前為空，無法建立 Extraction。");
      return;
    }

    setIsWorklistExtracting(true);
    try {
      const fallbackBinding = await resolveProfileAndChapter();
      let lastJobId: string | null = null;
      const nextWorklistState: ImportedReferenceBinding[] = [];

      for (const entry of referenceWorklist) {
        const mangaId = entry.mangaId || fallbackBinding?.mangaId;
        const mangaLabel = entry.mangaLabel || fallbackBinding?.mangaLabel;
        const translatorId = entry.translatorId || fallbackBinding?.translatorId;
        const translatorLabel = entry.translatorLabel || fallbackBinding?.translatorLabel;
        let chapterId = entry.chapterId || fallbackBinding?.chapterId;
        let chapterTitle = entry.chapterTitle || fallbackBinding?.chapterTitle;

        if (mangaId && translatorId && !chapterId) {
          const createdChapter = await createChapterForBinding(
            mangaId,
            translatorId,
            normalizeChapterTitleLabel(entry.label)
          );
          chapterId = createdChapter.chapterId;
          chapterTitle = createdChapter.chapterTitle;
        }

        if (!chapterId) {
          throw new Error(`Missing chapter binding for ${entry.label}.`);
        }

        setPageStatus(`正在為 ${entry.label} 建立 Extraction Job...`);
        const job = await createReferenceExtractionJobFn({
          referenceSetId: entry.referenceSetId,
          targetLanguage: entry.language,
          mangaId,
          mangaLabel,
          translatorId,
          translatorLabel,
          chapterId,
          chapterTitle,
          chapterLabel: chapterTitle,
          referenceKind: isSourceReferenceKind(entry.referenceKind) ? "source" : "translator",
        });
        lastJobId = job.id;
        await queryClient.invalidateQueries({ queryKey: ["jobs"] });
        nextWorklistState.push({
          ...entry,
          mangaId: entry.mangaId || fallbackBinding?.mangaId,
          mangaLabel: entry.mangaLabel || fallbackBinding?.mangaLabel,
          translatorId,
          translatorLabel,
          chapterId,
          chapterTitle,
        });
      }

      appendWorklistEntries(nextWorklistState);
      if (lastJobId) {
        setSelectedReferenceJobId(lastJobId);
      }
      setPageStatus(`已建立 ${referenceWorklist.length} 筆 Extraction Job。`);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    } catch (error) {
      setPageStatus(error instanceof Error ? error.message : "建立 Extraction Job 失敗。");
    } finally {
      setIsWorklistExtracting(false);
    }
  };

  const runWorklistIngestion = async () => {
    if (referenceWorklist.length === 0) {
      setPageStatus("工作區目前為空，無法建立 Ingestion。");
      return;
    }
    if (styleOptionDisabledForWorklist && !ingestionForm.useForTerminology) {
      setPageStatus("原文 Reference 不會建立翻譯風格，至少需要啟用專有名詞用途。");
      return;
    }
    if (!ingestionForm.useForTerminology && !ingestionForm.useForStyle) {
      setPageStatus("請至少選擇一個 Ingestion 用途。");
      return;
    }
    if (worklistEntriesMissingExtraction.length > 0) {
      setPageStatus(`需先完成 Extraction：${worklistEntriesMissingExtraction.map((entry) => entry.label).join(", ")}`);
      return;
    }
    setIsWorklistIngesting(true);
    try {
      const fallbackBinding = await resolveProfileAndChapter();
      const hasFallbackBinding = Boolean(fallbackBinding?.mangaId && fallbackBinding?.translatorId);
      const missingBindings = referenceWorklist.filter(
        (entry) => !(entry.mangaId && entry.translatorId) && !hasFallbackBinding
      );
      if (missingBindings.length > 0) {
        setPageStatus("Worklist Ingestion 需要漫畫、譯者與章節綁定，請先完成 Reference 匯入綁定。");
        return;
      }

      const nextWorklistState: ImportedReferenceBinding[] = [];
      const ingestionPayloads: ReferenceIngestionPayload[] = [];

      for (const entry of referenceWorklist) {
        const mangaId = entry.mangaId || fallbackBinding?.mangaId;
        const mangaLabel = entry.mangaLabel || fallbackBinding?.mangaLabel;
        const translatorId = entry.translatorId || fallbackBinding?.translatorId;
        const translatorLabel = entry.translatorLabel || fallbackBinding?.translatorLabel;
        let chapterId = entry.chapterId || fallbackBinding?.chapterId;
        let chapterTitle = entry.chapterTitle || fallbackBinding?.chapterTitle;

        if (mangaId && translatorId && !chapterId) {
          const createdChapter = await createChapterForBinding(
            mangaId,
            translatorId,
            normalizeChapterTitleLabel(entry.label)
          );
          chapterId = createdChapter.chapterId;
          chapterTitle = createdChapter.chapterTitle;
        }

        if (!mangaId || !translatorId || !chapterId) {
          throw new Error("Missing manga, translator, or chapter binding for worklist ingestion.");
        }

        ingestionPayloads.push({
          referenceSetId: entry.referenceSetId,
          mangaId,
          mangaLabel,
          translatorId,
          translatorLabel,
          chapterId,
          chapterTitle,
          chapterLabel: chapterTitle,
          referenceKind: isSourceReferenceKind(entry.referenceKind) ? "source" : "translator",
          useForTerminology: ingestionForm.useForTerminology,
          useForStyle: ingestionForm.useForStyle && !isSourceReferenceKind(entry.referenceKind),
          analysisDepth: ingestionForm.analysisDepth,
          translator: translatorLabel,
        });
        nextWorklistState.push({
          ...entry,
          mangaId,
          mangaLabel,
          translatorId,
          translatorLabel,
          chapterId,
          chapterTitle,
        });
      }

      setPageStatus(`正在依章節順序建立 ${ingestionPayloads.length} 筆 Ingestion Job...`);
      const { jobs } = await createReferenceIngestionJobsFn(ingestionPayloads);
      appendWorklistEntries(nextWorklistState);
      if (jobs.length > 0) {
        setSelectedReferenceJobId(jobs[jobs.length - 1].id);
      }
      setPageStatus(`已建立 ${referenceWorklist.length} 筆 Ingestion Job。`);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    } catch (error) {
      setPageStatus(error instanceof Error ? error.message : "建立 Ingestion Job 失敗。");
    } finally {
      setIsWorklistIngesting(false);
    }
  };

  const runWorklistItemExtraction = async (
    referenceSet: ReferenceSetSummary,
    worklistEntry: ImportedReferenceBinding | null
  ) => {
    if (!worklistEntry) {
      setPageStatus("缺少工作區項目，無法建立單筆 Extraction Job。");
      return;
    }

    const translatorLabel = worklistEntry.translatorLabel || worklistEntry.translatorId || undefined;

    await createReferenceExtractionJobFn({
      referenceSetId: referenceSet.id,
      targetLanguage: worklistEntry.language || referenceSet.language || undefined,
      mangaId: worklistEntry.mangaId,
      mangaLabel: worklistEntry.mangaLabel,
      translatorId: worklistEntry.translatorId,
      translatorLabel,
      chapterId: worklistEntry.chapterId,
      chapterTitle: worklistEntry.chapterTitle,
      chapterLabel: worklistEntry.chapterTitle,
      referenceKind: isSourceReferenceKind(worklistEntry.referenceKind) ? "source" : "translator",
    });
    selectReferenceMaterial(referenceSet.id, referenceSet.label);
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };

  const runWorklistItemIngestion = async (
    referenceSet: ReferenceSetSummary,
    worklistEntry: ImportedReferenceBinding | null
  ) => {
    if (!worklistEntry) {
      setPageStatus("缺少工作區項目，無法建立單筆 Ingestion Job。");
      return;
    }

    const extractionJob = latestReferenceJobForSet(referenceJobs, referenceSet.id, "reference_extraction");
    if (referenceSet.extractionAvailable !== true && extractionJob?.status !== "succeeded") {
      setPageStatus(`需先完成 ${referenceSet.label} 的 Extraction，才能執行 Ingestion。`);
      return;
    }

    if (isSourceReferenceKind(worklistEntry.referenceKind) && !ingestionForm.useForTerminology) {
      setPageStatus("原文 Reference 不會建立翻譯風格，至少需要啟用專有名詞用途。");
      return;
    }
    if (!ingestionForm.useForTerminology && !ingestionForm.useForStyle) {
      setPageStatus("請至少選擇一個 Ingestion 用途。");
      return;
    }

    if (!worklistEntry.mangaId || !worklistEntry.translatorId || !worklistEntry.chapterId) {
      setPageStatus(`缺少 ${referenceSet.label} 的漫畫、譯者或章節綁定，無法執行 Ingestion。`);
      return;
    }

    await createReferenceIngestionJobFn({
      referenceSetId: referenceSet.id,
      mangaId: worklistEntry.mangaId,
      mangaLabel: worklistEntry.mangaLabel,
      translatorId: worklistEntry.translatorId,
      translatorLabel: worklistEntry.translatorLabel,
      chapterId: worklistEntry.chapterId,
      chapterTitle: worklistEntry.chapterTitle,
      chapterLabel: worklistEntry.chapterTitle,
      referenceKind: isSourceReferenceKind(worklistEntry.referenceKind) ? "source" : "translator",
      useForTerminology: ingestionForm.useForTerminology,
      useForStyle: ingestionForm.useForStyle && !isSourceReferenceKind(worklistEntry.referenceKind),
      analysisDepth: ingestionForm.analysisDepth,
      translator: worklistEntry.translatorLabel,
    });
    selectReferenceMaterial(referenceSet.id, referenceSet.label);
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };

  return {
    selectReferenceMaterial,
    importQueuedReferenceFolders,
    runWorklistExtraction,
    runWorklistIngestion,
    runWorklistItemExtraction,
    runWorklistItemIngestion,
  };
}
