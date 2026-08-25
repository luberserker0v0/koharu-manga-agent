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

export function ReferenceImportPane({
  importForm,
  setImportForm,
  importQueue,
  isWorklistImporting,
  mangaSeriesOptions,
  mangaSeriesLoading,
  mangaSeriesFailed,
  availableImportTranslators,
  isSourceReferenceKind,
  sourceReferenceTranslatorLabel,
  hasSourceReferenceInWorklist,
  hasTranslatorReferenceInWorklist,
  importBlockedReason,
  removeQueuedReferenceFolder,
  updateQueuedReferenceFolderLabel,
  importQueuedReferenceFolders,
  pickSingleFolder,
  pickMultipleFolders,
  clearQueuedReferenceFolders,
}: ReferenceImportPaneProps) {
  const t = useLanguageStore((state) => state.t);

  return (
    <SectionCard
      title={t("reference.section.import.title")}
      description={t("reference.section.import.description")}
      defaultOpen
    >
      <div className="form-grid">
        <label>
          <span>{t("reference.import.folderLabel")}</span>
          <div className="inline-field-row">
            <input
              readOnly
              value={importForm.sourceFolder}
              placeholder={t("reference.import.folderPlaceholder")}
            />
            <button className="secondary-button" type="button" onClick={() => void pickSingleFolder()}>
              {t("reference.import.addFolder")}
            </button>
            <button className="secondary-button" type="button" onClick={() => void pickMultipleFolders()}>
              {t("reference.import.addFolders")}
            </button>
          </div>
        </label>
        <label>
          <span>{t("reference.import.languageLabel")}</span>
          <select
            value={normalizeReferenceLanguage(importForm.language || DEFAULT_REFERENCE_LANGUAGE)}
            onChange={(event) => {
              const nextLanguage = normalizeReferenceLanguage(event.currentTarget?.value);
              setImportForm((current) => ({
                ...current,
                language: nextLanguage,
              }));
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
        <MangaSelector
          label={t("reference.worklist.manga")}
          helpText={t("reference.import.mangaHelp")}
          selectedValue={importForm.mangaSelection}
          newMangaLabel={importForm.newMangaLabel}
          options={mangaSeriesOptions}
          loading={mangaSeriesLoading}
          failed={mangaSeriesFailed}
          onSelectionChange={(value) =>
            setImportForm((current) => ({
              ...current,
              mangaSelection: value,
              translatorSelection: "",
              newTranslatorLabel: "",
            }))
          }
          onNewMangaLabelChange={(value) =>
            setImportForm((current) => ({
              ...current,
              newMangaLabel: value,
            }))
          }
        />
        {isSourceReferenceKind(importForm.referenceKind) ? (
          <label>
            <span>{t("reference.worklist.translator")}</span>
            <small className="muted-text">{t("reference.import.originalTranslator.help")}</small>
            <input value={sourceReferenceTranslatorLabel} readOnly />
          </label>
        ) : (
          <TranslatorSelector
            label={t("reference.worklist.translator")}
            helpText={t("reference.import.translatorHelp")}
            selectedValue={importForm.translatorSelection}
            newTranslatorLabel={importForm.newTranslatorLabel}
            options={availableImportTranslators}
            loading={mangaSeriesLoading}
            failed={mangaSeriesFailed}
            disabled={!importForm.mangaSelection}
            emptyLabel={t(importForm.mangaSelection ? "reference.import.selectTranslator" : "reference.import.chooseMangaFirst")}
            loadingLabel={t("reference.import.loadingTranslators")}
            failedLabel={t("reference.import.failedTranslators")}
            createLabel={t("reference.import.createTranslator")}
            inputPlaceholder={t("reference.import.translatorPlaceholder")}
            onSelectionChange={(value) =>
              setImportForm((current) => ({
                ...current,
                translatorSelection: value,
              }))
            }
            onNewTranslatorLabelChange={(value) =>
              setImportForm((current) => ({
                ...current,
                newTranslatorLabel: value,
              }))
            }
          />
        )}
      </div>
      {hasSourceReferenceInWorklist ? (
        <p className="muted-text">
          {t("reference.import.sourceNotice")}
          {hasTranslatorReferenceInWorklist
            ? ` ${t("reference.import.mixedNotice")}`
            : ""}
        </p>
      ) : null}
      <div className="button-row">
        <button
          className="primary-button"
          type="button"
          disabled={Boolean(importBlockedReason)}
          onClick={() => void importQueuedReferenceFolders()}
        >
          {t("reference.import.submit")}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={importQueue.length === 0}
          onClick={clearQueuedReferenceFolders}
        >
          {t("reference.import.clear")}
        </button>
        <span className="muted-text">{t("reference.workspace.chapterCount", { count: importQueue.length })}</span>
      </div>
      {importBlockedReason ? <p className="muted-text">{importBlockedReason}</p> : null}
      {importQueue.length > 0 ? (
        <ul className="artifact-list">
          {importQueue.map((entry) => (
            <li key={entry.id} className="artifact-item">
              <div>
                <input
                  value={entry.label}
                  onChange={(event) => {
                    updateQueuedReferenceFolderLabel(entry.id, event.currentTarget.value);
                  }}
                />
                <div className="job-subtext">{entry.sourceFolder}</div>
              </div>
              <div className="job-actions">
                <button
                  className="secondary-button danger-button"
                  type="button"
                  onClick={() => removeQueuedReferenceFolder(entry.id)}
                >
                  {t("reference.import.remove")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted-text">{t("reference.import.empty")}</p>
      )}
    </SectionCard>
  );
}
