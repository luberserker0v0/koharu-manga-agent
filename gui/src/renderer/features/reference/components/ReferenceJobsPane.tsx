import type { GuiJob, MangaSeriesSummary, ReferenceSetSummary, TranslatorProfileSummary } from "../../../api/jobs";
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

type Translate = (key: string, params?: Record<string, string | number>) => string;

function ReferenceSetSummary(props: ReferenceJobsPaneProps & { t: Translate }) {
  const { t, selectedReferenceSetSummary: set, selectedReferenceExtractionJob: extraction } = props;
  return (
    <SummaryGrid
      items={[
        { label: t("reference.jobs.currentReference"), value: set?.label || t("shared.notAvailable") },
        { label: t("shared.language"), value: set?.language || t("shared.notAvailable") },
        { label: t("shared.extraction"), value: extraction?.status || t("shared.notAvailable") },
        {
          label: t("shared.ingestion"),
          value: props.selectedReferenceIngestionJob?.status || t("shared.notAvailable"),
        },
      ]}
    />
  );
}

function ReferenceSetActions(props: ReferenceJobsPaneProps & { t: Translate }) {
  const { t } = props;
  return (
    <div className="button-row">
      <ReferenceAction
        disabled={!props.selectedReferenceExtractionJob}
        onClick={props.viewExtraction}
        label={t("reference.jobs.viewExtraction")}
      />
      <ReferenceAction
        disabled={!props.selectedReferenceIngestionJob}
        onClick={props.viewIngestion}
        label={t("reference.jobs.viewIngestion")}
      />
      <ReferenceAction
        danger
        disabled={!props.selectedReferenceSetSummary || props.deleteReferenceExtractionPending}
        onClick={() => void props.confirmDeleteExtraction()}
        label={t("reference.jobs.deleteExtraction")}
      />
      <ReferenceAction
        danger
        disabled={!props.selectedDeletionManga || !props.selectedDeletionTranslator || props.deleteIngestionPending}
        onClick={() => void props.confirmDeleteIngestion()}
        label={t("reference.jobs.deleteIngestion")}
      />
    </div>
  );
}

function ReferenceAction(props: { disabled: boolean; onClick: () => void; label: string; danger?: boolean }) {
  const className = `secondary-button${props.danger ? " danger-button" : ""}`;
  return (
    <button className={className} type="button" disabled={props.disabled} onClick={props.onClick}>
      {props.label}
    </button>
  );
}

function ReferenceSetCard(props: ReferenceJobsPaneProps & { t: Translate }) {
  if (!props.selectedReferenceSetSummary) return <p className="muted-text">{props.t("reference.jobs.selectFirst")}</p>;
  return (
    <div className="artifact-summary-card">
      <ReferenceSetSummary {...props} />
      <ReferenceSetActions {...props} />
    </div>
  );
}

function SelectedJobSummary(props: ReferenceJobsPaneProps & { t: Translate; job: GuiJob }) {
  const { t, job } = props;
  const details = props.selectedJobSummary(job);
  return (
    <>
      <SummaryGrid
        items={[
          { label: t("shared.jobType"), value: props.displayJobType(job.type) },
          { label: t("shared.status"), value: job.status },
          { label: t("shared.jobId"), value: job.id },
          { label: t("shared.referenceSet"), value: String(job.payload.referenceSetId || t("shared.notAvailable")) },
        ]}
      />
      {details.length > 0 && <SummaryGrid items={details} />}
    </>
  );
}

function IngestionSummary({ summary, t }: { summary: IngestionResultSummary | null; t: Translate }) {
  if (!summary) return null;
  return (
    <SummaryGrid
      items={[
        { label: t("reference.jobs.confirmedTerms"), value: String(summary.terminology) },
        { label: t("reference.jobs.confirmedCharacters"), value: String(summary.characters) },
        { label: t("reference.jobs.candidateTerms"), value: String(summary.candidateTerms) },
        { label: t("reference.jobs.candidateCharacters"), value: String(summary.candidateCharacters) },
      ]}
    />
  );
}

function SelectedJobActions(props: ReferenceJobsPaneProps & { t: Translate }) {
  return (
    <div className="button-row">
      <button className="secondary-button" onClick={props.retryJob} type="button">
        {props.t("reference.jobs.retry")}
      </button>
      <button className="secondary-button" onClick={props.openJobList} type="button">
        {props.t("reference.jobs.openList")}
      </button>
      <button className="secondary-button" onClick={props.deleteJob} type="button">
        {props.t("reference.jobs.deleteJob")}
      </button>
    </div>
  );
}

function SelectedJobCard(props: ReferenceJobsPaneProps & { t: Translate }) {
  if (!props.selectedJob) return null;
  return (
    <div className="artifact-summary-card">
      <SelectedJobSummary {...props} job={props.selectedJob} />
      <IngestionSummary summary={props.selectedIngestionSummary} t={props.t} />
      <SelectedJobActions {...props} />
    </div>
  );
}

export function ReferenceJobsPane(props: ReferenceJobsPaneProps) {
  const t = useLanguageStore((state) => state.t);
  return (
    <SectionCard title={t("reference.section.jobs.title")} description={t("reference.section.jobs.description")}>
      <ReferenceSetCard {...props} t={t} />
      <SelectedJobCard {...props} t={t} />
    </SectionCard>
  );
}
