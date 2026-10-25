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
  deleteExtractionPending: boolean;
  confirmDeleteExtraction: (set: ReferenceSetSummary) => Promise<void>;
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

type WorklistCountData = { total: number; extracted: number; observed: number; reviewed: number; ingested: number };

function calculateWorklistCounts(
  entries: ImportedReferenceBinding[],
  setMap: ReferenceSetMap,
  jobs: GuiJob[],
  latestJob: LatestReferenceJobResolver,
): WorklistCountData {
  const extracted = entries.filter((entry) => setMap.get(entry.referenceSetId)?.extractionAvailable === true ||
    latestJob(jobs, entry.referenceSetId, "reference_extraction")?.status === "succeeded").length;
  const ingested = entries.filter((entry) =>
    latestJob(jobs, entry.referenceSetId, "reference_ingestion")?.status === "succeeded").length;
  const reviewed = entries.filter((entry) => setMap.get(entry.referenceSetId)?.reviewStatus === "reviewed").length;
  const observed = entries.filter((entry) => setMap.get(entry.referenceSetId)?.observationStatus === "complete").length;
  return { total: entries.length, extracted, observed, reviewed, ingested };
}

function WorklistCount({ label, value }: { label: string; value: string | number }) {
  return <div><strong>{label}</strong><span>{value}</span></div>;
}

function WorklistCounts({ referenceWorklist, referenceSetMap, referenceJobs, latestReferenceJobForSet }: {
  referenceWorklist: ImportedReferenceBinding[]; referenceSetMap: ReferenceSetMap;
  referenceJobs: GuiJob[]; latestReferenceJobForSet: LatestReferenceJobResolver;
}) {
  const t = useLanguageStore((state) => state.t);
  const counts = calculateWorklistCounts(referenceWorklist, referenceSetMap, referenceJobs, latestReferenceJobForSet);
  return <div className="summary-grid compact-grid">
    <WorklistCount label={t("reference.worklist.count")} value={counts.total} />
    <WorklistCount label="Extraction" value={`${counts.extracted}/${counts.total}`} />
    <WorklistCount label="Observation" value={`${counts.observed}/${counts.total}`} />
    <WorklistCount label={t("reference.extractionReview.shortTitle")} value={`${counts.reviewed}/${counts.total}`} />
    <WorklistCount label="Ingestion" value={`${counts.ingested}/${counts.total}`} />
  </div>;
}

function updateIngestionOption(
  setForm: Dispatch<SetStateAction<ReferenceIngestionForm>>,
  key: "useForTerminology" | "useForStyle",
  checked: boolean,
) {
  setForm((current) => ({ ...current, [key]: checked }));
}

function WorklistOption({ checked, disabled, label, onChange }: {
  checked: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void;
}) {
  return <label className="checkbox-field">
    <input type="checkbox" checked={checked} disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)} />
    <span>{label}</span>
  </label>;
}

function WorklistOptions({ ingestionForm, setIngestionForm, styleOptionDisabledForWorklist,
  hasSourceReferenceInWorklist, hasTranslatorReferenceInWorklist }: {
  ingestionForm: ReferenceIngestionForm; setIngestionForm: Dispatch<SetStateAction<ReferenceIngestionForm>>;
  styleOptionDisabledForWorklist: boolean; hasSourceReferenceInWorklist: boolean;
  hasTranslatorReferenceInWorklist: boolean;
}) {
  const t = useLanguageStore((state) => state.t);
  const styleLabel = hasSourceReferenceInWorklist && !hasTranslatorReferenceInWorklist
    ? t("reference.worklist.sourceStyleDisabled") : t("reference.worklist.useStyle");
  return <div className="reference-workspace-options">
    <WorklistOption checked={Boolean(ingestionForm.useForTerminology)} label={t("reference.worklist.useTerminology")}
      onChange={(checked) => updateIngestionOption(setIngestionForm, "useForTerminology", checked)} />
    <WorklistOption checked={Boolean(ingestionForm.useForStyle)} disabled={styleOptionDisabledForWorklist}
      label={styleLabel} onChange={(checked) => updateIngestionOption(setIngestionForm, "useForStyle", checked)} />
  </div>;
}

