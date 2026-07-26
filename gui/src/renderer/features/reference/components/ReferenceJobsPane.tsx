import type {
  GuiJob,
  MangaSeriesSummary,
  ReferenceSetSummary,
  TranslatorProfileSummary,
} from "../../../api/jobs";
import { SectionCard } from "../../shared/components/SectionCard";
import { SummaryGrid } from "../../shared/components/SummaryGrid";
import { useLanguageStore } from "../../../stores/language_store";
import type { IngestionResultSummary, ReferenceJobSummaryLike } from "../types";

type ReferenceJobsPaneProps = {
  selectedReferenceSetSummary: ReferenceSetSummary | null;
  selectedReferenceExtractionJob: ReferenceJobSummaryLike;
  selectedReferenceIngestionJob: ReferenceJobSummaryLike;
  selectedDeletionManga: MangaSeriesSummary | null;
  selectedDeletionTranslator: TranslatorProfileSummary | null;
  deleteReferenceExtractionPending: boolean;
  deleteIngestionPending: boolean;
  selectedJob: ReferenceJobSummaryLike;
  displayJobType: (type: string) => string;
  selectedJobSummary: (job: GuiJob | null) => Array<{ label: string; value: string }>;
  selectedIngestionSummary: IngestionResultSummary | null;
  retryJob: () => void;
  openJobList: () => void;
  deleteJob: () => void;
  viewExtraction: () => void;
  viewIngestion: () => void;
  confirmDeleteExtraction: () => Promise<void>;
  confirmDeleteIngestion: () => Promise<void>;
};

export function ReferenceJobsPane({
  selectedReferenceSetSummary,
  selectedReferenceExtractionJob,
  selectedReferenceIngestionJob,
  selectedDeletionManga,
  selectedDeletionTranslator,
  deleteReferenceExtractionPending,
  deleteIngestionPending,
  selectedJob,
  displayJobType,
  selectedJobSummary,
  selectedIngestionSummary,
  retryJob,
  openJobList,
  deleteJob,
  viewExtraction,
  viewIngestion,
  confirmDeleteExtraction,
  confirmDeleteIngestion,
}: ReferenceJobsPaneProps) {
  const t = useLanguageStore((state) => state.t);
  return (
    <SectionCard
      title={t("reference.section.jobs.title")}
      description={t("reference.section.jobs.description")}
    >
      {selectedReferenceSetSummary ? (
        <div className="artifact-summary-card">
          <SummaryGrid
            items={[
              { label: t("reference.jobs.currentReference"), value: selectedReferenceSetSummary.label },
              { label: t("shared.language"), value: selectedReferenceSetSummary.language },
              { label: t("shared.extraction"), value: selectedReferenceExtractionJob?.status || t("shared.notAvailable") },
              { label: t("shared.ingestion"), value: selectedReferenceIngestionJob?.status || t("shared.notAvailable") },
            ]}
          />
          <div className="button-row">
            <button className="secondary-button" type="button" disabled={!selectedReferenceExtractionJob} onClick={viewExtraction}>
              {t("reference.jobs.viewExtraction")}
            </button>
            <button className="secondary-button" type="button" disabled={!selectedReferenceIngestionJob} onClick={viewIngestion}>
              {t("reference.jobs.viewIngestion")}
            </button>
            <button
              className="secondary-button danger-button"
              type="button"
              disabled={!selectedReferenceSetSummary || deleteReferenceExtractionPending}
              onClick={() => void confirmDeleteExtraction()}
            >
              {t("reference.jobs.deleteExtraction")}
            </button>
            <button
              className="secondary-button danger-button"
              type="button"
              disabled={!selectedDeletionManga || !selectedDeletionTranslator || deleteIngestionPending}
              onClick={() => void confirmDeleteIngestion()}
            >
              {t("reference.jobs.deleteIngestion")}
            </button>
          </div>
        </div>
      ) : (
        <p className="muted-text">{t("reference.jobs.selectFirst")}</p>
      )}

      {selectedJob ? (
        <div className="artifact-summary-card">
          <SummaryGrid
            items={[
              { label: t("shared.jobType"), value: displayJobType(selectedJob.type) },
              { label: t("shared.status"), value: selectedJob.status },
              { label: t("shared.jobId"), value: selectedJob.id },
              { label: t("shared.referenceSet"), value: String(selectedJob.payload.referenceSetId || t("shared.notAvailable")) },
            ]}
          />
          {selectedJobSummary(selectedJob).length > 0 ? <SummaryGrid items={selectedJobSummary(selectedJob)} /> : null}
          {selectedIngestionSummary ? (
            <SummaryGrid
              items={[
                { label: t("reference.jobs.confirmedTerms"), value: String(selectedIngestionSummary.terminology) },
                { label: t("reference.jobs.confirmedCharacters"), value: String(selectedIngestionSummary.characters) },
                { label: t("reference.jobs.candidateTerms"), value: String(selectedIngestionSummary.candidateTerms) },
                { label: t("reference.jobs.candidateCharacters"), value: String(selectedIngestionSummary.candidateCharacters) },
              ]}
            />
          ) : null}
          <div className="button-row">
            <button className="secondary-button" onClick={retryJob} type="button">
              {t("reference.jobs.retry")}
            </button>
            <button className="secondary-button" onClick={openJobList} type="button">
              {t("reference.jobs.openList")}
            </button>
            <button className="secondary-button" onClick={deleteJob} type="button">
              {t("reference.jobs.deleteJob")}
            </button>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}
