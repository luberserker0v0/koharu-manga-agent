import type { Dispatch, SetStateAction } from "react";
import type { GuiJob, MangaSeriesSummary, ReferenceSetSummary } from "../../../api/jobs";
import { useLanguageStore } from "../../../stores/language_store";
import { SectionCard } from "../../shared/components/SectionCard";
import type {
  ImportedReferenceBinding,
  LatestReferenceJobResolver,
  ReferenceIngestionForm,
  ReferenceSetMap,
} from "../types";

type Props = {
  ingestionForm: ReferenceIngestionForm;
  setIngestionForm: Dispatch<SetStateAction<ReferenceIngestionForm>>;
  styleOptionDisabledForWorklist: boolean;
  hasSourceReferenceInWorklist: boolean;
  hasTranslatorReferenceInWorklist: boolean;
  referenceWorklist: ImportedReferenceBinding[];
  referenceSetMap: ReferenceSetMap;
  mangaSeriesOptions: MangaSeriesSummary[];
  referenceJobs: GuiJob[];
  latestReferenceJobForSet: LatestReferenceJobResolver;
  statusLabel: (status: string | undefined) => string;
  extractionMutationPending: boolean;
  ingestionMutationPending: boolean;
  reviewMutationPending: boolean;
  activeReviewReferenceSetId: string | null;
  worklistEntriesMissingExtraction: ImportedReferenceBinding[];
  extractionBlockedReason: string | null;
  ingestionBlockedReason: string | null;
  removeWorklistEntry: (referenceSetId: string) => void;
  deleteReferencePending: boolean;
  confirmDeleteReference: (set: ReferenceSetSummary) => Promise<void>;
  selectReferenceMaterial: (referenceSetId: string, label: string) => void;
  runWorklistExtraction: () => Promise<void>;
  runWorklistIngestion: () => Promise<void>;
  runWorklistItemExtraction: (set: ReferenceSetSummary, entry: ImportedReferenceBinding) => Promise<void>;
  runWorklistItemIngestion: (set: ReferenceSetSummary, entry: ImportedReferenceBinding) => Promise<void>;
  deepReviewPending: boolean;
  runDeepReview: (set: ReferenceSetSummary) => void;
  reviewExtraction: (set: ReferenceSetSummary, entry: ImportedReferenceBinding) => void;
  finishReviewEditing: (set: ReferenceSetSummary, entry: ImportedReferenceBinding) => void;
  selectedReferenceSetId: string;
};