function WorklistToolbar({ props, t }: { props: Props; t: ReturnType<typeof useLanguageStore.getState>["t"] }) {
  return <div className="button-row reference-workspace-toolbar">
    <button className="primary-button" type="button" disabled={Boolean(props.extractionBlockedReason)}
      onClick={() => void props.runWorklistExtraction()}>
      {`${t("reference.worklist.runExtraction")} (${props.referenceWorklist.length})`}
    </button>
    <button className="primary-button" type="button" disabled={Boolean(props.ingestionBlockedReason)}
      onClick={() => void props.runWorklistIngestion()}>
      {`${t("reference.worklist.runIngestion")} (${props.referenceWorklist.length})`}
    </button>
  </div>;
}

function WorklistBlockers({ extraction, ingestion }: { extraction: string | null; ingestion: string | null }) {
  return <>{extraction ? <p className="muted-text">{extraction}</p> : null}
    {ingestion ? <p className="muted-text">{ingestion}</p> : null}</>;
}

function WorklistHeader(props: Props) {
  const t = useLanguageStore((state) => state.t);
  return <>
    <div className="reference-workspace-header">
      <WorklistCounts referenceWorklist={props.referenceWorklist} referenceSetMap={props.referenceSetMap}
        referenceJobs={props.referenceJobs} latestReferenceJobForSet={props.latestReferenceJobForSet} />
      <WorklistOptions ingestionForm={props.ingestionForm} setIngestionForm={props.setIngestionForm}
        styleOptionDisabledForWorklist={props.styleOptionDisabledForWorklist}
        hasSourceReferenceInWorklist={props.hasSourceReferenceInWorklist}
        hasTranslatorReferenceInWorklist={props.hasTranslatorReferenceInWorklist} />
    </div>
    <WorklistToolbar props={props} t={t} />
    <WorklistBlockers extraction={props.extractionBlockedReason} ingestion={props.ingestionBlockedReason} />
  </>;
}

type EntryActionProps = {
  props: Props; entry: ImportedReferenceBinding; referenceSet: ReferenceSetSummary | undefined;
  extractionReady: boolean; observationStatus?: string;
};

function SelectEntryButton({ props, entry, referenceSet }: EntryActionProps) {
  const t = useLanguageStore((state) => state.t);
  const selected = props.selectedReferenceSetId === entry.referenceSetId;
  const label = referenceSet?.label || entry.label || entry.referenceSetId;
  return <button className="secondary-button" type="button"
    onClick={() => props.selectReferenceMaterial(entry.referenceSetId, label)}>
    {t(selected ? "reference.worklist.selected" : "reference.worklist.select")}
  </button>;
}

function ExtractEntryButton({ props, entry, referenceSet }: EntryActionProps) {
  const t = useLanguageStore((state) => state.t);
  return <button className="secondary-button" type="button"
    disabled={props.extractionMutationPending || !referenceSet}
    onClick={() => referenceSet && void props.runWorklistItemExtraction(referenceSet, entry)}>
    {t("reference.worklist.singleExtraction")}
  </button>;
}

function toggleExtractionReview({ props, entry, referenceSet }: EntryActionProps) {
  if (!referenceSet) return;
  if (props.activeReviewReferenceSetId === entry.referenceSetId) props.finishReviewEditing(referenceSet, entry);
  else props.reviewExtraction(referenceSet, entry);
}

function ReviewEntryButton(action: EntryActionProps) {
  const t = useLanguageStore((state) => state.t);
  const active = action.props.activeReviewReferenceSetId === action.entry.referenceSetId;
  const anotherActive = Boolean(action.props.activeReviewReferenceSetId && !active);
  return <button className={active ? "primary-button" : "secondary-button"} type="button"
    disabled={action.props.reviewMutationPending || !action.extractionReady || !action.referenceSet || anotherActive}
    onClick={() => toggleExtractionReview(action)}>
    {t(active ? "reference.extractionReview.finishEditor" : "reference.extractionReview.reviewButton")}
  </button>;
}

