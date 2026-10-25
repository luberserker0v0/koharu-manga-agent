import { useMemo } from "react";
import type { GuiJob, MangaSeriesSummary, ReferenceSetSummary, TranslatorProfileSummary } from "../../../api/jobs";
import { confirmDialog } from "../../../services/desktop_api";
import type { ReferenceJobSummaryLike } from "../types";

type ReferenceJobActionsParams = {
  selectedJob: ReferenceJobSummaryLike;
  selectedReferenceSetSummary: ReferenceSetSummary | null;
  selectedReferenceExtractionJob: ReferenceJobSummaryLike;
  selectedReferenceIngestionJob: ReferenceJobSummaryLike;
  selectedDeletionManga: MangaSeriesSummary | null;
  selectedDeletionTranslator: TranslatorProfileSummary | null;
  retryReferenceJob: (jobId: string) => void;
  deleteReferenceJob: (jobId: string) => void;
  deleteReferenceExtractionResult: (referenceSetId: string) => void;
  deleteIngestionResult: (mangaId: string, translatorId: string) => void;
  selectReferenceJob: (jobId: string | null) => void;
  openJobListPage: (job: GuiJob) => void;
};

async function confirmDeleteExtraction(params: ReferenceJobActionsParams) {
  const reference = params.selectedReferenceSetSummary;
  if (!reference) return;
  const confirmed = await confirmDialog({
    title: "刪除 Extraction 結果",
    message: `確定要刪除 ${reference.label} 的 Extraction 結果與相關工作紀錄嗎？`,
    confirmLabel: "刪除 Extraction",
  });
  if (confirmed) params.deleteReferenceExtractionResult(reference.id);
}

async function confirmDeleteIngestion(params: ReferenceJobActionsParams) {
  const { selectedDeletionManga: manga, selectedDeletionTranslator: translator } = params;
  if (!manga || !translator) return;
  const confirmed = await confirmDialog({
    title: "刪除 Ingestion 結果",
    message: `確定要刪除 ${manga.label} / ${translator.label} 的 Ingestion 結果與相關工作紀錄嗎？`,
    confirmLabel: "刪除 Ingestion",
  });
  if (confirmed) params.deleteIngestionResult(manga.mangaId, translator.translatorId);
}

function createActions(params: ReferenceJobActionsParams) {
  return {
    retryJob: () => {
      if (params.selectedJob) params.retryReferenceJob(params.selectedJob.id);
    },
    openJobList: () => {
      if (params.selectedJob) params.openJobListPage(params.selectedJob);
    },
    deleteJob: () => {
      if (params.selectedJob) params.deleteReferenceJob(params.selectedJob.id);
    },
    viewExtraction: () => params.selectReferenceJob(params.selectedReferenceExtractionJob?.id || null),
    viewIngestion: () => params.selectReferenceJob(params.selectedReferenceIngestionJob?.id || null),
    confirmDeleteExtraction: () => confirmDeleteExtraction(params),
    confirmDeleteIngestion: () => confirmDeleteIngestion(params),
  };
}

export function useReferenceJobActions(params: ReferenceJobActionsParams) {
  return useMemo(
    () => createActions(params),
    [
      params.deleteIngestionResult,
      params.deleteReferenceExtractionResult,
      params.deleteReferenceJob,
      params.openJobListPage,
      params.retryReferenceJob,
      params.selectReferenceJob,
      params.selectedDeletionManga,
      params.selectedDeletionTranslator,
      params.selectedJob,
      params.selectedReferenceExtractionJob,
      params.selectedReferenceIngestionJob,
      params.selectedReferenceSetSummary,
    ],
  );
}
