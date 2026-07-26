import { useMemo } from "react";
import type {
  GuiJob,
  MangaSeriesSummary,
  ReferenceSetSummary,
  TranslatorProfileSummary,
} from "../../../api/jobs";
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

export function useReferenceJobActions({
  selectedJob,
  selectedReferenceSetSummary,
  selectedReferenceExtractionJob,
  selectedReferenceIngestionJob,
  selectedDeletionManga,
  selectedDeletionTranslator,
  retryReferenceJob,
  deleteReferenceJob,
  deleteReferenceExtractionResult,
  deleteIngestionResult,
  selectReferenceJob,
  openJobListPage,
}: ReferenceJobActionsParams) {
  return useMemo(
    () => ({
      retryJob() {
        if (selectedJob) {
          retryReferenceJob(selectedJob.id);
        }
      },
      openJobList() {
        if (selectedJob) {
          openJobListPage(selectedJob);
        }
      },
      deleteJob() {
        if (selectedJob) {
          deleteReferenceJob(selectedJob.id);
        }
      },
      viewExtraction() {
        selectReferenceJob(selectedReferenceExtractionJob?.id || null);
      },
      viewIngestion() {
        selectReferenceJob(selectedReferenceIngestionJob?.id || null);
      },
      async confirmDeleteExtraction() {
        if (!selectedReferenceSetSummary) {
          return;
        }
        const confirmed = await confirmDialog({
          title: "刪除 Extraction 結果",
          message: `確定要刪除 ${selectedReferenceSetSummary.label} 的 Extraction 結果與相關工作紀錄嗎？`,
          confirmLabel: "刪除 Extraction",
        });
        if (!confirmed) {
          return;
        }
        deleteReferenceExtractionResult(selectedReferenceSetSummary.id);
      },
      async confirmDeleteIngestion() {
        if (!selectedDeletionManga || !selectedDeletionTranslator) {
          return;
        }
        const confirmed = await confirmDialog({
          title: "刪除 Ingestion 結果",
          message: `確定要刪除 ${selectedDeletionManga.label} / ${selectedDeletionTranslator.label} 的 Ingestion 結果與相關工作紀錄嗎？`,
          confirmLabel: "刪除 Ingestion",
        });
        if (!confirmed) {
          return;
        }
        deleteIngestionResult(selectedDeletionManga.mangaId, selectedDeletionTranslator.translatorId);
      },
    }),
    [
      deleteIngestionResult,
      deleteReferenceExtractionResult,
      deleteReferenceJob,
      openJobListPage,
      retryReferenceJob,
      selectReferenceJob,
      selectedDeletionManga,
      selectedDeletionTranslator,
      selectedJob,
      selectedReferenceExtractionJob,
      selectedReferenceIngestionJob,
      selectedReferenceSetSummary,
    ]
  );
}