function WorklistEntryMainActions(action: EntryActionProps) {
  return <><SelectEntryButton {...action} /><ExtractEntryButton {...action} /><ReviewEntryButton {...action} /></>;
}

function IngestEntryButton({ props, entry, referenceSet, extractionReady }: EntryActionProps) {
  const t = useLanguageStore((state) => state.t);
  return <button className="secondary-button" type="button"
    disabled={props.ingestionMutationPending || !extractionReady || !referenceSet}
    onClick={() => referenceSet && void props.runWorklistItemIngestion(referenceSet, entry)}>
    {t("reference.worklist.singleIngestion")}
  </button>;
}

function DeepReviewEntryButton({ props, referenceSet, observationStatus }: EntryActionProps) {
  const t = useLanguageStore((state) => state.t);
  return <button className="secondary-button" type="button"
    disabled={props.deepReviewPending || observationStatus !== "complete" || !referenceSet}
    onClick={() => referenceSet && props.runDeepReview(referenceSet)}>
    {t("reference.worklist.deepReview")}
  </button>;
}

function RemoveEntryButton({ props, entry }: EntryActionProps) {
  const t = useLanguageStore((state) => state.t);
  return <button className="secondary-button" type="button"
    onClick={() => props.removeWorklistEntry(entry.referenceSetId)}>{t("reference.worklist.remove")}</button>;
}

function WorklistEntrySecondaryActions(action: EntryActionProps) {
  return <><IngestEntryButton {...action} /><DeepReviewEntryButton {...action} /><RemoveEntryButton {...action} /></>;
}

function DeleteExtractionButton({ props, referenceSet, extractionReady }: EntryActionProps) {
  const t = useLanguageStore((state) => state.t);
  return <button className="secondary-button danger-button" type="button"
    disabled={props.deleteExtractionPending || !extractionReady || !referenceSet}
    onClick={() => referenceSet && void props.confirmDeleteExtraction(referenceSet)}>
    {t("reference.data.deleteExtraction")}
  </button>;
}

function DeleteReferenceButton({ props, referenceSet }: EntryActionProps) {
  const t = useLanguageStore((state) => state.t);
  return <button className="secondary-button danger-button" type="button"
    disabled={props.deleteReferencePending || !referenceSet}
    onClick={() => referenceSet && void props.confirmDeleteReference(referenceSet)}>
    {t("reference.worklist.delete")}
  </button>;
}

function WorklistEntryDangerActions(action: EntryActionProps) {
  return <><DeleteExtractionButton {...action} /><DeleteReferenceButton {...action} /></>;
}

function WorklistEntryActions(action: EntryActionProps) {
  return <div className="job-actions reference-workspace-card-actions">
    <WorklistEntryMainActions {...action} />
    <WorklistEntrySecondaryActions {...action} />
    <WorklistEntryDangerActions {...action} />
  </div>;
}

type WorklistEntrySummaryProps = {
  props: Props;
  entry: ImportedReferenceBinding;
  referenceSet: ReferenceSetSummary | undefined;
  extractionJob: GuiJob | null;
  ingestionJob: GuiJob | null;
  kind: string;
  manga: MangaSeriesSummary | undefined;
  order: number | null;
  extractionReady: boolean;
  reviewReady: boolean;
  observationStatus: string;
  label: string;
  t: ReturnType<typeof useLanguageStore.getState>["t"];
};

