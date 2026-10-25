import type { Dispatch, SetStateAction } from "react";
import { MangaSelector } from "../../../components/MangaSelector";
import { TranslatorSelector } from "../../../components/TranslatorSelector";
import {
  DEFAULT_REFERENCE_LANGUAGE,
  normalizeReferenceLanguage,
  REFERENCE_LANGUAGE_OPTIONS,
} from "../../../constants/languages";
import { useLanguageStore } from "../../../stores/language_store";
import { SectionCard } from "../../shared/components/SectionCard";
import type {
  QueuedReferenceFolder,
  ReferenceImportForm,
  ReferenceMangaOption,
  ReferenceTranslatorOption,
} from "../types";

type ReferenceImportPaneProps = {
  importForm: ReferenceImportForm;
  setImportForm: Dispatch<SetStateAction<ReferenceImportForm>>;
  importQueue: QueuedReferenceFolder[];
  isWorklistImporting: boolean;
  mangaSeriesOptions: ReferenceMangaOption[];
  mangaSeriesLoading: boolean;
  mangaSeriesFailed: boolean;
  availableImportTranslators: ReferenceTranslatorOption[];
  isSourceReferenceKind: (kind: string | undefined) => boolean;
  sourceReferenceTranslatorLabel: string;
  hasSourceReferenceInWorklist: boolean;
  hasTranslatorReferenceInWorklist: boolean;
  importBlockedReason: string | null;
  removeQueuedReferenceFolder: (id: string) => void;
  updateQueuedReferenceFolderLabel: (id: string, label: string) => void;
  importQueuedReferenceFolders: () => Promise<void>;
  pickSingleFolder: () => Promise<void>;
  pickMultipleFolders: () => Promise<void>;
  clearQueuedReferenceFolders: () => void;
};

function ImportFolderField({
  importForm,
  pickSingleFolder,
  pickMultipleFolders,
}: {
  importForm: ReferenceImportForm;
  pickSingleFolder: () => Promise<void>;
  pickMultipleFolders: () => Promise<void>;
}) {
  const t = useLanguageStore((state) => state.t);
  return (
    <label>
      <span>{t("reference.import.folderLabel")}</span>
      <div className="inline-field-row">
        <input readOnly value={importForm.sourceFolder} placeholder={t("reference.import.folderPlaceholder")} />
        <button className="secondary-button" type="button" onClick={() => void pickSingleFolder()}>
          {t("reference.import.addFolder")}
        </button>
        <button className="secondary-button" type="button" onClick={() => void pickMultipleFolders()}>
          {t("reference.import.addFolders")}
        </button>
      </div>
    </label>
  );
}