export function ReferenceWorklistPane(props: Props) {
  const t = useLanguageStore((state) => state.t);
  const {
    ingestionForm,
    setIngestionForm,
    styleOptionDisabledForWorklist,
    hasSourceReferenceInWorklist,
    hasTranslatorReferenceInWorklist,
    referenceWorklist,
    referenceSetMap,
    mangaSeriesOptions,
    referenceJobs,
    latestReferenceJobForSet,
    statusLabel,
  } = props;
  const extractedCount = referenceWorklist.filter((entry) =>
    referenceSetMap.get(entry.referenceSetId)?.extractionAvailable === true ||
    latestReferenceJobForSet(referenceJobs, entry.referenceSetId, "reference_extraction")?.status === "succeeded"
  ).length;
  const ingestedCount = referenceWorklist.filter((entry) =>
    latestReferenceJobForSet(referenceJobs, entry.referenceSetId, "reference_ingestion")?.status === "succeeded"
  ).length;
  const reviewedCount = referenceWorklist.filter(
    (entry) => referenceSetMap.get(entry.referenceSetId)?.reviewStatus === "reviewed"
  ).length;
  const observedCount = referenceWorklist.filter(
    (entry) => referenceSetMap.get(entry.referenceSetId)?.observationStatus === "complete"
  ).length;

  return (
    <SectionCard
      title={t("reference.section.worklist.title")}
      description={t("reference.section.worklist.sequenceDescription")}
    >
      <div className="reference-workspace-header">
        <div className="summary-grid compact-grid">
          <div><strong>{t("reference.worklist.count")}</strong><span>{referenceWorklist.length}</span></div>
          <div><strong>Extraction</strong><span>{`${extractedCount}/${referenceWorklist.length}`}</span></div>
          <div><strong>Observation</strong><span>{`${observedCount}/${referenceWorklist.length}`}</span></div>
          <div><strong>{t("reference.extractionReview.shortTitle")}</strong><span>{`${reviewedCount}/${referenceWorklist.length}`}</span></div>
          <div><strong>Ingestion</strong><span>{`${ingestedCount}/${referenceWorklist.length}`}</span></div>
        </div>
        <div className="reference-workspace-options">
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={Boolean(ingestionForm.useForTerminology)}
              onChange={(event) => setIngestionForm((current) => ({
                ...current,
                useForTerminology: event.currentTarget.checked,
              }))}
            />
            <span>{t("reference.worklist.useTerminology")}</span>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={Boolean(ingestionForm.useForStyle)}
              disabled={styleOptionDisabledForWorklist}
              onChange={(event) => setIngestionForm((current) => ({
                ...current,
                useForStyle: event.currentTarget.checked,
              }))}
            />
            <span>{hasSourceReferenceInWorklist && !hasTranslatorReferenceInWorklist
              ? t("reference.worklist.sourceStyleDisabled")
              : t("reference.worklist.useStyle")}</span>
          </label>
        </div>
      </div>

      <div className="button-row reference-workspace-toolbar">
        <button className="primary-button" type="button" disabled={Boolean(props.extractionBlockedReason)} onClick={() => void props.runWorklistExtraction()}>
          {`${t("reference.worklist.runExtraction")} (${referenceWorklist.length})`}
        </button>
        <button className="primary-button" type="button" disabled={Boolean(props.ingestionBlockedReason)} onClick={() => void props.runWorklistIngestion()}>
          {`${t("reference.worklist.runIngestion")} (${referenceWorklist.length})`}
        </button>
      </div>
      {props.extractionBlockedReason ? <p className="muted-text">{props.extractionBlockedReason}</p> : null}
      {props.ingestionBlockedReason ? <p className="muted-text">{props.ingestionBlockedReason}</p> : null}

      {referenceWorklist.length > 0 ? (
        <ul className="artifact-list reference-workspace-list">
          {referenceWorklist.map((entry) => {
            const referenceSet = referenceSetMap.get(entry.referenceSetId);
            const extractionJob = latestReferenceJobForSet(referenceJobs, entry.referenceSetId, "reference_extraction");
            const ingestionJob = latestReferenceJobForSet(referenceJobs, entry.referenceSetId, "reference_ingestion");
            const kind = entry.referenceKind || referenceSet?.referenceKind || "translator";
            const manga = mangaSeriesOptions.find((item) => item.mangaId === entry.mangaId);
            const chapter = manga?.translators
              .find((item) => item.translatorId === entry.translatorId)
              ?.chapters.find((item) => item.chapterId === entry.chapterId);
            const order = Number.isFinite(chapter?.sortOrder) ? Number(chapter?.sortOrder) + 1 : null;
            const extractionReady = referenceSet?.extractionAvailable === true || extractionJob?.status === "succeeded";
            const reviewReady = referenceSet?.reviewStatus === "reviewed";
            const observationStatus = referenceSet?.observationStatus || "missing";
            const label = referenceSet?.label || entry.label || entry.referenceSetId;
            return (
              <li key={entry.referenceSetId} className={`artifact-item reference-workspace-card ${props.selectedReferenceSetId === entry.referenceSetId ? "selected" : ""}`}>
                <div className="reference-workspace-main">
                  <div className="reference-workspace-title-row">
                    <div><strong>{label}</strong><div className="job-subtext">{t(`reference.worklist.kind.${kind}`)}</div></div>
                    <div className="reference-workspace-status-pills">
                      <span className={`pill ${extractionReady ? "pill-success" : "pill-neutral"}`}>
                        {`Extraction ${extractionJob ? statusLabel(extractionJob.status) : extractionReady ? t("reference.worklist.assetReady") : statusLabel(undefined)}`}
                      </span>
                      <span className={`pill ${reviewReady ? "pill-success" : "pill-warn"}`}>
                        {t(`reference.extractionReview.status.${referenceSet?.reviewStatus || "awaiting_review"}`)}
                      </span>
                      <span className={`pill ${observationStatus === "complete" ? "pill-success" : observationStatus === "stale" ? "pill-warn" : "pill-neutral"}`}>
                        {`Observation ${t(`reference.observation.status.${observationStatus}`)}`}
                      </span>
                      <span className="pill pill-neutral">{`Ingestion ${statusLabel(ingestionJob?.status)}`}</span>
                    </div>
                  </div>
                  <div className="reference-workspace-meta">
                    <span>{`${t("reference.worklist.manga")}: ${manga?.label || entry.mangaLabel || entry.mangaId || "-"}`}</span>
                    <span>{`${t("reference.worklist.translator")}: ${entry.translatorLabel || entry.translatorId || "-"}`}</span>
                    <span>{`${t("reference.worklist.chapter")}: ${entry.chapterTitle || entry.chapterId || "-"}`}</span>
                    {order ? <span>{`${t("reference.worklist.streamOrder")}: ${order}`}</span> : null}
                  </div>
                </div>
                <div className="job-actions reference-workspace-card-actions">
                  <button className="secondary-button" type="button" onClick={() => props.selectReferenceMaterial(entry.referenceSetId, label)}>
                    {t(props.selectedReferenceSetId === entry.referenceSetId ? "reference.worklist.selected" : "reference.worklist.select")}
                  </button>
                  <button className="secondary-button" type="button" disabled={props.extractionMutationPending || !referenceSet} onClick={() => referenceSet && void props.runWorklistItemExtraction(referenceSet, entry)}>
                    {t("reference.worklist.singleExtraction")}
                  </button>
                  <button
                    className={props.activeReviewReferenceSetId === entry.referenceSetId ? "primary-button" : "secondary-button"}
                    type="button"
                    disabled={
                      props.reviewMutationPending ||
                      !extractionReady ||
                      !referenceSet ||
                      Boolean(
                        props.activeReviewReferenceSetId &&
                        props.activeReviewReferenceSetId !== entry.referenceSetId
                      )
                    }
                    onClick={() => {
                      if (!referenceSet) return;
                      if (props.activeReviewReferenceSetId === entry.referenceSetId) {
                        props.finishReviewEditing(referenceSet, entry);
                      } else {
                        props.reviewExtraction(referenceSet, entry);
                      }
                    }}
                  >
                    {t(
                      props.activeReviewReferenceSetId === entry.referenceSetId
                        ? "reference.extractionReview.finishEditor"
                        : "reference.extractionReview.reviewButton"
                    )}
                  </button>
                  <button className="secondary-button" type="button" disabled={props.ingestionMutationPending || !extractionReady || !referenceSet} onClick={() => referenceSet && void props.runWorklistItemIngestion(referenceSet, entry)}>
                    {t("reference.worklist.singleIngestion")}
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={props.deepReviewPending || observationStatus !== "complete" || !referenceSet}
                    onClick={() => referenceSet && props.runDeepReview(referenceSet)}
                  >
                    {t("reference.worklist.deepReview")}
                  </button>
                  <button className="secondary-button" type="button" onClick={() => props.removeWorklistEntry(entry.referenceSetId)}>
                    {t("reference.worklist.remove")}
                  </button>
                  <button
                    className="secondary-button danger-button"
                    type="button"
                    disabled={props.deleteReferencePending || !referenceSet}
                    onClick={() => referenceSet && void props.confirmDeleteReference(referenceSet)}
                  >
                    {t("reference.worklist.delete")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : <p className="muted-text">{t("reference.worklist.empty")}</p>}
    </SectionCard>
  );
}