function WorklistEntrySummary(p: WorklistEntrySummaryProps) {
  return (
    <div className="reference-workspace-main">
      <div className="reference-workspace-title-row">
        <div>
          <strong>{p.label}</strong>
          <div className="job-subtext">{p.t(`reference.worklist.kind.${p.kind}`)}</div>
        </div>
        <div className="reference-workspace-status-pills">
          <span
            className={`pill ${p.extractionReady ? "pill-success" : "pill-neutral"}`}
          >{`Extraction ${p.extractionJob ? p.props.statusLabel(p.extractionJob.status) : p.extractionReady ? p.t("reference.worklist.assetReady") : p.props.statusLabel(undefined)}`}</span>
          <span className={`pill ${p.reviewReady ? "pill-success" : "pill-warn"}`}>
            {p.t(`reference.extractionReview.status.${p.referenceSet?.reviewStatus || "awaiting_review"}`)}
          </span>
          <span
            className={`pill ${p.observationStatus === "complete" ? "pill-success" : p.observationStatus === "stale" ? "pill-warn" : "pill-neutral"}`}
          >{`Observation ${p.t(`reference.observation.status.${p.observationStatus}`)}`}</span>
          <span className="pill pill-neutral">{`Ingestion ${p.props.statusLabel(p.ingestionJob?.status)}`}</span>
        </div>
      </div>
      <div className="reference-workspace-meta">
        <span>{`${p.t("reference.worklist.manga")}: ${p.manga?.label || p.entry.mangaLabel || p.entry.mangaId || "-"}`}</span>
        <span>{`${p.t("reference.worklist.translator")}: ${p.entry.translatorLabel || p.entry.translatorId || "-"}`}</span>
        <span>{`${p.t("reference.worklist.chapter")}: ${p.entry.chapterTitle || p.entry.chapterId || "-"}`}</span>
        {p.order ? <span>{`${p.t("reference.worklist.streamOrder")}: ${p.order}`}</span> : null}
      </div>
    </div>
  );
}

function buildWorklistEntryModel(props: Props, entry: ImportedReferenceBinding) {
  const referenceSet = props.referenceSetMap.get(entry.referenceSetId);
  const extractionJob = props.latestReferenceJobForSet(props.referenceJobs, entry.referenceSetId, "reference_extraction");
  const ingestionJob = props.latestReferenceJobForSet(props.referenceJobs, entry.referenceSetId, "reference_ingestion");
  const kind = entry.referenceKind || referenceSet?.referenceKind || "translator";
  const manga = props.mangaSeriesOptions.find((item) => item.mangaId === entry.mangaId);
  const chapter = manga?.translators
    .find((item) => item.translatorId === entry.translatorId)
    ?.chapters.find((item) => item.chapterId === entry.chapterId);
  const order = Number.isFinite(chapter?.sortOrder) ? Number(chapter?.sortOrder) + 1 : null;
  const extractionReady = referenceSet?.extractionAvailable === true || extractionJob?.status === "succeeded";
  const reviewReady = referenceSet?.reviewStatus === "reviewed";
  const observationStatus = referenceSet?.observationStatus || "missing";
  const label = referenceSet?.label || entry.label || entry.referenceSetId;
  return { referenceSet, extractionJob, ingestionJob, kind, manga, order, extractionReady,
    reviewReady, observationStatus, label };
}

function WorklistEntryCard({ props, entry }: { props: Props; entry: ImportedReferenceBinding }) {
  const t = useLanguageStore((state) => state.t);
  const model = buildWorklistEntryModel(props, entry);
  return (
    <li
      key={entry.referenceSetId}
      className={`artifact-item reference-workspace-card ${props.selectedReferenceSetId === entry.referenceSetId ? "selected" : ""}`}
    >
      <WorklistEntrySummary
        props={props}
        entry={entry}
        {...model}
        t={t}
      />
      <WorklistEntryActions
        props={props}
        entry={entry}
        referenceSet={model.referenceSet}
        extractionReady={model.extractionReady}
        observationStatus={model.observationStatus}
      />
    </li>
  );
}

export function ReferenceWorklistPane(props: Props) {
  const t = useLanguageStore((state) => state.t);
  return (
    <SectionCard
      title={t("reference.section.worklist.title")}
      description={t("reference.section.worklist.sequenceDescription")}
      defaultOpen
    >
      <WorklistHeader {...props} />
      {props.referenceWorklist.length > 0 ? (
        <ul className="artifact-list reference-workspace-list">
          {props.referenceWorklist.map((entry) => (
            <WorklistEntryCard key={entry.referenceSetId} props={props} entry={entry} />
          ))}
        </ul>
      ) : (
        <p className="muted-text">{t("reference.worklist.empty")}</p>
      )}
    </SectionCard>
  );
}