function ImportLanguageField({
  importForm,
  setImportForm,
}: {
  importForm: ReferenceImportForm;
  setImportForm: Dispatch<SetStateAction<ReferenceImportForm>>;
}) {
  const t = useLanguageStore((state) => state.t);
  return (
    <label>
      <span>{t("reference.import.languageLabel")}</span>
      <select
        value={normalizeReferenceLanguage(importForm.language || DEFAULT_REFERENCE_LANGUAGE)}
        onChange={(event) => {
          const nextLanguage = normalizeReferenceLanguage(event.currentTarget?.value);
          setImportForm((current) => ({ ...current, language: nextLanguage }));
        }}
      >
        {REFERENCE_LANGUAGE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <small className="muted-text">{t("reference.import.languageHelp")}</small>
    </label>
  );
}

function ImportKindField({
  importForm,
  setImportForm,
}: {
  importForm: ReferenceImportForm;
  setImportForm: Dispatch<SetStateAction<ReferenceImportForm>>;
}) {
  const t = useLanguageStore((state) => state.t);
  return (
    <label>
      <span>{t("reference.import.kindLabel")}</span>
      <select
        value={importForm.referenceKind}
        onChange={(event) => {
          const nextKind = event.currentTarget.value === "source" ? "source" : "translator";
          setImportForm((current) => ({
            ...current,
            referenceKind: nextKind,
            translatorSelection: nextKind === "source" ? "" : current.translatorSelection,
            newTranslatorLabel: nextKind === "source" ? "" : current.newTranslatorLabel,
          }));
        }}
      >
        <option value="source">{t("reference.import.referenceType.source")}</option>
        <option value="translator">{t("reference.import.referenceType.translator")}</option>
      </select>
      <small className="muted-text">{t("reference.import.referenceType.help")}</small>
    </label>
  );
}

function ImportNotices({
  hasSourceReferenceInWorklist,
  hasTranslatorReferenceInWorklist,
}: {
  hasSourceReferenceInWorklist: boolean;
  hasTranslatorReferenceInWorklist: boolean;
}) {
  const t = useLanguageStore((state) => state.t);
  if (!hasSourceReferenceInWorklist) return null;
  return (
    <p className="muted-text">
      {t("reference.import.sourceNotice")}
      {hasTranslatorReferenceInWorklist ? ` ${t("reference.import.mixedNotice")}` : ""}
    </p>
  );
}

function ImportActions({
  importBlockedReason,
  importQueue,
  importQueuedReferenceFolders,
  clearQueuedReferenceFolders,
}: {
  importBlockedReason: string | null;
  importQueue: QueuedReferenceFolder[];
  importQueuedReferenceFolders: () => Promise<void>;
  clearQueuedReferenceFolders: () => void;
}) {
  const t = useLanguageStore((state) => state.t);
  return (
    <div className="button-row">
      <ImportAction
        primary
        disabled={Boolean(importBlockedReason)}
        onClick={() => void importQueuedReferenceFolders()}
        label={t("reference.import.submit")}
      />
      <ImportAction
        disabled={importQueue.length === 0}
        onClick={clearQueuedReferenceFolders}
        label={t("reference.import.clear")}
      />
      <span className="muted-text">{t("reference.workspace.chapterCount", { count: importQueue.length })}</span>
    </div>
  );
}

function ImportAction(props: { label: string; disabled: boolean; onClick: () => void; primary?: boolean }) {
  return (
    <button
      className={props.primary ? "primary-button" : "secondary-button"}
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function ImportQueueEntry(props: {
  entry: QueuedReferenceFolder;
  update: (id: string, label: string) => void;
  remove: (id: string) => void;
}) {
  const t = useLanguageStore((state) => state.t);
  return (
    <li className="artifact-item">
      <div>
        <input
          value={props.entry.label}
          onChange={(event) => props.update(props.entry.id, event.currentTarget.value)}
        />
        <div className="job-subtext">{props.entry.sourceFolder}</div>
      </div>
      <div className="job-actions">
        <button className="secondary-button danger-button" type="button" onClick={() => props.remove(props.entry.id)}>
          {t("reference.import.remove")}
        </button>
      </div>
    </li>
  );
}

function ImportQueueList({
  importQueue,
  updateQueuedReferenceFolderLabel,
  removeQueuedReferenceFolder,
}: {
  importQueue: QueuedReferenceFolder[];
  updateQueuedReferenceFolderLabel: (id: string, label: string) => void;
  removeQueuedReferenceFolder: (id: string) => void;
}) {
  return (
    <ul className="artifact-list">
      {importQueue.map((entry) => (
        <ImportQueueEntry
          key={entry.id}
          entry={entry}
          update={updateQueuedReferenceFolderLabel}
          remove={removeQueuedReferenceFolder}
        />
      ))}
    </ul>
  );
}

type ImportTranslatorFieldProps = {
  importForm: ReferenceImportForm;
  setImportForm: Dispatch<SetStateAction<ReferenceImportForm>>;
  mangaSeriesLoading: boolean;
  mangaSeriesFailed: boolean;
  availableImportTranslators: ReferenceTranslatorOption[];
  isSourceReferenceKind: (kind: string | undefined) => boolean;
  sourceReferenceTranslatorLabel: string;
};

function SourceTranslatorField({ sourceReferenceTranslatorLabel }: { sourceReferenceTranslatorLabel: string }) {
  const t = useLanguageStore((state) => state.t);
  return (
    <label>
      <span>{t("reference.worklist.translator")}</span>
      <small className="muted-text">{t("reference.import.originalTranslator.help")}</small>
      <input value={sourceReferenceTranslatorLabel} readOnly />
    </label>
  );
}

function TranslatorSelectField(
  props: Omit<ImportTranslatorFieldProps, "isSourceReferenceKind" | "sourceReferenceTranslatorLabel">,
) {
  const { importForm, setImportForm, mangaSeriesLoading, mangaSeriesFailed, availableImportTranslators } = props;
  const t = useLanguageStore((state) => state.t);
  const labels = translatorSelectLabels(t, importForm.mangaSelection);
  return (
    <TranslatorSelector
      label={t("reference.worklist.translator")}
      helpText={t("reference.import.translatorHelp")}
      selectedValue={importForm.translatorSelection}
      newTranslatorLabel={importForm.newTranslatorLabel}
      options={availableImportTranslators}
      loading={mangaSeriesLoading}
      failed={mangaSeriesFailed}
      disabled={!importForm.mangaSelection}
      {...labels}
      onSelectionChange={(value) => setImportForm((current) => ({ ...current, translatorSelection: value }))}
      onNewTranslatorLabelChange={(value) => setImportForm((current) => ({ ...current, newTranslatorLabel: value }))}
    />
  );
}

function translatorSelectLabels(t: ReturnType<typeof useLanguageStore.getState>["t"], hasManga: string) {
  return {
    emptyLabel: t(hasManga ? "reference.import.selectTranslator" : "reference.import.chooseMangaFirst"),
    loadingLabel: t("reference.import.loadingTranslators"),
    failedLabel: t("reference.import.failedTranslators"),
    createLabel: t("reference.import.createTranslator"),
    inputPlaceholder: t("reference.import.translatorPlaceholder"),
  };
}

function ImportTranslatorField(props: ImportTranslatorFieldProps) {
  if (props.isSourceReferenceKind(props.importForm.referenceKind)) {
    return <SourceTranslatorField sourceReferenceTranslatorLabel={props.sourceReferenceTranslatorLabel} />;
  }
  return (
    <TranslatorSelectField
      importForm={props.importForm}
      setImportForm={props.setImportForm}
      mangaSeriesLoading={props.mangaSeriesLoading}
      mangaSeriesFailed={props.mangaSeriesFailed}
      availableImportTranslators={props.availableImportTranslators}
    />
  );
}

type ImportFormGridProps = {
  importForm: ReferenceImportForm;
  setImportForm: Dispatch<SetStateAction<ReferenceImportForm>>;
  mangaSeriesOptions: ReferenceMangaOption[];
  mangaSeriesLoading: boolean;
  mangaSeriesFailed: boolean;
  availableImportTranslators: ReferenceTranslatorOption[];
  isSourceReferenceKind: (kind: string | undefined) => boolean;
  sourceReferenceTranslatorLabel: string;
  pickSingleFolder: () => Promise<void>;
  pickMultipleFolders: () => Promise<void>;
};

function ImportFormGrid(props: ImportFormGridProps) {
  return (
    <div className="form-grid">
      <ImportFolderField
        importForm={props.importForm}
        pickSingleFolder={props.pickSingleFolder}
        pickMultipleFolders={props.pickMultipleFolders}
      />
      <ImportLanguageField importForm={props.importForm} setImportForm={props.setImportForm} />
      <ImportKindField importForm={props.importForm} setImportForm={props.setImportForm} />
      <ImportMangaField {...props} />
      <ImportTranslatorField {...props} />
    </div>
  );
}

function ImportMangaField(props: ImportFormGridProps) {
  const t = useLanguageStore((state) => state.t);
  const select = (value: string) =>
    props.setImportForm((current) => ({
      ...current,
      mangaSelection: value,
      translatorSelection: "",
      newTranslatorLabel: "",
    }));
  const rename = (value: string) => props.setImportForm((current) => ({ ...current, newMangaLabel: value }));
  return (
    <MangaSelector
      label={t("reference.worklist.manga")}
      helpText={t("reference.import.mangaHelp")}
      selectedValue={props.importForm.mangaSelection}
      newMangaLabel={props.importForm.newMangaLabel}
      options={props.mangaSeriesOptions}
      loading={props.mangaSeriesLoading}
      failed={props.mangaSeriesFailed}
      onSelectionChange={select}
      onNewMangaLabelChange={rename}
    />
  );
}

export function ReferenceImportPane(props: ReferenceImportPaneProps) {
  const t = useLanguageStore((state) => state.t);
  return (
    <SectionCard
      title={t("reference.section.import.title")}
      description={t("reference.section.import.description")}
      defaultOpen
    >
      <ImportFormGrid {...props} />
      <ImportNotices {...props} />
      <ImportActions {...props} />
      {props.importBlockedReason ? <p className="muted-text">{props.importBlockedReason}</p> : null}
      {props.importQueue.length > 0 ? (
        <ImportQueueList {...props} />
      ) : (
        <p className="muted-text">{t("reference.import.empty")}</p>
      )}
    </SectionCard>
  );
}
